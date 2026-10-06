/**
 * `deriveRetryState`: the supervisor's retry and stuck decision, computed from
 * the verified receipt chain and nothing else (Phase 9 D-01, D-22). No counter
 * lives in memory or in a state file, so a long-running loop, `supervise
 * --once` under cron and a restarted supervisor all make the same decision for
 * the same chain and clock.
 *
 * Reading the chain in order:
 *  - a `transition` whose event is `teardown_incomplete` is one failed pass: it
 *    counts, sets the landing time and clears any stuck marker;
 *  - a `teardown_blocked` entry clears the stuck marker (a blocked attempt is a
 *    new attempt by someone);
 *  - a `teardown_stuck` entry sets the stuck marker and resets the count, so a
 *    failed manual cleanup after it starts a fresh budget.
 *
 * Payloads are read defensively: an entry without the expected shape is ignored.
 */

import type { ReceiptEntry } from "@stint/spec";

import type { SupervisorConfig } from "./config.js";

/** The widest exponent used: 2 ** 30 times the largest allowed base is still a finite number, and the wait is clamped to `retryMaxSeconds` anyway. */
const MAX_EXPONENT = 31;

export interface RetryState {
  /** Failed teardown passes since the last stuck marker. */
  readonly failedPasses: number;
  /** `ts` of the latest failed landing; 0 when there is none. */
  readonly lastLandingAt: number;
  /** Backoff after the latest failed pass; 0 with no failed pass. */
  readonly waitSeconds: number;
  /** `lastLandingAt + waitSeconds`. */
  readonly nextDueAt: number;
  /** True when a retry should run now. */
  readonly due: boolean;
  /** True when the failed passes exceed the retry cap, so the lease is to be marked stuck. */
  readonly exhausted: boolean;
  /** The latest stuck marker, while no later teardown marker has cleared it. */
  readonly stuck: { readonly reason: string; readonly attempts: number } | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A finite number `ts`, else 0. */
function tsOf(entry: ReceiptEntry): number {
  const ts: unknown = entry.ts;
  return typeof ts === "number" && Number.isFinite(ts) ? ts : 0;
}

/** Backoff in seconds after `failedPasses` failed passes: `min(base * 2^(k-1), max)`, with the exponent clamped before exponentiation. */
function waitFor(failedPasses: number, config: SupervisorConfig): number {
  if (failedPasses <= 0) return 0;
  const exponent = Math.min(failedPasses, MAX_EXPONENT) - 1;
  return Math.min(config.retryBaseSeconds * 2 ** exponent, config.retryMaxSeconds);
}

/**
 * Derives the retry state of one lease from its verified chain.
 *
 * `due` is true at or after `nextDueAt`, and also when `nextDueAt` lies more
 * than `retryMaxSeconds` ahead of `now`: no honest wait is longer than the
 * maximum, so such a landing time means the clock went backward.
 */
export function deriveRetryState(
  chain: readonly ReceiptEntry[],
  config: SupervisorConfig,
  now: number,
): RetryState {
  let failedPasses = 0;
  let lastLandingAt = 0;
  let stuck: RetryState["stuck"];

  for (const entry of chain) {
    const type: string = entry.type;
    const payload: unknown = entry.payload;
    if (type === "transition") {
      if (isRecord(payload) && payload.event === "teardown_incomplete") {
        failedPasses += 1;
        lastLandingAt = tsOf(entry);
        stuck = undefined;
      }
    } else if (type === "teardown_blocked") {
      stuck = undefined;
    } else if (type === "teardown_stuck") {
      if (isRecord(payload) && typeof payload.reason === "string" && typeof payload.attempts === "number") {
        stuck = { reason: payload.reason, attempts: payload.attempts };
        failedPasses = 0;
      }
    }
  }

  const waitSeconds = waitFor(failedPasses, config);
  const nextDueAt = lastLandingAt + waitSeconds;
  const due = failedPasses > 0 && (now >= nextDueAt || nextDueAt - now > config.retryMaxSeconds);
  return {
    failedPasses,
    lastLandingAt,
    waitSeconds,
    nextDueAt,
    due,
    exhausted: failedPasses > config.retryCap,
    stuck,
  };
}
