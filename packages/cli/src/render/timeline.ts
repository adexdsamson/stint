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
import { UNREVOKED_STATE_SUFFIX, unrevokedResources } from "./caveat.js";
import type { Style } from "./style.js";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A sanitized string field of an entry payload; a missing or non-string value renders as `?`. */
function field(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === "string" ? sanitizeForTerminal(value) : "?";
}

/** A fence epoch from an entry payload: a safe integer renders as itself, anything else as `?`. */
function epochField(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  return typeof value === "number" && Number.isSafeInteger(value) ? String(value) : "?";
}

function isoTimestamp(ts: unknown): string {
  if (typeof ts !== "number") return "unknown time";
  const date = new Date(ts * 1000);
  return Number.isNaN(date.getTime()) ? "unknown time" : date.toISOString();
}

/** Appended to a `revoke_oauth` line that names a credential the provider was never asked to revoke. */
const ROTATE_SUFFIX = " (not revoked upstream; rotate it in the provider dashboard)";

function describe(entry: ReceiptEntry, hasUnrevoked: boolean): string {
  const payload: Record<string, unknown> = isRecord(entry.payload) ? entry.payload : {};
  const type: string = entry.type;
  switch (type) {
    case "call": {
      const outcome = field(payload, "outcome");
      const summary = field(payload, "redactedSummary");
      return `call ${outcome} on ${field(payload, "resource")}: ${summary}`;
    }
    case "transition": {
      // The caveat rides on the transition into cleaned_up so the end state is never read as "all revoked".
      const to = field(payload, "to");
      const target = to === "cleaned_up" && hasUnrevoked ? `${to}${UNREVOKED_STATE_SUFFIX}` : to;
      return `lease ${field(payload, "from")} -> ${target} (${field(payload, "event")} by ${field(payload, "actor")})`;
    }
    case "teardown_step": {
      const base = `teardown ${field(payload, "step")}: ${field(payload, "outcome")}`;
      if (typeof payload.resource !== "string") return base;
      const named = `${base} for ${field(payload, "resource")}`;
      return payload.outcome === "discarded_revocation_unsupported" ? `${named}${ROTATE_SUFFIX}` : named;
    }
    case "teardown_blocked": {
      // Read defensively: a hand-edited receipt may carry any shape.
      const resources = payload.resources;
      const names =
        Array.isArray(resources) && resources.length > 0 && resources.every((r): r is string => typeof r === "string")
          ? resources.map((r) => sanitizeForTerminal(r)).join(", ")
          : undefined;
      return names === undefined
        ? "teardown blocked: credentials unavailable"
        : `teardown blocked: credentials unavailable for ${names}`;
    }
    case "teardown_takeover":
      // A later driver took over a fence a crashed driver never released (Phase 9 D-10).
      return `teardown takeover: epoch ${epochField(payload, "previousEpoch")} -> ${epochField(payload, "epoch")} (${field(payload, "reason")})`;
    case "attested_claim":
      return `publisher ${field(payload, "publisherId")} claims ${field(payload, "claimType")} (not verified by the runtime)`;
    default:
      return "unrecognized receipt entry";
  }
}

/** Renders one sanitized line per timeline entry, in the order given (`mergeTimeline` order). */
export function renderTimeline(entries: readonly TimelineEntry[], style: Style): string[] {
  // Only the verified chain can establish what teardown did; an attested entry is publisher-claimed.
  const hasUnrevoked =
    unrevokedResources(entries.filter((e) => e.origin === "verified").map((e) => e.entry)).length >
    0;
  return entries.map(({ origin, entry }) => {
    const tag = origin === "verified" ? style.verified("[verified]") : style.attested("[attested]");
    return `${isoTimestamp(entry.ts)} ${tag} ${describe(entry, hasUnrevoked)}`;
  });
}
