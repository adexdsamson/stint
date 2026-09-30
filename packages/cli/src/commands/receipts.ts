/**
 * `stint receipts <leaseId>`: the merged, plain-language receipt timeline
 * (CLI-02, D-06). A thin renderer: `mergeTimeline` from `@stint/core` does the
 * merge, this file only loads, prints and maps exit codes. No integrity logic
 * lives here; `--verify` hands off to `stint verify` (D-08).
 */

import { mergeTimeline } from "@stint/core";

import type { CliDeps, GlobalOpts } from "../deps.js";
import { CliError, EXIT_CODES } from "../exit.js";
import { assertSafeLeaseId, resolveStoreRoot } from "../paths.js";
import { renderTimeline } from "../render/timeline.js";
import { verifyCommand } from "./verify.js";

export interface ReceiptsOpts extends GlobalOpts {
  readonly verify?: boolean | undefined;
}

export async function receiptsCommand(
  deps: CliDeps,
  leaseId: string,
  opts: ReceiptsOpts,
): Promise<number> {
  assertSafeLeaseId(leaseId);
  if (opts.verify === true) return verifyCommand(deps, leaseId, opts);

  const json = opts.json === true;
  const root = resolveStoreRoot(opts);
  if ((await deps.storeFactory(root).load(leaseId)) === undefined) {
    throw new CliError(EXIT_CODES.leaseNotFound, "Lease not found.");
  }

  // An absent receipts directory reads as two empty chains (v0.1 normally has no attested chain).
  const receipts = deps.receiptStoreFactory(root, leaseId);
  const verified = await receipts.load("verified");
  const attested = await receipts.load("attested");
  const timeline = mergeTimeline(verified, attested);

  if (json) {
    deps.io.out(`${JSON.stringify(timeline)}\n`);
    return EXIT_CODES.ok;
  }

  if (timeline.length === 0) {
    deps.io.out("No receipts recorded for this lease.\n");
    return EXIT_CODES.ok;
  }
  const lines = renderTimeline(timeline, deps.style(false));
  deps.io.out(`${lines.join("\n")}\n`);
  return EXIT_CODES.ok;
}
