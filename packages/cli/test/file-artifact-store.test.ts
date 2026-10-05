import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { createLeaseArtifactStoreContractTests } from "@stint/core/testing";

import { CliError } from "../src/exit.js";
import { leaseDir } from "../src/paths.js";
import { createFileLeaseArtifactStore } from "../src/store/file-artifact-store.js";
import { saveEnvelope } from "../src/store/envelope.js";
import { savePublisherBinding } from "../src/store/publisher-binding.js";

const roots: string[] = [];
function freshRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "stint-artifacts-"));
  roots.push(root);
  return root;
}

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

// The shared contract suite, unmodified, against the real on-disk store (D-24).
createLeaseArtifactStoreContractTests(() => createFileLeaseArtifactStore({ root: freshRoot() }));

const BINDING = {
  issue_url: "https://publisher.example/issue",
  reissue_url: "https://publisher.example/reissue",
  invalidate_url: "https://publisher.example/invalidate",
  license_public_key: "k4.public.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
};

describe("createFileLeaseArtifactStore (v0.1 compatibility)", () => {
  it("get('envelope') returns what saveEnvelope wrote, by deep equality", async () => {
    const root = freshRoot();
    const envelope = { payload: { a: 1, nested: [1, 2, { b: true }] }, signatures: [{ kid: "k" }] };
    await saveEnvelope(root, "lease-1", envelope);
    const store = createFileLeaseArtifactStore({ root });
    expect(await store.get("lease-1", "envelope")).toEqual(envelope);
  });

  it("get('publisher') returns what savePublisherBinding wrote", async () => {
    const root = freshRoot();
    await savePublisherBinding(root, "lease-1", BINDING);
    const store = createFileLeaseArtifactStore({ root });
    expect(await store.get("lease-1", "publisher")).toEqual(BINDING);
  });

  it("put('envelope') writes the same bytes saveEnvelope would write", async () => {
    const rootA = freshRoot();
    const rootB = freshRoot();
    const envelope = { payload: { x: "y" }, list: [3, 2, 1] };
    await saveEnvelope(rootA, "lease-1", envelope);
    await createFileLeaseArtifactStore({ root: rootB }).put("lease-1", "envelope", envelope);
    const read = (root: string): string =>
      readFileSync(path.join(leaseDir(root, "lease-1"), "envelope.json"), "utf8");
    expect(read(rootB)).toBe(read(rootA));
  });

  it("put('grants') writes <root>/leases/<id>/grants.json", async () => {
    const root = freshRoot();
    const store = createFileLeaseArtifactStore({ root });
    await store.put("lease-1", "grants", { version: 1, grants: [] });
    expect(readdirSync(leaseDir(root, "lease-1"))).toContain("grants.json");
    expect(JSON.parse(readFileSync(path.join(leaseDir(root, "lease-1"), "grants.json"), "utf8"))).toEqual({
      version: 1,
      grants: [],
    });
  });

  it("an unsafe lease id rejects with the existing 'Invalid lease id.' CliError", async () => {
    const store = createFileLeaseArtifactStore({ root: freshRoot() });
    for (const id of ["../x", "con", "a/b", ""]) {
      const err = await store.put(id, "grants", {}).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).safeMessage).toBe("Invalid lease id.");
      await expect(store.get(id, "grants")).rejects.toBeInstanceOf(CliError);
    }
  });
});
