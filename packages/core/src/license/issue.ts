/**
 * PASETO v4.public hosted-license issuance (D-11, D-13, LIC-01).
 *
 * RED phase stub (03-05 Task 3): `LicenseClaims` and its sub-shapes are
 * declared now (structural, not behavioral); `issueLicense` throws until
 * implemented.
 */

import type { SecretKey } from "paseto/v4/public";

/** The custom claim carrying the manifest's `job.description` into the license (Claude's Discretion, D-13). */
export interface LicenseJobClaim {
  readonly description: string;
}

/** The custom claim carrying the manifest's entitlement bounds into the license (Claude's Discretion, D-13). */
export interface LicenseLimitsClaim {
  readonly max_actions: number;
  readonly actions_per_hour: number | null;
}

/** The three custom claims a hosted license carries alongside the registered `exp`/`iat`/`nbf`/`jti` (D-13). */
export interface LicenseClaims {
  readonly lease_id: string;
  readonly job: LicenseJobClaim;
  readonly limits: LicenseLimitsClaim;
}

/**
 * Issues a PASETO v4.public license over `claims`, with `kid` carried in the
 * token's (authenticated, public/non-secret) footer and the implicit
 * assertion derived by the one shared `deriveImplicitAssertion` (D-13).
 * `exp` is set as an explicit claim derived from the already-clamped
 * `expEpochSeconds` -- never via paseto's `expiresIn` option -- so callers
 * (LIC-03's refresh clamp) fully control the issued expiry. `jti` defaults
 * to a fresh random token identifier; a caller may pass a fixed value for
 * reproducible output (e.g. the license conformance vector).
 */
export async function issueLicense(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  secretKey: SecretKey,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  claims: LicenseClaims,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  kid: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  specVersion: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  now: number,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  expEpochSeconds: number,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  jti?: string,
): Promise<string> {
  throw new Error("not implemented");
}
