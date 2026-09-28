/**
 * `chainTeardownIfEnded` -- the D-18 shared auto-chain helper. On reaching
 * any terminal end state (`completed`/`expired`/`revoked`/`failed`), the
 * runtime immediately dispatches `begin_teardown` (actor `runtime`) as a
 * SECOND, distinct `reduce()` call chained onto the ending transition -- so
 * no lease is left terminal-but-not-torn-down (TEAR-01). Mirrors
 * `revocation.ts`'s pre-retrofit `applyProviderRevocation` "call reduce,
 * check `.ok`" shape exactly: this is the ONE shared helper every
 * end-transition call site (the provider-revocation retrofit in
 * `revocation.ts`, and `orchestrate.ts`'s own `runTeardown`) calls, instead
 * of duplicating the ending-state check at each site (D-16: no hand-rolled
 * parallel transition check -- every state change goes through core's
 * `reduce()` and its namespaced event constructors).
 *
 * `reduce()`'s own `TRANSITION_TABLE` lookup is what actually enforces the
 * "terminal end state" precondition: only `completed`/`expired`/`revoked`/
 * `failed` have a `begin_teardown` table entry, so calling this on a lease
 * already `tearing_down` (or any other state) returns `reduce`'s own
 * `illegal_transition` rejection rather than a thrown error -- callers
 * branch on `Result.ok`, never a try/catch.
 */

import { reduce, runtimeEvents } from "@stint/core";
import type { Lease, Result, TransitionRecord } from "@stint/core";

export function chainTeardownIfEnded(
  lease: Lease,
  now: number,
): Result<{ lease: Lease; transition: TransitionRecord }> {
  return reduce(lease, runtimeEvents.beginTeardown(), now);
}
