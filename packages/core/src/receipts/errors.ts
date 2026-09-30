/**
 * Receipt-chain verification failure vocabulary for `@stint/core`'s
 * `verifyChain` (D-09, RCPT-06).
 *
 * This is deliberately independent of both `@stint/spec`'s `SpecErrorCode`
 * and `@stint/core`'s own `CoreErrorCode` (packages/core/src/errors.ts) —
 * neither is imported or aliased here, mirroring the exact discipline
 * `errors.ts`'s own docstring establishes for `CoreErrorCode` relative to
 * `SpecErrorCode`. A receipt-chain break is not a lease-transition error;
 * conflating the two vocabularies would let a rename of one silently break
 * the other's consumers (RESEARCH.md Pitfall 4).
 *
 * `Result<T>` below mirrors the shape of `@stint/core`'s own `Result<T>`
 * (packages/core/src/errors.ts) — the same `{ ok: true; value } | { ok:
 * false; errors }` discriminated union — without importing it, since that
 * type is pinned to `CoreError`/`CoreErrorCode` and this module's failures
 * carry a different shape (`{ brokenAtSeq, reason }`, not `{ path, code,
 * message }`).
 */

export const RECEIPT_VERIFY_REASONS = [
  "hash_mismatch",
  "reordered",
  "truncated",
  "checkpoint_sig_invalid",
  "claim_sig_invalid",
] as const;

export type ReceiptVerifyReason = (typeof RECEIPT_VERIFY_REASONS)[number];

/** The precise break locus a failed `verifyChain` reports (D-09, RCPT-06). */
export interface ChainVerifyFailure {
  readonly brokenAtSeq: number;
  readonly reason: ReceiptVerifyReason;
}

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly ChainVerifyFailure[] };
