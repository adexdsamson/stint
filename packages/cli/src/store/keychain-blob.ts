/**
 * The pure chunk/integrity blob layer for the keychain `SecretStore`.
 *
 * This module has NO binding import and no I/O: it only turns a secret string
 * into a head record plus a list of byte chunks, and back again, verifying the
 * reassembled bytes against the head's length and SHA-256 digest.
 *
 * A value is encoded to UTF-8 bytes and split by BYTES (never by UTF-16 code
 * units — splitting a surrogate pair mid-character would corrupt it) into
 * chunks of at most `CHUNK_BYTES`. The head records the chunk count, the total
 * UTF-8 byte length and the lowercase-hex SHA-256 of the whole value, so a torn
 * or tampered blob is rejected with `StoreCorruptError` rather than returned as
 * a partial string.
 */

import { createHash } from "node:crypto";

import { StoreCorruptError } from "./atomic-file.js";

/** Maximum bytes per chunk. Chunk + head stay under the 2560-byte Windows Credential Manager cap. */
export const CHUNK_BYTES = 2048;

/** The integrity head stored alongside a value's chunks. */
export interface BlobHead {
  /** Schema version. */
  readonly v: 1;
  /** Number of chunks (0 for an empty value). */
  readonly n: number;
  /** Total UTF-8 byte length of the value. */
  readonly len: number;
  /** Lowercase-hex SHA-256 of the value's UTF-8 bytes. */
  readonly sha256: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8");

/** Splits `value` into an integrity head and its ordered byte chunks. */
export function splitSecret(value: string): { head: BlobHead; chunks: Uint8Array[] } {
  const bytes = encoder.encode(value);
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
    // slice() copies, so each chunk owns its bytes independently of the source buffer.
    chunks.push(bytes.slice(offset, Math.min(offset + CHUNK_BYTES, bytes.length)));
  }
  const head: BlobHead = {
    v: 1,
    n: chunks.length,
    len: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  return { head, chunks };
}

/** Validates an unknown value as a `BlobHead`; returns it narrowed, or `undefined`. */
export function parseBlobHead(value: unknown): BlobHead | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const h = value as Record<string, unknown>;
  if (h.v !== 1) return undefined;
  if (typeof h.n !== "number" || !Number.isInteger(h.n) || h.n < 0) return undefined;
  if (typeof h.len !== "number" || !Number.isInteger(h.len) || h.len < 0) return undefined;
  if (typeof h.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(h.sha256)) return undefined;
  return { v: 1, n: h.n, len: h.len, sha256: h.sha256 };
}

/**
 * Reassembles `head` + `chunks` back into the original string, throwing
 * `StoreCorruptError` on a malformed head, a missing chunk, a chunk-count
 * mismatch, a length mismatch or a digest mismatch — never a partial string.
 */
export function reassembleSecret(
  head: unknown,
  chunks: readonly (Uint8Array | undefined)[],
): string {
  const parsed = parseBlobHead(head);
  if (parsed === undefined) throw new StoreCorruptError();
  if (chunks.length !== parsed.n) throw new StoreCorruptError();

  let total = 0;
  for (const chunk of chunks) {
    if (chunk === undefined) throw new StoreCorruptError();
    total += chunk.length;
  }
  if (total !== parsed.len) throw new StoreCorruptError();

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    // Narrowed above: the undefined check already threw for any missing chunk.
    bytes.set(chunk as Uint8Array, offset);
    offset += (chunk as Uint8Array).length;
  }

  if (createHash("sha256").update(bytes).digest("hex") !== parsed.sha256) {
    throw new StoreCorruptError();
  }
  return decoder.decode(bytes);
}
