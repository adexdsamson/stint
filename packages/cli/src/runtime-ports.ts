/**
 * `buildRuntimePorts` - the CLI's single place that turns `CliDeps` plus a store
 * root into the `RuntimePorts` bundle `@stint/runtime` consumes (D-24). Each
 * storage port prefers its optional `CliDeps` seam and otherwise falls back to
 * the file-backed implementation under the store root.
 */

import { calculateJwkThumbprint, exportJWK } from "jose";
import type { CryptoKey } from "jose";

import type { KeyProvider, RuntimePublicJwk, RuntimeVerificationKey } from "@stint/core";
import type { RuntimePorts } from "@stint/runtime";

import type { CliDeps } from "./deps.js";
import { StoreCorruptError } from "./store/atomic-file.js";
import { createFileLeaseArtifactStore } from "./store/file-artifact-store.js";
import { createFileSecretStore } from "./store/file-secret-store.js";

/**
 * A `KeyProvider` over the injected `deps.keys` seams, so a test that replaces
 * `deps.keys` still controls the key. With the default file functions this is
 * equivalent to `createFileKeyProvider(root)`.
 */
function keyProviderFrom(deps: Pick<CliDeps, "keys">, root: string): KeyProvider {
  let pending: ReturnType<typeof deps.keys.loadOrCreate> | undefined;

  return {
    loadOrCreate() {
      if (pending === undefined) {
        const attempt = deps.keys.loadOrCreate(root);
        pending = attempt;
        attempt.catch(() => {
          if (pending === attempt) pending = undefined;
        });
      }
      return pending;
    },

    async loadVerificationKeys(): Promise<readonly RuntimeVerificationKey[]> {
      let publicKey: CryptoKey;
      try {
        publicKey = await deps.keys.loadPublic(root);
      } catch (e) {
        // An absent public file is a plain internal CliError (no key yet); corruption must surface.
        if (e instanceof StoreCorruptError) throw e;
        return [];
      }
      const jwk = await exportJWK(publicKey);
      if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string") {
        throw new StoreCorruptError();
      }
      const publicJwk: RuntimePublicJwk = { kty: "OKP", crv: "Ed25519", x: jwk.x };
      return [{ kid: await calculateJwkThumbprint(publicJwk), publicKey, publicJwk }];
    },
  };
}

export function buildRuntimePorts(
  deps: CliDeps,
  root: string,
  opts?: { readonly trust?: string | undefined },
): RuntimePorts {
  return {
    leases: deps.storeFactory(root),
    receipts: (leaseId) => deps.receiptStoreFactory(root, leaseId),
    clock: deps.clock,
    ...(deps.telemetry === undefined ? {} : { telemetry: deps.telemetry }),
    secrets: deps.secrets?.(root) ?? createFileSecretStore({ root }),
    artifacts: deps.artifacts?.(root) ?? createFileLeaseArtifactStore({ root }),
    keys: deps.keyProvider?.(root) ?? keyProviderFrom(deps, root),
    trust: () => deps.loadTrustStore(root, { trust: opts?.trust }),
  };
}
