/**
 * `stint revoke <leaseId>` (D-13): a user-actor revoke that auto-chains teardown.
 *
 *   load -> [refuse unless granted/active] -> build real-vault TeardownDeps ->
 *   [y/N] -> transaction(reduce(userEvents.revoke)) -> transition receipt ->
 *   runTeardown (auto-chains begin_teardown) -> report
 *
 * The actor is always `user`; the agent is never an actor for ending a lease.
 * All teardown behaviour belongs to the Phase-5 orchestrator.
 */

import { reduce, userEvents } from "@stint/core";
import type { TransitionRecord } from "@stint/core";
import { appendTransitionReceipt, runTeardown } from "@stint/proxy";

import type { CliDeps } from "../deps.js";
import { CliError, EXIT_CODES } from "../exit.js";
import { assertSafeLeaseId, resolveStoreRoot } from "../paths.js";
import { buildTeardownDeps, confirmOrDecline, reportTeardown } from "./teardown-support.js";
import type { TeardownCommandOpts } from "./teardown-support.js";

export type RevokeOpts = TeardownCommandOpts;

export async function revokeCommand(
  deps: CliDeps,
  leaseId: string,
  opts: RevokeOpts,
): Promise<number> {
  assertSafeLeaseId(leaseId);
  const root = resolveStoreRoot(opts);
  const store = deps.storeFactory(root);

  const lease = await store.load(leaseId);
  if (lease === undefined) throw new CliError(EXIT_CODES.leaseNotFound, "Lease not found.");
  if (lease.state !== "granted" && lease.state !== "active") {
    // `state` is validated against the fixed STATES vocabulary when the lease is loaded.
    throw new CliError(
      EXIT_CODES.wrongState,
      `The lease is ${lease.state}; only a granted or active lease can be revoked. Use "stint cleanup" for a lease that has ended.`,
    );
  }

  // Built before any state change so a missing credentials file fails without touching the lease.
  const teardown = await buildTeardownDeps(deps, root, leaseId, opts, true);

  const declined = await confirmOrDecline(deps, "Revoke this lease? [y/N] ", opts.yes);
  if (declined !== undefined) return declined;

  const now = deps.clock();
  let record: TransitionRecord | undefined;
  await store.transaction(leaseId, (current) => {
    const result = reduce(current, userEvents.revoke(), now);
    if (!result.ok) {
      throw new CliError(
        EXIT_CODES.wrongState,
        "The lease can no longer be revoked from its current state.",
      );
    }
    record = result.value.transition;
    return result.value.lease;
  });
  if (record !== undefined) {
    await appendTransitionReceipt(teardown.receiptStore, record, now);
  }

  const finished = await runTeardown(teardown, deps.clock());
  return reportTeardown(deps, opts, finished);
}
