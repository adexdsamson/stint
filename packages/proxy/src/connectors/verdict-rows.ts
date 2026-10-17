/**
 * `verdictRowAdapter` -- the named built-in row adapter for the Paystack verify
 * route (Phase 10, D-C). `runResourceQueryVerification` requires a binding's
 * `rowAdapter`, and a JSON run profile cannot carry a function, so the profile
 * names this one adapter by string (the CLI maps `"verdict"` to it in 10-06).
 *
 * The verify connector already returns `{ rows: [{ verdict, ...allowlisted }] }`;
 * this adapter is the defensive pass-through plus projection over it. A
 * malformed body yields NO rows, so a malformed response can never satisfy the
 * `exists(rows where verdict = 'confirmed') >= 1` predicate.
 */

import type { ConnectorRowAdapter } from "@stint/core";

import { TRANSACTION_VERDICTS, allowlistTransactionData } from "./paystack-verify.js";

export const verdictRowAdapter: ConnectorRowAdapter = (result) => {
  const body = result.body;
  if (typeof body !== "object" || body === null || !("rows" in body) || !Array.isArray(body.rows)) {
    return { rows: [] };
  }
  const rows: Array<Record<string, unknown>> = [];
  for (const row of body.rows as unknown[]) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) continue;
    const raw = (row as Record<string, unknown>)["verdict"];
    const verdict = typeof raw === "string" && TRANSACTION_VERDICTS.has(raw) ? raw : "unknown";
    // Re-project through the same allowlist: even a row built elsewhere cannot widen what the predicate sees.
    rows.push({ verdict, ...allowlistTransactionData(row) });
  }
  return { rows };
};
