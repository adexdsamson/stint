/**
 * The reference `LicenseIssuer` (D-11, D-14): a non-test PASETO signer a mock
 * (or real) publisher wraps. It is the test-runner-free twin of
 * `@stint/core/testing`'s `createMockLicenseIssuer` -- that double now
 * delegates here so the two can never drift. This module (and everything it
 * imports) MUST NOT import the test runner: it is exposed through the
 * `@stint/core/license-issuer` subpath so a quickstart runtime can import it
 * without dragging the optional test-runner peer in (Pitfall 5).
 *
 * The issuer composes the reference `issueLicense` primitive and wraps its raw
 * token in a `HeldLicense` via `mintHeldLicense`. `reissue` enforces the
 * LIC-03 clamp itself via `clampedLicenseExpiry`, refusing (`null`) once the
 * clamp is `null`, and refuses for any lease id the runtime has told it to
 * `invalidate` (LIC-04/D-21).
 */

import { PublicProtocol } from "paseto";
import { GenerateKeyPairFactory } from "paseto/v4/public";
import type { PublicKey } from "paseto/v4/public";

import { mintHeldLicense } from "./held-license.js";
import type { HeldLicense } from "./held-license.js";
import { issueLicense } from "./issue.js";
import type { LicenseClaims } from "./issue.js";
import type { LicenseIssuer } from "./license-issuer.js";
import { clampedLicenseExpiry, DEFAULT_LICENSE_TTL_SECONDS } from "./refresh.js";

/** The default `kid` the reference issuer signs under when the caller supplies none. */
export const REFERENCE_LICENSE_ISSUER_KID = "reference-publisher-key";

const keyPairProtocol = new PublicProtocol(GenerateKeyPairFactory);

/** Optional configuration for {@link createReferenceLicenseIssuer}. */
export interface ReferenceLicenseIssuerOptions {
  /** The `kid` carried in every issued token's footer. Defaults to {@link REFERENCE_LICENSE_ISSUER_KID}. */
  readonly kid?: string;
}

/** A `LicenseIssuer` plus the public key a verifier pins to check what it issued. */
export interface ReferenceLicenseIssuer {
  readonly issuer: LicenseIssuer;
  readonly publicKey: PublicKey;
}

/**
 * Creates a `LicenseIssuer` backed by a fresh, extractable Ed25519 keypair
 * generated for this call. Exposes the `publicKey` so the runtime client and
 * offline verification can pin it.
 */
export async function createReferenceLicenseIssuer(
  options: ReferenceLicenseIssuerOptions = {},
): Promise<ReferenceLicenseIssuer> {
  const { secretKey, publicKey } = await keyPairProtocol.GenerateKeyPair({ extractable: true });
  const kid = options.kid ?? REFERENCE_LICENSE_ISSUER_KID;
  // LIC-04/D-21: leases the runtime has told this issuer to stop issuing
  // for -- `reissue` refuses (returns null) for any lease id in this set.
  // No background loop: a plain custody flag flipped once by `invalidate`.
  const invalidatedLeaseIds = new Set<string>();

  async function issue(
    claims: LicenseClaims,
    specVersion: string,
    now: number,
    expEpochSeconds: number,
    jti?: string,
  ): Promise<HeldLicense> {
    const token = await issueLicense(
      secretKey,
      claims,
      kid,
      specVersion,
      now,
      expEpochSeconds,
      jti,
    );
    return mintHeldLicense(token);
  }

  async function reissue(
    claims: LicenseClaims,
    specVersion: string,
    now: number,
    leaseExpiresAt: number,
    jti?: string,
  ): Promise<HeldLicense | null> {
    if (invalidatedLeaseIds.has(claims.lease_id)) return null;
    const expEpochSeconds = clampedLicenseExpiry(now, DEFAULT_LICENSE_TTL_SECONDS, leaseExpiresAt);
    if (expEpochSeconds === null) return null;
    return issue(claims, specVersion, now, expEpochSeconds, jti);
  }

  async function invalidate(leaseId: string): Promise<void> {
    invalidatedLeaseIds.add(leaseId);
    return Promise.resolve();
  }

  return { issuer: { kid, issue, reissue, invalidate }, publicKey };
}
