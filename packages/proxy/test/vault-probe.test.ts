/**
 * SUP-04 (09-06) Task 2: `CredentialVault.probeGrant`, the idle-lease probe
 * (D-14, D-16). It reaches the token endpoint even while the cached access
 * token is valid, persists a rotated refresh token through the SecretStore,
 * reports only a definitive 4xx as a revocation (D-17), shares the single
 * flight with `resolveAccessToken`, and never puts a token in its result.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { credentialSecretKey } from "@stint/core";
import { createInMemorySecretStore } from "@stint/core/testing";
import type { SecretStore } from "@stint/core";

import { createCredentialVault, parseStoredCredential, serializeStoredCredential } from "../src/vault/credential-vault.js";
import type { CredentialVault, ProbeGrantResult } from "../src/vault/credential-vault.js";
import { oauthClientFromCredential } from "../src/vault/oauth-client.js";
import type { OAuthSeededCredential, SeededCredential } from "../src/vault/oauth-client.js";
import { startMockAuthServer } from "../src/testing.js";
import type { MockAuthHarness } from "../src/testing.js";

const NOW = 1_700_000_000;
const LEASE = "lease-probe";
const RESOURCE = "res-probe";
const SEED_ACCESS = "probe-seed-access-token";
const SEED_REFRESH = "probe-seed-refresh-token";

function validForAnHour(overrides?: Partial<OAuthSeededCredential>): OAuthSeededCredential {
  return {
    accessToken: SEED_ACCESS,
    refreshToken: SEED_REFRESH,
    expiry: NOW + 3600,
    tokenEndpoint: "https://as.probe-test.example/token",
    resourceIndicator: "https://api.probe-test.example/v1",
    ...overrides,
  };
}

describe("CredentialVault.probeGrant", () => {
  let harness: MockAuthHarness;
  let store: SecretStore;
  let vault: CredentialVault;
  const results: ProbeGrantResult[] = [];

  beforeEach(async () => {
    harness = await startMockAuthServer();
    store = createInMemorySecretStore();
    results.length = 0;
    vault = createCredentialVault(harness.oauthClient, () => NOW, { allowInsecureRequests: true, secrets: store });
  });

  afterEach(async () => {
    await harness.stop();
  });

  async function probe(resource = RESOURCE): Promise<ProbeGrantResult> {
    const result = await vault.probeGrant(LEASE, resource, NOW);
    results.push(result);
    return result;
  }

  async function storedCredential(resource = RESOURCE): Promise<SeededCredential | undefined> {
    const raw = await store.get(credentialSecretKey(LEASE, resource));
    return raw === undefined ? undefined : parseStoredCredential(raw);
  }

  it("reaches the token endpoint while the access token is still valid and persists the rotated refresh token", async () => {
    vault.seedCredential(LEASE, RESOURCE, validForAnHour());
    const before = harness.tokenEndpointHits;

    await expect(probe()).resolves.toEqual({ kind: "ok" });

    expect(harness.tokenEndpointHits).toBe(before + 1);
    const stored = await storedCredential();
    expect(stored).toBeDefined();
    if (stored === undefined || "key" in stored) throw new Error("expected a stored OAuth credential");
    expect(stored.refreshToken).not.toBe("");
    expect(stored.refreshToken).not.toBe(SEED_REFRESH);
    expect(stored.accessToken).not.toBe(SEED_ACCESS);
    expect(stored.expiry).toBeGreaterThan(NOW);
  });

  it("a probe loads a credential through from the store when memory is empty", async () => {
    await store.put(credentialSecretKey(LEASE, RESOURCE), serializeStoredCredential(validForAnHour()));
    const before = harness.tokenEndpointHits;
    await expect(probe()).resolves.toEqual({ kind: "ok" });
    expect(harness.tokenEndpointHits).toBe(before + 1);
  });

  it("maps a forced invalid_grant (status 400) to provider_revoked", async () => {
    vault.seedCredential(LEASE, RESOURCE, validForAnHour());
    harness.forceNextTokenError("invalid_grant");
    await expect(probe()).resolves.toEqual({ kind: "provider_revoked" });
  });

  it("a 403 invalid_grant is provider_revoked", async () => {
    vault.seedCredential(LEASE, RESOURCE, validForAnHour());
    harness.forceNextTokenResponse(403, { error: "invalid_grant" });
    await expect(probe()).resolves.toEqual({ kind: "provider_revoked" });
  });

  it("a 503 with an invalid_grant body is transient, never a revocation", async () => {
    vault.seedCredential(LEASE, RESOURCE, validForAnHour());
    harness.forceNextTokenResponse(503, { error: "invalid_grant" });
    await expect(probe()).resolves.toEqual({ kind: "transient" });
  });

  it("a 429 with an invalid_grant body is transient", async () => {
    vault.seedCredential(LEASE, RESOURCE, validForAnHour());
    harness.forceNextTokenResponse(429, { error: "invalid_grant" });
    await expect(probe()).resolves.toEqual({ kind: "transient" });
  });

  it("a failed probe leaves the stored refresh token untouched", async () => {
    vault.seedCredential(LEASE, RESOURCE, validForAnHour());
    harness.forceNextTokenResponse(503, { error: "temporarily_unavailable" });
    await probe();
    expect(await storedCredential()).toBeUndefined();
    await expect(vault.resolveAccessToken(LEASE, RESOURCE, NOW)).resolves.toBe(SEED_ACCESS);
  });

  it("a transient probe carries the provider's Retry-After as retryAfterSeconds", async () => {
    // The mock cannot set headers, so the classifier-to-probe plumbing is driven through a
    // loopback endpoint that does.
    const { createServer } = await import("node:http");
    const stub = createServer((_req, res) => {
      res.writeHead(429, { "content-type": "application/json", "retry-after": "45" });
      res.end(JSON.stringify({ error: "slow_down" }));
    });
    await new Promise<void>((resolve) => {
      stub.listen(0, "127.0.0.1", () => {
        resolve();
      });
    });
    try {
      const address = stub.address();
      if (address === null || typeof address === "string") throw new Error("no stub address");
      const origin = `http://127.0.0.1:${String(address.port)}`;
      const perCredential = createCredentialVault((_resource, credential) => oauthClientFromCredential(credential), () => NOW, {
        allowInsecureRequests: true,
      });
      perCredential.seedCredential(LEASE, RESOURCE, validForAnHour({ tokenEndpoint: `${origin}/token` }));
      const result = await perCredential.probeGrant(LEASE, RESOURCE, NOW);
      expect(result).toEqual({ kind: "transient", retryAfterSeconds: 45 });
    } finally {
      stub.closeAllConnections();
      await new Promise<void>((resolve) => {
        stub.close(() => {
          resolve();
        });
      });
    }
  });

  it("an API key is not_probeable and makes no request", async () => {
    vault.seedCredential(LEASE, "res-key", { kind: "api_key", key: "sk-probe-key" });
    const before = harness.tokenEndpointHits;
    await expect(probe("res-key")).resolves.toEqual({ kind: "not_probeable" });
    expect(harness.tokenEndpointHits).toBe(before);
  });

  it("an OAuth credential with an empty refresh token is not_probeable and makes no request", async () => {
    vault.seedCredential(LEASE, "res-empty", validForAnHour({ refreshToken: "" }));
    const before = harness.tokenEndpointHits;
    await expect(probe("res-empty")).resolves.toEqual({ kind: "not_probeable" });
    expect(harness.tokenEndpointHits).toBe(before);
  });

  it("a resource the store does not hold is not_probeable and makes no request", async () => {
    const before = harness.tokenEndpointHits;
    await expect(probe("res-absent")).resolves.toEqual({ kind: "not_probeable" });
    expect(harness.tokenEndpointHits).toBe(before);
  });

  it("a probe and a resolveAccessToken started together make one token request between them", async () => {
    vault.seedCredential(LEASE, RESOURCE, validForAnHour({ expiry: NOW - 10 }));
    const before = harness.tokenEndpointHits;

    const probing = vault.probeGrant(LEASE, RESOURCE, NOW);
    const resolving = vault.resolveAccessToken(LEASE, RESOURCE, NOW);
    const [result, token] = await Promise.all([probing, resolving]);
    results.push(result);

    expect(result).toEqual({ kind: "ok" });
    expect(token).not.toBe(SEED_ACCESS);
    expect(harness.tokenEndpointHits).toBe(before + 1);
  });

  it("a probe result never contains a token", async () => {
    vault.seedCredential(LEASE, RESOURCE, validForAnHour());
    await probe();
    harness.forceNextTokenResponse(503, { error: "invalid_grant", error_description: SEED_REFRESH });
    await probe();
    harness.forceNextTokenError("invalid_grant");
    await probe();
    await probe("res-absent");

    const stored = await storedCredential();
    if (stored === undefined || "key" in stored) throw new Error("expected a stored OAuth credential");
    const serialized = JSON.stringify(results);
    for (const secret of [SEED_ACCESS, SEED_REFRESH, stored.accessToken, stored.refreshToken]) {
      expect(serialized).not.toContain(secret);
    }
    expect(results.length).toBeGreaterThanOrEqual(4);
  });
});
