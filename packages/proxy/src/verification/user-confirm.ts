/**
 * `runUserConfirmVerification` -- the `user_confirm` outcome-verification
 * trigger (LIFE-06, D-05, D-07). Mirrors `resource-query.ts`'s trigger
 * discipline exactly (D-03): the agent may only SIGNAL "check done", which
 * causes the runtime to run this out-of-band confirmation itself -- there is
 * no code path where an agent-supplied "done" claim itself completes the
 * lease.
 *
 * Arms `deps.signal`'s deadline (the caller's responsibility, mirroring
 * `awaitApprovalDecision`/`awaitConsentDecision`'s convention: core never
 * arms a real timer itself) and calls `awaitOutcomeConfirmDecision` -- the
 * ONLY sanctioned way to invoke `HostAdapter.requestOutcomeConfirmation`
 * (D-05). On `confirm`: `verifierEvents.outcomeVerified()` (actor
 * `verifier`) -> `completed`, auto-chained into `begin_teardown` via the
 * SAME shared `completeViaVerifier` helper `resource-query.ts` uses (D-18) --
 * the two verifier types funnel through one completion path, not two. On
 * `reject` (`user_rejected` or `timeout`): the lease stays `active`, never
 * completes -- deny-by-default (D-05).
 *
 * Every attempt appends EXACTLY ONE verified-chain verification receipt
 * (D-07), via the SAME `appendVerificationReceipt` helper `resource-query.ts`
 * uses. There is no real customer `resource` for a `user_confirm` verifier
 * (the manifest's `UserConfirmVerifier` carries only `prompt`) -- the fixed
 * sentinel `"user_confirm"` is recorded instead, mirroring
 * `receipts/call-receipt.ts`'s `UNRESOLVED_RESOURCE` sentinel convention for
 * "no real resource to name here."
 */

import type { HostAdapter, OutcomeConfirmRequest } from "@stint/core";
import { awaitOutcomeConfirmDecision } from "@stint/core";

import { appendVerificationReceipt, completeViaVerifier } from "./resource-query.js";
import type { VerifierCompletionDeps } from "./resource-query.js";

/** The sentinel `resource` recorded for a `user_confirm` verification receipt -- there is no real customer resource for this verifier type (mirrors `receipts/call-receipt.ts`'s `UNRESOLVED_RESOURCE`). */
const USER_CONFIRM_RESOURCE = "user_confirm";

/** The closed outcome of one `user_confirm` verification attempt (D-05, D-07). `"true"` is an explicit user confirm; `"false"` covers BOTH an explicit rejection and a timeout -- neither ever completes the lease. */
export type UserConfirmOutcome = "true" | "false";

/**
 * Every construction-time dependency `runUserConfirmVerification` needs.
 * `signal` is the caller-armed deadline `awaitOutcomeConfirmDecision` races
 * against (core owns the deny-by-default timeout DECISION, D-17; the caller
 * arms the actual timer, exactly like `ApprovalStage`/`createApprovalDispatcher`).
 */
export interface UserConfirmDeps extends VerifierCompletionDeps {
  readonly adapter: HostAdapter;
  readonly prompt: string;
  readonly signal: AbortSignal;
}

/**
 * Runs one `user_confirm` verification attempt (LIFE-06): the runtime-run,
 * out-of-band confirmation an agent's "check done" signal triggers. Returns
 * the closed outcome; never throws for an expected business result -- a
 * rejection, timeout, or adapter error are all folded into `"false"` by
 * `awaitOutcomeConfirmDecision`'s own deny-by-default discipline before this
 * function ever sees them.
 */
export async function runUserConfirmVerification(
  deps: UserConfirmDeps,
  now: number,
): Promise<UserConfirmOutcome> {
  const request: OutcomeConfirmRequest = { leaseId: deps.leaseId, prompt: deps.prompt };
  const decision = await awaitOutcomeConfirmDecision(deps.adapter, request, deps.signal);

  const outcome: UserConfirmOutcome = decision.decision === "confirm" ? "true" : "false";
  const reason = decision.decision === "confirm" ? "user_confirmed" : decision.reason;

  if (outcome === "true") {
    await completeViaVerifier(deps, now);
  }

  await appendVerificationReceipt(deps.receiptStore, "user_confirm", USER_CONFIRM_RESOURCE, outcome, reason, now);

  return outcome;
}
