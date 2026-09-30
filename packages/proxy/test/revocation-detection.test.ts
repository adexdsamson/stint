/**
 * PRXY-07 lazy customer-side OAuth revocation detection (D-09). Task 1:
 * unit coverage for `applyProviderRevocation`/`isProviderRevocation`
 * (`revocation.ts`) and the dispatch-level provider_revoked-vs-transient
 * discrimination wired into `handleCall` (`dispatch.ts`) -- driven directly
 * (not over the full MCP `Client`) since these are dispatch-branch wiring
 * proofs, not protocol proofs. Task 2 extends this file with the forced-
 * `invalid_grant` end-to-end proof over a real mock authorization server and
 * a real MCP `Client`.
 *
 * 05-03 (D-18, TEAR-01) retrofit: `applyProviderRevocation` now chains
 * `grant_revoked` (actor `provider`) into `begin_teardown` (actor
 * `runtime`) via the shared `chainTeardownIfEnded` helper, landing
 * `tearing_down` rather than a bare `revoked`. `ProxyDeps.teardownSteps` is
 * wired into every `ProxyDeps` fixture in this file so `handleCall` runs
 * the full orchestrator after its own transaction commits -- the
 * post-revocation state assertions below read `cleaned_up` (not `revoked`),
 * matching TEAR-01's "ending a lease for any reason runs teardown".
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { generateKeyPair } from "jose";

import { createBindingSet } from "@stint/core";
import type { ConnectorBinding, Lease } from "@stint/core";
import { createInMemoryLeaseStore, createInMemoryReceiptStore } from "@stint/core/testing";

import { createToolCatalog } from "../src/catalog.js";
import { DEFAULT_APPROVAL_STAGE, DEFAULT_CAP_ENFORCER, handleCall } from "../src/dispatch.js";
import type { ExecuteStage } from "../src/dispatch.js";
import { createLeaseProxyServer } from "../src/server.js";
import type { ProxyDeps } from "../src/server.js";
import { createEchoingCredentialConnector, startMockAuthServer } from "../src/testing.js";
import type { MockAuthHarness } from "../src/testing.js";
import { createDefaultTeardownSteps } from "../src/teardown/steps.js";
import { createCredentialVault, CredentialRefreshError } from "../src/vault/credential-vault.js";
import { createVaultExecuteStage } from "../src/vault/execute-stage.js";
import { applyProviderRevocation, isProviderRevocation } from "../src/revocation.js";

const NOW = 1_700_000_000;

function makeLease(id: string, overrides?: Partial<Lease>): Lease {
  return {
    id,
    state: "active",
    version: 0,
    boundHash: "jcs-sha256:test",
    grantedAt: NOW - 100,
    expiresAt: NOW + 3600,
    maxDurationSeconds: 3600,
    counters: { actionCount: 0, spentMinor: 0, denialErrorTimestamps: [], actionTimestamps: [] },
    ...overrides,
  };
}

// --- Task 1: applyProviderRevocation / isProviderRevocation (unit) -------

describe("applyProviderRevocation (05-03 retrofit: chains begin_teardown, D-18)", () => {
  it("moves an active lease through grant_revoked (provider) then begin_teardown (runtime), landing tearing_down", () => {
    const lease = makeLease("lease-apply-active", { state: "active" });

    const result = applyProviderRevocation(lease, NOW);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lease.state).toBe("tearing_down");

    const [grantRevoked, beginTeardown] = result.value.transitions;
    expect(grantRevoked.actor).toBe("provider");
    expect(grantRevoked.event).toBe("grant_revoked");
    expect(grantRevoked.from).toBe("active");
    expect(grantRevoked.to).toBe("revoked");
    expect(beginTeardown.actor).toBe("runtime");
    expect(beginTeardown.event).toBe("begin_teardown");
    expect(beginTeardown.from).toBe("revoked");
    expect(beginTeardown.to).toBe("tearing_down");
  });

  it("moves a granted lease to tearing_down (the other legal grant_revoked source state)", () => {
    const lease = makeLease("lease-apply-granted", { state: "granted" });

    const result = applyProviderRevocation(lease, NOW);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lease.state).toBe("tearing_down");
    expect(result.value.transitions[0].actor).toBe("provider");
    expect(result.value.transitions[1].actor).toBe("runtime");
  });

  it("returns reduce's illegal_transition rejection (not a throw) for a non-active/non-granted source state", () => {
    const lease = makeLease("lease-apply-illegal", { state: "revoked" });

    const result = applyProviderRevocation(lease, NOW);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe("illegal_transition");
  });
});

describe("isProviderRevocation", () => {
  it("returns true for the provider_revoked signal", () => {
    expect(isProviderRevocation("provider_revoked")).toBe(true);
  });

  it("returns false for the transient_error signal", () => {
    expect(isProviderRevocation("transient_error")).toBe(false);
  });
});

// --- Task 1: dispatch-level provider_revoked vs transient discrimination -

const REVOCABLE_BINDING: ConnectorBinding = {
  tool: "read_message",
  resource: "inbox",
  access: "read",
  irreversible: false,
  provenance: "built_in",
};

function makeThrowingExecuteStage(err: Error): ExecuteStage {
  return {
    execute() {
      return Promise.reject(err);
    },
  };
}

async function buildRevocationDeps(
  leaseId: string,
  execute: ExecuteStage,
): Promise<{
  deps: ProxyDeps;
  leaseStore: ReturnType<typeof createInMemoryLeaseStore>;
  receiptStore: ReturnType<typeof createInMemoryReceiptStore>;
}> {
  const leaseStore = createInMemoryLeaseStore();
  const receiptStore = createInMemoryReceiptStore();
  await leaseStore.save(makeLease(leaseId));

  const catalog = createToolCatalog([
    {
      name: REVOCABLE_BINDING.tool,
      description: "Reads a message",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
  ]);
  const bindings = createBindingSet([REVOCABLE_BINDING]);

  // 05-03 (TEAR-01): a real Ed25519 key so the wired orchestrator's
  // final_receipt step can sign a real checkpoint -- this file cares only
  // that the orchestrator runs and reaches cleaned_up, not about the key
  // material itself.
  const { privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });

  const deps: ProxyDeps = {
    leaseId,
    leaseStore,
    receiptStore,
    catalog,
    bindings,
    grantedScopes: ["read"],
    grantedResources: [REVOCABLE_BINDING.resource],
    limits: { max_actions: 100 },
    approvals: { require_for: [], timeout_seconds: 30 },
    clock: () => NOW,
    execute,
    approve: DEFAULT_APPROVAL_STAGE,
    enforceCaps: DEFAULT_CAP_ENFORCER,
    teardownSteps: createDefaultTeardownSteps(receiptStore, privateKey),
  };

  return { deps, leaseStore, receiptStore };
}

describe("dispatch: applyProviderRevocation wiring drives the full teardown orchestrator (PRXY-07, 05-03 TEAR-01)", () => {
  it("a provider_revoked CredentialRefreshError auto-chains begin_teardown, denies the triggering call, and the orchestrator (run in its OWN transaction after) lands cleaned_up", async () => {
    const leaseId = "lease-revoke-1";
    const { deps, leaseStore, receiptStore } = await buildRevocationDeps(
      leaseId,
      makeThrowingExecuteStage(new CredentialRefreshError(`${leaseId}:inbox`, "provider_revoked")),
    );

    const result = await handleCall(deps, { name: REVOCABLE_BINDING.tool, arguments: {} }, NOW);

    expect(result.isError).toBe(true);
    const [content] = result.content;
    if (content === undefined || content.type !== "text") {
      throw new Error("expected a text content block");
    }
    expect(content.text).toBe("denied: provider_revoked");

    // Not a bare `revoked` lease (TEAR-01) -- the orchestrator ran to completion.
    const lease = await leaseStore.load(leaseId);
    expect(lease?.state).toBe("cleaned_up");

    const chain = await receiptStore.load("verified");
    // grant_revoked + begin_teardown (dispatch's own transaction) + denied
    // call + 5 teardown_step + teardown_succeeded (the orchestrator's
    // separate, later transaction) = 9 entries.
    expect(chain).toHaveLength(9);

    const [grantRevokedEntry, beginTeardownEntry, callEntry] = chain;
    expect(grantRevokedEntry?.type).toBe("transition");
    if (grantRevokedEntry?.type === "transition") {
      expect(grantRevokedEntry.payload).toEqual({ from: "active", event: "grant_revoked", actor: "provider", to: "revoked" });
    }
    expect(beginTeardownEntry?.type).toBe("transition");
    if (beginTeardownEntry?.type === "transition") {
      expect(beginTeardownEntry.payload).toEqual({ from: "revoked", event: "begin_teardown", actor: "runtime", to: "tearing_down" });
    }
    expect(callEntry?.type).toBe("call");
    if (callEntry?.type === "call") {
      expect(callEntry.payload.outcome).toBe("denied");
    }

    const lastEntry = chain.at(-1);
    expect(lastEntry?.type).toBe("transition");
    if (lastEntry?.type === "transition") {
      expect(lastEntry.payload).toEqual({ from: "tearing_down", event: "teardown_succeeded", actor: "runtime", to: "cleaned_up" });
    }
  });

  it("a transient_error CredentialRefreshError denies the call but leaves the lease active (never calls providerEvents.grantRevoked)", async () => {
    const leaseId = "lease-transient-1";
    const { deps, leaseStore } = await buildRevocationDeps(
      leaseId,
      makeThrowingExecuteStage(new CredentialRefreshError(`${leaseId}:inbox`, "transient_error")),
    );

    const result = await handleCall(deps, { name: REVOCABLE_BINDING.tool, arguments: {} }, NOW);

    expect(result.isError).toBe(true);
    const [content] = result.content;
    if (content === undefined || content.type !== "text") {
      throw new Error("expected a text content block");
    }
    expect(content.text).toBe("denied: transient_error");

    const lease = await leaseStore.load(leaseId);
    expect(lease?.state).toBe("active");
  });

  it("runs the orchestrator in its OWN transaction AFTER the dispatch transaction commits -- never nested on the same lease id (D-30)", async () => {
    const leaseId = "lease-revoke-no-deadlock";
    const { deps, leaseStore } = await buildRevocationDeps(
      leaseId,
      makeThrowingExecuteStage(new CredentialRefreshError(`${leaseId}:inbox`, "provider_revoked")),
    );

    // Wrap `leaseStore.transaction` to record each call's start and
    // settlement in a single shared order log. A nested transaction on the
    // SAME id would either deadlock (the in-memory double's per-id promise
    // chain awaits the outer mutator before starting the inner one -- this
    // test would then time out) or, if it somehow completed, its "start"
    // would be logged BEFORE the outer transaction's own "end" -- proving
    // interleaving rather than sequencing. Neither happens here.
    const order: string[] = [];
    let callCounter = 0;
    const originalTransaction = leaseStore.transaction.bind(leaseStore);
    const instrumentedStore = {
      ...leaseStore,
      transaction(id: string, mutate: Parameters<typeof originalTransaction>[1]) {
        const callIndex = callCounter++;
        order.push(`start-${String(callIndex)}`);
        return originalTransaction(id, mutate).finally(() => {
          order.push(`end-${String(callIndex)}`);
        });
      },
    };

    await handleCall({ ...deps, leaseStore: instrumentedStore }, { name: REVOCABLE_BINDING.tool, arguments: {} }, NOW);

    // handleCall's own transaction (index 0) plus every transaction() call
    // the orchestrator's separate run makes (indices 1..N) -- proving
    // strict sequencing (each call's "end" before the NEXT call's "start")
    // is exactly what rules out nesting: a mutator that opened a SECOND
    // transaction() on the same id from inside itself would show that
    // inner call's "start" BEFORE its own outer "end", breaking this
    // pattern (and, on the real in-memory store, would simply hang).
    expect(order.length).toBeGreaterThanOrEqual(2);
    expect(order.length % 2).toBe(0);
    const expectedPattern: string[] = [];
    for (let i = 0; i < order.length / 2; i++) {
      expectedPattern.push(`start-${String(i)}`, `end-${String(i)}`);
    }
    expect(order).toEqual(expectedPattern);
  });
});

// --- Task 2: forced-invalid_grant end-to-end revocation (real mock AS + --
// real MCP Client, PRXY-07) -----------------------------------------------
//
// Drives the FULL stack -- a real `oauth4webapi` refresh against a real
// loopback `oauth2-mock-server`, through the vault-backed `ExecuteStage`,
// through a real MCP `Client` `tools/call` -- rather than a synthetic
// `CredentialRefreshError` (Task 1 above). `forceNextTokenError` is the
// mock's ONLY way to produce `oauth.ResponseBodyError`; its `/revoke`
// endpoint always returns 200 with no reuse-detection (04-RESEARCH.md
// Pitfall 2/5), so no assertion here depends on it -- the revocation
// signal is exclusively the forced `invalid_grant` on the REFRESH request.

const E2E_BINDING: ConnectorBinding = {
  tool: "read_message",
  resource: "inbox",
  access: "read",
  irreversible: false,
  provenance: "built_in",
};

describe("PRXY-07 end-to-end: real mock AS + MCP Client (forced invalid_grant revokes; forced transient does not)", () => {
  let harness: MockAuthHarness;

  beforeEach(async () => {
    harness = await startMockAuthServer();
  });

  afterEach(async () => {
    await harness.stop();
  });

  async function buildE2EDeps(leaseId: string): Promise<{
    deps: ProxyDeps;
    leaseStore: ReturnType<typeof createInMemoryLeaseStore>;
  }> {
    const leaseStore = createInMemoryLeaseStore();
    const receiptStore = createInMemoryReceiptStore();
    await leaseStore.save(makeLease(leaseId));

    const catalog = createToolCatalog([
      {
        name: E2E_BINDING.tool,
        description: "Reads a message",
        inputSchema: { type: "object", properties: {}, required: [] },
      },
    ]);
    const bindings = createBindingSet([E2E_BINDING]);

    const vault = createCredentialVault(harness.oauthClient, () => NOW, { allowInsecureRequests: true });
    // Already-expired -- forces the triggering call's resolveAccessToken to
    // refresh (never a stale "success").
    vault.seedCredential(leaseId, E2E_BINDING.resource, {
      accessToken: "expired-access-token",
      refreshToken: "seed-refresh-token",
      expiry: NOW - 10,
      tokenEndpoint: "unused-see-harness.oauthClient.as.token_endpoint",
      resourceIndicator: E2E_BINDING.resource,
    });

    // 05-03 (TEAR-01): same rationale as `buildRevocationDeps` above -- wires
    // the real orchestrator so a forced `invalid_grant` proves the FULL
    // teardown path, not just the bare `grant_revoked` transition.
    const { privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });

    const deps: ProxyDeps = {
      leaseId,
      leaseStore,
      receiptStore,
      catalog,
      bindings,
      grantedScopes: ["read"],
      grantedResources: [E2E_BINDING.resource],
      limits: { max_actions: 100 },
      approvals: { require_for: [], timeout_seconds: 30 },
      clock: () => NOW,
      // The adversarial echoing connector is never actually invoked on
      // either path below (both calls are denied before connector.execute
      // would run) -- reused here only as a type-satisfying OutboundConnector.
      execute: createVaultExecuteStage(vault, createEchoingCredentialConnector()),
      approve: DEFAULT_APPROVAL_STAGE,
      enforceCaps: DEFAULT_CAP_ENFORCER,
      teardownSteps: createDefaultTeardownSteps(receiptStore, privateKey),
    };

    return { deps, leaseStore };
  }

  async function connectE2EClient(deps: ProxyDeps): Promise<Client> {
    const server = createLeaseProxyServer(deps);
    const client = new Client({ name: "revocation-e2e-agent", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
  }

  it("a forced invalid_grant on refresh auto-chains begin_teardown and runs the orchestrator to cleaned_up (05-03, TEAR-01) and denies the triggering call; a subsequent call on the torn-down lease is also denied", async () => {
    const leaseId = "lease-e2e-revoke";
    const { deps, leaseStore } = await buildE2EDeps(leaseId);
    // The mock's ONLY way to produce oauth.ResponseBodyError -- never its
    // /revoke endpoint's 200 no-op (Pitfall 2/5).
    harness.forceNextTokenError("invalid_grant");

    const client = await connectE2EClient(deps);

    const result = (await client.callTool({ name: E2E_BINDING.tool, arguments: {} })) as CallToolResult;

    expect(result.isError).toBe(true);
    const [content] = result.content;
    if (content === undefined || content.type !== "text") {
      throw new Error("expected a text content block");
    }
    expect(content.text).toBe("denied: provider_revoked");

    // The lease is now `cleaned_up` -- NOT a bare `revoked` (05-03, TEAR-01):
    // reachable here ONLY via dispatch.ts's provider_revoked branch
    // (revocation.ts's retrofitted `applyProviderRevocation`, chaining
    // grant_revoked (actor provider) into begin_teardown (actor runtime),
    // unit-proven above) followed by the orchestrator's own, separate
    // transaction running the fixed 5 steps to completion; no `user`-actor
    // `revoke` call is made anywhere in this test.
    const finalLease = await leaseStore.load(leaseId);
    expect(finalLease?.state).toBe("cleaned_up");

    // A subsequent tools/call on the now-torn-down lease: denied by
    // evaluatePolicy's lease_not_active check (LIFE-02, deny by default) --
    // the agent cannot act on a lease that is no longer active.
    const second = (await client.callTool({ name: E2E_BINDING.tool, arguments: {} })) as CallToolResult;
    expect(second.isError).toBe(true);
    const [secondContent] = second.content;
    if (secondContent === undefined || secondContent.type !== "text") {
      throw new Error("expected a text content block");
    }
    expect(secondContent.text).toBe("denied: lease_not_active");
  });

  it("a forced non-invalid_grant (transient) refresh failure denies the call but leaves the lease active -- never revoked", async () => {
    const leaseId = "lease-e2e-transient";
    const { deps, leaseStore } = await buildE2EDeps(leaseId);
    harness.forceNextTokenError("server_error");

    const client = await connectE2EClient(deps);

    const result = (await client.callTool({ name: E2E_BINDING.tool, arguments: {} })) as CallToolResult;

    expect(result.isError).toBe(true);
    const [content] = result.content;
    if (content === undefined || content.type !== "text") {
      throw new Error("expected a text content block");
    }
    expect(content.text).toBe("denied: transient_error");

    const lease = await leaseStore.load(leaseId);
    expect(lease?.state).toBe("active");
  });
});
