import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import type { JsonWebKey } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { TrustStore } from "../src/envelope.js";
import { verifyEnvelope } from "../src/envelope.js";
import { importTestSigningKey, signEnvelopeWithKey } from "../src/testing.js";

// packages/spec/test -> packages/spec -> packages -> repo root
const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, "..", "..", "..");
const envelopeVectorsDir = path.join(repoRoot, "spec", "vectors", "envelope");
const jcsVectorsDir = path.join(repoRoot, "spec", "vectors", "jcs");
const validDir = path.join(repoRoot, "spec", "vectors", "valid");

interface ExpectedValid {
  readonly valid: true;
  readonly content_hash: string;
  readonly publisher_id: string;
  readonly kid: string;
}

interface ExpectedInvalid {
  readonly valid: false;
  readonly code: string;
  readonly path: string;
}

type ExpectedOutcome = ExpectedValid | ExpectedInvalid;

interface TestKeyFile {
  readonly kid: string;
  readonly kty: string;
  readonly crv: string;
  readonly d: string;
  readonly x: string;
}

interface ValidVectorFile {
  readonly manifest: unknown;
}

function readJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

const trustStore = readJson(path.join(envelopeVectorsDir, "trust-store.json")) as TrustStore;
const expected = readJson(path.join(envelopeVectorsDir, "expected.json")) as Record<string, ExpectedOutcome>;
const testKeyRaw = readJson(path.join(envelopeVectorsDir, "test-key.jwk.json")) as TestKeyFile;

describe("vectors", () => {
  it("each envelope yields its expected outcome", async () => {
    for (const [name, outcome] of Object.entries(expected)) {
      const envelope = readJson(path.join(envelopeVectorsDir, name));
      const result = await verifyEnvelope(envelope, trustStore);

      if (outcome.valid) {
        expect(result.ok, name).toBe(true);
        if (result.ok) {
          expect(result.value.contentHash, name).toBe(outcome.content_hash);
          expect(result.value.publisherId, name).toBe(outcome.publisher_id);
          expect(result.value.kid, name).toBe(outcome.kid);
        }
      } else {
        expect(result.ok, name).toBe(false);
        if (!result.ok) {
          expect(result.errors, name).toEqual([
            { path: outcome.path, code: outcome.code, message: expect.any(String) as string },
          ]);
        }
      }
    }
  });

  it("re-signing with the RFC 8037 key reproduces signed.json", async () => {
    const privateKey = await importTestSigningKey(testKeyRaw as unknown as JsonWebKey);
    const reconciler = readJson(path.join(validDir, "payment-reconciler.json")) as ValidVectorFile;

    const resigned = await signEnvelopeWithKey(reconciler.manifest, privateKey, testKeyRaw.kid);
    const signed = readJson(path.join(envelopeVectorsDir, "signed.json"));

    expect(resigned).toEqual(signed);
  });

  it("node:crypto verifies signed.json over the documented signing input", () => {
    interface SignedVectorFile {
      readonly signature: { readonly kid: string; readonly sig: string };
    }

    const signed = readJson(path.join(envelopeVectorsDir, "signed.json")) as SignedVectorFile;
    const canonicalText = readFileSync(path.join(jcsVectorsDir, "manifest-canonical.json"), "utf8");

    // ASCII(base64url(JWS_PROTECTED_HEADER)) + "." + BASE64URL(JCS(manifest) as UTF-8 bytes) -- the
    // documented signing input (this plan's "Signature format decision"), verified independently
    // of jose via node:crypto directly.
    const protectedB64 = "eyJhbGciOiJFZERTQSJ9";
    const payloadB64 = Buffer.from(canonicalText, "utf8").toString("base64url");
    const signingInput = `${protectedB64}.${payloadB64}`;

    const publisherKeys = trustStore["reconciler-labs.example"];
    if (publisherKeys === undefined) throw new Error("test setup: missing trust store publisher entry");
    const publicJwk = publisherKeys[signed.signature.kid];
    if (publicJwk === undefined) throw new Error("test setup: missing trust store key entry");

    const keyObject = createPublicKey({ key: publicJwk as unknown as JsonWebKey, format: "jwk" });
    const sigBuf = Buffer.from(signed.signature.sig, "base64url");

    expect(cryptoVerify(null, Buffer.from(signingInput, "utf8"), keyObject, sigBuf)).toBe(true);
  });
});
