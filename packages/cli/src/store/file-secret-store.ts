/**
 * `createFileSecretStore` - the plaintext file `SecretStore` (RT-02, D-06).
 *
 * Layout: `<root>/secrets/lease/<id>/...`, a tree SEPARATE from the shareable
 * lease folder `<root>/leases/<id>/` (D-07). Every key segment after the lease
 * id becomes a path component named `s-` plus the lowercase SHA-256 hex of the
 * segment's UTF-8 bytes; the last component ends in `.json`. The name has a
 * fixed length, is case-insensitive safe and can never be a Windows device
 * name, so no caller-chosen text reaches a path (T-08-13). The file body is
 * `{ "v": 1, "key": FULL_KEY, "value": SECRET }`.
 *
 * Plaintext at rest is the disclosed, accepted risk until the keychain backend
 * lands (D-06, D-09). Modes 0600 (file) and 0700 (directory) are applied where
 * the OS honours them; there is no `icacls` and no refusal to persist on
 * Windows (D-10). Every error message is fixed text: never a key, a path or
 * file contents (T-08-17).
 */

import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

import { SecretKeyError, assertValidSecretKey, assertValidSecretPrefix } from "@stint/core";
import type { SecretStore } from "@stint/core";

import { CliError, EXIT_CODES } from "../exit.js";
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

export interface FileSecretStoreOptions {
  /** Store root directory (see `resolveStoreRoot`). */
  readonly root: string;
  /** Total wait for a contended secret-file lock before `LeaseBusyError` (default 30s). */
  readonly lockTimeoutMs?: number;
}

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

function segmentName(segment: string): string {
  return `s-${createHash("sha256").update(segment, "utf8").digest("hex")}`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
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

async function bestEffortChmod(target: string, mode: number): Promise<void> {
  try {
    await chmod(target, mode);
  } catch {
    // win32 and some filesystems do not honour POSIX modes (D-10); the secret is still only in the user's store.
  }
}

/** Counts the `.json` secret files under `dir`, recursively; 0 when `dir` does not exist. */
async function countSecretFiles(dir: string): Promise<number> {
  let entries;
  try {
    entries = await withTransientRetry(() => readdir(dir, { withFileTypes: true }));
  } catch (e) {
    if (errnoCode(e) === "ENOENT") return 0;
    throw e;
  }
  let count = 0;
  for (const entry of entries) {
    if (entry.isDirectory()) count += await countSecretFiles(path.join(dir, entry.name));
    else if (entry.name.endsWith(".json")) count += 1;
  }
  return count;
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (e) {
    if (errnoCode(e) === "ENOENT") return false;
    throw e;
  }
}

export function createFileSecretStore(opts: FileSecretStoreOptions): SecretStore {
  const { root } = opts;
  const lockOpts: FileLockOptions =
    opts.lockTimeoutMs === undefined ? {} : { timeoutMs: opts.lockTimeoutMs };
  const runSerialized = createKeyedQueue();

  /** Maps a key to `{ dir, file }`; rejects any key outside `lease/<safe id>/<name...>`. */
  function mapKey(key: string): { dir: string; file: string } {
    assertValidSecretKey(key);
    const { leaseId, rest } = splitUnderLease(key.split("/"));
    if (rest.length < 1) throw new SecretKeyError();
    const names = rest.map(segmentName);
    const last = names.pop() as string;
    const dir = path.join(leaseSecretsDir(root, leaseId), ...names);
    return { dir, file: path.join(dir, `${last}.json`) };
  }

  /** Maps a prefix (`lease/<id>/` or deeper) to the directory holding everything under it. */
  function mapPrefix(prefix: string): string {
    assertValidSecretPrefix(prefix);
    const { leaseId, rest } = splitUnderLease(prefix.slice(0, -1).split("/"));
    return path.join(leaseSecretsDir(root, leaseId), ...rest.map(segmentName));
  }

  return {
    async get(key: string): Promise<string | undefined> {
      const { file } = mapKey(key);
      const raw = await readJsonRetry(file);
      if (raw === undefined) return undefined;
      if (
        !isRecord(raw) ||
        raw.v !== 1 ||
        typeof raw.key !== "string" ||
        typeof raw.value !== "string" ||
        raw.key !== key
      ) {
        throw new StoreCorruptError();
      }
      return raw.value;
    },

    async put(key: string, value: string): Promise<void> {
      const { dir, file } = mapKey(key);
      await runSerialized(file, async () => {
        await mkdir(dir, { recursive: true, mode: DIR_MODE });
        await withFileLock(
          file,
          async (assertHeld) => {
            assertHeld();
            await atomicWriteJson(file, { v: 1, key, value }, { mode: FILE_MODE });
            await bestEffortChmod(file, FILE_MODE);
          },
          lockOpts,
        );
      });
    },

    async delete(key: string): Promise<void> {
      const { file } = mapKey(key);
      await runSerialized(file, () => withTransientRetry(() => rm(file, { force: true })));
    },

    async deletePrefix(prefix: string): Promise<number> {
      const dir = mapPrefix(prefix);
      const count = await countSecretFiles(dir);
      await withTransientRetry(() => rm(dir, { recursive: true, force: true }));
      if (await exists(dir)) {
        throw new CliError(EXIT_CODES.internal, "The stored secrets could not be removed.");
      }
      return count;
    },
  };
}
