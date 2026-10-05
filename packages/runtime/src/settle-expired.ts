/**
 * `settleExpired`: the first host-agnostic runtime entry point. A `granted` or
 * `active` lease whose `expiresAt` has been reached is moved to `expired` by
 * the clock (`clockEvents.expire()`, ALP Section 7), and the transition is
 * receipted. Nothing else in the system applies that event, so a host calls
 * this before tearing an expired-but-unsettled lease down.
 *
 * The state change and its receipt are written inside ONE lease transaction,
 * so a crash cannot leave a settled lease without its transition receipt, and
 * a second driver racing this one sees the lease already moved and does
 * nothing (`settled: false`).
 */

import { clockEvents, reduce, safeEmit } from "@stint/core";
import type { Lease, TransitionRecord } from "@stint/core";
import { appendTransitionReceipt } from "@stint/proxy";

import { RuntimeError } from "./errors.js";
import type { RuntimePorts } from "./ports.js";

export async function settleExpired(
  ports: Pick<RuntimePorts, "leases" | "receipts" | "clock" | "telemetry">,
  leaseId: string,
): Promise<{ readonly lease: Lease; readonly settled: boolean }> {
  const existing = await ports.leases.load(leaseId);
  if (existing === undefined) throw new RuntimeError("lease_not_found", "Lease not found.");

  const now = ports.clock();
  let record: TransitionRecord | undefined;

  const lease = await ports.leases.transaction(leaseId, async (fresh) => {
    if (fresh.state !== "granted" && fresh.state !== "active") return fresh;
    if (!(fresh.expiresAt > 0 && now >= fresh.expiresAt)) return fresh;

    const result = reduce(fresh, clockEvents.expire(), now);
    // Another driver moved the lease first; carry on from whatever state it is in now.
    if (!result.ok) return fresh;

    await appendTransitionReceipt(ports.receipts(leaseId), result.value.transition, now);
    record = result.value.transition;
    return result.value.lease;
  });

  if (record !== undefined) {
    safeEmit(ports.telemetry, {
      name: "lease.transition",
      leaseId,
      from: record.from,
      to: record.to,
      actor: record.actor,
    });
  }
  return { lease, settled: record !== undefined };
}
