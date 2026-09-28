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
 * STUB (RED phase, Task 1): `authorize` always allows and `commit` neither
 * prunes the window nor adds spend -- replaced with the real
 * strict-`>`-window read-check (mirroring `checkErrorThreshold`,
 * `packages/core/src/policy.ts:153-163`) in the GREEN commit.
 */

import type { Lease, PolicyCall } from "@stint/core";
import type { Limits } from "@stint/spec";

import type { CapCheck, CapEnforcer } from "../dispatch.js";

/** Constructs the real, sliding-window `CapEnforcer` (PRXY-04). */
export function createCapEnforcer(): CapEnforcer {
  return {
    authorize(lease: Lease, call: PolicyCall, limits: Limits, now: number): CapCheck {
      return { ok: true };
    },

    commit(lease: Lease, call: PolicyCall, now: number): Lease {
      return {
        ...lease,
        counters: {
          ...lease.counters,
          actionCount: lease.counters.actionCount + 1,
          actionTimestamps: [...lease.counters.actionTimestamps, now],
        },
      };
    },
  };
}
