/**
 * License verification failure vocabulary for `@stint/core`'s
 * `verifyLicense` (D-13, D-16, LIC-02).
 *
 * Deliberately independent of `@stint/spec`'s `SpecErrorCode`,
 * `@stint/core`'s own `CoreErrorCode` (packages/core/src/errors.ts), and the
 * receipt chain's `ReceiptVerifyReason` (packages/core/src/receipts/errors.ts)
 * -- none of those are imported or aliased here. A license verification
 * failure is not a lease-transition error and not a receipt-chain break;
 * conflating vocabularies would let a rename in one silently break the
 * other's consumers (mirrors receipts/errors.ts's own docstring discipline).
 *
 * Every reason below is a fixed, non-interpolated string. `verify.ts` is the
 * single call site that produces these: every failure mode from every
 * `PasetoError` subclass (`ClaimValidationError`, `InvalidTokenError`,
 * `InvalidKeyError`), and any other unexpected throw, collapses to one of
 * these codes. The underlying library's own exception text is never
 * forwarded into a `Result`, receipt, or log (D-16).
 */

export const LICENSE_VERIFY_REASONS = [
  "license_claim_invalid",
  "license_invalid_signature",
  "license_verification_failed",
] as const;

export type LicenseVerifyReason = (typeof LICENSE_VERIFY_REASONS)[number];

/** The fixed, non-interpolated failure a rejected `verifyLicense` call reports. */
export interface LicenseVerifyFailure {
  readonly reason: LicenseVerifyReason;
}

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly LicenseVerifyFailure[] };
