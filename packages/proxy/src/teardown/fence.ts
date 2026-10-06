/**
 * The teardown fence (Phase 9 D-09 to D-11, SUP-03): lease-level ownership of
 * one teardown pass, held on the lease record as `{ epoch, expiresAt }`.
 *
 * Why it lives on the lease record: every fence change commits in the SAME
 * lease transaction as the step outcome (or the landing transition) it
 * guards, so no other driver can slip between "I still hold the fence" and
 * "I recorded this step". `epoch` counts the drivers that have taken the
 * teardown; `expiresAt` is epoch seconds and `0` means released.
 *
 * Rules (all inside one `runInLeaseTransaction`, never a separate lock):
 * - Acquire: an absent fence gives epoch 1; a released fence gives the
 *   previous epoch plus 1; a fence still live (`expiresAt` after the clock
 *   and no more than one TTL ahead) throws `TeardownFencedError("held")`;
 *   anything else (expired, or implausibly far in the future after a backward
 *   clock jump or a hand edit) is a takeover: previous epoch plus 1 and a
 *   verified `teardown_takeover` receipt appended in the same transaction.
 * - Hold: every step mutator and the landing mutator first check that the
 *   record still carries the driver's epoch, else `TeardownFencedError("stale")`
 *   and no step runs. A holder whose fence merely expired but was never taken
 *   over still matches and may continue (epoch equality inside a transaction
 *   proves nobody took over).
 * - Release: the landing mutator writes `expiresAt: 0` in the same write as
 *   the landing transition; `releaseFence` is the best-effort path after an
 *   error.
 *
 * Fence times always come from the injected `config.clock()`, read at the
 * moment of use, never from the single `now` a pass is called with: a pass
 * can span minutes of network calls. This module arms no timer and reaches
 * the lease only through `runInLeaseTransaction`.
 */

import { safeEmit } from "@stint/core";
import type { Lease, LeaseStore, ReceiptStore, TeardownFence, Telemetry } from "@stint/core";

import { runInLeaseTransaction } from "../concurrency/lease-serializer.js";
import { appendReceiptEntry } from "../receipts/append.js";

/** The fence lifetime in seconds. A pass renews it at acquire, at every step and at landing, so it only has to outlive the gap between two renewals. */
export const DEFAULT_FENCE_TTL_SECONDS = 120;

/** How a driver reads the live clock (epoch seconds) and how long a fence it writes stays valid. */
export interface TeardownFenceConfig {
  readonly clock: () => number;
  readonly ttlSeconds: number;
}

/** Fixed message: nothing about the other driver is interpolated. */
const FENCED_MESSAGE = "Another driver holds the teardown for this lease.";

/**
 * Thrown when a driver may not run teardown steps: `held` means another
 * driver's fence is live (nothing was changed); `stale` means this driver's
 * fence was taken over, so it must stop at once.
 */
export class TeardownFencedError extends Error {
  readonly kind: "held" | "stale";

  constructor(kind: "held" | "stale") {
    super(FENCED_MESSAGE);
    this.name = "TeardownFencedError";
    this.kind = kind;
  }
}

/** The proof of ownership a driver carries through one pass. */
export interface FenceToken {
  readonly epoch: number;
}

/** The slice of `TeardownDeps` the fence helpers need. */
export interface FenceDeps {
  readonly leaseStore: LeaseStore;
  readonly receiptStore: ReceiptStore;
  readonly leaseId: string;
  readonly telemetry?: Telemetry;
}

/**
 * Acquires the fence for one pass in ONE lease transaction (see the module
 * docstring for the rules). Emits `teardown.fence_takeover` after the
 * transaction when it took over an unreleased fence.
 */
export async function acquireFence(deps: FenceDeps, config: TeardownFenceConfig): Promise<FenceToken> {
  let token: FenceToken | undefined;
  let takeover: { readonly previousEpoch: number; readonly epoch: number } | undefined;

  await runInLeaseTransaction(deps.leaseStore, deps.leaseId, async (lease) => {
    const at = config.clock();
    const held = lease.fence;
    const live = held !== undefined && held.expiresAt > at && held.expiresAt - at <= config.ttlSeconds;
    if (live) throw new TeardownFencedError("held");

    const epoch = (held?.epoch ?? 0) + 1;
    if (held !== undefined && held.expiresAt !== 0) {
      await appendReceiptEntry(
        deps.receiptStore,
        {
          chain: "verified",
          type: "teardown_takeover",
          payload: { previousEpoch: held.epoch, epoch, reason: "fence_expired" },
        },
        at,
      );
      takeover = { previousEpoch: held.epoch, epoch };
    }
    token = { epoch };
    return { ...lease, fence: { epoch, expiresAt: at + config.ttlSeconds } };
  });

  if (token === undefined) {
    throw new Error("@stint/proxy: fence acquisition did not produce a token.");
  }
  if (takeover !== undefined) {
    safeEmit(deps.telemetry, {
      name: "teardown.fence_takeover",
      leaseId: deps.leaseId,
      previousEpoch: takeover.previousEpoch,
      epoch: takeover.epoch,
    });
  }
  return token;
}

/** First statement of every fenced mutator: a record that no longer carries this driver's epoch means the fence was taken over, so no step may run. */
export function assertFenceHolder(lease: Lease, token: FenceToken): void {
  if (lease.fence?.epoch !== token.epoch) throw new TeardownFencedError("stale");
}

/** The fence value a holder writes back to renew its hold: same epoch, a fresh expiry from the live clock. */
export function renewedFence(token: FenceToken, config: TeardownFenceConfig): TeardownFence {
  return { epoch: token.epoch, expiresAt: config.clock() + config.ttlSeconds };
}

/** The fence value written in the same write as the landing transition. */
export function releasedFence(token: FenceToken): TeardownFence {
  return { epoch: token.epoch, expiresAt: 0 };
}

/**
 * Best-effort release after an error: changes the lease only when the record
 * still carries this driver's epoch and the fence is not already released.
 * Callers swallow any error from this attempt.
 */
export async function releaseFence(deps: FenceDeps, token: FenceToken): Promise<void> {
  await runInLeaseTransaction(deps.leaseStore, deps.leaseId, (lease) => {
    const held = lease.fence;
    if (held === undefined || held.epoch !== token.epoch || held.expiresAt === 0) return lease;
    return { ...lease, fence: releasedFence(token) };
  });
}
