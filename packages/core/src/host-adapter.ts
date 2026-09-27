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

/** `approve` accepts; `deny` carries why — `user_denied` (explicit) or `timeout` (core-decided, D-17). */
export type ApprovalDecision =
  | { readonly decision: "approve" }
  | { readonly decision: "deny"; readonly reason: "user_denied" | "timeout" };

/**
 * Lifecycle notifications a host renders (toast, log line, dashboard row,
 * etc.). Tagged by a literal `type` field so new lifecycle events extend
 * this union rather than growing `HostAdapter`'s method set (D-15). One
 * member per notifiable lease state (`transitions.ts`'s `State` union, minus
 * the non-notifiable `proposed`/`declined`/`granted` states).
 */
export type LifecycleEvent =
  | { readonly type: "activated"; readonly leaseId: string; readonly at: number }
  | { readonly type: "completed"; readonly leaseId: string; readonly at: number }
  | { readonly type: "expired"; readonly leaseId: string; readonly at: number }
  | { readonly type: "revoked"; readonly leaseId: string; readonly at: number }
  | { readonly type: "failed"; readonly leaseId: string; readonly at: number }
  | { readonly type: "tearing_down"; readonly leaseId: string; readonly at: number }
  | { readonly type: "cleaned_up"; readonly leaseId: string; readonly at: number }
  | { readonly type: "cleanup_incomplete"; readonly leaseId: string; readonly at: number };

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
  notify(event: LifecycleEvent): Promise<void>;
}
