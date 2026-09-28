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

// PRXY-01 completeness (Task 2): a tool whose binding exists but is
// out-of-scope-access, and one that is out-of-scope-resource, are BOTH
// absent from tools/list AND still denied `no_binding` if the agent names
// them directly -- `resolveEffectiveBinding` (dispatch.ts) is the ONE place
// this "unbound-or-out-of-scope" collapse happens for both surfaces
// (T-04-02-TP, T-04-02-DN).
const OUT_OF_SCOPE_ACCESS_BINDING: ConnectorBinding = {
  tool: "send_message",
  resource: "inbox",
  access: "send",
  irreversible: false,
  provenance: "built_in",
};

const OUT_OF_SCOPE_RESOURCE_BINDING: ConnectorBinding = {
  tool: "read_vault",
  resource: "vault",
  access: "read",
  irreversible: false,
  provenance: "built_in",
};

const UNBOUND_TOOL_NAME = "delete_everything";

describe("PRXY-01 completeness: filtering + direct-name denial", () => {
  it("tools/list excludes an out-of-scope-access tool and an out-of-scope-resource tool", async () => {
    const { deps } = await buildDeps(
      "lease-prxy01-list",
      undefined,
      [
        {
          name: OUT_OF_SCOPE_ACCESS_BINDING.tool,
          description: "Sends a message",
          inputSchema: { type: "object", properties: {}, required: [] },
        },
        {
          name: OUT_OF_SCOPE_RESOURCE_BINDING.tool,
          description: "Reads the vault",
          inputSchema: { type: "object", properties: {}, required: [] },
        },
      ],
      [OUT_OF_SCOPE_ACCESS_BINDING, OUT_OF_SCOPE_RESOURCE_BINDING],
    );
    const client = await connectedClient(deps);

    const { tools } = await client.listTools();

    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe(READ_BINDING.tool);
    expect(tools.map((tool) => tool.name)).not.toContain(OUT_OF_SCOPE_ACCESS_BINDING.tool);
    expect(tools.map((tool) => tool.name)).not.toContain(OUT_OF_SCOPE_RESOURCE_BINDING.tool);
  });

  it("a tools/call naming a completely unbound tool is denied no_binding and appends one denied receipt", async () => {
    const { deps, receiptStore } = await buildDeps("lease-prxy01-unbound");
    const client = await connectedClient(deps);

    const result = (await client.callTool({ name: UNBOUND_TOOL_NAME, arguments: {} })) as CallToolResult;

    expect(result.isError).toBe(true);
    const [first] = result.content;
    if (first === undefined || first.type !== "text") {
      throw new Error("expected a text content block");
    }
    expect(first.text).toBe("denied: no_binding");

    const chain = await receiptStore.load("verified");
    expect(chain).toHaveLength(1);
    const [entry] = chain;
    if (entry === undefined || entry.type !== "call") {
      throw new Error("expected a call receipt entry");
    }
    expect(entry.payload.outcome).toBe("denied");
  });

  it("a tools/call naming an out-of-scope-but-cataloged tool directly is still denied no_binding, even though it is hidden from tools/list", async () => {
    const { deps, receiptStore } = await buildDeps(
      "lease-prxy01-hidden-call",
      undefined,
      [
        {
          name: OUT_OF_SCOPE_ACCESS_BINDING.tool,
          description: "Sends a message",
          inputSchema: { type: "object", properties: {}, required: [] },
        },
      ],
      [OUT_OF_SCOPE_ACCESS_BINDING],
    );
    const client = await connectedClient(deps);

    // Confirm it is indeed hidden first.
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).not.toContain(OUT_OF_SCOPE_ACCESS_BINDING.tool);

    const result = (await client.callTool({
      name: OUT_OF_SCOPE_ACCESS_BINDING.tool,
      arguments: {},
    })) as CallToolResult;

    expect(result.isError).toBe(true);
    const [first] = result.content;
    if (first === undefined || first.type !== "text") {
      throw new Error("expected a text content block");
    }
    expect(first.text).toBe("denied: no_binding");

    const chain = await receiptStore.load("verified");
    expect(chain).toHaveLength(1);
    const [entry] = chain;
    if (entry === undefined || entry.type !== "call") {
      throw new Error("expected a call receipt entry");
    }
    expect(entry.payload.outcome).toBe("denied");
  });
});
