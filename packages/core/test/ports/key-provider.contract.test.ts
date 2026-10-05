import { calculateJwkThumbprint, exportJWK, generateKeyPair } from "jose";

import type { KeyProvider, RuntimeKey, RuntimePublicJwk } from "../../src/ports/key-provider.js";
import { createInMemoryKeyProvider, createKeyProviderContractTests } from "../../src/testing.js";

/**
 * A second implementation written only from the `KeyProvider` type and `jose`.
 * Passing the shared suite proves a platform builder can implement the port
 * from the published types alone.
 */
function makeIndependentKeyProvider(): KeyProvider {
  let created: Promise<RuntimeKey> | undefined;
  return {
    loadOrCreate() {
      created ??= generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true }).then(async (pair) => {
        const jwk = await exportJWK(pair.publicKey);
        const publicJwk: RuntimePublicJwk = { kty: "OKP", crv: "Ed25519", x: String(jwk.x) };
        return {
          privateKey: pair.privateKey,
          publicKey: pair.publicKey,
          publicJwk,
          kid: await calculateJwkThumbprint(publicJwk),
        };
      });
      return created;
    },
    async loadVerificationKeys() {
      if (created === undefined) return [];
      const key = await created;
      return [{ kid: key.kid, publicKey: key.publicKey, publicJwk: key.publicJwk }];
    },
  };
}

createKeyProviderContractTests(() => createInMemoryKeyProvider());
createKeyProviderContractTests(() => makeIndependentKeyProvider());
