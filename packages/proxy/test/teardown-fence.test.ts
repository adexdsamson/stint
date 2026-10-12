/**
 * SUP-03 (Phase 9 D-09 to D-11): the teardown fence's ownership and crash
 * recovery rules, proven directly. A crash is simulated by persisting the
 * state a killed process leaves (a `tearing_down` lease with some steps
 * recorded and an unreleased fence), not by throwing from a step: a thrown
 * error releases the fence, which is right for a live process and is not what
 * a killed one does. The in-flight step of a crash is at-least-once; what
 * these tests pin is that no RECORDED step is ever repeated.
 */

import { generateKeyPair } from "jose";
import type { CryptoKey } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import { verifyChain } from "@stint/core";
import type { Lease, LeaseStore, ReceiptEntry, ReceiptStore, TeardownProgress, TeardownStepName } from "@stint/core";
import {
  createInMemoryLeaseStore,
  createInMemoryReceiptStore,
  createRecordingTelemetry,
  makeTearingDownTestLease,
  makeTestLease,
} from "@stint/core/testing";

import { createDefaultTeardownSteps, runTeardown, TEARDOWN_STEP_ORDER, TeardownFencedError } from "../src/index.js";
import type { TeardownDeps, TeardownFenceConfig, TeardownStep } from "../src/index.js";
import { acquireFence } from "../src/teardown/fence.js";

const NOW = 1_700_000_000;
const T = 5_000;
const TTL = 120;
const LEASE_ID = "lease-teardown-fence";

let signingKey: CryptoKey;

beforeAll(async () => {
  ({ privateKey: signingKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true }));
});

type Runs = Record<TeardownStepName, number>;

interface Counted {
  readonly steps: readonly TeardownStep[];
  readonly runs: Runs;
}

/** Wraps the default steps so every run is counted and `failing` steps always resolve `failed`. */
function countingSteps(receiptStore: ReceiptStore, failing: readonly TeardownStepName[] = []): Counted {
  const runs = Object.fromEntries(TEARDOWN_STEP_ORDER.map((n) => [n, 0])) as Runs;
  const steps = createDefaultTeardownSteps(receiptStore, signingKey).map(
    (inner): TeardownStep => ({
      name: inner.name,
      async run(lease, now) {
        runs[inner.name] += 1;
        await Promise.resolve();
        if (failing.includes(inner.name)) return "failed";
        return inner.run(lease, now);
      },
    }),
  );
  return { steps, runs };
}

/** A mutable fence clock: `clock.t` is the live time every fence read returns. */
interface MutableClock {
  t: number;
  readonly config: TeardownFenceConfig;
}

function mutableClock(start: number): MutableClock {
  const clock: MutableClock = {
    t: start,
    config: { clock: () => clock.t, ttlSeconds: TTL },
  };
  return clock;
}

interface Rig {
  readonly leaseStore: ReturnType<typeof createInMemoryLeaseStore>;
  readonly receipts: ReceiptStore;
  readonly counted: Counted;
  readonly clock: MutableClock;
  readonly deps: TeardownDeps;
}

async function buildRig(lease: Lease, failing: readonly TeardownStepName[] = []): Promise<Rig> {
  const leaseStore = createInMemoryLeaseStore();
  const receipts = createInMemoryReceiptStore();
  await leaseStore.save(lease);
  const counted = countingSteps(receipts, failing);
  const clock = mutableClock(T);
  const deps: TeardownDeps = {
    leaseStore,
    receiptStore: receipts,
    leaseId: lease.id,
    steps: counted.steps,
    fence: clock.config,
  };
  return { leaseStore, receipts, counted, clock, deps };
}

/** The state a killed driver leaves: some steps recorded, the fence never released. */
function crashedLease(progress: TeardownProgress, fence: { epoch: number; expiresAt: number }): Lease {
  return makeTearingDownTestLease(LEASE_ID, { teardownProgress: progress, fence });
}

function takeovers(chain: readonly ReceiptEntry[]): ReceiptEntry[] {
  return chain.filter((entry) => entry.type === "teardown_takeover");
}

function totalRuns(runs: Runs): number {
  return TEARDOWN_STEP_ORDER.reduce((sum, name) => sum + runs[name], 0);
}

describe("fence acquire and release (D-09)", () => {
  it("acquires epoch 1 on a lease with no fence, appends no takeover receipt and releases at landing", async () => {
    const rig = await buildRig(makeTestLease(LEASE_ID, { state: "expired" }));

    const lease = await runTeardown(rig.deps, NOW);

    expect(lease.state).toBe("cleaned_up");
    expect((await rig.leaseStore.load(LEASE_ID))?.fence).toEqual({ epoch: 1, expiresAt: 0 });
    expect(takeovers(await rig.receipts.load("verified"))).toHaveLength(0);
  });

  it("re-acquires a released fence as the next epoch with no takeover receipt", async () => {
    const rig = await buildRig(crashedLease({}, { epoch: 3, expiresAt: 0 }));

    await runTeardown(rig.deps, NOW);

    expect((await rig.leaseStore.load(LEASE_ID))?.fence).toEqual({ epoch: 4, expiresAt: 0 });
    expect(takeovers(await rig.receipts.load("verified"))).toHaveLength(0);
  });
});

describe("a live fence refuses a second driver (D-09)", () => {
  it("rejects with TeardownFencedError held before any step runs and changes nothing", async () => {
    const rig = await buildRig(crashedLease({}, { epoch: 1, expiresAt: T + 60 }));

    const error: unknown = await runTeardown(rig.deps, NOW).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TeardownFencedError);
    expect((error as TeardownFencedError).kind).toBe("held");
    expect(totalRuns(rig.counted.runs)).toBe(0);
    expect(await rig.receipts.load("verified")).toEqual([]);
    const lease = await rig.leaseStore.load(LEASE_ID);
    expect(lease?.state).toBe("tearing_down");
    expect(lease?.fence).toEqual({ epoch: 1, expiresAt: T + 60 });
    expect(lease?.teardownProgress).toEqual({});
  });

  it("boundary: expiresAt equal to the fence clock is taken over", async () => {
    const rig = await buildRig(crashedLease({}, { epoch: 1, expiresAt: T }));

    const lease = await runTeardown(rig.deps, NOW);

    expect(lease.state).toBe("cleaned_up");
    expect(takeovers(await rig.receipts.load("verified"))).toHaveLength(1);
  });

  it("boundary: expiresAt one second after the fence clock is held", async () => {
    const rig = await buildRig(crashedLease({}, { epoch: 1, expiresAt: T + 1 }));

    const error: unknown = await runTeardown(rig.deps, NOW).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(TeardownFencedError);
    expect((error as TeardownFencedError).kind).toBe("held");
    expect(takeovers(await rig.receipts.load("verified"))).toHaveLength(0);
  });

  it("a fence exactly one TTL ahead is still live", async () => {
    const rig = await buildRig(crashedLease({}, { epoch: 1, expiresAt: T + TTL }));

    await expect(runTeardown(rig.deps, NOW)).rejects.toBeInstanceOf(TeardownFencedError);
  });

  it("a fence more than one TTL ahead is implausible and is taken over with a receipt", async () => {
    const rig = await buildRig(crashedLease({}, { epoch: 1, expiresAt: T + TTL + 1 }));

    const lease = await runTeardown(rig.deps, NOW);

    expect(lease.state).toBe("cleaned_up");
    expect(takeovers(await rig.receipts.load("verified"))).toHaveLength(1);
  });
});

describe("takeover of an expired fence (D-10)", () => {
  it("receipts exactly { previousEpoch, epoch, reason } before the first step receipt and emits telemetry", async () => {
    const rig = await buildRig(crashedLease({}, { epoch: 1, expiresAt: T - 1 }));
    const telemetry = createRecordingTelemetry();

    await runTeardown({ ...rig.deps, telemetry }, NOW);

    const chain = await rig.receipts.load("verified");
    const takeover = takeovers(chain);
    expect(takeover).toHaveLength(1);
    expect(takeover[0]?.payload).toEqual({ previousEpoch: 1, epoch: 2, reason: "fence_expired" });
    const takeoverIndex = chain.findIndex((entry) => entry.type === "teardown_takeover");
    const firstStepIndex = chain.findIndex((entry) => entry.type === "teardown_step");
    expect(takeoverIndex).toBeGreaterThanOrEqual(0);
    expect(takeoverIndex).toBeLessThan(firstStepIndex);
    expect((await verifyChain(chain)).ok).toBe(true);

    const events = telemetry.events.filter((e) => e.name === "teardown.fence_takeover");
    expect(events).toEqual([{ name: "teardown.fence_takeover", leaseId: LEASE_ID, previousEpoch: 1, epoch: 2 }]);
  });

  it("two takeovers in a row produce epochs 2 then 3 and two receipts", async () => {
    const rig = await buildRig(crashedLease({}, { epoch: 1, expiresAt: T - 1 }));
    const deps = { leaseStore: rig.leaseStore, receiptStore: rig.receipts, leaseId: LEASE_ID };

    const first = await acquireFence(deps, rig.clock.config);
    expect(first.epoch).toBe(2);
    expect((await rig.leaseStore.load(LEASE_ID))?.fence).toEqual({ epoch: 2, expiresAt: T + TTL });

    rig.clock.t = T + TTL + 1;
    const second = await acquireFence(deps, rig.clock.config);
    expect(second.epoch).toBe(3);

    const chain = await rig.receipts.load("verified");
    expect(takeovers(chain).map((entry) => entry.payload)).toEqual([
      { previousEpoch: 1, epoch: 2, reason: "fence_expired" },
      { previousEpoch: 2, epoch: 3, reason: "fence_expired" },
    ]);
    expect((await verifyChain(chain)).ok).toBe(true);
  });
});

describe("crash resume (SUP-03)", () => {
  it("resumes from teardownProgress: recorded steps never re-run, the rest run once, lands cleaned_up with the fence released", async () => {
    const rig = await buildRig(
      crashedLease({ revoke_oauth: "revoked", invalidate_license: "ok" }, { epoch: 1, expiresAt: T - 1 }),
    );

    const lease = await runTeardown(rig.deps, NOW);

    expect(rig.counted.runs.revoke_oauth).toBe(0);
    expect(rig.counted.runs.invalidate_license).toBe(0);
    expect(rig.counted.runs.cleanup_hook).toBe(1);
    expect(rig.counted.runs.delete_cached_data).toBe(1);
    expect(rig.counted.runs.final_receipt).toBe(1);
    expect(lease.state).toBe("cleaned_up");
    expect((await rig.leaseStore.load(LEASE_ID))?.fence).toEqual({ epoch: 2, expiresAt: 0 });

    const chain = await rig.receipts.load("verified");
    expect((await verifyChain(chain)).ok).toBe(true);
    expect(takeovers(chain)).toHaveLength(1);
    const stepReceipts = chain.flatMap((entry) => (entry.type === "teardown_step" ? [entry.payload.step] : []));
    expect(stepReceipts).toEqual(["cleanup_hook", "delete_cached_data", "final_receipt"]);
  });

  it("a revoke_oauth recorded failed before the crash is not re-run and the lease lands cleanup_incomplete", async () => {
    const rig = await buildRig(
      crashedLease({ revoke_oauth: "failed", invalidate_license: "ok" }, { epoch: 1, expiresAt: T - 1 }),
    );

    const lease = await runTeardown(rig.deps, NOW);

    expect(rig.counted.runs.revoke_oauth).toBe(0);
    expect(lease.state).toBe("cleanup_incomplete");
    expect(lease.teardownProgress?.revoke_oauth).toBe("failed");
    expect((await rig.leaseStore.load(LEASE_ID))?.fence).toEqual({ epoch: 2, expiresAt: 0 });
    expect((await verifyChain(await rig.receipts.load("verified"))).ok).toBe(true);
  });
});

describe("fence renewal (D-11)", () => {
  it("renews from the live clock at every step, never from the pass now", async () => {
    const rig = await buildRig(makeTestLease(LEASE_ID, { state: "expired" }));
    let reads = 1_000;
    const clock: TeardownFenceConfig = {
      clock: () => {
        reads += 10;
        return reads;
      },
      ttlSeconds: TTL,
    };
    const seen: number[] = [];
    const steps = rig.counted.steps.map(
      (inner): TeardownStep => ({
        name: inner.name,
        run(lease, now) {
          seen.push(lease.fence?.expiresAt ?? -1);
          return inner.run(lease, now);
        },
      }),
    );

    await runTeardown({ ...rig.deps, steps, fence: clock }, NOW);

    // acquire read 1010, then one read per step transaction: each step sees the previous expiry.
    expect(seen).toEqual([1_130, 1_140, 1_150, 1_160, 1_170]);
  });

  it("stamps the renewal after a long step finishes, so a slow step does not eat its own lease", async () => {
    const rig = await buildRig(makeTestLease(LEASE_ID, { state: "expired" }));
    const seen: number[] = [];
    const steps = rig.counted.steps.map(
      (inner): TeardownStep => ({
        name: inner.name,
        async run(lease, now) {
          seen.push(lease.fence?.expiresAt ?? -1);
          if (inner.name === "revoke_oauth") rig.clock.t += 100;
          return inner.run(lease, now);
        },
      }),
    );

    await runTeardown({ ...rig.deps, steps }, NOW);

    // Acquire stamped T + TTL; the first step took 100 s; the renewal that the next step sees is from after it.
    expect(seen[0]).toBe(T + TTL);
    expect(seen[1]).toBe(T + 100 + TTL);
  });
});

describe("stale holder (T-09-07)", () => {
  it("a driver whose fence was taken over rejects with stale before its next step and its run count does not change", async () => {
    const leaseStore = createInMemoryLeaseStore();
    const receipts = createInMemoryReceiptStore();
    await leaseStore.save(makeTestLease(LEASE_ID, { state: "expired" }));
    const countedA = countingSteps(receipts);
    const countedB = countingSteps(receipts);
    const clock = mutableClock(T);

    const depsB: TeardownDeps = {
      leaseStore,
      receiptStore: receipts,
      leaseId: LEASE_ID,
      steps: countedB.steps,
      fence: clock.config,
    };

    // Driver A's store hands control to driver B exactly once: after A recorded its first step, before A's next transaction.
    let handedOver: Promise<Lease> | undefined;
    const storeA: LeaseStore = {
      ...leaseStore,
      async transaction(id, mutate) {
        if (handedOver === undefined && countedA.runs.revoke_oauth === 1) {
          clock.t += TTL + 1;
          handedOver = runTeardown(depsB, NOW);
          await handedOver;
        }
        return leaseStore.transaction(id, mutate);
      },
    };
    const depsA: TeardownDeps = { ...depsB, leaseStore: storeA, steps: countedA.steps };

    const outcomeA: unknown = await runTeardown(depsA, NOW).catch((e: unknown) => e);
    const outcomeB = await handedOver;

    expect(outcomeA).toBeInstanceOf(TeardownFencedError);
    expect((outcomeA as TeardownFencedError).kind).toBe("stale");
    expect(countedA.runs.revoke_oauth).toBe(1);
    expect(countedA.runs.invalidate_license).toBe(0);
    expect(countedB.runs.revoke_oauth).toBe(0);
    for (const name of ["invalidate_license", "cleanup_hook", "delete_cached_data", "final_receipt"] as const) {
      expect(countedB.runs[name]).toBe(1);
    }
    expect(outcomeB?.state).toBe("cleaned_up");

    const lease = await leaseStore.load(LEASE_ID);
    expect(lease?.state).toBe("cleaned_up");
    expect(lease?.fence).toEqual({ epoch: 2, expiresAt: 0 });
    const chain = await receipts.load("verified");
    expect((await verifyChain(chain)).ok).toBe(true);
    expect(takeovers(chain).map((entry) => entry.payload)).toEqual([
      { previousEpoch: 1, epoch: 2, reason: "fence_expired" },
    ]);
  });
});

describe("Phase 8 D-29 closed", () => {
  it("two fenced drivers started together run an always-failing step exactly once and one is held", async () => {
    const rig = await buildRig(makeTestLease(LEASE_ID, { state: "expired" }), ["cleanup_hook"]);

    const results = await Promise.allSettled([runTeardown(rig.deps, NOW), runTeardown(rig.deps, NOW)]);

    expect(rig.counted.runs.cleanup_hook).toBe(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(TeardownFencedError);
    expect((rejected[0]?.reason as TeardownFencedError).kind).toBe("held");

    const lease = await rig.leaseStore.load(LEASE_ID);
    expect(lease?.state).toBe("cleanup_incomplete");
    const chain = await rig.receipts.load("verified");
    const incomplete = chain.filter((e) => e.type === "transition" && e.payload.event === "teardown_incomplete");
    expect(incomplete).toHaveLength(1);
    expect((await verifyChain(chain)).ok).toBe(true);
  });
});
