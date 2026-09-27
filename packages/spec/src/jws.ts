/**
 * One shared protected-header constant and detached EdDSA sign/verify (D-03).
 *
 * Internal only — never re-exported from `./index.ts`. Both `testing.ts`
 * (signing) and `envelope.ts` (verification) import this module, so the
 * header literal exists exactly once in the codebase (RESEARCH Pitfall 5:
 * reconstructing this per call site risks the exact "compute a
 * security-relevant blob in two places" mistake this file exists to avoid).
 *
 * Signature format (follows RFC 7515 Appendix F "detached content", per
 * CONTEXT.md canonical_refs — NOT RFC 7797's `b64: false` unencoded-payload
 * mode, which needs `crit` header support some non-TypeScript JOSE libraries
 * lack): the envelope carries only `signature.sig`; the protected header and
 * payload are both re-derived by the verifier from the manifest and this
 * constant, never stored.
 */

import { FlattenedSign, flattenedVerify, base64url } from "jose";
import type { CryptoKey } from "jose";

/** The one shared JWS protected header — a content-free constant (no `kid`; that lives on the envelope's own `signature.kid`, D-04). */
export const JWS_PROTECTED_HEADER = { alg: "EdDSA" } as const;

/** `base64url(JSON.stringify(JWS_PROTECTED_HEADER))` — computed once, from the one shared constant. */
export const JWS_PROTECTED_B64: string = base64url.encode(JSON.stringify(JWS_PROTECTED_HEADER));

/**
 * Signs `payload` (the UTF-8 bytes of `canonicalize(manifest)`) as a
 * detached EdDSA signature. Returns only the base64url signature — the
 * protected header and payload are never carried in the result (RFC 7515
 * Appendix F).
 */
export async function signDetached(payload: Uint8Array, privateKey: CryptoKey): Promise<string> {
  const jws = await new FlattenedSign(payload).setProtectedHeader(JWS_PROTECTED_HEADER).sign(privateKey);
  return jws.signature;
}

/**
 * Verifies a detached EdDSA signature over `payload` (the UTF-8 bytes of
 * `canonicalize(manifest)`). Never throws — any verification failure
 * (wrong key, tampered payload, malformed signature) resolves to `false`, so
 * callers can map every failure mode to the same fixed `invalid_signature`
 * error without ever forwarding jose's exception text (T-01-15).
 */
export async function verifyDetached(payload: Uint8Array, signature: string, publicKey: CryptoKey): Promise<boolean> {
  try {
    await flattenedVerify(
      { protected: JWS_PROTECTED_B64, payload: base64url.encode(payload), signature },
      publicKey,
      { algorithms: ["EdDSA"] },
    );
    return true;
  } catch {
    return false;
  }
}
