/**
 * `createCapEnforcer` -- the real sliding-window `CapEnforcer` (PRXY-04,
 * D-05, D-06). `authorize` performs ONLY the sliding-window
 * `actions_per_hour` gate; the `max_actions`, `spend`, `expiry`, and
 * `no_binding` gates stay in `evaluatePolicy` (`@stint/core`), never
 * duplicated here. `commit` produces the next `Lease` by incrementing
 * `actionCount`, appending `now` to a window-pruned `actionTimestamps`, and
 * adding the call's `spendMinor` to `spentMinor` -- it never mutates its
 * `lease` input (a new object is always returned).
 *
 * The window is `(now-3600, now]` -- strict `>`, mirroring
 * `checkErrorThreshold`'s trailing-window idiom exactly
 * (`packages/core/src/policy.ts:153-163`): a timestamp exactly `now-3600` is
 * OUTSIDE the window and does not count.
 */

import type { Lease, PolicyCall } from "@stint/core";
import type { Limits } from "@stint/spec";

import type { CapCheck, CapEnforcer } from "../dispatch.js";

const ACTIONS_PER_HOUR_WINDOW_SECONDS = 3600;

/** Counts `timestamps` strictly newer than `now - ACTIONS_PER_HOUR_WINDOW_SECONDS` (exclusive lower bound). */
function countWithinWindow(timestamps: readonly number[], now: number): number {
  const windowStart = now - ACTIONS_PER_HOUR_WINDOW_SECONDS;
  return timestamps.filter((ts) => ts > windowStart).length;
}

/** Drops every timestamp `<= now - ACTIONS_PER_HOUR_WINDOW_SECONDS` -- the surviving set before appending the current call's `now`. */
function pruneWindow(timestamps: readonly number[], now: number): readonly number[] {
  const windowStart = now - ACTIONS_PER_HOUR_WINDOW_SECONDS;
  return timestamps.filter((ts) => ts > windowStart);
}

/** Constructs the real, sliding-window `CapEnforcer` (PRXY-04). */
export function createCapEnforcer(): CapEnforcer {
  return {
    authorize(lease: Lease, _call: PolicyCall, limits: Limits, now: number): CapCheck {
      const limit = limits.actions_per_hour;
      if (limit === undefined) return { ok: true };
      const inWindowCount = countWithinWindow(lease.counters.actionTimestamps, now);
      if (inWindowCount >= limit) {
        return { ok: false, reason: "over_actions_per_hour" };
      }
      return { ok: true };
    },

    commit(lease: Lease, call: PolicyCall, now: number): Lease {
      return {
        ...lease,
        counters: {
          ...lease.counters,
          actionCount: lease.counters.actionCount + 1,
          actionTimestamps: [...pruneWindow(lease.counters.actionTimestamps, now), now],
          spentMinor: lease.counters.spentMinor + (call.spendMinor ?? 0),
        },
      };
    },
  };
}
