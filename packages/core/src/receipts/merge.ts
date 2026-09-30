/**
 * Display-only merged timeline over the verified and attested chains
 * (D-10, RCPT-05).
 *
 * `mergeTimeline` is a pure read-side function: it never mutates either
 * input chain (`readonly` arrays in, a brand-new array out) and never
 * touches either chain's hash linkage or signatures — that integrity lives
 * entirely in `verifyChain`/`verifyAttestedChain` and each chain's own
 * signed checkpoint. The merged output's ORDERING CARRIES NO INTEGRITY
 * MEANING OF ITS OWN: it exists solely so a host/CLI can render one
 * plain-language timeline that clearly marks each entry `verified` or
 * `attested`, per ALP.md Section 11 ("The merge is display-only"). A caller
 * that re-sorts, filters, or otherwise reorders this function's output
 * changes nothing about either source chain's verification result.
 *
 * `origin` is derived from WHICH argument an entry came from
 * (`verified`/`attested`), never re-derived from the entry's own `chain`
 * field — this keeps the tag a property of the merge call itself, not a
 * second, potentially-divergent read of data the chain's own verification
 * already covers.
 */

import type { ReceiptEntry } from "@stint/spec";

/** Which chain a merged timeline entry came from — display-only, no integrity meaning (D-10). */
export type TimelineOrigin = "verified" | "attested";

/** A single receipt entry tagged with the chain it came from, for display purposes only. */
export interface TimelineEntry {
  readonly origin: TimelineOrigin;
  readonly entry: ReceiptEntry;
}

/**
 * Stable, deterministic ordering: primarily by `ts`, then by `origin`
 * (`"attested" < "verified"` lexically, applied consistently), then by
 * `seq` — so two entries with an identical timestamp never collide or
 * silently merge; each retains its own origin tag and position. This
 * ordering is a display convenience only (D-10) and carries no integrity
 * meaning; re-sorting the output by any other key changes nothing about
 * either source chain's own verification result.
 */
function compareTimelineEntries(a: TimelineEntry, b: TimelineEntry): number {
  if (a.entry.ts !== b.entry.ts) return a.entry.ts - b.entry.ts;
  if (a.origin !== b.origin) return a.origin < b.origin ? -1 : 1;
  return a.entry.seq - b.entry.seq;
}

/**
 * Merges `verified` and `attested` into one display-only timeline, each
 * entry tagged with the chain it came from. Every input entry appears
 * exactly once in the output; neither input array (nor any entry within
 * it) is ever mutated — `verified`/`attested` may be `Object.freeze`d and
 * this function still succeeds. `mergeTimeline([], [])` returns `[]`; a
 * single non-empty input returns just that chain's entries, tagged.
 */
export function mergeTimeline(
  verified: readonly ReceiptEntry[],
  attested: readonly ReceiptEntry[],
): readonly TimelineEntry[] {
  const tagged: TimelineEntry[] = [
    ...verified.map((entry): TimelineEntry => ({ origin: "verified", entry })),
    ...attested.map((entry): TimelineEntry => ({ origin: "attested", entry })),
  ];

  return tagged.sort(compareTimelineEntries);
}
