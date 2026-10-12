import { assertValidSecretKey, assertValidSecretPrefix } from "../../src/ports/secret-store.js";
import type { SecretStore } from "../../src/ports/secret-store.js";
import { createInMemorySecretStore, createSecretStoreContractTests } from "../../src/testing.js";

/**
 * A second implementation written only from the `SecretStore` type: a plain
 * object over a Map that calls the exported validators. Passing the shared
 * suite proves a platform builder can implement the port from the published
 * types alone.
 */
function makeIndependentSecretStore(): SecretStore {
  const data = new Map<string, string>();
  return {
    async get(key) {
      await Promise.resolve();
      assertValidSecretKey(key);
      return data.get(key);
    },
    async put(key, value) {
      await Promise.resolve();
      assertValidSecretKey(key);
      data.set(key, value);
    },
    async delete(key) {
      await Promise.resolve();
      assertValidSecretKey(key);
      data.delete(key);
    },
    async deletePrefix(prefix) {
      await Promise.resolve();
      assertValidSecretPrefix(prefix);
      const doomed = [...data.keys()].filter((k) => k.startsWith(prefix));
      for (const k of doomed) data.delete(k);
      return doomed.length;
    },
  };
}

createSecretStoreContractTests(() => createInMemorySecretStore());
createSecretStoreContractTests(() => makeIndependentSecretStore());
