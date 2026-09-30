/**
 * The CLI's HTTP implementation of core's `LicenseIssuerTransport`, plus the
 * helpers `create` and teardown share to talk to a publisher (D-14, D-18).
 *
 * Wire protocol (publisher side, all `POST` with a JSON body; the publisher is
 * allowed to emit the raw license string, the runtime-side client verifies it
 * before trusting it):
 *
 *   issue_url       { claims, spec_version, now, exp }          -> 2xx { license: string }
 *   reissue_url     { claims, spec_version, now, lease_expires_at }
 *                                                                -> 2xx { license: string | null }
 *   invalidate_url  { lease_id }                                 -> 2xx (body ignored)
 *
 * `{ license: null }` from reissue means the publisher declines to refresh. Any
 * non-2xx, unreachable publisher, redirect, timeout or malformed body is a
 * FIXED-message error: the response body, status text, URL and the token itself
 * are never interpolated (T-07-TOKENLOG). The license is never logged here.
 */

import type { LicenseClaims } from "@stint/core";
import type { LicenseIssuerClient, LicenseIssuerTransport } from "@stint/core/license-issuer";
import { createLicenseIssuerClient, importLicensePublicKey } from "@stint/core/license-issuer";
import type { Manifest } from "@stint/spec";

import type { PublisherBinding } from "../store/publisher-binding.js";

/** Client-side budget for one publisher call. */
export const PUBLISHER_TIMEOUT_MS = 10_000;

const UNREACHABLE = "The publisher could not be reached.";
const REFUSED = "The publisher refused the request.";
const BAD_RESPONSE = "The publisher returned an unexpected response.";

type FetchFn = typeof fetch;

async function post(url: string, body: unknown, fetchFn: FetchFn): Promise<Response> {
  let response: Response;
  try {
    response = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      // A publisher redirecting us elsewhere is never followed.
      redirect: "error",
      signal: AbortSignal.timeout(PUBLISHER_TIMEOUT_MS),
    });
  } catch {
    throw new Error(UNREACHABLE);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(REFUSED);
  }
  return response;
}

async function readLicenseField(response: Response): Promise<string | null> {
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new Error(BAD_RESPONSE);
  }
  if (typeof parsed !== "object" || parsed === null || !("license" in parsed)) {
    throw new Error(BAD_RESPONSE);
  }
  const { license } = parsed;
  if (license === null) return null;
  if (typeof license !== "string" || license === "") throw new Error(BAD_RESPONSE);
  return license;
}

/** Builds the HTTP `LicenseIssuerTransport` for a persisted publisher binding. */
export function httpIssuerTransport(
  binding: PublisherBinding,
  fetchFn: FetchFn = fetch,
): LicenseIssuerTransport {
  return {
    async issue(req) {
      const response = await post(
        binding.issue_url,
        {
          claims: req.claims,
          spec_version: req.specVersion,
          now: req.now,
          exp: req.expEpochSeconds,
        },
        fetchFn,
      );
      const license = await readLicenseField(response);
      if (license === null) throw new Error(BAD_RESPONSE);
      return license;
    },
    async reissue(req) {
      const response = await post(
        binding.reissue_url,
        {
          claims: req.claims,
          spec_version: req.specVersion,
          now: req.now,
          lease_expires_at: req.leaseExpiresAt,
        },
        fetchFn,
      );
      return readLicenseField(response);
    },
    async invalidate(leaseId) {
      const response = await post(binding.invalidate_url, { lease_id: leaseId }, fetchFn);
      await response.body?.cancel().catch(() => undefined);
    },
  };
}

/** Builds the verify-then-mint client pinned to the binding's publisher key. */
export async function createPublisherClient(
  binding: PublisherBinding,
  specVersion: string,
  fetchFn: FetchFn = fetch,
): Promise<LicenseIssuerClient> {
  return createLicenseIssuerClient({
    publicKey: await importLicensePublicKey(binding.license_public_key),
    specVersion,
    transport: httpIssuerTransport(binding, fetchFn),
  });
}

/** The claims a license carries, derived from the verified manifest (D-13): job description and entitlement limits. */
export function licenseClaimsFromManifest(leaseId: string, manifest: Manifest): LicenseClaims {
  return {
    lease_id: leaseId,
    job: { description: manifest.job.description },
    limits: {
      max_actions: manifest.limits.max_actions,
      actions_per_hour: manifest.limits.actions_per_hour ?? null,
    },
  };
}
