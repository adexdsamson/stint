/**
 * The canonical `Lease` shape and `reduce()`, the pure, table-driven
 * transition function every later Phase 2 plan (policy, activation,
 * teardown) builds on (D-01, D-02, D-04, D-20).
 *
 * `reduce` follows the numbered-step, early-return, Result-returning control
 * flow of `@stint/spec`'s `verifyEnvelope`: look up legality, check actor
 * attribution, compute the next lease, build the `TransitionRecord`. It
 * never mutates its input and never throws for an expected rejection.
 */

import { TRANSITION_TABLE } from "./transitions.js";
import type { Actor, Event, State } from "./transitions.js";
import type { LeaseEvent } from "./events.js";
import type { CoreError, CoreErrorCode, Result } from "./errors.js";

/**
 * D-01: the single serialized aggregate both `reduce` and the policy
 * function read. `actionTimestamps` (D-05/D-06) is the per-action epoch
 * timestamp list the `actions_per_hour` sliding window enforces against —
 * additive, data-only this plan; mirrors `denialErrorTimestamps` exactly.
 * Enforcement (pruning/window checks) lands in plan 04-03.
 */
export interface LeaseCounters {
  readonly actionCount: number;
  readonly spentMinor: number;
  readonly denialErrorTimestamps: readonly number[];
  readonly actionTimestamps: readonly number[];
}

/**
 * The canonical, immutable lease shape (D-01, D-04, D-06, D-20). `boundHash`
 * is the prefixed `jcs-sha256:` content hash captured at consent — never
 * the manifest itself (D-20). `grantedAt`/`expiresAt` are epoch seconds,
 * `0` until the lease is granted; only the `consent_granted` and `extend`
 * paths move `expiresAt` (D-06).
 */
export interface Lease {
  readonly id: string;
  readonly state: State;
  readonly version: number;
  readonly boundHash: string;
  readonly grantedAt: number;
  readonly expiresAt: number;
  readonly maxDurationSeconds: number;
  readonly counters: LeaseCounters;
}

/** D-02: at minimum these five fields; the caller persists it and Phase 3 receipts consume it. */
export interface TransitionRecord {
  readonly from: State;
  readonly event: Event;
  readonly actor: Actor;
  readonly to: State;
  readonly at: number;
}

/** Recursively freezes `value` (and every nested array/object) so a returned `Lease` can never be mutated after minting. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

function reject(
  code: CoreErrorCode,
  message: string,
  context?: Readonly<Record<string, string>>,
): Result<never> {
  const error: CoreError =
    context === undefined ? { path: "", code, message } : { path: "", code, message, context };
  return { ok: false, errors: [error] };
}

/**
 * `reduce(lease, event, now)`: the single entry point every consumer calls
 * to advance a lease's state (D-03). Follows ALP.md Section 7.4 exactly via
 * the `TRANSITION_TABLE` lookup — never nested conditionals.
 */
export function reduce(
  lease: Lease,
  event: LeaseEvent,
  now: number,
): Result<{ lease: Lease; transition: TransitionRecord }> {
  // Step 1 — legality: is `(state, event)` in the table at all?
  const key = `${lease.state}:${event.type}`;
  const entry = TRANSITION_TABLE[key];
  if (entry === undefined) {
    return reject(
      "illegal_transition",
      `No legal transition from "${lease.state}" on event "${event.type}".`,
      {
        from: lease.state,
        event: event.type,
      },
    );
  }

  // Step 2 — actor attribution: independently re-check the event's actor
  // against the table entry, never trusting a caller-set actor (D-19).
  if (!entry.actors.includes(event.actor)) {
    return reject("wrong_actor", `Actor "${event.actor}" may not cause event "${event.type}".`, {
      event: event.type,
      actor: event.actor,
      expected: entry.actors.join("|"),
    });
  }

  // Step 3 — event-specific guard: `extend` is bounded by `lease.maxDurationSeconds`
  // per extension (D-06). This is the only guard beyond the table lookup and
  // the actor check; it runs before any lease is computed so a rejected
  // extend never advances state or version.
  let extendedExpiresAt: number | undefined;
  if (event.type === "extend") {
    const delta = event.deltaSeconds;
    const isValidDelta = typeof delta === "number" && Number.isInteger(delta) && delta > 0;
    if (!isValidDelta || delta > lease.maxDurationSeconds) {
      return reject("extension_exceeds_max", "Extension delta exceeds lease.maxDurationSeconds.", {
        delta: String(delta),
        max: String(lease.maxDurationSeconds),
      });
    }
    extendedExpiresAt = lease.expiresAt + delta;
  }

  // Step 4 — compute the next lease: copy the input, never mutate it.
  // `expiresAt` is written in exactly two branches: `consent_granted` (grant)
  // and `extend` (D-06, D-08) — every other transition, including `expire`,
  // leaves `expiresAt` untouched. `expire`'s `at` field below uses only the
  // injected `now`; this function never reads a wall clock (D-07).
  const isConsentGranted = event.type === "consent_granted";
  const nextExpiresAt = isConsentGranted
    ? now + lease.maxDurationSeconds
    : extendedExpiresAt !== undefined
      ? extendedExpiresAt
      : lease.expiresAt;
  const nextLease: Lease = deepFreeze({
    ...lease,
    state: entry.to,
    version: lease.version + 1,
    grantedAt: isConsentGranted ? now : lease.grantedAt,
    expiresAt: nextExpiresAt,
  });

  // Step 5 — build the TransitionRecord and return.
  const transition: TransitionRecord = {
    from: lease.state,
    event: event.type,
    actor: event.actor,
    to: entry.to,
    at: now,
  };

  return { ok: true, value: { lease: nextLease, transition } };
}
