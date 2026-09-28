/**
 * PRXY-07 lazy customer-side OAuth revocation detection (D-09). Task 1:
 * unit coverage for `applyProviderRevocation`/`isProviderRevocation`
 * (`revocation.ts`) and the dispatch-level provider_revoked-vs-transient
 * discrimination wired into `handleCall` (`dispatch.ts`) -- driven directly
 * (not over the full MCP `Client`) since these are dispatch-branch wiring
 * proofs, not protocol proofs. Task 2 extends this file with the forced-
 * `invalid_grant` end-to-end proof over a real mock authorization server and
 * a real MCP `Client`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { createBindingSet } from "@stint/core";
import type { ConnectorBinding, Lease } from "@stint/core";
import { createInMemoryLeaseStore, createInMemoryReceiptStore } from "@stint/core/testing";

import { createToolCatalog } from "../src/catalog.js";
import { DEFAULT_APPROVAL_STAGE, DEFAULT_CAP_ENFORCER, handleCall } from "../src/dispatch.js";
import type { ExecuteStage } from "../src/dispatch.js";
import { createLeaseProxyServer } from "../src/server.js";
import type { ProxyDeps } from "../src/server.js";
import { createEchoingCredentialConnector, startMockAuthServer } from "../src/testing.js";
import type { MockAuthHarness } from "../src/testing.js";
import { createCredentialVault, CredentialRefreshError } from "../src/vault/credential-vault.js";
import { createVaultExecuteStage } from "../src/vault/execute-stage.js";
import { applyProviderRevocation, isProviderRevocation } from "../src/revocation.js";

const NOW = 1_700_000_000;

function makeLease(id: string, overrides?: Partial<Lease>): Lease {
  return {
    id,
    state: "active",
    version: 0,
    boundHash: "jcs-sha256:test",
    grantedAt: NOW - 100,
    expiresAt: NOW + 3600,
    maxDurationSeconds: 3600,
    counters: { actionCount: 0, spentMinor: 0, denialErrorTimestamps: [], actionTimestamps: [] },
    ...overrides,
  };
}

// --- Task 1: applyProviderRevocation / isProviderRevocation (unit) -------

describe("applyProviderRevocation", () => {
  it("moves an active lease to revoked with actor provider, event grant_revoked", () => {
    const lease = makeLease("lease-apply-active", { state: "active" });

    const result = applyProviderRevocation(lease, NOW);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lease.state).toBe("revoked");
    expect(result.value.transition.actor).toBe("provider");
    expect(result.value.transition.event).toBe("grant_revoked");
    expect(result.value.transition.from).toBe("active");
    expect(result.value.transition.to).toBe("revoked");
  });

  it("moves a granted lease to revoked with actor provider (the other legal source state)", () => {
    const lease = makeLease("lease-apply-granted", { state: "granted" });

    const result = applyProviderRevocation(lease, NOW);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lease.state).toBe("revoked");
    expect(result.value.transition.actor).toBe("provider");
  });

  it("returns reduce's illegal_transition rejection (not a throw) for a non-active/non-granted source state", () => {
    const lease = makeLease("lease-apply-illegal", { state: "revoked" });

    const result = applyProviderRevocation(lease, NOW);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe("illegal_transition");
  });
});

describe("isProviderRevocation", () => {
  it("returns true for the provider_revoked signal", () => {
    expect(isProviderRevocation("provider_revoked")).toBe(true);
  });

  it("returns false for the transient_error signal", () => {
    expect(isProviderRevocation("transient_error")).toBe(false);
  });
});

// --- Task 1: dispatch-level provider_revoked vs transient discrimination -

const REVOCABLE_BINDING: ConnectorBinding = {
  tool: "read_message",
  resource: "inbox",
  access: "read",
  irreversible: false,
  provenance: "built_in",
};

function makeThrowingExecuteStage(err: Error): ExecuteStage {
  return {
    execute() {
      return Promise.reject(err);
    },
  };
}

async function buildRevocationDeps(
  leaseId: string,
  execute: ExecuteStage,
): Promise<{
  deps: ProxyDeps;
  leaseStore: ReturnType<typeof createInMemoryLeaseStore>;
  receiptStore: ReturnType<typeof createInMemoryReceiptStore>;
}> {
  const leaseStore = createInMemoryLeaseStore();
  const receiptStore = createInMemoryReceiptStore();
  await leaseStore.save(makeLease(leaseId));

  const catalog = createToolCatalog([
    {
      name: REVOCABLE_BINDING.tool,
      description: "Reads a message",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
  ]);
  const bindings = createBindingSet([REVOCABLE_BINDING]);

  const deps: ProxyDeps = {
    leaseId,
    leaseStore,
    receiptStore,
    catalog,
    bindings,
    grantedScopes: ["read"],
    grantedResources: [REVOCABLE_BINDING.resource],
    limits: { max_actions: 100 },
    approvals: { require_for: [], timeout_seconds: 30 },
    clock: () => NOW,
    execute,
    approve: DEFAULT_APPROVAL_STAGE,
    enforceCaps: DEFAULT_CAP_ENFORCER,
  };

  return { deps, leaseStore, receiptStore };
}

describe("dispatch: applyProviderRevocation wiring (PRXY-07)", () => {
  it("a provider_revoked CredentialRefreshError applies applyProviderRevocation, saves the revoked lease (actor provider), and denies the call with exactly one receipt", async () => {
    const leaseId = "lease-revoke-1";
    const { deps, leaseStore, receiptStore } = await buildRevocationDeps(
      leaseId,
      makeThrowingExecuteStage(new CredentialRefreshError(`${leaseId}:inbox`, "provider_revoked")),
    );

    const result = await handleCall(deps, { name: REVOCABLE_BINDING.tool, arguments: {} }, NOW);

    expect(result.isError).toBe(true);
    const [content] = result.content;
    if (content === undefined || content.type !== "text") {
      throw new Error("expected a text content block");
    }
    expect(content.text).toBe("denied: provider_revoked");

    const lease = await leaseStore.load(leaseId);
    expect(lease?.state).toBe("revoked");

    const chain = await receiptStore.load("verified");
    expect(chain).toHaveLength(1);
    const [entry] = chain;
    if (entry === undefined || entry.type !== "call") {
      throw new Error("expected a call receipt entry");
    }
    expect(entry.payload.outcome).toBe("denied");
  });

  it("a transient_error CredentialRefreshError denies the call but leaves the lease active (never calls providerEvents.grantRevoked)", async () => {
    const leaseId = "lease-transient-1";
    const { deps, leaseStore } = await buildRevocationDeps(
      leaseId,
      makeThrowingExecuteStage(new CredentialRefreshError(`${leaseId}:inbox`, "transient_error")),
    );

    const result = await handleCall(deps, { name: REVOCABLE_BINDING.tool, arguments: {} }, NOW);

    expect(result.isError).toBe(true);
    const [content] = result.content;
    if (content === undefined || content.type !== "text") {
      throw new Error("expected a text content block");
    }
    expect(content.text).toBe("denied: transient_error");

    const lease = await leaseStore.load(leaseId);
    expect(lease?.state).toBe("active");
  });
});

// --- Task 2: forced-invalid_grant end-to-end revocation (real mock AS + --
// real MCP Client, PRXY-07) -----------------------------------------------
//
// Drives the FULL stack -- a real `oauth4webapi` refresh against a real
// loopback `oauth2-mock-server`, through the vault-backed `ExecuteStage`,
// through a real MCP `Client` `tools/call` -- rather than a synthetic
// `CredentialRefreshError` (Task 1 above). `forceNextTokenError` is the
// mock's ONLY way to produce `oauth.ResponseBodyError`; its `/revoke`
// endpoint always returns 200 with no reuse-detection (04-RESEARCH.md
// Pitfall 2/5), so no assertion here depends on it -- the revocation
// signal is exclusively the forced `invalid_grant` on the REFRESH request.

const E2E_BINDING: ConnectorBinding = {
  tool: "read_message",
  resource: "inbox",
  access: "read",
  irreversible: false,
  provenance: "built_in",
};

describe("PRXY-07 end-to-end: real mock AS + MCP Client (forced invalid_grant revokes; forced transient does not)", () => {
  let harness: MockAuthHarness;

  beforeEach(async () => {
    harness = await startMockAuthServer();
  });

  afterEach(async () => {
    await harness.stop();
  });

  async function buildE2EDeps(leaseId: string): Promise<{
    deps: ProxyDeps;
    leaseStore: ReturnType<typeof createInMemoryLeaseStore>;
  }> {
    const leaseStore = createInMemoryLeaseStore();
    const receiptStore = createInMemoryReceiptStore();
    await leaseStore.save(makeLease(leaseId));

    const catalog = createToolCatalog([
      {
        name: E2E_BINDING.tool,
        description: "Reads a message",
        inputSchema: { type: "object", properties: {}, required: [] },
      },
    ]);
    const bindings = createBindingSet([E2E_BINDING]);

    const vault = createCredentialVault(harness.oauthClient, () => NOW, { allowInsecureRequests: true });
    // Already-expired -- forces the triggering call's resolveAccessToken to
    // refresh (never a stale "success").
    vault.seedCredential(leaseId, E2E_BINDING.resource, {
      accessToken: "expired-access-token",
      refreshToken: "seed-refresh-token",
      expiry: NOW - 10,
      tokenEndpoint: "unused-see-harness.oauthClient.as.token_endpoint",
      resourceIndicator: E2E_BINDING.resource,
    });

    const deps: ProxyDeps = {
      leaseId,
      leaseStore,
      receiptStore,
      catalog,
      bindings,
      grantedScopes: ["read"],
      grantedResources: [E2E_BINDING.resource],
      limits: { max_actions: 100 },
      approvals: { require_for: [], timeout_seconds: 30 },
      clock: () => NOW,
      // The adversarial echoing connector is never actually invoked on
      // either path below (both calls are denied before connector.execute
      // would run) -- reused here only as a type-satisfying OutboundConnector.
      execute: createVaultExecuteStage(vault, createEchoingCredentialConnector()),
      approve: DEFAULT_APPROVAL_STAGE,
      enforceCaps: DEFAULT_CAP_ENFORCER,
    };

    return { deps, leaseStore };
  }

  async function connectE2EClient(deps: ProxyDeps): Promise<Client> {
    const server = createLeaseProxyServer(deps);
    const client = new Client({ name: "revocation-e2e-agent", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
  }

  it("a forced invalid_grant on refresh revokes the lease (actor provider) and denies the triggering call; a subsequent call on the revoked lease is also denied", async () => {
    const leaseId = "lease-e2e-revoke";
    const { deps, leaseStore } = await buildE2EDeps(leaseId);
    // The mock's ONLY way to produce oauth.ResponseBodyError -- never its
    // /revoke endpoint's 200 no-op (Pitfall 2/5).
    harness.forceNextTokenError("invalid_grant");

    const client = await connectE2EClient(deps);

    const result = (await client.callTool({ name: E2E_BINDING.tool, arguments: {} })) as CallToolResult;

    expect(result.isError).toBe(true);
    const [content] = result.content;
    if (content === undefined || content.type !== "text") {
      throw new Error("expected a text content block");
    }
    expect(content.text).toBe("denied: provider_revoked");

    // The lease is now `revoked` -- reachable here ONLY via
    // dispatch.ts's provider_revoked branch (revocation.ts's
    // applyProviderRevocation, actor `provider`, event `grant_revoked`,
    // unit-proven in Task 1 above); no `user`-actor `revoke` call is made
    // anywhere in this test.
    const revokedLease = await leaseStore.load(leaseId);
    expect(revokedLease?.state).toBe("revoked");

    // A subsequent tools/call on the now-revoked lease: denied by
    // evaluatePolicy's lease_not_active check (LIFE-02, deny by default) --
    // the agent cannot act on a revoked lease.
    const second = (await client.callTool({ name: E2E_BINDING.tool, arguments: {} })) as CallToolResult;
    expect(second.isError).toBe(true);
    const [secondContent] = second.content;
    if (secondContent === undefined || secondContent.type !== "text") {
      throw new Error("expected a text content block");
    }
    expect(secondContent.text).toBe("denied: lease_not_active");
  });

  it("a forced non-invalid_grant (transient) refresh failure denies the call but leaves the lease active -- never revoked", async () => {
    const leaseId = "lease-e2e-transient";
    const { deps, leaseStore } = await buildE2EDeps(leaseId);
    harness.forceNextTokenError("server_error");

    const client = await connectE2EClient(deps);

    const result = (await client.callTool({ name: E2E_BINDING.tool, arguments: {} })) as CallToolResult;

    expect(result.isError).toBe(true);
    const [content] = result.content;
    if (content === undefined || content.type !== "text") {
      throw new Error("expected a text content block");
    }
    expect(content.text).toBe("denied: transient_error");

    const lease = await leaseStore.load(leaseId);
    expect(lease?.state).toBe("active");
  });
});
