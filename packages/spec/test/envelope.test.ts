import { describe, expect, it } from "vitest";

import { hashManifest } from "../src/canonical.js";
import { MAX_ENVELOPE_BYTES, parseEnvelope, verifyEnvelope } from "../src/envelope.js";
import type { TrustStore } from "../src/envelope.js";
import { JWS_PROTECTED_B64, JWS_PROTECTED_HEADER } from "../src/jws.js";
import { signEnvelopeWithKey, signManifestForTest } from "../src/testing.js";
import * as specIndex from "../src/index.js";
import { cloneManifest, paymentReconcilerManifest, withoutMode } from "./fixtures.js";

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

describe("rejects", () => {
  it("oversized envelope: envelope_too_large before parsing", () => {
    const padding = "a".repeat(MAX_ENVELOPE_BYTES + 10);
    const raw = `{"padding":"${padding}"}`;

    const result = parseEnvelope(raw);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([{ path: "", code: "envelope_too_large", message: expect.any(String) as string }]);
    }
  });

  it("invalid JSON: invalid_json with a message that does not contain the raw text", () => {
    const raw = "{not valid json, definitely-not-in-the-message";

    const result = parseEnvelope(raw);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([{ path: "", code: "invalid_json", message: expect.any(String) as string }]);
      expect(result.errors[0]?.message).not.toContain("definitely-not-in-the-message");
    }
  });

  it("envelope without signature: missing_required at /signature (no unsigned path, D-07)", async () => {
    const result = await verifyEnvelope({ manifest: paymentReconcilerManifest() }, {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([{ path: "/signature", code: "missing_required", message: expect.any(String) as string }]);
    }
  });

  it("non-EdDSA alg: unsupported_algorithm at /signature/alg", async () => {
    const manifest = paymentReconcilerManifest();
    const envelope = { manifest, signature: { alg: "RS256", kid: "x", sig: "y".repeat(86) } };

    const result = await verifyEnvelope(envelope, {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([
        { path: "/signature/alg", code: "unsupported_algorithm", message: expect.any(String) as string, allowed: ["EdDSA"] },
      ]);
    }
  });

  it("unknown publisher: unknown_publisher at /manifest/publisher/id", async () => {
    const manifest = paymentReconcilerManifest();
    const { envelope } = await signManifestForTest(manifest);

    const result = await verifyEnvelope(envelope, {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([
        { path: "/manifest/publisher/id", code: "unknown_publisher", message: expect.any(String) as string },
      ]);
    }
  });

  it("unknown kid: unknown_key at /signature/kid", async () => {
    const manifest = paymentReconcilerManifest();
    const { envelope, trustStore } = await signManifestForTest(manifest, { kid: "key-a" });
    const tamperedKidEnvelope = { ...envelope, signature: { ...envelope.signature, kid: "key-b" } };

    const result = await verifyEnvelope(tamperedKidEnvelope, trustStore);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([{ path: "/signature/kid", code: "unknown_key", message: expect.any(String) as string }]);
    }
  });

  it("prototype-named ids: publisher 'constructor' and kid '__proto__' fail without throwing", async () => {
    const manifest1 = cloneManifest(paymentReconcilerManifest());
    manifest1.publisher.id = "constructor";
    const { envelope: envelope1 } = await signManifestForTest(manifest1, { publisherId: "constructor" });

    const result1 = await verifyEnvelope(envelope1, {});
    expect(result1.ok).toBe(false);
    if (!result1.ok) {
      expect(result1.errors).toEqual([
        { path: "/manifest/publisher/id", code: "unknown_publisher", message: expect.any(String) as string },
      ]);
    }

    const manifest2 = cloneManifest(paymentReconcilerManifest());
    const { envelope: envelope2, trustStore: trustStore2 } = await signManifestForTest(manifest2, { kid: "real-kid" });
    const badKidEnvelope = { ...envelope2, signature: { ...envelope2.signature, kid: "__proto__" } };

    const result2 = await verifyEnvelope(badKidEnvelope, trustStore2);
    expect(result2.ok).toBe(false);
    if (!result2.ok) {
      expect(result2.errors).toEqual([{ path: "/signature/kid", code: "unknown_key", message: expect.any(String) as string }]);
    }
  });

  it("key of another publisher: unknown_key (D-05)", async () => {
    const manifestA = cloneManifest(paymentReconcilerManifest());
    manifestA.publisher.id = "publisher-a.example";
    const { trustStore: trustStoreA } = await signManifestForTest(manifestA, {
      publisherId: "publisher-a.example",
      kid: "shared-kid",
    });

    const manifestB = cloneManifest(paymentReconcilerManifest());
    manifestB.publisher.id = "publisher-b.example";
    const { trustStore: trustStoreB, envelope: envelopeBOwnKid } = await signManifestForTest(manifestB, {
      publisherId: "publisher-b.example",
      kid: "b-own-kid",
    });

    // Combined trust store: "shared-kid" exists, but only under publisher-a.example -- never
    // under publisher-b.example. publisher-b.example is a KNOWN publisher (registered under its
    // own "b-own-kid"), so this proves the kid lookup is scoped per-publisher, not global.
    const combinedTrustStore: TrustStore = { ...trustStoreA, ...trustStoreB };
    const envelopeWithSharedKid = { ...envelopeBOwnKid, signature: { ...envelopeBOwnKid.signature, kid: "shared-kid" } };

    const result = await verifyEnvelope(envelopeWithSharedKid, combinedTrustStore);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([{ path: "/signature/kid", code: "unknown_key", message: expect.any(String) as string }]);
    }
  });

  it("signature by another publisher's key under B's kid: invalid_signature (D-05)", async () => {
    const manifestA = cloneManifest(paymentReconcilerManifest());
    manifestA.publisher.id = "publisher-a.example";
    const { privateKey: privateKeyA } = await signManifestForTest(manifestA, {
      publisherId: "publisher-a.example",
      kid: "shared-kid",
    });

    const manifestB = cloneManifest(paymentReconcilerManifest());
    manifestB.publisher.id = "publisher-b.example";
    const { trustStore: trustStoreB } = await signManifestForTest(manifestB, {
      publisherId: "publisher-b.example",
      kid: "shared-kid",
    });

    // manifestB is signed with A's private key but claims publisher-b.example + "shared-kid" -- the
    // kid lookup succeeds (it resolves to B's OWN registered key), but that key never produced this
    // signature, so verification fails.
    const crossEnvelope = await signEnvelopeWithKey(manifestB, privateKeyA, "shared-kid");

    const result = await verifyEnvelope(crossEnvelope, trustStoreB);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([{ path: "/signature/sig", code: "invalid_signature", message: expect.any(String) as string }]);
    }
  });

  it("non-finite number in manifest: not_canonicalizable at /manifest", async () => {
    const manifest = cloneManifest(paymentReconcilerManifest());
    const { envelope, trustStore } = await signManifestForTest(manifest);

    const raw = JSON.stringify(envelope).replace('"max_actions":500', '"max_actions":1e400');
    const parsed = parseEnvelope(raw);
    expect(parsed.ok).toBe(true);

    if (parsed.ok) {
      const result = await verifyEnvelope(parsed.value, trustStore);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors).toEqual([{ path: "/manifest", code: "not_canonicalizable", message: expect.any(String) as string }]);
      }
    }
  });

  it("signed but invalid manifest: invalid_enum at /manifest/scopes/0/access/0", async () => {
    const manifest = cloneManifest(paymentReconcilerManifest());
    (manifest.scopes[0] as { access: string[] }).access = ["delete"];
    const { envelope, trustStore } = await signManifestForTest(manifest);

    const result = await verifyEnvelope(envelope, trustStore);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([
        {
          path: "/manifest/scopes/0/access/0",
          code: "invalid_enum",
          message: expect.any(String) as string,
          allowed: ["read", "write", "send", "pay"],
        },
      ]);
    }
  });
});

describe("rotation and re-signing", () => {
  it("both kids verify, removed kid fails (D-06)", async () => {
    const manifest = cloneManifest(paymentReconcilerManifest());
    const publisherId = manifest.publisher.id;

    const call1 = await signManifestForTest(manifest, { publisherId, kid: "key-1" });
    const call2 = await signManifestForTest(manifest, { publisherId, kid: "key-2" });

    const call1Keys = call1.trustStore[publisherId];
    const call2Keys = call2.trustStore[publisherId];
    if (call1Keys === undefined || call2Keys === undefined) {
      throw new Error("test setup: signManifestForTest must register the publisher's kid");
    }

    const combinedTrustStore: TrustStore = { [publisherId]: { ...call1Keys, ...call2Keys } };

    const result1 = await verifyEnvelope(call1.envelope, combinedTrustStore);
    const result2 = await verifyEnvelope(call2.envelope, combinedTrustStore);
    expect(result1.ok).toBe(true);
    expect(result2.ok).toBe(true);

    // Remove key-1 (rotation): envelope1 now fails, envelope2 (key-2) is unaffected.
    const rotatedTrustStore: TrustStore = { [publisherId]: { ...call2Keys } };
    const result1AfterRotation = await verifyEnvelope(call1.envelope, rotatedTrustStore);
    expect(result1AfterRotation.ok).toBe(false);
    if (!result1AfterRotation.ok) {
      expect(result1AfterRotation.errors[0]?.code).toBe("unknown_key");
    }
  });

  it("re-signing keeps the content hash (D-08)", async () => {
    const manifest = cloneManifest(paymentReconcilerManifest());
    const call1 = await signManifestForTest(manifest, { kid: "key-1" });
    const call2 = await signManifestForTest(manifest, { kid: "key-2" });

    const result1 = await verifyEnvelope(call1.envelope, call1.trustStore);
    const result2 = await verifyEnvelope(call2.envelope, call2.trustStore);

    expect(result1.ok).toBe(true);
    expect(result2.ok).toBe(true);
    if (result1.ok && result2.ok) {
      expect(result1.value.contentHash).toBe(result2.value.contentHash);
    }
  });

  it("omitted auth.mode still round-trips its hash", async () => {
    const manifest = withoutMode(paymentReconcilerManifest());
    const { envelope, trustStore } = await signManifestForTest(manifest);

    const result = await verifyEnvelope(envelope, trustStore);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(hashManifest(result.value.manifest)).toBe(result.value.contentHash);
    }
  });
});

describe("verified manifest integrity", () => {
  it("verified manifest is deeply frozen", async () => {
    const manifest = cloneManifest(paymentReconcilerManifest());
    const { envelope, trustStore } = await signManifestForTest(manifest);

    const result = await verifyEnvelope(envelope, trustStore);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(() => {
        (result.value.manifest.limits as { max_actions: number }).max_actions = 1;
      }).toThrow();
    }
  });

  it("errors never leak key material", async () => {
    const manifest = cloneManifest(paymentReconcilerManifest());
    const publisherId = manifest.publisher.id;
    const { envelope, publicJwk } = await signManifestForTest(manifest, { publisherId, kid: "leaky-kid" });

    // A trust-store entry carrying a stray private "d" member alongside the legitimate public fields.
    const leakyTrustStore = {
      [publisherId]: {
        "leaky-kid": { ...publicJwk, d: "THIS_IS_A_SECRET_D_VALUE" },
      },
    } as unknown as TrustStore;

    const sig = envelope.signature.sig;
    const flippedSig = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
    const malformedEnvelope = { ...envelope, signature: { ...envelope.signature, sig: flippedSig } };

    const result = await verifyEnvelope(malformedEnvelope, leakyTrustStore);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const serialized = JSON.stringify(result.errors);
      expect(serialized).not.toContain("THIS_IS_A_SECRET_D_VALUE");
      expect(serialized).not.toContain(publicJwk.x);
      expect(serialized.toLowerCase()).not.toContain("jws");
      expect(serialized.toLowerCase()).not.toContain("jose");
    }
  });
});
