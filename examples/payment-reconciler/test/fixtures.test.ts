/**
 * The hermetic backend fixtures in isolation (plan 07-05): headless OAuth
 * acquisition, the mock publisher, the recorded loopback customer services and
 * the signed hybrid manifest + run profiles. Every server binds loopback port 0
 * and is stopped in `afterEach`; no sleeps.
 */

import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import { importLicensePublicKey, createLicenseIssuerClient } from "@stint/core/license-issuer";
import { httpIssuerTransport } from "@stint/cli";
import type { LoadedCredential } from "@stint/cli";
import { mintCleanupToken } from "@stint/proxy";
import { startMockAuthServer } from "@stint/proxy/testing";
import type { MockAuthHarness } from "@stint/proxy/testing";
import { generateKeyPair } from "jose";
import { afterEach, describe, expect, it } from "vitest";

import { startMockPublisher } from "../src/mocks/publisher.js";
import type { MockPublisher } from "../src/mocks/publisher.js";
import { acquireCredentialsFile, acquireGrant, writeCredentialsFile } from "../src/oauth/acquire.js";

const PAYSTACK = "paystack.transactions";
const SHEETS = "sheets.orders";
const NOW = 1_800_000_000;
const SPEC_VERSION = "alp/0.1";

const stoppers: Array<() => Promise<void>> = [];
const tempDirs: string[] = [];

function track<T extends { stop(): Promise<void> }>(server: T): T {
  stoppers.push(() => server.stop());
  return server;
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "alp-fixtures-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(stoppers.splice(0).map((stop) => stop()));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("headless OAuth acquisition (D-05)", () => {
  it("yields a credential in the --credentials shape bound to its resource", async () => {
    const as = track(await startMockAuthServer());
    const credential = await acquireGrant({
      issuerUrl: as.issuerUrl,
      tokenEndpoint: as.oauthClient.as.token_endpoint ?? "",
      ...(as.oauthClient.as.revocation_endpoint === undefined
        ? {}
        : { revocationEndpoint: as.oauthClient.as.revocation_endpoint }),
      clientId: as.oauthClient.client.client_id,
      resource: PAYSTACK,
      now: () => NOW,
    });

    expect(credential.accessToken).not.toBe("");
    expect(credential.refreshToken).not.toBe("");
    expect(credential.resourceIndicator).toBe(PAYSTACK);
    expect(credential.clientId).toBe(as.oauthClient.client.client_id);
    expect(URL.canParse(credential.tokenEndpoint)).toBe(true);
    expect(credential.revocationEndpoint).toBeDefined();
    expect(credential.expiry).toBe(NOW + 3600);

    // The grant really went through the code + PKCE exchange with the RFC 8707 indicator.
    expect(as.tokenEndpointHits).toBe(1);
    expect(as.lastTokenRequestBody?.grant_type).toBe("authorization_code");
    expect(as.lastTokenRequestBody?.resource).toBe(PAYSTACK);
    expect(typeof as.lastTokenRequestBody?.code_verifier).toBe("string");
  });

  it("honors a forced short access-token lifetime (forces a real vault refresh later)", async () => {
    const as = track(await startMockAuthServer());
    as.forceNextExpiresIn(1);
    const credential = await acquireGrant({
      issuerUrl: as.issuerUrl,
      tokenEndpoint: as.oauthClient.as.token_endpoint ?? "",
      clientId: as.oauthClient.client.client_id,
      resource: PAYSTACK,
      now: () => NOW,
    });
    expect(credential.expiry - NOW).toBe(1);
  });

  it("acquires one credential per resource and writes a file loadCredentials shape", async () => {
    const as: MockAuthHarness = track(await startMockAuthServer());
    const credentials = await acquireCredentialsFile(as, [PAYSTACK, SHEETS], () => NOW);
    expect(Object.keys(credentials)).toEqual([PAYSTACK, SHEETS]);
    expect(credentials[PAYSTACK]?.resourceIndicator).toBe(PAYSTACK);
    expect(credentials[SHEETS]?.resourceIndicator).toBe(SHEETS);

    const dir = await tempDir();
    const file = await writeCredentialsFile(credentials, path.join(dir, "credentials.json"));
    const roundTripped = JSON.parse(await readFile(file, "utf8")) as Record<string, LoadedCredential>;
    expect(roundTripped[SHEETS]?.refreshToken).toBe(credentials[SHEETS]?.refreshToken);
  });
});

describe("mock publisher (D-07, D-10)", () => {
  it("issues a PASETO license the runtime client verifies, then refuses after invalidate", async () => {
    const publisher: MockPublisher = track(await startMockPublisher({ now: () => NOW }));
    const client = createLicenseIssuerClient({
      publicKey: await importLicensePublicKey(publisher.licensePublicKeyPaserk),
      specVersion: SPEC_VERSION,
      transport: httpIssuerTransport({
        issue_url: publisher.issueUrl,
        reissue_url: publisher.reissueUrl,
        invalidate_url: publisher.invalidateUrl,
        license_public_key: publisher.licensePublicKeyPaserk,
      }),
    });
    const claims = {
      lease_id: "lease-1",
      job: { description: "reconcile" },
      limits: { max_actions: 10, actions_per_hour: null },
    };

    // Verified then minted: the client only ever returns a HeldLicense after offline verification.
    const held = await client.issue(claims, NOW, NOW + 600);
    expect(held).toBeDefined();
    expect(publisher.issueHits).toBe(1);
    expect(publisher.issuedTokens).toHaveLength(1);
    expect(publisher.issuedTokens[0]?.startsWith("v4.public.")).toBe(true);

    expect(await client.reissue(claims, NOW + 10, NOW + 600)).not.toBeNull();
    expect(publisher.reissueHits).toBe(1);

    await client.invalidate("lease-1");
    expect(publisher.invalidateHits).toBe(1);
    expect(publisher.invalidatedLeaseIds).toEqual(["lease-1"]);
    expect(await client.reissue(claims, NOW + 20, NOW + 600)).toBeNull();
  });

  it("can decline a reissue on demand", async () => {
    const publisher = track(await startMockPublisher({ now: () => NOW }));
    const client = createLicenseIssuerClient({
      publicKey: await importLicensePublicKey(publisher.licensePublicKeyPaserk),
      specVersion: SPEC_VERSION,
      transport: httpIssuerTransport({
        issue_url: publisher.issueUrl,
        reissue_url: publisher.reissueUrl,
        invalidate_url: publisher.invalidateUrl,
        license_public_key: publisher.licensePublicKeyPaserk,
      }),
    });
    const claims = {
      lease_id: "lease-2",
      job: { description: "reconcile" },
      limits: { max_actions: 10, actions_per_hour: null },
    };
    await client.issue(claims, NOW, NOW + 600);
    publisher.declineReissue(true);
    expect(await client.reissue(claims, NOW + 10, NOW + 600)).toBeNull();
  });

  it("verifies the cleanup bearer, is single-use per jti, and fails exactly once when armed", async () => {
    const publisher = track(await startMockPublisher({ now: () => NOW }));
    const { privateKey, publicKey } = await generateKeyPair("EdDSA", {
      crv: "Ed25519",
      extractable: true,
    });
    const leaseId = "lease-3";

    // The publisher only honors cleanup for a lease it issued a license for.
    const claims = {
      lease_id: leaseId,
      job: { description: "reconcile" },
      limits: { max_actions: 10, actions_per_hour: null },
    };
    const issued = await postJson(publisher.issueUrl, {
      claims,
      spec_version: SPEC_VERSION,
      now: NOW,
      exp: NOW + 600,
    });
    expect(issued.status).toBe(200);

    const bearer = async (jti: string, forLease = leaseId): Promise<Record<string, string>> => ({
      authorization: `Bearer ${await mintCleanupToken(forLease, jti, NOW, privateKey)}`,
    });
    const cleanup = async (jti: string, forLease?: string): Promise<number> =>
      (await postJson(publisher.cleanupUrl, {}, await bearer(jti, forLease))).status;

    // No runtime key pinned yet: fail closed.
    expect(await cleanup("jti-0")).toBe(401);
    publisher.setRuntimePublicKey(publicKey);

    // Missing / forged bearers and a foreign lease scope are refused.
    expect((await postJson(publisher.cleanupUrl, {})).status).toBe(401);
    expect(
      (await postJson(publisher.cleanupUrl, {}, { authorization: "Bearer not-a-jwt" })).status,
    ).toBe(401);
    expect(await cleanup("jti-foreign", "some-other-lease")).toBe(403);

    // Armed: exactly one 500 (the jti is NOT consumed by a failed attempt), then success.
    publisher.failNextCleanup();
    expect(await cleanup("jti-1")).toBe(500);
    expect(publisher.seenJtis).toEqual([]);
    expect(await cleanup("jti-2")).toBe(200);
    expect(publisher.seenJtis).toEqual(["jti-2"]);

    // A replayed jti is refused; a fresh one succeeds again (no more one-shot failure).
    expect(await cleanup("jti-2")).toBe(409);
    expect(await cleanup("jti-3")).toBe(200);
    expect(publisher.seenJtis).toEqual(["jti-2", "jti-3"]);
    expect(publisher.cleanupHits).toBe(8);
  });
});

