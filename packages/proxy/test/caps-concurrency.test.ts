/**
 * `caps-concurrency.test.ts` -- unit tests for the real `CapEnforcer`
 * (`createCapEnforcer`, PRXY-04, D-05, D-06) and `extractSpendMinor` (D-07)
 * (Task 1), plus the cap-boundary and concurrency integration proofs
 * driving the 04-02 server over `InMemoryTransport` (Task 3).
 */

import { describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { createBindingSet } from "@stint/core";
import type { ConnectorBinding, Lease, PolicyCall } from "@stint/core";
import { createInMemoryLeaseStore, createInMemoryReceiptStore } from "@stint/core/testing";
import type { Limits } from "@stint/spec";

import { createCapEnforcer } from "../src/caps/cap-enforcer.js";
import { createToolCatalog, extractSpendMinor } from "../src/catalog.js";
import type { ToolCatalogEntry } from "../src/catalog.js";
import { DEFAULT_APPROVAL_STAGE } from "../src/dispatch.js";
import type { ApprovalStage } from "../src/dispatch.js";
import { createLeaseProxyServer } from "../src/server.js";
import type { ProxyDeps } from "../src/server.js";
import { createEchoExecuteStage } from "../src/testing.js";

const NOW = 1_700_000_000;
const HOUR = 3600;

function makeLease(overrides?: Partial<Lease>): Lease {
  return {
    id: "lease-unit",
    state: "active",
    version: 0,
    boundHash: "jcs-sha256:test",
    grantedAt: NOW - 100,
    expiresAt: NOW + HOUR,
    maxDurationSeconds: HOUR,
    counters: { actionCount: 0, spentMinor: 0, denialErrorTimestamps: [], actionTimestamps: [] },
    ...overrides,
  };
}

const READ_CALL: PolicyCall = { tool: "read_message" };

describe("createCapEnforcer: authorize (sliding-window actions_per_hour)", () => {
  it("denies over_actions_per_hour once the strict-window count reaches the limit", () => {
    const enforcer = createCapEnforcer();
    const limits: Limits = { max_actions: 100, actions_per_hour: 3 };
    const lease = makeLease({
      counters: {
        actionCount: 3,
        spentMinor: 0,
        denialErrorTimestamps: [],
        actionTimestamps: [NOW - 10, NOW - 20, NOW - 30],
      },
    });

    expect(enforcer.authorize(lease, READ_CALL, limits, NOW)).toEqual({
      ok: false,
      reason: "over_actions_per_hour",
    });
  });

  it("allows when the strict-window count is below the limit", () => {
    const enforcer = createCapEnforcer();
    const limits: Limits = { max_actions: 100, actions_per_hour: 3 };
    const lease = makeLease({
      counters: {
        actionCount: 2,
        spentMinor: 0,
        denialErrorTimestamps: [],
        actionTimestamps: [NOW - 10, NOW - 20],
      },
    });

    expect(enforcer.authorize(lease, READ_CALL, limits, NOW)).toEqual({ ok: true });
  });

  it("excludes a timestamp exactly now-3600 (strict `>`, outside the window)", () => {
    const enforcer = createCapEnforcer();
    const limits: Limits = { max_actions: 100, actions_per_hour: 1 };
    const lease = makeLease({
      counters: {
        actionCount: 1,
        spentMinor: 0,
        denialErrorTimestamps: [],
        actionTimestamps: [NOW - HOUR],
      },
    });

    expect(enforcer.authorize(lease, READ_CALL, limits, NOW)).toEqual({ ok: true });
  });

  it("never denies when limits.actions_per_hour is undefined", () => {
    const enforcer = createCapEnforcer();
    const limits: Limits = { max_actions: 100 };
    const lease = makeLease({
      counters: {
        actionCount: 50,
        spentMinor: 0,
        denialErrorTimestamps: [],
        actionTimestamps: Array.from({ length: 50 }, () => NOW),
      },
    });

    expect(enforcer.authorize(lease, READ_CALL, limits, NOW)).toEqual({ ok: true });
  });
});

describe("createCapEnforcer: commit", () => {
  it("increments actionCount, appends now to a window-pruned actionTimestamps, and adds spendMinor to spentMinor, without mutating the input lease", () => {
    const enforcer = createCapEnforcer();
    const lease = makeLease({
      counters: {
        actionCount: 5,
        spentMinor: 100,
        denialErrorTimestamps: [],
        actionTimestamps: [NOW - HOUR, NOW - 10],
      },
    });
    const call: PolicyCall = { tool: "pay_invoice", spendMinor: 50 };

    const next = enforcer.commit(lease, call, NOW);

    expect(next).not.toBe(lease);
    expect(next.counters.actionCount).toBe(6);
    expect(next.counters.actionTimestamps).toEqual([NOW - 10, NOW]);
    expect(next.counters.spentMinor).toBe(150);
    // input unchanged
    expect(lease.counters.actionCount).toBe(5);
    expect(lease.counters.actionTimestamps).toEqual([NOW - HOUR, NOW - 10]);
    expect(lease.counters.spentMinor).toBe(100);
  });

  it("adds 0 to spentMinor when the call declares no spendMinor", () => {
    const enforcer = createCapEnforcer();
    const lease = makeLease({
      counters: { actionCount: 0, spentMinor: 0, denialErrorTimestamps: [], actionTimestamps: [NOW - HOUR] },
    });

    const next = enforcer.commit(lease, READ_CALL, NOW);

    expect(next.counters.spentMinor).toBe(0);
    expect(next.counters.actionCount).toBe(1);
    // the now-3600 entry is pruned away, leaving only the freshly-appended `now`.
    expect(next.counters.actionTimestamps).toEqual([NOW]);
  });
});

describe("extractSpendMinor", () => {
  const payEntry: ToolCatalogEntry = {
    name: "pay_invoice",
    description: "Pays an invoice",
    inputSchema: { type: "object", properties: { amount: { type: "number" } }, required: ["amount"] },
    payAmount: { amountArgPath: "amount", currency: "USD" },
  };

  const readEntry: ToolCatalogEntry = {
    name: "read_message",
    description: "Reads a message",
    inputSchema: { type: "object", properties: {}, required: [] },
  };

  it("returns the integer minor amount at the declared arg path for a pay entry", () => {
    expect(extractSpendMinor(payEntry, { amount: 500 })).toBe(500);
  });

  it("returns undefined for an entry with no payAmount descriptor", () => {
    expect(extractSpendMinor(readEntry, { amount: 500 })).toBeUndefined();
  });

  it("returns undefined when the declared arg path is absent", () => {
    expect(extractSpendMinor(payEntry, {})).toBeUndefined();
  });

  it("returns undefined when the value at the arg path is not a non-negative integer", () => {
    expect(extractSpendMinor(payEntry, { amount: -5 })).toBeUndefined();
    expect(extractSpendMinor(payEntry, { amount: 1.5 })).toBeUndefined();
    expect(extractSpendMinor(payEntry, { amount: "500" })).toBeUndefined();
  });

  it("a __proto__ arg path never reaches Object.prototype", () => {
    const protoEntry: ToolCatalogEntry = {
      ...payEntry,
      payAmount: { amountArgPath: "__proto__", currency: "USD" },
    };

    expect(extractSpendMinor(protoEntry, {})).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Task 3: cap-boundary + concurrency proof (PRXY-04) -- drives the 04-02
// server over `InMemoryTransport`, mirroring server-tracer.test.ts's /
// call-receipts.test.ts's own local buildDeps/connectedClient fixtures
// (each test file stays self-contained, per that established convention).
// ---------------------------------------------------------------------------

const READ_BINDING: ConnectorBinding = {
  tool: "read_message",
  resource: "inbox",
  access: "read",
  irreversible: false,
  provenance: "built_in",
};

const PAY_BINDING: ConnectorBinding = {
  tool: "pay_invoice",
  resource: "billing",
  access: "pay",
  irreversible: false,
  provenance: "built_in",
};

/** Approves every call instantly -- only used to get a `pay` call past the require_approval gate so the spend-cap boundary itself is what's under test. */
const ALWAYS_APPROVE: ApprovalStage = {
  requestApproval() {
    return Promise.resolve({ decision: "approve" });
  },
};

function makeCapsLease(id: string): Lease {
  return {
    id,
    state: "active",
    version: 0,
    boundHash: "jcs-sha256:test",
    grantedAt: NOW - 100,
    expiresAt: NOW + HOUR,
    maxDurationSeconds: HOUR,
    counters: { actionCount: 0, spentMinor: 0, denialErrorTimestamps: [], actionTimestamps: [] },
  };
}

async function buildCapsDeps(
  leaseId: string,
  limits: Limits,
  options?: { readonly includePayTool?: boolean },
): Promise<{
  deps: ProxyDeps;
  leaseStore: ReturnType<typeof createInMemoryLeaseStore>;
}> {
  const leaseStore = createInMemoryLeaseStore();
  await leaseStore.save(makeCapsLease(leaseId));

  const catalogEntries: ToolCatalogEntry[] = [
    {
      name: READ_BINDING.tool,
      description: "Reads a message",
      inputSchema: { type: "object", properties: {}, required: [] },
    },
  ];
  const bindings: ConnectorBinding[] = [READ_BINDING];
  if (options?.includePayTool === true) {
    catalogEntries.push({
      name: PAY_BINDING.tool,
      description: "Pays an invoice",
      inputSchema: { type: "object", properties: { amount: { type: "number" } }, required: ["amount"] },
      payAmount: { amountArgPath: "amount", currency: "USD" },
    });
    bindings.push(PAY_BINDING);
  }

  const deps: ProxyDeps = {
    leaseId,
    leaseStore,
    receiptStore: createInMemoryReceiptStore(),
    catalog: createToolCatalog(catalogEntries),
    bindings: createBindingSet(bindings),
    grantedScopes: options?.includePayTool === true ? ["read", "pay"] : ["read"],
    grantedResources: options?.includePayTool === true ? ["inbox", "billing"] : ["inbox"],
    limits,
    approvals: { require_for: [], timeout_seconds: 30 },
    clock: () => NOW,
    execute: createEchoExecuteStage({ ok: true }),
    approve: options?.includePayTool === true ? ALWAYS_APPROVE : DEFAULT_APPROVAL_STAGE,
    enforceCaps: createCapEnforcer(),
  };

  return { deps, leaseStore };
}

async function connectedCapsClient(deps: ProxyDeps): Promise<Client> {
  const server = createLeaseProxyServer(deps);
  const client = new Client({ name: "test-agent", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function deniedReason(result: CallToolResult): string {
  const [first] = result.content;
  if (first === undefined || first.type !== "text") {
    throw new Error("expected a text content block");
  }
  return first.text.replace(/^denied: /, "");
}

describe("PRXY-04 boundary: actions_per_hour", () => {
  it("the L-th call is allowed and the (L+1)-th is denied over_actions_per_hour; final actionTimestamps length is L", async () => {
    const L = 3;
    const { deps, leaseStore } = await buildCapsDeps("lease-boundary-aph", { max_actions: 1000, actions_per_hour: L });
    const client = await connectedCapsClient(deps);

    for (let i = 0; i < L; i++) {
      const result = (await client.callTool({ name: READ_BINDING.tool, arguments: {} })) as CallToolResult;
      expect(result.isError).not.toBe(true);
    }

    const overLimit = (await client.callTool({ name: READ_BINDING.tool, arguments: {} })) as CallToolResult;
    expect(overLimit.isError).toBe(true);
    expect(deniedReason(overLimit)).toBe("over_actions_per_hour");

    const lease = await leaseStore.load("lease-boundary-aph");
    expect(lease?.counters.actionTimestamps).toHaveLength(L);
  });
});

describe("PRXY-04 boundary: max_actions", () => {
  it("the M-th call is allowed and the (M+1)-th is denied over_max_actions", async () => {
    const M = 4;
    const { deps } = await buildCapsDeps("lease-boundary-max-actions", { max_actions: M });
    const client = await connectedCapsClient(deps);

    for (let i = 0; i < M; i++) {
      const result = (await client.callTool({ name: READ_BINDING.tool, arguments: {} })) as CallToolResult;
      expect(result.isError).not.toBe(true);
    }

    const overLimit = (await client.callTool({ name: READ_BINDING.tool, arguments: {} })) as CallToolResult;
    expect(overLimit.isError).toBe(true);
    expect(deniedReason(overLimit)).toBe("over_max_actions");
  });
});

describe("PRXY-04 boundary: spend", () => {
  it("a call bringing spentMinor to exactly S is allowed and one minor unit over S is denied over_spend", async () => {
    const S = 500;
    const { deps } = await buildCapsDeps(
      "lease-boundary-spend",
      { max_actions: 1000, spend: { amount_minor: S, currency: "USD" } },
      { includePayTool: true },
    );
    const client = await connectedCapsClient(deps);

    const atLimit = (await client.callTool({
      name: PAY_BINDING.tool,
      arguments: { amount: S },
    })) as CallToolResult;
    expect(atLimit.isError).not.toBe(true);

    const overLimit = (await client.callTool({
      name: PAY_BINDING.tool,
      arguments: { amount: 1 },
    })) as CallToolResult;
    expect(overLimit.isError).toBe(true);
    expect(deniedReason(overLimit)).toBe("over_spend");
  });
});

describe("PRXY-04 concurrency: K concurrent calls against one lease never exceed J = actions_per_hour", () => {
  it("K concurrent calls with actions_per_hour = J yield exactly J allowed and K-J denied, final actionTimestamps length J", async () => {
    const J = 5;
    const K = 12;
    const { deps, leaseStore } = await buildCapsDeps("lease-concurrency-aph", { max_actions: 1000, actions_per_hour: J });
    const client = await connectedCapsClient(deps);

    const results = await Promise.all(
      Array.from(
        { length: K },
        () => client.callTool({ name: READ_BINDING.tool, arguments: {} }) as Promise<CallToolResult>,
      ),
    );

    const allowedCount = results.filter((result) => result.isError !== true).length;
    const deniedCount = results.filter((result) => result.isError === true).length;
    expect(allowedCount).toBe(J);
    expect(deniedCount).toBe(K - J);
    for (const result of results.filter((result) => result.isError === true)) {
      expect(deniedReason(result)).toBe("over_actions_per_hour");
    }

    const lease = await leaseStore.load("lease-concurrency-aph");
    expect(lease?.counters.actionTimestamps).toHaveLength(J);
  });
});
