/**
 * The single shared implicit-assertion derivation for PASETO v4.public
 * hosted licenses (D-13, LIC-01, LIC-02). `issue.ts` and `verify.ts` both
 * import this -- and only this -- function; a license issued under one
 * lease id or spec version can never verify under another, and a
 * hand-recomputed second derivation (even one differing only in key order
 * or whitespace) would silently break every verification.
 *
 * RED phase stub (03-05 Task 3): throws until implemented.
 */

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function deriveImplicitAssertion(leaseId: string, specVersion: string): Uint8Array {
  throw new Error("not implemented");
}
