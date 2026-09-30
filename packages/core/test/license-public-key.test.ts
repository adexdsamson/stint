import { describe, expect, it } from "vitest";

import { readLicenseToken } from "../src/license/held-license.js";
import type { LicenseClaims } from "../src/license/issue.js";
import {
  exportLicensePublicKey,
  importLicensePublicKey,
  isPublicPaserk,
} from "../src/license/public-key.js";
import { createReferenceLicenseIssuer } from "../src/license/reference-issuer.js";
import { verifyLicense } from "../src/license/verify.js";

const claims: LicenseClaims = {
  lease_id: "lease-01hqzz1test0000000000000011",
  job: { description: "Reconcile invoices." },
  limits: { max_actions: 5, actions_per_hour: null },
};

describe("license public-key PASERK helpers", () => {
  it("round-trips a publisher key: export -> import verifies what the issuer signed", async () => {
    const { issuer, publicKey } = await createReferenceLicenseIssuer();
    const paserk = await exportLicensePublicKey(publicKey);
    expect(paserk.startsWith("k4.public.")).toBe(true);
    expect(isPublicPaserk(paserk)).toBe(true);

    const imported = await importLicensePublicKey(paserk);
    const now = 1_700_000_000;
    const held = await issuer.issue(claims, "alp/0.1", now, now + 300);
    const verified = await verifyLicense(
      imported,
      readLicenseToken(held),
      claims.lease_id,
      "alp/0.1",
      now,
    );
    expect(verified.ok).toBe(true);
  });

  it.each(["", "k4.public.", "k4.secret.AAAA", "not a paserk", "k4.public.!!!notbase64!!!"])(
    "refuses %j with a fixed message that does not echo the input",
    async (bad) => {
      const error: unknown = await importLicensePublicKey(bad).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("The license public key is not a valid PASERK.");
    },
  );
});
