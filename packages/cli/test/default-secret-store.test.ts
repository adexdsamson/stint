import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { credentialSecretKey, leaseSecretPrefix } from "@stint/core";

import { CliError } from "../src/exit.js";
import {
  KEYCHAIN_UNAVAILABLE_MESSAGE,
  assertSecretStoreAvailable,
  createDefaultSecretStore,
  resolveSecretBackend,
} from "../src/store/default-secret-store.js";
import { createFileSecretStore } from "../src/store/file-secret-store.js";
import { createKeychainSecretStore } from "../src/store/keychain-secret-store.js";
import { FakeKeychainBinding } from "./helpers/fake-keychain-binding.js";

const roots: string[] = [];
function freshRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "stint-default-store-"));
  roots.push(root);
  return root;
}
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const PLATFORM = process.platform;

function keychainDefault(root: string, binding: FakeKeychainBinding, env = {}) {
  return createDefaultSecretStore({ root, env, platform: PLATFORM, binding });
}

describe("backend selection", () => {
  it.each([
    [{}, "os_keychain"],
    [{ STINT_SECRET_STORE: "keychain" }, "os_keychain"],
    [{ STINT_SECRET_STORE: "bogus" }, "os_keychain"],
    [{ STINT_SECRET_STORE: "" }, "os_keychain"],
    [{ STINT_SECRET_STORE: "file" }, "plaintext_file"],
  ] as const)("env %j resolves to %s", (env, backend) => {
    expect(resolveSecretBackend(env)).toBe(backend);
    expect(createDefaultSecretStore({ root: freshRoot(), env, platform: PLATFORM }).backend).toBe(
      backend,
    );
  });

  it("keychain default: put goes to the keychain ONLY (no write-through to the file store)", async () => {
    const root = freshRoot();
    const binding = new FakeKeychainBinding();
    const { store, backend } = keychainDefault(root, binding);
    expect(backend).toBe("os_keychain");
    const key = credentialSecretKey("lease-route", "res");

    await store.put(key, "kc-value");

    expect(binding.size).toBeGreaterThan(0);
    expect(await createFileSecretStore({ root }).get(key)).toBeUndefined();
    expect(await createKeychainSecretStore({ root, binding }).get(key)).toBe("kc-value");
  });

  it("STINT_SECRET_STORE=file: put lands in the file store and never touches the native binding", async () => {
    const root = freshRoot();
    const binding = new FakeKeychainBinding();
    const { store, backend } = keychainDefault(root, binding, { STINT_SECRET_STORE: "file" });
    expect(backend).toBe("plaintext_file");
    const key = credentialSecretKey("lease-file", "res");

    await store.put(key, "file-value");
    expect(await store.get(key)).toBe("file-value");
    expect(await createFileSecretStore({ root }).get(key)).toBe("file-value");
    await store.delete(key);
    await store.deletePrefix(leaseSecretPrefix("lease-file"));

    expect(binding.calls).toBe(0);
  });
});

describe("D-04 legacy read-through", () => {
  it("reads a lease sealed in the file store before the flip", async () => {
    const root = freshRoot();
    const key = credentialSecretKey("lease-legacy", "res");
    await createFileSecretStore({ root }).put(key, "legacy-value");

    const { store } = keychainDefault(root, new FakeKeychainBinding());
    expect(await store.get(key)).toBe("legacy-value");
  });

  it("a keychain value shadows a legacy file value for the same key", async () => {
    const root = freshRoot();
    const key = credentialSecretKey("lease-shadow", "res");
    const file = createFileSecretStore({ root });
    await file.put(key, "old-file");

    const { store } = keychainDefault(root, new FakeKeychainBinding());
    await store.put(key, "new-keychain");

    expect(await store.get(key)).toBe("new-keychain");
    expect(await file.get(key)).toBe("old-file");
  });

  it("returns undefined when neither store has the key", async () => {
    const { store } = keychainDefault(freshRoot(), new FakeKeychainBinding());
    expect(await store.get(credentialSecretKey("lease-none", "res"))).toBeUndefined();
  });

  it("delete and deletePrefix run against BOTH stores and sum the counts", async () => {
    const root = freshRoot();
    const binding = new FakeKeychainBinding();
    const file = createFileSecretStore({ root });
    const fileKey = credentialSecretKey("lease-both", "legacy");
    const kcKey = credentialSecretKey("lease-both", "fresh");
    await file.put(fileKey, "f");
    const { store } = keychainDefault(root, binding);
    await store.put(kcKey, "k");

    expect(await store.deletePrefix(leaseSecretPrefix("lease-both"))).toBe(2);
    expect(await store.get(fileKey)).toBeUndefined();
    expect(await store.get(kcKey)).toBeUndefined();
    expect(binding.size).toBe(0);

    // single-key delete clears the keychain copy AND a shadowed file copy
    const key = credentialSecretKey("lease-both2", "res");
    await file.put(key, "f");
    await store.put(key, "k");
    await store.delete(key);
    expect(await store.get(key)).toBeUndefined();
    expect(await file.get(key)).toBeUndefined();
  });
});

describe("B2 keychain unavailable (fail closed)", () => {
  const down = new Error("native keychain exploded: C:\\secret\\path");

  it("(a) a file-only lease gets, deletes and deletePrefixes with the binding forced to throw", async () => {
    const root = freshRoot();
    const binding = new FakeKeychainBinding();
    const file = createFileSecretStore({ root });
    const key = credentialSecretKey("lease-down-a", "res");
    const key2 = credentialSecretKey("lease-down-a2", "res");
    await file.put(key, "legacy");
    await file.put(key2, "legacy2");
    const { store } = keychainDefault(root, binding);
    binding.failWith = down;

    expect(await store.get(key)).toBe("legacy");
    await store.delete(key);
    expect(await file.get(key)).toBeUndefined();
    expect(await store.deletePrefix(leaseSecretPrefix("lease-down-a2"))).toBe(1);
    expect(await file.get(key2)).toBeUndefined();
  });

  it("(b) a keychain-held key with an empty file store and a throwing keychain rethrows", async () => {
    const root = freshRoot();
    const binding = new FakeKeychainBinding();
    const { store } = keychainDefault(root, binding);
    const key = credentialSecretKey("lease-down-b", "res");
    await store.put(key, "kc-secret");
    binding.failWith = down;

    await expect(store.get(key)).rejects.toBe(down);
  });

  it("(c) delete/deletePrefix for a lease with no index make ZERO binding calls", async () => {
    const root = freshRoot();
    const binding = new FakeKeychainBinding();
    const { store } = keychainDefault(root, binding);

    await store.delete(credentialSecretKey("lease-noindex", "res"));
    expect(await store.deletePrefix(leaseSecretPrefix("lease-noindex"))).toBe(0);
    expect(binding.calls).toBe(0);
  });

  it("a throwing keychain falls through to the file value on get", async () => {
    const root = freshRoot();
    const binding = new FakeKeychainBinding();
    const key = credentialSecretKey("lease-fallthrough", "res");
    await createFileSecretStore({ root }).put(key, "from-file");
    const { store } = keychainDefault(root, binding);
    binding.failWith = down;

    expect(await store.get(key)).toBe("from-file");
  });
});

describe("onPlaintextWrite", () => {
  it("fires once per file-backend put (seed AND refresh) and never on a keychain put", async () => {
    const key = credentialSecretKey("lease-warn", "res");

    const onFile = vi.fn();
    const file = createDefaultSecretStore({
      root: freshRoot(),
      env: { STINT_SECRET_STORE: "file" },
      platform: PLATFORM,
      onPlaintextWrite: onFile,
    });
    await file.store.put(key, "seed");
    expect(onFile).toHaveBeenCalledTimes(1);
    await file.store.put(key, "refreshed");
    expect(onFile).toHaveBeenCalledTimes(2);
    await file.store.get(key);
    await file.store.delete(key);
    await file.store.deletePrefix(leaseSecretPrefix("lease-warn"));
    expect(onFile).toHaveBeenCalledTimes(2);

    const onKeychain = vi.fn();
    const keychain = createDefaultSecretStore({
      root: freshRoot(),
      env: {},
      platform: PLATFORM,
      binding: new FakeKeychainBinding(),
      onPlaintextWrite: onKeychain,
    });
    await keychain.store.put(key, "seed");
    await keychain.store.put(key, "refreshed");
    expect(onKeychain).not.toHaveBeenCalled();
  });

  it("does not fire when the file put fails", async () => {
    const onWrite = vi.fn();
    const { store } = createDefaultSecretStore({
      root: freshRoot(),
      env: { STINT_SECRET_STORE: "file" },
      platform: PLATFORM,
      onPlaintextWrite: onWrite,
    });
    await expect(store.put("not-a-valid-key", "v")).rejects.toThrow();
    expect(onWrite).not.toHaveBeenCalled();
  });
});

describe("assertSecretStoreAvailable", () => {
  it("plaintext_file resolves without touching the binding (no probe)", async () => {
    const binding = new FakeKeychainBinding();
    await expect(
      assertSecretStoreAvailable({ root: freshRoot(), backend: "plaintext_file", platform: PLATFORM, binding }),
    ).resolves.toBeUndefined();
    expect(binding.calls).toBe(0);
  });

  it("os_keychain resolves when the probe round-trips", async () => {
    const binding = new FakeKeychainBinding();
    await expect(
      assertSecretStoreAvailable({ root: freshRoot(), backend: "os_keychain", platform: PLATFORM, binding }),
    ).resolves.toBeUndefined();
    expect(binding.calls).toBeGreaterThan(0);
    expect(binding.size).toBe(0); // the throwaway probe entry was cleaned up
  });

  it("an unavailable keychain throws a CliError naming the file opt-in, never native text", async () => {
    const binding = new FakeKeychainBinding();
    binding.failWith = new Error("dbus: org.freedesktop.secrets not found");
    const err = await assertSecretStoreAvailable({
      root: freshRoot(),
      backend: "os_keychain",
      platform: PLATFORM,
      binding,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(CliError);
    const message = (err as CliError).safeMessage;
    expect(message).toBe(KEYCHAIN_UNAVAILABLE_MESSAGE);
    expect(message).toContain("STINT_SECRET_STORE=file");
    expect(message).not.toContain("dbus");
  });

  it("a probe false-positive (set rejects after a nominal success path) counts as unavailable", async () => {
    const binding = new FakeKeychainBinding(8); // 32-byte probe value exceeds the cap: set rejects
    await expect(
      assertSecretStoreAvailable({ root: freshRoot(), backend: "os_keychain", platform: PLATFORM, binding }),
    ).rejects.toBeInstanceOf(CliError);
  });

  it("a read-back mismatch counts as unavailable", async () => {
    const binding = new FakeKeychainBinding();
    const realGet = binding.get.bind(binding);
    binding.get = async (service, account) => {
      const value = await realGet(service, account);
      return value === undefined ? undefined : Uint8Array.from(value, (b) => b ^ 0xff);
    };
    await expect(
      assertSecretStoreAvailable({ root: freshRoot(), backend: "os_keychain", platform: PLATFORM, binding }),
    ).rejects.toBeInstanceOf(CliError);
  });

  it("caches the verdict: the probe body runs once across two calls", async () => {
    const binding = new FakeKeychainBinding();
    const root = freshRoot();
    const opts = { root, backend: "os_keychain", platform: PLATFORM, binding } as const;

    await assertSecretStoreAvailable(opts);
    const afterFirst = binding.calls;
    expect(afterFirst).toBeGreaterThan(0);
    await assertSecretStoreAvailable(opts);
    expect(binding.calls).toBe(afterFirst);
  });

  it("caches an unavailable verdict too", async () => {
    const binding = new FakeKeychainBinding();
    binding.failWith = new Error("down");
    const root = freshRoot();
    const opts = { root, backend: "os_keychain", platform: PLATFORM, binding } as const;

    await expect(assertSecretStoreAvailable(opts)).rejects.toBeInstanceOf(CliError);
    const afterFirst = binding.calls;
    await expect(assertSecretStoreAvailable(opts)).rejects.toBeInstanceOf(CliError);
    expect(binding.calls).toBe(afterFirst);
  });
});
