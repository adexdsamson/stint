/**
 * TEAR-07: teardown fails closed when a credential the lease recorded cannot
 * be produced. The preflight runs no step, performs no transition, signs no
 * checkpoint and leaves the lease state alone; it records one verified
 * `teardown_blocked` receipt and throws `TeardownBlockedError`. Steps 1 and 4
 * add their own defences: an expected credential the vault could not produce
 * is `failed` (never `not_applicable`), and a secret left in the store after
 * the purge is `failed`.
 */

import { generateKeyPair } from "jose";
import type { CryptoKey } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import { credentialSecretKey, leaseSecretPrefix, verifyChain } from "@stint/core";
import type { Lease, ReceiptEntry, ReceiptStore, SecretStore, TeardownStepName } from "@stint/core";
import {
  createInMemoryLeaseStore,
  createInMemoryReceiptStore,
  createInMemorySecretStore,
  createRecordingTelemetry,
  makeTearingDownTestLease,
  makeTestLease,
} from "@stint/core/testing";

import {
  createDefaultTeardownSteps,
  retryTeardown,
  runStepOnce,
  runTeardown,
  TEARDOWN_STEP_ORDER,
  TeardownBlockedError,
} from "../src/index.js";
import type { CredentialVault } from "../src/index.js";
import type { TeardownCredentialCheck, TeardownDeps, TeardownStep } from "../src/index.js";

const NOW = 1_700_000_000;
const LEASE_ID = "lease-teardown-blocked";

let signingKey: CryptoKey;

beforeAll(async () => {
  ({ privateKey: signingKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true }));
});

interface Counted {
  readonly steps: readonly TeardownStep[];
  readonly runs: Record<TeardownStepName, number>;
}

function countingSteps(receiptStore: ReceiptStore): Counted {
  const runs = Object.fromEntries(TEARDOWN_STEP_ORDER.map((n) => [n, 0])) as Record<TeardownStepName, number>;
  const steps = createDefaultTeardownSteps(receiptStore, signingKey).map(
    (inner): TeardownStep => ({
      name: inner.name,
      run(lease, now) {
        runs[inner.name] += 1;
        return inner.run(lease, now);
      },
    }),
  );
  return { steps, runs };
}

function interleavingReceiptStore(inner: ReceiptStore): ReceiptStore {
  return {
    ...inner,
    async load(chain) {
      await Promise.resolve();
      return inner.load(chain);
    },
    async append(chain, entry) {
      await Promise.resolve();
      return inner.append(chain, entry);
    },
  };
}

function check(expected: readonly string[], missing: () => Promise<readonly string[]>): TeardownCredentialCheck {
  return { expected, missing };
}

interface Rig {
  readonly deps: TeardownDeps;
  readonly leaseStore: ReturnType<typeof createInMemoryLeaseStore>;
  readonly rawReceipts: ReceiptStore;
  readonly counted: Counted;
  readonly telemetry: ReturnType<typeof createRecordingTelemetry>;
}

async function buildRig(
  lease: Lease,
  credentialCheck: TeardownCredentialCheck | undefined,
  options: { interleave?: boolean } = {},
): Promise<Rig> {
  const leaseStore = createInMemoryLeaseStore();
  const rawReceipts = createInMemoryReceiptStore();
  const receiptStore = options.interleave === true ? interleavingReceiptStore(rawReceipts) : rawReceipts;
  await leaseStore.save(lease);
  const counted = countingSteps(receiptStore);
  const telemetry = createRecordingTelemetry();
  const deps: TeardownDeps = {
    leaseStore,
    receiptStore,
    leaseId: lease.id,
    steps: counted.steps,
    telemetry,
    signingKey,
    ...(credentialCheck === undefined ? {} : { credentialCheck }),
  };
  return { deps, leaseStore, rawReceipts, counted, telemetry };
}

function blockedEntries(chain: readonly ReceiptEntry[]): ReceiptEntry[] {
  return chain.filter((entry) => entry.type === "teardown_blocked");
}

function totalRuns(counted: Counted): number {
  return Object.values(counted.runs).reduce((a, b) => a + b, 0);
}

describe("credential preflight (TEAR-07, D-11)", () => {
  it("without a credentialCheck teardown behaves as before and lands cleaned_up", async () => {
    const rig = await buildRig(makeTestLease(LEASE_ID, { state: "expired" }), undefined);
    const lease = await runTeardown(rig.deps, NOW);
    expect(lease.state).toBe("cleaned_up");
    expect(blockedEntries(await rig.rawReceipts.load("verified"))).toHaveLength(0);
  });

  it("a missing credential runs no step, performs no transition, signs no checkpoint and keeps the state", async () => {
    const rig = await buildRig(
      makeTestLease(LEASE_ID, { state: "expired" }),
      check(["sheets.orders"], () => Promise.resolve(["sheets.orders"])),
    );

    const error = await runTeardown(rig.deps, NOW).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TeardownBlockedError);
    expect((error as TeardownBlockedError).reason).toBe("credentials_unavailable");
    expect((error as TeardownBlockedError).resources).toEqual(["sheets.orders"]);
    expect((error as TeardownBlockedError).message).not.toContain("sheets.orders");

    expect(totalRuns(rig.counted)).toBe(0);
    const lease = await rig.leaseStore.load(LEASE_ID);
    expect(lease?.state).toBe("expired");
    expect(lease?.teardownProgress).toBeUndefined();
    expect(await rig.rawReceipts.readCheckpoint("verified")).toBeUndefined();

    const chain = await rig.rawReceipts.load("verified");
    expect(chain).toHaveLength(1);
    expect(chain[0]?.type).toBe("teardown_blocked");
    expect(chain[0]?.chain).toBe("verified");
    expect(chain[0]?.payload).toEqual({ reason: "credentials_unavailable", resources: ["sheets.orders"] });
    expect((await verifyChain(chain)).ok).toBe(true);

    expect(rig.telemetry.events).toEqual([
      { name: "teardown.blocked", leaseId: LEASE_ID, reason: "credentials_unavailable", resourceCount: 1 },
    ]);
  });

  it("blocks a lease the caller already chained into tearing_down and leaves it tearing_down", async () => {
    const rig = await buildRig(
      makeTearingDownTestLease(LEASE_ID),
      check(["a"], () => Promise.resolve(["a"])),
    );

    await expect(runTeardown(rig.deps, NOW)).rejects.toBeInstanceOf(TeardownBlockedError);

    expect(totalRuns(rig.counted)).toBe(0);
    expect((await rig.leaseStore.load(LEASE_ID))?.state).toBe("tearing_down");
  });

  it("adjacency: two missing out of three expected are listed sorted and alone", async () => {
    const rig = await buildRig(
      makeTestLease(LEASE_ID, { state: "expired" }),
      check(["a", "b", "c"], () => Promise.resolve(["c", "a"])),
    );

    await expect(runTeardown(rig.deps, NOW)).rejects.toMatchObject({ resources: ["a", "c"] });

    const chain = await rig.rawReceipts.load("verified");
    expect(chain[0]?.payload).toEqual({ reason: "credentials_unavailable", resources: ["a", "c"] });
  });

  it("nothing missing: the teardown proceeds to cleaned_up with no blocked entry", async () => {
    const rig = await buildRig(
      makeTestLease(LEASE_ID, { state: "expired" }),
      check(["a", "b"], () => Promise.resolve([])),
    );

    const lease = await runTeardown(rig.deps, NOW);

    expect(lease.state).toBe("cleaned_up");
    expect(blockedEntries(await rig.rawReceipts.load("verified"))).toHaveLength(0);
    expect(rig.telemetry.events.some((e) => e.name === "teardown.blocked")).toBe(false);
  });

  it("ordering: duplicates collapse, unwritable names become unknown, and the list is sorted", async () => {
    const long = "x".repeat(129);
    const rig = await buildRig(
      makeTestLease(LEASE_ID, { state: "expired" }),
      check(["b", "a"], () => Promise.resolve(["b", "a", "b", "", long, "a"])),
    );

    await expect(runTeardown(rig.deps, NOW)).rejects.toMatchObject({ resources: ["a", "b", "unknown"] });
    const chain = await rig.rawReceipts.load("verified");
    expect(chain[0]?.payload).toEqual({ reason: "credentials_unavailable", resources: ["a", "b", "unknown"] });
  });

  it("a recorded revoke_oauth outcome skips the preflight even when names would be reported", async () => {
    const rig = await buildRig(
      makeTearingDownTestLease(LEASE_ID, { teardownProgress: { revoke_oauth: "failed" } }),
      check(["a"], () => Promise.resolve(["a"])),
    );

    const lease = await runTeardown(rig.deps, NOW);

    expect(lease.state).toBe("cleanup_incomplete");
    expect(blockedEntries(await rig.rawReceipts.load("verified"))).toHaveLength(0);
    expect(rig.counted.runs.revoke_oauth).toBe(0);
  });

  it("a check that throws blocks on every expected credential (fail closed)", async () => {
    const rig = await buildRig(
      makeTestLease(LEASE_ID, { state: "expired" }),
      check(["b", "a"], () => Promise.reject(new Error("store unreadable"))),
    );

    const error = await runTeardown(rig.deps, NOW).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TeardownBlockedError);
    expect((error as TeardownBlockedError).resources).toEqual(["a", "b"]);
    expect(totalRuns(rig.counted)).toBe(0);
    expect((await rig.leaseStore.load(LEASE_ID))?.state).toBe("expired");
  });

  it("idempotency: the same blocked set appends nothing new, a different set appends one", async () => {
    let reported: readonly string[] = ["a"];
    const rig = await buildRig(
      makeTestLease(LEASE_ID, { state: "expired" }),
      check(["a", "b"], () => Promise.resolve(reported)),
    );

    await expect(runTeardown(rig.deps, NOW)).rejects.toBeInstanceOf(TeardownBlockedError);
    const afterFirst = (await rig.rawReceipts.load("verified")).length;
    await expect(runTeardown(rig.deps, NOW + 1)).rejects.toBeInstanceOf(TeardownBlockedError);
    expect((await rig.rawReceipts.load("verified")).length).toBe(afterFirst);

    reported = ["a", "b"];
    await expect(runTeardown(rig.deps, NOW + 2)).rejects.toBeInstanceOf(TeardownBlockedError);
    const chain = await rig.rawReceipts.load("verified");
    expect(chain.length).toBe(afterFirst + 1);
    expect(blockedEntries(chain)).toHaveLength(2);
    expect((await verifyChain(chain)).ok).toBe(true);
  });

  for (const interleave of [false, true]) {
    it(`concurrency: two blocked drivers leave exactly one entry and a verifying chain (${interleave ? "interleaving" : "plain"})`, async () => {
      const rig = await buildRig(
        makeTestLease(LEASE_ID, { state: "expired" }),
        check(["a"], async () => {
          await Promise.resolve();
          return ["a"];
        }),
        { interleave },
      );

      const results = await Promise.allSettled([runTeardown(rig.deps, NOW), runTeardown(rig.deps, NOW)]);

      expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
      for (const r of results) {
        expect(r.status === "rejected" && r.reason instanceof TeardownBlockedError).toBe(true);
      }
      const chain = await rig.rawReceipts.load("verified");
      expect(blockedEntries(chain)).toHaveLength(1);
      expect((await verifyChain(chain)).ok).toBe(true);
      expect(totalRuns(rig.counted)).toBe(0);
    });
  }

  it("retryTeardown on cleanup_incomplete with revoke_oauth unrecorded is blocked with no retry transition", async () => {
    const rig = await buildRig(
      makeTestLease(LEASE_ID, {
        state: "cleanup_incomplete",
        teardownProgress: { invalidate_license: "ok", cleanup_hook: "attested_ok" },
      }),
      check(["a"], () => Promise.resolve(["a"])),
    );

    await expect(retryTeardown(rig.deps, "user", NOW)).rejects.toBeInstanceOf(TeardownBlockedError);

    expect(totalRuns(rig.counted)).toBe(0);
    expect((await rig.leaseStore.load(LEASE_ID))?.state).toBe("cleanup_incomplete");
    const chain = await rig.rawReceipts.load("verified");
    expect(chain.filter((e) => e.type === "transition")).toHaveLength(0);
    expect(blockedEntries(chain)).toHaveLength(1);
  });
});

/** The vault surface step 1 and step 4 use, with call recording. */
function fakeVault(
  produced: ReadonlyArray<{ resource: string; kind: "revoked" | "discarded_revocation_unsupported" | "failed" }>,
  discard: () => void | Promise<void> = () => undefined,
): { vault: CredentialVault; expectedSeen: Array<readonly string[] | undefined> } {
  const expectedSeen: Array<readonly string[] | undefined> = [];
  const vault = {
    revokeAndDiscardLeaseCredentials(_leaseId: string, _now: number, expected?: readonly string[]) {
      expectedSeen.push(expected);
      return Promise.resolve(produced.map(({ resource, kind }) => ({ resource, result: { kind } })));
    },
    discardLeaseCredentials: () => discard(),
  } as unknown as CredentialVault;
  return { vault, expectedSeen };
}

function stepByName(steps: readonly TeardownStep[], name: TeardownStepName): TeardownStep {
  const step = steps.find((candidate) => candidate.name === name);
  if (step === undefined) throw new Error(`test setup: no step ${name}`);
  return step;
}

describe("step 1 fails closed for an expected credential the vault cannot produce (T-08-30)", () => {
  it("records failed for the missing resource and an aggregate failed, keeping the real outcome of the other", async () => {
    const receiptStore = createInMemoryReceiptStore();
    const { vault, expectedSeen } = fakeVault([{ resource: "a", kind: "revoked" }]);
    const steps = createDefaultTeardownSteps(receiptStore, signingKey, vault, undefined, undefined, {
      expectedResources: ["a", "b"],
    });

    const outcome = await stepByName(steps, "revoke_oauth").run(makeTestLease(LEASE_ID), NOW);

    expect(outcome).toBe("failed");
    expect(expectedSeen).toEqual([["a", "b"]]);
    const payloads = (await receiptStore.load("verified")).flatMap((e) => (e.type === "teardown_step" ? [e.payload] : []));
    expect(payloads).toEqual([
      { step: "revoke_oauth", outcome: "revoked", resource: "a" },
      { step: "revoke_oauth", outcome: "failed", resource: "b" },
    ]);
  });

  it("an expected credential with an empty vault is failed, never not_applicable", async () => {
    const receiptStore = createInMemoryReceiptStore();
    const { vault } = fakeVault([]);
    const steps = createDefaultTeardownSteps(receiptStore, signingKey, vault, undefined, undefined, {
      expectedResources: ["a"],
    });

    expect(await stepByName(steps, "revoke_oauth").run(makeTestLease(LEASE_ID), NOW)).toBe("failed");
  });

  it("no expectedResources and an empty vault stays not_applicable", async () => {
    const receiptStore = createInMemoryReceiptStore();
    const { vault } = fakeVault([]);
    const steps = createDefaultTeardownSteps(receiptStore, signingKey, vault);

    expect(await stepByName(steps, "revoke_oauth").run(makeTestLease(LEASE_ID), NOW)).toBe("not_applicable");
    expect(await receiptStore.load("verified")).toHaveLength(0);
  });
});

describe("step 4 purges stored secrets and reads them back (D-13, T-08-33)", () => {
  async function seeded(): Promise<SecretStore> {
    const secrets = createInMemorySecretStore();
    await secrets.put(credentialSecretKey(LEASE_ID, "a"), "refresh-a");
    await secrets.put(credentialSecretKey(LEASE_ID, "b"), "refresh-b");
    await secrets.put(credentialSecretKey("lease-other", "a"), "other-lease");
    return secrets;
  }

  it("empties the lease prefix, keeps other leases and resolves ok", async () => {
    const secrets = await seeded();
    const { vault } = fakeVault([]);
    const steps = createDefaultTeardownSteps(createInMemoryReceiptStore(), signingKey, vault, undefined, undefined, {
      expectedResources: ["a", "b"],
      secrets,
    });

    const outcome = await runStepOnce(stepByName(steps, "delete_cached_data"), makeTestLease(LEASE_ID), NOW);

    expect(outcome).toBe("ok");
    expect(await secrets.get(credentialSecretKey(LEASE_ID, "a"))).toBeUndefined();
    expect(await secrets.get(credentialSecretKey(LEASE_ID, "b"))).toBeUndefined();
    expect(await secrets.get(credentialSecretKey("lease-other", "a"))).toBe("other-lease");
  });

  it("a secret still readable after the purge is failed", async () => {
    const secrets = await seeded();
    const stubborn: SecretStore = { ...secrets, deletePrefix: () => Promise.resolve(0) };
    const { vault } = fakeVault([]);
    const steps = createDefaultTeardownSteps(createInMemoryReceiptStore(), signingKey, vault, undefined, undefined, {
      expectedResources: ["a"],
      secrets: stubborn,
    });

    expect(await runStepOnce(stepByName(steps, "delete_cached_data"), makeTestLease(LEASE_ID), NOW)).toBe("failed");
  });

  it("a rejecting deletePrefix is failed and the lease lands cleanup_incomplete", async () => {
    const secrets = await seeded();
    const broken: SecretStore = { ...secrets, deletePrefix: () => Promise.reject(new Error("disk")) };
    const leaseStore = createInMemoryLeaseStore();
    const receiptStore = createInMemoryReceiptStore();
    await leaseStore.save(makeTestLease(LEASE_ID, { state: "expired" }));
    const { vault } = fakeVault([]);
    const steps = createDefaultTeardownSteps(receiptStore, signingKey, vault, undefined, undefined, {
      expectedResources: ["a"],
      secrets: broken,
    });

    const lease = await runTeardown({ leaseStore, receiptStore, leaseId: LEASE_ID, steps }, NOW);

    expect(lease.state).toBe("cleanup_incomplete");
    expect(lease.teardownProgress?.delete_cached_data).toBe("failed");
  });

  it("a rejecting vault.discardLeaseCredentials is awaited and surfaced as failed", async () => {
    const { vault } = fakeVault([], () => Promise.reject(new Error("deletePrefix failed")));
    const steps = createDefaultTeardownSteps(createInMemoryReceiptStore(), signingKey, vault);

    expect(await runStepOnce(stepByName(steps, "delete_cached_data"), makeTestLease(LEASE_ID), NOW)).toBe("failed");
  });

  it("uses the lease prefix for the purge", async () => {
    const calls: string[] = [];
    const inner = createInMemorySecretStore();
    const spy: SecretStore = {
      ...inner,
      deletePrefix(prefix) {
        calls.push(prefix);
        return inner.deletePrefix(prefix);
      },
    };
    const { vault } = fakeVault([]);
    const steps = createDefaultTeardownSteps(createInMemoryReceiptStore(), signingKey, vault, undefined, undefined, {
      secrets: spy,
    });

    await runStepOnce(stepByName(steps, "delete_cached_data"), makeTestLease(LEASE_ID), NOW);

    expect(calls).toEqual([leaseSecretPrefix(LEASE_ID)]);
  });
});
