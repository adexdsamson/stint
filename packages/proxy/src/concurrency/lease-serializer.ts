/**
 * `runInLeaseTransaction` -- a thin wrapper over `@stint/core`'s
 * `LeaseStore.transaction(id, mutate)`, the already-implemented,
 * contract-tested per-lease serialization primitive (Phase 2 D-13).
 *
 * Per RESEARCH.md's "Don't Hand-Roll" table, `@stint/proxy` MUST NOT build a
 * second `Map<leaseId, Promise>` queue -- that would create two sources of
 * truth for the same lease's serialization guarantee. `dispatch.ts` calls
 * this instead of `deps.leaseStore.transaction` directly purely so every
 * mutating call-handling path in `@stint/proxy` has one obvious, greppable
 * entry point; the actual serialization is entirely `LeaseStore`'s.
 *
 * The mutator passed to `runInLeaseTransaction` is expected to compute both
 * the next `Lease` (its return value) and any other outcome the caller
 * needs -- e.g. the `CallToolResult` `dispatch.ts`'s `handleCall` produces
 * -- via a variable captured in the mutator's closure, since `LeaseMutator`
 * itself only returns a `Lease`.
 */

import type { Lease, LeaseMutator, LeaseStore } from "@stint/core";

/** Runs `mutate` as the per-`leaseId` serialized read-modify-write step (D-13). */
export function runInLeaseTransaction(
  store: LeaseStore,
  leaseId: string,
  mutate: LeaseMutator,
): Promise<Lease> {
  return store.transaction(leaseId, mutate);
}
