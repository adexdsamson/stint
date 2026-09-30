/**
 * HOST-03 concurrency hammer (SC#4, D-11): no lost updates and no torn files
 * for the JSON `LeaseStore`, in-process and across real processes. Asserts on
 * FINAL STATE ONLY (never timing) so it is deterministic on every OS; the
 * store's transient-retry budget, not this test, absorbs EPERM jitter.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { makeTestLease } from "@stint/core/testing";

import { leaseDir } from "../src/paths.js";
import { createJsonLeaseStore } from "../src/store/json-lease-store.js";

const roots: string[] = [];
function freshRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "stint-hammer-"));
  roots.push(root);
  return root;
}

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const WORKER = fileURLToPath(new URL("./fixtures/hammer-worker.mjs", import.meta.url));
const BUILT_ENTRY = fileURLToPath(new URL("../dist/index.js", import.meta.url));

interface WorkerResult {
  readonly code: number | null;
  readonly summary: {
    readonly done: number;
    readonly parseErrors: number;
    readonly otherErrors: number;
  };
}

function runWorker(
  root: string,
  id: string,
  mode: "writer" | "reader",
  n: number,
): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER, root, id, mode, String(n)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const line = out.trim().split("\n").pop() ?? "";
      try {
        resolve({ code, summary: JSON.parse(line) as WorkerResult["summary"] });
      } catch {
        reject(new Error(`hammer worker (${mode}) exited ${String(code)} without a JSON summary`));
      }
    });
  });
}

describe("HOST-03 concurrent read/write hammer", () => {
  it("in-process: 50 concurrent transactions + 4 reader loops -> version 50, no torn reads, no leftovers", async () => {
    const root = freshRoot();
    const id = "lease-hammer";
    const store = createJsonLeaseStore({ root });
    await store.save(makeTestLease(id, { version: 0 }));

    let writersDone = false;
    let reads = 0;
    const readerFailures: unknown[] = [];

    async function readerLoop(): Promise<void> {
      let last = -1;
      while (!writersDone) {
        try {
          // load() parses AND shape-validates as a Lease: a torn file throws StoreCorruptError.
          const lease = await store.load(id);
          await store.list();
          if (lease === undefined || lease.version < last) {
            readerFailures.push(new Error("lease vanished or version went backwards"));
          } else {
            last = lease.version;
          }
          reads++;
        } catch (e) {
          readerFailures.push(e);
        }
        await new Promise((r) => setTimeout(r, 1));
      }
    }

    const readers = Array.from({ length: 4 }, () => readerLoop());
    const writers = Array.from({ length: 50 }, () =>
      store.transaction(id, (lease) => ({ ...lease, version: lease.version + 1 })),
    );
    await Promise.all(writers);
    writersDone = true;
    await Promise.all(readers);

    expect((await store.load(id))?.version).toBe(50);
    expect(readerFailures).toEqual([]);
    expect(reads).toBeGreaterThan(0);

    // Only lease.json may remain: no `lease.json.<number>` temp files, no `lease.json.lock` dir.
    const entries = await readdir(leaseDir(root, id));
    expect(entries).toEqual(["lease.json"]);
  });

  it("cross-process: 3 writer processes x 20 + 1 reader process -> version 60, 0 torn reads, 0 non-transient errors", async () => {
    expect(existsSync(BUILT_ENTRY), "packages/cli/dist is missing: run `pnpm build` first").toBe(
      true,
    );

    const root = freshRoot();
    const id = "lease-hammer-x";
    const store = createJsonLeaseStore({ root });
    await store.save(makeTestLease(id, { version: 0 }));

    const reader = runWorker(root, id, "reader", 0);
    const writers = await Promise.all([0, 1, 2].map(() => runWorker(root, id, "writer", 20)));
    writeFileSync(path.join(root, "reader-stop"), "");
    const readerResult = await reader;

    for (const w of writers) {
      expect(w.code).toBe(0);
      expect(w.summary.done).toBe(20);
      expect(w.summary.otherErrors).toBe(0);
    }
    expect(readerResult.summary.parseErrors).toBe(0);
    expect(readerResult.summary.otherErrors).toBe(0);
    expect(readerResult.code).toBe(0);

    expect((await store.load(id))?.version).toBe(60);
    expect(await readdir(leaseDir(root, id))).toEqual(["lease.json"]);
  });
});
