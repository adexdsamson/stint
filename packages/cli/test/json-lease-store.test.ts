import { mkdtempSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { createLeaseStoreContractTests, makeTestLease } from "@stint/core/testing";

import { CliError, EXIT_CODES } from "../src/exit.js";
import { leaseFile } from "../src/paths.js";
import { LeaseBusyError, StoreCorruptError } from "../src/store/atomic-file.js";
import { createJsonLeaseStore } from "../src/store/json-lease-store.js";

const roots: string[] = [];
function freshRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "stint-store-"));
  roots.push(root);
  return root;
}

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

// The shared contract suite, unmodified, against the real on-disk store (HOST-03).
createLeaseStoreContractTests(() => createJsonLeaseStore({ root: freshRoot() }));

describe("createJsonLeaseStore (JSON-store specifics)", () => {
  it("load()/list() are lock-free: load inside a transaction() does not deadlock", async () => {
    const store = createJsonLeaseStore({ root: freshRoot() });
    await store.save(makeTestLease("lease-1"));
    const result = await store.transaction("lease-1", async (cur) => {
      const inner = await store.load("lease-1");
      const all = await store.list();
      expect(inner?.id).toBe("lease-1");
      expect(all).toHaveLength(1);
      return { ...cur, version: cur.version + 1 };
    });
    expect(result.version).toBe(1);
  });

  it("a contending transaction past the lock budget rejects with LeaseBusyError, leaving the lease untouched", async () => {
    const root = freshRoot();
    const store = createJsonLeaseStore({ root });
    const contender = createJsonLeaseStore({ root, lockTimeoutMs: 300 });
    await store.save(makeTestLease("lease-busy"));

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const holder = store.transaction("lease-busy", async (cur) => {
      await gate;
      return { ...cur, version: cur.version + 1 };
    });
    await new Promise((r) => setTimeout(r, 150));

    const err = await contender
      .transaction("lease-busy", (cur) => ({ ...cur, version: 99 }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LeaseBusyError);
    expect((err as CliError).code).toBe(EXIT_CODES.leaseBusy);

    release();
    await holder;
    expect((await store.load("lease-busy"))?.version).toBe(1);
  });

  it("transaction on an id that was never saved rejects and creates nothing", async () => {
    const store = createJsonLeaseStore({ root: freshRoot() });
    await expect(store.transaction("ghost", (l) => l)).rejects.toThrow();
    expect(await store.load("ghost")).toBeUndefined();
    expect(await store.list()).toEqual([]);
  });

  it("malformed lease JSON on load throws StoreCorruptError rather than returning a bad Lease", async () => {
    const root = freshRoot();
    const store = createJsonLeaseStore({ root });
    await store.save(makeTestLease("lease-bad"));
    await writeFile(
      leaseFile(root, "lease-bad"),
      JSON.stringify({ id: "lease-bad", state: "nonsense" }),
    );
    const err = await store.load("lease-bad").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoreCorruptError);
    expect((err as CliError).code).toBe(EXIT_CODES.storeCorrupt);
  });

  it("torn lease JSON is StoreCorruptError from load() and list()", async () => {
    const root = freshRoot();
    const store = createJsonLeaseStore({ root });
    await store.save(makeTestLease("lease-torn"));
    await writeFile(leaseFile(root, "lease-torn"), '{"id": "lease-torn", ');
    await expect(store.load("lease-torn")).rejects.toBeInstanceOf(StoreCorruptError);
    await expect(store.list()).rejects.toBeInstanceOf(StoreCorruptError);
  });

  it("rejects unsafe lease ids before touching the filesystem", async () => {
    const store = createJsonLeaseStore({ root: freshRoot() });
    await expect(store.load("../evil")).rejects.toBeInstanceOf(CliError);
    await expect(store.save(makeTestLease("a/b"))).rejects.toBeInstanceOf(CliError);
    await expect(store.delete("CON")).rejects.toBeInstanceOf(CliError);
    await expect(store.transaction("..", (l) => l)).rejects.toBeInstanceOf(CliError);
  });

  it("save() replaces an existing lease and delete() of a missing id is a no-op", async () => {
    const store = createJsonLeaseStore({ root: freshRoot() });
    await store.save(makeTestLease("lease-r", { version: 1 }));
    await store.save(makeTestLease("lease-r", { version: 7 }));
    expect((await store.load("lease-r"))?.version).toBe(7);
    await store.delete("lease-r");
    await expect(store.delete("lease-r")).resolves.toBeUndefined();
    expect(await store.load("lease-r")).toBeUndefined();
  });

  it("persists exactly the Lease shape (no secret-bearing extras)", async () => {
    const root = freshRoot();
    const store = createJsonLeaseStore({ root });
    await store.save(makeTestLease("lease-shape"));
    const raw = JSON.parse(await readFile(leaseFile(root, "lease-shape"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(Object.keys(raw).sort()).toEqual(
      [
        "boundHash",
        "counters",
        "expiresAt",
        "grantedAt",
        "id",
        "maxDurationSeconds",
        "state",
        "version",
      ].sort(),
    );
  });
});
