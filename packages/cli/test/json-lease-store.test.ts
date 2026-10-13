import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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

  it("jobParameters round-trips through save, load and transaction (10-05, SPEC-08)", async () => {
    const store = createJsonLeaseStore({ root: freshRoot() });
    const jobParameters = { reference: "ref_1001", expected_amount_kobo: 30050, currency: "NGN" };
    await store.save(makeTestLease("lease-params", { jobParameters }));
    expect((await store.load("lease-params"))?.jobParameters).toEqual(jobParameters);

    const moved = await store.transaction("lease-params", (cur) => ({
      ...cur,
      version: cur.version + 1,
    }));
    expect(moved.jobParameters).toEqual(jobParameters);
    expect((await store.load("lease-params"))?.jobParameters).toEqual(jobParameters);
  });

  it("a pre-phase lease without jobParameters loads exactly as before", async () => {
    const store = createJsonLeaseStore({ root: freshRoot() });
    await store.save(makeTestLease("lease-prephase"));
    const loaded = await store.load("lease-prephase");
    expect(loaded).toEqual(makeTestLease("lease-prephase"));
    expect(loaded?.jobParameters).toBeUndefined();
    expect("jobParameters" in (loaded ?? {})).toBe(false);
  });

  it("accepts the identifier-scale name boundaries: a 128-char name loads, a 129-char name is corrupt", async () => {
    const root = freshRoot();
    const store = createJsonLeaseStore({ root });
    await store.save(makeTestLease("lease-name", { jobParameters: { ok: "x" } }));
    const stored = JSON.parse(await readFile(leaseFile(root, "lease-name"), "utf8")) as Record<
      string,
      unknown
    >;

    await writeFile(
      leaseFile(root, "lease-name"),
      JSON.stringify({ ...stored, jobParameters: { ["a".repeat(128)]: "x" } }),
    );
    expect((await store.load("lease-name"))?.jobParameters).toEqual({ ["a".repeat(128)]: "x" });

    await writeFile(
      leaseFile(root, "lease-name"),
      JSON.stringify({ ...stored, jobParameters: { ["a".repeat(129)]: "x" } }),
    );
    await expect(store.load("lease-name")).rejects.toBeInstanceOf(StoreCorruptError);
  });

  it.each([
    ["a float value", { reference: 12.5 }],
    ["an unsafe name", { "bad name": "x" }],
    ["a non-record shape", ["reference", "NGN"]],
    ["a null value", { reference: null }],
    ["a boolean value", { currency: true }],
    ["an empty name", { "": "x" }],
  ])("a lease.json whose jobParameters has %s loads as StoreCorruptError", async (_name, jobParameters) => {
    const root = freshRoot();
    const store = createJsonLeaseStore({ root });
    await store.save(makeTestLease("lease-badparams"));
    const stored = JSON.parse(await readFile(leaseFile(root, "lease-badparams"), "utf8")) as Record<string, unknown>;
    await writeFile(leaseFile(root, "lease-badparams"), JSON.stringify({ ...stored, jobParameters }));
    await expect(store.load("lease-badparams")).rejects.toBeInstanceOf(StoreCorruptError);
  });

  it("a fence round-trips through save, load and transaction (Phase 9 D-09)", async () => {
    const store = createJsonLeaseStore({ root: freshRoot() });
    const fence = { epoch: 2, expiresAt: 100 };
    await store.save(makeTestLease("lease-fence", { fence }));
    expect((await store.load("lease-fence"))?.fence).toEqual(fence);

    const moved = await store.transaction("lease-fence", (cur) => ({
      ...cur,
      fence: { epoch: 2, expiresAt: 0 },
    }));
    expect(moved.fence).toEqual({ epoch: 2, expiresAt: 0 });
    expect((await store.load("lease-fence"))?.fence).toEqual({ epoch: 2, expiresAt: 0 });
  });

  it.each([
    ["a string epoch", { epoch: "2", expiresAt: 100 }],
    ["a fractional epoch", { epoch: 1.5, expiresAt: 100 }],
    ["an epoch of 0", { epoch: 0, expiresAt: 100 }],
    ["a negative expiry", { epoch: 1, expiresAt: -1 }],
    ["a missing expiry", { epoch: 1 }],
    ["a non-object fence", "released"],
  ])("a lease.json with %s loads as StoreCorruptError", async (_name, fence) => {
    const root = freshRoot();
    const store = createJsonLeaseStore({ root });
    await store.save(makeTestLease("lease-badfence"));
    const stored = JSON.parse(await readFile(leaseFile(root, "lease-badfence"), "utf8")) as Record<string, unknown>;
    await writeFile(leaseFile(root, "lease-badfence"), JSON.stringify({ ...stored, fence }));
    await expect(store.load("lease-badfence")).rejects.toBeInstanceOf(StoreCorruptError);
  });

  it("scan() is tolerant: a torn record is reported by id, sorted, and its bytes are untouched", async () => {
    const root = freshRoot();
    const store = createJsonLeaseStore({ root });
    await store.save(makeTestLease("lease-b"));
    await store.save(makeTestLease("lease-a"));
    const tornFile = leaseFile(root, "lease-a");
    await writeFile(tornFile, '{"id": "lease-a", ');
    const before = await readFile(tornFile);

    const scanned = await store.scan();

    expect(scanned.map((entry) => entry.id)).toEqual(["lease-a", "lease-b"]);
    const [torn, ok] = scanned;
    expect(torn).toMatchObject({ id: "lease-a", unreadable: "corrupt" });
    expect((torn as { fingerprint: string }).fingerprint).not.toBe("");
    expect(ok).toMatchObject({ id: "lease-b", lease: { id: "lease-b" } });
    expect((await readFile(tornFile)).equals(before)).toBe(true);
  });

  it("scan() of a missing store root is empty and skips stray names and empty directories", async () => {
    const root = freshRoot();
    const store = createJsonLeaseStore({ root });
    expect(await store.scan()).toEqual([]);

    await store.save(makeTestLease("lease-1"));
    await mkdir(path.join(root, "leases", "no-record"), { recursive: true });
    await mkdir(path.join(root, "leases", ".hidden"), { recursive: true });
    await writeFile(path.join(root, "leases", "stray-file"), "x");

    const scanned = await store.scan();
    expect(scanned.map((entry) => entry.id)).toEqual(["lease-1"]);
  });

  it("scan() reports a record that fails strict validation as corrupt, never as a lease", async () => {
    const root = freshRoot();
    const store = createJsonLeaseStore({ root });
    await store.save(makeTestLease("lease-v"));
    await writeFile(leaseFile(root, "lease-v"), JSON.stringify({ id: "lease-v", state: "nonsense" }));
    const [entry] = await store.scan();
    expect(entry).toMatchObject({ id: "lease-v", unreadable: "corrupt" });
  });
});
