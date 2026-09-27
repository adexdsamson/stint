import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CanonicalizationError,
  MAX_CANONICAL_DEPTH,
  canonicalize,
  hashCanonical,
  hashManifest,
  isContentHash,
} from "../src/canonical.js";
import { cloneManifest, paymentReconcilerManifest } from "./fixtures.js";

// packages/spec/test -> packages/spec -> packages -> repo root
const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, "..", "..", "..");
const vectorsDir = path.join(repoRoot, "spec", "vectors", "jcs");
const validDir = path.join(repoRoot, "spec", "vectors", "valid");

function readVector(name: string): string {
  return readFileSync(path.join(vectorsDir, name), "utf8");
}

/** Recursively shuffles an object's key order (reverse of insertion order at every level). Array order and values are untouched. */
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).reverse();
    const out: Record<string, unknown> = {};
    for (const key of keys) out[key] = reverseKeys((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

/** Deterministic pseudo-shuffle of an object's key order, seeded by index, so 20 shuffles are each different from one another. */
function shuffleKeys(value: unknown, seed: number): unknown {
  if (Array.isArray(value)) return value.map((item) => shuffleKeys(item, seed));
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    // A simple seeded rotation: rotate the entries array by `seed` positions.
    const rotated = entries.length > 0 ? [...entries.slice(seed % entries.length), ...entries.slice(0, seed % entries.length)] : entries;
    const out: Record<string, unknown> = {};
    for (const [key, val] of rotated) out[key] = shuffleKeys(val, seed + 1);
    return out;
  }
  return value;
}

describe("golden hash", () => {
  it("RFC 8785 sample canonicalizes to the RFC output", () => {
    const input: unknown = JSON.parse(readVector("rfc8785-input.json"));
    const expected = readVector("rfc8785-canonical.txt");
    expect(canonicalize(input)).toBe(expected);
  });

  it("manifest vector", () => {
    const input: unknown = JSON.parse(readVector("manifest-input.json"));
    const expectedCanonical = readVector("manifest-canonical.json");
    const expectedHash = readVector("manifest-expected-hash.txt").trim();

    expect(canonicalize(input)).toBe(expectedCanonical);
    expect(hashCanonical(input)).toBe(expectedHash);
  });

  it("payment-reconciler vector hashes to the same value", () => {
    const fixture = JSON.parse(readFileSync(path.join(validDir, "payment-reconciler.json"), "utf8")) as {
      manifest: unknown;
    };
    const expectedHash = readVector("manifest-expected-hash.txt").trim();

    expect(hashCanonical(fixture.manifest)).toBe(expectedHash);
  });
});

describe("key order and whitespace do not change the hash", () => {
  it("20 recursive key shuffles of the payment-reconciler manifest all hash identically", () => {
    const manifest = paymentReconcilerManifest();
    const baseline = hashManifest(manifest);

    for (let i = 0; i < 20; i++) {
      const shuffled = shuffleKeys(cloneManifest(manifest), i);
      expect(hashCanonical(shuffled)).toBe(baseline);
    }

    // Full reversal too, as an additional distinct permutation.
    expect(hashCanonical(reverseKeys(cloneManifest(manifest)))).toBe(baseline);
  });
});

describe("array order changes the hash", () => {
  it("swapping the two auth.delegated grants changes hashManifest", () => {
    const manifest = paymentReconcilerManifest();
    const baseline = hashManifest(manifest);

    const swapped = cloneManifest(manifest);
    const delegated = swapped.auth.delegated;
    if (delegated === undefined || delegated.length !== 2) {
      throw new Error("fixture must have exactly 2 delegated grants for this test");
    }
    swapped.auth.delegated = [delegated[1], delegated[0]];

    expect(hashManifest(swapped)).not.toBe(baseline);
  });
});

describe("rejects non-JSON values", () => {
  class CustomClass {
    x = 1;
  }

  const cases: Array<[string, unknown]> = [
    ["undefined", undefined],
    ["a function", () => 1],
    ["a symbol", Symbol("x")],
    ["a bigint", 10n],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["a Date", new Date()],
    ["a Map", new Map()],
    ["a class instance", new CustomClass()],
  ];

  it.each(cases)("rejects %s", (_label, value) => {
    expect(() => canonicalize(value)).toThrow(CanonicalizationError);
  });

  it("rejects an object with an undefined-valued property", () => {
    expect(() => canonicalize({ a: 1, b: undefined })).toThrow(CanonicalizationError);
  });

  it("never echoes the offending value in the error message", () => {
    const secretMarker = "TOP_SECRET_MARKER_VALUE";
    try {
      canonicalize({ a: new Date(), secret: secretMarker });
      expect.unreachable("expected canonicalize to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(CanonicalizationError);
      expect((error as Error).message).not.toContain(secretMarker);
    }
  });
});

describe("rejects nesting deeper than MAX_CANONICAL_DEPTH", () => {
  function nestedArray(depth: number): unknown {
    let value: unknown = 0;
    for (let i = 0; i < depth; i++) value = [value];
    return value;
  }

  it(`${String(MAX_CANONICAL_DEPTH + 1)} nested arrays throw`, () => {
    expect(() => canonicalize(nestedArray(MAX_CANONICAL_DEPTH + 1))).toThrow(CanonicalizationError);
  });

  it(`${String(MAX_CANONICAL_DEPTH)} nested arrays do not throw`, () => {
    expect(() => canonicalize(nestedArray(MAX_CANONICAL_DEPTH))).not.toThrow();
  });
});

describe("hash format", () => {
  it("every hashCanonical output matches ^jcs-sha256:[0-9a-f]{64}$", () => {
    expect(hashManifest(paymentReconcilerManifest())).toMatch(/^jcs-sha256:[0-9a-f]{64}$/);
    expect(hashCanonical({ a: 1 })).toMatch(/^jcs-sha256:[0-9a-f]{64}$/);
  });

  it("isContentHash rejects a sha256: prefix plus 64 hex characters", () => {
    const hex = "0".repeat(64);
    expect(isContentHash(`sha256:${hex}`)).toBe(false);
    expect(isContentHash(`jcs-sha256:${hex}`)).toBe(true);
  });
});
