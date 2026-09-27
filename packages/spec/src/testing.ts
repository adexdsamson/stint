/**
 * `@stint/spec/testing` — signing helpers for tests and vector generation
 * (D-07). This subpath is the ONLY place in the package that can produce a
 * signature: the public `.` entry (`./index.ts`) never re-exports anything
 * from this file, so there is no option or flag anywhere in the public API
 * that returns a `VerifiedManifest` without going through `verifyEnvelope`.
 */

import { generateKeyPair, importJWK, exportJWK } from "jose";
import type { CryptoKey, JWK } from "jose";
import type { JsonWebKey } from "node:crypto";

import { canonicalize } from "./canonical.js";
import { signDetached } from "./jws.js";
import type { Ed25519PublicJwk, TrustStore } from "./envelope.js";
import type { SignedEnvelope } from "./generated/envelope.js";

function readPublisherIdForDefault(manifest: unknown): string {
  if (typeof manifest === "object" && manifest !== null) {
    const publisher = (manifest as Record<string, unknown>).publisher;
    if (typeof publisher === "object" && publisher !== null) {
      const id = (publisher as Record<string, unknown>).id;
      if (typeof id === "string") return id;
    }
  }
  throw new Error("@stint/spec/testing: signManifestForTest requires manifest.publisher.id or an explicit publisherId option");
}

function requireManifestObject(manifest: unknown): { [k: string]: unknown } {
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
    throw new Error("@stint/spec/testing: manifest must be a JSON object");
  }
  return manifest as { [k: string]: unknown };
}

function requireEd25519PublicJwk(exported: JWK): Ed25519PublicJwk {
  if (exported.kty !== "OKP" || (exported as { crv?: unknown }).crv !== "Ed25519" || typeof (exported as { x?: unknown }).x !== "string") {
    throw new Error("@stint/spec/testing: expected an Ed25519 (OKP) public key");
  }
  return { kty: "OKP", crv: "Ed25519", x: (exported as { x: string }).x };
}

/**
 * Signs `manifest` over the JCS bytes of `canonicalize(manifest)`. Fixed
 * vector key material comes in via `importTestSigningKey`; both this
 * function and `signManifestForTest` route through the one shared
 * `signDetached` in `jws.ts`.
 */
export async function signEnvelopeWithKey(manifest: unknown, privateKey: CryptoKey, kid: string): Promise<SignedEnvelope> {
  const manifestObject = requireManifestObject(manifest);
  const canonicalText = canonicalize(manifestObject);
  const jcsBytes = new TextEncoder().encode(canonicalText);
  const sig = await signDetached(jcsBytes, privateKey);
  return { manifest: manifestObject, signature: { alg: "EdDSA", kid, sig } };
}

/** Imports a fixed vector private key (e.g. the RFC 8037 A.1 test key) as an EdDSA-usable `CryptoKey`. */
export async function importTestSigningKey(privateJwk: JsonWebKey): Promise<CryptoKey> {
  const key = await importJWK(privateJwk as unknown as JWK, "EdDSA");
  return key as CryptoKey;
}

/**
 * Generates a fresh, extractable Ed25519 key pair, signs `manifest` with
 * it, and returns everything a test needs to round-trip through
 * `verifyEnvelope`: the envelope, a matching one-entry `TrustStore`, the
 * public JWK, and the private key (for re-signing scenarios, e.g. D-06 key
 * rotation).
 */
export async function signManifestForTest(
  manifest: unknown,
  options?: { publisherId?: string; kid?: string },
): Promise<{ envelope: SignedEnvelope; trustStore: TrustStore; publicJwk: Ed25519PublicJwk; privateKey: CryptoKey }> {
  const publisherId = options?.publisherId ?? readPublisherIdForDefault(manifest);
  const kid = options?.kid ?? "test-key";

  const { privateKey, publicKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
  const envelope = await signEnvelopeWithKey(manifest, privateKey, kid);
  const exported = await exportJWK(publicKey);
  const publicJwk = requireEd25519PublicJwk(exported);

  const trustStore: TrustStore = { [publisherId]: { [kid]: publicJwk } };

  return { envelope, trustStore, publicJwk, privateKey };
}
