/**
 * Partial teardown failure and its idempotent retry, end to end (E2E-02, TEAR-01,
 * TEAR-04). The publisher's cleanup hook answers 500 once, so the first teardown
 * completes every step it can and lands in `cleanup_incomplete` (exit 7) with an
 * honest per-step record. The hook then recovers and `stint cleanup` finishes the
 * job: steps that already succeeded are NOT re-run, each attempt mints its own
 * single-use cleanup token (two distinct jtis), and the lease never goes back to
 * `active` at any point.
 *
 * The publisher mock only remembers ACCEPTED jtis, so the failed attempt's token is
 * observed the way a network tap would see it: a pass-through spy on `fetch` that
 * reads each cleanup bearer's (non-secret) `jti` claim. Every server binds loopback
 * port 0 and is stopped inside `runScenario`. No sleeps.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { runScenario } from "../src/scenario.js";
import type { ScenarioResult } from "../src/scenario.js";

const SCRIPT = [{ name: "list_transactions" }, { name: "read_orders" }] as const;

interface FetchLog {
  readonly url: string;
  readonly jti: string | undefined;
}

/** The `jti` of a compact-JWS bearer, or `undefined` when the header is not one. */
function jtiOf(authorization: string | undefined): string | undefined {
  const token = authorization?.startsWith("Bearer ") === true ? authorization.slice(7) : "";
  const payload = token.split(".")[1];
  if (payload === undefined) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      jti?: unknown;
    };
    return typeof claims.jti === "string" ? claims.jti : undefined;
  } catch {
    return undefined;
  }
}

/** Spies on `fetch` (pass-through) and records every request URL plus any bearer `jti`. */
function tapFetch(): FetchLog[] {
  const log: FetchLog[] = [];
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    log.push({ url, jti: jtiOf(headers.get("authorization") ?? undefined) });
    return real(input, init);
  });
  return log;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("partial teardown: the cleanup hook fails once", () => {
  describe("first teardown only", () => {
    let run: ScenarioResult;

    beforeAll(async () => {
      run = await runScenario({
        end: "revoke",
        failNextCleanup: true,
        approvals: [],
        script: SCRIPT,
      });
    });

    afterAll(async () => {
      await run.dispose();
    });

    it("lands in cleanup_incomplete with exit 7 and an honest per-step record", () => {
      expect(run.exitCodes.create).toBe(0);
      expect(run.exitCodes.end).toBe(7);
      expect(run.exitCodes.retry).toBeUndefined();
      expect(run.lease?.state).toBe("cleanup_incomplete");

      // Only the hook failed; every other step completed and was recorded.
      expect(run.lease?.teardownProgress).toEqual({
        revoke_oauth: "revoked",
        invalidate_license: "ok",
        cleanup_hook: "failed",
        delete_cached_data: "ok",
        final_receipt: "ok",
      });

      // The publisher was asked once and refused; nothing was accepted.
      expect(run.publisher.cleanupHits).toBe(1);
      expect(run.publisher.seenJtis).toHaveLength(0);

      // The failure is on the signed trail and there is no attested-ok marker.
      const steps = run.verifiedReceipts.flatMap((entry) =>
        entry.type === "teardown_step" ? [entry.payload] : [],
      );
      expect(steps.find((step) => step.step === "cleanup_hook")?.outcome).toBe("failed");
      expect(
        run.timeline.some(
          (item) =>
            item.entry.type === "teardown_step" && item.entry.payload.outcome === "attested_ok",
        ),
      ).toBe(false);
      expect(run.exitCodes.verify).toBe(0);
    });
  });

  describe("with a retry once the hook is healthy", () => {
    let run: ScenarioResult;
    let log: FetchLog[];

    beforeAll(async () => {
      log = tapFetch();
      try {
        run = await runScenario({
          end: "revoke",
          failNextCleanup: true,
          retryCleanup: true,
          approvals: [],
          script: SCRIPT,
        });
      } finally {
        vi.restoreAllMocks();
      }
    });

    afterAll(async () => {
      await run.dispose();
    });

    it("retries to cleaned_up: first exit 7, retry exit 0, final record complete", () => {
      expect(run.exitCodes.end).toBe(7);
      expect(run.exitCodes.retry).toBe(0);
      expect(run.lease?.state).toBe("cleaned_up");
      expect(run.lease?.teardownProgress).toEqual({
        revoke_oauth: "revoked",
        invalidate_license: "ok",
        cleanup_hook: "attested_ok",
        delete_cached_data: "ok",
        final_receipt: "ok",
      });
      expect(run.exitCodes.verify).toBe(0);
    });

    it("never re-runs a step that already succeeded (revoke and invalidate counters unchanged)", () => {
      // Same totals as a single, uninterrupted teardown: one /revoke per grant, one invalidate.
      expect(run.as.revokeHits).toBe(Object.keys(run.credentials).length);
      expect(run.publisher.invalidateHits).toBe(1);
      expect(run.publisher.invalidatedLeaseIds).toEqual([run.leaseId]);

      // Wire order: after the first cleanup call, the retry only calls the hook again.
      const urls = log.map((entry) => new URL(entry.url).pathname);
      const firstCleanup = urls.indexOf("/alp/cleanup");
      expect(firstCleanup).toBeGreaterThan(-1);
      const afterFirst = urls.slice(firstCleanup + 1);
      expect(afterFirst.filter((path) => path === "/alp/cleanup")).toHaveLength(1);
      expect(afterFirst).not.toContain("/revoke");
      expect(afterFirst).not.toContain("/license/invalidate");
    });

    it("mints a distinct single-use cleanup token per attempt", () => {
      const attempts = log.filter((entry) => new URL(entry.url).pathname === "/alp/cleanup");
      expect(attempts).toHaveLength(2);
      expect(run.publisher.cleanupHits).toBe(2);

      const [first, second] = attempts;
      expect(first?.jti).toBeDefined();
      expect(second?.jti).toBeDefined();
      expect(first?.jti).not.toBe(second?.jti);

      // The publisher accepted only the second; a replay of the first would have been refused.
      expect(run.publisher.seenJtis).toEqual([second?.jti]);
    });

    it("never returns to active after the revoke, through failure and retry", () => {
      const transitions = run.verifiedReceipts.flatMap((entry) =>
        entry.type === "transition" ? [entry.payload] : [],
      );
      const revokeIndex = transitions.findIndex((t) => t.event === "revoke");
      expect(revokeIndex).toBeGreaterThan(-1);
      expect(transitions.slice(revokeIndex).map((t) => t.to)).toEqual([
        "revoked",
        "tearing_down",
        "cleanup_incomplete",
        "tearing_down",
        "cleaned_up",
      ]);
      expect(transitions.slice(revokeIndex).every((t) => t.to !== "active")).toBe(true);
      expect(transitions.every((t) => t.actor !== "agent")).toBe(true);
    });
  });
});
