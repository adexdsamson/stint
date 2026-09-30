import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { generateKeyPair, importJWK } from "jose";
import type { CryptoKey, JWK } from "jose";
import { PublicProtocol } from "paseto";
import { PublicKeyFromCryptoKey, SecretKeyFromCryptoKey, SignFactory } from "paseto/v4/public";
import type { PublicKey } from "paseto/v4/public";

import { verifyLicense, LICENSE_CLOCK_SKEW_SECONDS } from "../../src/license/verify.js";
import { LICENSE_VERIFY_REASONS } from "../../src/license/errors.js";
import { deriveImplicitAssertion } from "../../src/license/implicit-assertion.js";

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

/** Flips one base64url character of the token's payload segment (message+signature), corrupting the signature bytes without altering the token's overall shape. */
function tamperSignature(token: string): string {
  const parts = token.split(".");
  const payload = parts[2];
  if (payload === undefined || payload.length === 0) {
    throw new Error("token must have a non-empty payload segment");
  }
  const lastChar = payload.at(-1) as string;
  const replacement = lastChar === "A" ? "B" : "A";
  parts[2] = payload.slice(0, -1) + replacement;
  return parts.join(".");
}

describe("D-14: explicit clock-skew boundary", () => {
  it("verifying 1s before exp passes", async () => {
    const claimsVector = loadClaimsVector();
    const publicKey = await loadVectorPublicKey();
    const token = readVector("valid-token.txt").trim();

    const result = await verifyLicense(
      publicKey,
      token,
      claimsVector.lease_id,
      claimsVector.spec_version,
      claimsVector.exp_epoch_seconds - 1,
    );

    expect(result.ok).toBe(true);
  });

  it("verifying just inside the skew window (exp + skew - 1) passes", async () => {
    const claimsVector = loadClaimsVector();
    const publicKey = await loadVectorPublicKey();
    const token = readVector("valid-token.txt").trim();

    const result = await verifyLicense(
      publicKey,
      token,
      claimsVector.lease_id,
      claimsVector.spec_version,
      claimsVector.exp_epoch_seconds + LICENSE_CLOCK_SKEW_SECONDS - 1,
    );

    expect(result.ok).toBe(true);
  });

  it("verifying beyond the skew window (exp + skew + 1) fails with the claim-validation code", async () => {
    const claimsVector = loadClaimsVector();
    const publicKey = await loadVectorPublicKey();
    const token = readVector("valid-token.txt").trim();

    const result = await verifyLicense(
      publicKey,
      token,
      claimsVector.lease_id,
      claimsVector.spec_version,
      claimsVector.exp_epoch_seconds + LICENSE_CLOCK_SKEW_SECONDS + 1,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.reason).toBe("license_claim_invalid");
    }
  });
});

describe("WR-01: verifyLicense cross-checks claims.lease_id against the leaseId parameter directly", () => {
  it("rejects a token whose implicit assertion matches leaseId but whose lease_id claim names a different lease (non-conforming issuer)", async () => {
    const claimsVector = loadClaimsVector();
    const realLeaseId = claimsVector.lease_id;
    const otherLeaseId = `${realLeaseId}-different-lease`;

    const { publicKey: cryptoPublicKey, privateKey: cryptoPrivateKey } = await generateKeyPair(
      "EdDSA",
      { crv: "Ed25519", extractable: true },
    );
    const secretKey = await SecretKeyFromCryptoKey(cryptoPrivateKey);
    const publicKey = await PublicKeyFromCryptoKey(cryptoPublicKey);

    // The implicit assertion is derived from the REAL leaseId -- exactly
    // what a conforming verifier expects -- but the signed payload's
    // `lease_id` claim names a DIFFERENT lease. This simulates a
    // non-conforming `LicenseIssuer` (an injectable port) that does not
    // derive its implicit assertion from `claims.lease_id` the way the
    // reference `issueLicense` does. Before WR-01's direct check, this
    // token would verify successfully against `realLeaseId` even though
    // its own `claims.lease_id` disagrees.
    const implicitAssertion = deriveImplicitAssertion(realLeaseId, claimsVector.spec_version);
    const nowDate = new Date(claimsVector.now * 1000);
    const exp = new Date(claimsVector.exp_epoch_seconds * 1000).toISOString();

    const signProtocol = new PublicProtocol(SignFactory);
    const token = await signProtocol.Sign(
      secretKey,
      {
        lease_id: otherLeaseId,
        job: claimsVector.job,
        limits: claimsVector.limits,
        exp,
        nbf: nowDate.toISOString(),
        jti: crypto.randomUUID(),
      },
      {
        now: nowDate,
        addIssuedAt: true,
        footer: new TextEncoder().encode(JSON.stringify({ kid: claimsVector.kid })),
        implicitAssertion,
      },
    );

    const result = await verifyLicense(
      publicKey,
      token,
      realLeaseId,
      claimsVector.spec_version,
      claimsVector.now,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.reason).toBe("license_claim_invalid");
    }
  });
});

describe("D-16: tampered signature and sanitized error messages", () => {
  it("a tampered signature fails with the invalid-signature code", async () => {
    const claimsVector = loadClaimsVector();
    const publicKey = await loadVectorPublicKey();
    const token = tamperSignature(readVector("valid-token.txt").trim());

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

  it("every rejection reason is one of the fixed strings and contains no substring of the input token", async () => {
    const claimsVector = loadClaimsVector();
    const publicKey = await loadVectorPublicKey();
    const validToken = readVector("valid-token.txt").trim();
    const wrongLeaseToken = readVector("invalid-wrong-lease.txt").trim();
    const tamperedToken = tamperSignature(validToken);

    const cases = [
      { token: wrongLeaseToken, now: claimsVector.now },
      { token: tamperedToken, now: claimsVector.now },
      { token: validToken, now: claimsVector.exp_epoch_seconds + LICENSE_CLOCK_SKEW_SECONDS + 1 },
    ];

    for (const { token, now } of cases) {
      const result = await verifyLicense(publicKey, token, claimsVector.lease_id, claimsVector.spec_version, now);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const reason = result.errors[0]?.reason;
        expect(reason).toBeDefined();
        expect(LICENSE_VERIFY_REASONS).toContain(reason);
        // The reason is drawn from a small fixed English vocabulary; it can
        // never legitimately contain a fragment of a base64url PASETO token,
        // but assert it explicitly so a future refactor cannot silently
        // start interpolating token/claim material into the reason (D-16).
        const tokenFragment = token.slice(20, 40);
        expect(reason).not.toContain(tokenFragment);
      }
    }
  });
});
