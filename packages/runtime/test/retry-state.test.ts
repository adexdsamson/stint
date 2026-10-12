import { appendEntry } from "@stint/core";
import type { ReceiptEntry } from "@stint/spec";
import { describe, expect, it } from "vitest";

import { DEFAULT_SUPERVISOR_CONFIG, deriveRetryState } from "../src/index.js";
import type { SupervisorConfig } from "../src/index.js";

const L = 10_000;

type Step =
  | { readonly kind: "landing"; readonly ts: number }
  | { readonly kind: "blocked"; readonly ts: number }
  | { readonly kind: "stuck"; readonly ts: number; readonly reason?: "retries_exhausted" | "revocation_failed"; readonly attempts?: number }
  | { readonly kind: "other"; readonly ts: number };

/** A real hash-linked verified chain built from simple steps. */
function chainOf(...steps: readonly Step[]): readonly ReceiptEntry[] {
  const chain: ReceiptEntry[] = [];
  for (const step of steps) {
    switch (step.kind) {
      case "landing":
        chain.push(
          appendEntry(
            chain,
            {
              chain: "verified",
              type: "transition",
              payload: { from: "tearing_down", event: "teardown_incomplete", actor: "runtime", to: "cleanup_incomplete" },
            },
            step.ts,
          ),
        );
        break;
      case "other":
        chain.push(
          appendEntry(
            chain,
            {
              chain: "verified",
              type: "transition",
              payload: { from: "cleanup_incomplete", event: "retry_teardown", actor: "runtime", to: "tearing_down" },
            },
            step.ts,
          ),
        );
        break;
      case "blocked":
        chain.push(
          appendEntry(
            chain,
            {
              chain: "verified",
              type: "teardown_blocked",
              payload: { reason: "credentials_unavailable", resources: ["sheets.orders"] },
            },
            step.ts,
          ),
        );
        break;
      case "stuck":
        chain.push(
          appendEntry(
            chain,
            {
              chain: "verified",
              type: "teardown_stuck",
              payload: { reason: step.reason ?? "retries_exhausted", attempts: step.attempts ?? 9 },
            },
            step.ts,
          ),
        );
        break;
    }
  }
  return chain;
}

function landings(count: number, at = L): readonly Step[] {
  return Array.from({ length: count }, (_, index) => ({ kind: "landing" as const, ts: at + index }));
}

const CONFIG = DEFAULT_SUPERVISOR_CONFIG;

describe("DEFAULT_SUPERVISOR_CONFIG", () => {
  it("is 60 s base, 3600 s max, a cap of 8 retries (D-22) and a 900 s probe interval (D-15) and a 86400 s corrupt repeat (D-23)", () => {
    expect(CONFIG).toEqual({
      retryBaseSeconds: 60,
      retryMaxSeconds: 3600,
      retryCap: 8,
      probeIntervalSeconds: 900,
      probeTimeoutMs: 15_000,
      corruptRepeatSeconds: 86_400,
      clockJumpThresholdSeconds: 3600,
    });
  });
});

describe("deriveRetryState", () => {
  it("an empty chain has no failed pass and is not due", () => {
    const state = deriveRetryState([], CONFIG, L);
    expect(state.failedPasses).toBe(0);
    expect(state.waitSeconds).toBe(0);
    expect(state.due).toBe(false);
    expect(state.exhausted).toBe(false);
    expect(state.stuck).toBeUndefined();
  });

  it("one landing at L waits 60 s: not due at L+59, due at exactly L+60", () => {
    const chain = chainOf({ kind: "landing", ts: L });
    const early = deriveRetryState(chain, CONFIG, L + 59);
    expect(early.failedPasses).toBe(1);
    expect(early.lastLandingAt).toBe(L);
    expect(early.waitSeconds).toBe(60);
    expect(early.nextDueAt).toBe(L + 60);
    expect(early.due).toBe(false);
    expect(deriveRetryState(chain, CONFIG, L + 60).due).toBe(true);
    expect(deriveRetryState(chain, CONFIG, L + 61).due).toBe(true);
  });

  it.each([
    [1, 60],
    [2, 120],
    [3, 240],
    [4, 480],
    [5, 960],
    [6, 1920],
    [7, 3600],
    [8, 3600],
  ])("after %i failed passes the wait is %i seconds from the last landing", (failed, wait) => {
    const chain = chainOf(...landings(failed));
    const last = L + failed - 1;
    const state = deriveRetryState(chain, CONFIG, last);
    expect(state.failedPasses).toBe(failed);
    expect(state.waitSeconds).toBe(wait);
    expect(state.nextDueAt).toBe(last + wait);
    expect(deriveRetryState(chain, CONFIG, last + wait - 1).due).toBe(false);
    expect(deriveRetryState(chain, CONFIG, last + wait).due).toBe(true);
  });

  it("clamps the exponent: 1000 failed passes wait retryMax, finite and never NaN", () => {
    const chain = chainOf(...landings(1000));
    const state = deriveRetryState(chain, CONFIG, L + 1000);
    expect(state.failedPasses).toBe(1000);
    expect(state.waitSeconds).toBe(3600);
    expect(Number.isFinite(state.nextDueAt)).toBe(true);
    expect(Number.isNaN(state.nextDueAt)).toBe(false);
    expect(state.exhausted).toBe(true);
  });

  it("a landing further in the future than retryMax counts as due (backward clock jump)", () => {
    const chain = chainOf({ kind: "landing", ts: L + 3601 });
    expect(deriveRetryState(chain, CONFIG, L).due).toBe(true);
    // Exactly retryMax ahead is still a legitimate wait, not a jump.
    const edge = chainOf({ kind: "landing", ts: L + 3600 - 60 });
    expect(deriveRetryState(edge, CONFIG, L).due).toBe(false);
  });

  it("is exhausted only above the cap: not at 8 failed passes, yes at 9", () => {
    expect(deriveRetryState(chainOf(...landings(8)), CONFIG, L).exhausted).toBe(false);
    expect(deriveRetryState(chainOf(...landings(9)), CONFIG, L).exhausted).toBe(true);
  });

  it("honours a custom config", () => {
    const config: SupervisorConfig = { ...DEFAULT_SUPERVISOR_CONFIG, retryBaseSeconds: 5, retryMaxSeconds: 12, retryCap: 1 };
    const one = deriveRetryState(chainOf({ kind: "landing", ts: L }), config, L);
    expect(one.waitSeconds).toBe(5);
    expect(one.exhausted).toBe(false);
    const two = deriveRetryState(chainOf(...landings(2)), config, L);
    expect(two.waitSeconds).toBe(10);
    expect(two.exhausted).toBe(true);
    expect(deriveRetryState(chainOf(...landings(3)), config, L).waitSeconds).toBe(12);
  });

  it("a teardown_stuck entry after the landings sets stuck and resets failedPasses to 0", () => {
    const chain = chainOf(...landings(9), { kind: "stuck", ts: L + 100, attempts: 9 });
    const state = deriveRetryState(chain, CONFIG, L + 100_000);
    expect(state.stuck).toEqual({ reason: "retries_exhausted", attempts: 9 });
    expect(state.failedPasses).toBe(0);
    expect(state.due).toBe(false);
    expect(state.exhausted).toBe(false);
  });

  it("a teardown_incomplete landing after the stuck entry clears stuck and starts a fresh budget", () => {
    const chain = chainOf(...landings(9), { kind: "stuck", ts: L + 100 }, { kind: "landing", ts: L + 200 });
    const state = deriveRetryState(chain, CONFIG, L + 200);
    expect(state.stuck).toBeUndefined();
    expect(state.failedPasses).toBe(1);
    expect(state.lastLandingAt).toBe(L + 200);
    expect(state.waitSeconds).toBe(60);
    expect(state.exhausted).toBe(false);
  });

  it("a teardown_blocked entry after the stuck entry clears stuck", () => {
    const chain = chainOf(...landings(9), { kind: "stuck", ts: L + 100 }, { kind: "blocked", ts: L + 200 });
    const state = deriveRetryState(chain, CONFIG, L + 300);
    expect(state.stuck).toBeUndefined();
    expect(state.failedPasses).toBe(0);
  });

  it("ignores entries that are not landings, blocks or stuck markers", () => {
    const chain = chainOf({ kind: "landing", ts: L }, { kind: "other", ts: L + 1 });
    const state = deriveRetryState(chain, CONFIG, L + 1);
    expect(state.failedPasses).toBe(1);
    expect(state.lastLandingAt).toBe(L);
  });

  it("reads payloads defensively: a malformed entry is ignored", () => {
    const good = chainOf({ kind: "landing", ts: L });
    const malformed = [
      { seq: 1, ts: L + 5, chain: "verified", type: "transition", payload: null },
      { seq: 2, ts: L + 6, chain: "verified", type: "teardown_stuck", payload: { reason: 7, attempts: "x" } },
      { seq: 3, ts: L + 7, chain: "verified", type: "transition", payload: "teardown_incomplete" },
    ] as unknown as readonly ReceiptEntry[];
    const state = deriveRetryState([...good, ...malformed], CONFIG, L + 10);
    expect(state.failedPasses).toBe(1);
    expect(state.stuck).toBeUndefined();
    expect(state.lastLandingAt).toBe(L);
  });
});
