import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { importJWK } from "jose";
import type { JWK } from "jose";
import { PublicKeyFromCryptoKey } from "paseto/v4/public";
import type { PublicKey } from "paseto/v4/public";

import { verifyLicense } from "../../src/license/verify.js";

// packages/core/test/license -> packages/core/test -> packages/core -> packages -> repo root
const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, "..", "..", "..", "..");
const vectorsDir = path.join(repoRoot, "spec", "vectors", "license");

function readVector(name: string): string {
  return readFileSync(path.join(vectorsDir, name), "utf8");
}

interface LicensePublicKeyJwk {
  readonly kid: string;
  readonly kty: string;
  readonly crv: string;
  readonly x: string;
}

interface LicenseClaimsVector {
  readonly lease_id: string;
  readonly spec_version: string;
  readonly job: { readonly description: string };
  readonly limits: { readonly max_actions: number; readonly actions_per_hour: number | null };
  readonly now: number;
  readonly exp_epoch_seconds: number;
  readonly kid: string;
}

function loadClaimsVector(): LicenseClaimsVector {
  return JSON.parse(readVector("claims.json")) as LicenseClaimsVector;
}

function loadPublicKeyJwk(): LicensePublicKeyJwk {
  return JSON.parse(readVector("public-key.jwk.json")) as LicensePublicKeyJwk;
}

async function loadVectorPublicKey(): Promise<PublicKey> {
  const raw = loadPublicKeyJwk();
  const jwk: JWK = { kty: raw.kty, crv: raw.crv, x: raw.x };
  const cryptoKey = (await importJWK(jwk, "EdDSA")) as CryptoKey;
  return PublicKeyFromCryptoKey(cryptoKey);
}

describe("golden vector: spec/vectors/license/", () => {
  it("verifyLicense accepts the pinned valid-token.txt vector against public-key.jwk.json", async () => {
    const claimsVector = loadClaimsVector();
    const publicKey = await loadVectorPublicKey();
    const token = readVector("valid-token.txt").trim();

    const result = await verifyLicense(
      publicKey,
      token,
      claimsVector.lease_id,
      claimsVector.spec_version,
      claimsVector.now,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kid).toBe(claimsVector.kid);
      expect(result.value.claims.lease_id).toBe(claimsVector.lease_id);
      expect(result.value.claims.job).toEqual(claimsVector.job);
      expect(result.value.claims.limits).toEqual(claimsVector.limits);
      expect(result.value.expEpochSeconds).toBe(claimsVector.exp_epoch_seconds);
    }
  });

  it("verifyLicense rejects invalid-wrong-lease.txt with a fixed code, never the paseto message", async () => {
    const claimsVector = loadClaimsVector();
    const publicKey = await loadVectorPublicKey();
    const token = readVector("invalid-wrong-lease.txt").trim();

    // Verified against the SAME lease id the valid vector uses -- this token
    // was issued for a different lease, so its implicit assertion cannot match.
    const result = await verifyLicense(
      publicKey,
      token,
      claimsVector.lease_id,
      claimsVector.spec_version,
      claimsVector.now,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.reason).toBe("license_invalid_signature");
    }
  });
});
