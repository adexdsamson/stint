import { describe, expect, it } from "vitest";

import { hashManifest } from "../src/canonical.js";
import { verifyEnvelope } from "../src/envelope.js";
import { JWS_PROTECTED_B64, JWS_PROTECTED_HEADER } from "../src/jws.js";
import { signManifestForTest } from "../src/testing.js";
import * as specIndex from "../src/index.js";
import { paymentReconcilerManifest } from "./fixtures.js";

describe("sign and verify", () => {
  it("payment-reconciler round trip yields VerifiedManifest", async () => {
    const manifest = paymentReconcilerManifest();
    const { envelope, trustStore } = await signManifestForTest(manifest);

    const result = await verifyEnvelope(envelope, trustStore);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.contentHash).toMatch(/^jcs-sha256:[0-9a-f]{64}$/);
      expect(result.value.publisherId).toBe("reconciler-labs.example");
      expect(result.value.manifest).toEqual(manifest);
      expect(hashManifest(result.value.manifest)).toBe(result.value.contentHash);
    }
  });

  it("tampered manifest is rejected with invalid_signature", async () => {
    const manifest = paymentReconcilerManifest();
    const { envelope, trustStore } = await signManifestForTest(manifest);

    const tampered = {
      ...envelope,
      manifest: { ...envelope.manifest, limits: { ...(envelope.manifest.limits as object), max_actions: 999_999 } },
    };

    const result = await verifyEnvelope(tampered, trustStore);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([{ path: "/signature/sig", code: "invalid_signature", message: expect.any(String) as string }]);
    }
  });

  it("protected header is the shared constant", async () => {
    const manifest = paymentReconcilerManifest();
    const { envelope, trustStore } = await signManifestForTest(manifest);

    const result = await verifyEnvelope(envelope, trustStore);
    expect(result.ok).toBe(true);

    expect(JWS_PROTECTED_B64).toBe(Buffer.from(JSON.stringify(JWS_PROTECTED_HEADER), "utf8").toString("base64url"));
  });

  it("public entry exposes no signing helper", () => {
    const namespace = specIndex as unknown as Record<string, unknown>;
    expect(namespace.signManifestForTest).toBeUndefined();
    expect(namespace.signEnvelopeWithKey).toBeUndefined();
    expect(namespace.importTestSigningKey).toBeUndefined();
    expect(namespace.signDetached).toBeUndefined();
  });

  it("verifyEnvelope takes exactly two parameters (no option that skips verification, D-07)", () => {
    expect(verifyEnvelope.length).toBe(2);
  });
});
