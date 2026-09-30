/**
 * `ReceiptStore` — the async append/load/checkpoint-read-write contract for
 * persisting receipt chains (D-08, RCPT-02, RCPT-03). Mirrors
 * `packages/core/src/lease-store.ts`'s "async, returns a value, never throws
 * for an expected outcome" shape, scoped to the receipt log's own smaller
 * surface instead of `LeaseStore`'s CRUD+transaction contract.
 *
 * The receipt log is related-but-distinct from `LeaseStore` (ARCHITECTURE):
 * an append-only audit trail, not a current-state snapshot. It is NOT folded
 * into `LeaseStore` and never will be — keep this interface in its own file,
 * exactly as `lease-store.ts` is separate from `lease.ts`.
 *
 * Normative append-only guarantee this interface is the single source of
 * truth for, and that Phase 6's JSON-file `ReceiptStore` implements against:
 * `append(chain, entry)` MUST NOT overwrite, reorder, or remove any
 * previously-appended entry for that `chain` — `load(chain)` MUST always
 * return every entry appended so far, in the exact order `append` was
 * called, for that chain. The two chains (`"verified"` / `"attested"`) are
 * stored independently; appending to one MUST NOT affect the other's
 * `load`/`readCheckpoint` result. A `ReceiptStore` never computes or trusts
 * its own hash of a stored entry — it persists opaque `ReceiptEntry` values
 * and leaves hash-chain integrity to `verifyChain`/`verifyAttestedChain`
 * (chain.ts/attested.ts) to recompute on load (D-04, D-05). This is verified
 * once, generically, by the shared contract-test factory (`testing.ts`) that
 * both the in-memory double here and the Phase 6 JSON-file store run against
 * their own implementation, so neither can silently drift from the
 * guarantee.
 */

import type { Checkpoint, ReceiptChain, ReceiptEntry } from "@stint/spec";

/**
 * The async append/load/checkpoint-read-write contract every `ReceiptStore`
 * implementation (the in-memory double here, the Phase 6 JSON-file store)
 * must uphold.
 */
export interface ReceiptStore {
  /**
   * Appends `entry` to `chain`'s persisted log. MUST NOT overwrite, reorder,
   * or remove any previously-appended entry for that `chain` — append-only.
   */
  append(chain: ReceiptChain, entry: ReceiptEntry): Promise<void>;
  /**
   * Returns every entry appended to `chain` so far, in append order. A
   * chain with no appended entries returns `[]`.
   */
  load(chain: ReceiptChain): Promise<readonly ReceiptEntry[]>;
  /**
   * Returns the most recently written `Checkpoint` for `chain`, or
   * `undefined` if none has been written yet.
   */
  readCheckpoint(chain: ReceiptChain): Promise<Checkpoint | undefined>;
  /**
   * Persists `checkpoint`, replacing any prior checkpoint stored for
   * `checkpoint.chain`.
   */
  writeCheckpoint(checkpoint: Checkpoint): Promise<void>;
}
