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

import { mkdir, readdir, rm, unlink } from "node:fs/promises";

import type { Lease, LeaseMutator, LeaseStore } from "@stint/core";
import { STATES } from "@stint/core";

import { assertSafeLeaseId, leaseDir, leaseFile, leasesRoot } from "../paths.js";
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
    (teardownProgress !== undefined && !isRecord(teardownProgress))
  ) {
    throw new StoreCorruptError();
  }
  return raw as unknown as Lease;
}

export function createJsonLeaseStore(opts: JsonLeaseStoreOptions): LeaseStore {
  const { root } = opts;
  const lockOpts = opts.lockTimeoutMs === undefined ? {} : { timeoutMs: opts.lockTimeoutMs };
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
