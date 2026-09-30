import { mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { appendEntry } from "@stint/core";
import { createReceiptStoreContractTests } from "@stint/core/testing";

import { CliError } from "../src/exit.js";
import { leaseDir } from "../src/paths.js";
import { StoreCorruptError } from "../src/store/atomic-file.js";
import { createJsonReceiptStore } from "../src/store/json-receipt-store.js";

const roots: string[] = [];
function freshRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "stint-receipts-"));
  roots.push(root);
  return root;
}

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

// The shared contract suite, unmodified, against the real on-disk store (HOST-03).
createReceiptStoreContractTests(() =>
  createJsonReceiptStore({ root: freshRoot(), leaseId: "lease-01" }),
);

describe("createJsonReceiptStore (JSON-store specifics)", () => {
  const transition = (to: string) =>
    ({
      chain: "verified",
      type: "transition",
      payload: { from: "created", event: "activate", actor: "runtime", to },
    }) as const;

  it("append-only: 20 concurrent appends all persist, in a single unbroken sequence", async () => {
    const store = createJsonReceiptStore({ root: freshRoot(), leaseId: "lease-01" });
    const entries = [];
    let chain: Awaited<ReturnType<typeof store.load>> = [];
    for (let i = 0; i < 20; i++) {
      const e = appendEntry(chain, transition(`s-${String(i)}`), 1000 + i);
      chain = [...chain, e];
      entries.push(e);
    }
    // Sequenced append calls issued without awaiting each: the per-file queue preserves call order.
    await Promise.all(entries.map((e) => store.append("verified", e)));
    expect(await store.load("verified")).toEqual(entries);
    expect(await store.load("attested")).toEqual([]);
  });

  it("two instances for different leases are isolated", async () => {
    const root = freshRoot();
    const a = createJsonReceiptStore({ root, leaseId: "lease-a" });
    const b = createJsonReceiptStore({ root, leaseId: "lease-b" });
    await a.append("verified", appendEntry([], transition("active"), 1000));
    expect(await a.load("verified")).toHaveLength(1);
    expect(await b.load("verified")).toEqual([]);
  });

  it("rejects an unsafe lease id at construction", () => {
    expect(() => createJsonReceiptStore({ root: freshRoot(), leaseId: "../evil" })).toThrow(
      CliError,
    );
  });

  it("a torn or wrong-shaped chain file is StoreCorruptError, never a bad chain", async () => {
    const root = freshRoot();
    const store = createJsonReceiptStore({ root, leaseId: "lease-01" });
    await store.append("verified", appendEntry([], transition("active"), 1000));
    const file = path.join(leaseDir(root, "lease-01"), "receipts", "verified.json");

    await writeFile(file, '[{"seq": 0, ');
    await expect(store.load("verified")).rejects.toBeInstanceOf(StoreCorruptError);

    await writeFile(file, JSON.stringify({ not: "an array" }));
    await expect(store.load("verified")).rejects.toBeInstanceOf(StoreCorruptError);
    await expect(
      store.append("verified", appendEntry([], transition("active"), 1001)),
    ).rejects.toBeInstanceOf(StoreCorruptError);
  });
});
