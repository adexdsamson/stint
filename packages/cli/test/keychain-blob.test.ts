import { describe, expect, it } from "vitest";

import { StoreCorruptError } from "../src/store/atomic-file.js";
import { CHUNK_BYTES, reassembleSecret, splitSecret } from "../src/store/keychain-blob.js";

/** Round-trips `value` through split → reassemble and asserts byte-identity. */
function roundTrip(value: string): string {
  const { head, chunks } = splitSecret(value);
  return reassembleSecret(head, chunks);
}

describe("keychain-blob", () => {
  describe("chunk boundary", () => {
    it("a value of exactly CHUNK_BYTES is one chunk", () => {
      const value = "a".repeat(CHUNK_BYTES);
      const { head, chunks } = splitSecret(value);
      expect(chunks).toHaveLength(1);
      expect(head.n).toBe(1);
      expect(head.len).toBe(CHUNK_BYTES);
      expect(chunks[0]).toHaveLength(CHUNK_BYTES);
      expect(roundTrip(value)).toBe(value);
    });

    it("a value of CHUNK_BYTES + 1 is two chunks with a short last chunk", () => {
      const value = "a".repeat(CHUNK_BYTES + 1);
      const { head, chunks } = splitSecret(value);
      expect(chunks).toHaveLength(2);
      expect(head.n).toBe(2);
      expect(chunks[0]).toHaveLength(CHUNK_BYTES);
      expect(chunks[1]).toHaveLength(1);
      expect(roundTrip(value)).toBe(value);
    });

    it("an empty value is zero chunks and round-trips", () => {
      const { head, chunks } = splitSecret("");
      expect(chunks).toHaveLength(0);
      expect(head.n).toBe(0);
      expect(head.len).toBe(0);
      expect(roundTrip("")).toBe("");
    });

    it("a multi-chunk value round-trips byte-identically", () => {
      const value = "x".repeat(CHUNK_BYTES * 3 + 7);
      const { chunks } = splitSecret(value);
      expect(chunks).toHaveLength(4);
      expect(roundTrip(value)).toBe(value);
    });
  });

  describe("multibyte safety", () => {
    it("a surrogate pair straddling a CHUNK_BYTES boundary reassembles byte-identically", () => {
      // 2047 ASCII bytes then a 4-byte astral char: its bytes span 2047..2050,
      // so the character is split across the first (byte 2047) and second chunk.
      const value = "a".repeat(CHUNK_BYTES - 1) + "😀";
      const { head, chunks } = splitSecret(value);
      expect(head.n).toBe(2);
      expect(head.len).toBe(CHUNK_BYTES - 1 + 4);
      // The split happened mid-character: the first chunk ends with one emoji byte.
      expect(chunks[0]).toHaveLength(CHUNK_BYTES);
      expect(chunks[1]).toHaveLength(3);
      expect(roundTrip(value)).toBe(value);
    });

    it("mixed unicode, newlines and astral characters round-trip", () => {
      const value = `héllo 世界 😀\nℝ𝕦𝕟 ${"🌍".repeat(600)}`;
      expect(roundTrip(value)).toBe(value);
    });
  });

  describe("integrity: torn or tampered blobs throw, never a partial string", () => {
    const value = "secret-" + "p".repeat(CHUNK_BYTES * 2);

    it("a missing (undefined) chunk throws StoreCorruptError", () => {
      const { head, chunks } = splitSecret(value);
      const torn: (Uint8Array | undefined)[] = [...chunks];
      torn[1] = undefined;
      expect(() => reassembleSecret(head, torn)).toThrow(StoreCorruptError);
    });

    it("too few chunks (count mismatch) throws StoreCorruptError", () => {
      const { head, chunks } = splitSecret(value);
      expect(() => reassembleSecret(head, chunks.slice(0, chunks.length - 1))).toThrow(
        StoreCorruptError,
      );
    });

    it("a mutated chunk byte (digest mismatch) throws StoreCorruptError", () => {
      const { head, chunks } = splitSecret(value);
      const mutated = chunks.map((c) => Uint8Array.from(c));
      const first = mutated[0] as Uint8Array;
      first[0] = (first[0] ?? 0) ^ 0xff;
      expect(() => reassembleSecret(head, mutated)).toThrow(StoreCorruptError);
    });

    it("a wrong sha256 in the head throws StoreCorruptError", () => {
      const { head, chunks } = splitSecret(value);
      expect(() => reassembleSecret({ ...head, sha256: "0".repeat(64) }, chunks)).toThrow(
        StoreCorruptError,
      );
    });

    it("a wrong len in the head throws StoreCorruptError", () => {
      const { head, chunks } = splitSecret(value);
      expect(() => reassembleSecret({ ...head, len: head.len + 1 }, chunks)).toThrow(
        StoreCorruptError,
      );
    });

    it("a malformed head (bad shape) throws StoreCorruptError", () => {
      const { chunks } = splitSecret(value);
      expect(() =>
        reassembleSecret({ v: 2, n: chunks.length, len: 1, sha256: "x" }, chunks),
      ).toThrow(StoreCorruptError);
      expect(() => reassembleSecret(null, chunks)).toThrow(StoreCorruptError);
      expect(() => reassembleSecret("not-a-head", chunks)).toThrow(StoreCorruptError);
    });
  });
});
