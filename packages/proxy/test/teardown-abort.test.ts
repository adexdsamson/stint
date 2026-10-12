/**
 * SUP-07 (Phase 9 D-21): a graceful stop ends a teardown pass between steps.
 * The abort is raised from inside a step, the way a Ctrl-C arrives while a
 * step is in flight: that step finishes and is recorded, no later step starts,
 * the fence is released (not left to expire) and the next driver resumes with
 * no takeover receipt and no repeated step.
 */

import { generateKeyPair } from "jose";
import type { CryptoKey } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import { verifyChain } from "@stint/core";
import type { Lease, ReceiptEntry, ReceiptStore, TeardownStepName } from "@stint/core";
import { createInMemoryLeaseStore, createInMemoryReceiptStore, makeTestLease } from "@stint/core/testing";

import { createDefaultTeardownSteps, runTeardown, TEARDOWN_STEP_ORDER } from "../src/index.js";
import type { TeardownDeps, TeardownStep } from "../src/index.js";

const NOW = 1_700_000_000;
const T = 5_000;
const LEASE_ID = "lease-teardown-abort";

let signingKey: CryptoKey;

beforeAll(async () => {
  ({ privateKey: signingKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true }));
});

type Runs = Record<TeardownStepName, number>;

/** Counts every step run and aborts `controller` right after `abortAfter` has run. */
function countingSteps(
  receiptStore: ReceiptStore,
  controller: AbortController,
  abortAfter: TeardownStepName | undefined,
): { readonly steps: readonly TeardownStep[]; readonly runs: Runs } {
  const runs = Object.fromEntries(TEARDOWN_STEP_ORDER.map((name) => [name, 0])) as Runs;
  const steps = createDefaultTeardownSteps(receiptStore, signingKey).map(
    (inner): TeardownStep => ({
      name: inner.name,
      async run(lease, now) {
        runs[inner.name] += 1;
        const outcome = await inner.run(lease, now);
        if (inner.name === abortAfter) controller.abort();
        return outcome;
      },
    }),
  );
  return { steps, runs };
}

function takeovers(chain: readonly ReceiptEntry[]): ReceiptEntry[] {
  return chain.filter((entry) => entry.type === "teardown_takeover");
}

function stepReceipts(chain: readonly ReceiptEntry[]): string[] {
  return chain.flatMap((entry) => (entry.type === "teardown_step" ? [entry.payload.step] : []));
}

interface Rig {
  readonly leaseStore: ReturnType<typeof createInMemoryLeaseStore>;
  readonly receipts: ReceiptStore;
  readonly clock: { t: number };
}

async function buildRig(lease: Lease): Promise<Rig> {
  const leaseStore = createInMemoryLeaseStore();
  const receipts = createInMemoryReceiptStore();
  await leaseStore.save(lease);
  return { leaseStore, receipts, clock: { t: T } };
}

function depsFor(
  rig: Rig,
  counted: { readonly steps: readonly TeardownStep[] },
  options: { readonly fenced: boolean; readonly signal?: AbortSignal },
): TeardownDeps {
  return {
    leaseStore: rig.leaseStore,
    receiptStore: rig.receipts,
    leaseId: LEASE_ID,
    steps: counted.steps,
    ...(options.fenced ? { fence: { clock: () => rig.clock.t, ttlSeconds: 120 } } : {}),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
}

describe("a fenced pass stopped between steps (D-21)", () => {
  it("records the step in flight, runs no later step, lands nothing and releases the fence", async () => {
    const rig = await buildRig(makeTestLease(LEASE_ID, { state: "expired" }));
    const controller = new AbortController();
    const counted = countingSteps(rig.receipts, controller, "invalidate_license");

    const lease = await runTeardown(depsFor(rig, counted, { fenced: true, signal: controller.signal }), NOW);

    expect(lease.state).toBe("tearing_down");
    expect(counted.runs.revoke_oauth).toBe(1);
    expect(counted.runs.invalidate_license).toBe(1);
    expect(counted.runs.cleanup_hook).toBe(0);
    expect(counted.runs.delete_cached_data).toBe(0);
    expect(counted.runs.final_receipt).toBe(0);

    const stored = await rig.leaseStore.load(LEASE_ID);
    expect(stored?.state).toBe("tearing_down");
    expect(stored?.fence).toEqual({ epoch: 1, expiresAt: 0 });
    expect(Object.keys(stored?.teardownProgress ?? {}).sort()).toEqual(["invalidate_license", "revoke_oauth"]);

    const chain = await rig.receipts.load("verified");
    expect(stepReceipts(chain)).toEqual(["revoke_oauth", "invalidate_license"]);
    const landings = chain.filter(
      (entry) => entry.type === "transition" && (entry.payload.to === "cleaned_up" || entry.payload.to === "cleanup_incomplete"),
    );
    expect(landings).toEqual([]);
    expect((await verifyChain(chain)).ok).toBe(true);
  });

  it("the next driver resumes with epoch 2, no takeover receipt and no repeated step, and lands cleaned_up", async () => {
    const rig = await buildRig(makeTestLease(LEASE_ID, { state: "expired" }));
    const controller = new AbortController();
    const first = countingSteps(rig.receipts, controller, "invalidate_license");
    await runTeardown(depsFor(rig, first, { fenced: true, signal: controller.signal }), NOW);

    const second = countingSteps(rig.receipts, new AbortController(), undefined);
    const lease = await runTeardown(depsFor(rig, second, { fenced: true }), NOW);

    expect(lease.state).toBe("cleaned_up");
    expect(second.runs.revoke_oauth).toBe(0);
    expect(second.runs.invalidate_license).toBe(0);
    expect(second.runs.cleanup_hook).toBe(1);
    expect(second.runs.delete_cached_data).toBe(1);
    expect(second.runs.final_receipt).toBe(1);
    expect(first.runs.cleanup_hook).toBe(0);
    expect((await rig.leaseStore.load(LEASE_ID))?.fence).toEqual({ epoch: 2, expiresAt: 0 });

    const chain = await rig.receipts.load("verified");
    expect(takeovers(chain)).toHaveLength(0);
    expect(stepReceipts(chain)).toEqual([
      "revoke_oauth",
      "invalidate_license",
      "cleanup_hook",
      "delete_cached_data",
      "final_receipt",
    ]);
    expect((await verifyChain(chain)).ok).toBe(true);
  });

  it("a signal aborted before the pass starts runs no step but still releases the fence", async () => {
    const rig = await buildRig(makeTestLease(LEASE_ID, { state: "expired" }));
    const controller = new AbortController();
    controller.abort();
    const counted = countingSteps(rig.receipts, controller, undefined);

    const lease = await runTeardown(depsFor(rig, counted, { fenced: true, signal: controller.signal }), NOW);

    expect(lease.state).toBe("tearing_down");
    for (const name of TEARDOWN_STEP_ORDER) expect(counted.runs[name]).toBe(0);
    expect((await rig.leaseStore.load(LEASE_ID))?.fence).toEqual({ epoch: 1, expiresAt: 0 });
  });

  it("an abort during the last step still lands, because landing is not a step", async () => {
    const rig = await buildRig(makeTestLease(LEASE_ID, { state: "expired" }));
    const controller = new AbortController();
    const counted = countingSteps(rig.receipts, controller, "final_receipt");

    const lease = await runTeardown(depsFor(rig, counted, { fenced: true, signal: controller.signal }), NOW);

    expect(lease.state).toBe("cleaned_up");
    expect((await rig.leaseStore.load(LEASE_ID))?.fence).toEqual({ epoch: 1, expiresAt: 0 });
  });
});

describe("an unfenced pass stopped between steps (D-21)", () => {
  it("stops before the next step with an aborted signal and leaves the lease tearing_down", async () => {
    const rig = await buildRig(makeTestLease(LEASE_ID, { state: "expired" }));
    const controller = new AbortController();
    const counted = countingSteps(rig.receipts, controller, "revoke_oauth");

    const lease = await runTeardown(depsFor(rig, counted, { fenced: false, signal: controller.signal }), NOW);

    expect(lease.state).toBe("tearing_down");
    expect(counted.runs.revoke_oauth).toBe(1);
    expect(counted.runs.invalidate_license).toBe(0);
    expect((await rig.leaseStore.load(LEASE_ID))?.fence).toBeUndefined();
  });
});
