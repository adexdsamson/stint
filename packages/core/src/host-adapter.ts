/**
 * `HostAdapter` — the single three-method contract a platform builder
 * implements (HOST-01): `requestConsent`, `requestApproval`, and
 * `notify(event: LifecycleEvent)`. All three methods are async
 * (Promise-returning, D-16) because consent and approval are inherently
 * out-of-band/interactive (ALP.md Section 9: approvals are dispatched out of
 * band through the HostAdapter and MUST NOT be satisfied by MCP elicitation
 * through the agent's own client; Section 7.6: `user_confirm` consent is
 * asked through the HostAdapter).
 *
 * `requestApproval` carries only a binding-redacted summary, the resolved
 * `ConnectorBinding`, and an opaque approval-request id — never the raw call
 * arguments (D-18; mirrors receipts storing an args-hash only, never raw
 * args). The binding-hash mechanics over resolved args are `[OPEN: Phase 4]`;
 * this interface only carries the opaque id.
 *
 * The `AbortSignal` each interactive method receives is how core signals a
 * timeout so the adapter can cancel its own UI, but the deny/decline decision
 * on abort belongs to core alone (D-17) — implemented by
 * `awaitApprovalDecision`/`awaitConsentDecision` (Task 2 of this plan). A
 * `HostAdapter` implementation never decides deny-by-default itself; it only
 * ever proposes an outcome core is free to override with a timeout, and an
 * adapter error can never become an allow/grant.
 */

import type { ConnectorBinding } from "./bindings.js";
import type { VerifiedManifest } from "@stint/spec";

/** A request to grant or decline the whole lease at consent time (ALP.md Section 6). */
export interface ConsentRequest {
  readonly consentId: string;
  readonly manifest: VerifiedManifest;
}

/** `grant` accepts; `decline` carries why — `user_declined` (explicit) or `timeout` (core-decided, D-17). */
export type ConsentDecision =
  | { readonly decision: "grant" }
  | { readonly decision: "decline"; readonly reason: "user_declined" | "timeout" };

/**
 * A single per-call approval request. `summary` is binding-redacted display
 * text; there is deliberately no field that could carry the raw call
 * arguments (D-18).
 */
export interface ApprovalRequest {
  readonly approvalId: string;
  readonly summary: string;
  readonly binding: ConnectorBinding;
}

/**
 * `approve` accepts; `deny` carries why: `user_denied` (explicit), `timeout`
 * (core-decided, D-17), `lease_ended` (the lease ended while the approval was
 * pending, D-20) or `approval_queue_full` (too many approvals pending at once,
 * decided by the proxy's dispatcher without asking the adapter).
 */
export type ApprovalDecision =
  | { readonly decision: "approve" }
  | {
      readonly decision: "deny";
      readonly reason: "user_denied" | "timeout" | "lease_ended" | "approval_queue_full";
    };

/**
 * The `name` of the abort reason core uses to say "the lease ended while this
 * approval was pending" (D-20). It is compared by name, never by identity, so
 * the check works across package copies.
 */
export const LEASE_ENDED_REASON = "LeaseEndedError";

/** Builds the abort reason for a lease that ended while an approval was pending. */
export function createLeaseEndedReason(): Error {
  const reason = new Error("The lease ended while an approval was pending.");
  reason.name = LEASE_ENDED_REASON;
  return reason;
}

/**
 * True when `signal` is aborted and its reason is the lease-ended reason. Works
 * for a signal derived through `AbortSignal.any`, which carries the source's
 * reason through.
 */
export function isLeaseEndedSignal(signal: AbortSignal): boolean {
  if (!signal.aborted) return false;
  const reason: unknown = signal.reason;
  return (
    typeof reason === "object" &&
    reason !== null &&
    (reason as { readonly name?: unknown }).name === LEASE_ENDED_REASON
  );
}

/**
 * Why an approval the human granted did not take effect (D-21). Fixed codes so
 * a host can render a fixed sentence for each.
 */
export type ApprovalVoidReason =
  | "expired_after_approval"
  | "lease_ended_after_approval"
  | "limit_reached_after_approval"
  | "approval_drifted";

/**
 * A single `user_confirm` outcome-verification request (D-05, LIFE-06):
 * asks a human, out of band, whether the job's stated outcome actually
 * happened. `prompt` is the manifest's `job.verifier.prompt` text verbatim —
 * there is deliberately no field that could carry raw resource data.
 */
export interface OutcomeConfirmRequest {
  readonly leaseId: string;
  readonly prompt: string;
}

/**
 * `confirm` accepts (drives `outcome_verified`, actor `verifier`); `reject`
 * carries why — `user_rejected` (explicit) or `timeout` (core-decided,
 * D-17) — and NEVER completes the lease (deny-by-default, D-05).
 */
export type OutcomeConfirmDecision =
  | { readonly decision: "confirm" }
  | { readonly decision: "reject"; readonly reason: "user_rejected" | "timeout" };

/**
 * Lifecycle notifications a host renders (toast, log line, dashboard row,
 * etc.). Tagged by a literal `type` field so new lifecycle events extend
 * this union rather than growing `HostAdapter`'s method set (D-15). One
 * member per notifiable lease state (`transitions.ts`'s `State` union, minus
 * the non-notifiable `proposed`/`declined`/`granted` states). It also carries
 * one per-call approval notice, `approval_void`, so the "your approval did not
 * take effect" message reaches the user without a new `HostAdapter` method.
 */
export type LifecycleEvent =
  | { readonly type: "activated"; readonly leaseId: string; readonly at: number }
  | { readonly type: "completed"; readonly leaseId: string; readonly at: number }
  | { readonly type: "expired"; readonly leaseId: string; readonly at: number }
  | { readonly type: "revoked"; readonly leaseId: string; readonly at: number }
  | { readonly type: "failed"; readonly leaseId: string; readonly at: number }
  | { readonly type: "tearing_down"; readonly leaseId: string; readonly at: number }
  | { readonly type: "cleaned_up"; readonly leaseId: string; readonly at: number }
  | { readonly type: "cleanup_incomplete"; readonly leaseId: string; readonly at: number }
  | {
      readonly type: "approval_void";
      readonly leaseId: string;
      readonly at: number;
      readonly reason: ApprovalVoidReason;
    };

/**
 * The single published contract a platform builder implements (HOST-01).
 * Exactly three methods, all Promise-returning (D-16): `requestConsent` and
 * `requestApproval` are interactive and out-of-band (never via MCP
 * elicitation through the agent's own client, ALP.md Section 9); `notify`
 * is fire-and-forget lifecycle reporting. Each interactive method receives
 * an `AbortSignal` — core aborts it on timeout so the adapter can cancel its
 * own UI, but the resulting deny/decline decision belongs to core alone
 * (D-17), never to this interface's implementation.
 */
export interface HostAdapter {
  requestConsent(request: ConsentRequest, signal: AbortSignal): Promise<ConsentDecision>;
  requestApproval(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision>;
  /**
   * The `user_confirm` outcome-verification method (D-05, LIFE-06): asks a
   * human, out of band, whether the job's stated outcome happened. Mirrors
   * `requestConsent`/`requestApproval` exactly (async, `AbortSignal`,
   * core-owned deny-by-default via `awaitOutcomeConfirmDecision` below) —
   * never satisfied by MCP elicitation through the agent's own client.
   */
  requestOutcomeConfirmation(
    request: OutcomeConfirmRequest,
    signal: AbortSignal,
  ): Promise<OutcomeConfirmDecision>;
  notify(event: LifecycleEvent): Promise<void>;
}

/**
 * Races `adapter.requestApproval` against `signal`. Core owns the
 * deny-by-default timeout rule (D-17): if `signal` is already aborted, aborts
 * before the adapter resolves, or the adapter's `requestApproval` rejects or
 * throws, this resolves `{ decision: 'deny', reason: 'timeout' }` — a slow,
 * buggy, or hostile adapter can never turn into an approve. No real timer is
 * armed here; the caller (the Phase 4 proxy) arms the timeout and aborts
 * `signal` — tests abort the controller directly, keeping this deterministic.
 * An abort carrying the lease-ended reason resolves `lease_ended` instead of
 * `timeout` (D-20). This is the ONLY sanctioned way to call `adapter.requestApproval`.
 */
export function awaitApprovalDecision(
  adapter: HostAdapter,
  request: ApprovalRequest,
  signal: AbortSignal,
): Promise<ApprovalDecision> {
  const timeoutDeny: ApprovalDecision = { decision: "deny", reason: "timeout" };
  const leaseEndedDeny: ApprovalDecision = { decision: "deny", reason: "lease_ended" };
  // Any abort is a timeout except one carrying the lease-ended reason (D-20).
  const abortDeny = (): ApprovalDecision => (isLeaseEndedSignal(signal) ? leaseEndedDeny : timeoutDeny);
  const deny = timeoutDeny;

  if (signal.aborted) {
    return Promise.resolve(abortDeny());
  }

  return new Promise<ApprovalDecision>((resolve) => {
    let settled = false;

    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      resolve(abortDeny());
    };
    signal.addEventListener("abort", onAbort, { once: true });

    adapter.requestApproval(request, signal).then(
      (decision) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(decision);
      },
      () => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(deny);
      },
    );
  });
}

/**
 * Races `adapter.requestConsent` against `signal`, mirroring
 * `awaitApprovalDecision` exactly but resolving `{ decision: 'decline',
 * reason: 'timeout' }` on abort/non-response/adapter-error (D-17). This is
 * the ONLY sanctioned way to call `adapter.requestConsent`.
 */
export function awaitConsentDecision(
  adapter: HostAdapter,
  request: ConsentRequest,
  signal: AbortSignal,
): Promise<ConsentDecision> {
  const decline: ConsentDecision = { decision: "decline", reason: "timeout" };

  if (signal.aborted) {
    return Promise.resolve(decline);
  }

  return new Promise<ConsentDecision>((resolve) => {
    let settled = false;

    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      resolve(decline);
    };
    signal.addEventListener("abort", onAbort, { once: true });

    adapter.requestConsent(request, signal).then(
      (decision) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(decision);
      },
      () => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(decline);
      },
    );
  });
}

/**
 * Races `adapter.requestOutcomeConfirmation` against `signal`, copying
 * `awaitConsentDecision`'s exact settled-flag/abort-listener/then-resolve
 * structure verbatim (D-05): if `signal` is already aborted, aborts before
 * the adapter resolves, or the adapter's `requestOutcomeConfirmation`
 * rejects or throws, this resolves `{ decision: 'reject', reason: 'timeout'
 * }` — a slow, buggy, or hostile adapter can never turn into a confirm.
 * This is the ONLY sanctioned way to call `adapter.requestOutcomeConfirmation`.
 */
export function awaitOutcomeConfirmDecision(
  adapter: HostAdapter,
  request: OutcomeConfirmRequest,
  signal: AbortSignal,
): Promise<OutcomeConfirmDecision> {
  const reject: OutcomeConfirmDecision = { decision: "reject", reason: "timeout" };

  if (signal.aborted) {
    return Promise.resolve(reject);
  }

  return new Promise<OutcomeConfirmDecision>((resolve) => {
    let settled = false;

    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      resolve(reject);
    };
    signal.addEventListener("abort", onAbort, { once: true });

    adapter.requestOutcomeConfirmation(request, signal).then(
      (decision) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(decision);
      },
      () => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(reject);
      },
    );
  });
}
