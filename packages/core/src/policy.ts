/**
 * The pure policy engine (D-09, D-11): `evaluatePolicy` decides one call —
 * allow / deny / require_approval — from a `Lease`, the call, a resolved
 * runtime-owned `ConnectorBinding | undefined`, the manifest's `limits` and
 * `approvals` fields, and an injected clock. `checkErrorThreshold` (below)
 * is a separate pure check that reports when the error window is exceeded;
 * per D-09, deciding a call and advancing lease state stay cleanly
 * separated — the CALLER feeds a `policyEvents.errorThresholdExceeded()`
 * event to `reduce()` (lease.ts) when `checkErrorThreshold` returns `true`.
 *
 * Neither function reads a wall clock or arms a timer: every time-based
 * decision is a pure comparison against the injected `now` (epoch seconds),
 * so the whole security surface this module implements is deterministically
 * testable with no real timers.
 *
 * `evaluatePolicy` derives a tool's `(resource, access, irreversible)`
 * classification ONLY from the `binding` argument — it never reads the
 * manifest for classification (PRXY-03). A missing binding (`undefined`)
 * denies with `no_binding` before any other check (PRXY-02, deny by default).
 *
 * `lease.state !== "active"` denies with `lease_not_active` immediately
 * after the binding check (LIFE-02, deny by default): once a lease leaves
 * `active` — by any actor, for any reason, including the provider-side
 * `revoked` transition 04-07 (PRXY-07, D-09) applies — no further call on
 * it may be allowed or reach an approval flow. This is a plain field
 * comparison, never a second read of the lease store.
 */

import type { Lease, LeaseCounters } from "./lease.js";
import type { ConnectorBinding } from "./bindings.js";
import type { Approvals, ApprovalTrigger, ErrorThreshold, Limits } from "@stint/spec";

/**
 * Stable, machine-readable `deny` reason codes (D-10). This is a public API
 * surface: host UIs render these codes directly (mirrors `@stint/spec`'s
 * `SpecErrorCode` convention). Renaming or removing a code is a breaking
 * change for every integrating platform; adding a new code is safe.
 */
export const POLICY_REASON_CODES = [
  "no_binding",
  "lease_not_active",
  "expired",
  "over_max_actions",
  "over_actions_per_hour",
  "over_spend",
] as const;

export type PolicyReason = (typeof POLICY_REASON_CODES)[number];

/** What triggered the approval requirement, and the binding it was derived from — never raw call args (D-18). */
export interface ApprovalRequirement {
  readonly trigger: ApprovalTrigger;
  readonly binding: ConnectorBinding;
}

/**
 * `evaluatePolicy`'s result: a discriminated union tagged by the literal
 * `decision` field, the same way `@stint/spec`'s `Verifier` union is tagged
 * by a literal `type` field.
 */
export type PolicyDecision =
  | { readonly decision: "allow" }
  | { readonly decision: "deny"; readonly reason: PolicyReason }
  | { readonly decision: "require_approval"; readonly requirement: ApprovalRequirement };

/** The one call `evaluatePolicy` decides. `spendMinor` is omitted for calls that spend nothing. */
export interface PolicyCall {
  readonly tool: string;
  readonly spendMinor?: number;
}

function deny(reason: PolicyReason): PolicyDecision {
  return { decision: "deny", reason };
}

/** Derives the single `ApprovalTrigger` a binding maps to, or `undefined` if none applies. `pay` and `send` take priority over `irreversible` (a binding is classified by its access class first). */
function triggerForBinding(binding: ConnectorBinding): ApprovalTrigger | undefined {
  if (binding.access === "pay") return "pay";
  if (binding.access === "send") return "send";
  if (binding.irreversible) return "irreversible";
  return undefined;
}

/**
 * Decides one call against `lease`, per spec/ALP.md Section 9's enforcement
 * order (deny by default):
 *
 * 1. No resolved binding -> `deny('no_binding')` (PRXY-02) — checked before
 *    anything else, including expiry.
 * 2. `lease.state !== 'active'` -> `deny('lease_not_active')` (LIFE-02) — a
 *    lease that has ended (`revoked`, `expired`, `failed`, ...) or has not
 *    yet been activated (`proposed`, `granted`) can never authorize a call,
 *    regardless of which actor or reason moved it out of `active`.
 * 3. Past-expiry lease -> `deny('expired')`, a pure comparison against the
 *    injected `now` (LIFE-04, D-07) — no timer.
 * 4. Lifetime action cap exceeded -> `deny('over_max_actions')`.
 * 5. Spend cap exceeded -> `deny('over_spend')`.
 * 6. `send` / `pay` / `irreversible` bindings require approval; `pay` always
 *    requires approval even if a manifest's `approvals.require_for` omits it
 *    (spec/ALP.md Section 9).
 * 7. Otherwise -> `allow`.
 *
 * `limits.actions_per_hour`'s code (`over_actions_per_hour`) is part of the
 * stable reason vocabulary above, but full sliding-window enforcement under
 * concurrent calls is PRXY-04 (Phase 4): it needs a per-action timestamp
 * counter that isn't part of the `LeaseCounters` aggregate this phase built
 * (D-01). See `.planning/WINDOWS.md` for the tracked follow-up.
 */
export function evaluatePolicy(
  lease: Lease,
  call: PolicyCall,
  binding: ConnectorBinding | undefined,
  limits: Limits,
  approvals: Approvals,
  now: number,
): PolicyDecision {
  // Step 1 — deny by default: no resolved binding, no decision (PRXY-02).
  if (binding === undefined) {
    return deny("no_binding");
  }

  // Step 2 — a lease that has left `active` (ended for any reason/actor, or
  // never activated) can never authorize a call (LIFE-02, deny by default).
  if (lease.state !== "active") {
    return deny("lease_not_active");
  }

  // Step 3 — per-call expiry: pure comparison against the injected clock (LIFE-04).
  if (now >= lease.expiresAt) {
    return deny("expired");
  }

  // Step 4 — lifetime action cap.
  if (lease.counters.actionCount >= limits.max_actions) {
    return deny("over_max_actions");
  }

  // Step 5 — spend cap (only when the call declares a spend amount and the manifest sets one).
  if (
    call.spendMinor !== undefined &&
    limits.spend !== undefined &&
    lease.counters.spentMinor + call.spendMinor > limits.spend.amount_minor
  ) {
    return deny("over_spend");
  }

  // Step 6 — approval: classification comes only from `binding`, never the manifest (PRXY-03).
  const trigger = triggerForBinding(binding);
  // `approvals.require_for`'s generated type is a union of fixed-length tuples
  // (0-3 items); widening to a plain readonly array first avoids TypeScript
  // resolving `.includes`'s parameter to `never` across that tuple union.
  const requireFor: readonly ApprovalTrigger[] = approvals.require_for;
  if (trigger !== undefined && (trigger === "pay" || requireFor.includes(trigger))) {
    return { decision: "require_approval", requirement: { trigger, binding } };
  }

  // Step 7 — nothing else applies.
  return { decision: "allow" };
}

/**
 * Reports whether `counters.denialErrorTimestamps` has at least
 * `threshold.count` entries strictly within the trailing `threshold.window_seconds`
 * window ending at `now` (LIFE-07). Does NOT mutate state and does NOT
 * dispatch an event — per D-09, the caller feeds a
 * `policyEvents.errorThresholdExceeded()` event to `reduce()` (lease.ts,
 * `active -> failed`, actor `policy`) when this returns `true`. Timestamps
 * are integer epoch-seconds; a timestamp exactly `window_seconds` old is
 * OUTSIDE the window (strict `>`, not `>=`).
 */
export function checkErrorThreshold(
  counters: Pick<LeaseCounters, "denialErrorTimestamps">,
  threshold: ErrorThreshold,
  now: number,
): boolean {
  const windowStart = now - threshold.window_seconds;
  const inWindowCount = counters.denialErrorTimestamps.filter(
    (timestamp) => timestamp > windowStart,
  ).length;
  return inWindowCount >= threshold.count;
}
