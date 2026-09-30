/**
 * The ALP.md Section 7.4 transition table, reproduced as a data structure
 * (D-05): a lookup keyed by `${state}:${event}` yielding `{ actors, to }`,
 * never nested conditionals. This is the single source of truth `reduce()`
 * (lease.ts) consults to decide whether a `(state, event, actor)` triple is
 * legal.
 *
 * This table is a byte-for-byte transcription of ALP.md Section 7.4 (lines
 * 356-380 at the time of writing): all 24 distinct `(state, event)` keys /
 * 25 `(state, event, actor)` triples. The only multi-actor key is
 * `cleanup_incomplete:retry_teardown`, legal from both `user` and `runtime`.
 * No transition is added, removed, or altered beyond what Section 7.4 states
 * (one-way, D-05) — `packages/core/test/transition-table.test.ts` parses
 * Section 7.4 from `spec/ALP.md` at test time and asserts this table is
 * identical to it, so drift in either direction fails CI.
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

export const ACTORS = [
  "user",
  "verifier",
  "policy",
  "clock",
  "provider",
  "publisher",
  "runtime",
] as const;

export type Actor = (typeof ACTORS)[number];

export type TransitionKey = `${State}:${Event}`;

export interface TransitionEntry {
  readonly actors: readonly Actor[];
  readonly to: State;
}

/**
 * ALP.md Section 7.4, transcribed exactly. `declined` and `cleaned_up` are
 * terminal states (Section 7.1) and carry no outgoing transition, so neither
 * has any key here.
 */
export const TRANSITION_TABLE: Readonly<Record<string, TransitionEntry>> = {
  "proposed:consent_granted": { actors: ["user"], to: "granted" },
  "proposed:consent_declined": { actors: ["user"], to: "declined" },
  "proposed:consent_timed_out": { actors: ["clock"], to: "declined" },
  "granted:activate": { actors: ["runtime"], to: "active" },
  "granted:activation_failed": { actors: ["runtime"], to: "failed" },
  "granted:revoke": { actors: ["user"], to: "revoked" },
  "granted:grant_revoked": { actors: ["provider"], to: "revoked" },
  "granted:entitlement_revoked": { actors: ["publisher"], to: "revoked" },
  "granted:expire": { actors: ["clock"], to: "expired" },
  "active:extend": { actors: ["user"], to: "active" },
  "active:outcome_verified": { actors: ["verifier"], to: "completed" },
  "active:expire": { actors: ["clock"], to: "expired" },
  "active:revoke": { actors: ["user"], to: "revoked" },
  "active:grant_revoked": { actors: ["provider"], to: "revoked" },
  "active:entitlement_revoked": { actors: ["publisher"], to: "revoked" },
  "active:error_threshold_exceeded": { actors: ["policy"], to: "failed" },
  "active:runtime_failure": { actors: ["runtime"], to: "failed" },
  "completed:begin_teardown": { actors: ["runtime"], to: "tearing_down" },
  "expired:begin_teardown": { actors: ["runtime"], to: "tearing_down" },
  "revoked:begin_teardown": { actors: ["runtime"], to: "tearing_down" },
  "failed:begin_teardown": { actors: ["runtime"], to: "tearing_down" },
  "tearing_down:teardown_succeeded": { actors: ["runtime"], to: "cleaned_up" },
  "tearing_down:teardown_incomplete": { actors: ["runtime"], to: "cleanup_incomplete" },
  "cleanup_incomplete:retry_teardown": { actors: ["user", "runtime"], to: "tearing_down" },
};
