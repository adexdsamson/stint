/**
 * `refresh-single-flight.test.ts` (PRXY-08) -- Task 1: "oauth-client:
 * refreshAccessToken" exercises `oauth-client.ts` directly against a fresh
 * loopback `oauth2-mock-server` per test: a successful refresh, the RFC
 * 8707 `resource` indicator on the request, and D-09's classification
 * (`invalid_grant` -> `provider_revoked`, anything else -> `transient_error`).
 * Task 3 extends this file with the "credential-vault: single-flight
 * refresh" describe block -- the end-to-end PRXY-08 concurrency proof
 * (exactly-one-hit same-key, exactly-two-hits cross-key) driven through
 * `credential-vault.ts` itself, not the raw `refreshAccessToken` call.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CredentialRefreshError, createCredentialVault } from "../src/vault/credential-vault.js";
import type { CredentialVault } from "../src/vault/credential-vault.js";
import { refreshAccessToken } from "../src/vault/oauth-client.js";
import type { SeededCredential } from "../src/vault/oauth-client.js";
import { startMockAuthServer } from "../src/testing.js";
import type { MockAuthHarness } from "../src/testing.js";

const NOW = 1_700_000_000;
const RESOURCE_INDICATOR = "https://api.paystack.example/v1";

function seedFor(overrides?: Partial<SeededCredential>): SeededCredential {
  return {
    accessToken: "seed-access-token",
    refreshToken: "seed-refresh-token",
    expiry: NOW - 10, // already expired
    tokenEndpoint: "unused-by-this-plan-see-oauthClient.as.token_endpoint",
    resourceIndicator: RESOURCE_INDICATOR,
    ...overrides,
  };
}

describe("oauth-client: refreshAccessToken (PRXY-08 foundation)", () => {
  let harness: MockAuthHarness;

  beforeEach(async () => {
    harness = await startMockAuthServer();
  });

  afterEach(async () => {
    await harness.stop();
  });

  it("a successful refresh returns ok with a new access token, refresh token, and expiry", async () => {
    const result = await refreshAccessToken(harness.oauthClient, seedFor(), NOW, { allowInsecureRequests: true });

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(typeof result.accessToken).toBe("string");
    expect(result.accessToken.length).toBeGreaterThan(0);
    expect(typeof result.refreshToken).toBe("string");
    expect(result.expiry).toBeGreaterThan(NOW);
  });

  it("the refresh request carries the RFC 8707 resource indicator", async () => {
    await refreshAccessToken(harness.oauthClient, seedFor(), NOW, { allowInsecureRequests: true });

    expect(harness.lastTokenRequestBody?.resource).toBe(RESOURCE_INDICATOR);
  });

  it("a forced invalid_grant classifies the refresh as provider_revoked", async () => {
    harness.forceNextTokenError("invalid_grant");

    const result = await refreshAccessToken(harness.oauthClient, seedFor(), NOW, { allowInsecureRequests: true });

    expect(result.kind).toBe("provider_revoked");
  });

  it("a forced non-invalid_grant token-endpoint error classifies the refresh as transient_error", async () => {
    harness.forceNextTokenError("server_error");

    const result = await refreshAccessToken(harness.oauthClient, seedFor(), NOW, { allowInsecureRequests: true });

    expect(result.kind).toBe("transient_error");
    if (result.kind === "transient_error") {
      expect(result.cause).toBeDefined();
    }
  });
});

describe("credential-vault: single-flight refresh (PRXY-08)", () => {
  let harness: MockAuthHarness;
  let vault: CredentialVault;

  beforeEach(async () => {
    harness = await startMockAuthServer();
    vault = createCredentialVault(harness.oauthClient, () => NOW, { allowInsecureRequests: true });
  });

  afterEach(async () => {
    await harness.stop();
  });

  it("seedCredential + resolveAccessToken round-trip an unexpired token without any token-endpoint hit", async () => {
    vault.seedCredential("lease-a", "resource-a", seedFor({ accessToken: "still-fresh", expiry: NOW + 1000 }));

    const token = await vault.resolveAccessToken("lease-a", "resource-a", NOW);

    expect(token).toBe("still-fresh");
    expect(harness.tokenEndpointHits).toBe(0);
  });

  it("an expired token triggers exactly one refresh", async () => {
    vault.seedCredential("lease-b", "resource-b", seedFor());

    const token = await vault.resolveAccessToken("lease-b", "resource-b", NOW);

    expect(typeof token).toBe("string");
    expect(harness.tokenEndpointHits).toBe(1);
  });

  it("the vault's refresh carries the RFC 8707 resource indicator", async () => {
    vault.seedCredential("lease-c", "resource-c", seedFor());

    await vault.resolveAccessToken("lease-c", "resource-c", NOW);

    expect(harness.lastTokenRequestBody?.resource).toBe(RESOURCE_INDICATOR);
  });

  it("a forced invalid_grant during vault refresh rejects with CredentialRefreshError(provider_revoked)", async () => {
    vault.seedCredential("lease-d", "resource-d", seedFor());
    harness.forceNextTokenError("invalid_grant");

    try {
      await vault.resolveAccessToken("lease-d", "resource-d", NOW);
      expect.unreachable("expected resolveAccessToken to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(CredentialRefreshError);
      expect((err as CredentialRefreshError).kind).toBe("provider_revoked");
    }
  });

  it("N concurrent resolveAccessToken calls for the SAME leaseId:resource collapse to exactly one token-endpoint hit and one shared token", async () => {
    const leaseId = "lease-concurrent";
    const resource = "resource-concurrent";
    vault.seedCredential(leaseId, resource, seedFor());

    const N = 20;
    const tokens = await Promise.all(
      Array.from({ length: N }, () => vault.resolveAccessToken(leaseId, resource, NOW)),
    );

    expect(harness.tokenEndpointHits).toBe(1);
    expect(new Set(tokens).size).toBe(1);
    expect(tokens).toHaveLength(N);
  });

  it("N concurrent calls across two DIFFERENT leaseId:resource keys produce exactly two hits (independent per credential)", async () => {
    vault.seedCredential("lease-x", "resource-x", seedFor());
    vault.seedCredential("lease-y", "resource-y", seedFor());

    const N = 10;
    await Promise.all([
      ...Array.from({ length: N }, () => vault.resolveAccessToken("lease-x", "resource-x", NOW)),
      ...Array.from({ length: N }, () => vault.resolveAccessToken("lease-y", "resource-y", NOW)),
    ]);

    expect(harness.tokenEndpointHits).toBe(2);
  });

  it("the raw token store is not reachable from any exported symbol", () => {
    // 05-04 (D-22, D-23): revokeAndDiscardLeaseCredentials/discardLeaseCredentials
    // are additive teardown-step-1 methods -- neither returns a raw token,
    // preserving the custody boundary this test asserts.
    expect(Object.keys(vault).sort()).toEqual([
      "discardLeaseCredentials",
      "resolveAccessToken",
      "revokeAndDiscardLeaseCredentials",
      "seedCredential",
    ]);
  });
});
