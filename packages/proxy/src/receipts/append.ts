/**
 * `appendReceiptEntry` -- the single path every `@stint/proxy` receipt takes
 * onto the verified chain (TEAR-06, T-08-23). It loads the persisted chain,
 * derives the next entry with core's `appendEntry` (so `seq` and `prevHash`
 * always link to the latest stored entry) and appends it.
 *
 * Stores reject an out-of-sequence append with `ReceiptConflictError` (the
 * chain advanced between the load and the append). The helper then reloads
 * the chain, re-derives the entry and tries again -- a plain bounded loop of
 * `RECEIPT_APPEND_ATTEMPTS` attempts in total, with no timer and no sleep
 * (T-08-24), so it can neither spin forever nor hold a lock while waiting.
 * After the last failed attempt the conflict is rethrown; any other store
 * error is rethrown at once.
 */

import { appendEntry, ReceiptConflictError } from "@stint/core";
import type { ReceiptEntry, ReceiptEntryInput, ReceiptStore } from "@stint/core";

/** Total append attempts (the first try plus reloads) before a `ReceiptConflictError` is rethrown. */
export const RECEIPT_APPEND_ATTEMPTS = 5;

/**
 * Appends `input` to `input.chain`'s persisted log and returns the stored
 * entry. Survives a concurrent writer by reloading and re-deriving on
 * `ReceiptConflictError`, at most `RECEIPT_APPEND_ATTEMPTS` times in total.
 */
export async function appendReceiptEntry(
  receiptStore: ReceiptStore,
  input: ReceiptEntryInput,
  now: number,
): Promise<ReceiptEntry> {
  let lastConflict: ReceiptConflictError | undefined;
  for (let attempt = 0; attempt < RECEIPT_APPEND_ATTEMPTS; attempt++) {
    const chain = await receiptStore.load(input.chain);
    const entry = appendEntry(chain, input, now);
    try {
      await receiptStore.append(input.chain, entry);
      return entry;
    } catch (error) {
      if (!(error instanceof ReceiptConflictError)) throw error;
      lastConflict = error;
    }
  }
  // The loop only exits here after RECEIPT_APPEND_ATTEMPTS conflicts.
  throw lastConflict ?? new ReceiptConflictError(input.chain, 0);
}
