/**
 * PASETO v4.public hosted-license offline verification (D-11, D-13, D-14, D-16, LIC-02).
 *
 * The single call site of paseto's `Verify` (composed via `PublicProtocol` +
 * `VerifyFactory`, mirroring `issue.ts`'s `PublicProtocol` + `SignFactory`
 * composition -- never the classic 3.x `V4.verify` static-namespace API).
 * Every call passes an explicit `clockTolerance` (`LICENSE_CLOCK_SKEW_SECONDS`)
 * -- paseto's own default is exactly zero (RESEARCH.md, confirmed from
 * source) -- and the implicit assertion from the one shared
 * `deriveImplicitAssertion`, so a token issued for a different lease or spec
 * version fails: its implicit assertion no longer matches, so paseto's own
 * signature authentication fails.
 *
 * `err()` mirrors `packages/spec/src/envelope.ts`'s discipline: every
 * `PasetoError` subclass, and any other unexpected throw, collapses to one
 * fixed, non-interpolated `LicenseVerifyReason` -- the library's own
 * exception text is never forwarded into the returned `Result` (D-16).
 */

import { PublicProtocol, ClaimValidationError, InvalidTokenError, InvalidKeyError } from "paseto";
import { VerifyFactory } from "paseto/v4/public";
import type { PublicKey } from "paseto/v4/public";

import { deriveImplicitAssertion } from "./implicit-assertion.js";
import type { LicenseClaims, LicenseJobClaim, LicenseLimitsClaim } from "./issue.js";
import type { LicenseVerifyReason, Result } from "./errors.js";

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

const verifyProtocol = new PublicProtocol(VerifyFactory);

function err(reason: LicenseVerifyReason): Result<never> {
  return { ok: false, errors: [{ reason }] };
}

function isLicenseJobClaim(value: unknown): value is LicenseJobClaim {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).description === "string"
  );
}

function isLicenseLimitsClaim(value: unknown): value is LicenseLimitsClaim {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.max_actions !== "number") return false;
  return record.actions_per_hour === null || typeof record.actions_per_hour === "number";
}

/**
 * Verifies `token` offline against `publicKey`, deriving the implicit
 * assertion from `leaseId` and `specVersion` via the one shared
 * `deriveImplicitAssertion` (the same bytes `issueLicense` used). Every
 * failure mode maps to one of `LicenseVerifyReason`'s fixed codes; the
 * underlying paseto/crypto exception text is never forwarded (D-16).
 */
export async function verifyLicense(
  publicKey: PublicKey,
  token: string,
  leaseId: string,
  specVersion: string,
  now: number,
): Promise<Result<VerifiedLicense>> {
  const implicitAssertion = deriveImplicitAssertion(leaseId, specVersion);

  let claims: Record<string, unknown>;
  let footer: Uint8Array;
  try {
    const result = await verifyProtocol.Verify(publicKey, token, {
      now: new Date(now * 1000),
      clockTolerance: LICENSE_CLOCK_SKEW_SECONDS,
      implicitAssertion,
    });
    claims = result.claims;
    footer = result.footer;
  } catch (error) {
    if (error instanceof ClaimValidationError) return err("license_claim_invalid");
    if (error instanceof InvalidTokenError) return err("license_invalid_signature");
    if (error instanceof InvalidKeyError) return err("license_invalid_signature");
    return err("license_verification_failed");
  }

  const leaseIdClaim = claims.lease_id;
  const jobClaim = claims.job;
  const limitsClaim = claims.limits;
  const expClaim = claims.exp;
  if (
    typeof leaseIdClaim !== "string" ||
    !isLicenseJobClaim(jobClaim) ||
    !isLicenseLimitsClaim(limitsClaim) ||
    typeof expClaim !== "string"
  ) {
    return err("license_claim_invalid");
  }

  // Defense-in-depth (WR-01): the implicit assertion above already binds a
  // conforming issuer's token to `leaseId`, but that binding holds only
  // because the reference `issueLicense` happens to derive its implicit
  // assertion from `claims.lease_id`, the same field it signs -- a
  // non-conforming `LicenseIssuer` (an injectable port third-party
  // publishers implement) could derive its implicit assertion from
  // something else and still verify successfully for a lease other than
  // the one its own `claims.lease_id` names. Cross-check directly rather
  // than relying solely on that side channel.
  if (leaseIdClaim !== leaseId) {
    return err("license_claim_invalid");
  }

  const expEpochSeconds = Math.floor(new Date(expClaim).getTime() / 1000);
  if (!Number.isFinite(expEpochSeconds)) {
    return err("license_claim_invalid");
  }

  let kid: string;
  try {
    const footerText = new TextDecoder("utf-8", { fatal: true }).decode(footer);
    const parsedFooter: unknown = JSON.parse(footerText);
    if (
      typeof parsedFooter !== "object" ||
      parsedFooter === null ||
      typeof (parsedFooter as Record<string, unknown>).kid !== "string"
    ) {
      return err("license_claim_invalid");
    }
    kid = (parsedFooter as Record<string, unknown>).kid as string;
  } catch {
    return err("license_claim_invalid");
  }

  return {
    ok: true,
    value: {
      claims: { lease_id: leaseIdClaim, job: jobClaim, limits: limitsClaim },
      kid,
      expEpochSeconds,
    },
  };
}
