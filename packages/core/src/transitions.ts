/**
 * The ALP.md Section 7.4 transition table, reproduced as a data structure
 * (D-05): a lookup keyed by `${state}:${event}` yielding `{ actors, to }`,
 * never nested conditionals. This is the single source of truth `reduce()`
 * (lease.ts) consults to decide whether a `(state, event, actor)` triple is
 * legal.
 *
 * This tracer seeds ONLY the `proposed` rows (3 of the eventual 24 keys / 25
 * triples in ALP.md Section 7.4). Plan 02-02 completes the table to every
 * row and adds a test that cross-checks it against ALP.md Section 7.4 so the
 * code and the spec cannot silently diverge.
 */

export const STATES = [
  "proposed",
  "declined",
  "granted",
  "active",
  "completed",
  "expired",
  "revoked",
  "failed",
  "tearing_down",
  "cleaned_up",
  "cleanup_incomplete",
] as const;

export type State = (typeof STATES)[number];

export const EVENTS = [
  "consent_granted",
  "consent_declined",
  "consent_timed_out",
  "activate",
  "activation_failed",
  "revoke",
  "grant_revoked",
  "entitlement_revoked",
  "expire",
  "extend",
  "outcome_verified",
  "error_threshold_exceeded",
  "runtime_failure",
  "begin_teardown",
  "teardown_succeeded",
  "teardown_incomplete",
  "retry_teardown",
] as const;

export type Event = (typeof EVENTS)[number];

export const ACTORS = ["user", "verifier", "policy", "clock", "provider", "publisher", "runtime"] as const;

export type Actor = (typeof ACTORS)[number];

export type TransitionKey = `${State}:${Event}`;

export interface TransitionEntry {
  readonly actors: readonly Actor[];
  readonly to: State;
}

export const TRANSITION_TABLE: Readonly<Record<string, TransitionEntry>> = {
  "proposed:consent_granted": { actors: ["user"], to: "granted" },
  "proposed:consent_declined": { actors: ["user"], to: "declined" },
  "proposed:consent_timed_out": { actors: ["clock"], to: "declined" },
};
