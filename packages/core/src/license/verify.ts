/**
 * PASETO v4.public hosted-license offline verification (D-11, D-13, D-14, D-16, LIC-02).
 *
 * RED phase stub (03-05 Task 3): `LICENSE_CLOCK_SKEW_SECONDS` and the result
 * shapes are declared now (structural, not behavioral); `verifyLicense`
 * throws until implemented.
 */

import type { PublicKey } from "paseto/v4/public";

import type { LicenseClaims } from "./issue.js";
import type { Result } from "./errors.js";

export type { Result } from "./errors.js";

/**
 * The explicit, tested clock-skew tolerance (in seconds) every `verifyLicense`
 * call passes to paseto's `Verify` -- never the library's default of zero
 * (D-14). Deliberately single-digit relative to the 300s default TTL so it
 * does not widen the revocation-latency bound.
 */
export const LICENSE_CLOCK_SKEW_SECONDS = 5;

/** What a successful `verifyLicense` call returns: the authenticated custom claims, the footer's `kid`, and the decoded `exp` (epoch seconds). */
export interface VerifiedLicense {
  readonly claims: LicenseClaims;
  readonly kid: string;
  readonly expEpochSeconds: number;
}

/**
 * Verifies `token` offline against `publicKey`, deriving the implicit
 * assertion from `leaseId` and `specVersion` via the one shared
 * `deriveImplicitAssertion` (the same bytes `issueLicense` used) -- so a
 * token issued for a different lease or spec version fails verification
 * (the implicit assertion no longer matches, so paseto's own signature
 * check fails). Every failure mode maps to one of `LicenseVerifyReason`'s
 * fixed codes; the underlying paseto/crypto exception text is never
 * forwarded (D-16).
 */
export async function verifyLicense(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  publicKey: PublicKey,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  token: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  leaseId: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  specVersion: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  now: number,
): Promise<Result<VerifiedLicense>> {
  throw new Error("not implemented");
}
