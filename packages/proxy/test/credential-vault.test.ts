/**
 * 10-03 Task 1 (CRED-02, D-B): a stored API key carries the one origin it was
 * seeded for, the strict parse refuses a key with no usable origin, and
 * `resolveOutboundCredential` hands a connector the credential's kind (and,
 * for a key, its origin) while `resolveAccessToken` stays byte-unchanged.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { credentialSecretKey } from "@stint/core";
import { createInMemorySecretStore } from "@stint/core/testing";

import {
  createCredentialVault,
  parseStoredCredential,
  serializeStoredCredential,
} from "../src/vault/credential-vault.js";
import type { OAuthSeededCredential, SeededCredential } from "../src/vault/oauth-client.js";
import { startMockAuthServer } from "../src/testing.js";
import type { MockAuthHarness } from "../src/testing.js";

const NOW = 1_700_000_000;
const LEASE = "lease-origin";
const PAYSTACK_ORIGIN = "https://api.paystack.co";

function oauthSeed(overrides?: Partial<OAuthSeededCredential>): OAuthSeededCredential {
  return {
    accessToken: "seed-access-token",
    refreshToken: "seed-refresh-token",
    expiry: NOW + 600,
    tokenEndpoint: "https://as.origin-test.example/token",
    resourceIndicator: "https://api.origin-test.example/v1",
    ...overrides,
  };
}

describe("the api_key origin member in the stored credential", () => {
  it("round-trips { kind: api_key, key, origin } exactly", () => {
    const key: SeededCredential = { kind: "api_key", key: "sk_x", origin: PAYSTACK_ORIGIN };
    expect(parseStoredCredential(serializeStoredCredential(key))).toEqual(key);
  });

  it("accepts a loopback http origin", () => {
    const key: SeededCredential = { kind: "api_key", key: "sk_x", origin: "http://127.0.0.1:3999" };
    expect(parseStoredCredential(serializeStoredCredential(key))).toEqual(key);
  });

  it.each([
    ["no origin", { kind: "api_key", key: "sk_x" }],
    ["a non-string origin", { kind: "api_key", key: "sk_x", origin: 7 }],
    ["an unparseable origin", { kind: "api_key", key: "sk_x", origin: "not a url" }],
    ["a non-https non-loopback origin", { kind: "api_key", key: "sk_x", origin: "http://10.0.0.5:1" }],
    ["a plain-http public origin", { kind: "api_key", key: "sk_x", origin: "http://api.paystack.co" }],
    ["a non-http scheme", { kind: "api_key", key: "sk_x", origin: "ftp://api.paystack.co" }],
    ["an empty key", { kind: "api_key", key: "", origin: PAYSTACK_ORIGIN }],
  ])("treats a stored api_key with %s as absent", (_label, credential) => {
    expect(parseStoredCredential(JSON.stringify({ v: 1, credential }))).toBeUndefined();
  });

  it("the vault reports no usable credential for a stored api_key with no origin", async () => {
    const harness = await startMockAuthServer();
    try {
      const secrets = createInMemorySecretStore();
      await secrets.put(
        credentialSecretKey(LEASE, "res-key"),
        JSON.stringify({ v: 1, credential: { kind: "api_key", key: "sk_x" } }),
      );
      const vault = createCredentialVault(harness.oauthClient, () => NOW, { secrets });
      await expect(vault.resolveOutboundCredential(LEASE, "res-key", NOW)).rejects.toThrow(/no credential seeded/);
      await expect(vault.resolveAccessToken(LEASE, "res-key", NOW)).rejects.toThrow(/no credential seeded/);
    } finally {
      await harness.stop();
    }
  });
});

describe("resolveOutboundCredential", () => {
  let harness: MockAuthHarness;

  beforeEach(async () => {
    harness = await startMockAuthServer();
  });

  afterEach(async () => {
    await harness.stop();
  });

  it("returns the key, the api_key kind and the recorded origin for an API key", async () => {
    const vault = createCredentialVault(harness.oauthClient, () => NOW, { allowInsecureRequests: true });
    vault.seedCredential(LEASE, "res-key", { kind: "api_key", key: "sk_x", origin: PAYSTACK_ORIGIN });
    await expect(vault.resolveOutboundCredential(LEASE, "res-key", NOW)).resolves.toEqual({
      accessToken: "sk_x",
      kind: "api_key",
      origin: PAYSTACK_ORIGIN,
    });
  });

  it("returns { accessToken, kind: oauth } with no origin member for an OAuth grant", async () => {
    const vault = createCredentialVault(harness.oauthClient, () => NOW, { allowInsecureRequests: true });
    vault.seedCredential(LEASE, "res-oauth", oauthSeed());
    const resolved = await vault.resolveOutboundCredential(LEASE, "res-oauth", NOW);
    expect(resolved).toEqual({ accessToken: "seed-access-token", kind: "oauth" });
    expect("origin" in resolved).toBe(false);
  });

  it("an expired OAuth access token still refreshes through it, with one token-endpoint hit", async () => {
    const vault = createCredentialVault(harness.oauthClient, () => NOW, { allowInsecureRequests: true });
    vault.seedCredential(LEASE, "res-expired", oauthSeed({ expiry: NOW - 10 }));
    const resolved = await vault.resolveOutboundCredential(LEASE, "res-expired", NOW);
    expect(resolved.kind).toBe("oauth");
    expect(resolved.accessToken).not.toBe("seed-access-token");
    expect(harness.tokenEndpointHits).toBe(1);
  });

  it("loads an API key through from the store and keeps its origin", async () => {
    const secrets = createInMemorySecretStore();
    await secrets.put(
      credentialSecretKey(LEASE, "res-key"),
      serializeStoredCredential({ kind: "api_key", key: "sk_stored", origin: PAYSTACK_ORIGIN }),
    );
    const vault = createCredentialVault(harness.oauthClient, () => NOW, { secrets });
    await expect(vault.resolveOutboundCredential(LEASE, "res-key", NOW)).resolves.toEqual({
      accessToken: "sk_stored",
      kind: "api_key",
      origin: PAYSTACK_ORIGIN,
    });
  });

  it("rejects when nothing is seeded, with the same fixed message as resolveAccessToken", async () => {
    const vault = createCredentialVault(harness.oauthClient, () => NOW);
    await expect(vault.resolveOutboundCredential(LEASE, "absent", NOW)).rejects.toThrow(/no credential seeded/);
  });

  it("resolveAccessToken still returns the bare key string for an API key", async () => {
    const vault = createCredentialVault(harness.oauthClient, () => NOW);
    vault.seedCredential(LEASE, "res-key", { kind: "api_key", key: "sk_x", origin: PAYSTACK_ORIGIN });
    await expect(vault.resolveAccessToken(LEASE, "res-key", NOW)).resolves.toBe("sk_x");
  });
});
