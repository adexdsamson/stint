import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { SecretKeyError, credentialSecretKey, leaseSecretPrefix } from "@stint/core";
import { createSecretStoreContractTests } from "@stint/core/testing";

import { leaseSecretsDir, secretsRoot } from "../src/paths.js";
import { StoreCorruptError } from "../src/store/atomic-file.js";
import { createFileSecretStore } from "../src/store/file-secret-store.js";

const roots: string[] = [];
function freshRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "stint-secrets-"));
  roots.push(root);
  return root;
}

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

// The shared contract suite, unmodified, against the real on-disk store (D-24).
createSecretStoreContractTests(() => createFileSecretStore({ root: freshRoot() }));

describe("createFileSecretStore (file specifics)", () => {
  it("writes the secret only under secrets/lease/, never under leases/", async () => {
    const root = freshRoot();
    const store = createFileSecretStore({ root });
    await store.put("lease/lease-1/cred/sheets.orders", "s3cret-value");

    expect(readdirSync(root).sort()).toEqual(["secrets"]);
    const files = listFiles(leaseSecretsDir(root, "lease-1")).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(1);
    expect(files[0]?.startsWith(path.join(secretsRoot(root), "lease", "lease-1"))).toBe(true);
    // Nothing secret is under the lease folder tree.
    expect(readdirSync(root)).not.toContain("leases");
  });

  it.skipIf(process.platform === "win32")("creates the file 0600 and its directory 0700", async () => {
    const root = freshRoot();
    const store = createFileSecretStore({ root });
    await store.put("lease/lease-1/cred/sheets", "v");
    const dir = leaseSecretsDir(root, "lease-1");
    const [file] = listFiles(dir).filter((f) => f.endsWith(".json"));
    expect(file).toBeDefined();
    expect(statSync(file as string).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(file as string)).mode & 0o777).toBe(0o700);
  });

  it("succeeds on this platform whatever the OS does with modes", async () => {
    const store = createFileSecretStore({ root: freshRoot() });
    await expect(store.put("lease/lease-1/cred/x", "v")).resolves.toBeUndefined();
    expect(await store.get("lease/lease-1/cred/x")).toBe("v");
  });

  it("get rejects with StoreCorruptError for unreadable JSON", async () => {
    const root = freshRoot();
    const store = createFileSecretStore({ root });
    await store.put("lease/lease-1/cred/x", "v");
    const [file] = listFiles(leaseSecretsDir(root, "lease-1")).filter((f) => f.endsWith(".json"));
    writeFileSync(file as string, "{not json");
    await expect(store.get("lease/lease-1/cred/x")).rejects.toBeInstanceOf(StoreCorruptError);
  });

  it("get rejects with StoreCorruptError when the stored key differs from the requested key", async () => {
    const root = freshRoot();
    const store = createFileSecretStore({ root });
    await store.put("lease/lease-1/cred/x", "v");
    const [file] = listFiles(leaseSecretsDir(root, "lease-1")).filter((f) => f.endsWith(".json"));
    writeFileSync(file as string, JSON.stringify({ v: 1, key: "lease/lease-1/cred/other", value: "v" }));
    await expect(store.get("lease/lease-1/cred/x")).rejects.toBeInstanceOf(StoreCorruptError);
  });

  it("get rejects with StoreCorruptError for a body of the wrong shape", async () => {
    const root = freshRoot();
    const store = createFileSecretStore({ root });
    await store.put("lease/lease-1/cred/x", "v");
    const [file] = listFiles(leaseSecretsDir(root, "lease-1")).filter((f) => f.endsWith(".json"));
    writeFileSync(file as string, JSON.stringify({ v: 2, key: "lease/lease-1/cred/x", value: "v" }));
    await expect(store.get("lease/lease-1/cred/x")).rejects.toBeInstanceOf(StoreCorruptError);
  });

  it("deletePrefix removes the lease directory in one go and leaves a sibling lease sharing the prefix", async () => {
    const root = freshRoot();
    const store = createFileSecretStore({ root });
    await store.put(credentialSecretKey("lease-1", "a"), "1");
    await store.put(credentialSecretKey("lease-1", "b"), "2");
    await store.put(credentialSecretKey("lease-10", "a"), "neighbour");

    expect(await store.deletePrefix(leaseSecretPrefix("lease-1"))).toBe(2);
    expect(() => statSync(leaseSecretsDir(root, "lease-1"))).toThrow();
    expect(statSync(leaseSecretsDir(root, "lease-10")).isDirectory()).toBe(true);
    expect(await store.get(credentialSecretKey("lease-10", "a"))).toBe("neighbour");
  });

  it("rejects keys outside lease/<safe id>/<name> with SecretKeyError", async () => {
    const store = createFileSecretStore({ root: freshRoot() });
    const bad = [
      "other/lease-1/x",
      "lease",
      "lease/lease-1",
      "lease/con/x",
      "lease/..x../y",
      "lease/-bad/x",
    ];
    for (const key of bad) {
      await expect(store.put(key, "v")).rejects.toBeInstanceOf(SecretKeyError);
      await expect(store.get(key)).rejects.toBeInstanceOf(SecretKeyError);
    }
    await expect(store.deletePrefix("other/lease-1/")).rejects.toBeInstanceOf(SecretKeyError);
    await expect(store.deletePrefix("lease/con/")).rejects.toBeInstanceOf(SecretKeyError);
  });

  it("stores Windows device names as hashed files, never as path components", async () => {
    const root = freshRoot();
    const store = createFileSecretStore({ root });
    for (const name of ["con", "nul", "aux"]) {
      await store.put(credentialSecretKey("lease-1", name), `v-${name}`);
    }
    for (const name of ["con", "nul", "aux"]) {
      expect(await store.get(credentialSecretKey("lease-1", name))).toBe(`v-${name}`);
    }
    const files = listFiles(leaseSecretsDir(root, "lease-1")).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(3);
    for (const file of files) {
      const rel = path.relative(root, file).split(path.sep);
      for (const part of rel.slice(3)) expect(part).toMatch(/^s-[0-9a-f]{64}(\.json)?$/);
    }
  });

  it("traversal-looking resource names stay inside the lease directory", async () => {
    const root = freshRoot();
    mkdirSync(path.join(root, "leases"), { recursive: true });
    const store = createFileSecretStore({ root });
    await store.put("lease/lease-1/cred/a..b", "v");
    expect(await store.get("lease/lease-1/cred/a..b")).toBe("v");
    expect(readdirSync(path.join(root, "leases"))).toEqual([]);
  });

  it("errors never carry the key, the value or a path", async () => {
    const root = freshRoot();
    const store = createFileSecretStore({ root });
    await store.put("lease/lease-1/cred/marker-name", "marker-value");
    const [file] = listFiles(leaseSecretsDir(root, "lease-1")).filter((f) => f.endsWith(".json"));
    writeFileSync(file as string, "marker-value{");
    const err = (await store
      .get("lease/lease-1/cred/marker-name")
      .catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain("marker-name");
    expect(err.message).not.toContain("marker-value");
    expect(err.message).not.toContain(root);
  });
});
