/**
 * `buildCallPayload`/`appendCallReceipt` -- the per-call receipt builder
 * (D-13, RCPT-01). `CallPayload` is secretless BY TYPE (`resource` +
 * `argsHash` + `redactedSummary` + `outcome` only, generated from
 * `spec/ALP.md`'s receipt schema and re-exported through `@stint/core`) --
 * leaking a raw arg into a receipt is a compile error, not a review
 * discipline (T-04-02-ID).
 *
 * `dispatch.ts`'s `finally` block is the ONLY caller of
 * `appendCallReceipt`, so every `tools/call` -- allowed or denied -- leaves
 * exactly one verified-chain receipt (RCPT-01).
 */

import { appendEntry } from "@stint/core";
import type { CallPayload, ConnectorBinding, ReceiptEntry, ReceiptStore } from "@stint/core";
import { hashCanonical } from "@stint/spec";

/** The sentinel `resource` recorded when no binding resolved at all (the unbound/out-of-scope `no_binding` deny path) -- never a guess at what resource the agent might have meant. */
const UNRESOLVED_RESOURCE = "unresolved";

/**
 * Builds the secretless `CallPayload` for one call's outcome. `argsHash` is
 * always `hashCanonical` of the resolved args (already normalized to `{}`
 * by `dispatch.ts` when `arguments` was absent) -- computed regardless of
 * outcome, so even a denied call with no args still produces a real,
 * reproducible hash (never a skipped/null receipt).
 *
 * `redactedSummary` is built ONLY from the binding's tool name and the
 * outcome/detail code -- NEVER from raw args or an underlying error's
 * message, so a secret-looking arg value can never surface here
 * (T-04-02-ID).
 */
export function buildCallPayload(
  binding: ConnectorBinding | undefined,
  resolvedArgs: Readonly<Record<string, unknown>>,
  outcome: "allowed" | "denied",
  detail?: string,
): CallPayload {
  const tool = binding?.tool ?? "unknown";
  const redactedSummary =
    outcome === "allowed"
      ? `call to "${tool}" allowed`
      : `call to "${tool}" denied${detail !== undefined ? `: ${detail}` : ""}`;

  return {
    resource: binding?.resource ?? UNRESOLVED_RESOURCE,
    argsHash: hashCanonical(resolvedArgs),
    redactedSummary,
    outcome,
  };
}

/**
 * Appends `payload` onto `chain` (the currently-loaded verified-chain
 * entries) and persists the new entry via `receiptStore.append` --
 * expected to run inside `dispatch.ts`'s per-lease-transaction `finally`
 * block so append order matches call order (D-13).
 */
export async function appendCallReceipt(
  receiptStore: ReceiptStore,
  chain: readonly ReceiptEntry[],
  payload: CallPayload,
  now: number,
): Promise<ReceiptEntry> {
  const entry = appendEntry(chain, { chain: "verified", type: "call", payload }, now);
  await receiptStore.append("verified", entry);
  return entry;
}
