/**
 * The injectable `LicenseIssuer` port (D-11, D-12). The runtime depends on
 * this port and never signs a license directly -- `issueLicense` is a
 * reference primitive an implementation may compose (the mock publisher in
 * `@stint/core/testing`, and Phase 7's mock publisher), but no code in
 * `@stint/core` proper calls it or holds a signing key.
 *
 * `reissue` is where the LIC-03 clamp is enforced: an implementation is
 * expected to compute `clampedLicenseExpiry(now, DEFAULT_LICENSE_TTL_SECONDS,
 * leaseExpiresAt)` and return `null` (refusing the refresh) once that clamp
 * is `null` -- it must never sign a token whose expiry would exceed the
 * lease.
 */

import type { LicenseClaims } from "./issue.js";
import type { HeldLicense } from "./held-license.js";

/** Injected port for issuing and refreshing hosted licenses; never implemented inside core proper (D-11). */
export interface LicenseIssuer {
  /** The `kid` this issuer signs under -- the same value it carries in every issued token's footer. */
  readonly kid: string;

  /** Issues a fresh license for `claims`, expiring at the caller-supplied (already-clamped) `expEpochSeconds`. */
  issue(
    claims: LicenseClaims,
    specVersion: string,
    now: number,
    expEpochSeconds: number,
    jti?: string,
  ): Promise<HeldLicense>;

  /**
   * Refreshes `claims`, clamping the new expiry to `min(now + defaultTtl,
   * leaseExpiresAt)` and refusing (returning `null`) once `now >=
   * leaseExpiresAt` -- so no refreshed token can ever outlive the lease
   * (LIC-03).
   */
  reissue(
    claims: LicenseClaims,
    specVersion: string,
    now: number,
    leaseExpiresAt: number,
    jti?: string,
  ): Promise<HeldLicense | null>;
}
