/**
 * Independent verification of the attested receipt chain, reusing
 * `@stint/spec`'s trust model (D-07, RCPT-04).
 *
 * An `attested_claim` entry's payload carries `publisherId`, `kid`,
 * `claimType`, `claimHash`, and `sig` — the publisher's detached EdDSA
 * signature over the canonical (`@stint/spec` `canonicalize`) bytes of
 * `{ publisherId, kid, claimType, claimHash }`. `verifyAttestedEntry`
 * resolves the publisher's Ed25519 public key from the caller-supplied
 * `TrustStore` by `publisherId` then `kid` — the exact same two-level
 * lookup `verifyEnvelope` performs for manifest signatures — and verifies
 * the signature via `@stint/spec`'s exported `verifyDetached`, the SAME
 * function `verifyEnvelope` itself calls. This file defines no second
 * Ed25519 verify path: an unknown publisher, an unknown kid, a malformed
 * trust-store entry, a wrong key, or a tampered claim all resolve to
 * `false`, and jose's own exception text is never surfaced (T-01-15, D-16).
 *
 * `verifyAttestedChain` reuses `verifyChain` from `chain.ts` UNMODIFIED for
 * the hash-link walk (never re-implemented here), then additionally checks
 * every `attested_claim` entry's publisher signature. The attested chain's
 * integrity — its hash links, its own checkpoint — is entirely its own;
 * this function never reads, accepts, or is affected by a verified chain's
 * state (D-07). A weak attested claim can never borrow the verified
 * chain's cryptographic strength, and the two chains' verification
 * outcomes are computed completely independently of one another.
 */

import { importJWK } from "jose";
import type { CryptoKey } from "jose";

import { canonicalize, verifyDetached } from "@stint/spec";
import type { Checkpoint, Ed25519PublicJwk, ReceiptEntry, TrustStore } from "@stint/spec";
import type { AttestedClaimEntry, AttestedClaimPayload } from "@stint/spec";

import { verifyChain } from "./chain.js";
import type { Result } from "./errors.js";

/** Looks up `key` as an OWN property of `record` — never a bare bracket access alone, mirroring `envelope.ts`'s `ownEntry` so a prototype-named key (`__proto__`, `constructor`) can never reach `Object.prototype`. */
function ownEntry(record: object, key: string): unknown {
  if (!Object.hasOwn(record, key)) return undefined;
  return (record as Record<string, unknown>)[key];
}

/** Validates a trust-store entry's shape and returns only `{ kty, crv, x }` — mirrors `envelope.ts`'s `readEd25519PublicJwk` exactly (never a stray private "d" member). */
function readEd25519PublicJwk(candidateRaw: unknown): Ed25519PublicJwk | null {
  if (typeof candidateRaw !== "object" || candidateRaw === null) return null;
  const candidate = candidateRaw as Record<string, unknown>;
  if (candidate.kty !== "OKP" || candidate.crv !== "Ed25519" || typeof candidate.x !== "string") return null;
  return { kty: "OKP", crv: "Ed25519", x: candidate.x };
}

function isAttestedClaimEntry(entry: ReceiptEntry): entry is AttestedClaimEntry {
  return entry.type === "attested_claim";
}

/** The exact canonical bytes a publisher signs/verifies for an attested claim — the single derivation this file uses for both the trust lookup and the signature check (mirrors `checkpoint.ts`'s `checkpointSigningBytes`). */
function attestedClaimSigningBytes(payload: AttestedClaimPayload): Uint8Array {
  const { publisherId, kid, claimType, claimHash } = payload;
  return new TextEncoder().encode(canonicalize({ publisherId, kid, claimType, claimHash }));
}

/**
 * Verifies a single `attested_claim` entry's publisher signature against
 * `trustStore`. Resolves the Ed25519 public key by `payload.publisherId`
 * then `payload.kid`; an unknown publisher, an unknown kid, a malformed
 * JWK, or a signature that fails to verify (wrong key or tampered payload)
 * all resolve to `false` — never throws, never forwards jose's exception
 * text.
 */
export async function verifyAttestedEntry(
  entry: AttestedClaimEntry,
  trustStore: TrustStore,
): Promise<boolean> {
  const publisherEntryRaw = ownEntry(trustStore, entry.payload.publisherId);
  if (typeof publisherEntryRaw !== "object" || publisherEntryRaw === null) return false;

  const kidEntryRaw = ownEntry(publisherEntryRaw, entry.payload.kid);
  const publicJwk = readEd25519PublicJwk(kidEntryRaw);
  if (publicJwk === null) return false;

  const bytes = attestedClaimSigningBytes(entry.payload);

  try {
    const publicKey = await importJWK(publicJwk, "EdDSA");
    return await verifyDetached(bytes, entry.payload.sig, publicKey);
  } catch {
    return false;
  }
}

/**
 * Verifies an attested chain (every entry's `chain` field is `"attested"`):
 * the same hash-link walk `verifyChain` performs (reused unmodified,
 * D-04/D-05), plus every `attested_claim` entry's publisher signature. The
 * first failure of either kind is returned with its exact `brokenAtSeq`
 * (a publisher-signature failure reports `"claim_sig_invalid"`). Optional
 * `checkpoint`/`checkpointPublicKey` anchor this attested chain to its OWN
 * signed checkpoint — never the verified chain's — exactly as `verifyChain`
 * already does for any single chain.
 */
export async function verifyAttestedChain(
  chain: readonly ReceiptEntry[],
  trustStore: TrustStore,
  checkpoint?: Checkpoint,
  checkpointPublicKey?: CryptoKey,
): Promise<Result<{ headHash: string; count: number }>> {
  const hashResult = await verifyChain(chain, checkpoint, checkpointPublicKey);
  if (!hashResult.ok) return hashResult;

  for (const entry of chain) {
    if (!isAttestedClaimEntry(entry)) continue;
    const sigOk = await verifyAttestedEntry(entry, trustStore);
    if (!sigOk) {
      return { ok: false, errors: [{ brokenAtSeq: entry.seq, reason: "claim_sig_invalid" }] };
    }
  }

  return hashResult;
}
