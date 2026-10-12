/**
 * The `KeyProvider` port (RT-02). Supplies the runtime's Ed25519 checkpoint
 * signing key and the public keys a verifier may use.
 *
 * `loadVerificationKeys` returns a list so key rotation by `kid` needs no port
 * change later; in this phase it holds zero entries (no key created yet) or one.
 * A public JWK never carries the private `d` member.
 */

import type { CryptoKey } from "jose";

/** Public half in its minimal JWK form (never carries `d`). */
export interface RuntimePublicJwk {
  readonly kty: "OKP";
  readonly crv: "Ed25519";
  readonly x: string;
}

/** The loaded runtime key pair. `kid` is the RFC 7638 thumbprint of the public key. */
export interface RuntimeKey {
  readonly privateKey: CryptoKey;
  readonly publicKey: CryptoKey;
  readonly publicJwk: RuntimePublicJwk;
  readonly kid: string;
}

/** The public half of a runtime key, enough to verify a checkpoint. */
export interface RuntimeVerificationKey {
  readonly kid: string;
  readonly publicKey: CryptoKey;
  readonly publicJwk: RuntimePublicJwk;
}

/** Source of the runtime signing key. */
export interface KeyProvider {
  /**
   * The signing key pair, created on first use. Repeated and concurrent calls
   * resolve the same key (same `kid`).
   */
  loadOrCreate(): Promise<RuntimeKey>;
  /** Every public key a verifier may use; an empty array before any key exists. */
  loadVerificationKeys(): Promise<readonly RuntimeVerificationKey[]>;
}
