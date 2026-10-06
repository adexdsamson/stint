/**
 * The SPEC-07 caveat, in one place (D-16, D-17).
 *
 * A credential whose authorization server offers no revocation endpoint is
 * discarded from the vault but never revoked upstream. The lease still ends
 * `cleaned_up` (terminal success), so a person reading only the state would
 * wrongly conclude nothing is left live. Every human-facing surface (inspect,
 * the cleanup/revoke result, the receipts timeline) therefore shares these
 * helpers so the label and the rotate instruction cannot drift apart.
 *
 * The stored state value stays the plain `cleaned_up`; the label is display
 * only. Resource names come from a signed but publisher-chosen manifest and
 * from an on-disk receipt file, so every name is sanitized before it is shown.
 * Nothing here reads a secret.
 */

import type { Lease, TeardownStuckReason } from "@stint/core";
import type { ReceiptEntry } from "@stint/spec";

import { sanitizeForTerminal } from "../adapter/sanitize.js";

/** Appended to `cleaned_up` wherever a person sees that state for an unrevoked lease. */
export const UNREVOKED_STATE_SUFFIX = " (credential not revoked upstream)";

/** True for a cleaned-up lease whose `revoke_oauth` step could not revoke upstream. */
export function isUnrevokedCleanup(lease: Lease): boolean {
  return (
    lease.state === "cleaned_up" &&
    lease.teardownProgress?.revoke_oauth === "discarded_revocation_unsupported"
  );
}

/** The state as a person should read it: `cleaned_up` carries the caveat when it applies. */
export function stateLabel(lease: Lease): string {
  return isUnrevokedCleanup(lease) ? `${lease.state}${UNREVOKED_STATE_SUFFIX}` : lease.state;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The unique, ascending-sorted resource names whose `revoke_oauth` receipt says
 * `discarded_revocation_unsupported`. Pass entries of the verified chain only.
 * Entries without a string `resource` are ignored.
 */
export function unrevokedResources(entries: readonly ReceiptEntry[]): readonly string[] {
  const found = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "teardown_step" || !isRecord(entry.payload)) continue;
    const { step, outcome, resource } = entry.payload;
    if (
      step === "revoke_oauth" &&
      outcome === "discarded_revocation_unsupported" &&
      typeof resource === "string"
    ) {
      found.add(resource);
    }
  }
  return [...found].sort();
}

/** The instruction for one unrevoked credential; never worded as the credential being safe. */
export function rotateCaveat(resource: string): string {
  return `The credential for ${sanitizeForTerminal(resource)} was not revoked upstream. Rotate it in the provider dashboard.`;
}

const STUCK_REASONS: ReadonlySet<string> = new Set<TeardownStuckReason>([
  "credentials_unavailable",
  "retries_exhausted",
  "revocation_failed",
  "manifest_invalid",
]);

/**
 * The reason the supervisor stopped retrying this lease, from its verified
 * chain: the latest `teardown_stuck` entry, unless a later failed landing
 * (`teardown_incomplete`) or `teardown_blocked` entry means someone has tried
 * again since. A reason text outside the four the supervisor writes (a hand
 * written entry) yields no reason, so it never reaches a terminal (D-01).
 */
export function stuckReason(entries: readonly ReceiptEntry[]): TeardownStuckReason | undefined {
  let reason: TeardownStuckReason | undefined;
  for (const entry of entries) {
    const payload: unknown = entry.payload;
    if (entry.type === "teardown_stuck") {
      const text = isRecord(payload) ? payload.reason : undefined;
      reason = typeof text === "string" && STUCK_REASONS.has(text) ? (text as TeardownStuckReason) : undefined;
    } else if (entry.type === "teardown_blocked") {
      reason = undefined;
    } else if (entry.type === "transition" && isRecord(payload) && payload.event === "teardown_incomplete") {
      reason = undefined;
    }
  }
  return reason;
}

/**
 * The state with everything a person needs to read it: the unrevoked caveat for
 * `cleaned_up`, and `(stuck: <reason>)` for any other lease whose latest
 * teardown marker says the supervisor gave up on its own (D-01). Display only;
 * the stored state value is unchanged. Pass entries of the verified chain.
 */
export function leaseLabel(lease: Lease, entries: readonly ReceiptEntry[]): string {
  const reason = lease.state === "cleaned_up" ? undefined : stuckReason(entries);
  return reason === undefined ? stateLabel(lease) : `${stateLabel(lease)} (stuck: ${reason})`;
}
