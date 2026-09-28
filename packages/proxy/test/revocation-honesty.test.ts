/**
 * TEAR-02 honesty matrix (05-04). Task 1: `revokeCredential`'s structural
 * RFC 7009 tri-state in isolation (no vault, no teardown step) -- the
 * absent-endpoint case never makes an HTTP call, the 2xx case is never
 * upgraded beyond `revoked`, and any thrown error collapses to `failed`
 * without leaking a raw cause. Tasks 2 and 3 extend this file with the
 * vault-level discard-on-teardown proof and the full step-1/Pitfall-5
 * end-to-end matrix.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as oauth from "oauth4webapi";

import { revokeCredential } from "../src/vault/oauth-client.js";
import type { OAuthClient } from "../src/vault/oauth-client.js";
import { startMockAuthServer } from "../src/testing.js";
import type { MockAuthHarness } from "../src/testing.js";

/** An `OAuthClient` whose AS metadata has NO `revocation_endpoint` at all -- the D-20 structural distinguisher. Only `issuer` is required by `oauth.AuthorizationServer`. */
function makeAbsentEndpointClient(): OAuthClient {
  return {
    as: { issuer: "https://as.revocation-honesty-test.example" },
    client: { client_id: "revocation-honesty-test-client" },
    clientAuth: oauth.None(),
  };
}

/**
 * An `OAuthClient` whose `revocation_endpoint` points at a loopback address
 * with no listener (port 1 -- connecting, unlike binding, needs no
 * privilege, and nothing listens there), so any revoke attempt fails fast
 * with a real network error -- constructed directly, per the plan, rather
 * than forcing the mock AS's own always-200 `/revoke`.
 */
function makeErroringEndpointClient(): OAuthClient {
  return {
    as: {
      issuer: "https://as.revocation-honesty-test.example",
      revocation_endpoint: "http://127.0.0.1:1/revoke",
    },
    client: { client_id: "revocation-honesty-test-client" },
    clientAuth: oauth.None(),
  };
}

describe("revokeCredential: structural RFC 7009 tri-state (D-20, Pitfall 5, TEAR-02)", () => {
  it("returns discarded_revocation_unsupported and makes NO HTTP call when as.revocation_endpoint is undefined", async () => {
    const client = makeAbsentEndpointClient();
    // No `fetch` stub/spy needed: the structural check must short-circuit
    // before any network call is even attempted -- if it did not, hitting
    // `https://as.revocation-honesty-test.example` (a non-routable, non-existent
    // host) would reject with a network error instead of resolving cleanly.
    const result = await revokeCredential(client, "refresh-token-absent-endpoint");

    expect(result).toEqual({ kind: "discarded_revocation_unsupported" });
  });

  describe("against a mock AS with a revocation_endpoint", () => {
    let harness: MockAuthHarness;

    beforeEach(async () => {
      harness = await startMockAuthServer();
    });

    afterEach(async () => {
      await harness.stop();
    });

    it("returns revoked (and nothing stronger) on a 2xx response", async () => {
      expect(harness.oauthClient.as.revocation_endpoint).toBeDefined();

      const result = await revokeCredential(harness.oauthClient, "refresh-token-2xx", {
        allowInsecureRequests: true,
      });

      expect(result).toEqual({ kind: "revoked" });
    });
  });

  it("returns failed (error collapsed, no raw error leaked) when the revoke endpoint errors", async () => {
    const client = makeErroringEndpointClient();

    const result = await revokeCredential(client, "refresh-token-erroring", {
      allowInsecureRequests: true,
    });

    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    // The classified result itself never carries a raw error STRING for a
    // receipt to accidentally serialize -- `cause` is the caught value for
    // local diagnostics only; callers (teardown step 1) must never forward
    // it to a receipt (Pitfall 8, proven end-to-end in Task 3).
    expect(result.cause).toBeDefined();
  });
});
