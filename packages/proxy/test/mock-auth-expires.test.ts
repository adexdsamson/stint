/**
 * `mock-auth-expires.test.ts` -- the `forceNextExpiresIn` seam on
 * `@stint/proxy/testing`'s `MockAuthHarness` (plan 07-02, D-05, D-14): a
 * one-shot override of the next `/token` response's `expires_in`, so a test
 * can force a real vault refresh without advancing the injected clock. Also
 * covers the additive `revokeHits` counter and proves the seam stays
 * testing-only (never re-exported from the public `.` entry).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { refreshAccessToken, revokeCredential } from "../src/vault/oauth-client.js";
import type { SeededCredential } from "../src/vault/oauth-client.js";
import { startMockAuthServer } from "../src/testing.js";
import type { MockAuthHarness } from "../src/testing.js";

const NOW = 1_700_000_000;

function seed(): SeededCredential {
  return {
    accessToken: "seed-access-token",
    refreshToken: "seed-refresh-token",
    expiry: NOW - 10,
    tokenEndpoint: "unused-see-oauthClient.as.token_endpoint",
    resourceIndicator: "https://api.paystack.example/v1",
  };
}

describe("MockAuthHarness.forceNextExpiresIn", () => {
  let harness: MockAuthHarness;

  beforeEach(async () => {
    harness = await startMockAuthServer();
  });

  afterEach(async () => {
    await harness.stop();
  });

  it("overrides exactly the next /token response's expires_in, then defaults back to 3600", async () => {
    harness.forceNextExpiresIn(1);

    const forced = await refreshAccessToken(harness.oauthClient, seed(), NOW, {
      allowInsecureRequests: true,
    });
    expect(forced.kind).toBe("ok");
    if (forced.kind !== "ok") return;
    expect(forced.expiry - NOW).toBe(1);

    const after = await refreshAccessToken(harness.oauthClient, seed(), NOW, {
      allowInsecureRequests: true,
    });
    expect(after.kind).toBe("ok");
    if (after.kind !== "ok") return;
    expect(after.expiry - NOW).toBe(3600);
    expect(harness.tokenEndpointHits).toBe(2);
  });

  it("leaves forceNextTokenError untouched: an armed error still wins and the override survives it", async () => {
    harness.forceNextExpiresIn(7);
    harness.forceNextTokenError("invalid_grant");

    const failed = await refreshAccessToken(harness.oauthClient, seed(), NOW, {
      allowInsecureRequests: true,
    });
    expect(failed.kind).toBe("provider_revoked");

    const next = await refreshAccessToken(harness.oauthClient, seed(), NOW, {
      allowInsecureRequests: true,
    });
    expect(next.kind).toBe("ok");
    if (next.kind !== "ok") return;
    expect(next.expiry - NOW).toBe(7);
  });

  it("counts /revoke requests via revokeHits", async () => {
    expect(harness.revokeHits).toBe(0);
    const result = await revokeCredential(harness.oauthClient, "seed-refresh-token", {
      allowInsecureRequests: true,
    });
    expect(result.kind).toBe("revoked");
    expect(harness.revokeHits).toBe(1);
  });
});

describe("@stint/proxy public entry", () => {
  it("does not re-export anything from testing.ts", () => {
    const text = readFileSync(fileURLToPath(new URL("../src/index.ts", import.meta.url)), "utf8");
    expect(text).not.toMatch(/from\s+["']\.\/testing(\.js)?["']/);
  });
});
