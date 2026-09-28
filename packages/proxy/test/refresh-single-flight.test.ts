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
