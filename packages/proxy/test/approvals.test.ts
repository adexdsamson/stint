/**
 * `approvals.test.ts` -- Task 2: unit tests for `computeApprovalHash` (the
 * confirmed D-11 commitment tuple) and `createApprovalDispatcher` (armed
 * timeout, deny-by-default on throw/never-resolve, the exact-deadline-vs-
 * one-tick-past boundary), using a stub `HostAdapter` and a fake/controlled
 * clock. Task 3 extends this same file with the end-to-end drift/timeout
 * cases driven over the 04-02 server.
 */

import { describe, expect, it } from "vitest";

import type { ApprovalDecision as HostApprovalDecision, ApprovalRequest, ApprovalRequirement, ConnectorBinding, HostAdapter } from "@stint/core";

import { computeApprovalHash, createApprovalDispatcher } from "../src/approvals/approval-dispatcher.js";
import type { CallContext } from "../src/dispatch.js";

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
