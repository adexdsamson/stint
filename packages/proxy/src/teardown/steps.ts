/**
 * The injectable `TeardownStep` port (D-27) and the fixed 5-step order
 * (D-33). `runStepOnce` is the ONE-PASS step runner (D-15): a single
 * attempt per run, any thrown error collapsing to `"failed"` -- never a
 * retry, backoff, or timer inside a step or this runner. Do NOT port
 * ARCHITECTURE.md Pattern 5's `withRetry` wrapper here.
 *
 * The 5 default step implementations below are happy-path placeholders
 * hardened by later plans (05-04 revoke_oauth's real RFC 7009 call, 05-05
 * invalidate_license's real `LicenseIssuer.invalidate`, 05-06 cleanup_hook's
 * real single-use cleanup-token POST) -- EXCEPT `final_receipt`, which
 * already does its real, permanent job this plan (D-19, D-31): it signs an
 * EdDSA checkpoint over the verified chain accumulated by the steps before
 * it (plus the `begin_teardown` transition) and writes it. `receiptStore`
 * and `signingKey` are always caller-injected (never read from disk/env);
 * an unverifiable chain or a signing failure is caught by `runStepOnce` and
 * recorded as `"failed"` -- just another step failure, landing
 * `cleanup_incomplete` (D-15, D-19).
 */

import { signCheckpoint, verifyChain } from "@stint/core";
import type { Lease, ReceiptStore, TeardownStepName, TeardownStepOutcome } from "@stint/core";
import type { CryptoKey } from "jose";

/** The injectable per-step port (D-27) -- the fault matrix (Task 2) forces any single step to fail/timeout by swapping in a step that rejects or resolves `"failed"`. */
export interface TeardownStep {
  readonly name: TeardownStepName;
  run(lease: Lease, now: number): Promise<TeardownStepOutcome>;
}

/** The fixed, unconditional 5-step order (D-33) every teardown run walks, for every end reason and auth mode. */
export const TEARDOWN_STEP_ORDER: readonly TeardownStepName[] = [
  "revoke_oauth",
  "invalidate_license",
  "cleanup_hook",
  "delete_cached_data",
  "final_receipt",
];

/**
 * A single attempt at `step` -- no retry/backoff/timer (D-15). Any thrown
 * error (including a rejected promise) is recorded as `"failed"`, never
 * rethrown -- the orchestrator's per-step loop never needs its own
 * try/catch.
 */
export async function runStepOnce(
  step: TeardownStep,
  lease: Lease,
  now: number,
): Promise<TeardownStepOutcome> {
  try {
    return await step.run(lease, now);
  } catch {
    return "failed";
  }
}

function happyPathStep(name: TeardownStepName, outcome: TeardownStepOutcome): TeardownStep {
  return {
    name,
    run(): Promise<TeardownStepOutcome> {
      return Promise.resolve(outcome);
    },
  };
}

/**
 * The real `final_receipt` (step 5) implementation (D-19, D-31): loads the
 * currently-persisted verified chain, verifies it, and -- only if it
 * verifies -- signs a checkpoint over its `headHash`/`count` and writes it.
 * A chain that fails to verify, or a signing failure, resolves `"failed"`
 * rather than throwing, so a caller never needs to distinguish "step threw"
 * from "step returned failed" -- both land the same way via `runStepOnce`.
 */
function createFinalReceiptStep(receiptStore: ReceiptStore, signingKey: CryptoKey): TeardownStep {
  return {
    name: "final_receipt",
    async run(_lease: Lease, now: number): Promise<TeardownStepOutcome> {
      const chain = await receiptStore.load("verified");
      const verified = await verifyChain(chain);
      if (!verified.ok) return "failed";
      const checkpoint = await signCheckpoint(
        "verified",
        verified.value.count,
        verified.value.headHash,
        now,
        signingKey,
      );
      await receiptStore.writeCheckpoint(checkpoint);
      return "ok";
    },
  };
}

/**
 * The 5 fixed-order default `TeardownStep`s (D-33), in `TEARDOWN_STEP_ORDER`
 * -- the production defaults a `TeardownDeps.steps` should be built from
 * until 05-04/05-05/05-06 supply the real revoke/license/cleanup-hook
 * implementations. `final_receipt` is real, permanent behavior this plan
 * ships, not a placeholder.
 */
export function createDefaultTeardownSteps(
  receiptStore: ReceiptStore,
  signingKey: CryptoKey,
): readonly TeardownStep[] {
  return [
    happyPathStep("revoke_oauth", "revoked"),
    happyPathStep("invalidate_license", "ok"),
    happyPathStep("cleanup_hook", "attested_ok"),
    happyPathStep("delete_cached_data", "ok"),
    createFinalReceiptStep(receiptStore, signingKey),
  ];
}
