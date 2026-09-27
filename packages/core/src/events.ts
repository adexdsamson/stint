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
 * `LeaseEvent` is through a constructor namespaced to a non-agent actor —
 * and `agent` is not even a member of the `Actor` union (transitions.ts).
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
  /** D-06: `deltaSeconds` is the requested extension, bounded by `lease.maxDurationSeconds` in `reduce()`. */
  extend(deltaSeconds: number): LeaseEvent {
    return freezeEvent({ type: "extend", actor: "user", deltaSeconds });
  },
  retryTeardown(): LeaseEvent {
    return freezeEvent({ type: "retry_teardown", actor: "user" });
  },
};

export const clockEvents = {
  expire(): LeaseEvent {
    return freezeEvent({ type: "expire", actor: "clock" });
  },
  consentTimedOut(): LeaseEvent {
    return freezeEvent({ type: "consent_timed_out", actor: "clock" });
  },
};

export const policyEvents = {
  errorThresholdExceeded(): LeaseEvent {
    return freezeEvent({ type: "error_threshold_exceeded", actor: "policy" });
  },
};

export const providerEvents = {
  grantRevoked(): LeaseEvent {
    return freezeEvent({ type: "grant_revoked", actor: "provider" });
  },
};

export const publisherEvents = {
  entitlementRevoked(): LeaseEvent {
    return freezeEvent({ type: "entitlement_revoked", actor: "publisher" });
  },
};

export const verifierEvents = {
  outcomeVerified(): LeaseEvent {
    return freezeEvent({ type: "outcome_verified", actor: "verifier" });
  },
};

export const runtimeEvents = {
  activate(): LeaseEvent {
    return freezeEvent({ type: "activate", actor: "runtime" });
  },
  activationFailed(): LeaseEvent {
    return freezeEvent({ type: "activation_failed", actor: "runtime" });
  },
  runtimeFailure(): LeaseEvent {
    return freezeEvent({ type: "runtime_failure", actor: "runtime" });
  },
  beginTeardown(): LeaseEvent {
    return freezeEvent({ type: "begin_teardown", actor: "runtime" });
  },
  teardownSucceeded(): LeaseEvent {
    return freezeEvent({ type: "teardown_succeeded", actor: "runtime" });
  },
  teardownIncomplete(): LeaseEvent {
    return freezeEvent({ type: "teardown_incomplete", actor: "runtime" });
  },
  retryTeardown(): LeaseEvent {
    return freezeEvent({ type: "retry_teardown", actor: "runtime" });
  },
};
