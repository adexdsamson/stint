/**
 * TEAR-06 (second half): teardown is safe under concurrent drivers. Two
 * `runTeardown`/`retryTeardown` drivers started together on one lease run
 * every step that succeeds exactly once, leave one unforked verifying chain,
 * land the lease once, notify once, and neither driver throws.
 */

import { generateKeyPair } from "jose";
import type { CryptoKey } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import { verifyChain } from "@stint/core";
import type { Lease, LifecycleEvent, ReceiptEntry, ReceiptStore, TeardownStepName } from "@stint/core";
import {
  createInMemoryLeaseStore,
  createInMemoryReceiptStore,
  createRecordingTelemetry,
  makeTearingDownTestLease,
  makeTestLease,
} from "@stint/core/testing";

import {
  createDefaultTeardownSteps,
  retryTeardown,
  runTeardown,
  TEARDOWN_STEP_ORDER,
  TeardownFencedError,
} from "../src/index.js";
import type { TeardownDeps, TeardownFenceConfig, TeardownStep } from "../src/index.js";

const NOW = 1_700_000_000;
const LEASE_ID = "lease-teardown-concurrent";

let signingKey: CryptoKey;

beforeAll(async () => {
  ({ privateKey: signingKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true }));
});

interface Counted {
  readonly steps: readonly TeardownStep[];
  readonly runs: Record<TeardownStepName, number>;
  readonly succeeded: Record<TeardownStepName, number>;
}

/** Wraps the default steps so every run is counted and `failing` steps always resolve `failed`. */
function countingSteps(receiptStore: ReceiptStore, failing: readonly TeardownStepName[] = []): Counted {
  const runs = Object.fromEntries(TEARDOWN_STEP_ORDER.map((n) => [n, 0])) as Record<TeardownStepName, number>;
  const succeeded = { ...runs };
  const steps = createDefaultTeardownSteps(receiptStore, signingKey).map(
    (inner): TeardownStep => ({
      name: inner.name,
      async run(lease, now) {
        runs[inner.name] += 1;
        await Promise.resolve();
        if (failing.includes(inner.name)) return "failed";
        const outcome = await inner.run(lease, now);
        if (outcome !== "failed") succeeded[inner.name] += 1;
        return outcome;
      },
    }),
  );
  return { steps, runs, succeeded };
}

/** A receipt store that yields between every load and append, widening the race window. */
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

interface Rig {
  readonly deps: TeardownDeps;
  readonly leaseStore: ReturnType<typeof createInMemoryLeaseStore>;
  readonly rawReceipts: ReceiptStore;
  readonly counted: Counted;
  readonly notified: LifecycleEvent[];
}

async function buildRig(
  lease: Lease,
  options: { failing?: readonly TeardownStepName[]; interleave?: boolean; fence?: TeardownFenceConfig } = {},
): Promise<Rig> {
  const leaseStore = createInMemoryLeaseStore();
  const rawReceipts = createInMemoryReceiptStore();
  const receiptStore = options.interleave === true ? interleavingReceiptStore(rawReceipts) : rawReceipts;
  await leaseStore.save(lease);
  const counted = countingSteps(receiptStore, options.failing);
  const notified: LifecycleEvent[] = [];
  const deps: TeardownDeps = {
    leaseStore,
    receiptStore,
    leaseId: lease.id,
    steps: counted.steps,
    notify(event) {
      notified.push(event);
      return Promise.resolve();
    },
    ...(options.fence === undefined ? {} : { fence: options.fence }),
  };
  return { deps, leaseStore, rawReceipts, counted, notified };
}

function transitionEvents(chain: readonly ReceiptEntry[]): string[] {
  return chain.flatMap((entry) => (entry.type === "transition" ? [entry.payload.event] : []));
}

function seqs(chain: readonly ReceiptEntry[]): number[] {
  return chain.map((entry) => entry.seq);
}

describe("two concurrent runTeardown drivers (TEAR-06)", () => {
  for (const interleave of [false, true]) {
    it(`run every step once, leave one verifying chain and land once (${interleave ? "interleaving" : "plain"} receipt store)`, async () => {
      const rig = await buildRig(makeTestLease(LEASE_ID, { state: "expired" }), { interleave });

      const results = await Promise.allSettled([runTeardown(rig.deps, NOW), runTeardown(rig.deps, NOW)]);

      expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
      for (const name of TEARDOWN_STEP_ORDER) expect(rig.counted.runs[name]).toBe(1);

      const lease = await rig.leaseStore.load(LEASE_ID);
      expect(lease?.state).toBe("cleaned_up");
      expect(rig.notified).toEqual([{ type: "cleaned_up", leaseId: LEASE_ID, at: NOW }]);

      const chain = await rig.rawReceipts.load("verified");
      expect((await verifyChain(chain)).ok).toBe(true);
      expect(new Set(seqs(chain)).size).toBe(chain.length);
      const events = transitionEvents(chain);
      expect(events.filter((e) => e === "begin_teardown")).toHaveLength(1);
      expect(events.filter((e) => e === "teardown_succeeded")).toHaveLength(1);
      expect(chain.filter((e) => e.type === "teardown_step")).toHaveLength(5);
    });
  }

  it("with one step always failing: lands cleanup_incomplete once, neither driver throws, successes ran once", async () => {
    const rig = await buildRig(makeTestLease(LEASE_ID, { state: "expired" }), { failing: ["cleanup_hook"] });

    const results = await Promise.allSettled([runTeardown(rig.deps, NOW), runTeardown(rig.deps, NOW)]);

    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    for (const name of TEARDOWN_STEP_ORDER) {
      if (name !== "cleanup_hook") expect(rig.counted.succeeded[name]).toBeLessThanOrEqual(1);
    }
    expect(rig.counted.succeeded.revoke_oauth).toBe(1);
    expect(rig.counted.runs.revoke_oauth).toBe(1);

    const lease = await rig.leaseStore.load(LEASE_ID);
    expect(lease?.state).toBe("cleanup_incomplete");
    expect(rig.notified).toEqual([{ type: "cleanup_incomplete", leaseId: LEASE_ID, at: NOW }]);

    const chain = await rig.rawReceipts.load("verified");
    expect((await verifyChain(chain)).ok).toBe(true);
    const events = transitionEvents(chain);
    expect(events.filter((e) => e === "teardown_incomplete")).toHaveLength(1);
    expect(events.filter((e) => e === "teardown_succeeded")).toHaveLength(0);
  });

  it("a driver started after the lease is cleaned_up returns it, runs no step and appends nothing", async () => {
    const rig = await buildRig(makeTestLease(LEASE_ID, { state: "expired" }));
    await runTeardown(rig.deps, NOW);
    const before = await rig.rawReceipts.load("verified");
    const runsBefore = { ...rig.counted.runs };
    rig.notified.length = 0;

    const lease = await runTeardown(rig.deps, NOW + 1);

    expect(lease.state).toBe("cleaned_up");
    expect(rig.counted.runs).toEqual(runsBefore);
    expect(await rig.rawReceipts.load("verified")).toHaveLength(before.length);
    expect(rig.notified).toEqual([]);
  });

  it("a recorded revoked outcome is not re-run and its record is unchanged", async () => {
    const rig = await buildRig(
      makeTearingDownTestLease(LEASE_ID, { state: "tearing_down", teardownProgress: { revoke_oauth: "revoked" } }),
    );

    await Promise.all([runTeardown(rig.deps, NOW), runTeardown(rig.deps, NOW)]);

    expect(rig.counted.runs.revoke_oauth).toBe(0);
    const lease = await rig.leaseStore.load(LEASE_ID);
    expect(lease?.teardownProgress?.revoke_oauth).toBe("revoked");
    expect(lease?.state).toBe("cleaned_up");
  });

  it("a recorded real outcome is never replaced: not_applicable never overwrites revoked", async () => {
    const rig = await buildRig(
      makeTearingDownTestLease(LEASE_ID, {
        state: "tearing_down",
        teardownProgress: { revoke_oauth: "revoked", invalidate_license: "ok" },
      }),
    );

    await Promise.all([runTeardown(rig.deps, NOW), runTeardown(rig.deps, NOW), runTeardown(rig.deps, NOW)]);

    const lease = await rig.leaseStore.load(LEASE_ID);
    expect(lease?.teardownProgress?.revoke_oauth).toBe("revoked");
    expect(lease?.teardownProgress?.invalidate_license).toBe("ok");
    expect(rig.counted.runs.invalidate_license).toBe(0);
  });
});

describe("two concurrent retryTeardown drivers (TEAR-06)", () => {
  it("dispatch retry_teardown once, never re-run recorded successes or an attempted revoke_oauth, and neither throws", async () => {
    const rig = await buildRig(
      makeTestLease(LEASE_ID, {
        state: "cleanup_incomplete",
        teardownProgress: {
          revoke_oauth: "failed",
          invalidate_license: "ok",
          cleanup_hook: "failed",
          delete_cached_data: "ok",
          final_receipt: "failed",
        },
      }),
    );

    const results = await Promise.allSettled([
      retryTeardown(rig.deps, "user", NOW),
      retryTeardown(rig.deps, "user", NOW),
    ]);

    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(rig.counted.runs.revoke_oauth).toBe(0);
    expect(rig.counted.runs.invalidate_license).toBe(0);
    expect(rig.counted.runs.delete_cached_data).toBe(0);
    expect(rig.counted.succeeded.cleanup_hook).toBe(1);
    expect(rig.counted.succeeded.final_receipt).toBe(1);

    const lease = await rig.leaseStore.load(LEASE_ID);
    expect(lease?.state).toBe("cleanup_incomplete");
    expect(lease?.teardownProgress?.revoke_oauth).toBe("failed");

    const chain = await rig.rawReceipts.load("verified");
    expect((await verifyChain(chain)).ok).toBe(true);
    const events = transitionEvents(chain);
    expect(events.filter((e) => e === "retry_teardown")).toHaveLength(1);
    expect(events.filter((e) => e === "teardown_incomplete")).toHaveLength(1);
  });

  it("a retry on a lease in a state that cannot retry still throws the invariant error", async () => {
    const rig = await buildRig(makeTestLease(LEASE_ID, { state: "active" }));

    await expect(retryTeardown(rig.deps, "user", NOW)).rejects.toThrow(/teardown transition rejected/);
  });
});

describe("teardown telemetry (TEAR-06)", () => {
  it("emits one teardown.step per step run and one lease.transition per transition performed", async () => {
    const rig = await buildRig(makeTestLease(LEASE_ID, { state: "expired" }));
    const telemetry = createRecordingTelemetry();

    await runTeardown({ ...rig.deps, telemetry }, NOW);

    const stepNames = telemetry.events.flatMap((e) => (e.name === "teardown.step" ? [e.step] : []));
    expect(stepNames).toEqual(TEARDOWN_STEP_ORDER);
    const transitions = telemetry.events.flatMap((e) => (e.name === "lease.transition" ? [`${e.from}>${e.to}`] : []));
    expect(transitions).toEqual(["expired>tearing_down", "tearing_down>cleaned_up"]);
  });

  it("two concurrent drivers sharing a sink emit each step and transition once", async () => {
    const rig = await buildRig(makeTestLease(LEASE_ID, { state: "expired" }));
    const telemetry = createRecordingTelemetry();

    await Promise.all([runTeardown({ ...rig.deps, telemetry }, NOW), runTeardown({ ...rig.deps, telemetry }, NOW)]);

    expect(telemetry.events.filter((e) => e.name === "teardown.step")).toHaveLength(5);
    expect(telemetry.events.filter((e) => e.name === "lease.transition")).toHaveLength(2);
  });

  it("a throwing sink changes nothing", async () => {
    const rig = await buildRig(makeTestLease(LEASE_ID, { state: "expired" }));
    const telemetry = {
      emit(): void {
        throw new Error("sink exploded");
      },
    };

    const lease = await runTeardown({ ...rig.deps, telemetry }, NOW);

    expect(lease.state).toBe("cleaned_up");
    expect((await verifyChain(await rig.rawReceipts.load("verified"))).ok).toBe(true);
  });
});

const FENCE: TeardownFenceConfig = { clock: () => NOW, ttlSeconds: 120 };

/** Splits settled results into the fulfilled count and the `TeardownFencedError` kinds of the rejected ones; any other rejection fails the test. */
function fencedOutcome(results: readonly PromiseSettledResult<Lease>[]): { fulfilled: number; held: number } {
  let fulfilled = 0;
  let held = 0;
  for (const result of results) {
    if (result.status === "fulfilled") {
      fulfilled += 1;
    } else {
      expect(result.reason).toBeInstanceOf(TeardownFencedError);
      expect((result.reason as TeardownFencedError).kind).toBe("held");
      held += 1;
    }
  }
  return { fulfilled, held };
}

describe("fenced drivers (Phase 9)", () => {
  for (const interleave of [false, true]) {
    it(`two runTeardown drivers: one owns the pass, runs every step once and lands once, the other is held (${interleave ? "interleaving" : "plain"} receipt store)`, async () => {
      const rig = await buildRig(makeTestLease(LEASE_ID, { state: "expired" }), { interleave, fence: FENCE });

      const results = await Promise.allSettled([runTeardown(rig.deps, NOW), runTeardown(rig.deps, NOW)]);

      expect(fencedOutcome(results)).toEqual({ fulfilled: 1, held: 1 });
      for (const name of TEARDOWN_STEP_ORDER) expect(rig.counted.runs[name]).toBe(1);

      const lease = await rig.leaseStore.load(LEASE_ID);
      expect(lease?.state).toBe("cleaned_up");
      expect(lease?.fence).toEqual({ epoch: 1, expiresAt: 0 });
      expect(rig.notified).toEqual([{ type: "cleaned_up", leaseId: LEASE_ID, at: NOW }]);

      const chain = await rig.rawReceipts.load("verified");
      expect((await verifyChain(chain)).ok).toBe(true);
      expect(chain.filter((e) => e.type === "teardown_step")).toHaveLength(5);
      expect(chain.filter((e) => e.type === "teardown_takeover")).toHaveLength(0);
      const events = transitionEvents(chain);
      expect(events.filter((e) => e === "begin_teardown")).toHaveLength(1);
      expect(events.filter((e) => e === "teardown_succeeded")).toHaveLength(1);
    });
  }

  it("with one step always failing, that step runs exactly once, the lease lands cleanup_incomplete once and the other driver is held", async () => {
    const rig = await buildRig(makeTestLease(LEASE_ID, { state: "expired" }), {
      failing: ["cleanup_hook"],
      fence: FENCE,
    });

    const results = await Promise.allSettled([runTeardown(rig.deps, NOW), runTeardown(rig.deps, NOW)]);

    expect(fencedOutcome(results)).toEqual({ fulfilled: 1, held: 1 });
    expect(rig.counted.runs.cleanup_hook).toBe(1);
    for (const name of TEARDOWN_STEP_ORDER) expect(rig.counted.runs[name]).toBe(1);

    const lease = await rig.leaseStore.load(LEASE_ID);
    expect(lease?.state).toBe("cleanup_incomplete");
    expect(rig.notified).toEqual([{ type: "cleanup_incomplete", leaseId: LEASE_ID, at: NOW }]);

    const chain = await rig.rawReceipts.load("verified");
    expect((await verifyChain(chain)).ok).toBe(true);
    const events = transitionEvents(chain);
    expect(events.filter((e) => e === "teardown_incomplete")).toHaveLength(1);
  });

  it("three drivers on a lease with recorded successes never re-run them and only one is not held", async () => {
    const rig = await buildRig(
      makeTearingDownTestLease(LEASE_ID, {
        teardownProgress: { revoke_oauth: "revoked", invalidate_license: "ok" },
      }),
      { fence: FENCE },
    );

    const results = await Promise.allSettled([
      runTeardown(rig.deps, NOW),
      runTeardown(rig.deps, NOW),
      runTeardown(rig.deps, NOW),
    ]);

    expect(fencedOutcome(results)).toEqual({ fulfilled: 1, held: 2 });
    expect(rig.counted.runs.revoke_oauth).toBe(0);
    expect(rig.counted.runs.invalidate_license).toBe(0);
    for (const name of ["cleanup_hook", "delete_cached_data", "final_receipt"] as const) {
      expect(rig.counted.runs[name]).toBe(1);
    }
    expect((await rig.leaseStore.load(LEASE_ID))?.state).toBe("cleaned_up");
  });

  it("two retryTeardown drivers dispatch retry_teardown once, never re-run recorded successes or an attempted revoke_oauth, and the other is held", async () => {
    const rig = await buildRig(
      makeTestLease(LEASE_ID, {
        state: "cleanup_incomplete",
        teardownProgress: {
          revoke_oauth: "failed",
          invalidate_license: "ok",
          cleanup_hook: "failed",
          delete_cached_data: "ok",
          final_receipt: "failed",
        },
      }),
      { fence: FENCE },
    );

    const results = await Promise.allSettled([
      retryTeardown(rig.deps, "user", NOW),
      retryTeardown(rig.deps, "user", NOW),
    ]);

    expect(fencedOutcome(results)).toEqual({ fulfilled: 1, held: 1 });
    expect(rig.counted.runs.revoke_oauth).toBe(0);
    expect(rig.counted.runs.invalidate_license).toBe(0);
    expect(rig.counted.runs.delete_cached_data).toBe(0);
    expect(rig.counted.runs.cleanup_hook).toBe(1);
    expect(rig.counted.runs.final_receipt).toBe(1);

    const lease = await rig.leaseStore.load(LEASE_ID);
    expect(lease?.state).toBe("cleanup_incomplete");
    expect(lease?.fence?.expiresAt).toBe(0);

    const chain = await rig.rawReceipts.load("verified");
    expect((await verifyChain(chain)).ok).toBe(true);
    const events = transitionEvents(chain);
    expect(events.filter((e) => e === "retry_teardown")).toHaveLength(1);
    expect(events.filter((e) => e === "teardown_incomplete")).toHaveLength(1);
  });

  it("a fenced driver started after the lease is cleaned_up returns it, acquires no fence, runs no step and appends nothing", async () => {
    const rig = await buildRig(makeTestLease(LEASE_ID, { state: "expired" }), { fence: FENCE });
    await runTeardown(rig.deps, NOW);
    const before = await rig.rawReceipts.load("verified");
    const runsBefore = { ...rig.counted.runs };

    const lease = await runTeardown(rig.deps, NOW + 1);

    expect(lease.state).toBe("cleaned_up");
    expect(lease.fence).toEqual({ epoch: 1, expiresAt: 0 });
    expect(rig.counted.runs).toEqual(runsBefore);
    expect(await rig.rawReceipts.load("verified")).toHaveLength(before.length);
  });
});
