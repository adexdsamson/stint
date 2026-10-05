/**
 * `approval-recheck.test.ts` -- PRXY-09 and PRXY-10: an approval wait holds no
 * lease lock, and after the wait everything is evaluated again with a fresh
 * clock before anything runs (D-18, D-19, D-20, D-21). The doubles are a
 * mutable clock and a deferred-approval `HostAdapter` behind the real
 * `createApprovalDispatcher`.
 */

import { describe, expect, it } from "vitest";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { createBindingSet, createLeaseEndedReason, isLeaseEndedSignal } from "@stint/core";
import type {
  ApprovalDecision as HostApprovalDecision,
  ApprovalRequest,
  ConnectorBinding,
  HostAdapter,
  LeaseStore,
  LifecycleEvent,
  Lease,
  Telemetry,
  TelemetryEvent,
} from "@stint/core";
import { createInMemoryLeaseStore, createInMemoryReceiptStore } from "@stint/core/testing";

import { computeApprovalHash, createApprovalDispatcher } from "../src/approvals/approval-dispatcher.js";
import { createToolCatalog } from "../src/catalog.js";
import { DEFAULT_CAP_ENFORCER, handleCall } from "../src/dispatch.js";
import type { ApprovalStage, CallContext, ExecuteStage } from "../src/dispatch.js";
import type { ProxyDeps } from "../src/server.js";

const NOW = 1_700_000_000;
const EXPIRES_AT = NOW + 3600;
/** Large enough that the lease-end watcher never fires in tests that are not about it. */
const NO_WATCH_MS = 600_000;

const SEND: ConnectorBinding = {
  tool: "send_message",
  resource: "inbox",
  access: "send",
  irreversible: false,
  provenance: "built_in",
};

const READ: ConnectorBinding = {
  tool: "read_inbox",
  resource: "inbox",
  access: "read",
  irreversible: false,
  provenance: "built_in",
};

function makeLease(id: string, overrides?: Partial<Lease>): Lease {
  return {
    id,
    state: "active",
    version: 0,
    boundHash: "jcs-sha256:test",
    grantedAt: NOW - 100,
    expiresAt: EXPIRES_AT,
    maxDurationSeconds: 3600,
    counters: { actionCount: 0, spentMinor: 0, denialErrorTimestamps: [], actionTimestamps: [] },
    ...overrides,
  };
}

interface DeferredAdapter {
  readonly adapter: HostAdapter;
  /** Resolves with the request and signal the moment the adapter is asked. */
  readonly requested: Promise<{ readonly request: ApprovalRequest; readonly signal: AbortSignal }>;
  readonly requestCount: () => number;
  readonly events: LifecycleEvent[];
  answer(decision: HostApprovalDecision): void;
}

/** A `HostAdapter` whose first approval is answered by the test, whenever the test chooses. */
function deferredAdapter(onRequest?: () => void | Promise<void>): DeferredAdapter {
  let requests = 0;
  let answerFn: (decision: HostApprovalDecision) => void = () => undefined;
  let announce: (value: { request: ApprovalRequest; signal: AbortSignal }) => void = () => undefined;
  const requested = new Promise<{ request: ApprovalRequest; signal: AbortSignal }>((resolve) => {
    announce = resolve;
  });
  const events: LifecycleEvent[] = [];
  const adapter: HostAdapter = {
    requestConsent: () => Promise.reject(new Error("n/a")),
    async requestApproval(request, signal) {
      requests += 1;
      const answered = new Promise<HostApprovalDecision>((resolve) => {
        answerFn = resolve;
      });
      announce({ request, signal });
      await onRequest?.();
      return answered;
    },
    requestOutcomeConfirmation: () => Promise.reject(new Error("n/a")),
    notify(event) {
      events.push(event);
      return Promise.resolve();
    },
  };
  return {
    adapter,
    requested,
    requestCount: () => requests,
    events,
    answer: (decision) => {
      answerFn(decision);
    },
  };
}

function countingExecute(): { readonly stage: ExecuteStage; readonly calls: () => number } {
  let calls = 0;
  return {
    stage: {
      execute() {
        calls += 1;
        return Promise.resolve({ status: 200, body: { ok: true } });
      },
    },
    calls: () => calls,
  };
}

function recordingTelemetry(): { readonly telemetry: Telemetry; readonly events: TelemetryEvent[] } {
  const events: TelemetryEvent[] = [];
  return {
    telemetry: {
      emit(event) {
        events.push(event);
      },
    },
    events,
  };
}

interface Rig {
  readonly deps: ProxyDeps;
  readonly leaseStore: LeaseStore;
  readonly receiptStore: ReturnType<typeof createInMemoryReceiptStore>;
  readonly execute: ReturnType<typeof countingExecute>;
  readonly clock: { now: number };
}

async function buildRig(
  leaseId: string,
  approve: ApprovalStage,
  options?: {
    readonly maxActions?: number;
    readonly watchMs?: number;
    readonly leaseStore?: LeaseStore;
    readonly telemetry?: Telemetry;
    readonly bindings?: ReturnType<typeof createBindingSet>;
  },
): Promise<Rig> {
  const leaseStore = options?.leaseStore ?? createInMemoryLeaseStore();
  await leaseStore.save(makeLease(leaseId));
  const receiptStore = createInMemoryReceiptStore();
  const execute = countingExecute();
  const clock = { now: NOW };
  const deps: ProxyDeps = {
    leaseId,
    leaseStore,
    receiptStore,
    catalog: createToolCatalog([
      {
        name: SEND.tool,
        description: "Sends a message",
        inputSchema: { type: "object", properties: { to: { type: "string" } }, required: ["to"] },
      },
      { name: READ.tool, description: "Reads the inbox", inputSchema: { type: "object", properties: {} } },
    ]),
    bindings: options?.bindings ?? createBindingSet([SEND, READ]),
    grantedScopes: ["send", "read"],
    grantedResources: ["inbox"],
    limits: { max_actions: options?.maxActions ?? 100 },
    approvals: { require_for: ["send"], timeout_seconds: 30 },
    clock: () => clock.now,
    execute: execute.stage,
    approve,
    enforceCaps: DEFAULT_CAP_ENFORCER,
    approvalWatchMs: options?.watchMs ?? NO_WATCH_MS,
    ...(options?.telemetry !== undefined ? { telemetry: options.telemetry } : {}),
  };
  return { deps, leaseStore, receiptStore, execute, clock };
}

function text(result: CallToolResult): string {
  const [first] = result.content;
  if (first === undefined || first.type !== "text") throw new Error("expected a text content block");
  return first.text;
}

async function summaries(rig: Rig): Promise<string[]> {
  const chain = await rig.receiptStore.load("verified");
  return chain.map((entry) => {
    if (entry.type !== "call") throw new Error("expected only call receipts");
    return entry.payload.redactedSummary;
  });
}

const sendCall = { name: SEND.tool, arguments: { to: "alice" } };
const readCall = { name: READ.tool, arguments: {} };

describe("PRXY-09: an approval granted after expiry never executes", () => {
  it("denies expired at exactly expires_at, executes nothing, and says so in the one receipt", async () => {
    const host = deferredAdapter();
    const rig = await buildRig("lease-expiry-boundary", createApprovalDispatcher(host.adapter, 30, () => NOW));

    const pending = handleCall(rig.deps, sendCall, NOW);
    await host.requested;
    rig.clock.now = EXPIRES_AT;
    host.answer({ decision: "approve" });
    const result = await pending;

    expect(result.isError).toBe(true);
    expect(text(result)).toBe("denied: expired");
    expect(rig.execute.calls()).toBe(0);
    expect(await summaries(rig)).toEqual(['call to "send_message" denied after approval: expired']);
  });

  it("executes when the approval is granted one second before expires_at", async () => {
    const host = deferredAdapter();
    const rig = await buildRig("lease-expiry-before", createApprovalDispatcher(host.adapter, 30, () => NOW));

    const pending = handleCall(rig.deps, sendCall, NOW);
    await host.requested;
    rig.clock.now = EXPIRES_AT - 1;
    host.answer({ decision: "approve" });
    const result = await pending;

    expect(result.isError).toBe(false);
    expect(rig.execute.calls()).toBe(1);
    expect(await summaries(rig)).toEqual(['call to "send_message" allowed']);
  });

  it("tells the user, through notify, that the approval did not take effect", async () => {
    const host = deferredAdapter();
    const rig = await buildRig("lease-expiry-notify", createApprovalDispatcher(host.adapter, 30, () => NOW));

    const pending = handleCall(rig.deps, sendCall, NOW);
    await host.requested;
    rig.clock.now = EXPIRES_AT + 5;
    host.answer({ decision: "approve" });
    const result = await pending;

    expect(text(result)).toBe("denied: expired");
    expect(host.events).toEqual([
      { type: "approval_void", leaseId: "lease-expiry-notify", at: EXPIRES_AT + 5, reason: "expired_after_approval" },
    ]);
  });

  it("never tells the agent that an approval was granted", async () => {
    const host = deferredAdapter();
    const rig = await buildRig("lease-agent-text", createApprovalDispatcher(host.adapter, 30, () => NOW));

    const pending = handleCall(rig.deps, sendCall, NOW);
    await host.requested;
    rig.clock.now = EXPIRES_AT;
    host.answer({ decision: "approve" });
    const result = await pending;

    expect(text(result)).not.toMatch(/approv/i);
  });
});

describe("PRXY-10: nothing is locked or reserved while an approval waits", () => {
  it("lets a read call on the same lease finish before the send call's approval is answered", async () => {
    const host = deferredAdapter();
    const rig = await buildRig("lease-concurrent-read", createApprovalDispatcher(host.adapter, 30, () => NOW));

    const pendingSend = handleCall(rig.deps, sendCall, NOW);
    await host.requested;

    const readResult = await handleCall(rig.deps, readCall, NOW);
    expect(readResult.isError).toBe(false);
    expect(rig.execute.calls()).toBe(1);

    host.answer({ decision: "approve" });
    const sendResult = await pendingSend;
    expect(sendResult.isError).toBe(false);
    expect(rig.execute.calls()).toBe(2);
    // Receipts are in decision order: the read decided first.
    expect(await summaries(rig)).toEqual(['call to "read_inbox" allowed', 'call to "send_message" allowed']);
  });

  it("denies a waiting call over_max_actions when another call used the last action, and never exceeds the cap", async () => {
    const host = deferredAdapter();
    const rig = await buildRig("lease-cap-consumed", createApprovalDispatcher(host.adapter, 30, () => NOW), {
      maxActions: 1,
    });

    const pendingSend = handleCall(rig.deps, sendCall, NOW);
    await host.requested;
    await handleCall(rig.deps, readCall, NOW);
    host.answer({ decision: "approve" });
    const result = await pendingSend;

    expect(text(result)).toBe("denied: over_max_actions");
    expect(rig.execute.calls()).toBe(1);
    expect(await summaries(rig)).toEqual([
      'call to "read_inbox" allowed',
      'call to "send_message" denied after approval: over_max_actions',
    ]);
    const lease = await rig.leaseStore.load("lease-cap-consumed");
    expect(lease?.counters.actionCount).toBe(1);
    expect(host.events.map((event) => event.type === "approval_void" && event.reason)).toEqual([
      "limit_reached_after_approval",
    ]);
  });
});

describe("D-20: a lease that ends during the wait cancels the approval", () => {
  it("aborts the adapter's signal with the lease-ended reason and denies lease_ended with one plain receipt", async () => {
    const host = deferredAdapter();
    const rig = await buildRig("lease-ends-during-wait", createApprovalDispatcher(host.adapter, 30, () => NOW), {
      watchMs: 10,
    });

    const pending = handleCall(rig.deps, sendCall, NOW);
    const { signal } = await host.requested;
    const lease = await rig.leaseStore.load("lease-ends-during-wait");
    if (lease === undefined) throw new Error("lease missing");
    await rig.leaseStore.save({ ...lease, state: "revoked" });
    const result = await pending;

    expect(isLeaseEndedSignal(signal)).toBe(true);
    expect(text(result)).toBe("denied: lease_ended");
    expect(rig.execute.calls()).toBe(0);
    expect(await summaries(rig)).toEqual(['call to "send_message" denied: lease_ended']);
    expect(host.events).toEqual([]);
  });

  it("also cancels when the clock passes expires_at during the wait", async () => {
    const host = deferredAdapter();
    const rig = await buildRig("lease-expires-during-wait", createApprovalDispatcher(host.adapter, 30, () => NOW), {
      watchMs: 10,
    });

    const pending = handleCall(rig.deps, sendCall, NOW);
    const { signal } = await host.requested;
    rig.clock.now = EXPIRES_AT;
    const result = await pending;

    expect(isLeaseEndedSignal(signal)).toBe(true);
    expect(text(result)).toBe("denied: lease_ended");
  });

  it("clears the watcher timer on every path", async () => {
    const host = deferredAdapter();
    const rig = await buildRig("lease-watcher-cleared", createApprovalDispatcher(host.adapter, 30, () => NOW), {
      watchMs: 5,
    });
    let loads = 0;
    const inner = rig.leaseStore;
    const counting: LeaseStore = {
      ...inner,
      load(id) {
        loads += 1;
        return inner.load(id);
      },
    };
    const deps: ProxyDeps = { ...rig.deps, leaseStore: counting };

    const pending = handleCall(deps, sendCall, NOW);
    await host.requested;
    host.answer({ decision: "approve" });
    await pending;
    const loadsAfter = loads;
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(loads).toBe(loadsAfter);
  });
});

describe("D-21: drift, user denial and timeout", () => {
  it("reports a drift denial through reportVoided with approval_drifted", async () => {
    const bindings = createBindingSet([SEND, READ]);
    const host = deferredAdapter(() => {
      (bindings as unknown as Record<string, ConnectorBinding>)[SEND.tool] = {
        ...SEND,
        provenance: "user_approved_custom",
      };
    });
    const rig = await buildRig("lease-drift-void", createApprovalDispatcher(host.adapter, 30, () => NOW), { bindings });

    const pending = handleCall(rig.deps, sendCall, NOW);
    await host.requested;
    await new Promise((resolve) => setTimeout(resolve, 0));
    host.answer({ decision: "approve" });
    const result = await pending;

    expect(text(result)).toBe("denied: approval_drifted");
    expect(await summaries(rig)).toEqual(['call to "send_message" denied after approval: approval_drifted']);
    expect(host.events).toEqual([
      { type: "approval_void", leaseId: "lease-drift-void", at: NOW, reason: "approval_drifted" },
    ]);
  });

  it("a user denial is a plain denied receipt, not 'after approval'", async () => {
    const host = deferredAdapter();
    const rig = await buildRig("lease-user-denied", createApprovalDispatcher(host.adapter, 30, () => NOW));

    const pending = handleCall(rig.deps, sendCall, NOW);
    await host.requested;
    host.answer({ decision: "deny", reason: "user_denied" });
    const result = await pending;

    expect(text(result)).toBe("denied: user_denied");
    expect(await summaries(rig)).toEqual(['call to "send_message" denied: user_denied']);
    expect(host.events).toEqual([]);
  });

  it("a timeout is a plain denied receipt, not 'after approval'", async () => {
    const host = deferredAdapter();
    const rig = await buildRig("lease-timeout-plain", createApprovalDispatcher(host.adapter, 0.05, () => NOW));

    const result = await handleCall(rig.deps, sendCall, NOW);

    expect(text(result)).toBe("denied: timeout");
    expect(await summaries(rig)).toEqual(['call to "send_message" denied: timeout']);
  });

  it("calls reportVoided once per post-approval denial and survives its failure", async () => {
    const host = deferredAdapter();
    const inner = createApprovalDispatcher(host.adapter, 30, () => NOW);
    const reports: string[] = [];
    const stage: ApprovalStage = {
      requestApproval: (ctx, requirement, now, opts) => inner.requestApproval(ctx, requirement, now, opts),
      verifyCommitment: (id, hash) => inner.verifyCommitment(id, hash),
      reportVoided(_ctx, reason) {
        reports.push(reason);
        return Promise.reject(new Error("notify failed"));
      },
    };
    const rig = await buildRig("lease-report-fails", stage);

    const pending = handleCall(rig.deps, sendCall, NOW);
    await host.requested;
    rig.clock.now = EXPIRES_AT;
    host.answer({ decision: "approve" });
    const result = await pending;

    expect(text(result)).toBe("denied: expired");
    expect(reports).toEqual(["expired_after_approval"]);
    expect((await summaries(rig)).length).toBe(1);
  });
});

describe("commitment release", () => {
  it("releases the pending commitment when the second transaction cannot run", async () => {
    const host = deferredAdapter();
    const inner = createApprovalDispatcher(host.adapter, 30, () => NOW);
    let approvalId: string | undefined;
    const stage: ApprovalStage = {
      async requestApproval(ctx, requirement, now, opts) {
        const decision = await inner.requestApproval(ctx, requirement, now, opts);
        approvalId = decision.approvalId;
        return decision;
      },
      verifyCommitment: (id, hash) => inner.verifyCommitment(id, hash),
      release: (id) => inner.release?.(id),
    };
    const base = createInMemoryLeaseStore();
    let transactions = 0;
    const flaky: LeaseStore = {
      ...base,
      transaction(id, mutate) {
        transactions += 1;
        if (transactions === 2) return Promise.reject(new Error("store unavailable"));
        return base.transaction(id, mutate);
      },
    };
    const rig = await buildRig("lease-release", stage, { leaseStore: flaky });

    const pending = handleCall(rig.deps, sendCall, NOW);
    await host.requested;
    host.answer({ decision: "approve" });
    await expect(pending).rejects.toThrow("store unavailable");

    expect(approvalId).toBeDefined();
    const ctx: CallContext = {
      leaseId: "lease-release",
      tool: SEND.tool,
      resolvedArgs: { to: "alice" },
      binding: SEND,
      leaseVersion: 0,
    };
    const hash = computeApprovalHash(ctx.resolvedArgs, ctx.binding, ctx.leaseVersion);
    expect(inner.verifyCommitment(approvalId ?? "", hash)).toBe(false);
    expect(rig.execute.calls()).toBe(0);
  });
});

describe("pending approval cap", () => {
  it("denies the 21st concurrent approval approval_queue_full without asking the adapter", async () => {
    let asked = 0;
    const adapter: HostAdapter = {
      requestConsent: () => Promise.reject(new Error("n/a")),
      requestApproval() {
        asked += 1;
        return new Promise<HostApprovalDecision>(() => undefined);
      },
      requestOutcomeConfirmation: () => Promise.reject(new Error("n/a")),
      notify: () => Promise.resolve(),
    };
    const dispatcher = createApprovalDispatcher(adapter, 30, () => NOW);
    const ctx: CallContext = {
      leaseId: "lease-cap",
      tool: SEND.tool,
      resolvedArgs: { to: "alice" },
      binding: SEND,
      leaseVersion: 0,
    };
    const requirement = { trigger: "send", binding: SEND } as const;
    const stop = new AbortController();

    const held = Array.from({ length: 20 }, () =>
      dispatcher.requestApproval(ctx, requirement, NOW, { signal: stop.signal }),
    );
    const overflow = await dispatcher.requestApproval(ctx, requirement, NOW);

    expect(overflow).toEqual({ decision: "deny", reason: "approval_queue_full" });
    expect(asked).toBe(20);

    stop.abort(createLeaseEndedReason());
    const settled = await Promise.all(held);
    expect(settled.every((decision) => decision.decision === "deny")).toBe(true);

    // Capacity is returned once the waiting requests settle: this one is admitted
    // (not queue-full), and core denies it at once because its signal is already aborted.
    const next = await dispatcher.requestApproval(ctx, requirement, NOW, { signal: stop.signal });
    expect(next).toEqual({ decision: "deny", reason: "lease_ended" });
  });

  it("honours a smaller maxPending", async () => {
    const adapter: HostAdapter = {
      requestConsent: () => Promise.reject(new Error("n/a")),
      requestApproval: () => new Promise<HostApprovalDecision>(() => undefined),
      requestOutcomeConfirmation: () => Promise.reject(new Error("n/a")),
      notify: () => Promise.resolve(),
    };
    const dispatcher = createApprovalDispatcher(adapter, 30, () => NOW, { maxPending: 1 });
    const ctx: CallContext = {
      leaseId: "lease-cap-1",
      tool: SEND.tool,
      resolvedArgs: {},
      binding: SEND,
      leaseVersion: 0,
    };
    const requirement = { trigger: "send", binding: SEND } as const;
    const stop = new AbortController();

    const first = dispatcher.requestApproval(ctx, requirement, NOW, { signal: stop.signal });
    const second = await dispatcher.requestApproval(ctx, requirement, NOW);
    stop.abort();
    await first;

    expect(second).toEqual({ decision: "deny", reason: "approval_queue_full" });
  });
});

describe("telemetry", () => {
  it("emits one call.decided per call, with the tool or the fixed string unknown and a fixed reason code", async () => {
    const host = deferredAdapter();
    const sink = recordingTelemetry();
    const rig = await buildRig("lease-telemetry", createApprovalDispatcher(host.adapter, 30, () => NOW), {
      telemetry: sink.telemetry,
    });

    await handleCall(rig.deps, readCall, NOW);
    await handleCall(rig.deps, { name: "not_a_tool", arguments: { secret: "shh" } }, NOW);
    const pending = handleCall(rig.deps, sendCall, NOW);
    await host.requested;
    rig.clock.now = EXPIRES_AT;
    host.answer({ decision: "approve" });
    await pending;

    expect(sink.events).toEqual([
      { name: "call.decided", leaseId: "lease-telemetry", tool: "read_inbox", outcome: "allowed" },
      { name: "call.decided", leaseId: "lease-telemetry", tool: "unknown", outcome: "denied", reason: "no_binding" },
      { name: "call.decided", leaseId: "lease-telemetry", tool: "send_message", outcome: "denied", reason: "expired" },
    ]);
    expect(JSON.stringify(sink.events)).not.toContain("shh");
  });
});
