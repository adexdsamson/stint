/**
 * 10-06 Task 4 (SPEC-11): the agent signal tool `request_outcome_check`.
 *
 * The agent may ASK for a check; it can never complete one. A call to the fixed
 * tool receipts (sentinel resource `outcome_check`), tells the user through the
 * HostAdapter's `notify`, answers with fixed text, and leaves the lease record
 * and the transition set byte-identical, even in a world where the verifier
 * would pass. It consumes no binding, no counter and no limit.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";

import { createBindingSet, verifyChain } from "@stint/core";
import type { ConnectorBinding, Lease, LifecycleEvent } from "@stint/core";
import { createInMemoryLeaseStore, createInMemoryReceiptStore } from "@stint/core/testing";
import { hashCanonical } from "@stint/spec";

import { createToolCatalog } from "../src/catalog.js";
import { DEFAULT_APPROVAL_STAGE, DEFAULT_CAP_ENFORCER } from "../src/dispatch.js";
import type { CapEnforcer, ExecuteStage } from "../src/dispatch.js";
import { createLeaseProxyServer } from "../src/server.js";
import type { ProxyDeps } from "../src/server.js";
import type { TeardownStep } from "../src/teardown/steps.js";

const NOW = 1_700_000_000;
const LEASE = "lease-signal-1";
const SIGNAL = "request_outcome_check";
const SIGNAL_SUMMARY = "agent requested an outcome check";

const READ_BINDING: ConnectorBinding = {
  tool: "read_orders",
  resource: "orders",
  access: "read",
  irreversible: false,
  provenance: "built_in",
  // A verifier-grade row adapter: the passing world's predicate would be satisfied.
  rowAdapter: () => ({ rows: [{ verdict: "confirmed" }] }),
};

function makeLease(state: Lease["state"] = "active"): Lease {
  return {
    id: LEASE,
    state,
    version: 0,
    boundHash: "jcs-sha256:test",
    grantedAt: NOW - 100,
    expiresAt: NOW + 3600,
    maxDurationSeconds: 3600,
    counters: { actionCount: 0, spentMinor: 0, denialErrorTimestamps: [], actionTimestamps: [] },
  };
}

interface Rig {
  readonly deps: ProxyDeps;
  readonly leaseStore: ReturnType<typeof createInMemoryLeaseStore>;
  readonly receiptStore: ReturnType<typeof createInMemoryReceiptStore>;
  readonly events: LifecycleEvent[];
  readonly spies: { executes: number; commits: number; teardownRuns: number };
}

async function buildRig(
  opts: {
    readonly state?: Lease["state"];
    readonly notify?: ProxyDeps["notify"] | "absent";
    readonly extraTool?: string;
  } = {},
): Promise<Rig> {
  const leaseStore = createInMemoryLeaseStore();
  const receiptStore = createInMemoryReceiptStore();
  await leaseStore.save(makeLease(opts.state));
  const events: LifecycleEvent[] = [];
  const spies = { executes: 0, commits: 0, teardownRuns: 0 };

  const execute: ExecuteStage = {
    execute() {
      spies.executes += 1;
      return Promise.resolve({ status: 200, body: { rows: [{ verdict: "confirmed" }] } });
    },
  };
  const enforceCaps: CapEnforcer = {
    authorize: () => ({ ok: true }),
    commit: (lease, call, now) => {
      spies.commits += 1;
      return DEFAULT_CAP_ENFORCER.commit(lease, call, now);
    },
  };
  const teardownSteps: TeardownStep[] = [
    {
      name: "final_receipt",
      run: () => {
        spies.teardownRuns += 1;
        return Promise.resolve("ok");
      },
    },
  ];

  const tools = [
    {
      name: READ_BINDING.tool,
      description: "Reads orders",
      inputSchema: { type: "object" as const, properties: {}, required: [] },
    },
    ...(opts.extraTool === undefined
      ? []
      : [{ name: opts.extraTool, description: "A catalog tool", inputSchema: { type: "object" as const, properties: {}, required: [] } }]),
  ];
  const notify: ProxyDeps["notify"] =
    opts.notify === "absent"
      ? undefined
      : (opts.notify ??
        ((event) => {
          events.push(event);
          return Promise.resolve();
        }));

  const deps: ProxyDeps = {
    leaseId: LEASE,
    leaseStore,
    receiptStore,
    catalog: createToolCatalog(tools),
    bindings: createBindingSet([READ_BINDING]),
    grantedScopes: ["read"],
    grantedResources: ["orders"],
    limits: { max_actions: 1 },
    approvals: { require_for: [], timeout_seconds: 30 },
    clock: () => NOW,
    execute,
    approve: DEFAULT_APPROVAL_STAGE,
    enforceCaps,
    teardownSteps,
    ...(notify === undefined ? {} : { notify }),
  };
  return { deps, leaseStore, receiptStore, events, spies };
}

async function connect(deps: ProxyDeps): Promise<Client> {
  const server = createLeaseProxyServer(deps);
  const client = new Client({ name: "agent", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const call = async (client: Client, name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> =>
  (await client.callTool({ name, arguments: args })) as CallToolResult;

const textOf = (result: CallToolResult): string => {
  const first = result.content[0];
  return first !== undefined && first.type === "text" ? first.text : "";
};

describe("request_outcome_check: the tool list", () => {
  it("lists the fixed tool once, beside the catalog tools, with a fixed description", async () => {
    const rig = await buildRig();
    const client = await connect(rig.deps);

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);

    expect(names).toEqual([READ_BINDING.tool, SIGNAL]);
    expect(names.filter((n) => n === SIGNAL)).toHaveLength(1);
    const signal = tools.find((t) => t.name === SIGNAL);
    expect(signal?.description).toContain("user");
    expect(signal?.inputSchema.type).toBe("object");
  });

  it("a catalog entry with the same name neither duplicates nor shadows the fixed tool", async () => {
    const rig = await buildRig({ extraTool: SIGNAL });
    const client = await connect(rig.deps);

    const { tools } = await client.listTools();
    expect(tools.filter((t) => t.name === SIGNAL)).toHaveLength(1);

    const result = await call(client, SIGNAL);
    expect(result.isError).not.toBe(true);
    expect(rig.spies.executes).toBe(0);
  });
});

describe("request_outcome_check: a call is a notice", () => {
  it("receipts once (sentinel resource, fixed summary), notifies the host and answers with fixed text", async () => {
    const rig = await buildRig();
    const client = await connect(rig.deps);

    const result = await call(client, SIGNAL);

    expect(result.isError).not.toBe(true);
    const text = textOf(result);
    expect(text).toContain("user");
    expect(text).toContain("outcome check");
    // The answer is fully static: it carries no lease id, no value from the call.
    expect(text).not.toContain(LEASE);

    const chain = await rig.receiptStore.load("verified");
    expect(chain).toHaveLength(1);
    const entry = chain[0];
    expect(entry?.type).toBe("call");
    if (entry?.type !== "call") throw new Error("expected a call receipt");
    expect(entry.payload).toEqual({
      resource: "outcome_check",
      argsHash: hashCanonical({}),
      redactedSummary: SIGNAL_SUMMARY,
      outcome: "allowed",
    });
    expect((await verifyChain(chain, undefined, undefined)).ok).toBe(true);

    expect(rig.events).toEqual([{ type: "outcome_check_requested", leaseId: LEASE, at: NOW }]);
  });

  it("completion is impossible: the lease record and the transition set are byte-identical, and nothing ran", async () => {
    const rig = await buildRig();
    const client = await connect(rig.deps);
    const before = JSON.stringify(await rig.leaseStore.load(LEASE));

    // A passing world: the verifier binding would confirm, teardown steps exist, the caps stub would commit.
    await call(client, SIGNAL);
    await call(client, SIGNAL, { done: true, verified: true, complete: "yes", lease: LEASE });
    await call(client, SIGNAL);

    expect(JSON.stringify(await rig.leaseStore.load(LEASE))).toBe(before);
    expect((await rig.leaseStore.load(LEASE))?.state).toBe("active");
    const chain = await rig.receiptStore.load("verified");
    expect(chain.filter((e) => e.type === "transition")).toEqual([]);
    expect(JSON.stringify(chain)).not.toContain("outcome_verified");
    expect(JSON.stringify(chain)).not.toContain("begin_teardown");
    expect(rig.spies).toEqual({ executes: 0, commits: 0, teardownRuns: 0 });
  });

  it("consumes no binding, counter or limit: repeated signals leave the cap untouched and a real call still runs", async () => {
    const rig = await buildRig(); // max_actions: 1
    const client = await connect(rig.deps);

    for (let i = 0; i < 5; i += 1) {
      expect((await call(client, SIGNAL)).isError).not.toBe(true);
    }
    expect((await rig.leaseStore.load(LEASE))?.counters).toEqual({
      actionCount: 0,
      spentMinor: 0,
      denialErrorTimestamps: [],
      actionTimestamps: [],
    });

    const real = await call(client, READ_BINDING.tool);
    expect(real.isError).not.toBe(true);
    expect(rig.spies.executes).toBe(1);
    expect(rig.events).toHaveLength(5);
  });

  it("never echoes agent arguments into the receipt or the answer", async () => {
    const rig = await buildRig();
    const client = await connect(rig.deps);

    const result = await call(client, SIGNAL, { note: "sk_live_super_secret_value" });

    expect(textOf(result)).not.toContain("sk_live_super_secret_value");
    expect(JSON.stringify(await rig.receiptStore.load("verified"))).not.toContain("sk_live_super_secret_value");
  });

  it("a host whose notify throws changes nothing: the call is still receipted and answered", async () => {
    const rig = await buildRig({ notify: () => Promise.reject(new Error("host exploded")) });
    const client = await connect(rig.deps);

    const result = await call(client, SIGNAL);

    expect(result.isError).not.toBe(true);
    expect(textOf(result)).not.toContain("host exploded");
    expect(await rig.receiptStore.load("verified")).toHaveLength(1);
  });

  it("works with no notify configured (receipt and answer only)", async () => {
    const rig = await buildRig({ notify: "absent" });
    const client = await connect(rig.deps);

    const result = await call(client, SIGNAL);

    expect(result.isError).not.toBe(true);
    expect(await rig.receiptStore.load("verified")).toHaveLength(1);
  });

  it("on a lease that is not active it is denied with a denied receipt, tells nobody and changes nothing", async () => {
    const rig = await buildRig({ state: "expired" });
    const client = await connect(rig.deps);

    const result = await call(client, SIGNAL);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("denied: lease_not_active");
    const chain = await rig.receiptStore.load("verified");
    expect(chain).toHaveLength(1);
    if (chain[0]?.type !== "call") throw new Error("expected a call receipt");
    expect(chain[0].payload.outcome).toBe("denied");
    expect(chain[0].payload.resource).toBe("outcome_check");
    expect(rig.events).toEqual([]);
    expect((await rig.leaseStore.load(LEASE))?.state).toBe("expired");
  });
});
