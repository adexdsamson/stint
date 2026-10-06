/**
 * `stint cleanup <leaseId>` (D-12): one command that auto-detects what to do.
 *
 *   completed | expired | revoked | failed | tearing_down -> run teardown
 *   cleanup_incomplete                                     -> retry teardown (idempotent resume)
 *   cleaned_up                                             -> no-op success
 *   granted | active (not expired)                         -> refuse: use revoke
 *   proposed | declined                                    -> refuse: never activated
 *
 * An `active` lease past `expiresAt` is settled through `settleExpired` from
 * `@stint/runtime` first (A9: nothing else applies the clock `expire` event
 * today), so an expired-but-unsettled lease can be torn down. Resume and
 * idempotency are entirely the orchestrator's: a step already recorded as
 * succeeded is not re-run and the lease never returns to `active`.
 *
 * Teardown is assembled by the runtime (`resolveTeardown`). A recorded credential
 * the store cannot produce blocks it: the orchestrator receipts that once and
 * throws `TeardownBlockedError`, which becomes a usage error naming the recovery.
 */

import type { Lease } from "@stint/core";
import { TeardownBlockedError } from "@stint/proxy";
import { settleExpired } from "@stint/runtime";

import { seedFromCredentials } from "../custody.js";
import type { CliDeps } from "../deps.js";
import { CliError, EXIT_CODES } from "../exit.js";
import { blockedTeardownMessage } from "../messages.js";
import { assertSafeLeaseId, resolveStoreRoot } from "../paths.js";
import { toCliError } from "../runtime-errors.js";
import { confirmOrDecline, reportTeardown, resolveLeaseTeardown, withFenceWait } from "./teardown-support.js";
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

  const now = deps.clock();
  const first = route(lease, now);
  if (first === "refuse") throw refusal(lease);
  if (first === "noop") {
    if (opts.json !== true) deps.io.err("stint: Nothing to do; the lease is already cleaned up.\n");
    return reportTeardown(deps, opts, root, lease, { noop: true });
  }

  // No pre-refusal on missing credentials: the orchestrator's preflight must run so the
  // block is receipted (TEAR-07). `revoke_oauth` is attempted once and never re-run (D-23),
  // so a credentials file only matters while it has not been recorded yet.
  const { ports, resolved, fileCredentials } = await resolveLeaseTeardown(
    deps,
    root,
    leaseId,
    opts,
  );

  const question =
    first === "retry"
      ? "Retry teardown for this lease? [y/N] "
      : "Run teardown for this lease? [y/N] ";
  const declined = await confirmOrDecline(deps, question, opts.yes);
  if (declined !== undefined) return declined;

  // Seed only after consent, so a declined cleanup leaves nothing under the secrets root.
  if (
    fileCredentials !== undefined &&
    lease.teardownProgress?.revoke_oauth === undefined &&
    resolved.expectedResources.length > 0
  ) {
    await seedFromCredentials(deps, ports, leaseId, fileCredentials);
  }

  let current: Lease = lease;
  if (first === "settle") {
    // Settling is the runtime's job (D-24): the state change and its receipt commit together.
    try {
      const settled = await settleExpired(
        {
          leases: store,
          receipts: (id) => deps.receiptStoreFactory(root, id),
          clock: deps.clock,
          telemetry: deps.telemetry,
        },
        leaseId,
      );
      current = settled.lease;
    } catch (err) {
      throw toCliError(err);
    }
  }

  const next = route(current, deps.clock());
  if (next === "refuse" || next === "settle") throw refusal(current);
  if (next === "noop") return reportTeardown(deps, opts, root, current, { noop: true });

  let finished: Lease;
  try {
    // D-13: another driver's live fence is waited out (bounded), never torn down underneath.
    finished = await withFenceWait(deps, store, leaseId, () =>
      next === "retry" ? resolved.retry("user", deps.clock()) : resolved.run(deps.clock()),
    );
  } catch (err) {
    if (err instanceof TeardownBlockedError) {
      throw new CliError(EXIT_CODES.usage, blockedTeardownMessage(leaseId, err.resources));
    }
    throw err;
  }
  return reportTeardown(deps, opts, root, finished);
}
