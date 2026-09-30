/**
 * Task 3: RCPT-01 receipt guarantees over the tracer server -- exactly one
 * verified-chain receipt per `tools/call` (allowed or denied), identical
 * args never merged into one receipt, a denied call with no `arguments`
 * still receipts against the normalized empty-object `argsHash`, N
 * concurrent calls against one lease leave a gap-free `verifyChain`-valid
 * chain (D-13), and no receipt payload/summary ever carries a raw arg or
 * secret-looking value (T-04-02-ID).
 */

import { describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { createBindingSet, verifyChain } from "@stint/core";
import type { ConnectorBinding, Lease } from "@stint/core";
import { createInMemoryLeaseStore, createInMemoryReceiptStore } from "@stint/core/testing";
import { hashCanonical } from "@stint/spec";

import { createToolCatalog } from "../src/catalog.js";
import { DEFAULT_APPROVAL_STAGE, DEFAULT_CAP_ENFORCER } from "../src/dispatch.js";
import { createLeaseProxyServer } from "../src/server.js";
import type { ProxyDeps } from "../src/server.js";
import { createEchoExecuteStage } from "../src/testing.js";

const NOW = 1_700_000_000;

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

async function buildDeps(
  leaseId: string,
  echoBody: unknown = { ok: true },
): Promise<{
  deps: ProxyDeps;
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
  ]);
  const bindings = createBindingSet([READ_BINDING]);

  const deps: ProxyDeps = {
    leaseId,
    leaseStore,
    receiptStore,
    catalog,
    bindings,
    grantedScopes: ["read"],
    grantedResources: ["inbox"],
    limits: { max_actions: 1000 },
    approvals: { require_for: [], timeout_seconds: 30 },
    clock: () => NOW,
    execute: createEchoExecuteStage(echoBody),
    approve: DEFAULT_APPROVAL_STAGE,
    enforceCaps: DEFAULT_CAP_ENFORCER,
  };

  return { deps, receiptStore };
}

async function connectedClient(deps: ProxyDeps): Promise<Client> {
  const server = createLeaseProxyServer(deps);
  const client = new Client({ name: "test-agent", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function asCallToolResult(value: unknown): CallToolResult {
  return value as CallToolResult;
}

describe("RCPT-01: exactly one receipt per call", () => {
  it("an allowed call appends exactly one receipt (chain length delta == 1)", async () => {
    const { deps, receiptStore } = await buildDeps("lease-rcpt-allowed");
    const client = await connectedClient(deps);

    const before = await receiptStore.load("verified");
    await client.callTool({ name: READ_BINDING.tool, arguments: {} });
    const after = await receiptStore.load("verified");

    expect(after.length - before.length).toBe(1);
  });

  it("a denied call appends exactly one receipt (chain length delta == 1)", async () => {
    const { deps, receiptStore } = await buildDeps("lease-rcpt-denied");
    const client = await connectedClient(deps);

    const before = await receiptStore.load("verified");
    await client.callTool({ name: "not_a_real_tool", arguments: {} });
    const after = await receiptStore.load("verified");

    expect(after.length - before.length).toBe(1);
  });
});

describe("RCPT-01: identical-arg calls are never merged", () => {
  it("two calls with identical args produce two receipts, equal argsHash, distinct seq", async () => {
    const { deps, receiptStore } = await buildDeps("lease-rcpt-identical");
    const client = await connectedClient(deps);

    await client.callTool({ name: READ_BINDING.tool, arguments: { same: "value" } });
    await client.callTool({ name: READ_BINDING.tool, arguments: { same: "value" } });

    const chain = await receiptStore.load("verified");
    expect(chain).toHaveLength(2);

    const [first, second] = chain;
    if (first === undefined || first.type !== "call" || second === undefined || second.type !== "call") {
      throw new Error("expected two call receipt entries");
    }
    expect(first.payload.argsHash).toBe(second.payload.argsHash);
    expect(first.seq).not.toBe(second.seq);
    expect(first.seq).toBe(0);
    expect(second.seq).toBe(1);
  });
});

describe("RCPT-01: absent arguments still receipt against the normalized empty object", () => {
  it("a denied call with no `arguments` field appends one receipt whose argsHash equals hashCanonical({})", async () => {
    const { deps, receiptStore } = await buildDeps("lease-rcpt-empty-args");
    const client = await connectedClient(deps);

    // No `arguments` field at all -- not even `{}`.
    await client.callTool({ name: "not_a_real_tool" });

    const chain = await receiptStore.load("verified");
    expect(chain).toHaveLength(1);
    const [entry] = chain;
    if (entry === undefined || entry.type !== "call") {
      throw new Error("expected a call receipt entry");
    }
    expect(entry.payload.outcome).toBe("denied");
    expect(entry.payload.argsHash).toBe(hashCanonical({}));
  });
});

describe("RCPT-01: concurrent calls against one lease leave a gap-free, verifyChain-valid chain", () => {
  it("N concurrent tools/calls produce seq 0..N-1 with no gaps, and verifyChain reports ok", async () => {
    const CALL_COUNT = 20;
    const { deps, receiptStore } = await buildDeps("lease-rcpt-concurrent");
    const client = await connectedClient(deps);

    await Promise.all(
      Array.from({ length: CALL_COUNT }, () => client.callTool({ name: READ_BINDING.tool, arguments: {} })),
    );

    const chain = await receiptStore.load("verified");
    expect(chain).toHaveLength(CALL_COUNT);

    const seqs = chain.map((entry) => entry.seq).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: CALL_COUNT }, (_, i) => i));

    const result = await verifyChain(chain);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.count).toBe(CALL_COUNT);
    }
  });
});

describe("RCPT-01: no secret ever reaches a receipt", () => {
  const SECRET = "sk-live-super_secret_token_value_12345";

  it("an allowed call carrying a secret-looking arg leaks it into neither the payload nor redactedSummary", async () => {
    const { deps, receiptStore } = await buildDeps("lease-rcpt-secret-allowed");
    const client = await connectedClient(deps);

    const result = asCallToolResult(
      await client.callTool({ name: READ_BINDING.tool, arguments: { apiKey: SECRET } }),
    );
    expect(result.isError).not.toBe(true);

    const chain = await receiptStore.load("verified");
    const [entry] = chain;
    if (entry === undefined || entry.type !== "call") {
      throw new Error("expected a call receipt entry");
    }

    // By TYPE: CallPayload has exactly these four keys.
    expect(Object.keys(entry.payload).sort()).toEqual(["argsHash", "outcome", "redactedSummary", "resource"]);

    // By VALUE: the secret substring appears nowhere in the persisted entry.
    expect(JSON.stringify(entry)).not.toContain(SECRET);
    expect(entry.payload.redactedSummary).not.toContain(SECRET);
  });

  it("a denied call carrying a secret-looking arg leaks it into neither the payload nor redactedSummary", async () => {
    const { deps, receiptStore } = await buildDeps("lease-rcpt-secret-denied");
    const client = await connectedClient(deps);

    await client.callTool({ name: "not_a_real_tool", arguments: { apiKey: SECRET } });

    const chain = await receiptStore.load("verified");
    const [entry] = chain;
    if (entry === undefined || entry.type !== "call") {
      throw new Error("expected a call receipt entry");
    }

    expect(Object.keys(entry.payload).sort()).toEqual(["argsHash", "outcome", "redactedSummary", "resource"]);
    expect(JSON.stringify(entry)).not.toContain(SECRET);
    expect(entry.payload.redactedSummary).not.toContain(SECRET);
  });
});
