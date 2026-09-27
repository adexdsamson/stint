/**
 * The single RFC 8785 (JSON Canonicalization Scheme) serializer and
 * `jcs-sha256:` content hash for @stint/spec (D-01, D-02, D-28).
 *
 * This is the ONLY serializer used for hashing anywhere in this repo — never
 * `JSON.stringify` for hashing. Phase 2 binds `contentHash` to leases and
 * Phase 3 reuses `canonicalize`/`hashCanonical` for receipt chains; both
 * depend on this being exact and single-sourced.
 *
 * `canonicalize@5.1.0`'s own serializer silently drops `undefined`-valued
 * object properties, functions and symbols (mirroring `JSON.stringify`'s
 * behavior) instead of rejecting them, and would happily call a `Date`'s
 * `toJSON()` instead of rejecting it outright. Two different inputs (one
 * with a key omitted, one with the same key set to `undefined`) would then
 * hash identically, which defeats the point of a content hash. A pre-walk
 * that accepts only the strict JSON data model runs BEFORE the library call
 * so every rejection is loud and none of these values are silently coerced.
 */

import { createHash } from "node:crypto";

import canonicalizeJcs from "canonicalize";

import type { Manifest } from "./generated/manifest.js";

export const CONTENT_HASH_PREFIX = "jcs-sha256:";

/** A `jcs-sha256:` content hash string: the prefix followed by 64 lowercase hex characters. */
export type ContentHash = `${typeof CONTENT_HASH_PREFIX}${string}`;

/** Bounds recursion in the pre-walk below; also documents a sane manifest nesting limit (T-01-13). */
export const MAX_CANONICAL_DEPTH = 64;

const CONTENT_HASH_PATTERN = /^jcs-sha256:[0-9a-f]{64}$/;

/**
 * Thrown by {@link canonicalize} for any value outside the strict JSON data
 * model, or when the underlying serializer fails or returns `undefined`.
 * The message names only the JSON Pointer (RFC 6901) of the offending
 * location — it never echoes the offending value, so no manifest content
 * (however sensitive) can leak through a canonicalization error.
 */
export class CanonicalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalizationError";
  }
}

/** Escapes a single JSON Pointer (RFC 6901) segment: `~` -> `~0`, `/` -> `~1`. */
function escapePointerSegment(segment: string): string {
  return segment.replace(/~/g, "~0").replace(/\//g, "~1");
}

/**
 * Recursively asserts that `value` is within the strict JSON data model:
 * `null`, booleans, finite numbers, strings, arrays, and plain objects whose
 * prototype is `Object.prototype` or `null`. Rejects `undefined` anywhere
 * (including `undefined`-valued object properties), functions, symbols,
 * bigints, non-finite numbers, and every other object kind (Date, Map, class
 * instances, ...). `containerDepth` counts only array/object nesting — a
 * leaf value never itself increments or is bounded by the depth check,
 * only the containers it sits inside are.
 */
function assertJsonValue(value: unknown, pointer: string, containerDepth: number): void {
  if (value === null) return;

  const type = typeof value;

  if (type === "boolean" || type === "string") return;

  if (type === "number") {
    if (!Number.isFinite(value)) {
      throw new CanonicalizationError(`Non-finite number at "${pointer}".`);
    }
    return;
  }

  if (type !== "object") {
    // undefined, function, symbol, bigint
    throw new CanonicalizationError(`Unsupported value type at "${pointer}".`);
  }

  const nextDepth = containerDepth + 1;
  if (nextDepth > MAX_CANONICAL_DEPTH) {
    throw new CanonicalizationError(`Nesting exceeds maximum depth at "${pointer}".`);
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      assertJsonValue(item, `${pointer}/${String(index)}`, nextDepth);
    });
    return;
  }

  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new CanonicalizationError(`Unsupported object type at "${pointer}".`);
  }

  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const propPointer = `${pointer}/${escapePointerSegment(key)}`;
    const propValue = record[key];
    if (propValue === undefined) {
      throw new CanonicalizationError(`Undefined value at "${propPointer}".`);
    }
    assertJsonValue(propValue, propPointer, nextDepth);
  }
}

/**
 * Serializes `value` as RFC 8785 JSON Canonicalization Scheme text. Throws
 * {@link CanonicalizationError} for any value outside the strict JSON data
 * model, or if the underlying serializer fails or produces `undefined`.
 */
export function canonicalize(value: unknown): string {
  assertJsonValue(value, "", 0);

  let result: string | undefined;
  try {
    result = canonicalizeJcs(value);
  } catch {
    throw new CanonicalizationError("Value cannot be canonicalized.");
  }

  if (result === undefined) {
    throw new CanonicalizationError("Value cannot be canonicalized.");
  }

  return result;
}

/** `"jcs-sha256:" + lowercase hex SHA-256 of the UTF-8 bytes of canonicalize(value)`. */
export function hashCanonical(value: unknown): ContentHash {
  return hashCanonicalText(canonicalize(value));
}

/**
 * Hashes already-canonicalized text directly — used where the exact
 * canonical bytes are already in hand (e.g. the bytes just verified against
 * a signature) and re-canonicalizing would be redundant (D-08).
 */
export function hashCanonicalText(canonicalText: string): ContentHash {
  const hex = createHash("sha256").update(canonicalText, "utf8").digest("hex");
  return `${CONTENT_HASH_PREFIX}${hex}`;
}

/** `hashCanonical`, typed for the manifest use case. */
export function hashManifest(manifest: Manifest): ContentHash {
  return hashCanonical(manifest);
}

/** Narrows `value` to a `jcs-sha256:` content hash string (`^jcs-sha256:[0-9a-f]{64}$`). */
export function isContentHash(value: unknown): value is ContentHash {
  return typeof value === "string" && CONTENT_HASH_PATTERN.test(value);
}
