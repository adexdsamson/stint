import { describe, expect, it } from "vitest";

import {
  LEASE_ENDED_REASON,
  awaitApprovalDecision,
  createLeaseEndedReason,
  isLeaseEndedSignal,
} from "../src/host-adapter.js";
import type { ApprovalDecision, ApprovalRequest, HostAdapter, LifecycleEvent } from "../src/host-adapter.js";
import type { ConnectorBinding } from "../src/bindings.js";

const binding: ConnectorBinding = {
  tool: "sheets.append_row",
  resource: "sheets.orders",
  access: "write",
  irreversible: false,
  provenance: "built_in",
};

function approvalRequest(): ApprovalRequest {
  return { approvalId: "approval-1", summary: "Append a row to sheets.orders", binding };
}

function adapterWith(requestApproval: HostAdapter["requestApproval"]): HostAdapter {
  return {
    requestConsent: () => Promise.reject(new Error("not stubbed")),
    requestApproval,
    requestOutcomeConfirmation: () => Promise.reject(new Error("not stubbed")),
    notify: () => Promise.resolve(),
  };
}

describe("createLeaseEndedReason", () => {
  it("builds an Error whose name is the lease-ended reason name", () => {
    const reason = createLeaseEndedReason();
    expect(reason).toBeInstanceOf(Error);
    expect(reason.name).toBe(LEASE_ENDED_REASON);
  });
});

describe("isLeaseEndedSignal", () => {
  it("is false for an un-aborted signal", () => {
    expect(isLeaseEndedSignal(new AbortController().signal)).toBe(false);
  });

  it("is false for a signal aborted with no explicit reason", () => {
    const controller = new AbortController();
    controller.abort();
    expect(isLeaseEndedSignal(controller.signal)).toBe(false);
  });

  it("is false for a signal aborted with another reason", () => {
    const controller = new AbortController();
    controller.abort(new Error("something else"));
    expect(isLeaseEndedSignal(controller.signal)).toBe(false);
    const stringy = new AbortController();
    stringy.abort("LeaseEndedError");
    expect(isLeaseEndedSignal(stringy.signal)).toBe(false);
  });

  it("is true for a signal aborted with the lease-ended reason", () => {
    const controller = new AbortController();
    controller.abort(createLeaseEndedReason());
    expect(isLeaseEndedSignal(controller.signal)).toBe(true);
  });

  it("is true through AbortSignal.any when one source carries the lease-ended reason (A8)", () => {
    const timeout = new AbortController();
    const leaseEnded = new AbortController();
    const merged = AbortSignal.any([timeout.signal, leaseEnded.signal]);
    expect(isLeaseEndedSignal(merged)).toBe(false);
    leaseEnded.abort(createLeaseEndedReason());
    expect(merged.aborted).toBe(true);
    expect(isLeaseEndedSignal(merged)).toBe(true);
  });

  it("is false through AbortSignal.any when the timeout source aborts first", () => {
    const timeout = new AbortController();
    const leaseEnded = new AbortController();
    const merged = AbortSignal.any([timeout.signal, leaseEnded.signal]);
    timeout.abort(new Error("timeout"));
    leaseEnded.abort(createLeaseEndedReason());
    expect(isLeaseEndedSignal(merged)).toBe(false);
  });
});

describe("awaitApprovalDecision with a lease-ended abort", () => {
  it("resolves deny/lease_ended when the signal is already aborted with the reason", async () => {
    const controller = new AbortController();
    controller.abort(createLeaseEndedReason());
    const adapter = adapterWith(() => new Promise<ApprovalDecision>(() => {}));

    const decision = await awaitApprovalDecision(adapter, approvalRequest(), controller.signal);

    expect(decision).toEqual({ decision: "deny", reason: "lease_ended" });
  });

  it("resolves deny/lease_ended when the abort arrives during the adapter call", async () => {
    const controller = new AbortController();
    const adapter = adapterWith(() => new Promise<ApprovalDecision>(() => {}));

    const pending = awaitApprovalDecision(adapter, approvalRequest(), controller.signal);
    controller.abort(createLeaseEndedReason());

    expect(await pending).toEqual({ decision: "deny", reason: "lease_ended" });
  });

  it("resolves deny/lease_ended for a merged signal", async () => {
    const timeout = new AbortController();
    const leaseEnded = new AbortController();
    const adapter = adapterWith(() => new Promise<ApprovalDecision>(() => {}));

    const pending = awaitApprovalDecision(
      adapter,
      approvalRequest(),
      AbortSignal.any([timeout.signal, leaseEnded.signal]),
    );
    leaseEnded.abort(createLeaseEndedReason());

    expect(await pending).toEqual({ decision: "deny", reason: "lease_ended" });
  });

  it("still resolves deny/timeout for any other abort", async () => {
    const controller = new AbortController();
    const adapter = adapterWith(() => new Promise<ApprovalDecision>(() => {}));

    const pending = awaitApprovalDecision(adapter, approvalRequest(), controller.signal);
    controller.abort(new Error("timed out"));

    expect(await pending).toEqual({ decision: "deny", reason: "timeout" });
  });

  it("still resolves deny/timeout for a rejecting adapter", async () => {
    const controller = new AbortController();
    const adapter = adapterWith(() => Promise.reject(new Error("adapter blew up")));

    const decision = await awaitApprovalDecision(adapter, approvalRequest(), controller.signal);

    expect(decision).toEqual({ decision: "deny", reason: "timeout" });
  });

  it("ignores a late adapter approve after a lease-ended abort", async () => {
    const controller = new AbortController();
    let approveLate: (decision: ApprovalDecision) => void = () => {};
    const adapter = adapterWith(
      () =>
        new Promise<ApprovalDecision>((resolve) => {
          approveLate = resolve;
        }),
    );

    const pending = awaitApprovalDecision(adapter, approvalRequest(), controller.signal);
    controller.abort(createLeaseEndedReason());
    approveLate({ decision: "approve" });

    expect(await pending).toEqual({ decision: "deny", reason: "lease_ended" });
  });
});

describe("approval_void lifecycle event", () => {
  it("is a member of LifecycleEvent and carries a fixed reason code", () => {
    const event: LifecycleEvent = {
      type: "approval_void",
      leaseId: "lease-1",
      at: 1,
      reason: "expired_after_approval",
    };
    expect(event.type).toBe("approval_void");
  });
});
