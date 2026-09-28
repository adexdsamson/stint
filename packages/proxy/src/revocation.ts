/**
 * `applyProviderRevocation`/`isProviderRevocation` -- the D-09/PRXY-07
 * lazy customer-side OAuth revocation wiring. A single, narrow bridge from
 * the 04-05 vault's `provider_revoked` classification to the ONE sanctioned
 * provider-actor lifecycle event (`@stint/core`'s `providerEvents.grantRevoked()`).
 *
 * `applyProviderRevocation` is a thin wrapper over `reduce()` -- it never
 * hand-rolls the transition, never imports a broader slice of `@stint/core`'s
 * events module, and never trusts a caller-supplied actor (the agent is
 * never an actor, D-19). `dispatch.ts`'s `provider_revoked` catch branch is
 * the sole call site: the resulting `revoked` lease is returned from the
 * per-lease transaction's mutator so it is saved atomically with the single
 * `denied` receipt for the triggering call (D-13).
 *
 * `isProviderRevocation` narrows the 04-05 `RefreshResult`'s failure kinds
 * (`CredentialRefreshError.kind` carries the identical union) so the
 * transient-vs-revocation discrimination reads as one boolean check, never a
 * re-derivation of D-09's classification.
 */

import { providerEvents, reduce } from "@stint/core";
import type { Lease, Result, TransitionRecord } from "@stint/core";

import type { RefreshResult } from "./vault/oauth-client.js";

/**
 * D-09's narrow revocation-signal discriminator, reused at the dispatch
 * boundary: only `"provider_revoked"` counts as a positive revocation
 * signal. A `"transient_error"` (5xx, network, non-auth 4xx, or any
 * non-`invalid_grant` OAuth error) must never revoke a lease -- a single
 * blip never revokes.
 */
export function isProviderRevocation(kind: Exclude<RefreshResult["kind"], "ok">): boolean {
  return kind === "provider_revoked";
}

/**
 * Moves `lease` to `revoked` via `reduce(lease, providerEvents.grantRevoked(), now)`
 * -- the ONE sanctioned provider-actor event constructor (D-19: the agent is
 * never an actor). Legal from `active` or `granted` (ALP.md Section 7.4);
 * any other source state returns `reduce`'s own `illegal_transition`
 * rejection rather than throwing, so a caller can branch on `Result.ok`
 * without a try/catch.
 */
export function applyProviderRevocation(
  lease: Lease,
  now: number,
): Result<{ lease: Lease; transition: TransitionRecord }> {
  return reduce(lease, providerEvents.grantRevoked(), now);
}
