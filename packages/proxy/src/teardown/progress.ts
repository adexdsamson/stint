/**
 * Per-step teardown progress helpers over `Lease.teardownProgress` (D-14).
 * `remainingSteps` encodes the two resume rules `orchestrate.ts`'s
 * `retryTeardown` depends on:
 *
 * - **D-23 (attempted = terminal for step 1):** once `revoke_oauth` has ANY
 *   recorded outcome -- success or `"failed"` -- it is never re-attempted.
 *   The honest failure record stands; the security goal (the runtime holds
 *   no usable credential) is already met by the always-discard rule (D-22),
 *   which is a later plan's concern, not this helper's.
 * - **D-15 (one pass, then explicit retry):** every OTHER step is skipped on
 *   resume only when its recorded outcome is one of the four SUCCESS
 *   outcomes -- a recorded `"failed"` for steps 2-5 always re-runs on the
 *   next pass.
 *
 * `allStepsSucceeded` is the `teardown_succeeded` landing gate (D-19): every
 * one of the fixed 5 steps must have a recorded SUCCESS outcome, including
 * the signed final receipt.
 */

import type { TeardownProgress, TeardownStepName, TeardownStepOutcome } from "@stint/core";

import { TEARDOWN_STEP_ORDER } from "./steps.js";

/** D-33's "recorded terminal-success" outcomes -- the teardown_succeeded gate (D-19) and the steps-2-5 skip-on-resume rule (D-15). */
const SUCCESS_OUTCOMES: readonly TeardownStepOutcome[] = ["ok", "revoked", "not_applicable", "attested_ok"];

/** Step 1 is attempted-is-terminal (D-23): once recorded, ANY outcome is never retried. */
const ATTEMPTED_IS_TERMINAL_STEP: TeardownStepName = "revoke_oauth";

/** True when `outcome` is one of the SUCCESS outcomes (D-33) -- `undefined` (not yet attempted) is never a success. */
export function isSuccessOutcome(outcome: TeardownStepOutcome | undefined): boolean {
  return outcome !== undefined && SUCCESS_OUTCOMES.includes(outcome);
}

/**
 * Which of the fixed 5 steps still need to run, given `progress` recorded so
 * far -- fixed order preserved (D-33). An absent record always needs to
 * run. `revoke_oauth` is skipped whenever ANY outcome is already recorded
 * for it (D-23); every other step is skipped only when its recorded outcome
 * is a SUCCESS outcome.
 */
export function remainingSteps(progress: TeardownProgress): readonly TeardownStepName[] {
  return TEARDOWN_STEP_ORDER.filter((name) => {
    const recorded = progress[name];
    if (recorded === undefined) return true;
    if (name === ATTEMPTED_IS_TERMINAL_STEP) return false;
    return !isSuccessOutcome(recorded);
  });
}

/** Returns a NEW `TeardownProgress` with `name` recorded as `outcome` -- never mutates `progress` (D-14). */
export function recordStepOutcome(
  progress: TeardownProgress,
  name: TeardownStepName,
  outcome: TeardownStepOutcome,
): TeardownProgress {
  return { ...progress, [name]: outcome };
}

/** True only when every fixed step has a recorded SUCCESS outcome (D-19) -- the `teardown_succeeded` landing gate. */
export function allStepsSucceeded(progress: TeardownProgress): boolean {
  return TEARDOWN_STEP_ORDER.every((name) => isSuccessOutcome(progress[name]));
}
