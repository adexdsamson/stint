/**
 * Task 2: one-pass fault handling + idempotent `retry_teardown` resume
 * (TEAR-04, TEAR-05 orchestrator matrix). Drives the injectable
 * `TeardownStep` ports (D-27) with a forced single-step failure for each of
 * the 5 fixed steps in turn, proving: the run still walks every remaining
 * step (a failure never aborts the saga, D-15), lands `cleanup_incomplete`
 * with every step's outcome honestly recorded, and `retryTeardown` resumes
 * from persisted progress -- skipping already-succeeded steps, never
 * re-attempting `revoke_oauth` once it has any recorded outcome (D-23), and
 * never landing the lease back in `active`.
 */

import { generateKeyPair } from "jose";
import type { CryptoKey } from "jose";
import { describe, expect, it } from "vitest";

import type { Lease, TeardownProgress, TeardownStepName } from "@stint/core";
import { createInMemoryLeaseStore, createInMemoryReceiptStore, makeTestLease } from "@stint/core/testing";

import {
  createDefaultTeardownSteps,
  retryTeardown,
  runTeardown,
  TEARDOWN_STEP_ORDER,
} from "../src/index.js";
import type { TeardownDeps, TeardownStep } from "../src/index.js";

const NOW = 1_700_000_000;

/** Swaps the named step in `steps` for a step that always resolves `"failed"` -- proves runtime rejection, not a thrown error, is handled identically via `runStepOnce`. */
function withFailingStep(steps: readonly TeardownStep[], name: TeardownStepName): readonly TeardownStep[] {
  return steps.map((step) =>
    step.name === name
      ? {
          name,
          run(): Promise<"failed"> {
            return Promise.resolve("failed");
          },
        }
      : step,
  );
}

/** Swaps the named step for one that THROWS -- `runStepOnce` must catch it and record `"failed"` too, never letting the loop abort. */
function withThrowingStep(steps: readonly TeardownStep[], name: TeardownStepName): readonly TeardownStep[] {
  return steps.map((step) =>
    step.name === name
      ? {
          name,
          run(): Promise<never> {
            return Promise.reject(new Error(`forced failure: ${name}`));
          },
        }
      : step,
  );
}

async function buildDeps(
  leaseId: string,
  overrideSteps?: (defaultSteps: readonly TeardownStep[]) => readonly TeardownStep[],
): Promise<{
  deps: TeardownDeps;
  leaseStore: ReturnType<typeof createInMemoryLeaseStore>;
  receiptStore: ReturnType<typeof createInMemoryReceiptStore>;
  signingKey: CryptoKey;
}> {
  const leaseStore = createInMemoryLeaseStore();
  const receiptStore = createInMemoryReceiptStore();
  const { privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });

  const lease: Lease = makeTestLease(leaseId, { state: "revoked" });
  await leaseStore.save(lease);

  const defaultSteps = createDefaultTeardownSteps(receiptStore, privateKey);
  const steps = overrideSteps !== undefined ? overrideSteps(defaultSteps) : defaultSteps;

  const deps: TeardownDeps = { leaseStore, receiptStore, leaseId, steps };
  return { deps, leaseStore, receiptStore, signingKey: privateKey };
}

const HAPPY_OUTCOMES: TeardownProgress = {
  revoke_oauth: "revoked",
  invalidate_license: "ok",
  cleanup_hook: "attested_ok",
  delete_cached_data: "ok",
  final_receipt: "ok",
};

describe("fault matrix: each single step failing lands cleanup_incomplete (TEAR-04)", () => {
  for (const failingStep of TEARDOWN_STEP_ORDER) {
    it(`forcing "${failingStep}" to fail -> cleanup_incomplete, with every step's outcome recorded and the rest still run`, async () => {
      const leaseId = `lease-fault-${failingStep}`;
      const { deps, leaseStore } = await buildDeps(leaseId, (defaults) => withFailingStep(defaults, failingStep));

      const finalLease = await runTeardown(deps, NOW);

      expect(finalLease.state).toBe("cleanup_incomplete");

      const lease = await leaseStore.load(leaseId);
      const expectedProgress: TeardownProgress = { ...HAPPY_OUTCOMES, [failingStep]: "failed" };
      expect(lease?.teardownProgress).toEqual(expectedProgress);

      // Every OTHER step still ran (the failure never aborted the saga).
      for (const name of TEARDOWN_STEP_ORDER) {
        expect(lease?.teardownProgress?.[name]).toBeDefined();
      }
    });

    it(`forcing "${failingStep}" to THROW is caught by runStepOnce and recorded as "failed" identically`, async () => {
      const leaseId = `lease-fault-throw-${failingStep}`;
      const { deps, leaseStore } = await buildDeps(leaseId, (defaults) => withThrowingStep(defaults, failingStep));

      const finalLease = await runTeardown(deps, NOW);

      expect(finalLease.state).toBe("cleanup_incomplete");
      const lease = await leaseStore.load(leaseId);
      expect(lease?.teardownProgress?.[failingStep]).toBe("failed");
    });
  }
});

describe("retry_teardown resume (D-14, D-15, D-23)", () => {
  it("a failed final_receipt (step 5) resumes on retry re-attempting ONLY step 5, and lands cleaned_up", async () => {
    const leaseId = "lease-retry-final-receipt";
    const { deps: failingDeps, leaseStore, receiptStore, signingKey } = await buildDeps(leaseId, (defaults) =>
      withFailingStep(defaults, "final_receipt"),
    );

    const incomplete = await runTeardown(failingDeps, NOW);
    expect(incomplete.state).toBe("cleanup_incomplete");
    const beforeRetry = await leaseStore.load(leaseId);
    expect(beforeRetry?.teardownProgress).toEqual({ ...HAPPY_OUTCOMES, final_receipt: "failed" });

    // Retry with the REAL default steps (the transient forced failure is gone).
    const realSteps = createDefaultTeardownSteps(receiptStore, signingKey);
    const retryDeps: TeardownDeps = { ...failingDeps, steps: realSteps };

    const cleaned = await retryTeardown(retryDeps, "user", NOW + 10);
    expect(cleaned.state).toBe("cleaned_up");

    const afterRetry = await leaseStore.load(leaseId);
    expect(afterRetry?.teardownProgress).toEqual(HAPPY_OUTCOMES);
  });

  it("a step-1 (revoke_oauth) failure is never re-attempted on retry -- resumes at later failed steps only (D-23)", async () => {
    const leaseId = "lease-retry-step1-terminal";
    // Force BOTH step 1 and step 3 to fail on the first pass.
    const { deps: firstPassDeps, leaseStore, receiptStore, signingKey } = await buildDeps(leaseId, (defaults) =>
      withFailingStep(withFailingStep(defaults, "revoke_oauth"), "cleanup_hook"),
    );

    const incomplete = await runTeardown(firstPassDeps, NOW);
    expect(incomplete.state).toBe("cleanup_incomplete");
    const beforeRetry = await leaseStore.load(leaseId);
    expect(beforeRetry?.teardownProgress).toEqual({
      ...HAPPY_OUTCOMES,
      revoke_oauth: "failed",
      cleanup_hook: "failed",
    });

    let step1Invoked = false;
    const retrySteps = createDefaultTeardownSteps(receiptStore, signingKey).map((step) =>
      step.name === "revoke_oauth"
        ? {
            name: step.name,
            run(): Promise<"revoked"> {
              step1Invoked = true;
              return Promise.resolve("revoked");
            },
          }
        : step,
    );
    const retryDeps: TeardownDeps = { ...firstPassDeps, steps: retrySteps };

    const retried = await retryTeardown(retryDeps, "runtime", NOW + 10);

    expect(step1Invoked).toBe(false); // revoke_oauth is attempted=terminal (D-23) -- never re-run, even though this retry's step array COULD have succeeded.
    // step 1's permanent "failed" record means teardown_succeeded's D-19 gate
    // (ALL five steps SUCCESS) can never pass -- the lease honestly stays
    // cleanup_incomplete forever, it never reaches cleaned_up (D-23's "the
    // honest failed record stands").
    expect(retried.state).toBe("cleanup_incomplete");

    const afterRetry = await leaseStore.load(leaseId);
    // revoke_oauth's original (honest) "failed" record stands -- retry never overwrites it; cleanup_hook (step 3) DID resume and succeed this time.
    expect(afterRetry?.teardownProgress).toEqual({ ...HAPPY_OUTCOMES, revoke_oauth: "failed" });
  });

  it("no assertion ever observes the lease in state active during or after teardown, across a fail-then-retry cycle", async () => {
    const leaseId = "lease-never-active";
    const { deps, leaseStore, receiptStore, signingKey } = await buildDeps(leaseId, (defaults) =>
      withFailingStep(defaults, "invalidate_license"),
    );

    const seenStates: Lease["state"][] = [];
    const track = async (): Promise<void> => {
      const current = await leaseStore.load(leaseId);
      if (current !== undefined) seenStates.push(current.state);
    };

    await track();
    const incomplete = await runTeardown(deps, NOW);
    seenStates.push(incomplete.state);
    await track();

    const retryDeps: TeardownDeps = { ...deps, steps: createDefaultTeardownSteps(receiptStore, signingKey) };
    const cleaned = await retryTeardown(retryDeps, "user", NOW + 10);
    seenStates.push(cleaned.state);
    await track();

    expect(seenStates).not.toContain("active");
    expect(new Set(seenStates)).toEqual(new Set(["revoked", "cleanup_incomplete", "cleaned_up"]));
  });
});
