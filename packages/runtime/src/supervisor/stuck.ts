/**
 * `markStuck`: writes the verified `teardown_stuck` receipt for a lease the
 * supervisor will no longer retry on its own (Phase 9 D-01, D-03). It changes
 * no lease state: the lease stays where it is and stays visible until the user
 * fixes the cause and runs `stint-cli cleanup`.
 *
 * The check and the append happen inside one lease transaction, so two drivers
 * marking the same lease write one entry.
 */

import { appendReceiptEntry } from "@stint/proxy";
import type { TeardownStuckPayload } from "@stint/spec";

import type { RuntimePorts } from "../ports.js";

/**
 * Appends a `teardown_stuck` entry with `payload` unless the chain's tail is
 * already that same entry. Returns true when a receipt was written.
 */
export async function markStuck(
  ports: Pick<RuntimePorts, "leases" | "receipts">,
  leaseId: string,
  payload: TeardownStuckPayload,
  now: number,
): Promise<boolean> {
  let wrote = false;
  const receiptStore = ports.receipts(leaseId);
  await ports.leases.transaction(leaseId, async (lease) => {
    const chain = await receiptStore.load("verified");
    const tail = chain.at(-1);
    const alreadyMarked =
      tail?.type === "teardown_stuck" &&
      tail.payload.reason === payload.reason &&
      tail.payload.attempts === payload.attempts;
    if (alreadyMarked) return lease;

    await appendReceiptEntry(receiptStore, { chain: "verified", type: "teardown_stuck", payload }, now);
    wrote = true;
    return lease;
  });
  return wrote;
}
