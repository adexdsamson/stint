import { describe, expect, it, vi } from "vitest";

import { readLicenseToken } from "../src/license/held-license.js";
import type { LicenseClaims } from "../src/license/issue.js";
import { createLicenseIssuerClient } from "../src/license/license-issuer-client.js";
import type { LicenseIssuerTransport } from "../src/license/license-issuer-client.js";
import { createReferenceLicenseIssuer } from "../src/license/reference-issuer.js";
import { verifyLicense } from "../src/license/verify.js";

const LEASE_ID = "lease-01hqzz1test0000000000000020";
const OTHER_LEASE_ID = "lease-01hqzz1test0000000000000021";
const SPEC_VERSION = "alp/0.1";
const NOW = 1_700_000_000;

function claimsFor(leaseId: string): LicenseClaims {
  return {
    lease_id: leaseId,
    job: { description: "Reconcile invoices against bank statements." },
    limits: { max_actions: 50, actions_per_hour: 10 },
  };
}

/** A transport wrapping the reference issuer, emitting the raw token like a remote publisher would. */
async function makeTransport(override?: {
  issue?: LicenseIssuerTransport["issue"];
  reissue?: LicenseIssuerTransport["reissue"];
}) {
  const { issuer, publicKey } = await createReferenceLicenseIssuer();
  const transport: LicenseIssuerTransport = {
    issue:
      override?.issue ??
      (async (req) =>
        readLicenseToken(
          await issuer.issue(req.claims, req.specVersion, req.now, req.expEpochSeconds),
        )),
    reissue:
      override?.reissue ??
      (async (req) => {
        const held = await issuer.reissue(req.claims, req.specVersion, req.now, req.leaseExpiresAt);
        return held === null ? null : readLicenseToken(held);
      }),
    invalidate: (leaseId) => issuer.invalidate(leaseId),
  };
  return { issuer, publicKey, transport };
}

describe("createLicenseIssuerClient", () => {
  it("verifies a correctly-bound token and mints a HeldLicense that round-trips", async () => {
    const { publicKey, transport } = await makeTransport();
    const client = createLicenseIssuerClient({ publicKey, specVersion: SPEC_VERSION, transport });

    const held = await client.issue(claimsFor(LEASE_ID), NOW, NOW + 1000);
    const token = readLicenseToken(held);
    const result = await verifyLicense(publicKey, token, LEASE_ID, SPEC_VERSION, NOW);
    expect(result.ok).toBe(true);
  });

  it("refuses a token minted for a DIFFERENT lease id, with a fixed message that never echoes the token", async () => {
    const { issuer, publicKey } = await makeTransport();
    let leakedToken = "";
    const transport: LicenseIssuerTransport = {
      issue: async (req) => {
        // A publisher (mis)behaving: signs for a different lease than requested.
        const held = await issuer.issue(
          claimsFor(OTHER_LEASE_ID),
          req.specVersion,
          req.now,
          req.expEpochSeconds,
        );
        leakedToken = readLicenseToken(held);
        return leakedToken;
      },
      reissue: () => Promise.resolve(null),
      invalidate: () => Promise.resolve(),
    };
    const client = createLicenseIssuerClient({ publicKey, specVersion: SPEC_VERSION, transport });

    const attempt = client.issue(claimsFor(LEASE_ID), NOW, NOW + 1000);
    await expect(attempt).rejects.toThrow(
      "License issuance refused: the received license failed verification.",
    );
    const error = (await attempt.catch((e: unknown) => e)) as Error;
    expect(leakedToken.length).toBeGreaterThan(0);
    expect(error.message).not.toContain(leakedToken);
  });

  it("refuses a token signed by a key other than the pinned publisher key", async () => {
    const { transport } = await makeTransport();
    const { publicKey: otherKey } = await createReferenceLicenseIssuer();
    const client = createLicenseIssuerClient({
      publicKey: otherKey,
      specVersion: SPEC_VERSION,
      transport,
    });
    await expect(client.issue(claimsFor(LEASE_ID), NOW, NOW + 1000)).rejects.toThrow(
      /failed verification/,
    );
  });

  it("does not trust the publisher's clamp: a validly-signed token outliving the lease is refused", async () => {
    const { issuer, publicKey } = await makeTransport();
    const transport: LicenseIssuerTransport = {
      // Ignores the requested expiry and signs a far-future one.
      issue: async (req) =>
        readLicenseToken(await issuer.issue(req.claims, req.specVersion, req.now, NOW + 100_000)),
      reissue: async (req) =>
        readLicenseToken(await issuer.issue(req.claims, req.specVersion, req.now, NOW + 100_000)),
      invalidate: () => Promise.resolve(),
    };
    const client = createLicenseIssuerClient({ publicKey, specVersion: SPEC_VERSION, transport });

    await expect(client.issue(claimsFor(LEASE_ID), NOW, NOW + 1000)).rejects.toThrow(
      /failed verification/,
    );
    await expect(client.reissue(claimsFor(LEASE_ID), NOW, NOW + 1000)).rejects.toThrow(
      /failed verification/,
    );
  });

  it("issue throws a fixed lapsed message once now >= leaseExpiresAt, without calling the transport", async () => {
    const issueSpy = vi.fn<LicenseIssuerTransport["issue"]>();
    const { publicKey, transport } = await makeTransport({ issue: issueSpy });
    const client = createLicenseIssuerClient({ publicKey, specVersion: SPEC_VERSION, transport });

    await expect(client.issue(claimsFor(LEASE_ID), NOW, NOW)).rejects.toThrow(
      "License issuance refused: the lease has lapsed.",
    );
    expect(issueSpy).not.toHaveBeenCalled();
  });

  it("reissue returns null past leaseExpiresAt WITHOUT hitting the transport (client-side clamp)", async () => {
    const reissueSpy = vi.fn<LicenseIssuerTransport["reissue"]>();
    const { publicKey, transport } = await makeTransport({ reissue: reissueSpy });
    const client = createLicenseIssuerClient({ publicKey, specVersion: SPEC_VERSION, transport });

    expect(await client.reissue(claimsFor(LEASE_ID), NOW + 1000, NOW + 1000)).toBeNull();
    expect(await client.reissue(claimsFor(LEASE_ID), NOW + 2000, NOW + 1000)).toBeNull();
    expect(reissueSpy).not.toHaveBeenCalled();
  });

  it("reissue verifies-then-mints a clamped token while the lease is live", async () => {
    const { publicKey, transport } = await makeTransport();
    const client = createLicenseIssuerClient({ publicKey, specVersion: SPEC_VERSION, transport });

    const held = await client.reissue(claimsFor(LEASE_ID), NOW, NOW + 100);
    expect(held).not.toBeNull();
    if (held === null) return;
    const result = await verifyLicense(
      publicKey,
      readLicenseToken(held),
      LEASE_ID,
      SPEC_VERSION,
      NOW,
    );
    expect(result.ok && result.value.expEpochSeconds).toBe(NOW + 100);
  });

  it("reissue returns null when the publisher refuses, and invalidate delegates to the transport", async () => {
    const invalidate = vi.fn<LicenseIssuerTransport["invalidate"]>(() => Promise.resolve());
    const { publicKey } = await makeTransport();
    const transport: LicenseIssuerTransport = {
      issue: () => Promise.resolve("unused"),
      reissue: () => Promise.resolve(null),
      invalidate,
    };
    const client = createLicenseIssuerClient({ publicKey, specVersion: SPEC_VERSION, transport });

    expect(await client.reissue(claimsFor(LEASE_ID), NOW, NOW + 1000)).toBeNull();
    await client.invalidate(LEASE_ID);
    expect(invalidate).toHaveBeenCalledWith(LEASE_ID);
  });

  it("a token issued for another spec version is refused", async () => {
    // Guards the implicit-assertion binding the client relies on.
    const { issuer, publicKey } = await makeTransport();
    const transport: LicenseIssuerTransport = {
      issue: async (req) =>
        readLicenseToken(await issuer.issue(req.claims, "alp/9.9", req.now, req.expEpochSeconds)),
      reissue: () => Promise.resolve(null),
      invalidate: () => Promise.resolve(),
    };
    const client = createLicenseIssuerClient({ publicKey, specVersion: SPEC_VERSION, transport });
    await expect(client.issue(claimsFor(LEASE_ID), NOW, NOW + 1000)).rejects.toThrow(
      /failed verification/,
    );
  });
});
