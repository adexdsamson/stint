import { describe, expect, it } from "vitest";

import { needsRefresh, clampedLicenseExpiry, DEFAULT_LICENSE_TTL_SECONDS } from "../../src/license/refresh.js";
import { createMockLicenseIssuer } from "../../src/testing.js";
import { readLicenseToken } from "../../src/license/held-license.js";
import { verifyLicense } from "../../src/license/verify.js";
import type { LicenseClaims } from "../../src/license/issue.js";

const TEST_LEASE_ID = "lease-01hqzz1test0000000000000002";
const TEST_SPEC_VERSION = "alp/0.1";

const testClaims: LicenseClaims = {
  lease_id: TEST_LEASE_ID,
  job: { description: "Reconcile invoices against bank statements." },
  limits: { max_actions: 50, actions_per_hour: 10 },
};

describe("needsRefresh", () => {
  it("is false while now is more than refreshBeforeSeconds away from exp", () => {
    expect(needsRefresh(1000, 500, 60)).toBe(false);
  });

  it("is true exactly at the boundary (now === exp - refreshBeforeSeconds)", () => {
    expect(needsRefresh(1000, 940, 60)).toBe(true);
  });

  it("is true once now has passed the boundary", () => {
    expect(needsRefresh(1000, 999, 60)).toBe(true);
  });

  it("holds no state between calls -- repeated calls with the same stale exp keep answering true", () => {
    expect(needsRefresh(1000, 1500, 60)).toBe(true);
    expect(needsRefresh(1000, 1500, 60)).toBe(true);
  });
});

describe("clampedLicenseExpiry", () => {
  it("returns now + defaultTtlSeconds when that is before leaseExpiresAt", () => {
    expect(clampedLicenseExpiry(1000, 300, 999_999)).toBe(1300);
  });

  it("clamps to leaseExpiresAt when now + defaultTtlSeconds would exceed it", () => {
    expect(clampedLicenseExpiry(1000, 300, 1200)).toBe(1200);
  });

  it("refuses refresh (returns null) once now === leaseExpiresAt", () => {
    expect(clampedLicenseExpiry(1200, 300, 1200)).toBeNull();
  });

  it("refuses refresh (returns null) once now is past leaseExpiresAt", () => {
    expect(clampedLicenseExpiry(1300, 300, 1200)).toBeNull();
  });
});

describe("end-to-end refresh through the mock LicenseIssuer", () => {
  it("a refreshed token's verified exp is clamped to leaseExpiresAt when the lease ends first", async () => {
    const issuer = await createMockLicenseIssuer();
    const now = 1_700_000_000;
    const leaseExpiresAt = now + 100; // less than DEFAULT_LICENSE_TTL_SECONDS (300)

    const held = await issuer.reissue(testClaims, TEST_SPEC_VERSION, now, leaseExpiresAt);
    expect(held).not.toBeNull();

    const token = readLicenseToken(held as NonNullable<typeof held>);
    const result = await verifyLicense(issuer.publicKey, token, TEST_LEASE_ID, TEST_SPEC_VERSION, now);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.expEpochSeconds).toBe(leaseExpiresAt);
      expect(result.value.expEpochSeconds).toBeLessThanOrEqual(leaseExpiresAt);
    }
  });

  it("a refreshed token's expiry is the default TTL when the lease outlives it", async () => {
    const issuer = await createMockLicenseIssuer();
    const now = 1_700_000_000;
    const leaseExpiresAt = now + 10_000; // far beyond DEFAULT_LICENSE_TTL_SECONDS

    const held = await issuer.reissue(testClaims, TEST_SPEC_VERSION, now, leaseExpiresAt);
    expect(held).not.toBeNull();

    const token = readLicenseToken(held as NonNullable<typeof held>);
    const result = await verifyLicense(issuer.publicKey, token, TEST_LEASE_ID, TEST_SPEC_VERSION, now);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.expEpochSeconds).toBe(now + DEFAULT_LICENSE_TTL_SECONDS);
    }
  });

  it("refuses reissue once now >= leaseExpiresAt -- no refreshed token can ever outlive the lease", async () => {
    const issuer = await createMockLicenseIssuer();
    const now = 1_700_000_000;
    const leaseExpiresAt = now;

    const held = await issuer.reissue(testClaims, TEST_SPEC_VERSION, now, leaseExpiresAt);
    expect(held).toBeNull();
  });
});

describe("LicenseIssuer.invalidate (LIC-04, D-21)", () => {
  it("refuses reissue for a lease after invalidate -- returns null, no background loop", async () => {
    const issuer = await createMockLicenseIssuer();
    const now = 1_700_000_000;
    const leaseExpiresAt = now + 10_000; // far beyond DEFAULT_LICENSE_TTL_SECONDS

    await issuer.invalidate(TEST_LEASE_ID);
    const held = await issuer.reissue(testClaims, TEST_SPEC_VERSION, now, leaseExpiresAt);

    expect(held).toBeNull();
  });

  it("invalidate for an unknown lease resolves without throwing (idempotent no-op)", async () => {
    const issuer = await createMockLicenseIssuer();

    await expect(issuer.invalidate("lease-never-seen")).resolves.toBeUndefined();
  });
});
