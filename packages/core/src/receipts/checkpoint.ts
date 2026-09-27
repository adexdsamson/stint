/**
 * Ed25519-signed chain checkpoints (D-06, D-07, RCPT-03).
 *
 * Mirrors `packages/spec/src/jws.ts`'s detached-EdDSA sign/verify shape
 * exactly: one shared protected-header constant computed once at module
 * scope (never reconstructed per call site — the exact "compute a
 * security-relevant blob in two places" footgun that file's own docstring
 * warns about), and a verify function that collapses every failure mode
 * (wrong key, tampered summary, malformed signature) to a single fixed
 * outcome, never forwarding jose's exception text (T-01-15, D-16).
 *
 * The checkpoint summary — `{ chain, count, headHash, ts }` — is hashed
 * through the SAME `@stint/spec` canonical serializer `chain.ts` uses for
 * every receipt entry (D-05): no second serializer, no ad hoc
 * `JSON.stringify` anywhere in the receipt path. Both `privateKey` and
 * `publicKey` are always caller-supplied `CryptoKey` parameters — `@stint/
 * core` never hard-wires or reads a checkpoint keypair from disk/env (D-07).
 */

import { FlattenedSign, flattenedVerify, base64url } from "jose";
import type { CryptoKey } from "jose";

import { canonicalize } from "@stint/spec";
import type { Checkpoint } from "@stint/spec";

/** The one shared checkpoint protected header — computed once, mirrors `packages/spec/src/jws.ts`'s `JWS_PROTECTED_HEADER`. */
export const CHECKPOINT_HEADER = { alg: "EdDSA" } as const;

/** `base64url(JSON.stringify(CHECKPOINT_HEADER))` — computed once, from the one shared constant. */
const CHECKPOINT_HEADER_B64: string = base64url.encode(JSON.stringify(CHECKPOINT_HEADER));

/** The exact UTF-8 canonical bytes signed/verified for a checkpoint summary — the single derivation shared by sign and verify. */
function checkpointSigningBytes(
  chainKind: Checkpoint["chain"],
  count: number,
  headHash: string,
  ts: number,
): Uint8Array {
  const summary = { chain: chainKind, count, headHash, ts };
  return new TextEncoder().encode(canonicalize(summary));
}

/**
 * Signs `{ chain: chainKind, count, headHash, ts: now }` as a detached
 * EdDSA signature over its `@stint/spec` canonical bytes, returning the
 * complete `Checkpoint` value (summary fields plus `sig`). `privateKey` is
 * injected by the caller — never read from disk/env inside `@stint/core`
 * (D-07).
 */
export async function signCheckpoint(
  chainKind: Checkpoint["chain"],
  count: number,
  headHash: string,
  now: number,
  privateKey: CryptoKey,
): Promise<Checkpoint> {
  const bytes = checkpointSigningBytes(chainKind, count, headHash, now);
  const jws = await new FlattenedSign(bytes).setProtectedHeader(CHECKPOINT_HEADER).sign(privateKey);
  return { chain: chainKind, count, headHash, ts: now, sig: jws.signature };
}

/**
 * Verifies `checkpoint.sig` as a detached EdDSA signature over the
 * `@stint/spec` canonical bytes recomputed from `checkpoint`'s own
 * `chain`/`count`/`headHash`/`ts` fields. Never throws — every failure mode
 * (wrong key, a mutated summary field, a malformed signature) resolves to
 * `false`, mirroring `packages/spec/src/jws.ts`'s `verifyDetached` exactly
 * (T-01-15, D-16): jose's exception text is never surfaced to the caller.
 */
export async function verifyCheckpoint(
  checkpoint: Checkpoint,
  publicKey: CryptoKey,
): Promise<boolean> {
  try {
    const bytes = checkpointSigningBytes(
      checkpoint.chain,
      checkpoint.count,
      checkpoint.headHash,
      checkpoint.ts,
    );
    await flattenedVerify(
      {
        protected: CHECKPOINT_HEADER_B64,
        payload: base64url.encode(bytes),
        signature: checkpoint.sig,
      },
      publicKey,
      { algorithms: ["EdDSA"] },
    );
    return true;
  } catch {
    return false;
  }
}
