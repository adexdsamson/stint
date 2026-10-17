/**
 * RT-03 (08-05) Task 1: the credential vault holds credentials by kind and
 * refreshes and revokes each one with its own OAuth client. An absent `kind`
 * is an OAuth grant (D-05), an `api_key` never refreshes and is discarded
 * without a network call (D-14), and a resolver gives every credential the
 * client of its own authorization server.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createCredentialVault } from "../src/vault/credential-vault.js";
import { isApiKeyCredential, oauthClientFromCredential } from "../src/vault/oauth-client.js";
import type { OAuthClient, OAuthClientResolver, OAuthSeededCredential, SeededCredential } from "../src/vault/oauth-client.js";
import { startMockAuthServer } from "../src/testing.js";
import type { MockAuthHarness } from "../src/testing.js";

const NOW = 1_700_000_000;
const LEASE = "lease-kinds";

function oauthSeed(overrides?: Partial<OAuthSeededCredential>): OAuthSeededCredential {
  return {
    accessToken: "seed-access-token",
    refreshToken: "seed-refresh-token",
    expiry: NOW - 10,
    tokenEndpoint: "https://as.kinds-test.example/token",
    resourceIndicator: "https://api.kinds-test.example/v1",
    ...overrides,
  };
}

/** A copy of the harness client whose AS metadata carries no `revocation_endpoint`. */
function withoutRevocation(client: OAuthClient): OAuthClient {
  const as = { ...client.as };
  delete as.revocation_endpoint;
  return { ...client, as };
}

describe("credential kinds (D-05)", () => {
  let harness: MockAuthHarness;

  beforeEach(async () => {
    harness = await startMockAuthServer();
  });

  afterEach(async () => {
    await harness.stop();
  });

  it("a credential seeded with no kind resolves and refreshes exactly as before", async () => {
    const vault = createCredentialVault(harness.oauthClient, () => NOW, { allowInsecureRequests: true });
    vault.seedCredential(LEASE, "res-oauth", oauthSeed({ expiry: NOW + 600 }));
    await expect(vault.resolveAccessToken(LEASE, "res-oauth", NOW)).resolves.toBe("seed-access-token");
    expect(harness.tokenEndpointHits).toBe(0);

    vault.seedCredential(LEASE, "res-expired", oauthSeed());
    const refreshed = await vault.resolveAccessToken(LEASE, "res-expired", NOW);
    expect(refreshed).not.toBe("seed-access-token");
    expect(harness.tokenEndpointHits).toBe(1);
  });

  it("holds an OAuth grant and an API key side by side for one lease", async () => {
    const vault = createCredentialVault(harness.oauthClient, () => NOW, { allowInsecureRequests: true });
    vault.seedCredential(LEASE, "res-oauth", oauthSeed({ expiry: NOW + 600 }));
    vault.seedCredential(LEASE, "res-key", { kind: "api_key", key: "sk-live-123", origin: "https://api.kinds-test.example" });

    await expect(vault.resolveAccessToken(LEASE, "res-oauth", NOW)).resolves.toBe("seed-access-token");
    await expect(vault.resolveAccessToken(LEASE, "res-key", NOW)).resolves.toBe("sk-live-123");
  });

  it("an API key resolves at any now, never calls a token endpoint and never enters the refresh path", async () => {
    const vault = createCredentialVault(harness.oauthClient, () => NOW, { allowInsecureRequests: true });
    vault.seedCredential(LEASE, "res-key", { kind: "api_key", key: "sk-live-123", origin: "https://api.kinds-test.example" });

    await expect(vault.resolveAccessToken(LEASE, "res-key", NOW)).resolves.toBe("sk-live-123");
    await expect(vault.resolveAccessToken(LEASE, "res-key", NOW + 10_000_000)).resolves.toBe("sk-live-123");
    await expect(vault.resolveAccessToken(LEASE, "res-key", 0)).resolves.toBe("sk-live-123");
    expect(harness.tokenEndpointHits).toBe(0);
  });

  it("isApiKeyCredential narrows only the api_key member", () => {
    const key: SeededCredential = { kind: "api_key", key: "k", origin: "https://api.kinds-test.example" };
    expect(isApiKeyCredential(key)).toBe(true);
    expect(isApiKeyCredential(oauthSeed())).toBe(false);
    expect(isApiKeyCredential(oauthSeed({ kind: "oauth" }))).toBe(false);
  });

  it("a vault built with a plain OAuthClient uses it for every credential, as before", async () => {
    const vault = createCredentialVault(harness.oauthClient, () => NOW, { allowInsecureRequests: true });
    vault.seedCredential(LEASE, "res-a", oauthSeed());
    vault.seedCredential(LEASE, "res-b", oauthSeed());
    await vault.resolveAccessToken(LEASE, "res-a", NOW);
    await vault.resolveAccessToken(LEASE, "res-b", NOW);
    expect(harness.tokenEndpointHits).toBe(2);
  });

  it("keeps exactly the six vault keys", () => {
    const vault = createCredentialVault(harness.oauthClient, () => NOW);
    expect(Object.keys(vault).sort()).toEqual([
      "discardLeaseCredentials",
      "probeGrant",
      "resolveAccessToken",
      "resolveOutboundCredential",
      "revokeAndDiscardLeaseCredentials",
      "seedCredential",
    ]);
  });
});

describe("a client per credential", () => {
  let serverA: MockAuthHarness;
  let serverB: MockAuthHarness;

  beforeEach(async () => {
    serverA = await startMockAuthServer();
    serverB = await startMockAuthServer();
  });

  afterEach(async () => {
    await serverA.stop();
    await serverB.stop();
  });

  function resolverForTwoServers(): OAuthClientResolver {
    return (resource) => {
      if (resource === "res-a") return serverA.oauthClient;
      if (resource === "res-b") return withoutRevocation(serverB.oauthClient);
      throw new Error(`test setup: no client for ${resource}`);
    };
  }

  it("refreshes each credential against its own token endpoint", async () => {
    const vault = createCredentialVault(resolverForTwoServers(), () => NOW, { allowInsecureRequests: true });
    vault.seedCredential(LEASE, "res-a", oauthSeed());
    vault.seedCredential(LEASE, "res-b", oauthSeed());

    await vault.resolveAccessToken(LEASE, "res-a", NOW);
    expect(serverA.tokenEndpointHits).toBe(1);
    expect(serverB.tokenEndpointHits).toBe(0);

    await vault.resolveAccessToken(LEASE, "res-b", NOW);
    expect(serverA.tokenEndpointHits).toBe(1);
    expect(serverB.tokenEndpointHits).toBe(1);
  });

  it("one teardown yields revoked, discarded_revocation_unsupported and, for the API key, no network call", async () => {
    const clientFor = resolverForTwoServers();
    const resolver: OAuthClientResolver = (resource, credential) => {
      if (resource === "res-key") throw new Error("the resolver must never be asked about an API key");
      return clientFor(resource, credential);
    };
    const vault = createCredentialVault(resolver, () => NOW, { allowInsecureRequests: true });
    vault.seedCredential(LEASE, "res-a", oauthSeed());
    vault.seedCredential(LEASE, "res-b", oauthSeed());
    vault.seedCredential(LEASE, "res-key", { kind: "api_key", key: "sk-live-123", origin: "https://api.kinds-test.example" });

    const outcomes = await vault.revokeAndDiscardLeaseCredentials(LEASE, NOW);
    const byResource = new Map(outcomes.map((o) => [o.resource, o.result.kind]));

    expect(byResource.get("res-a")).toBe("revoked");
    expect(byResource.get("res-b")).toBe("discarded_revocation_unsupported");
    expect(byResource.get("res-key")).toBe("discarded_revocation_unsupported");
    expect(outcomes).toHaveLength(3);
    expect(serverA.revokeHits).toBe(1);
    expect(serverB.revokeHits).toBe(0);

    for (const resource of ["res-a", "res-b", "res-key"]) {
      await expect(vault.resolveAccessToken(LEASE, resource, NOW)).rejects.toThrow(/no credential seeded/);
    }
  });

  it("evaluates a function allowInsecureRequests per resolved client", async () => {
    const seen: string[] = [];
    const vault = createCredentialVault(resolverForTwoServers(), () => NOW, {
      allowInsecureRequests: (client) => {
        seen.push(client.as.issuer);
        // Plain http is allowed for server A only.
        return client.as.issuer === serverA.oauthClient.as.issuer;
      },
    });
    vault.seedCredential(LEASE, "res-a", oauthSeed());
    vault.seedCredential(LEASE, "res-b", oauthSeed());

    await expect(vault.resolveAccessToken(LEASE, "res-a", NOW)).resolves.toBeTypeOf("string");
    // Server B is loopback http and its client was not allowed, so the refresh is a transient failure.
    await expect(vault.resolveAccessToken(LEASE, "res-b", NOW)).rejects.toMatchObject({ kind: "transient_error" });
    expect(seen).toContain(serverA.oauthClient.as.issuer);
    expect(seen).toContain(serverB.oauthClient.as.issuer);
    expect(serverB.tokenEndpointHits).toBe(0);
  });
});

describe("oauthClientFromCredential", () => {
  it("builds the issuer from the token endpoint origin, with the revocation endpoint only when present", () => {
    const withRevocation = oauthClientFromCredential(
      oauthSeed({
        tokenEndpoint: "https://as.one.example/oauth/token",
        revocationEndpoint: "https://as.one.example/oauth/revoke",
        clientId: "client-one",
      }),
    );
    expect(withRevocation.as.issuer).toBe("https://as.one.example");
    expect(withRevocation.as.token_endpoint).toBe("https://as.one.example/oauth/token");
    expect(withRevocation.as.revocation_endpoint).toBe("https://as.one.example/oauth/revoke");
    expect(withRevocation.client.client_id).toBe("client-one");

    const without = oauthClientFromCredential(oauthSeed({ tokenEndpoint: "https://as.two.example/token" }));
    expect("revocation_endpoint" in without.as).toBe(false);
    expect(without.client.client_id).toBe("stint");
  });

  it("authenticates as a public client by client_id only", async () => {
    const client = oauthClientFromCredential(oauthSeed({ clientId: "pub-client" }));
    const body = new URLSearchParams();
    const headers = new Headers();
    await client.clientAuth(client.as, client.client, body, headers);
    expect(body.get("client_id")).toBe("pub-client");
    expect([...headers.keys()]).toEqual([]);
  });
});
