/**
 * `LeaseStore` — the async CRUD contract plus a serialized read-modify-write
 * primitive (`transaction`, a.k.a. `withLease`) that Phases 4, 5, and 6
 * implement/consume (D-13). This is the concurrency-safety boundary for the
 * whole runtime: spec/ALP.md Section 9 requires that state reads,
 * limit-counter updates, and transitions for one lease never race.
 *
 * The per-lease serialization requirement lives IN this contract, not merely
 * as a suggestion to implementors: any conforming `LeaseStore` MUST serialize
 * concurrent `transaction(id, mutate)` calls for the SAME `id` (never
 * interleaved), while calls for DIFFERENT ids may proceed concurrently. This
 * is verified once, generically, by the shared contract test factory
 * (`testing.ts`, Task 2) that both the in-memory double here and the Phase 6
 * `proper-lockfile`-backed JSON-file store run against their own
 * implementation, so neither can silently drift from the guarantee.
 *
 * There is no stateful async store analog elsewhere in this codebase — the
 * closest structural precedent is `@stint/spec`'s
 * `verifyEnvelope(...): Promise<Result<...>>` (an async function returning a
 * value, never throwing for an expected outcome). `LeaseStore`'s CRUD methods
 * follow that same "async, returns a value" shape; `transaction` additionally
 * owns the serialization guarantee itself, designed directly from D-13 since
 * no mutex/queue analog exists to mirror.
 */

import type { Lease } from "./lease.js";

/**
 * The read-modify-write step `transaction` applies to the current `Lease`
 * for an id. May be synchronous or asynchronous; either way `transaction`
 * awaits it before persisting the result.
 */
export type LeaseMutator = (lease: Lease) => Lease | Promise<Lease>;

/**
 * The async CRUD contract plus the serialized read-modify-write primitive
 * every `LeaseStore` implementation (the in-memory double here, the Phase 6
 * JSON-file store) must uphold.
 */
export interface LeaseStore {
  /** Returns the current `Lease` for `id`, or `undefined` if no lease with that id has been saved. */
  load(id: string): Promise<Lease | undefined>;
  /** Persists `lease`, replacing any prior value stored under `lease.id`. */
  save(lease: Lease): Promise<void>;
  /** Returns every lease currently in the store. An empty store returns `[]`. */
  list(): Promise<readonly Lease[]>;
  /** Removes the lease stored under `id`, if any. */
  delete(id: string): Promise<void>;
  /**
   * Loads the current lease for `id`, applies `mutate`, persists the result,
   * and returns it — the serialized read-modify-write primitive (a.k.a.
   * `withLease`). Concurrent `transaction` calls for the SAME `id` MUST be
   * serialized (never interleaved); calls for DIFFERENT ids may proceed
   * concurrently (spec/ALP.md Section 9 per-lease serialization).
   *
   * Rejects if `id` does not exist — the caller must `save` an initial lease
   * before calling `transaction` on it; `transaction` never creates a lease
   * from nothing.
   */
  transaction(id: string, mutate: LeaseMutator): Promise<Lease>;
}
