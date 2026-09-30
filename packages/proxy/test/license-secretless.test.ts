/**
 * LIC-05 adversarial proof: the publisher license never reaches
 * `OutboundConnector.execute` -- even when the vault-backed `ExecuteStage`
 * is constructed with a real `HeldLicense` present in its context
 * (`LicenseAccessor`). Spies on every argument the port receives and
 * asserts `credential` carries the OAuth access-token shape (`{
 * accessToken }`) ONLY -- the license value (read via `readLicenseToken` in
 * this test ONLY, for comparison -- never inside production code) appears
 * in no argument to the port, nor in the outbound request the reference
 * REST connector would actually send (D-15).
 */

import { describe, expect, it } from "vitest";
import * as oauth from "oauth4webapi";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { createBindingSet, readLicenseToken } from "@stint/core";
import type { ConnectorBinding, HeldLicense, Lease, LicenseClaims } from "@stint/core";
import { createInMemoryLeaseStore, createInMemoryReceiptStore, createMockLicenseIssuer } from "@stint/core/testing";

import { createToolCatalog } from "../src/catalog.js";
import type { OutboundConnector } from "../src/connectors/outbound-connector.js";
import { createRestOutboundConnector } from "../src/connectors/outbound-connector.js";
import type { FetchLike } from "../src/connectors/outbound-connector.js";
import { DEFAULT_APPROVAL_STAGE, DEFAULT_CAP_ENFORCER } from "../src/dispatch.js";
import { createLeaseProxyServer } from "../src/server.js";
import type { ProxyDeps } from "../src/server.js";
import { createCredentialVault } from "../src/vault/credential-vault.js";
import { createVaultExecuteStage } from "../src/vault/execute-stage.js";
import type { OAuthClient } from "../src/vault/oauth-client.js";

const NOW = 1_700_000_000;
const ACCESS_TOKEN = "oauth-access-token-abc123";

const STUB_OAUTH_CLIENT: OAuthClient = {
  as: { issuer: "https://issuer.example.test" },
  client: { client_id: "unused-test-client" },
  clientAuth: oauth.None(),
};

const READ_BINDING: ConnectorBinding = {
  tool: "read_message",
  resource: "inbox",
  access: "read",
  irreversible: false,
  provenance: "built_in",
};

function makeLease(id: string): Lease {
  return {
    id,
    state: "active",
    version: 0,
    boundHash: "jcs-sha256:test",
    grantedAt: NOW - 100,
    expiresAt: NOW + 3600,
    maxDurationSeconds: 3600,
    counters: { actionCount: 0, spentMinor: 0, denialErrorTimestamps: [], actionTimestamps: [] },
  };
}

async function mintTestLicense(leaseId: string): Promise<{ held: HeldLicense; token: string }> {
  const issuer = await createMockLicenseIssuer();
  const claims: LicenseClaims = {
    lease_id: leaseId,
    job: { description: "LIC-05 secretless test job" },
    limits: { max_actions: 10, actions_per_hour: null },
  };
  const held = await issuer.issue(claims, "alp/0.1", NOW, NOW + 300);
  // Test-only comparison read -- production code never calls
  // readLicenseToken outside publisher-facing license logic (D-15).
  return { held, token: readLicenseToken(held) };
}

async function buildLicenseTestDeps(
  leaseId: string,
  connector: OutboundConnector,
  licenseAccessor: Parameters<typeof createVaultExecuteStage>[2],
): Promise<{
  deps: ProxyDeps;
}> {
  const leaseStore = createInMemoryLeaseStore();
  const receiptStore = createInMemoryReceiptStore();
  await leaseStore.save(makeLease(leaseId));

  const catalog = createToolCatalog([
    {
      name: READ_BINDING.tool,
      description: "Reads a message",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
  ]);
  const bindings = createBindingSet([READ_BINDING]);

  const vault = createCredentialVault(STUB_OAUTH_CLIENT, () => NOW);
  vault.seedCredential(leaseId, READ_BINDING.resource, {
    accessToken: ACCESS_TOKEN,
    refreshToken: "unused-refresh-token",
    expiry: NOW + 3600,
    tokenEndpoint: "https://issuer.example.test/token",
    resourceIndicator: READ_BINDING.resource,
  });

  const deps: ProxyDeps = {
    leaseId,
    leaseStore,
    receiptStore,
    catalog,
    bindings,
    grantedScopes: ["read"],
    grantedResources: [READ_BINDING.resource],
    limits: { max_actions: 100 },
    approvals: { require_for: [], timeout_seconds: 30 },
    clock: () => NOW,
    execute: createVaultExecuteStage(vault, connector, licenseAccessor),
    approve: DEFAULT_APPROVAL_STAGE,
    enforceCaps: DEFAULT_CAP_ENFORCER,
  };

  return { deps };
}

async function callReadTool(deps: ProxyDeps): Promise<CallToolResult> {
  const server = createLeaseProxyServer(deps);
  const client = new Client({ name: "test-agent", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return (await client.callTool({ name: READ_BINDING.tool, arguments: {} })) as CallToolResult;
}

describe("LIC-05: the publisher license never reaches OutboundConnector.execute", () => {
  it("credential arg carries { accessToken } only -- the license value appears in no port argument", async () => {
    const leaseId = "lease-license-secretless-spy";
    const { held, token: licenseToken } = await mintTestLicense(leaseId);

    const capturedCalls: Array<
      Parameters<OutboundConnector["execute"]>
    > = [];
    const spyConnector: OutboundConnector = {
      execute(binding, resolvedArgs, credential) {
        capturedCalls.push([binding, resolvedArgs, credential]);
        return Promise.resolve({ status: 200, body: { ok: true } });
      },
    };

    const { deps } = await buildLicenseTestDeps(leaseId, spyConnector, { license: held });
    const result = await callReadTool(deps);

    expect(result.isError).not.toBe(true);
    expect(capturedCalls).toHaveLength(1);

    const call = capturedCalls[0];
    if (call === undefined) {
      throw new Error("expected exactly one captured OutboundConnector.execute call");
    }
    const [, , credential] = call;

    // The OAuth access-token shape only -- no additional field could carry
    // the license alongside it.
    expect(credential).toEqual({ accessToken: ACCESS_TOKEN });
    expect(Object.keys(credential)).toEqual(["accessToken"]);

    // Decisive substring check across every argument the port ever saw.
    expect(JSON.stringify(capturedCalls)).not.toContain(licenseToken);
  });

  it("the reference REST connector's outbound request carries the access token only -- never the license", async () => {
    const leaseId = "lease-license-secretless-rest";
    const { held, token: licenseToken } = await mintTestLicense(leaseId);

    let capturedInit: RequestInit | undefined;
    const fetchImpl: FetchLike = (_input, init) => {
      capturedInit = init;
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    };
    const restConnector = createRestOutboundConnector(fetchImpl);

    const { deps } = await buildLicenseTestDeps(leaseId, restConnector, { license: held });
    const result = await callReadTool(deps);

    expect(result.isError).not.toBe(true);

    const sentBody = typeof capturedInit?.body === "string" ? capturedInit.body : "";
    const sentHeaders = new Headers(capturedInit?.headers);

    expect(sentHeaders.get("authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(sentBody).not.toContain(licenseToken);
    expect([...sentHeaders.values()].join(" ")).not.toContain(licenseToken);
  });
});
