/**
 * Actor-namespaced lifecycle event constructors (D-19). Each namespace
 * (`userEvents`, `clockEvents`, ...) hard-codes the `actor` field on every
 * event it produces — the actor is never a caller-supplied claim. `reduce()`
 * (lease.ts) independently re-checks an event's `actor` against
 * `TRANSITION_TABLE` and rejects a mismatch with `wrong_actor`, so a forged
 * actor cannot slip through even if a caller constructs an event object by
 * hand instead of using these constructors.
 *
 * The agent boundary (the Phase 4 proxy) MUST NEVER import this module. That
 * is how "the agent is never an actor" (ALP.md Section 7.2) is guaranteed
 * structurally, not merely documented: there is no code path from an agent
 * message to a lifecycle transition, because the only way to produce a
 * `LeaseEvent` is through a constructor namespaced to a non-agent actor.
 *
 * This tracer defines only `userEvents` (`consentGranted`, `consentDeclined`,
 * `revoke`). Plan 02-02 adds `clockEvents`, `policyEvents`, `providerEvents`,
 * `publisherEvents`, `verifierEvents`, `runtimeEvents`, and
 * `userEvents.extend` / `userEvents.retryTeardown`.
 */

import type { Actor, Event } from "./transitions.js";

export interface LeaseEvent {
  readonly type: Event;
  readonly actor: Actor;
  readonly deltaSeconds?: number;
}

function freezeEvent(event: LeaseEvent): LeaseEvent {
  return Object.freeze(event);
}

export const userEvents = {
  consentGranted(): LeaseEvent {
    return freezeEvent({ type: "consent_granted", actor: "user" });
  },
  consentDeclined(): LeaseEvent {
    return freezeEvent({ type: "consent_declined", actor: "user" });
  },
  revoke(): LeaseEvent {
    return freezeEvent({ type: "revoke", actor: "user" });
  },
};
