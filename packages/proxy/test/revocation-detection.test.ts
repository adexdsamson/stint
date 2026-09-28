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

import { describe, expect, it } from "vitest";

import { createBindingSet } from "@stint/core";
import type { ConnectorBinding, Lease } from "@stint/core";
import { createInMemoryLeaseStore, createInMemoryReceiptStore } from "@stint/core/testing";

import { createToolCatalog } from "../src/catalog.js";
import { DEFAULT_APPROVAL_STAGE, DEFAULT_CAP_ENFORCER, handleCall } from "../src/dispatch.js";
import type { ExecuteStage } from "../src/dispatch.js";
import type { ProxyDeps } from "../src/server.js";
import { CredentialRefreshError } from "../src/vault/credential-vault.js";
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
