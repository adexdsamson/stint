/**
 * `stint inspect <leaseId>`: read-only view of a lease's state, limits, and
 * counters. Never mutates the store. The lease record carries the duration
 * limit and counters; per-action limits (max_actions, spend, ...) live in the
 * signed manifest that the lease is bound to by hash, not in the lease record.
 */

import type { Lease } from "@stint/core";

import { sanitizeForTerminal } from "../adapter/sanitize.js";
import type { CliDeps, GlobalOpts } from "../deps.js";
import { CliError, EXIT_CODES } from "../exit.js";
import { assertSafeLeaseId, resolveStoreRoot } from "../paths.js";

export type InspectOpts = GlobalOpts;

function iso(epochSeconds: number): string {
  return Number.isFinite(epochSeconds) ? new Date(epochSeconds * 1000).toISOString() : "unknown";
}

export async function inspectCommand(
  deps: CliDeps,
  leaseId: string,
  opts: InspectOpts,
): Promise<number> {
  assertSafeLeaseId(leaseId);
  const json = opts.json === true;
  const lease = await deps.storeFactory(resolveStoreRoot(opts)).load(leaseId);
  if (lease === undefined) {
    throw new CliError(EXIT_CODES.leaseNotFound, "Lease not found.");
  }

  if (json) {
    deps.io.out(`${JSON.stringify(lease)}\n`);
    return EXIT_CODES.ok;
  }

  deps.io.out(`${renderLease(lease, deps.clock(), deps.style(false))}\n`);
  return EXIT_CODES.ok;
}

function renderLease(lease: Lease, now: number, style: ReturnType<CliDeps["style"]>): string {
  const s = sanitizeForTerminal;
  const lines: string[] = [];
  const section = (title: string): void => {
    lines.push("", style.header(title));
  };
  const row = (text: string): void => {
    lines.push(`  ${text}`);
  };

  lines.push(style.header(`Lease ${s(lease.id)}`));
  row(`state: ${s(lease.state)}`);
  row(`version: ${String(lease.version)}`);
  row(`bound manifest hash: ${s(lease.boundHash)}`);
  if (lease.state === "active" && lease.expiresAt > 0 && now >= lease.expiresAt) {
    row(
      style.dim("note: past its expiry; it will be settled as expired on the next run or cleanup"),
    );
  }

  section("Limits");
  row(`max duration: ${String(lease.maxDurationSeconds)}s`);
  row(`granted at: ${lease.grantedAt > 0 ? iso(lease.grantedAt) : "not granted"}`);
  row(`expires at: ${lease.expiresAt > 0 ? iso(lease.expiresAt) : "not set"}`);

  section("Counters");
  row(`actions: ${String(lease.counters.actionCount)}`);
  row(`spent (minor units): ${String(lease.counters.spentMinor)}`);
  row(`recent denial errors: ${String(lease.counters.denialErrorTimestamps.length)}`);
  row(`actions in rate window: ${String(lease.counters.actionTimestamps.length)}`);

  if (lease.teardownProgress !== undefined) {
    section("Teardown");
    for (const [step, outcome] of Object.entries(lease.teardownProgress)) {
      row(`${s(step)}: ${s(outcome)}`);
    }
  }
  return lines.join("\n");
}
