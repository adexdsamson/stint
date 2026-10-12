import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { createKeyProviderContractTests } from "@stint/core/testing";

import { createFileKeyProvider, loadOrCreateRuntimeKey } from "../src/keys/runtime-key.js";
import { StoreCorruptError } from "../src/store/atomic-file.js";

const roots: string[] = [];
function freshRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "stint-keyprov-"));
  roots.push(root);
  return root;
}

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

// The shared contract suite, unmodified, against the real on-disk provider (D-24).
createKeyProviderContractTests(() => createFileKeyProvider(freshRoot()));

describe("createFileKeyProvider (v0.1 compatibility)", () => {
  it("returns the kid of a key created earlier by loadOrCreateRuntimeKey and creates no new file", async () => {
    const root = freshRoot();
    const earlier = await loadOrCreateRuntimeKey(root);
    const before = readdirSync(path.join(root, "keys")).sort();

    const provider = createFileKeyProvider(root);
    expect((await provider.loadOrCreate()).kid).toBe(earlier.kid);
    expect((await provider.loadVerificationKeys()).map((k) => k.kid)).toEqual([earlier.kid]);
    expect(readdirSync(path.join(root, "keys")).sort()).toEqual(before);
  });

  it("loadVerificationKeys on a root with no key files resolves [] and creates nothing", async () => {
    const root = freshRoot();
    expect(await createFileKeyProvider(root).loadVerificationKeys()).toEqual([]);
    expect(readdirSync(root)).toEqual([]);
  });

  it("a corrupt public key file rejects with StoreCorruptError", async () => {
    const root = freshRoot();
    await loadOrCreateRuntimeKey(root);
    writeFileSync(path.join(root, "keys", "runtime-ed25519.pub.json"), JSON.stringify({ kty: "RSA" }));
    await expect(createFileKeyProvider(root).loadVerificationKeys()).rejects.toBeInstanceOf(StoreCorruptError);
    writeFileSync(path.join(root, "keys", "runtime-ed25519.pub.json"), "{nope");
    await expect(createFileKeyProvider(root).loadVerificationKeys()).rejects.toBeInstanceOf(StoreCorruptError);
  });

  it("concurrent loadOrCreate on one provider creates one key", async () => {
    const root = freshRoot();
    const provider = createFileKeyProvider(root);
    const keys = await Promise.all(Array.from({ length: 5 }, () => provider.loadOrCreate()));
    expect(new Set(keys.map((k) => k.kid)).size).toBe(1);
    expect(readdirSync(path.join(root, "keys")).filter((f) => f.endsWith(".json"))).toHaveLength(2);
  });
});
