/**
 * `createKeychainSecretStore` — the keychain-backed `SecretStore` (RT-02).
 *
 * The value of a logical key is split into:
 *   - a HEAD entry in service `service`, account = the validated full key, whose
 *     bytes are the JSON integrity head (`{ v, n, len, sha256 }`); and
 *   - N CHUNK entries in a SEPARATE service `service + ".chunk"`, account =
 *     `KEY + "#" + i` for i in 0..N-1.
 *
 * A per-lease index file (`.keychain-index.json`) records, per full key, the
 * chunk high-water mark — the most chunks that key has ever had — so teardown
 * can delete every chunk without enumerating the keychain (OS keychains cannot
 * be listed). The index stores NAMES and counts only, never a value.
 *
 * Mutations run under a per-lease in-process queue and a cross-process file
 * lock (`.keychain.lock`), both keyed by lease, mirroring the file store.
 * `put` persists the raised high-water BEFORE touching chunks and writes the
 * head LAST, so a crash never leaves a head that points past its chunks.
 *
 * Fail-closed threat model: the key is validated before any backend call; the
 * index and lock hold names only (mode 0600 where honoured); SHA-256 and length
 * are verified on every read; and every error is fixed
 * `CliError`/`SecretKeyError`/`StoreCorruptError` text — never a key, value,
 * path or native/OS string.
 */

import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";

import { SecretKeyError, assertValidSecretKey, assertValidSecretPrefix } from "@stint/core";
import type { SecretStore } from "@stint/core";

import { assertSafeLeaseId, leaseSecretsDir } from "../paths.js";
import {
  StoreCorruptError,
  atomicWriteJson,
  createKeyedQueue,
  readJsonRetry,
  withFileLock,
  withTransientRetry,
} from "./atomic-file.js";
import type { FileLockOptions } from "./atomic-file.js";
import { createKeychainBinding } from "./keychain-binding.js";
import type { KeychainBinding } from "./keychain-binding.js";
import { parseBlobHead, reassembleSecret, splitSecret } from "./keychain-blob.js";

export interface KeychainSecretStoreOptions {
  /** Store root directory; holds the per-lease index and lock under `secrets/lease/<id>/`. */
  readonly root: string;
  /** Keychain service name for head entries (default `"stint"`); chunks use `service + ".chunk"`. */
  readonly service?: string;
  /** The keychain binding; defaults to the production native binding. Tests inject a fake. */
  readonly binding?: KeychainBinding;
  /** Total wait for a contended lease lock before `LeaseBusyError` (default 30s). */
  readonly lockTimeoutMs?: number;
}

const INDEX_FILE = ".keychain-index.json";
const LOCK_FILE = ".keychain.lock";
const INDEX_MODE = 0o600;
const DIR_MODE = 0o700;

/** How many times `get` re-reads a head when a read looks mid-write before giving up. */
const GET_ATTEMPTS = 5;
const GET_RETRY_MS = 10;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8");

/** `{ v: 1, keys: { <full key>: <chunk high-water> } }`. */
interface KeychainIndex {
  v: 1;
  keys: Record<string, number>;
}

function errnoCode(e: unknown): string | undefined {
  if (typeof e === "object" && e !== null && "code" in e) {
    const code = e.code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/** Splits a validated key or prefix body into the lease id and the remaining segments. */
function splitUnderLease(segments: readonly string[]): { leaseId: string; rest: string[] } {
  const [first, leaseId, ...rest] = segments;
  if (first !== "lease" || leaseId === undefined) throw new SecretKeyError();
  try {
    assertSafeLeaseId(leaseId);
  } catch {
    throw new SecretKeyError();
  }
  return { leaseId, rest };
}

function isIndex(value: unknown): value is KeychainIndex {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const i = value as Record<string, unknown>;
  if (i.v !== 1) return false;
  if (typeof i.keys !== "object" || i.keys === null || Array.isArray(i.keys)) return false;
  for (const count of Object.values(i.keys as Record<string, unknown>)) {
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0) return false;
  }
  return true;
}

async function readIndex(file: string): Promise<KeychainIndex> {
  const raw = await readJsonRetry(file);
  if (raw === undefined) return { v: 1, keys: {} };
  if (!isIndex(raw)) throw new StoreCorruptError();
  return raw;
}

async function exists(target: string): Promise<boolean> {
  try {
    await withTransientRetry(() => stat(target));
    return true;
  } catch (e) {
    if (errnoCode(e) === "ENOENT") return false;
    throw e;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createKeychainSecretStore(opts: KeychainSecretStoreOptions): SecretStore {
  const { root } = opts;
  const service = opts.service ?? "stint";
  const chunkService = `${service}.chunk`;
  const binding = opts.binding ?? createKeychainBinding();
  const lockOpts: FileLockOptions =
    opts.lockTimeoutMs === undefined ? {} : { timeoutMs: opts.lockTimeoutMs };
  const runSerialized = createKeyedQueue();

  function chunkAccount(key: string, i: number): string {
    return `${key}#${String(i)}`;
  }

  /** Validates a key, enforces the `lease/<safe id>/<name...>` shape, and returns the lease id. */
  function leaseOf(key: string): string {
    assertValidSecretKey(key);
    const { leaseId, rest } = splitUnderLease(key.split("/"));
    if (rest.length < 1) throw new SecretKeyError();
    return leaseId;
  }

  function paths(leaseId: string): { dir: string; indexFile: string; lockFile: string } {
    const dir = leaseSecretsDir(root, leaseId);
    return {
      dir,
      indexFile: path.join(dir, INDEX_FILE),
      lockFile: path.join(dir, LOCK_FILE),
    };
  }

  async function persistIndex(indexFile: string, index: KeychainIndex): Promise<void> {
    if (Object.keys(index.keys).length === 0) {
      await withTransientRetry(() => rm(indexFile, { force: true }));
      return;
    }
    await atomicWriteJson(indexFile, index, { mode: INDEX_MODE });
  }

  return {
    async get(key: string): Promise<string | undefined> {
      leaseOf(key);
      let lastError: unknown;
      for (let attempt = 0; attempt < GET_ATTEMPTS; attempt++) {
        const headBytes = await binding.get(service, key);
        if (headBytes === undefined) return undefined;

        let parsedHead: unknown;
        try {
          parsedHead = JSON.parse(decoder.decode(headBytes));
        } catch {
          // A torn head may be a concurrent write mid-flight; re-read.
          lastError = new StoreCorruptError();
          await sleep(GET_RETRY_MS);
          continue;
        }

        const head = parseBlobHead(parsedHead);
        if (head === undefined) {
          lastError = new StoreCorruptError();
          await sleep(GET_RETRY_MS);
          continue;
        }

        const chunks: (Uint8Array | undefined)[] = [];
        for (let i = 0; i < head.n; i++) {
          chunks.push(await binding.get(chunkService, chunkAccount(key, i)));
        }

        try {
          return reassembleSecret(head, chunks);
        } catch (e) {
          // The head may have been replaced since we read it; re-read and retry.
          lastError = e;
          await sleep(GET_RETRY_MS);
        }
      }
      throw lastError instanceof StoreCorruptError ? lastError : new StoreCorruptError();
    },

    async put(key: string, value: string): Promise<void> {
      const leaseId = leaseOf(key);
      const { dir, indexFile, lockFile } = paths(leaseId);
      const { head, chunks } = splitSecret(value);
      const n = chunks.length;

      await runSerialized(leaseId, async () => {
        await mkdir(dir, { recursive: true, mode: DIR_MODE });
        await withFileLock(
          lockFile,
          async (assertHeld) => {
            const index = await readIndex(indexFile);
            const prevHigh = index.keys[key] ?? 0;

            // (1) Raise the chunk high-water and persist BEFORE touching chunks,
            //     so a crash never leaves a head pointing past tracked chunks.
            index.keys[key] = Math.max(prevHigh, n);
            assertHeld();
            await atomicWriteJson(indexFile, index, { mode: INDEX_MODE });

            // (2) Write chunks 0..n-1.
            for (let i = 0; i < n; i++) {
              assertHeld();
              await binding.set(chunkService, chunkAccount(key, i), chunks[i] as Uint8Array);
            }

            // (3) Delete stale tail chunks n..prevHigh-1 (a shrink leaves none behind).
            for (let i = n; i < prevHigh; i++) {
              assertHeld();
              await binding.delete(chunkService, chunkAccount(key, i));
            }

            // (4) Write the head LAST — a reader only ever sees a head whose chunks exist.
            assertHeld();
            await binding.set(service, key, encoder.encode(JSON.stringify(head)));
          },
          lockOpts,
        );
      });
    },

    async delete(key: string): Promise<void> {
      const leaseId = leaseOf(key);
      const { indexFile, lockFile } = paths(leaseId);

      await runSerialized(leaseId, async () => {
        // No index → the key was never stored here; nothing to delete, no binding call.
        if (!(await exists(indexFile))) return;
        await withFileLock(
          lockFile,
          async (assertHeld) => {
            const index = await readIndex(indexFile);
            const high = index.keys[key];
            if (high === undefined) return;

            assertHeld();
            await binding.delete(service, key);
            for (let i = 0; i < high; i++) {
              assertHeld();
              await binding.delete(chunkService, chunkAccount(key, i));
            }

            index.keys = Object.fromEntries(Object.entries(index.keys).filter(([k]) => k !== key));
            assertHeld();
            await persistIndex(indexFile, index);
          },
          lockOpts,
        );
      });
    },

    async deletePrefix(prefix: string): Promise<number> {
      assertValidSecretPrefix(prefix);
      const { leaseId } = splitUnderLease(prefix.slice(0, -1).split("/"));
      const { indexFile, lockFile } = paths(leaseId);

      return runSerialized(leaseId, async () => {
        // No index → nothing we track under this prefix. Return 0 with NO binding
        // call, so a legacy file-only lease can tear down with the keychain down.
        if (!(await exists(indexFile))) return 0;
        return withFileLock(
          lockFile,
          async (assertHeld) => {
            const index = await readIndex(indexFile);
            const matching = Object.keys(index.keys).filter((k) => k.startsWith(prefix));
            if (matching.length === 0) return 0;

            let removed = 0;
            for (const key of matching) {
              const high = index.keys[key] ?? 0;
              assertHeld();
              if (await binding.delete(service, key)) removed += 1;
              for (let i = 0; i < high; i++) {
                assertHeld();
                await binding.delete(chunkService, chunkAccount(key, i));
              }
            }

            const removedKeys = new Set(matching);
            index.keys = Object.fromEntries(
              Object.entries(index.keys).filter(([k]) => !removedKeys.has(k)),
            );
            assertHeld();
            await persistIndex(indexFile, index);
            return removed;
          },
          lockOpts,
        );
      });
    },
  };
}
