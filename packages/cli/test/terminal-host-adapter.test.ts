import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  awaitApprovalDecision,
  awaitConsentDecision,
  awaitOutcomeConfirmDecision,
} from "@stint/core";
import type { ApprovalRequest, ConsentRequest, OutcomeConfirmRequest } from "@stint/core";
import { verifyEnvelope } from "@stint/spec";
import type { Manifest, VerifiedManifest } from "@stint/spec";
import { signManifestForTest } from "@stint/spec/testing";

import { renderConsent } from "../src/adapter/consent-view.js";
import { askLine } from "../src/adapter/prompt.js";
import {
  NoAnswerError,
  NoTerminalError,
  createTerminalHostAdapter,
} from "../src/adapter/terminal-host-adapter.js";
import { createStyle } from "../src/render/style.js";

const ESC = "\u001b";

function baseManifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    spec_version: "alp/0.1",
    agent: { id: "recon-agent", name: "Recon Agent", description: "Reconciles orders." },
    publisher: { id: "acme.example", name: "Acme" },
    version: "1.2.3",
    job: {
      description: "Reconcile the order sheet.",
      verifier: { type: "user_confirm", prompt: "Did it reconcile?" },
    },
    scopes: [
      { resource: "sheets.orders", access: ["read", "write"] },
      { resource: "mail.outbox", access: ["send"] },
    ],
    lease: { max_duration_seconds: 3600 },
    limits: {
      max_actions: 25,
      actions_per_hour: 10,
      spend: { amount_minor: 5000, currency: "USD" },
      error_threshold: { count: 3, window_seconds: 60 },
    },
    approvals: { require_for: ["send", "pay"], timeout_seconds: 45 },
    auth: { mode: "hosted", hosted: { license_issuer: "acme.example", kid: "k1" } },
    cleanup: { hook: { url: "https://acme.example/alp/cleanup" }, publisher_retains: "aggregates" },
    ...overrides,
  };
}

async function verified(manifest: Manifest): Promise<VerifiedManifest> {
  const { envelope, trustStore } = await signManifestForTest(manifest);
  const result = await verifyEnvelope(envelope, trustStore);
  if (!result.ok) throw new Error(`fixture failed verification: ${JSON.stringify(result.errors)}`);
  return result.value;
}

const approvalRequest: ApprovalRequest = {
  approvalId: "a-1",
  summary: "Append a row to sheets.orders",
  binding: {
    tool: "sheets.append_row",
    resource: "sheets.orders",
    access: "write",
    irreversible: false,
    provenance: "built_in",
  },
};
const outcomeRequest: OutcomeConfirmRequest = { leaseId: "lease-1", prompt: "Did the job finish?" };

interface Rig {
  readonly input: PassThrough & { isTTY?: boolean };
  readonly output: PassThrough;
  readonly outText: () => string;
  readonly errText: () => string;
  readonly adapter: ReturnType<typeof createTerminalHostAdapter>;
  readonly waitFor: (text: string) => Promise<void>;
}

function rig(opts: { tty?: boolean } = {}): Rig {
  const input = Object.assign(new PassThrough(), { isTTY: opts.tty ?? true });
  const output = new PassThrough();
  const errorOutput = new PassThrough();
  let out = "";
  let err = "";
  output.on("data", (chunk: Buffer) => {
    out += chunk.toString();
  });
  errorOutput.on("data", (chunk: Buffer) => {
    err += chunk.toString();
  });
  const adapter = createTerminalHostAdapter({
    input,
    output,
    errorOutput,
    approvalTimeoutSeconds: 45,
    consentTimeoutSeconds: 120,
    clock: () => 1_000,
    terminal: false,
  });
  const waitFor = async (text: string): Promise<void> => {
    for (let i = 0; i < 200 && !out.includes(text); i++) await new Promise((r) => setTimeout(r, 5));
    if (!out.includes(text)) throw new Error(`prompt "${text}" never appeared; output: ${out}`);
  };
  return { input, output, outText: () => out, errText: () => err, adapter, waitFor };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createTerminalHostAdapter shape", () => {
  it("has exactly the four HostAdapter methods", () => {
    const { adapter } = rig();
    expect(Object.keys(adapter).sort()).toEqual(
      ["notify", "requestApproval", "requestConsent", "requestOutcomeConfirmation"].sort(),
    );
  });
});

describe("requestApproval", () => {
  it.each(["y", "yes", "YES", " Y "])("approves on %j", async (answer) => {
    const r = rig();
    const p = r.adapter.requestApproval(approvalRequest, new AbortController().signal);
    await r.waitFor("Approve this action?");
    r.input.write(`${answer}\n`);
    await expect(p).resolves.toEqual({ decision: "approve" });
  });

  it.each(["n", "no", "", "maybe", "yy"])("denies user_denied on %j", async (answer) => {
    const r = rig();
    const p = r.adapter.requestApproval(approvalRequest, new AbortController().signal);
    await r.waitFor("Approve this action?");
    r.input.write(`${answer}\n`);
    await expect(p).resolves.toEqual({ decision: "deny", reason: "user_denied" });
  });

  it("rejects (never approves) when the signal aborts mid-wait, and core folds it to deny/timeout", async () => {
    const r = rig();
    const ac = new AbortController();
    const p = r.adapter.requestApproval(approvalRequest, ac.signal);
    const settled = p.then(
      (d) => d,
      (e: unknown) => e,
    );
    await r.waitFor("Approve this action?");
    ac.abort();
    const outcome = await settled;
    expect(outcome).toBeInstanceOf(NoAnswerError);
    expect((outcome as Error).name).toBe("AbortError");
  });

  it("core folds an abort to deny/timeout", async () => {
    const r = rig();
    const ac = new AbortController();
    const folded = awaitApprovalDecision(r.adapter, approvalRequest, ac.signal);
    await r.waitFor("Approve this action?");
    ac.abort();
    await expect(folded).resolves.toEqual({ decision: "deny", reason: "timeout" });
  });

  it("rejects immediately, without prompting, when the signal is already aborted", async () => {
    const r = rig();
    const ac = new AbortController();
    ac.abort();
    await expect(r.adapter.requestApproval(approvalRequest, ac.signal)).rejects.toBeInstanceOf(
      NoAnswerError,
    );
    expect(r.outText()).toBe("");
    await expect(awaitApprovalDecision(r.adapter, approvalRequest, ac.signal)).resolves.toEqual({
      decision: "deny",
      reason: "timeout",
    });
  });

  it("settles without approving when input reaches EOF (never hangs)", async () => {
    const r = rig();
    const p = r.adapter.requestApproval(approvalRequest, new AbortController().signal);
    const settled = p.then(
      (d) => d,
      (e: unknown) => e,
    );
    await r.waitFor("Approve this action?");
    r.input.end();
    const outcome = await settled;
    expect(outcome).toBeInstanceOf(NoAnswerError);
    expect(outcome).not.toEqual({ decision: "approve" });
  });

  it("rejects with NoTerminalError and prints one stderr line when input is not a TTY", async () => {
    const r = rig({ tty: false });
    await expect(
      r.adapter.requestApproval(approvalRequest, new AbortController().signal),
    ).rejects.toBeInstanceOf(NoTerminalError);
    expect(r.errText().trim().split("\n")).toHaveLength(1);
    expect(r.outText()).toBe("");
  });

  it("shows only the binding-redacted summary and binding, sanitized", async () => {
    const r = rig();
    const hostile: ApprovalRequest = { ...approvalRequest, summary: `Pay${ESC}[2J\rEVIL` };
    const p = r.adapter.requestApproval(hostile, new AbortController().signal);
    await r.waitFor("Approve this action?");
    r.input.write("n\n");
    await p;
    expect(r.outText()).not.toContain(ESC);
    expect(r.outText()).not.toContain("\r");
    expect(r.outText()).toContain("sheets.append_row");
  });
});

describe("requestOutcomeConfirmation", () => {
  it("confirms on y, rejects user_rejected on anything else", async () => {
    const a = rig();
    const pa = a.adapter.requestOutcomeConfirmation(outcomeRequest, new AbortController().signal);
    await a.waitFor("Did this happen?");
    a.input.write("y\n");
    await expect(pa).resolves.toEqual({ decision: "confirm" });

    const b = rig();
    const pb = b.adapter.requestOutcomeConfirmation(outcomeRequest, new AbortController().signal);
    await b.waitFor("Did this happen?");
    b.input.write("\n");
    await expect(pb).resolves.toEqual({ decision: "reject", reason: "user_rejected" });
  });

  it("rejects on non-TTY and on EOF, never confirming", async () => {
    const noTty = rig({ tty: false });
    await expect(
      noTty.adapter.requestOutcomeConfirmation(outcomeRequest, new AbortController().signal),
    ).rejects.toBeInstanceOf(NoTerminalError);

    const eof = rig();
    const p = eof.adapter.requestOutcomeConfirmation(outcomeRequest, new AbortController().signal);
    const settled = p.then(
      (d) => d,
      (e: unknown) => e,
    );
    await eof.waitFor("Did this happen?");
    eof.input.end();
    expect(await settled).toBeInstanceOf(NoAnswerError);
  });

  it("core folds an abort to reject/timeout", async () => {
    const r = rig();
    const ac = new AbortController();
    const folded = awaitOutcomeConfirmDecision(r.adapter, outcomeRequest, ac.signal);
    await r.waitFor("Did this happen?");
    ac.abort();
    await expect(folded).resolves.toEqual({ decision: "reject", reason: "timeout" });
  });
});

describe("requestConsent", () => {
  async function consent(): Promise<ConsentRequest> {
    return { consentId: "c-1", manifest: await verified(baseManifest()) };
  }

  it("grants on y and yes; declines user_declined on anything else", async () => {
    for (const answer of ["y", "yes"]) {
      const r = rig();
      const p = r.adapter.requestConsent(await consent(), new AbortController().signal);
      await r.waitFor("Grant this lease? [y/N]");
      r.input.write(`${answer}\n`);
      await expect(p).resolves.toEqual({ decision: "grant" });
    }
    for (const answer of ["", "n", "sure"]) {
      const r = rig();
      const p = r.adapter.requestConsent(await consent(), new AbortController().signal);
      await r.waitFor("Grant this lease? [y/N]");
      r.input.write(`${answer}\n`);
      await expect(p).resolves.toEqual({ decision: "decline", reason: "user_declined" });
    }
  });

  it("rejects on non-TTY, on EOF, and folds an abort to decline/timeout", async () => {
    const noTty = rig({ tty: false });
    await expect(
      noTty.adapter.requestConsent(await consent(), new AbortController().signal),
    ).rejects.toBeInstanceOf(NoTerminalError);

    const eof = rig();
    const p = eof.adapter.requestConsent(await consent(), new AbortController().signal);
    const settled = p.then(
      (d) => d,
      (e: unknown) => e,
    );
    await eof.waitFor("Grant this lease? [y/N]");
    eof.input.end();
    expect(await settled).toBeInstanceOf(NoAnswerError);

    const r = rig();
    const ac = new AbortController();
    const folded = awaitConsentDecision(r.adapter, await consent(), ac.signal);
    await r.waitFor("Grant this lease? [y/N]");
    ac.abort();
    await expect(folded).resolves.toEqual({ decision: "decline", reason: "timeout" });
  });

  it("prints the consent summary before prompting", async () => {
    const r = rig();
    const p = r.adapter.requestConsent(await consent(), new AbortController().signal);
    await r.waitFor("Grant this lease? [y/N]");
    r.input.write("n\n");
    await p;
    expect(r.outText()).toContain("Recon Agent");
    expect(r.outText()).toContain("sheets.orders");
  });
});

describe("notify", () => {
  it("prints a one-line lifecycle message and resolves", async () => {
    const r = rig();
    await expect(
      r.adapter.notify({ type: "revoked", leaseId: "lease-9", at: 1_800_000_000 }),
    ).resolves.toBeUndefined();
    const lines = r.outText().trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("lease-9");
    expect(lines[0]).toContain("revoked");
  });

  it("never throws, even for a broken output stream or a non-finite timestamp", async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true });
    const broken = new PassThrough();
    broken.write = () => {
      throw new Error("boom");
    };
    const adapter = createTerminalHostAdapter({
      input,
      output: broken,
      approvalTimeoutSeconds: 1,
      clock: () => 0,
    });
    await expect(
      adapter.notify({ type: "failed", leaseId: "l", at: Number.NaN }),
    ).resolves.toBeUndefined();
  });
});

describe("renderConsent", () => {
  it("includes every ALP section 6 field and no ANSI escapes when style is disabled", () => {
    const text = renderConsent(baseManifest(), createStyle(false));
    expect(text).not.toContain(ESC);
    expect(text).toContain("Recon Agent");
    expect(text).toContain("recon-agent");
    expect(text).toContain("Acme");
    expect(text).toContain("acme.example");
    expect(text).toContain("sheets.orders: read, write");
    expect(text).toContain("mail.outbox: send");
    expect(text).toContain("5000 minor units of USD");
    expect(text).toContain("send, pay");
    expect(text).toContain("45s");
    expect(text).toContain("auth mode: hosted");
    expect(text).toContain("verifier: user_confirm");
    expect(text).toContain("https://acme.example/alp/cleanup");
    expect(text).toMatch(
      /publisher retains: aggregates .*attested publisher claim, not runtime-verified/,
    );
  });

  it("resolves an omitted auth.mode to hybrid", () => {
    const m = baseManifest({
      auth: { delegated: [{ provider: "sheets.example", resources: ["sheets.orders"] }] },
    });
    expect(renderConsent(m, createStyle(false))).toContain("auth mode: hybrid");
  });

  it("states that no cleanup is declared when cleanup is null, without an attested line", () => {
    const text = renderConsent(baseManifest({ cleanup: null }), createStyle(false));
    expect(text).toContain("no publisher cleanup declared");
    expect(text).not.toContain("attested");
  });

  it("sanitizes manifest-derived strings (no ESC, CR or bidi reaches the output)", () => {
    const hostile = baseManifest({
      agent: { id: "recon-agent", name: `Evil${ESC}[2J\rAgent‮`, description: "x\ny" },
      job: { description: `job${ESC}[31m`, verifier: { type: "user_confirm", prompt: "p\rq" } },
    });
    const text = renderConsent(hostile, createStyle(false));
    expect(text).not.toContain(ESC);
    expect(text).not.toContain("\r");
    expect(text).not.toContain("‮");
  });

  it("colours headers only when the style is enabled", () => {
    expect(renderConsent(baseManifest(), createStyle(true))).toContain(ESC);
  });
});

describe("askLine countdown (display only)", () => {
  it("redraws the remaining time on a terminal and never answers by itself", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const input = Object.assign(new PassThrough(), { isTTY: true });
    const output = new PassThrough();
    let out = "";
    output.on("data", (c: Buffer) => {
      out += c.toString();
    });
    let remaining = 3;
    const ac = new AbortController();
    const p = askLine(input, output, "Q? ", ac.signal, {
      terminal: true,
      countdown: { remaining: () => remaining },
    });
    expect(out).toContain("Q? (3s)");
    remaining = 2;
    await vi.advanceTimersByTimeAsync(1000);
    expect(out).toContain("(2s)");
    remaining = 0;
    await vi.advanceTimersByTimeAsync(3000);
    // The timer expiring on screen resolves nothing: only abort/answer/EOF settle the prompt.
    let settled = false;
    void p.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    ac.abort();
    await expect(p).resolves.toBeUndefined();
    const before = out;
    await vi.advanceTimersByTimeAsync(5000);
    expect(out).toBe(before);
  });
});
