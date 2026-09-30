/**
 * A deterministic, tty-free `HostAdapter` for the e2e harness.
 *
 * A host adapter only PROPOSES (HOST-01, D-17): this one answers consent, each
 * per-call approval and the outcome confirmation from a script, and records every
 * request and lifecycle notification so a test can assert on them. It never
 * times anything out and never decides deny-by-default itself: core owns that.
 * An approval with no scripted answer throws, which core folds into a deny, so a
 * forgotten script line can only ever make a test stricter.
 *
 * `"hang"` leaves an approval unanswered until core aborts the request. It is how a
 * scenario lets core's own timeout be the thing under test; the pending promise
 * rejects on abort (core already settled it) so nothing is left open.
 */

import type {
  ApprovalDecision,
  ApprovalRequest,
  ConsentDecision,
  ConsentRequest,
  HostAdapter,
  LifecycleEvent,
  OutcomeConfirmDecision,
  OutcomeConfirmRequest,
} from "@stint/core";

/** One scripted answer to a per-call approval request. */
export type ScriptedApproval = "approve" | "deny" | "hang";

/** What the scripted adapter answers. Every field is optional; the defaults are the happy path. */
export interface ScriptedAnswers {
  /** Consent to the lease. Default `"grant"`. */
  readonly consent?: "grant" | "decline";
  /** One entry per approval request, consumed in order. An extra request has no answer and throws. */
  readonly approvals?: readonly ScriptedApproval[];
  /** The `user_confirm` outcome confirmation. Default `"confirm"`. */
  readonly outcome?: "confirm" | "reject";
}

/** The adapter plus everything it observed. The arrays grow as the scenario runs. */
export interface ScriptedAdapter extends HostAdapter {
  readonly events: LifecycleEvent[];
  readonly consentRequests: ConsentRequest[];
  readonly approvalRequests: ApprovalRequest[];
  readonly outcomeRequests: OutcomeConfirmRequest[];
}

/** Builds the scripted adapter. */
export function createScriptedAdapter(answers: ScriptedAnswers = {}): ScriptedAdapter {
  const pendingApprovals = [...(answers.approvals ?? [])];
  const events: LifecycleEvent[] = [];
  const consentRequests: ConsentRequest[] = [];
  const approvalRequests: ApprovalRequest[] = [];
  const outcomeRequests: OutcomeConfirmRequest[] = [];

  return {
    events,
    consentRequests,
    approvalRequests,
    outcomeRequests,

    requestConsent(request): Promise<ConsentDecision> {
      consentRequests.push(request);
      return Promise.resolve(
        answers.consent === "decline"
          ? { decision: "decline", reason: "user_declined" }
          : { decision: "grant" },
      );
    },

    requestApproval(request, signal): Promise<ApprovalDecision> {
      approvalRequests.push(request);
      const answer = pendingApprovals.shift();
      if (answer === undefined) {
        // No scripted answer: core folds a rejection into deny/timeout.
        return Promise.reject(new Error("No approval answer was scripted."));
      }
      if (answer === "approve") return Promise.resolve({ decision: "approve" });
      if (answer === "deny") return Promise.resolve({ decision: "deny", reason: "user_denied" });
      return new Promise<ApprovalDecision>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            reject(new Error("The approval request was aborted."));
          },
          { once: true },
        );
      });
    },

    requestOutcomeConfirmation(request): Promise<OutcomeConfirmDecision> {
      outcomeRequests.push(request);
      return Promise.resolve(
        answers.outcome === "reject"
          ? { decision: "reject", reason: "user_rejected" }
          : { decision: "confirm" },
      );
    },

    notify(event): Promise<void> {
      events.push(event);
      return Promise.resolve();
    },
  };
}
