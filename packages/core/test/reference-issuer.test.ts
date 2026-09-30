import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { readLicenseToken } from "../src/license/held-license.js";
import type { LicenseClaims } from "../src/license/issue.js";
import { createReferenceLicenseIssuer } from "../src/license/reference-issuer.js";
import { verifyLicense } from "../src/license/verify.js";
import { createMockLicenseIssuer, MOCK_LICENSE_ISSUER_KID } from "../src/testing.js";

const LEASE_ID = "lease-01hqzz1test0000000000000010";
const SPEC_VERSION = "alp/0.1";

const claims: LicenseClaims = {
  lease_id: LEASE_ID,
  job: { description: "Reconcile invoices against bank statements." },
  limits: { max_actions: 50, actions_per_hour: 10 },
};

describe("createReferenceLicenseIssuer", () => {
  it("issues a license that verifies against its exposed publicKey", async () => {
    const { issuer, publicKey } = await createReferenceLicenseIssuer();
    const now = 1_700_000_000;
    const held = await issuer.issue(claims, SPEC_VERSION, now, now + 300);

    const result = await verifyLicense(
      publicKey,
      readLicenseToken(held),
      LEASE_ID,
      SPEC_VERSION,
      now,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kid).toBe(issuer.kid);
      expect(result.value.expEpochSeconds).toBe(now + 300);
    }
  });

  it("honours a caller-supplied kid", async () => {
    const { issuer, publicKey } = await createReferenceLicenseIssuer({ kid: "custom-kid" });
    const now = 1_700_000_000;
    const held = await issuer.issue(claims, SPEC_VERSION, now, now + 300);
    const result = await verifyLicense(
      publicKey,
      readLicenseToken(held),
      LEASE_ID,
      SPEC_VERSION,
      now,
    );
    expect(issuer.kid).toBe("custom-kid");
    expect(result.ok && result.value.kid).toBe("custom-kid");
  });

  it("reissue clamps to the lease and returns null once now >= leaseExpiresAt (LIC-03)", async () => {
    const { issuer, publicKey } = await createReferenceLicenseIssuer();
    const now = 1_700_000_000;
    const leaseExpiresAt = now + 100;

    const held = await issuer.reissue(claims, SPEC_VERSION, now, leaseExpiresAt);
    expect(held).not.toBeNull();
    if (held === null) return;
    const result = await verifyLicense(
      publicKey,
      readLicenseToken(held),
      LEASE_ID,
      SPEC_VERSION,
      now,
    );
    expect(result.ok && result.value.expEpochSeconds).toBe(leaseExpiresAt);

    expect(await issuer.reissue(claims, SPEC_VERSION, leaseExpiresAt, leaseExpiresAt)).toBeNull();
    expect(
      await issuer.reissue(claims, SPEC_VERSION, leaseExpiresAt + 1, leaseExpiresAt),
    ).toBeNull();
  });

  it("reissue refuses for an invalidated lease id (LIC-04)", async () => {
    const { issuer } = await createReferenceLicenseIssuer();
    const now = 1_700_000_000;
    await issuer.invalidate(LEASE_ID);
    expect(await issuer.reissue(claims, SPEC_VERSION, now, now + 1000)).toBeNull();
  });

  it("the mock issuer in @stint/core/testing delegates and keeps its fixed kid", async () => {
    const mock = await createMockLicenseIssuer();
    expect(mock.kid).toBe(MOCK_LICENSE_ISSUER_KID);
    const now = 1_700_000_000;
    const held = await mock.issue(claims, SPEC_VERSION, now, now + 300);
    const result = await verifyLicense(
      mock.publicKey,
      readLicenseToken(held),
      LEASE_ID,
      SPEC_VERSION,
      now,
    );
    expect(result.ok).toBe(true);
  });

  it("the reference-issuer and subpath barrel sources never import vitest (Pitfall 5)", () => {
    const files = [
      "../src/license/reference-issuer.ts",
      "../src/license/license-issuer-client.ts",
      "../src/license-issuer.ts",
    ];
    for (const relative of files) {
      const text = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
      expect(text).not.toMatch(/from\s+["']vitest["']/);
      expect(text).not.toMatch(/import\s*\(\s*["']vitest["']/);
    }
  });
});
