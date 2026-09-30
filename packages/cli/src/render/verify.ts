/**
 * Plain-language rendering of chain-verification results (D-08, CLI-02).
 *
 * The reason table is `Record<ReceiptVerifyReason, string>` over the enum
 * exported by `@stint/core`, so adding or removing a reason there is a compile
 * error here rather than a silently unexplained failure (Pitfall 9; the
 * CONTEXT notes listed four reasons, the enum has five). Messages are fixed
 * strings: nothing from a receipt file is interpolated into them.
 */

import type { ReceiptVerifyReason, verifyChain } from "@stint/core";

import type { Style } from "./style.js";

export type ChainOutcome = Awaited<ReturnType<typeof verifyChain>>;

export interface VerifyOutcome {
  readonly verified: ChainOutcome;
  readonly attested: ChainOutcome;
}

/** Which chains had a signed checkpoint to anchor against (tail edits are invisible without one). */
export interface Anchored {
  readonly verified: boolean;
  readonly attested: boolean;
}

export const REASON_MESSAGES: Record<ReceiptVerifyReason, string> = {
  hash_mismatch: "an entry was modified after it was written (its content no longer matches)",
  reordered: "entries were moved or swapped out of their recorded order",
  truncated: "entries are missing: the chain is shorter than its signed checkpoint",
  checkpoint_sig_invalid:
    "the signed checkpoint could not be verified (it was altered, or the runtime key does not match)",
  claim_sig_invalid: "a publisher claim is not signed by a publisher this runtime trusts",
};

function chainLines(
  name: string,
  outcome: ChainOutcome,
  anchored: boolean,
  style: Style,
): string[] {
  if (outcome.ok) {
    const count = outcome.value.count;
    const lines = [style.pass(`OK   ${name} chain: ${String(count)} entries verified`)];
    if (count > 0 && !anchored) {
      lines.push(
        style.dim(
          `     note: no signed checkpoint for the ${name} chain, so removal of its newest entries cannot be detected`,
        ),
      );
    }
    return lines;
  }
  return outcome.errors.map((failure) =>
    style.fail(
      `FAIL ${name} chain broken at entry ${String(failure.brokenAtSeq)}: ${REASON_MESSAGES[failure.reason]} [${failure.reason}]`,
    ),
  );
}

/** Renders both chains' results: one success line each (with counts) or one failure line per break. */
export function renderVerifyResult(
  outcome: VerifyOutcome,
  style: Style,
  anchored: Anchored = { verified: true, attested: true },
): string[] {
  const lines = [
    ...chainLines("verified", outcome.verified, anchored.verified, style),
    ...chainLines("attested", outcome.attested, anchored.attested, style),
  ];
  if (outcome.verified.ok && outcome.attested.ok) {
    const total = outcome.verified.value.count + outcome.attested.value.count;
    lines.push(style.pass(`Receipt chains intact: ${String(total)} entries in total.`));
  }
  return lines;
}
