/**
 * `createJsonReceiptStore` — the on-disk, append-only `ReceiptStore` (HOST-03),
 * constructed PER LEASE (the contract is keyed by chain only, RESEARCH Pitfall
 * 10). Layout: `<root>/leases/<id>/receipts/{verified,attested}.json` (arrays of
 * `ReceiptEntry`) and `checkpoint-<chain>.json`. The two chains live in separate
 * files so they can never cross-contaminate.
 *
 * The store persists opaque bytes: it never computes or trusts a hash — the
 * chain verifiers recompute on load, so an edited receipt file is detected at
 * read time. Lock order is always lease-lock then receipt-lock, never the
 * reverse (Pitfall 10); this store only ever takes the receipt-file lock.
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";

import type { ReceiptStore } from "@stint/core";
import type { Checkpoint, ReceiptChain, ReceiptEntry } from "@stint/spec";

import { leaseDir } from "../paths.js";
import {
  StoreCorruptError,
  atomicWriteJson,
  createKeyedQueue,
  readJsonRetry,
  withFileLock,
} from "./atomic-file.js";
import type { FileLockOptions } from "./atomic-file.js";

export interface JsonReceiptStoreOptions {
  /** Store root directory (see `resolveStoreRoot`). */
  readonly root: string;
  /** The lease whose receipts this instance persists. */
  readonly leaseId: string;
  /** Total wait for a contended receipt-file lock before `LeaseBusyError` (default 30s). */
  readonly lockTimeoutMs?: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A chain file must be a JSON array of objects; anything else is corruption (fixed message). */
function parseChain(raw: unknown): ReceiptEntry[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || !raw.every(isRecord)) throw new StoreCorruptError();
  return raw as unknown as ReceiptEntry[];
}

export function createJsonReceiptStore(opts: JsonReceiptStoreOptions): ReceiptStore {
  const { root, leaseId } = opts;
  const lockOpts: FileLockOptions =
    opts.lockTimeoutMs === undefined ? {} : { timeoutMs: opts.lockTimeoutMs };
  const runSerialized = createKeyedQueue();
  // Validates the lease id and keeps the path under the store root (T-06-01).
  const receiptsDir = path.join(leaseDir(root, leaseId), "receipts");

  const chainFile = (chain: ReceiptChain): string => path.join(receiptsDir, `${chain}.json`);
  const checkpointFile = (chain: ReceiptChain): string =>
    path.join(receiptsDir, `checkpoint-${chain}.json`);

  return {
    async append(chain: ReceiptChain, entry: ReceiptEntry): Promise<void> {
      const file = chainFile(chain);
      await runSerialized(file, async () => {
        await mkdir(receiptsDir, { recursive: true });
        await withFileLock(
          file,
          async (assertHeld) => {
            const existing = parseChain(await readJsonRetry(file));
            assertHeld(); // never commit after losing the lock
            await atomicWriteJson(file, [...existing, entry]);
          },
          lockOpts,
        );
      });
    },

    async load(chain: ReceiptChain): Promise<readonly ReceiptEntry[]> {
      return parseChain(await readJsonRetry(chainFile(chain)));
    },

    async readCheckpoint(chain: ReceiptChain): Promise<Checkpoint | undefined> {
      const raw = await readJsonRetry(checkpointFile(chain));
      if (raw === undefined) return undefined;
      if (!isRecord(raw)) throw new StoreCorruptError();
      return raw as unknown as Checkpoint;
    },

    async writeCheckpoint(checkpoint: Checkpoint): Promise<void> {
      const file = checkpointFile(checkpoint.chain);
      await runSerialized(file, async () => {
        await mkdir(receiptsDir, { recursive: true });
        await withFileLock(
          file,
          async (assertHeld) => {
            assertHeld();
            await atomicWriteJson(file, checkpoint);
          },
          lockOpts,
        );
      });
    },
  };
}
