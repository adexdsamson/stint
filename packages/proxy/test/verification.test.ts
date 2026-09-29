/**
 * `verification.test.ts` -- LIFE-06 outcome verification (Tasks 1-3):
 * `resource_query` (D-02, D-03, D-06, D-07), `user_confirm` (D-05, D-07), and
 * `none` (D-03) -- proving the agent's own "check done" claim only ever
 * TRIGGERS a runtime-run evaluation and never itself completes a lease.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { generateKeyPair } from "jose";
import type { CryptoKey } from "jose";
import { describe, expect, it } from "vitest";

import { reduce, verifierEvents } from "@stint/core";
import type { ConnectorBinding, HostAdapter, Lease, OutcomeConfirmDecision, ReceiptEntry } from "@stint/core";
import { createInMemoryLeaseStore, createInMemoryReceiptStore, makeTestLease } from "@stint/core/testing";
import { parsePredicate } from "@stint/spec";
import type { PredicateAst } from "@stint/spec";

import {
  createDefaultTeardownSteps,
  runNoneVerification,
  runResourceQueryVerification,
  runUserConfirmVerification,
} from "../src/index.js";
import type { CredentialVault, OutboundConnector, ResourceQueryDeps, UserConfirmDeps } from "../src/index.js";

const NOW = 1_700_000_000;

function parsePredicateOrThrow(source: string): PredicateAst {
  const result = parsePredicate(source);
  if (!result.ok) {
    throw new Error(`test setup: predicate failed to parse: ${JSON.stringify(result.errors)}`);
  }
  return result.value;
}

const RECONCILED_PREDICATE = parsePredicateOrThrow("count(rows where status = 'reconciled') >= 1");

function fakeVault(accessToken = "test-access-token"): CredentialVault & { resolveCalls: number } {
  let resolveCalls = 0;
  return {
    get resolveCalls(): number {
      return resolveCalls;
    },
    seedCredential(): void {
      /* not needed for this test's happy/error paths */
    },
    resolveAccessToken(): Promise<string> {
      resolveCalls += 1;
      return Promise.resolve(accessToken);
    },
    revokeAndDiscardLeaseCredentials(): Promise<readonly never[]> {
      return Promise.resolve([]);
    },
    discardLeaseCredentials(): void {
      /* not needed for this test */
    },
  };
}

function rowsConnector(rows: ReadonlyArray<Record<string, unknown>>): OutboundConnector & { executeCalls: number } {
  let executeCalls = 0;
  return {
    get executeCalls(): number {
      return executeCalls;
    },
    execute(): Promise<{ readonly status: number; readonly body: unknown }> {
      executeCalls += 1;
      return Promise.resolve({ status: 200, body: { rows } });
    },
  };
}

function throwingConnector(): OutboundConnector {
  return {
    execute(): Promise<{ readonly status: number; readonly body: unknown }> {
      return Promise.reject(new Error("downstream read failed: secret-token-xyz"));
    },
  };
}

const VERIFIER_BINDING: ConnectorBinding = {
  tool: "__verifier_synthetic_read", // never a real, agent-facing tool
  resource: "orders.status",
  access: "read",
  irreversible: false,
  provenance: "built_in",
  rowAdapter(result) {
    const body = result.body as { readonly rows?: ReadonlyArray<Record<string, unknown>> };
    return { rows: body.rows ?? [] };
  },
};

const BINDING_WITHOUT_ROW_ADAPTER: ConnectorBinding = {
  tool: "__verifier_synthetic_read_no_adapter",
  resource: "orders.status",
  access: "read",
  irreversible: false,
  provenance: "built_in",
};

async function buildResourceQueryDeps(
  connector: OutboundConnector,
  overrides?: Partial<Lease>,
): Promise<{
  deps: ResourceQueryDeps;
  leaseStore: ReturnType<typeof createInMemoryLeaseStore>;
  receiptStore: ReturnType<typeof createInMemoryReceiptStore>;
  publicKey: CryptoKey;
  vault: ReturnType<typeof fakeVault>;
}> {
  const leaseStore = createInMemoryLeaseStore();
  const receiptStore = createInMemoryReceiptStore();
  const { privateKey, publicKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
  const leaseId = "lease-resource-query";
  await leaseStore.save(makeTestLease(leaseId, overrides));

  const vault = fakeVault();
  const deps: ResourceQueryDeps = {
    leaseStore,
    receiptStore,
    leaseId,
    vault,
    connector,
    binding: VERIFIER_BINDING,
    ast: RECONCILED_PREDICATE,
    teardownSteps: createDefaultTeardownSteps(receiptStore, privateKey),
  };

  return { deps, leaseStore, receiptStore, publicKey, vault };
}

function lastCallEntry(chain: readonly ReceiptEntry[]): Extract<ReceiptEntry, { type: "call" }> {
  const entry = chain.at(-1);
  if (entry === undefined || entry.type !== "call") {
    throw new Error("expected the last receipt entry to be a call-shaped verification receipt");
  }
  return entry;
}

describe("runResourceQueryVerification (LIFE-06, D-02, D-03, D-06, D-07)", () => {
  it("TRUE: a matching predicate completes the lease and auto-chains into the full teardown", async () => {
    const connector = rowsConnector([{ status: "reconciled" }]);
    const { deps, leaseStore, receiptStore } = await buildResourceQueryDeps(connector);

    const outcome = await runResourceQueryVerification(deps, NOW);

    expect(outcome).toBe("true");
    const finalLease = await leaseStore.load(deps.leaseId);
    expect(finalLease?.state).toBe("cleaned_up");

    const chain = await receiptStore.load("verified");
    const verificationEntry = chain.find(
      (entry) => entry.type === "call" && entry.payload.resource === VERIFIER_BINDING.resource,
    );
    expect(verificationEntry).toBeDefined();
    if (verificationEntry?.type === "call") {
      expect(verificationEntry.payload.outcome).toBe("allowed");
      expect(verificationEntry.payload.redactedSummary).toContain("outcome=true");
      expect(verificationEntry.payload.redactedSummary).toContain("actor=verifier");
    }
  });

  it("TRUE: reuses the vault + connector exactly once (D-02) -- the same path a real call uses", async () => {
    const connector = rowsConnector([{ status: "reconciled" }]);
    const { deps, vault } = await buildResourceQueryDeps(connector);

    await runResourceQueryVerification(deps, NOW);

    expect(vault.resolveCalls).toBe(1);
    expect((connector as { executeCalls: number }).executeCalls).toBe(1);
  });

  it("FALSE: a non-matching predicate is a no-op -- lease stays active, exactly one negative receipt, no state change", async () => {
    const connector = rowsConnector([{ status: "pending" }]);
    const { deps, leaseStore, receiptStore } = await buildResourceQueryDeps(connector);

    const outcome = await runResourceQueryVerification(deps, NOW);

    expect(outcome).toBe("false");
    const finalLease = await leaseStore.load(deps.leaseId);
    expect(finalLease?.state).toBe("active");
    expect(finalLease?.version).toBe(0);

    const chain = await receiptStore.load("verified");
    expect(chain).toHaveLength(1);
    const entry = lastCallEntry(chain);
    expect(entry.payload.outcome).toBe("denied");
    expect(entry.payload.redactedSummary).toContain("outcome=false");
  });

  it("ERROR: a read failure never completes the lease, records one outcome=error receipt, and counts toward the LIFE-07 threshold", async () => {
    const { deps, leaseStore, receiptStore } = await buildResourceQueryDeps(throwingConnector());

    const outcome = await runResourceQueryVerification(deps, NOW);

    expect(outcome).toBe("error");
    const finalLease = await leaseStore.load(deps.leaseId);
    expect(finalLease?.state).toBe("active");
    expect(finalLease?.counters.denialErrorTimestamps).toEqual([NOW]);

    const chain = await receiptStore.load("verified");
    expect(chain).toHaveLength(1);
    const entry = lastCallEntry(chain);
    expect(entry.payload.outcome).toBe("denied");
    expect(entry.payload.redactedSummary).toContain("outcome=error");
    // The scrubbed connector error message must never survive into a receipt.
    expect(JSON.stringify(chain)).not.toContain("secret-token-xyz");
  });

  it("ERROR: a binding with no rowAdapter configured is treated as a read error, never a match", async () => {
    const connector = rowsConnector([{ status: "reconciled" }]);
    const leaseStore = createInMemoryLeaseStore();
    const receiptStore = createInMemoryReceiptStore();
    const leaseId = "lease-no-adapter";
    await leaseStore.save(makeTestLease(leaseId));

    const deps: ResourceQueryDeps = {
      leaseStore,
      receiptStore,
      leaseId,
      vault: fakeVault(),
      connector,
      binding: BINDING_WITHOUT_ROW_ADAPTER,
      ast: RECONCILED_PREDICATE,
    };

    const outcome = await runResourceQueryVerification(deps, NOW);

    expect(outcome).toBe("error");
    expect((await leaseStore.load(leaseId))?.state).toBe("active");
  });

  it("never touches the action/spend limit counters, on any outcome (true/false/error)", async () => {
    for (const connector of [
      rowsConnector([{ status: "reconciled" }]),
      rowsConnector([{ status: "pending" }]),
      throwingConnector(),
    ]) {
      const { deps, leaseStore } = await buildResourceQueryDeps(connector);
      const before = await leaseStore.load(deps.leaseId);

      await runResourceQueryVerification(deps, NOW);

      const after = await leaseStore.load(deps.leaseId);
      expect(after?.counters.actionCount).toBe(before?.counters.actionCount);
      expect(after?.counters.spentMinor).toBe(before?.counters.spentMinor);
      expect(after?.counters.actionTimestamps).toEqual(before?.counters.actionTimestamps);
    }
  });

  it("never appears in any tool catalog import -- the verifier read is structurally absent from tools/list (D-02)", () => {
    const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "verification");
    const source = readFileSync(path.join(srcDir, "resource-query.ts"), "utf8");
    // Strip comments (best-effort, mirrors teardown-orchestrate.test.ts's D-15
    // grep) so this checks actual CODE, not prose docstrings explaining why
    // no catalog/tools-list reference exists.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/catalog|ToolCatalog/i);
  });
});

describe("runUserConfirmVerification (LIFE-06, D-05, D-07)", () => {
  function adapterResolving(decision: OutcomeConfirmDecision): HostAdapter {
    return {
      requestConsent() {
        return Promise.reject(new Error("n/a"));
      },
      requestApproval() {
        return Promise.reject(new Error("n/a"));
      },
      requestOutcomeConfirmation() {
        return Promise.resolve(decision);
      },
      notify() {
        return Promise.resolve();
      },
    };
  }

  async function buildUserConfirmDeps(
    adapter: HostAdapter,
  ): Promise<{
    deps: UserConfirmDeps;
    leaseStore: ReturnType<typeof createInMemoryLeaseStore>;
    receiptStore: ReturnType<typeof createInMemoryReceiptStore>;
  }> {
    const leaseStore = createInMemoryLeaseStore();
    const receiptStore = createInMemoryReceiptStore();
    const { privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
    const leaseId = "lease-user-confirm";
    await leaseStore.save(makeTestLease(leaseId));

    const deps: UserConfirmDeps = {
      leaseStore,
      receiptStore,
      leaseId,
      adapter,
      prompt: "Did the reconciliation job complete?",
      signal: new AbortController().signal,
      teardownSteps: createDefaultTeardownSteps(receiptStore, privateKey),
    };

    return { deps, leaseStore, receiptStore };
  }

  it("YES: an explicit confirm completes the lease and auto-chains into the full teardown", async () => {
    const { deps, leaseStore, receiptStore } = await buildUserConfirmDeps(
      adapterResolving({ decision: "confirm" }),
    );

    const outcome = await runUserConfirmVerification(deps, NOW);

    expect(outcome).toBe("true");
    expect((await leaseStore.load(deps.leaseId))?.state).toBe("cleaned_up");

    const chain = await receiptStore.load("verified");
    const entry = chain.find((e) => e.type === "call" && e.payload.resource === "user_confirm");
    expect(entry).toBeDefined();
    if (entry?.type === "call") {
      expect(entry.payload.outcome).toBe("allowed");
    }
  });

  it("NO: an explicit rejection never completes the lease", async () => {
    const { deps, leaseStore, receiptStore } = await buildUserConfirmDeps(
      adapterResolving({ decision: "reject", reason: "user_rejected" }),
    );

    const outcome = await runUserConfirmVerification(deps, NOW);

    expect(outcome).toBe("false");
    expect((await leaseStore.load(deps.leaseId))?.state).toBe("active");
    const chain = await receiptStore.load("verified");
    expect(chain).toHaveLength(1);
  });

  it("TIMEOUT: an aborted signal (never-resolving adapter) never completes the lease -- deny-by-default", async () => {
    const controller = new AbortController();
    const neverAdapter: HostAdapter = {
      requestConsent() {
        return Promise.reject(new Error("n/a"));
      },
      requestApproval() {
        return Promise.reject(new Error("n/a"));
      },
      requestOutcomeConfirmation() {
        return new Promise<OutcomeConfirmDecision>(() => {});
      },
      notify() {
        return Promise.resolve();
      },
    };
    const { deps, leaseStore } = await buildUserConfirmDeps(neverAdapter);
    const timedDeps: UserConfirmDeps = { ...deps, signal: controller.signal };

    const pending = runUserConfirmVerification(timedDeps, NOW);
    controller.abort();
    const outcome = await pending;

    expect(outcome).toBe("false");
    expect((await leaseStore.load(deps.leaseId))?.state).toBe("active");
  });
});

describe("runNoneVerification (LIFE-06, D-03): completes nothing", () => {
  it("is a pure no-op -- returns 'none', touches no lease, appends no receipt", async () => {
    const leaseStore = createInMemoryLeaseStore();
    const receiptStore = createInMemoryReceiptStore();
    const leaseId = "lease-none-verifier";
    const lease = makeTestLease(leaseId);
    await leaseStore.save(lease);

    const outcome = runNoneVerification();

    expect(outcome).toBe("none");
    expect(await leaseStore.load(leaseId)).toEqual(lease);
    expect(await receiptStore.load("verified")).toEqual([]);
  });
});

describe("Trigger discipline (D-03, D-19): the agent's own claim never completes a lease", () => {
  it("reduce() rejects a forged agent-actor outcome_verified event -- wrong_actor, never completed", () => {
    const lease = makeTestLease("lease-forged-actor");
    const forgedEvent = { type: "outcome_verified", actor: "agent" } as unknown as Parameters<typeof reduce>[1];

    const result = reduce(lease, forgedEvent, NOW);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.code).toBe("wrong_actor");
    }
  });

  it("the ONLY way outcome_verified is legally dispatched is via verifierEvents.outcomeVerified() (actor verifier)", () => {
    const lease = makeTestLease("lease-real-verifier-event");

    const result = reduce(lease, verifierEvents.outcomeVerified(), NOW);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.lease.state).toBe("completed");
      expect(result.value.transition.actor).toBe("verifier");
    }
  });
});
