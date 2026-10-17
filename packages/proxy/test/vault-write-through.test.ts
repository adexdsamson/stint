/**
 * RT-03 (08-05) Task 2: the vault loads credentials through from, and writes
 * rotated credentials through to, a `SecretStore`. A rotated refresh token is
 * never lost: memory is updated before the put, a failed put is retried before
 * the next token is returned, and the token endpoint is not hit again.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { credentialSecretKey, leaseSecretPrefix } from "@stint/core";
import type { SecretStore } from "@stint/core";
import { createInMemorySecretStore } from "@stint/core/testing";

import {
  CredentialRefreshError,
  createCredentialVault,
  parseStoredCredential,
  serializeStoredCredential,
} from "../src/vault/credential-vault.js";
import type { OAuthSeededCredential, SeededCredential } from "../src/vault/oauth-client.js";
import { startMockAuthServer } from "../src/testing.js";
import type { MockAuthHarness } from "../src/testing.js";

const NOW = 1_700_000_000;
const LEASE = "lease-wt";
const RESOURCE = "res-wt";

function expired(overrides?: Partial<OAuthSeededCredential>): OAuthSeededCredential {
  return {
    accessToken: "seed-access-token",
    refreshToken: "seed-refresh-token",
    expiry: NOW - 10,
    tokenEndpoint: "https://as.wt-test.example/token",
    resourceIndicator: "https://api.wt-test.example/v1",
    ...overrides,
  };
}

interface CountingStore extends SecretStore {
  readonly puts: number;
  readonly deletes: string[];
  readonly deletedPrefixes: string[];
  failNextPut(): void;
  failDeletes(): void;
  failDeletePrefix(): void;
}

/** Wraps a real in-memory store with put counting and one-shot failure injection. */
function countingStore(inner: SecretStore): CountingStore {
  let puts = 0;
  let failPut = false;
  let failDelete = false;
  let failPrefix = false;
  const deletes: string[] = [];
  const deletedPrefixes: string[] = [];
  return {
    get puts() {
      return puts;
    },
    deletes,
    deletedPrefixes,
    failNextPut() {
      failPut = true;
    },
    failDeletes() {
      failDelete = true;
    },
    failDeletePrefix() {
      failPrefix = true;
    },
    get: (key) => inner.get(key),
    async put(key, value) {
      puts += 1;
      if (failPut) {
        failPut = false;
        throw new Error("simulated backend outage");
      }
      await inner.put(key, value);
    },
    async delete(key) {
      deletes.push(key);
      if (failDelete) throw new Error("simulated delete failure");
      await inner.delete(key);
    },
    async deletePrefix(prefix) {
      deletedPrefixes.push(prefix);
      if (failPrefix) throw new Error("simulated deletePrefix failure");
      return inner.deletePrefix(prefix);
    },
  };
}

describe("stored credential serialization", () => {
  it("round-trips an OAuth grant and an API key", () => {
    const oauth = expired({ clientId: "cid", revocationEndpoint: "https://as.wt-test.example/revoke" });
    expect(parseStoredCredential(serializeStoredCredential(oauth))).toEqual(oauth);
    const key: SeededCredential = { kind: "api_key", key: "sk-1", origin: "https://api.wt-test.example" };
    expect(parseStoredCredential(serializeStoredCredential(key))).toEqual(key);
  });

  it.each([
    ["not json", "{nope"],
    ["wrong version", JSON.stringify({ v: 2, credential: expired() })],
    ["no credential", JSON.stringify({ v: 1 })],
    ["unknown kind", JSON.stringify({ v: 1, credential: { ...expired(), kind: "saml" } })],
    ["api_key without key", JSON.stringify({ v: 1, credential: { kind: "api_key" } })],
    ["non-string token", JSON.stringify({ v: 1, credential: { ...expired(), accessToken: 5 } })],
    ["non-finite expiry", JSON.stringify({ v: 1, credential: { ...expired(), expiry: "soon" } })],
    ["bad token endpoint", JSON.stringify({ v: 1, credential: { ...expired(), tokenEndpoint: "not a url" } })],
    ["non-string clientId", JSON.stringify({ v: 1, credential: { ...expired(), clientId: 1 } })],
    ["bad revocation endpoint", JSON.stringify({ v: 1, credential: { ...expired(), revocationEndpoint: "x" } })],
  ])("treats %s as absent", (_label, raw) => {
    expect(parseStoredCredential(raw)).toBeUndefined();
  });
});

describe("credential vault with a SecretStore", () => {
  let harness: MockAuthHarness;
  let store: CountingStore;

  beforeEach(async () => {
    harness = await startMockAuthServer();
    store = countingStore(createInMemorySecretStore());
  });

  afterEach(async () => {
    await harness.stop();
  });

  function vaultWithStore() {
    return createCredentialVault(harness.oauthClient, () => NOW, {
      allowInsecureRequests: true,
      secrets: store,
    });
  }

  const storeKey = () => credentialSecretKey(LEASE, RESOURCE);

  it("loads a stored credential through when memory is empty", async () => {
    await store.put(storeKey(), serializeStoredCredential(expired({ expiry: NOW + 600 })));
    const vault = vaultWithStore();

    await expect(vault.resolveAccessToken(LEASE, RESOURCE, NOW)).resolves.toBe("seed-access-token");
    expect(harness.tokenEndpointHits).toBe(0);
  });

  it("rejects with the no-credential error and no network call when neither memory nor store has it", async () => {
    const vault = vaultWithStore();
    await expect(vault.resolveAccessToken(LEASE, RESOURCE, NOW)).rejects.toThrow(/no credential seeded/);
    expect(harness.tokenEndpointHits).toBe(0);
  });

  it("treats a stored value that does not parse as absent without echoing it", async () => {
    await store.put(storeKey(), "{this-is-not-a-credential:super-secret-value");
    const vault = vaultWithStore();

    const failure = await vault.resolveAccessToken(LEASE, RESOURCE, NOW).then(
      () => undefined,
      (err: unknown) => err as Error,
    );
    expect(failure?.message).toMatch(/no credential seeded/);
    expect(failure?.message).not.toContain("super-secret-value");
    expect(harness.tokenEndpointHits).toBe(0);
  });

  it("writes a rotated credential through after a refresh", async () => {
    const vault = vaultWithStore();
    vault.seedCredential(LEASE, RESOURCE, expired());

    const token = await vault.resolveAccessToken(LEASE, RESOURCE, NOW);

    const raw = await store.get(storeKey());
    expect(raw).toBeDefined();
    const stored = parseStoredCredential(raw ?? "");
    expect(stored).toBeDefined();
    if (stored === undefined || stored.kind === "api_key") throw new Error("expected an oauth credential");
    expect(stored.accessToken).toBe(token);
    expect(stored.accessToken).not.toBe("seed-access-token");
    expect(stored.refreshToken).not.toBe("seed-refresh-token");
    expect(stored.expiry).toBeGreaterThan(NOW);
    expect(store.puts).toBe(1);
  });

  it("a failing put rejects with transient_error, keeps the new token in memory and retries the put without a second token request", async () => {
    const vault = vaultWithStore();
    vault.seedCredential(LEASE, RESOURCE, expired());
    store.failNextPut();

    const failure = await vault.resolveAccessToken(LEASE, RESOURCE, NOW).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(failure).toBeInstanceOf(CredentialRefreshError);
    expect((failure as CredentialRefreshError).kind).toBe("transient_error");
    expect(harness.tokenEndpointHits).toBe(1);
    expect(await store.get(storeKey())).toBeUndefined();

    const token = await vault.resolveAccessToken(LEASE, RESOURCE, NOW);

    expect(harness.tokenEndpointHits).toBe(1);
    expect(store.puts).toBe(2);
    expect(token).not.toBe("seed-access-token");
    const stored = parseStoredCredential((await store.get(storeKey())) ?? "");
    if (stored === undefined || stored.kind === "api_key") throw new Error("expected an oauth credential");
    expect(stored.accessToken).toBe(token);
    expect(stored.refreshToken).not.toBe("seed-refresh-token");

    // The flag is cleared: a further resolve neither puts nor refreshes.
    await vault.resolveAccessToken(LEASE, RESOURCE, NOW);
    expect(store.puts).toBe(2);
    expect(harness.tokenEndpointHits).toBe(1);
  });

  it("a failing put never puts the credential value in the error", async () => {
    const vault = vaultWithStore();
    vault.seedCredential(LEASE, RESOURCE, expired({ refreshToken: "refresh-secret-xyz" }));
    store.failNextPut();

    const failure = await vault.resolveAccessToken(LEASE, RESOURCE, NOW).then(
      () => undefined,
      (err: unknown) => err as Error,
    );
    expect(failure?.message).not.toContain("refresh-secret-xyz");
    expect(failure?.message).not.toContain("seed-access-token");
  });

  it("20 concurrent resolves on one expired credential make one token request and one put", async () => {
    const vault = vaultWithStore();
    vault.seedCredential(LEASE, RESOURCE, expired());

    const tokens = await Promise.all(
      Array.from({ length: 20 }, () => vault.resolveAccessToken(LEASE, RESOURCE, NOW)),
    );

    expect(harness.tokenEndpointHits).toBe(1);
    expect(store.puts).toBe(1);
    expect(new Set(tokens).size).toBe(1);
    expect(tokens[0]).not.toBe("seed-access-token");
  });

  it("20 concurrent resolves on a credential that is only in the store also make one token request and one put", async () => {
    await store.put(storeKey(), serializeStoredCredential(expired()));
    const putsBefore = store.puts;
    const vault = vaultWithStore();

    const tokens = await Promise.all(
      Array.from({ length: 20 }, () => vault.resolveAccessToken(LEASE, RESOURCE, NOW)),
    );

    expect(harness.tokenEndpointHits).toBe(1);
    expect(store.puts - putsBefore).toBe(1);
    expect(new Set(tokens).size).toBe(1);
  });

  it("revokeAndDiscardLeaseCredentials loads expected resources through, revokes them and deletes the stored key", async () => {
    await store.put(
      storeKey(),
      serializeStoredCredential(expired({ clientId: "stint-test-client" })),
    );
    const vault = vaultWithStore();

    const outcomes = await vault.revokeAndDiscardLeaseCredentials(LEASE, NOW, [RESOURCE]);

    expect(outcomes).toEqual([{ resource: RESOURCE, result: { kind: "revoked" } }]);
    expect(harness.revokeHits).toBe(1);
    expect(await store.get(storeKey())).toBeUndefined();
    expect(store.deletes).toContain(storeKey());
    await expect(vault.resolveAccessToken(LEASE, RESOURCE, NOW)).rejects.toThrow(/no credential seeded/);
  });

  it("revokeAndDiscardLeaseCredentials without expected resources only sees what is in memory", async () => {
    await store.put(storeKey(), serializeStoredCredential(expired()));
    const vault = vaultWithStore();

    const outcomes = await vault.revokeAndDiscardLeaseCredentials(LEASE, NOW);

    expect(outcomes).toEqual([]);
    expect(await store.get(storeKey())).toBeDefined();
  });

  it("a store delete failure does not change the returned outcome", async () => {
    const vault = vaultWithStore();
    vault.seedCredential(LEASE, RESOURCE, expired());
    await store.put(storeKey(), serializeStoredCredential(expired()));
    store.failDeletes();

    const outcomes = await vault.revokeAndDiscardLeaseCredentials(LEASE, NOW, [RESOURCE]);

    expect(outcomes).toEqual([{ resource: RESOURCE, result: { kind: "revoked" } }]);
    await expect(vault.resolveAccessToken(LEASE, RESOURCE, NOW)).rejects.toThrow(/no credential seeded/);
  });

  it("discardLeaseCredentials with a store clears memory and calls deletePrefix for the lease", async () => {
    const vault = vaultWithStore();
    vault.seedCredential(LEASE, RESOURCE, expired({ expiry: NOW + 600 }));
    await store.put(storeKey(), serializeStoredCredential(expired({ expiry: NOW + 600 })));
    await store.put(credentialSecretKey("lease-wt-other", RESOURCE), serializeStoredCredential(expired()));

    const result = vault.discardLeaseCredentials(LEASE);
    expect(result).toBeInstanceOf(Promise);
    await result;

    expect(store.deletedPrefixes).toEqual([leaseSecretPrefix(LEASE)]);
    expect(await store.get(storeKey())).toBeUndefined();
    expect(await store.get(credentialSecretKey("lease-wt-other", RESOURCE))).toBeDefined();
    await expect(vault.resolveAccessToken(LEASE, RESOURCE, NOW)).rejects.toThrow(/no credential seeded/);
  });

  it("a deletePrefix rejection propagates to the caller", async () => {
    const vault = vaultWithStore();
    vault.seedCredential(LEASE, RESOURCE, expired());
    store.failDeletePrefix();

    await expect(vault.discardLeaseCredentials(LEASE)).rejects.toThrow(/simulated deletePrefix failure/);
  });

  it("without a secrets option every method behaves as an in-memory vault", async () => {
    const vault = createCredentialVault(harness.oauthClient, () => NOW, { allowInsecureRequests: true });
    vault.seedCredential(LEASE, RESOURCE, expired());

    await vault.resolveAccessToken(LEASE, RESOURCE, NOW);
    expect(store.puts).toBe(0);
    expect(vault.discardLeaseCredentials(LEASE)).toBeUndefined();
    await expect(vault.resolveAccessToken(LEASE, RESOURCE, NOW)).rejects.toThrow(/no credential seeded/);
  });
});
