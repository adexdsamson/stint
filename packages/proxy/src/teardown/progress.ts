/**
 * Per-step teardown progress helpers over `Lease.teardownProgress` (D-14).
 * `remainingSteps` decides which of the fixed 5 steps still need to run,
 * given progress recorded so far (D-33): fixed order preserved, an absent
 * record always needs to run, a step already recorded with a SUCCESS
 * outcome (`ok`/`revoked`/`not_applicable`/`attested_ok`) is skipped.
 *
 * `allStepsSucceeded` is the `teardown_succeeded` landing gate (D-19): every
 * one of the fixed 5 steps must have a recorded SUCCESS outcome, including
 * the signed final receipt.
 */

import type { TeardownProgress, TeardownStepName, TeardownStepOutcome } from "@stint/core";

import { TEARDOWN_STEP_ORDER } from "./steps.js";

/** D-33's "recorded terminal-success" outcomes -- the teardown_succeeded gate (D-19) and the skip-on-resume rule (D-15). */
const SUCCESS_OUTCOMES: readonly TeardownStepOutcome[] = ["ok", "revoked", "not_applicable", "attested_ok"];

/** True when `outcome` is one of the SUCCESS outcomes (D-33) -- `undefined` (not yet attempted) is never a success. */
export function isSuccessOutcome(outcome: TeardownStepOutcome | undefined): boolean {
  return outcome !== undefined && SUCCESS_OUTCOMES.includes(outcome);
}

/**
 * Which of the fixed 5 steps still need to run, given `progress` recorded so
 * far -- fixed order preserved (D-33). An absent record always needs to
 * run; a step already recorded with a SUCCESS outcome is skipped.
 */
export function remainingSteps(progress: TeardownProgress): readonly TeardownStepName[] {
  return TEARDOWN_STEP_ORDER.filter((name) => !isSuccessOutcome(progress[name]));
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
