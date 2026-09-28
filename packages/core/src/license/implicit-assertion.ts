/**
 * The single shared implicit-assertion derivation for PASETO v4.public
 * hosted licenses (D-13, LIC-01, LIC-02). `issue.ts` and `verify.ts` both
 * import this -- and only this -- function; a license issued under one
 * lease id or spec version can never verify under another, and a
 * hand-recomputed second derivation (even one differing only in key order
 * or whitespace) would silently break every verification.
 *
 * `specVersion` is the MANIFEST's own `spec_version` field, never
 * `@stint/spec`'s runtime `SPEC_VERSION` constant (03-05 Task 2 decision):
 * a license verifies against the manifest's declared version, not whatever
 * version the verifying runtime build happens to be running.
 */

import { canonicalize } from "@stint/spec";

/**
 * Derives the exact UTF-8 canonical (RFC 8785 JCS, via `@stint/spec`)
 * bytes of `{ lease_id, spec_version }` -- the PASETO v4.public implicit
 * assertion for a hosted license. Identical inputs produce identical
 * bytes; changing either input changes the derived bytes.
 */
export function deriveImplicitAssertion(leaseId: string, specVersion: string): Uint8Array {
  const canonicalText = canonicalize({ lease_id: leaseId, spec_version: specVersion });
  return new TextEncoder().encode(canonicalText);
}
