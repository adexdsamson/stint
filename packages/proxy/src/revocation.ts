/**
 * `applyProviderRevocation`/`isProviderRevocation` -- the D-09/PRXY-07
 * lazy customer-side OAuth revocation wiring. A single, narrow bridge from
 * the 04-05 vault's `provider_revoked` classification to the ONE sanctioned
 * provider-actor lifecycle event (`@stint/core`'s `providerEvents.grantRevoked()`).
 *
 * `applyProviderRevocation` chains TWO `reduce()` calls -- `grant_revoked`
 * (actor `provider`) then, via the shared `chainTeardownIfEnded` helper
 * (D-18), `begin_teardown` (actor `runtime`) -- so a provider revocation now
 * drives the full teardown, not just a bare `revoked` lease (D-18, TEAR-01).
 * It never hand-rolls either transition, never imports a broader slice of
 * `@stint/core`'s events module beyond `providerEvents`, and never trusts a
 * caller-supplied actor (the agent is never an actor, D-19). Both
 * `TransitionRecord`s are returned (in order) so `dispatch.ts`'s
 * `provider_revoked` catch branch -- the sole call site -- can receipt each
 * one; the resulting `tearing_down` lease is returned from the per-lease
 * transaction's mutator so it is saved atomically with the triggering
 * call's `denied` receipt (D-13).
 *
 * `applyEntitlementRevocation` (LIC-04, D-21) mirrors the same shape
 * verbatim, chaining `entitlement_revoked` (actor `publisher` --
 * `@stint/core`'s `publisherEvents.entitlementRevoked()`) into
 * `begin_teardown` via the identical `chainTeardownIfEnded` helper. It is
 * the runtime-facing entry point a platform/publisher webhook wires to in a
 * later phase -- this phase provides the sanctioned bridge, not the webhook
 * transport itself.
 *
 * `isProviderRevocation` narrows the 04-05 `RefreshResult`'s failure kinds
 * (`CredentialRefreshError.kind` carries the identical union) so the
 * transient-vs-revocation discrimination reads as one boolean check, never a
 * re-derivation of D-09's classification.
 */

import { providerEvents, publisherEvents, reduce } from "@stint/core";
import type { Lease, Result, TransitionRecord } from "@stint/core";

import { chainTeardownIfEnded } from "./teardown/auto-chain.js";
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
 * never an actor) -- then immediately auto-chains `begin_teardown` via
 * `chainTeardownIfEnded` (D-18), landing `tearing_down`. `grant_revoked` is
 * legal from `active` or `granted` (ALP.md Section 7.4); either that
 * transition or the chained `begin_teardown` failing returns `reduce`'s own
 * `illegal_transition` rejection rather than throwing, so a caller can
 * branch on `Result.ok` without a try/catch. `transitions` carries BOTH
 * `TransitionRecord`s in order (`grant_revoked` then `begin_teardown`) so
 * the caller can receipt each one.
 */
export function applyProviderRevocation(
  lease: Lease,
  now: number,
): Result<{ lease: Lease; transitions: readonly [TransitionRecord, TransitionRecord] }> {
  const revoked = reduce(lease, providerEvents.grantRevoked(), now);
  if (!revoked.ok) return revoked;
  const chained = chainTeardownIfEnded(revoked.value.lease, now);
  if (!chained.ok) return chained;
  return {
    ok: true,
    value: {
      lease: chained.value.lease,
      transitions: [revoked.value.transition, chained.value.transition],
    },
  };
}

/**
 * Moves `lease` to `revoked` via `reduce(lease, publisherEvents.entitlementRevoked(), now)`
 * -- the ONE sanctioned publisher-actor event constructor (D-19: the agent is
 * never an actor; only `publisher` may cause `entitlement_revoked`, LIC-04)
 * -- then immediately auto-chains `begin_teardown` via `chainTeardownIfEnded`
 * (D-18), landing `tearing_down`. `entitlement_revoked` is legal only from a
 * source state the transition table permits; an illegal source state or the
 * chained `begin_teardown` failing returns `reduce`'s own `illegal_transition`
 * rejection rather than throwing, mirroring `applyProviderRevocation`
 * exactly. `transitions` carries BOTH `TransitionRecord`s in order
 * (`entitlement_revoked` then `begin_teardown`) so a caller can receipt each
 * one -- the same shape `dispatch.ts`'s `provider_revoked` branch already
 * consumes for the sibling end reason.
 */
export function applyEntitlementRevocation(
  lease: Lease,
  now: number,
): Result<{ lease: Lease; transitions: readonly [TransitionRecord, TransitionRecord] }> {
  const revoked = reduce(lease, publisherEvents.entitlementRevoked(), now);
  if (!revoked.ok) return revoked;
  const chained = chainTeardownIfEnded(revoked.value.lease, now);
  if (!chained.ok) return chained;
  return {
    ok: true,
    value: {
      lease: chained.value.lease,
      transitions: [revoked.value.transition, chained.value.transition],
    },
  };
}
