/**
 * `KeychainBinding` — the tiny async surface the keychain `SecretStore` drives,
 * the production binding backed by the native OS keyring addon, and the single
 * shared `probeKeychain` health check.
 *
 * The native addon is loaded with a dynamic `import(...)` on FIRST use ONLY. A
 * top-level import of a native module would run its binding load at process
 * start, breaking `--help`, the test run and every unsupported architecture —
 * none of which touch the keychain.
 *
 * Every entry is constructed with the Linux `secret-service` store pinned, so
 * Linux never silently falls back to the in-memory kernel keyutils keyring
 * (which would lose secrets across processes). Values move through
 * setSecret/getSecret/deleteCredential as raw bytes, never the password API: a
 * value written with setSecret cannot be read back through getPassword.
 */

import { randomBytes } from "node:crypto";

/** The minimal keychain surface the store drives; the test fake implements the same shape. */
export interface KeychainBinding {
  /** Stores `bytes` under (service, account), replacing any previous value. */
  set(service: string, account: string, bytes: Uint8Array): Promise<void>;
  /** The stored bytes, or `undefined` when the entry is absent. */
  get(service: string, account: string): Promise<Uint8Array | undefined>;
  /**
   * Deletes the entry. Resolves `true` when a credential was removed and
   * `false` when none existed; REJECTS on a real store failure (let it
   * propagate — a failed delete is never reported as `false`).
   */
  delete(service: string, account: string): Promise<boolean>;
}

type KeyringModule = typeof import("@napi-rs/keyring");

let modulePromise: Promise<KeyringModule> | undefined;

/** Loads the native addon once, on first use, memoising the in-flight promise. */
function loadKeyring(): Promise<KeyringModule> {
  modulePromise ??= import("@napi-rs/keyring");
  return modulePromise;
}

/** The production `KeychainBinding`, backed by the OS keychain through the native addon. */
export function createKeychainBinding(): KeychainBinding {
  async function entryFor(service: string, account: string) {
    const { AsyncEntry } = await loadKeyring();
    // Pin the Linux store so an unavailable Secret Service throws instead of
    // falling back to the volatile keyutils keyring.
    return new AsyncEntry(service, account, { linux: { store: "secret-service" } });
  }

  return {
    async set(service, account, bytes): Promise<void> {
      await (await entryFor(service, account)).setSecret(bytes);
    },

    async get(service, account): Promise<Uint8Array | undefined> {
      // getSecret resolves null when absent; Array.isArray treats null (and a
      // defensive undefined) alike as "no value", never a native/OS surprise.
      const secret = await (await entryFor(service, account)).getSecret();
      return Array.isArray(secret) ? Uint8Array.from(secret) : undefined;
    },

    async delete(service, account): Promise<boolean> {
      return (await entryFor(service, account)).deleteCredential();
    },
  };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * The SOLE keychain health probe. Later plans and the gated store tests import
 * THIS probe; they never re-implement it. Round-trips a random throwaway
 * account — set → get → byte-equals → delete (cleanup in a `finally` that
 * swallows errors) — and resolves `true` only on an exact match. Any throw
 * resolves `false`. Native/OS error text is never surfaced.
 */
export async function probeKeychain(binding: KeychainBinding, service: string): Promise<boolean> {
  const account = `probe-${randomBytes(16).toString("hex")}`;
  const value = randomBytes(32);
  try {
    await binding.set(service, account, value);
    const read = await binding.get(service, account);
    return read !== undefined && bytesEqual(read, value);
  } catch {
    return false;
  } finally {
    try {
      await binding.delete(service, account);
    } catch {
      // Best-effort cleanup only; a probe never surfaces a teardown failure.
    }
  }
}
