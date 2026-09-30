/**
 * PRXY-06 secretless-boundary proofs. Task 1: unit coverage for
 * `scrubCredential`/`scrubError` (D-02's narrow, exact-value-only scrubber)
 * and `createRestOutboundConnector`'s bearer-attachment (D-01) -- the
 * trusted-boundary code where the token legitimately appears. Task 3: the
 * end-to-end adversarial proofs below -- a real MCP `Client` driven (over
 * `InMemoryTransport`) against the vault-backed `ExecuteStage` wired to an
 * echoing/throwing adversarial `OutboundConnector`, asserting the seeded
 * access-token value appears in neither the `CallToolResult`, any surfaced
 * error, nor the receipt chain.
 */

import { describe, expect, it } from "vitest";
import * as oauth from "oauth4webapi";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { createBindingSet } from "@stint/core";
import type { ConnectorBinding, Lease } from "@stint/core";
import { createInMemoryLeaseStore, createInMemoryReceiptStore } from "@stint/core/testing";

import { createToolCatalog } from "../src/catalog.js";
import { createRestOutboundConnector } from "../src/connectors/outbound-connector.js";
import type { FetchLike } from "../src/connectors/outbound-connector.js";
import { DEFAULT_APPROVAL_STAGE, DEFAULT_CAP_ENFORCER } from "../src/dispatch.js";
import { createLeaseProxyServer } from "../src/server.js";
import type { ProxyDeps } from "../src/server.js";
import { createEchoingCredentialConnector, createThrowingCredentialConnector } from "../src/testing.js";
import { createCredentialVault } from "../src/vault/credential-vault.js";
import { createVaultExecuteStage } from "../src/vault/execute-stage.js";
import type { OAuthClient } from "../src/vault/oauth-client.js";
import { scrubCredential, scrubError } from "../src/vault/scrub.js";

const SECRET_TOKEN = "distinctive-secret-token-xyz789";

describe("scrubCredential", () => {
  it("strips the exact known secret from a plain string value", () => {
    const scrubbed = scrubCredential(`token=${SECRET_TOKEN}`, [SECRET_TOKEN]);
    expect(scrubbed).not.toContain(SECRET_TOKEN);
  });

  it("strips the secret from nested object/array values without touching unrelated content", () => {
    const value = {
      a: { b: [`prefix-${SECRET_TOKEN}-suffix`, "unrelated"] },
      c: 42,
      d: null,
      e: undefined,
    };

    const scrubbed = scrubCredential(value, [SECRET_TOKEN]);

    expect(JSON.stringify(scrubbed)).not.toContain(SECRET_TOKEN);
    expect(scrubbed.c).toBe(42);
    expect(scrubbed.d).toBeNull();
    expect(scrubbed.a.b[1]).toBe("unrelated");
  });

  it("leaves a value with no matching secret entirely untouched", () => {
    const value = { hello: "world", n: 1 };
    expect(scrubCredential(value, [SECRET_TOKEN])).toEqual(value);
  });

  it("strips only the exact known secret(s), never a generic secret-shaped pattern", () => {
    const value = "sk-live-lookalikeSecretButNotTheKnownOne";
    // A value that merely *looks* secret-shaped, but isn't in knownSecrets,
    // must survive untouched -- this scrubber is exact-match only (D-02).
    expect(scrubCredential(value, [SECRET_TOKEN])).toBe(value);
  });
});

describe("scrubError", () => {
  it("strips the secret from a thrown error's message", () => {
    const err = new Error(`request failed, token was ${SECRET_TOKEN}`);

    const scrubbed = scrubError(err, [SECRET_TOKEN]);

    expect(scrubbed).toBeInstanceOf(Error);
    expect(scrubbed.message).not.toContain(SECRET_TOKEN);
  });

  it("strips the secret from an echoed field the original error carries (e.g. a body/cause)", () => {
    const err = new Error("connector failure") as Error & { body?: unknown };
    err.body = { leaked: SECRET_TOKEN };

    const scrubbed = scrubError(err, [SECRET_TOKEN]) as Error & { body?: unknown };

    expect(JSON.stringify(scrubbed.body)).not.toContain(SECRET_TOKEN);
  });

  it("never mutates or returns the original error object", () => {
    const err = new Error(`leak: ${SECRET_TOKEN}`);

    const scrubbed = scrubError(err, [SECRET_TOKEN]);

    expect(scrubbed).not.toBe(err);
    expect(err.message).toContain(SECRET_TOKEN);
  });
});

describe("createRestOutboundConnector", () => {
  it("attaches the credential as a bearer Authorization header on the outbound request", async () => {
    let capturedInit: RequestInit | undefined;
    const fetchImpl: FetchLike = (_input, init) => {
      capturedInit = init;
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    };

    const connector = createRestOutboundConnector(fetchImpl);
    const binding = {
      tool: "t",
      resource: "https://api.example.test/x",
      access: "read" as const,
      irreversible: false,
      provenance: "built_in" as const,
    };

    const result = await connector.execute(binding, {}, { accessToken: SECRET_TOKEN });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true });
    const headers = new Headers(capturedInit?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${SECRET_TOKEN}`);
  });
});

// --- Task 3: end-to-end adversarial proofs (PRXY-06) ---------------------
//
// A real MCP `Client` drives `tools/call` through the vault-backed
// `ExecuteStage` (`createVaultExecuteStage`) wired to an adversarial
// `OutboundConnector` that tries to leak the seeded access-token value.
// The vault is seeded with an unexpired credential so `resolveAccessToken`
// never needs to refresh (no mock AS required for this proof) -- the
// `OAuthClient` bundle below is a type-satisfying stub whose fields are
// never read.

const NOW = 1_700_000_000;

const STUB_OAUTH_CLIENT: OAuthClient = {
  as: { issuer: "https://issuer.example.test" },
  client: { client_id: "unused-test-client" },
  clientAuth: oauth.None(),
};

const ADVERSARIAL_READ_BINDING: ConnectorBinding = {
  tool: "read_message",
  resource: "inbox",
  access: "read",
  irreversible: false,
  provenance: "built_in",
};

function makeAdversarialLease(id: string): Lease {
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

async function buildAdversarialDeps(
  leaseId: string,
  connector: Parameters<typeof createVaultExecuteStage>[1],
): Promise<{
  deps: ProxyDeps;
  receiptStore: ReturnType<typeof createInMemoryReceiptStore>;
}> {
  const leaseStore = createInMemoryLeaseStore();
  const receiptStore = createInMemoryReceiptStore();
  await leaseStore.save(makeAdversarialLease(leaseId));

  const catalog = createToolCatalog([
    {
      name: ADVERSARIAL_READ_BINDING.tool,
      description: "Reads a message",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
  ]);
  const bindings = createBindingSet([ADVERSARIAL_READ_BINDING]);

  const vault = createCredentialVault(STUB_OAUTH_CLIENT, () => NOW);
  vault.seedCredential(leaseId, ADVERSARIAL_READ_BINDING.resource, {
    accessToken: SECRET_TOKEN,
    refreshToken: "unused-refresh-token",
    // Far in the future -- this proof never exercises a refresh.
    expiry: NOW + 3600,
    tokenEndpoint: "https://issuer.example.test/token",
    resourceIndicator: ADVERSARIAL_READ_BINDING.resource,
  });

  const deps: ProxyDeps = {
    leaseId,
    leaseStore,
    receiptStore,
    catalog,
    bindings,
    grantedScopes: ["read"],
    grantedResources: [ADVERSARIAL_READ_BINDING.resource],
    limits: { max_actions: 100 },
    approvals: { require_for: [], timeout_seconds: 30 },
    clock: () => NOW,
    execute: createVaultExecuteStage(vault, connector),
    approve: DEFAULT_APPROVAL_STAGE,
    enforceCaps: DEFAULT_CAP_ENFORCER,
  };

  return { deps, receiptStore };
}

async function connectAdversarialClient(deps: ProxyDeps): Promise<Client> {
  const server = createLeaseProxyServer(deps);
  const client = new Client({ name: "adversarial-agent", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe("PRXY-06 adversarial: the seeded access token never crosses the agent boundary", () => {
  it("an echoing connector's leaked token is scrubbed from the CallToolResult and the receipt chain", async () => {
    const { deps, receiptStore } = await buildAdversarialDeps(
      "lease-secretless-echo",
      createEchoingCredentialConnector(),
    );
    const client = await connectAdversarialClient(deps);

    const result = (await client.callTool({ name: ADVERSARIAL_READ_BINDING.tool, arguments: {} })) as CallToolResult;

    expect(result.isError).not.toBe(true);
    const [content] = result.content;
    if (content === undefined || content.type !== "text") {
      throw new Error("expected a text content block");
    }
    expect(content.text).not.toContain(SECRET_TOKEN);

    const chain = await receiptStore.load("verified");
    expect(chain).toHaveLength(1);
    expect(JSON.stringify(chain)).not.toContain(SECRET_TOKEN);
  });

  it("a throwing connector's leaked token never reaches the client-surfaced error or the receipt chain", async () => {
    const { deps, receiptStore } = await buildAdversarialDeps(
      "lease-secretless-throw",
      createThrowingCredentialConnector(),
    );
    const client = await connectAdversarialClient(deps);

    const result = (await client.callTool({ name: ADVERSARIAL_READ_BINDING.tool, arguments: {} })) as CallToolResult;

    expect(result.isError).toBe(true);
    const [content] = result.content;
    if (content === undefined || content.type !== "text") {
      throw new Error("expected a text content block");
    }
    expect(content.text).not.toContain(SECRET_TOKEN);

    const chain = await receiptStore.load("verified");
    expect(chain).toHaveLength(1);
    expect(JSON.stringify(chain)).not.toContain(SECRET_TOKEN);
  });
});
