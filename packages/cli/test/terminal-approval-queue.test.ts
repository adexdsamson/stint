/**
 * The terminal adapter shows one prompt at a time, in arrival order (D-18); a
 * queued request's countdown runs from the moment it was requested, a prompt
 * on screen is cancelled with a fixed line when the lease ends (D-20), and an
 * approval that did not take effect is announced with a fixed sentence (D-21).
 * The terminal is a PassThrough pair in terminal mode, nothing spawns.
 */

import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { awaitApprovalDecision, createLeaseEndedReason } from "@stint/core";
import type { ApprovalRequest, ApprovalVoidReason, OutcomeConfirmRequest } from "@stint/core";

import {
  LEASE_ENDED_PROMPT_LINE,
  NoAnswerError,
  createTerminalHostAdapter,
} from "../src/adapter/terminal-host-adapter.js";

function approval(summary: string): ApprovalRequest {
  return {
    approvalId: `id-${summary}`,
    summary,
    binding: {
      tool: "send_notice",
      resource: "sheets.orders",
      access: "send",
      irreversible: false,
      provenance: "built_in",
    },
  };
}

const outcomeRequest: OutcomeConfirmRequest = { leaseId: "lease-1", prompt: "outcome-question" };

interface Rig {
  readonly input: PassThrough & { isTTY?: boolean };
  readonly adapter: ReturnType<typeof createTerminalHostAdapter>;
  readonly outText: () => string;
  readonly clock: { now: number };
  readonly waitFor: (text: string) => Promise<void>;
  readonly settleTicks: () => Promise<void>;
}

function rig(): Rig {
  const input = Object.assign(new PassThrough(), { isTTY: true });
  const output = new PassThrough();
  let out = "";
  output.on("data", (chunk: Buffer) => {
    out += chunk.toString();
  });
  const clock = { now: 1_000 };
  const adapter = createTerminalHostAdapter({
    input,
    output,
    errorOutput: new PassThrough(),
    approvalTimeoutSeconds: 45,
    clock: () => clock.now,
    terminal: true,
  });
  const waitFor = async (text: string): Promise<void> => {
    for (let i = 0; i < 400 && !out.includes(text); i++) await new Promise((r) => setTimeout(r, 5));
    if (!out.includes(text)) throw new Error(`"${text}" never appeared; output: ${out}`);
  };
  const settleTicks = async (): Promise<void> => {
    await new Promise((r) => setTimeout(r, 60));
  };
  return { input, adapter, outText: () => out, clock, waitFor, settleTicks };
}

describe("terminal approval queue (D-18)", () => {
  it("shows prompts one at a time, in arrival order", async () => {
    const r = rig();
    const first = r.adapter.requestApproval(approval("first-call"), new AbortController().signal);
    const second = r.adapter.requestApproval(approval("second-call"), new AbortController().signal);

    await r.waitFor("first-call");
    await r.settleTicks();
    expect(r.outText()).not.toContain("second-call");

    r.input.write("y\n");
    await expect(first).resolves.toEqual({ decision: "approve" });

    await r.waitFor("second-call");
    expect(r.outText().indexOf("first-call")).toBeLessThan(r.outText().indexOf("second-call"));
    r.input.write("n\n");
    await expect(second).resolves.toEqual({ decision: "deny", reason: "user_denied" });
  });

  it("starts the countdown of a queued prompt from the time it was requested, not shown", async () => {
    const r = rig();
    const first = r.adapter.requestApproval(approval("first-call"), new AbortController().signal);
    const second = r.adapter.requestApproval(approval("second-call"), new AbortController().signal);
    await r.waitFor("first-call");

    // 40 of the second request's 45 seconds pass while it waits behind the first.
    r.clock.now = 1_040;
    r.input.write("y\n");
    await first;
    await r.waitFor("second-call");
    await r.settleTicks();

    const shownSecond = r.outText().slice(r.outText().indexOf("second-call"));
    expect(shownSecond).toContain("Approve this action? [y/N] (5s)");
    expect(shownSecond).not.toContain("(45s)");

    r.input.write("n\n");
    await second;
  });

  it("never shows a queued request whose signal aborts before its turn, and does not stall the queue", async () => {
    const r = rig();
    const first = r.adapter.requestApproval(approval("first-call"), new AbortController().signal);
    const queuedAbort = new AbortController();
    const queued = r.adapter.requestApproval(approval("queued-call"), queuedAbort.signal);
    const third = r.adapter.requestApproval(approval("third-call"), new AbortController().signal);
    await r.waitFor("first-call");

    queuedAbort.abort();
    await expect(queued).rejects.toBeInstanceOf(NoAnswerError);

    r.input.write("y\n");
    await first;
    await r.waitFor("third-call");
    expect(r.outText()).not.toContain("queued-call");

    r.input.write("y\n");
    await expect(third).resolves.toEqual({ decision: "approve" });
  });

  it("never has a consent-style prompt and an approval prompt on screen together", async () => {
    const r = rig();
    const outcome = r.adapter.requestOutcomeConfirmation(outcomeRequest, new AbortController().signal);
    const approvalPending = r.adapter.requestApproval(
      approval("approval-call"),
      new AbortController().signal,
    );

    await r.waitFor("outcome-question");
    await r.settleTicks();
    expect(r.outText()).not.toContain("approval-call");

    r.input.write("y\n");
    await expect(outcome).resolves.toEqual({ decision: "confirm" });
    await r.waitFor("approval-call");
    r.input.write("y\n");
    await expect(approvalPending).resolves.toEqual({ decision: "approve" });
  });
});

describe("lease-ended cancel line (D-20)", () => {
  it("prints the fixed line and rejects when the prompt on screen is cancelled by the lease ending", async () => {
    const r = rig();
    const ac = new AbortController();
    const pending = r.adapter.requestApproval(approval("first-call"), ac.signal);
    const settled = pending.then(
      (decision) => decision,
      (error: unknown) => error,
    );
    await r.waitFor("first-call");

    ac.abort(createLeaseEndedReason());

    expect(await settled).toBeInstanceOf(NoAnswerError);
    expect(r.outText()).toContain("Lease ended, approval no longer needed.");
    expect(LEASE_ENDED_PROMPT_LINE).toBe("Lease ended, approval no longer needed.");
  });

  it("folds to deny lease_ended through core", async () => {
    const r = rig();
    const ac = new AbortController();
    const folded = awaitApprovalDecision(r.adapter, approval("first-call"), ac.signal);
    await r.waitFor("first-call");

    ac.abort(createLeaseEndedReason());

    await expect(folded).resolves.toEqual({ decision: "deny", reason: "lease_ended" });
  });

  it("prints nothing new for an ordinary abort", async () => {
    const r = rig();
    const ac = new AbortController();
    const pending = r.adapter.requestApproval(approval("first-call"), ac.signal);
    const settled = pending.then(
      (decision) => decision,
      (error: unknown) => error,
    );
    await r.waitFor("first-call");

    ac.abort();
    await settled;

    expect(r.outText()).not.toContain("Lease ended");
  });

  it("does not print the line for a queued request cancelled before it was ever shown", async () => {
    const r = rig();
    const first = r.adapter.requestApproval(approval("first-call"), new AbortController().signal);
    const queuedAbort = new AbortController();
    const queued = r.adapter.requestApproval(approval("queued-call"), queuedAbort.signal);
    await r.waitFor("first-call");

    queuedAbort.abort(createLeaseEndedReason());
    await expect(queued).rejects.toBeInstanceOf(NoAnswerError);
    expect(r.outText()).not.toContain("Lease ended");

    r.input.write("y\n");
    await first;
  });
});

describe("approval_void notice (D-21)", () => {
  const cases: ReadonlyArray<readonly [ApprovalVoidReason, string]> = [
    [
      "expired_after_approval",
      "Your approval did not take effect: the lease expired before the action could run.",
    ],
    [
      "lease_ended_after_approval",
      "Your approval did not take effect: the lease ended before the action could run.",
    ],
    [
      "limit_reached_after_approval",
      "Your approval did not take effect: a lease limit was reached before the action could run.",
    ],
    [
      "approval_drifted",
      "Your approval did not take effect: the request changed after you approved it.",
    ],
  ];

  it.each(cases)("prints one fixed line for %s", async (reason, sentence) => {
    const r = rig();

    await r.adapter.notify({ type: "approval_void", leaseId: "lease-1", at: 1_000, reason });

    expect(r.outText()).toBe(`${sentence}\n`);
  });

  it("keeps the one-line form for the other lifecycle events", async () => {
    const r = rig();

    await r.adapter.notify({ type: "revoked", leaseId: "lease-1", at: 1_000 });

    expect(r.outText()).toContain("lease lease-1 revoked");
  });
});
