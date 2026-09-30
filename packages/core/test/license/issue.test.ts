import { describe, expect, it } from "vitest";

import { PublicProtocol } from "paseto";
import { GenerateKeyPairFactory } from "paseto/v4/public";

import { deriveImplicitAssertion } from "../../src/license/implicit-assertion.js";
import { issueLicense } from "../../src/license/issue.js";
import type { LicenseClaims } from "../../src/license/issue.js";
import { verifyLicense } from "../../src/license/verify.js";

const keyPairProtocol = new PublicProtocol(GenerateKeyPairFactory);

async function generateTestKeyPair() {
  return keyPairProtocol.GenerateKeyPair({ extractable: true });
}

const TEST_LEASE_ID = "lease-01hqzz1test0000000000000001";
const TEST_SPEC_VERSION = "alp/0.1";

const testClaims: LicenseClaims = {
  lease_id: TEST_LEASE_ID,
  job: { description: "Reconcile invoices against bank statements." },
  limits: { max_actions: 50, actions_per_hour: 10 },
};

describe("deriveImplicitAssertion", () => {
  it("returns identical bytes for identical inputs", () => {
    const a = deriveImplicitAssertion(TEST_LEASE_ID, TEST_SPEC_VERSION);
    const b = deriveImplicitAssertion(TEST_LEASE_ID, TEST_SPEC_VERSION);
    expect(a).toEqual(b);
  });

  it("differs when leaseId changes", () => {
    const a = deriveImplicitAssertion(TEST_LEASE_ID, TEST_SPEC_VERSION);
    const b = deriveImplicitAssertion("lease-different", TEST_SPEC_VERSION);
    expect(a).not.toEqual(b);
  });

  it("differs when specVersion changes", () => {
    const a = deriveImplicitAssertion(TEST_LEASE_ID, TEST_SPEC_VERSION);
    const b = deriveImplicitAssertion(TEST_LEASE_ID, "alp/9.9");
    expect(a).not.toEqual(b);
  });
});

describe("issueLicense / verifyLicense round trip", () => {
  it("verifies with the matching public key, returning the same custom claims and footer kid", async () => {
    const { secretKey, publicKey } = await generateTestKeyPair();
    const now = 1_700_000_000;
    const expEpochSeconds = now + 300;

    const token = await issueLicense(
      secretKey,
      testClaims,
      "publisher-key-1",
      TEST_SPEC_VERSION,
      now,
      expEpochSeconds,
    );

    const result = await verifyLicense(publicKey, token, TEST_LEASE_ID, TEST_SPEC_VERSION, now);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kid).toBe("publisher-key-1");
      expect(result.value.claims.lease_id).toBe(TEST_LEASE_ID);
      expect(result.value.claims.job).toEqual(testClaims.job);
      expect(result.value.claims.limits).toEqual(testClaims.limits);
    }
  });

  it("the issued token's exp decodes to exactly the clamped expEpochSeconds", async () => {
    const { secretKey, publicKey } = await generateTestKeyPair();
    const now = 1_700_000_000;
    const expEpochSeconds = now + 300;

    const token = await issueLicense(
      secretKey,
      testClaims,
      "publisher-key-1",
      TEST_SPEC_VERSION,
      now,
      expEpochSeconds,
    );

    const result = await verifyLicense(publicKey, token, TEST_LEASE_ID, TEST_SPEC_VERSION, now);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.expEpochSeconds).toBe(expEpochSeconds);
    }
  });
});
