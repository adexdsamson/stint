import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import { credentialSecretKey, leaseSecretPrefix } from "@stint/core";
import type { SecretStore } from "@stint/core";
import { createSecretStoreContractTests } from "@stint/core/testing";

import { createKeychainBinding, probeKeychain } from "../src/store/keychain-binding.js";
import { createKeychainSecretStore } from "../src/store/keychain-secret-store.js";
import { FakeKeychainBinding } from "./helpers/fake-keychain-binding.js";

const roots: string[] = [];
function freshRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "stint-keychain-"));
  roots.push(root);
  return root;
}

/** Every regular file under `dir`, recursively, including dotfiles and lock artifacts. */
function listFiles(dir: string): string[] {
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

// The shared contract suite, unmodified, against the keychain store backed by a
// fake binding with the 2560-byte Windows Credential Manager cap (D-24).
createSecretStoreContractTests(() =>
  createKeychainSecretStore({
    root: freshRoot(),
    service: "stint-test",
    binding: new FakeKeychainBinding(2560),
  }),
);

describe("createKeychainSecretStore (keychain specifics)", () => {
  it("never writes the secret value in plaintext to any file under the store root", async () => {
    const root = freshRoot();
    const service = "stint-test";
    const store = createKeychainSecretStore({
      root,
      service,
      binding: new FakeKeychainBinding(2560),
    });

    const marker = `MARKER-${"s3cret".repeat(1200)}-世界😀-END`; // multi-chunk, recognizable
    const key = credentialSecretKey("lease-plain", "cred.blob");
    await store.put(key, marker);
    expect(await store.get(key)).toBe(marker);

    const markerBytes = Buffer.from(marker, "utf8");
    const files = listFiles(root);
    // The index file must be among them, proving we scanned real artifacts.
    expect(files.some((f) => f.endsWith(".keychain-index.json"))).toBe(true);
    for (const file of files) {
      const bytes = readFileSync(file);
      expect(bytes.includes(markerBytes), `plaintext secret found in ${path.basename(file)}`).toBe(
        false,
      );
    }

    // The index holds the key NAME (not the value) so teardown can find the chunks.
    const indexFile = files.find((f) => f.endsWith(".keychain-index.json")) as string;
    const index = JSON.parse(readFileSync(indexFile, "utf8")) as { keys: Record<string, number> };
    expect(Object.keys(index.keys)).toContain(key);
  });

  it("a shrink then grow leaves no stale chunk and reads the current value", async () => {
    const service = "stint-test";
    const binding = new FakeKeychainBinding(2560);
    const store = createKeychainSecretStore({ root: freshRoot(), service, binding });
    const chunkService = `${service}.chunk`;
    const key = credentialSecretKey("leaseg", "blob");

    const big = "A".repeat(5000); // 3 chunks
    await store.put(key, big);
    expect(binding.has(service, key)).toBe(true);
    for (const i of [0, 1, 2]) expect(binding.has(chunkService, `${key}#${String(i)}`)).toBe(true);

    const small = "B".repeat(100); // 1 chunk — chunks #1 and #2 become stale
    await store.put(key, small);
    expect(await store.get(key)).toBe(small);
    expect(binding.has(chunkService, `${key}#0`)).toBe(true);
    expect(binding.has(chunkService, `${key}#1`)).toBe(false);
    expect(binding.has(chunkService, `${key}#2`)).toBe(false);

    const grown = "C".repeat(6000); // 3 chunks again
    await store.put(key, grown);
    expect(await store.get(key)).toBe(grown);
    for (const i of [0, 1, 2]) expect(binding.has(chunkService, `${key}#${String(i)}`)).toBe(true);
  });

  it("delete removes the head and every chunk and clears the key from the index", async () => {
    const service = "stint-test";
    const binding = new FakeKeychainBinding(2560);
    const root = freshRoot();
    const store = createKeychainSecretStore({ root, service, binding });
    const chunkService = `${service}.chunk`;
    const key = credentialSecretKey("leased", "blob");

    await store.put(key, "D".repeat(5000)); // 3 chunks
    await store.delete(key);
    expect(await store.get(key)).toBeUndefined();
    expect(binding.has(service, key)).toBe(false);
    for (const i of [0, 1, 2]) expect(binding.has(chunkService, `${key}#${String(i)}`)).toBe(false);
    // Deleting the last key removes the now-empty index file.
    expect(listFiles(root).some((f) => f.endsWith(".keychain-index.json"))).toBe(false);
  });

  it("deletePrefix with no matching index entry returns 0 without any binding call", async () => {
    const service = "stint-test";
    let calls = 0;
    const counting = new Proxy(new FakeKeychainBinding(2560), {
      get(target, prop, receiver) {
        if (prop === "set" || prop === "get" || prop === "delete") calls += 1;
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
    const store = createKeychainSecretStore({ root: freshRoot(), service, binding: counting });
    // The accessor counts property reads, so reset after wiring and measure the call.
    calls = 0;
    expect(await store.deletePrefix(leaseSecretPrefix("never-stored"))).toBe(0);
    expect(calls).toBe(0);
  });
});

// --- Task 4: gated real-binding contract run -------------------------------

/** The lease ids the shared contract suite stores under, for real-keychain teardown. */
const CONTRACT_LEASE_IDS = ["lease-1", "lease-2", "a", "ab"] as const;
const realStores: SecretStore[] = [];

let probePromise: Promise<boolean> | undefined;
/** The single shared probe (wrapping the SOLE `probeKeychain`), memoised. */
function probeKeychainOnce(): Promise<boolean> {
  probePromise ??= probeKeychain(createKeychainBinding(), `stint-probe-${randomUUID()}`);
  return probePromise;
}

const usable = await probeKeychainOnce();
if (!usable && process.env.STINT_REQUIRE_KEYCHAIN_TESTS === "1") {
  throw new Error(
    "Keychain is required (STINT_REQUIRE_KEYCHAIN_TESTS=1) but is not usable on this host.",
  );
}

describe.skipIf(!usable)("createKeychainSecretStore (real OS keychain)", () => {
  createSecretStoreContractTests(() => {
    const store = createKeychainSecretStore({
      root: freshRoot(),
      service: `stint-test-${randomUUID()}`,
    });
    realStores.push(store);
    return store;
  });
});

afterAll(async () => {
  // Remove anything the real-binding run left in the dev/CI keychain BEFORE the
  // on-disk roots (which hold each store's index) are deleted.
  for (const store of realStores) {
    for (const id of CONTRACT_LEASE_IDS) {
      try {
        await store.deletePrefix(leaseSecretPrefix(id));
      } catch {
        // Best-effort teardown; never fail the suite on cleanup.
      }
    }
  }
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
