import { isLeaseEndedSignal } from "@stint/core";
import type {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalVoidReason,
  ConsentDecision,
  ConsentRequest,
  HostAdapter,
  LifecycleEvent,
  OutcomeConfirmDecision,
  OutcomeConfirmRequest,
} from "@stint/core";

import { createStyle } from "../render/style.js";
import type { Style } from "../render/style.js";
import { renderConsent } from "./consent-view.js";
import { askLine } from "./prompt.js";
import type { PromptInput, PromptOutput } from "./prompt.js";
import { sanitizeForTerminal } from "./sanitize.js";

/** ASSUMED (A3): ALP section 6 says consent times out but the manifest carries no field. */
export const DEFAULT_CONSENT_TIMEOUT_SECONDS = 120;

/** Thrown when an interactive method is called without an interactive terminal. Core folds it to deny/decline/reject. */
export class NoTerminalError extends Error {
  constructor() {
    super("no interactive terminal is available");
    this.name = "NoTerminalError";
  }
}

/** Thrown when a prompt ends without an answer (abort or EOF). Never an approval; core folds it to deny/decline/reject. */
export class NoAnswerError extends Error {
  readonly why: "aborted" | "eof";
  constructor(why: "aborted" | "eof") {
    super(why === "aborted" ? "prompt aborted before an answer" : "input closed before an answer");
    this.name = why === "aborted" ? "AbortError" : "NoAnswerError";
    this.why = why;
  }
}

export interface TerminalHostAdapterOptions {
  readonly input: PromptInput;
  readonly output: PromptOutput;
  /** From `manifest.approvals.timeout_seconds`; drives the display-only countdown (ApprovalRequest carries no deadline). */
  readonly approvalTimeoutSeconds: number;
  /** Display-only countdown for consent; defaults to `DEFAULT_CONSENT_TIMEOUT_SECONDS`. */
  readonly consentTimeoutSeconds?: number;
  /** Epoch seconds. Used only to compute the displayed countdown. */
  readonly clock: () => number;
  /** Where the single "no terminal" line goes. Defaults to `process.stderr`. */
  readonly errorOutput?: NodeJS.WritableStream;
  readonly style?: Style;
  /** Overrides `output.isTTY === true` for the readline mode (tests). */
  readonly terminal?: boolean;
}

const YES = new Set(["y", "yes"]);

function isYes(answer: string): boolean {
  return YES.has(answer.trim().toLowerCase());
}

/** The line shown when the lease ends while a prompt is on screen (D-20). A fixed string, no interpolation. */
export const LEASE_ENDED_PROMPT_LINE = "Lease ended, approval no longer needed.";

/** The fixed sentence for each reason an approval did not take effect (D-21). No interpolation: nothing the agent controls reaches the terminal. */
const APPROVAL_VOID_SENTENCES: Readonly<Record<ApprovalVoidReason, string>> = {
  expired_after_approval:
    "Your approval did not take effect: the lease expired before the action could run.",
  lease_ended_after_approval:
    "Your approval did not take effect: the lease ended before the action could run.",
  limit_reached_after_approval:
    "Your approval did not take effect: a lease limit was reached before the action could run.",
  approval_drifted: "Your approval did not take effect: the request changed after you approved it.",
};

function safeWrite(stream: NodeJS.WritableStream, text: string): void {
  try {
    stream.write(text);
  } catch {
    // Display failure must never change a lease outcome.
  }
}

/**
 * The reference terminal `HostAdapter` (HOST-02). It only renders and proposes.
 * Abort, EOF, a thrown error or a missing TTY all REJECT, so core's
 * `await*Decision` folds them to deny/decline/reject (D-05); this adapter has
 * no approve/deny timer of its own, and its countdown is display-only.
 *
 * One terminal shows one prompt at a time (D-18): every prompt runs through a
 * promise-chain mutex, so concurrent requests queue in arrival order and a
 * single terminal never has two readlines open. Each request's countdown
 * deadline is fixed when it is requested, not when it is shown, so a queued
 * request can time out (core's timer) before it is ever displayed. A queued
 * request whose signal aborts before its turn is never shown. If a prompt on
 * screen is cancelled because the lease ended, a fixed line says so (D-20).
 */
export function createTerminalHostAdapter(options: TerminalHostAdapterOptions): HostAdapter {
  const { input, output, clock } = options;
  const errorOutput = options.errorOutput ?? process.stderr;
  const style = options.style ?? createStyle(false);
  const consentTimeout = options.consentTimeoutSeconds ?? DEFAULT_CONSENT_TIMEOUT_SECONDS;
  const s = sanitizeForTerminal;

  /** The tail of the prompt queue; a new prompt starts only when the previous one has settled. */
  let queueTail: Promise<void> = Promise.resolve();

  /**
   * Runs `show` once every earlier prompt has settled. Rejects at once if
   * `signal` aborts while still queued, and never calls `show` for it.
   */
  function runExclusive<T>(signal: AbortSignal, show: () => Promise<T>): Promise<T> {
    const previous = queueTail;
    const state = { started: false };
    const turn = previous.then(async () => {
      if (signal.aborted) throw new NoAnswerError("aborted");
      state.started = true;
      return await show();
    });
    queueTail = turn.then(
      () => undefined,
      () => undefined,
    );
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => {
        if (!state.started) reject(new NoAnswerError("aborted"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      turn.then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(error instanceof Error ? error : new Error("prompt failed"));
        },
      );
    });
  }

  /**
   * Renders `body`, asks `question`, and returns whether the human said yes.
   * `deadline` (epoch seconds) was fixed when the request was made, so the
   * countdown runs from request time even when the prompt waited in the queue.
   * Rejects on any non-answer.
   */
  function ask(
    body: string,
    question: string,
    deadline: number,
    signal: AbortSignal,
  ): Promise<boolean> {
    return runExclusive(signal, async () => {
      if (input.isTTY !== true) {
        safeWrite(errorOutput, "stint: no interactive terminal is available; denying by default.\n");
        throw new NoTerminalError();
      }
      if (signal.aborted) throw new NoAnswerError("aborted");

      safeWrite(output, `${body}\n`);
      const answer = await askLine(input, output, question, signal, {
        countdown: { remaining: () => deadline - clock() },
        ...(options.terminal === undefined ? {} : { terminal: options.terminal }),
      });
      // `signal.aborted` may have flipped while awaiting; read it through a function so it is not narrowed to false.
      const abortedNow = (): boolean => signal.aborted;
      if (answer === undefined) {
        if (isLeaseEndedSignal(signal)) {
          const onTerminal = options.terminal ?? output.isTTY === true;
          safeWrite(output, `${onTerminal ? "\n" : ""}${LEASE_ENDED_PROMPT_LINE}\n`);
        }
        throw new NoAnswerError(abortedNow() ? "aborted" : "eof");
      }
      return isYes(answer);
    });
  }

  return {
    async requestConsent(request: ConsentRequest, signal: AbortSignal): Promise<ConsentDecision> {
      const yes = await ask(
        renderConsent(request.manifest.manifest, style),
        "Grant this lease? [y/N] ",
        clock() + consentTimeout,
        signal,
      );
      return yes ? { decision: "grant" } : { decision: "decline", reason: "user_declined" };
    },

    async requestApproval(
      request: ApprovalRequest,
      signal: AbortSignal,
    ): Promise<ApprovalDecision> {
      const { binding } = request;
      // The countdown starts now, when the approval is requested, not when it reaches the front of the queue (D-18).
      const deadline = clock() + options.approvalTimeoutSeconds;
      const body = [
        style.header("Approval requested"),
        `  ${s(request.summary)}`,
        `  tool: ${s(binding.tool)} on ${s(binding.resource)} (${s(binding.access)})${binding.irreversible ? " [irreversible]" : ""}`,
      ].join("\n");
      const yes = await ask(
        body,
        "Approve this action? [y/N] ",
        deadline,
        signal,
      );
      return yes ? { decision: "approve" } : { decision: "deny", reason: "user_denied" };
    },

    async requestOutcomeConfirmation(
      request: OutcomeConfirmRequest,
      signal: AbortSignal,
    ): Promise<OutcomeConfirmDecision> {
      const body = [
        style.header(`Outcome check for lease ${s(request.leaseId)}`),
        `  ${s(request.prompt)}`,
      ].join("\n");
      const yes = await ask(body, "Did this happen? [y/N] ", clock() + consentTimeout, signal);
      return yes ? { decision: "confirm" } : { decision: "reject", reason: "user_rejected" };
    },

    notify(event: LifecycleEvent): Promise<void> {
      try {
        if (event.type === "approval_void") {
          safeWrite(output, `${APPROVAL_VOID_SENTENCES[event.reason]}\n`);
          return Promise.resolve();
        }
        const at = Number.isFinite(event.at)
          ? ` at ${new Date(event.at * 1000).toISOString()}`
          : "";
        safeWrite(
          output,
          `${style.dim("[stint]")} lease ${s(event.leaseId)} ${s(event.type)}${at}\n`,
        );
      } catch {
        // notify never throws.
      }
      return Promise.resolve();
    },
  };
}
