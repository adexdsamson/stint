/**
 * `createDefaultSecretStore` - backend selection for the CLI's secret custody
 * (KEYC-02/03/04; D-02, D-03, D-04).
 *
 * The default is the OS keychain. `STINT_SECRET_STORE=file` is the one explicit
 * opt-in to the plaintext file store; any other value (or none) selects the
 * keychain-primary composite. The composite never writes through to the file
 * store: `put` goes to the keychain ONLY. `get` falls through to the file store
 * so a lease sealed before the flip keeps reading (D-04, no migration), and
 * `delete`/`deletePrefix` run against BOTH so a legacy file-only lease tears
 * down even with the keychain unavailable (the keychain store is index-driven,
 * so a lease with no index makes no binding call).
 *
 * Fail closed: if the keychain throws and the legacy file store has no value,
 * the keychain error is rethrown rather than reported as "absent".
 * `assertSecretStoreAvailable` probes the keychain once per process through the
 * shared `probeKeychain` and refuses with a fixed message that never carries
 * native/OS text.
 */

import type { SecretStore } from "@stint/core";

import { CliError, EXIT_CODES } from "../exit.js";
import { createFileSecretStore } from "./file-secret-store.js";
import { createKeychainBinding, probeKeychain } from "./keychain-binding.js";
import type { KeychainBinding } from "./keychain-binding.js";
import { createKeychainSecretStore } from "./keychain-secret-store.js";

/** Which custody a resolved store provides; mirrors the consent custody `storage` tags. */
export type SecretBackend = "os_keychain" | "plaintext_file";

/** The keychain service name the keychain store defaults to; the probe uses the same one. */
const DEFAULT_SERVICE = "stint";

export const KEYCHAIN_UNAVAILABLE_MESSAGE =
  "The operating-system keychain is not available. Set STINT_SECRET_STORE=file to store credentials in a plaintext file instead.";

/** The backend `STINT_SECRET_STORE` selects: `file` opts in to plaintext; everything else is the keychain. */
export function resolveSecretBackend(env: Readonly<Record<string, string | undefined>>): SecretBackend {
  return env.STINT_SECRET_STORE === "file" ? "plaintext_file" : "os_keychain";
}

export interface DefaultSecretStoreOptions {
  readonly root: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: string;
  /** Test seam: the keychain binding. Production leaves it unset (the native binding, loaded lazily). */
  readonly binding?: KeychainBinding;
  /** Called once per successful plaintext-file `put` (seed AND refresh write-back). Never called for the keychain. */
  readonly onPlaintextWrite?: () => void;
}

export interface DefaultSecretStore {
  readonly store: SecretStore;
  readonly backend: SecretBackend;
}

function createCompositeStore(primary: SecretStore, legacy: SecretStore): SecretStore {
  return {
    async get(key: string): Promise<string | undefined> {
      let failed = false;
      let failure: unknown;
      try {
        const value = await primary.get(key);
        if (value !== undefined) return value;
      } catch (e) {
        failed = true;
        failure = e;
      }
      const legacyValue = await legacy.get(key);
      if (legacyValue !== undefined) return legacyValue;
      // Fail closed: a keychain error is never turned into "no such secret".
      if (failed) throw failure;
      return undefined;
    },

    put(key: string, value: string): Promise<void> {
      return primary.put(key, value);
    },

    // Sequential, keychain first: the file store's prefix removal wipes the lease's
    // secrets directory, which also holds the keychain index and lock, so the two
    // must never run at once. A keychain failure stops here and leaves the file
    // store (and with it the index) untouched, so the teardown can be retried.
    async delete(key: string): Promise<void> {
      await primary.delete(key);
      await legacy.delete(key);
    },

    async deletePrefix(prefix: string): Promise<number> {
      const fromKeychain = await primary.deletePrefix(prefix);
      return fromKeychain + (await legacy.deletePrefix(prefix));
    },
  };
}

function withPlaintextWriteNotice(inner: SecretStore, onWrite: () => void): SecretStore {
  return {
    get: (key) => inner.get(key),
    async put(key, value) {
      await inner.put(key, value);
      onWrite();
    },
    delete: (key) => inner.delete(key),
    deletePrefix: (prefix) => inner.deletePrefix(prefix),
  };
}

export function createDefaultSecretStore(opts: DefaultSecretStoreOptions): DefaultSecretStore {
  const { root } = opts;
  const backend = resolveSecretBackend(opts.env);

  if (backend === "plaintext_file") {
    const file = createFileSecretStore({ root });
    const store =
      opts.onPlaintextWrite === undefined ? file : withPlaintextWriteNotice(file, opts.onPlaintextWrite);
    return { store, backend };
  }

  const primary = createKeychainSecretStore({
    root,
    ...(opts.binding === undefined ? {} : { binding: opts.binding }),
  });
  return { store: createCompositeStore(primary, createFileSecretStore({ root })), backend };
}

/** The per-process probe verdicts, keyed by root + service + backend. */
const verdicts = new Map<string, Promise<boolean>>();

export interface SecretStoreAvailabilityOptions {
  readonly root: string;
  /** The RESOLVED backend (callers pass `deps.secretBackend ?? "plaintext_file"`), never re-read from env. */
  readonly backend: SecretBackend;
  readonly platform: string;
  /** Test seam: the keychain binding. Production leaves it unset. */
  readonly binding?: KeychainBinding;
}

/**
 * Resolves when the active backend can hold a secret; rejects with a fixed
 * `CliError` otherwise. The plaintext file backend needs no probe and touches
 * no binding. The keychain verdict is computed once per process.
 */
export async function assertSecretStoreAvailable(opts: SecretStoreAvailabilityOptions): Promise<void> {
  if (opts.backend === "plaintext_file") return;

  const cacheKey = `${opts.root}\u0000${DEFAULT_SERVICE}\u0000${opts.backend}`;
  let verdict = verdicts.get(cacheKey);
  if (verdict === undefined) {
    verdict = probeKeychain(opts.binding ?? createKeychainBinding(), DEFAULT_SERVICE);
    verdicts.set(cacheKey, verdict);
  }
  if (!(await verdict)) throw new CliError(EXIT_CODES.internal, KEYCHAIN_UNAVAILABLE_MESSAGE);
}
