/**
 * `createJsonLeaseStore` — the on-disk `LeaseStore` (HOST-03), dir-per-lease
 * layout (`<root>/leases/<id>/lease.json`, D-10). Passes the shared
 * `createLeaseStoreContractTests` suite unmodified.
 *
 * Reads (`load`/`list`) are LOCK-FREE: the proxy dispatcher calls `load`
 * inside a per-lease `transaction`, so a locking read would deadlock. Writes
 * (`save`/`transaction`/`delete`) go through the per-id in-process queue, then
 * a per-`lease.json` cross-process lock, then an atomic rename.
 */

import { mkdir, readdir, rm, stat, unlink } from "node:fs/promises";

import type { Lease, LeaseMutator, LeaseScanEntry, LeaseStore } from "@stint/core";
import { STATES } from "@stint/core";

import { assertSafeLeaseId, leaseDir, leaseFile, leasesRoot } from "../paths.js";
import type { FileLockOptions } from "./atomic-file.js";
import {
  StoreCorruptError,
  atomicWriteJson,
  createKeyedQueue,
  readJsonRetry,
  withFileLock,
  withTransientRetry,
} from "./atomic-file.js";

export interface JsonLeaseStoreOptions {
  /** Store root directory (see `resolveStoreRoot`). */
  readonly root: string;
  /** Total wait for a contended lease lock before `LeaseBusyError` (default 30s). */
  readonly lockTimeoutMs?: number;
  /**
   * How long a killed holder's lock is kept before another process may take it
   * over (default 10000 ms, minimum 5000 ms). A supervisor test lowers it so a
   * crash-resume run takes seconds.
   */
  readonly staleMs?: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isNumberArray(v: unknown): v is number[] {
  return Array.isArray(v) && v.every(isNumber);
}

/** The optional teardown fence (Phase 9 D-09): an integer epoch of at least 1 and a finite expiry of at least 0 (0 means released). */
function isValidFence(v: unknown): boolean {
  return (
    isRecord(v) &&
    isNumber(v.epoch) &&
    Number.isInteger(v.epoch) &&
    v.epoch >= 1 &&
    isNumber(v.expiresAt) &&
    v.expiresAt >= 0
  );
}

/** Parameter names must be identifier-scale (the manifest's `Identifier` grammar's safe subset): 1..128 of [a-zA-Z0-9._-]. */
const SAFE_PARAMETER_NAME = /^[a-zA-Z0-9._-]{1,128}$/;

/**
 * The optional create-bound job parameters (10-05, SPEC-08): a record whose
 * every name is identifier-scale and whose every value is a string or a
 * whole number. The closed parameter type set (`string`/`integer`/`currency`,
 * with integers as whole kobo) can never produce a float, so a fractional
 * value fails closed as corrupt. Anything else unexpected does too.
 */
function isValidJobParameters(v: unknown): boolean {
  if (!isRecord(v)) return false;
  for (const [name, value] of Object.entries(v)) {
    if (!SAFE_PARAMETER_NAME.test(name)) return false;
    if (typeof value === "number") {
      if (!Number.isInteger(value)) return false;
    } else if (typeof value !== "string") {
      return false;
    }
  }
  return true;
}

/** Validates parsed JSON is a `Lease`; throws `StoreCorruptError` (fixed message) otherwise. */
function parseLease(raw: unknown, expectedId?: string): Lease {
  if (!isRecord(raw)) throw new StoreCorruptError();
  const {
    id,
    state,
    version,
    boundHash,
    grantedAt,
    expiresAt,
    maxDurationSeconds,
    counters,
    teardownProgress,
    fence,
    jobParameters,
  } = raw;
  if (
    typeof id !== "string" ||
    (expectedId !== undefined && id !== expectedId) ||
    typeof state !== "string" ||
    !(STATES as readonly string[]).includes(state) ||
    !isNumber(version) ||
    typeof boundHash !== "string" ||
    !isNumber(grantedAt) ||
    !isNumber(expiresAt) ||
    !isNumber(maxDurationSeconds) ||
    !isRecord(counters) ||
    !isNumber(counters.actionCount) ||
    !isNumber(counters.spentMinor) ||
    !isNumberArray(counters.denialErrorTimestamps) ||
    !isNumberArray(counters.actionTimestamps) ||
    (teardownProgress !== undefined && !isRecord(teardownProgress)) ||
    (fence !== undefined && !isValidFence(fence)) ||
    (jobParameters !== undefined && !isValidJobParameters(jobParameters))
  ) {
    throw new StoreCorruptError();
  }
  return raw as unknown as Lease;
}

/** A cheap change marker for a record the store cannot read: modification time and size, or `unknown`. Never the contents. */
async function fingerprintOf(file: string): Promise<string> {
  try {
    const info = await stat(file);
    return `${String(info.mtimeMs)}:${String(info.size)}`;
  } catch {
    return "unknown";
  }
}

export function createJsonLeaseStore(opts: JsonLeaseStoreOptions): LeaseStore {
  const { root } = opts;
  const lockOpts: FileLockOptions = {
    ...(opts.lockTimeoutMs === undefined ? {} : { timeoutMs: opts.lockTimeoutMs }),
    ...(opts.staleMs === undefined ? {} : { staleMs: opts.staleMs }),
  };
  const runSerialized = createKeyedQueue();

  return {
    async load(id: string): Promise<Lease | undefined> {
      const file = leaseFile(root, id);
      const raw = await readJsonRetry(file);
      return raw === undefined ? undefined : parseLease(raw, id);
    },

    async save(lease: Lease): Promise<void> {
      const file = leaseFile(root, lease.id);
      await runSerialized(lease.id, async () => {
        await mkdir(leaseDir(root, lease.id), { recursive: true });
        await withFileLock(
          file,
          async (assertHeld) => {
            assertHeld();
            await atomicWriteJson(file, lease);
          },
          lockOpts,
        );
      });
    },

    async list(): Promise<readonly Lease[]> {
      let names: string[];
      try {
        names = await withTransientRetry(() => readdir(leasesRoot(root)));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw e;
      }
      const leases: Lease[] = [];
      for (const name of names) {
        try {
          assertSafeLeaseId(name);
        } catch {
          continue; // stray non-lease entry; never treated as a lease
        }
        const raw = await readJsonRetry(leaseFile(root, name));
        if (raw !== undefined) leases.push(parseLease(raw, name));
      }
      return leases;
    },

    async scan(): Promise<readonly LeaseScanEntry[]> {
      let names: string[];
      try {
        names = await withTransientRetry(() => readdir(leasesRoot(root)));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw e;
      }
      const entries: LeaseScanEntry[] = [];
      for (const name of [...names].sort()) {
        try {
          assertSafeLeaseId(name);
        } catch {
          continue; // stray non-lease entry; never treated as a lease
        }
        const file = leaseFile(root, name);
        try {
          const raw = await readJsonRetry(file);
          if (raw !== undefined) entries.push({ id: name, lease: parseLease(raw, name) });
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ENOTDIR") continue; // a file, not a lease directory
          entries.push({
            id: name,
            unreadable: e instanceof StoreCorruptError ? "corrupt" : "io_error",
            fingerprint: await fingerprintOf(file),
          });
        }
      }
      return entries;
    },

    async delete(id: string): Promise<void> {
      const file = leaseFile(root, id);
      const dir = leaseDir(root, id);
      await runSerialized(id, async () => {
        if ((await readJsonRetry(file).catch(() => null)) !== undefined) {
          await mkdir(dir, { recursive: true });
          await withFileLock(
            file,
            async () => {
              await withTransientRetry(() => unlink(file)).catch((e: unknown) => {
                if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
              });
            },
            lockOpts,
          );
        }
        await withTransientRetry(() => rm(dir, { recursive: true, force: true }));
      });
    },

    async transaction(id: string, mutate: LeaseMutator): Promise<Lease> {
      const file = leaseFile(root, id);
      return await runSerialized(id, () =>
        withFileLock(
          file,
          async (assertHeld) => {
            const raw = await readJsonRetry(file);
            if (raw === undefined) {
              throw new Error("transaction() called before any lease was saved for that id.");
            }
            const current = parseLease(raw, id);
            const next = await mutate(current);
            assertHeld(); // never commit after losing the lock
            await atomicWriteJson(file, next);
            return next;
          },
          lockOpts,
        ),
      );
    },
  };
}
