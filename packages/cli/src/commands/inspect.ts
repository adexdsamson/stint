/**
 * `stint inspect <leaseId>`: read-only view of a lease's state, limits, and
 * counters. Never mutates the store. The lease record carries the duration
 * limit and counters; per-action limits (max_actions, spend, ...) live in the
 * signed manifest that the lease is bound to by hash, not in the lease record.
 */

import type { Lease } from "@stint/core";
import type { ReceiptEntry } from "@stint/spec";

import { sanitizeForTerminal } from "../adapter/sanitize.js";
import type { CliDeps, GlobalOpts } from "../deps.js";
import { CliError, EXIT_CODES } from "../exit.js";
import { assertSafeLeaseId, resolveStoreRoot } from "../paths.js";
import { isUnrevokedCleanup, leaseLabel, rotateCaveat, unrevokedResources } from "../render/caveat.js";

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
  const root = resolveStoreRoot(opts);
  const lease = await deps.storeFactory(root).load(leaseId);
  if (lease === undefined) {
    throw new CliError(EXIT_CODES.leaseNotFound, "Lease not found.");
  }

  if (json) {
    deps.io.out(`${JSON.stringify(lease)}\n`);
    return EXIT_CODES.ok;
  }

  // The caveat names each credential the user must rotate, and the stuck label names why the
  // supervisor gave up; both come from the verified receipts, read once.
  const chain = await loadChain(deps, root, lease);
  const unrevoked = isUnrevokedCleanup(lease) ? unrevokedResources(chain) : [];
  deps.io.out(`${renderLease(lease, deps.clock(), deps.style(false), unrevoked, chain)}\n`);
  return EXIT_CODES.ok;
}

/**
 * The verified chain, when something shown depends on it. A chain that cannot be read only costs a
 * stuck label (inspect stays a read-only view that works); the unrevoked caveat still fails loudly.
 */
async function loadChain(deps: CliDeps, root: string, lease: Lease): Promise<readonly ReceiptEntry[]> {
  const needsCaveat = isUnrevokedCleanup(lease);
  if (lease.state === "cleaned_up" && !needsCaveat) return [];
  try {
    return await deps.receiptStoreFactory(root, lease.id).load("verified");
  } catch (error) {
    if (needsCaveat) throw error;
    return [];
  }
}

function renderLease(
  lease: Lease,
  now: number,
  style: ReturnType<CliDeps["style"]>,
  unrevoked: readonly string[],
  chain: readonly ReceiptEntry[],
): string {
  const s = sanitizeForTerminal;
  const lines: string[] = [];
  const section = (title: string): void => {
    lines.push("", style.header(title));
  };
  const row = (text: string): void => {
    lines.push(`  ${text}`);
  };

  lines.push(style.header(`Lease ${s(lease.id)}`));
  row(`state: ${s(leaseLabel(lease, chain))}`);
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

  // The create-bound job parameters (10-05, SPEC-08), one row per bound value in
  // declaration order; absent entirely for pre-phase leases. The values are not
  // secrets (they were shown at consent), and both name and value are sanitized.
  if (lease.jobParameters !== undefined) {
    section("Job parameters");
    for (const [name, value] of Object.entries(lease.jobParameters)) {
      row(`${s(name)}: ${s(typeof value === "number" ? String(value) : value)}`);
    }
  }

  if (lease.teardownProgress !== undefined) {
    section("Teardown");
    for (const [step, outcome] of Object.entries(lease.teardownProgress)) {
      row(`${s(step)}: ${s(outcome)}`);
    }
  }
  if (unrevoked.length > 0) {
    section("Teardown caveat");
    for (const resource of unrevoked) row(rotateCaveat(resource));
  }
  return lines.join("\n");
}
