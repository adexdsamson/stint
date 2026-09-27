/**
 * `verifyBoundHash` — the single shared pure hash guard consumed by both
 * `activateLease` and `resumeLease` (D-20, D-21). A `Lease` persists only
 * the prefixed `jcs-sha256:` content-hash string captured at consent
 * (D-20); this guard recomputes the presented `VerifiedManifest`'s content
 * hash via `@stint/spec`'s `hashManifest` — the single serializer (ALP.md
 * Section 5) — and does a plain string compare against the bound hash. It
 * re-implements no canonicalization or hashing.
 *
 * Deliberately trusts no caller-supplied hash field: it recomputes from
 * `verifiedManifest.manifest`, never reads `verifiedManifest.contentHash`,
 * so a tampered `.contentHash` cannot make a mismatched manifest pass.
 *
 * One job, no `Result` wrapper, no throw for a mismatch (mirrors
 * `@stint/spec`'s `isContentHash` style) — each caller (`activateLease`,
 * `resumeLease`) decides what a `false` means: activation mismatch emits
 * `activation_failed`, resume mismatch emits `runtime_failure`.
 */

import { hashManifest } from "@stint/spec";
import type { VerifiedManifest } from "@stint/spec";

export function verifyBoundHash(boundHash: string, verifiedManifest: VerifiedManifest): boolean {
  const computed = hashManifest(verifiedManifest.manifest);
  return computed === boundHash;
}
