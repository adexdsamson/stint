/**
 * `stint cleanup <leaseId>` (D-12): one command that auto-detects what to do.
 *
 *   completed | expired | revoked | failed | tearing_down -> runTeardown
 *   cleanup_incomplete                                     -> retryTeardown (idempotent resume)
 *   cleaned_up                                             -> no-op success
 *   granted | active (not expired)                         -> refuse: use revoke
 *   proposed | declined                                    -> refuse: never activated
 *
 * An `active` lease past `expiresAt` is settled with `clockEvents.expire()`
 * first (A9: nothing else applies that event today), so an expired-but-unsettled
 * lease can be torn down. Resume/idempotency is entirely the orchestrator's:
 * a step already recorded as succeeded is not re-run and the lease never
 * returns to `active`.
 */

import { clockEvents, reduce } from "@stint/core";
import type { Lease, TransitionRecord } from "@stint/core";
import { appendTransitionReceipt, retryTeardown, runTeardown } from "@stint/proxy";

import type { CliDeps } from "../deps.js";
import { CliError, EXIT_CODES } from "../exit.js";
import { assertSafeLeaseId, resolveStoreRoot } from "../paths.js";
import { buildTeardownDeps, confirmOrDecline, reportTeardown } from "./teardown-support.js";
import type { TeardownCommandOpts } from "./teardown-support.js";

export type CleanupOpts = TeardownCommandOpts;

type Route = "teardown" | "retry" | "noop" | "settle" | "refuse";

function route(lease: Lease, now: number): Route {
  switch (lease.state) {
    case "completed":
    case "expired":
    case "revoked":
    case "failed":
    case "tearing_down":
      return "teardown";
    case "cleanup_incomplete":
      return "retry";
    case "cleaned_up":
      return "noop";
    case "granted":
    case "active":
      return lease.expiresAt > 0 && now >= lease.expiresAt ? "settle" : "refuse";
    case "proposed":
    case "declined":
      return "refuse";
  }
}

function refusal(lease: Lease): CliError {
  if (lease.state === "granted" || lease.state === "active") {
    return new CliError(EXIT_CODES.wrongState, "The lease has not ended; use revoke.");
  }
  return new CliError(
    EXIT_CODES.wrongState,
    "The lease was never activated; there is nothing to clean up.",
  );
}

export async function cleanupCommand(
  deps: CliDeps,
  leaseId: string,
  opts: CleanupOpts,
): Promise<number> {
  assertSafeLeaseId(leaseId);
  const root = resolveStoreRoot(opts);
  const store = deps.storeFactory(root);

  const lease = await store.load(leaseId);
  if (lease === undefined) throw new CliError(EXIT_CODES.leaseNotFound, "Lease not found.");

  let now = deps.clock();
  const first = route(lease, now);
  if (first === "refuse") throw refusal(lease);
  if (first === "noop") {
    if (opts.json !== true) deps.io.err("stint: Nothing to do; the lease is already cleaned up.\n");
    return reportTeardown(deps, opts, lease, { noop: true });
  }

  // `revoke_oauth` is attempted once and never re-run (D-23), so the credentials file is
  // only needed while it has not been recorded yet.
  const needsCredentials = lease.teardownProgress?.revoke_oauth === undefined;
  const teardown = await buildTeardownDeps(deps, root, leaseId, opts, needsCredentials);

  const question =
    first === "retry"
      ? "Retry teardown for this lease? [y/N] "
      : "Run teardown for this lease? [y/N] ";
  const declined = await confirmOrDecline(deps, question, opts.yes);
  if (declined !== undefined) return declined;

  let current: Lease = lease;
  if (first === "settle") {
    now = deps.clock();
    let record: TransitionRecord | undefined;
    current = await store.transaction(leaseId, (fresh) => {
      const result = reduce(fresh, clockEvents.expire(), now);
      // Something else moved the lease first; carry on from whatever state it is in now.
      if (!result.ok) return fresh;
      record = result.value.transition;
      return result.value.lease;
    });
    if (record !== undefined) {
      await appendTransitionReceipt(teardown.receiptStore, record, now);
    }
  }

  const next = route(current, deps.clock());
  if (next === "refuse" || next === "settle") throw refusal(current);
  if (next === "noop") return reportTeardown(deps, opts, current, { noop: true });

  const finished =
    next === "retry"
      ? await retryTeardown(teardown, "user", deps.clock())
      : await runTeardown(teardown, deps.clock());
  return reportTeardown(deps, opts, finished);
}
