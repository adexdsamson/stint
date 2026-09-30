/**
 * Plain-language rendering of the merged receipt timeline (D-06, CLI-02).
 *
 * One line per entry: ISO timestamp, a `[verified]`/`[attested]` tag, and a
 * description. Only fields that are already secretless by type are shown
 * (`resource`, `outcome`, the binding-redacted summary, transition and teardown
 * vocabulary); `argsHash` and signatures are never printed. Every value read
 * from a receipt is passed through `sanitizeForTerminal` because a receipt file
 * is on-disk data an attacker may have edited (terminal-injection defense).
 */

import type { TimelineEntry } from "@stint/core";
import type { ReceiptEntry } from "@stint/spec";

import { sanitizeForTerminal } from "../adapter/sanitize.js";
import type { Style } from "./style.js";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A sanitized string field of an entry payload; a missing or non-string value renders as `?`. */
function field(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === "string" ? sanitizeForTerminal(value) : "?";
}

function isoTimestamp(ts: unknown): string {
  if (typeof ts !== "number") return "unknown time";
  const date = new Date(ts * 1000);
  return Number.isNaN(date.getTime()) ? "unknown time" : date.toISOString();
}

function describe(entry: ReceiptEntry): string {
  const payload: Record<string, unknown> = isRecord(entry.payload) ? entry.payload : {};
  const type: string = entry.type;
  switch (type) {
    case "call": {
      const outcome = field(payload, "outcome");
      const summary = field(payload, "redactedSummary");
      return `call ${outcome} on ${field(payload, "resource")}: ${summary}`;
    }
    case "transition":
      return `lease ${field(payload, "from")} -> ${field(payload, "to")} (${field(payload, "event")} by ${field(payload, "actor")})`;
    case "teardown_step":
      return `teardown ${field(payload, "step")}: ${field(payload, "outcome")}`;
    case "attested_claim":
      return `publisher ${field(payload, "publisherId")} claims ${field(payload, "claimType")} (not verified by the runtime)`;
    default:
      return "unrecognized receipt entry";
  }
}

/** Renders one sanitized line per timeline entry, in the order given (`mergeTimeline` order). */
export function renderTimeline(entries: readonly TimelineEntry[], style: Style): string[] {
  return entries.map(({ origin, entry }) => {
    const tag = origin === "verified" ? style.verified("[verified]") : style.attested("[attested]");
    return `${isoTimestamp(entry.ts)} ${tag} ${describe(entry)}`;
  });
}
