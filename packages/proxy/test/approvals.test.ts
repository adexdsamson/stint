/**
 * `approvals.test.ts` -- Task 2: unit tests for `computeApprovalHash` (the
 * confirmed D-11 commitment tuple) and `createApprovalDispatcher` (armed
 * timeout, deny-by-default on throw/never-resolve, the exact-deadline-vs-
 * one-tick-past boundary), using a stub `HostAdapter` and a fake/controlled
 * clock. Task 3 extends this same file with the end-to-end drift/timeout
 * cases driven over the 04-02 server.
 */

import { describe, expect, it } from "vitest";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { createBindingSet } from "@stint/core";
import type {
  ApprovalDecision as HostApprovalDecision,
  ApprovalRequest,
  ApprovalRequirement,
  ConnectorBinding,
  HostAdapter,
  Lease,
} from "@stint/core";
import { createInMemoryLeaseStore, createInMemoryReceiptStore } from "@stint/core/testing";
import type { ContentHash } from "@stint/spec";

import { computeApprovalHash, createApprovalDispatcher } from "../src/approvals/approval-dispatcher.js";
import { createToolCatalog } from "../src/catalog.js";
import type { ToolCatalogEntry } from "../src/catalog.js";
import { DEFAULT_CAP_ENFORCER } from "../src/dispatch.js";
import type { ApprovalStage, CallContext } from "../src/dispatch.js";
import { createLeaseProxyServer } from "../src/server.js";
import type { ProxyDeps } from "../src/server.js";
import { createEchoExecuteStage } from "../src/testing.js";

const NOW = 1_700_000_000;

const BINDING: ConnectorBinding = {
  tool: "send_message",
  resource: "inbox",
  access: "send",
  irreversible: false,
  provenance: "built_in",
};

const REQUIREMENT: ApprovalRequirement = { trigger: "send", binding: BINDING };

function makeCtx(overrides?: Partial<CallContext>): CallContext {
  return {
    leaseId: "lease-approvals",
    tool: BINDING.tool,
    resolvedArgs: { to: "alice", body: "hi" },
    binding: BINDING,
    leaseVersion: 0,
    ...overrides,
  };
}

/** A `HostAdapter` whose `requestApproval` never settles -- proves the armed timer is what denies, not the adapter itself. */
function neverResolvingAdapter(): HostAdapter {
  return {
    requestConsent() {
      return new Promise<never>(() => undefined);
    },
    requestApproval() {
      return new Promise<HostApprovalDecision>(() => undefined);
    },
    requestOutcomeConfirmation() {
      return Promise.reject(new Error("n/a"));
    },
    notify() {
      return Promise.resolve();
    },
  };
}

/** A `HostAdapter` whose `requestApproval` rejects synchronously -- proves an adapter error can never become an allow. */
function throwingAdapter(): HostAdapter {
  return {
    requestConsent() {
      return Promise.reject(new Error("n/a"));
    },
    requestApproval() {
      return Promise.reject(new Error("adapter blew up"));
    },
    requestOutcomeConfirmation() {
      return Promise.reject(new Error("n/a"));
    },
    notify() {
      return Promise.resolve();
    },
  };
}

describe("createApprovalDispatcher: commitment hash (computeApprovalHash)", () => {
  it("returns equal hashes for equal (args, tool, provenance, leaseVersion)", () => {
    const a = computeApprovalHash({ to: "alice" }, { tool: "t", provenance: "built_in" }, 3);
    const b = computeApprovalHash({ to: "alice" }, { tool: "t", provenance: "built_in" }, 3);
    expect(a).toBe(b);
  });

  it("changes the commitment hash when the args value drifts", () => {
    const a = computeApprovalHash({ to: "alice" }, { tool: "t", provenance: "built_in" }, 3);
    const b = computeApprovalHash({ to: "bob" }, { tool: "t", provenance: "built_in" }, 3);
    expect(a).not.toBe(b);
  });

  it("changes the commitment hash when the tool drifts (binding hot-swap)", () => {
    const a = computeApprovalHash({ to: "alice" }, { tool: "t1", provenance: "built_in" }, 3);
    const b = computeApprovalHash({ to: "alice" }, { tool: "t2", provenance: "built_in" }, 3);
    expect(a).not.toBe(b);
  });

  it("changes the commitment hash when the provenance drifts (binding hot-swap)", () => {
    const a = computeApprovalHash({ to: "alice" }, { tool: "t", provenance: "built_in" }, 3);
    const b = computeApprovalHash({ to: "alice" }, { tool: "t", provenance: "user_approved_custom" }, 3);
    expect(a).not.toBe(b);
  });

  it("changes the commitment hash when leaseVersion drifts (mid-flight lease mutation)", () => {
    const a = computeApprovalHash({ to: "alice" }, { tool: "t", provenance: "built_in" }, 3);
    const b = computeApprovalHash({ to: "alice" }, { tool: "t", provenance: "built_in" }, 4);
    expect(a).not.toBe(b);
  });
});

describe("createApprovalDispatcher: armed timeout", () => {
  it("arms a real timer from timeoutSeconds and denies timeout once it fires, for a never-resolving adapter", async () => {
    const dispatcher = createApprovalDispatcher(neverResolvingAdapter(), 0.05, () => NOW);

    const decision = await dispatcher.requestApproval(makeCtx(), REQUIREMENT, NOW);

    expect(decision).toEqual({ decision: "deny", reason: "timeout" });
  });

  it("a decision resolving exactly at the deadline vs one tick past: the past-deadline decision loses to the abort and denies timeout", async () => {
    const timeoutSeconds = 0.05;
    const lateAdapter: HostAdapter = {
      requestConsent() {
        return Promise.reject(new Error("n/a"));
      },
      requestApproval() {
        return new Promise<HostApprovalDecision>((resolve) => {
          // Resolves AFTER the armed deadline -- must still lose the race.
          setTimeout(() => {
            resolve({ decision: "approve" });
          }, timeoutSeconds * 1000 + 40);
        });
      },
      requestOutcomeConfirmation() {
        return Promise.reject(new Error("n/a"));
      },
      notify() {
        return Promise.resolve();
      },
    };
    const dispatcher = createApprovalDispatcher(lateAdapter, timeoutSeconds, () => NOW);

    const decision = await dispatcher.requestApproval(makeCtx(), REQUIREMENT, NOW);

    expect(decision).toEqual({ decision: "deny", reason: "timeout" });
  });
});

describe("createApprovalDispatcher: deny-by-default", () => {
  it("denies (never allows) when the adapter throws", async () => {
    const dispatcher = createApprovalDispatcher(throwingAdapter(), 30, () => NOW);

    const decision = await dispatcher.requestApproval(makeCtx(), REQUIREMENT, NOW);

    expect(decision.decision).toBe("deny");
  });

  it("never places a raw call argument on the ApprovalRequest sent to the adapter (D-18)", async () => {
    let capturedRequest: ApprovalRequest | undefined;
    const capturingAdapter: HostAdapter = {
      requestConsent() {
        return Promise.reject(new Error("n/a"));
      },
      requestApproval(request) {
        capturedRequest = request;
        return Promise.resolve({ decision: "approve" });
      },
      requestOutcomeConfirmation() {
        return Promise.reject(new Error("n/a"));
      },
      notify() {
        return Promise.resolve();
      },
    };
    const dispatcher = createApprovalDispatcher(capturingAdapter, 30, () => NOW);

    await dispatcher.requestApproval(makeCtx({ resolvedArgs: { secret: "shh", to: "alice" } }), REQUIREMENT, NOW);

    expect(capturedRequest).toBeDefined();
    expect(JSON.stringify(capturedRequest)).not.toContain("shh");
    expect(capturedRequest).not.toHaveProperty("resolvedArgs");
    expect(capturedRequest).not.toHaveProperty("args");
  });
});

// ---------------------------------------------------------------------------
// Task 3: wire require_approval into the dispatch -- end-to-end approve /
// drift / timeout / pay-always cases driven over the 04-02 server, mirroring
// server-tracer.test.ts's / caps-concurrency.test.ts's own local
// buildDeps/connectedClient fixtures (each test file stays self-contained).
// ---------------------------------------------------------------------------

const SEND_BINDING: ConnectorBinding = {
  tool: "send_message",
  resource: "inbox",
  access: "send",
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

function makeApprovalLease(id: string, overrides?: Partial<Lease>): Lease {
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

async function buildApprovalDeps(
  leaseId: string,
  approve: ApprovalStage,
  options?: {
    readonly includePayTool?: boolean;
    readonly requireForSend?: boolean;
  },
): Promise<{
  deps: ProxyDeps;
  leaseStore: ReturnType<typeof createInMemoryLeaseStore>;
  receiptStore: ReturnType<typeof createInMemoryReceiptStore>;
}> {
  const leaseStore = createInMemoryLeaseStore();
  await leaseStore.save(makeApprovalLease(leaseId));
  const receiptStore = createInMemoryReceiptStore();

  const catalogEntries: ToolCatalogEntry[] = [
    {
      name: SEND_BINDING.tool,
      description: "Sends a message",
      inputSchema: { type: "object", properties: { to: { type: "string" } }, required: ["to"] },
    },
  ];
  const bindings: ConnectorBinding[] = [SEND_BINDING];
  const grantedScopes: ConnectorBinding["access"][] = ["send"];
  const grantedResources: string[] = [SEND_BINDING.resource];

  if (options?.includePayTool === true) {
    catalogEntries.push({
      name: PAY_BINDING.tool,
      description: "Pays an invoice",
      inputSchema: { type: "object", properties: { amount: { type: "number" } }, required: ["amount"] },
      payAmount: { amountArgPath: "amount", currency: "USD" },
    });
    bindings.push(PAY_BINDING);
    grantedScopes.push("pay");
    grantedResources.push(PAY_BINDING.resource);
  }

  const deps: ProxyDeps = {
    leaseId,
    leaseStore,
    receiptStore,
    catalog: createToolCatalog(catalogEntries),
    bindings: createBindingSet(bindings),
    grantedScopes,
    grantedResources,
    limits: { max_actions: 100 },
    approvals: { require_for: options?.requireForSend === false ? [] : ["send"], timeout_seconds: 30 },
    clock: () => NOW,
    execute: createEchoExecuteStage({ ok: true }),
    approve,
    enforceCaps: DEFAULT_CAP_ENFORCER,
  };

  return { deps, leaseStore, receiptStore };
}

async function connectedApprovalClient(deps: ProxyDeps): Promise<Client> {
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

/** A `HostAdapter` that approves every call instantly. */
function approvingAdapter(): HostAdapter {
  return {
    requestConsent() {
      return Promise.reject(new Error("n/a"));
    },
    requestApproval() {
      return Promise.resolve({ decision: "approve" });
    },
    requestOutcomeConfirmation() {
      return Promise.reject(new Error("n/a"));
    },
    notify() {
      return Promise.resolve();
    },
  };
}

describe("PRXY-05 approval integration: approve executes", () => {
  it("an approved, un-drifted call executes and appends exactly one allowed receipt", async () => {
    const approve = createApprovalDispatcher(approvingAdapter(), 30, () => NOW);
    const { deps, receiptStore } = await buildApprovalDeps("lease-approve-executes", approve);
    const client = await connectedApprovalClient(deps);

    const result = (await client.callTool({ name: SEND_BINDING.tool, arguments: { to: "alice" } })) as CallToolResult;

    expect(result.isError).not.toBe(true);

    const chain = await receiptStore.load("verified");
    expect(chain).toHaveLength(1);
    const [entry] = chain;
    if (entry === undefined || entry.type !== "call") {
      throw new Error("expected a call receipt entry");
    }
    expect(entry.payload.outcome).toBe("allowed");
  });
});

describe("PRXY-05 approval integration: drift denies the reused approval", () => {
  it("arg drift between approval and execution denies the reused approval (approval_drifted)", async () => {
    // Raw args never reach the out-of-band adapter (D-18), so a genuinely
    // stale commitment is simulated directly: this double mints a
    // commitment over DIFFERENT args than the ones dispatch.ts will
    // recompute against at execution time -- exactly what a reused
    // approval's stored commitment would look like after the args changed.
    const staleApprovals = new Map<string, ContentHash>();
    const driftingArgsApprove: ApprovalStage = {
      requestApproval(ctx) {
        const staleArgs = { ...ctx.resolvedArgs, to: "mallory" };
        staleApprovals.set("approval-drift-args", computeApprovalHash(staleArgs, ctx.binding, ctx.leaseVersion));
        return Promise.resolve({ decision: "approve", approvalId: "approval-drift-args" });
      },
      verifyCommitment(approvalId, currentHash) {
        return staleApprovals.get(approvalId) === currentHash;
      },
    };
    const { deps } = await buildApprovalDeps("lease-drift-args", driftingArgsApprove);
    const client = await connectedApprovalClient(deps);

    const result = (await client.callTool({ name: SEND_BINDING.tool, arguments: { to: "alice" } })) as CallToolResult;

    expect(result.isError).toBe(true);
    expect(deniedReason(result)).toBe("approval_drifted");
  });

  it("a binding hot-swap during the hold denies the reused approval (approval_drifted)", async () => {
    const leaseId = "lease-drift-binding";
    const leaseStore = createInMemoryLeaseStore();
    await leaseStore.save(makeApprovalLease(leaseId));
    const receiptStore = createInMemoryReceiptStore();
    const bindings = createBindingSet([SEND_BINDING]);

    const hotSwapAdapter: HostAdapter = {
      requestConsent() {
        return Promise.reject(new Error("n/a"));
      },
      requestApproval() {
        // Simulates an out-of-band binding hot-swap during the hold: the
        // SAME tool name now resolves to a different-provenance binding by
        // the time execution recomputes the commitment.
        (bindings as unknown as Record<string, ConnectorBinding>)[SEND_BINDING.tool] = {
          ...SEND_BINDING,
          provenance: "user_approved_custom",
        };
        return Promise.resolve({ decision: "approve" });
      },
      requestOutcomeConfirmation() {
        return Promise.reject(new Error("n/a"));
      },
      notify() {
        return Promise.resolve();
      },
    };
    const approve = createApprovalDispatcher(hotSwapAdapter, 30, () => NOW);

    const deps: ProxyDeps = {
      leaseId,
      leaseStore,
      receiptStore,
      catalog: createToolCatalog([
        {
          name: SEND_BINDING.tool,
          description: "Sends a message",
          inputSchema: { type: "object", properties: { to: { type: "string" } }, required: ["to"] },
        },
      ]),
      bindings,
      grantedScopes: ["send"],
      grantedResources: [SEND_BINDING.resource],
      limits: { max_actions: 100 },
      approvals: { require_for: ["send"], timeout_seconds: 30 },
      clock: () => NOW,
      execute: createEchoExecuteStage({ ok: true }),
      approve,
      enforceCaps: DEFAULT_CAP_ENFORCER,
    };
    const client = await connectedApprovalClient(deps);

    const result = (await client.callTool({ name: SEND_BINDING.tool, arguments: { to: "alice" } })) as CallToolResult;

    expect(result.isError).toBe(true);
    expect(deniedReason(result)).toBe("approval_drifted");
  });

  it("a lease-version bump during the hold denies the reused approval (approval_drifted)", async () => {
    const leaseId = "lease-drift-version";
    const leaseStore = createInMemoryLeaseStore();
    const initialLease = makeApprovalLease(leaseId);
    await leaseStore.save(initialLease);
    const receiptStore = createInMemoryReceiptStore();

    const versionBumpAdapter: HostAdapter = {
      requestConsent() {
        return Promise.reject(new Error("n/a"));
      },
      async requestApproval() {
        // Simulates an out-of-band lease-version bump during the hold (e.g.
        // a consent/extend event from elsewhere) via a direct `.save` that
        // bypasses the per-lease transaction's own serialization -- exactly
        // the scenario the recompute-and-match must catch.
        await leaseStore.save({ ...initialLease, version: initialLease.version + 1 });
        return { decision: "approve" };
      },
      requestOutcomeConfirmation() {
        return Promise.reject(new Error("n/a"));
      },
      notify() {
        return Promise.resolve();
      },
    };
    const approve = createApprovalDispatcher(versionBumpAdapter, 30, () => NOW);

    const deps: ProxyDeps = {
      leaseId,
      leaseStore,
      receiptStore,
      catalog: createToolCatalog([
        {
          name: SEND_BINDING.tool,
          description: "Sends a message",
          inputSchema: { type: "object", properties: { to: { type: "string" } }, required: ["to"] },
        },
      ]),
      bindings: createBindingSet([SEND_BINDING]),
      grantedScopes: ["send"],
      grantedResources: [SEND_BINDING.resource],
      limits: { max_actions: 100 },
      approvals: { require_for: ["send"], timeout_seconds: 30 },
      clock: () => NOW,
      execute: createEchoExecuteStage({ ok: true }),
      approve,
      enforceCaps: DEFAULT_CAP_ENFORCER,
    };
    const client = await connectedApprovalClient(deps);

    const result = (await client.callTool({ name: SEND_BINDING.tool, arguments: { to: "alice" } })) as CallToolResult;

    expect(result.isError).toBe(true);
    expect(deniedReason(result)).toBe("approval_drifted");
  });
});

describe("PRXY-05 approval integration: timeout denies at the boundary", () => {
  it("a never-answered approval denies timeout end-to-end and appends one denied receipt", async () => {
    const neverAdapter: HostAdapter = {
      requestConsent() {
        return Promise.reject(new Error("n/a"));
      },
      requestApproval() {
        return new Promise<HostApprovalDecision>(() => undefined);
      },
      requestOutcomeConfirmation() {
        return Promise.reject(new Error("n/a"));
      },
      notify() {
        return Promise.resolve();
      },
    };
    const approve = createApprovalDispatcher(neverAdapter, 0.05, () => NOW);
    const { deps, receiptStore } = await buildApprovalDeps("lease-timeout-e2e", approve);
    const client = await connectedApprovalClient(deps);

    const result = (await client.callTool({ name: SEND_BINDING.tool, arguments: { to: "alice" } })) as CallToolResult;

    expect(result.isError).toBe(true);
    expect(deniedReason(result)).toBe("timeout");

    const chain = await receiptStore.load("verified");
    expect(chain).toHaveLength(1);
    const [entry] = chain;
    if (entry === undefined || entry.type !== "call") {
      throw new Error("expected a call receipt entry");
    }
    expect(entry.payload.outcome).toBe("denied");
  });
});

describe("PRXY-05 approval integration: pay always requires approval", () => {
  it("a pay call is held via ApprovalStage even when approvals.require_for omits it", async () => {
    let requestApprovalCalled = false;
    const trackingAdapter: HostAdapter = {
      requestConsent() {
        return Promise.reject(new Error("n/a"));
      },
      requestApproval() {
        requestApprovalCalled = true;
        return Promise.resolve({ decision: "deny", reason: "user_denied" });
      },
      requestOutcomeConfirmation() {
        return Promise.reject(new Error("n/a"));
      },
      notify() {
        return Promise.resolve();
      },
    };
    const approve = createApprovalDispatcher(trackingAdapter, 30, () => NOW);
    const { deps } = await buildApprovalDeps("lease-pay-always", approve, {
      includePayTool: true,
      requireForSend: false,
    });
    const client = await connectedApprovalClient(deps);

    const result = (await client.callTool({ name: PAY_BINDING.tool, arguments: { amount: 100 } })) as CallToolResult;

    expect(requestApprovalCalled).toBe(true);
    expect(result.isError).toBe(true);
    expect(deniedReason(result)).toBe("user_denied");
  });
});
