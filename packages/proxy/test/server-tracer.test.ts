/**
 * Task 1 tracer: proves the whole Phase 4 enforcement path end-to-end for
 * ONE thin vertical slice -- a real MCP `Client` connects over
 * `InMemoryTransport`, `tools/list` shows only the one permitted `read`
 * tool, and a `tools/call` on it flows through `resolveBinding` ->
 * `evaluatePolicy` (allow) -> the injected `ExecuteStage` -> and leaves
 * exactly one verified-chain `allowed` receipt (PRXY-01, RCPT-01).
 */

import { describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { createBindingSet } from "@stint/core";
import type { ConnectorBinding, Lease } from "@stint/core";
import { createInMemoryLeaseStore, createInMemoryReceiptStore } from "@stint/core/testing";

import { createToolCatalog } from "../src/catalog.js";
import { DEFAULT_APPROVAL_STAGE, DEFAULT_CAP_ENFORCER } from "../src/dispatch.js";
import { createLeaseProxyServer } from "../src/server.js";
import type { ProxyDeps } from "../src/server.js";
import { createEchoExecuteStage } from "../src/testing.js";

const NOW = 1_700_000_000;

export function makeLease(id: string, overrides?: Partial<Lease>): Lease {
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

export const READ_BINDING: ConnectorBinding = {
  tool: "read_message",
  resource: "inbox",
  access: "read",
  irreversible: false,
  provenance: "built_in",
};

export async function buildDeps(
  leaseId: string,
  echoBody: unknown = { ok: true },
  extraCatalogEntries: readonly Parameters<typeof createToolCatalog>[0][number][] = [],
  extraBindings: readonly ConnectorBinding[] = [],
  scopeOverrides?: { readonly grantedScopes?: readonly ConnectorBinding["access"][]; readonly grantedResources?: readonly string[] },
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
      name: READ_BINDING.tool,
      description: "Reads a message",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
    ...extraCatalogEntries,
  ]);
  const bindings = createBindingSet([READ_BINDING, ...extraBindings]);

  const deps: ProxyDeps = {
    leaseId,
    leaseStore,
    receiptStore,
    catalog,
    bindings,
    grantedScopes: scopeOverrides?.grantedScopes ?? ["read"],
    grantedResources: scopeOverrides?.grantedResources ?? ["inbox"],
    limits: { max_actions: 100 },
    approvals: { require_for: [], timeout_seconds: 30 },
    clock: () => NOW,
    execute: createEchoExecuteStage(echoBody),
    approve: DEFAULT_APPROVAL_STAGE,
    enforceCaps: DEFAULT_CAP_ENFORCER,
  };

  return { deps, leaseStore, receiptStore };
}

export async function connectedClient(deps: ProxyDeps): Promise<Client> {
  const server = createLeaseProxyServer(deps);
  const client = new Client({ name: "test-agent", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe("server tracer: permitted read tool end-to-end", () => {
  it("tools/list shows exactly the one permitted tool", async () => {
    const { deps } = await buildDeps("lease-tracer-1");
    const client = await connectedClient(deps);

    const { tools } = await client.listTools();

    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe(READ_BINDING.tool);
  });

  it("tools/call on the permitted tool returns the echo body and appends exactly one allowed receipt", async () => {
    const { deps, receiptStore } = await buildDeps("lease-tracer-2", { hello: "world" });
    const client = await connectedClient(deps);

    const result = (await client.callTool({ name: READ_BINDING.tool, arguments: {} })) as CallToolResult;

    expect(result.isError).not.toBe(true);

    const [first] = result.content;
    if (first === undefined || first.type !== "text") {
      throw new Error("expected a text content block");
    }
    expect(JSON.parse(first.text)).toEqual({ hello: "world" });

    const chain = await receiptStore.load("verified");
    expect(chain).toHaveLength(1);

    const [entry] = chain;
    if (entry === undefined || entry.type !== "call") {
      throw new Error("expected a call receipt entry");
    }
    expect(entry.payload.outcome).toBe("allowed");
    expect(entry.payload.resource).toBe(READ_BINDING.resource);
  });
});
