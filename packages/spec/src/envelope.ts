/**
 * `verifyEnvelope`, `parseEnvelope`, `TrustStore` and the `VerifiedManifest`
 * brand (D-04, D-05, D-30). This is the runtime's trust anchor: a
 * `VerifiedManifest` can only ever be minted by `verifyEnvelope` succeeding,
 * so later phases that only accept a `VerifiedManifest` structurally cannot
 * skip verification (D-07).
 */

import { importJWK } from "jose";

import { canonicalize, CanonicalizationError, hashCanonicalText } from "./canonical.js";
import type { ContentHash } from "./canonical.js";
import { verifyDetached } from "./jws.js";
import { validateEnvelopeShape, validateManifest } from "./validate.js";
import type { SignedEnvelope } from "./generated/envelope.js";
import type { Manifest } from "./generated/manifest.js";
import type { SpecError, Result } from "./errors.js";

/** Envelope byte-size ceiling, checked in `parseEnvelope` before any parsing (T-01-14). */
export const MAX_ENVELOPE_BYTES = 262144;

/** An Ed25519 public key in its minimal JWK form — never carries a private "d" member. */
export interface Ed25519PublicJwk {
  readonly kty: "OKP";
  readonly crv: "Ed25519";
  readonly x: string;
}

/** Host-configured public keys, scoped by publisher id and then key id (kid). */
export type TrustStore = Readonly<Record<string, Readonly<Record<string, Ed25519PublicJwk>>>>;

declare const verifiedManifestBrand: unique symbol;

/**
 * A manifest that `verifyEnvelope` has verified and validated. The brand
 * (a module-private, unexported unique symbol) means no code outside this
 * module can construct a value of this type without a type assertion —
 * enforced by `brand.test.ts`'s `@ts-expect-error`.
 */
export interface VerifiedManifest {
  readonly manifest: Manifest;
  readonly contentHash: ContentHash;
  readonly publisherId: string;
  readonly kid: string;
  readonly [verifiedManifestBrand]: true;
}

function err(path: string, code: SpecError["code"], message: string, allowed?: readonly string[]): Result<never> {
  const error: SpecError = allowed === undefined ? { path, code, message } : { path, code, message, allowed };
  return { ok: false, errors: [error] };
}

/** Looks up `key` as an OWN property of `record` — never a bare bracket access alone, so prototype-named keys (`__proto__`, `constructor`) can never reach `Object.prototype` (D-05). */
function ownEntry(record: object, key: string): unknown {
  if (!Object.hasOwn(record, key)) return undefined;
  return (record as Record<string, unknown>)[key];
}

/** Recursively freezes `value` (and every nested array/object) so a `VerifiedManifest` can never be mutated after minting (T-01-17). */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/**
 * Parses raw envelope bytes/text. Checks the UTF-8 byte length against
 * {@link MAX_ENVELOPE_BYTES} BEFORE any JSON parsing, and never echoes the
 * parser's own exception text (which can otherwise reflect fragments of the
 * input) in the returned error.
 */
export function parseEnvelope(raw: string | Uint8Array): Result<unknown> {
  const bytes = typeof raw === "string" ? new TextEncoder().encode(raw) : raw;

  if (bytes.byteLength > MAX_ENVELOPE_BYTES) {
    return err("", "envelope_too_large", "Envelope exceeds the maximum allowed size.");
  }

  const text = typeof raw === "string" ? raw : new TextDecoder("utf-8", { fatal: true }).decode(raw);

  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return err("", "invalid_json", "Envelope is not valid JSON.");
  }
}

/** Reads `manifest.publisher.id` from an as-yet-unvalidated manifest value, with plain `typeof` checks only. */
function readPublisherId(manifestValue: unknown): Result<string> {
  const path = "/manifest/publisher/id";

  if (typeof manifestValue !== "object" || manifestValue === null) {
    return err(path, "missing_required", `Missing required property at "${path}".`);
  }

  const publisher = (manifestValue as Record<string, unknown>).publisher;
  if (typeof publisher !== "object" || publisher === null) {
    return err(path, "missing_required", `Missing required property at "${path}".`);
  }

  const id = (publisher as Record<string, unknown>).id;
  if (id === undefined) {
    return err(path, "missing_required", `Missing required property at "${path}".`);
  }
  if (typeof id !== "string") {
    return err(path, "invalid_type", `Value at "${path}" has an invalid type.`);
  }

  return { ok: true, value: id };
}

/** Validates a trust-store entry's shape and returns only `{ kty, crv, x }` — never a stray private "d" member. */
function readEd25519PublicJwk(candidateRaw: unknown): Ed25519PublicJwk | null {
  if (typeof candidateRaw !== "object" || candidateRaw === null) return null;
  const candidate = candidateRaw as Record<string, unknown>;
  if (candidate.kty !== "OKP" || candidate.crv !== "Ed25519" || typeof candidate.x !== "string") return null;
  return { kty: "OKP", crv: "Ed25519", x: candidate.x };
}

/**
 * Verifies `envelope` against `trustStore` and, on success, returns a
 * branded {@link VerifiedManifest}. Implements the procedure in
 * `01-03-PLAN.md`'s "verifyEnvelope procedure" section, steps 1-10, in
 * exact order. Takes exactly two parameters and has no option that skips
 * verification (D-07).
 */
export async function verifyEnvelope(envelope: unknown, trustStore: TrustStore): Promise<Result<VerifiedManifest>> {
  // Step 1
  const shapeResult = validateEnvelopeShape(envelope);
  if (!shapeResult.ok) {
    return { ok: false, errors: shapeResult.errors };
  }
  const signedEnvelope: SignedEnvelope = shapeResult.value;

  // Step 2
  const publisherIdResult = readPublisherId(signedEnvelope.manifest);
  if (!publisherIdResult.ok) {
    return { ok: false, errors: publisherIdResult.errors };
  }
  const publisherId = publisherIdResult.value;

  // Step 3
  const publisherEntryRaw = ownEntry(trustStore, publisherId);
  if (typeof publisherEntryRaw !== "object" || publisherEntryRaw === null) {
    return err(
      "/manifest/publisher/id",
      "unknown_publisher",
      'Unknown publisher at "/manifest/publisher/id".',
    );
  }

  // Step 4
  const kid = signedEnvelope.signature.kid;
  const kidEntryRaw = ownEntry(publisherEntryRaw, kid);
  const publicJwk = readEd25519PublicJwk(kidEntryRaw);
  if (publicJwk === null) {
    return err("/signature/kid", "unknown_key", 'Unknown signing key at "/signature/kid".');
  }

  // Step 5
  let canonicalText: string;
  try {
    canonicalText = canonicalize(signedEnvelope.manifest);
  } catch (error) {
    if (error instanceof CanonicalizationError) {
      return err("/manifest", "not_canonicalizable", 'Manifest at "/manifest" cannot be canonicalized.');
    }
    throw error;
  }
  const jcsBytes = new TextEncoder().encode(canonicalText);

  // Step 6 — every jose call (import + verify) is wrapped; any failure becomes
  // the same fixed invalid_signature error, never jose's exception text (T-01-15).
  let verified: boolean;
  try {
    const publicKey = await importJWK(publicJwk, "EdDSA");
    verified = await verifyDetached(jcsBytes, signedEnvelope.signature.sig, publicKey);
  } catch {
    verified = false;
  }
  if (!verified) {
    return err("/signature/sig", "invalid_signature", 'Signature at "/signature/sig" is invalid.');
  }

  // Step 7
  const trusted: unknown = JSON.parse(canonicalText);

  // Step 8
  const manifestResult = validateManifest(trusted);
  if (!manifestResult.ok) {
    return {
      ok: false,
      errors: manifestResult.errors.map((error) => ({ ...error, path: `/manifest${error.path}` })),
    };
  }

  // Step 9
  const contentHash = hashCanonicalText(canonicalText);

  // Step 10
  const frozenManifest = deepFreeze(manifestResult.value);
  const verifiedManifest = {
    manifest: frozenManifest,
    contentHash,
    publisherId,
    kid,
  } as VerifiedManifest;

  return { ok: true, value: verifiedManifest };
}
