/**
 * The runtime-side hosted-license client (D-14, LIC-01..03, LIC-05).
 *
 * `mintHeldLicense` is not exported from `@stint/core`'s root, so there is no
 * production path that turns a token received from a remote publisher into a
 * `HeldLicense`. This client is that path: it asks an injected
 * {@link LicenseIssuerTransport} for a raw token (the publisher is allowed to
 * emit raw strings on the wire), then `verifyLicense`s it against the PINNED
 * publisher public key BEFORE wrapping it via `mintHeldLicense`
 * (verify-then-mint, T-07-PASETO). The implicit assertion binds the token to
 * the lease id and spec version, so a token issued for a different lease is
 * refused and never minted.
 *
 * The client never trusts the publisher's clamp (LIC-03, T-07-CLOCK): it
 * computes `clampedLicenseExpiry` itself, returns `null` from `reissue`
 * without touching the transport once `now >= leaseExpiresAt`, and rejects a
 * token whose `exp` is later than the clamp it computed. It is I/O-free -- the
 * transport is injected -- and imports no test runner.
 *
 * Every failure throws a fixed-message error; the raw token is never
 * interpolated into an error (T-07-TOKENLOG).
 */

import type { PublicKey } from "paseto/v4/public";

import { mintHeldLicense } from "./held-license.js";
import type { HeldLicense } from "./held-license.js";
import type { LicenseClaims } from "./issue.js";
import { clampedLicenseExpiry, DEFAULT_LICENSE_TTL_SECONDS } from "./refresh.js";
import { verifyLicense } from "./verify.js";

/** The request body for a first issuance over the transport. */
export interface LicenseIssueRequest {
  readonly claims: LicenseClaims;
  readonly specVersion: string;
  readonly now: number;
  /** Already-clamped expiry (epoch seconds) the client computed. */
  readonly expEpochSeconds: number;
}

/** The request body for a refresh over the transport. */
export interface LicenseReissueRequest {
  readonly claims: LicenseClaims;
  readonly specVersion: string;
  readonly now: number;
  readonly leaseExpiresAt: number;
}

/**
 * Injected transport port. Raw token strings cross the wire -- the publisher
 * is allowed to emit them; the client verifies before it trusts them.
 */
export interface LicenseIssuerTransport {
  issue(req: LicenseIssueRequest): Promise<string>;
  /** Resolves `null` when the publisher refuses to refresh. */
  reissue(req: LicenseReissueRequest): Promise<string | null>;
  invalidate(leaseId: string): Promise<void>;
}

/** Options for {@link createLicenseIssuerClient}. */
export interface LicenseIssuerClientOptions {
  /** The publisher's pinned public key -- the only trust anchor. */
  readonly publicKey: PublicKey;
  readonly specVersion: string;
  readonly transport: LicenseIssuerTransport;
}

/** The runtime-side client: verify-then-mint `HeldLicense`s over an injected transport. */
export interface LicenseIssuerClient {
  issue(claims: LicenseClaims, now: number, leaseExpiresAt: number): Promise<HeldLicense>;
  reissue(claims: LicenseClaims, now: number, leaseExpiresAt: number): Promise<HeldLicense | null>;
  invalidate(leaseId: string): Promise<void>;
}

const LAPSED_MESSAGE = "License issuance refused: the lease has lapsed.";
const UNVERIFIED_MESSAGE = "License issuance refused: the received license failed verification.";

/** Creates the verify-then-mint hosted-license client. */
export function createLicenseIssuerClient(
  options: LicenseIssuerClientOptions,
): LicenseIssuerClient {
  const { publicKey, specVersion, transport } = options;

  async function verifyThenMint(
    token: string,
    claims: LicenseClaims,
    now: number,
    clampedExp: number,
  ): Promise<HeldLicense> {
    const verified = await verifyLicense(publicKey, token, claims.lease_id, specVersion, now);
    if (!verified.ok) throw new Error(UNVERIFIED_MESSAGE);
    // Never trust the publisher's clamp: a token outliving the lease (or the
    // default TTL) is refused even though its signature is valid (LIC-03).
    if (verified.value.expEpochSeconds > clampedExp) throw new Error(UNVERIFIED_MESSAGE);
    return mintHeldLicense(token);
  }

  async function issue(
    claims: LicenseClaims,
    now: number,
    leaseExpiresAt: number,
  ): Promise<HeldLicense> {
    const expEpochSeconds = clampedLicenseExpiry(now, DEFAULT_LICENSE_TTL_SECONDS, leaseExpiresAt);
    if (expEpochSeconds === null) throw new Error(LAPSED_MESSAGE);
    const token = await transport.issue({ claims, specVersion, now, expEpochSeconds });
    return verifyThenMint(token, claims, now, expEpochSeconds);
  }

  async function reissue(
    claims: LicenseClaims,
    now: number,
    leaseExpiresAt: number,
  ): Promise<HeldLicense | null> {
    const expEpochSeconds = clampedLicenseExpiry(now, DEFAULT_LICENSE_TTL_SECONDS, leaseExpiresAt);
    // Client-side clamp (LIC-03): refuse without asking the publisher.
    if (expEpochSeconds === null) return null;
    const token = await transport.reissue({ claims, specVersion, now, leaseExpiresAt });
    if (token === null) return null;
    return verifyThenMint(token, claims, now, expEpochSeconds);
  }

  function invalidate(leaseId: string): Promise<void> {
    return transport.invalidate(leaseId);
  }

  return { issue, reissue, invalidate };
}
