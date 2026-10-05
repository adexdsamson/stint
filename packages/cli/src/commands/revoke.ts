/**
 * `stint revoke <leaseId>` (D-13): a user-actor revoke that auto-chains teardown.
 *
 *   load -> [refuse unless granted/active] -> resolve teardown through the runtime ->
 *   [refuse when a recorded credential is unavailable] -> [y/N] -> seed the store from
 *   --credentials -> transaction(reduce(userEvents.revoke)) -> transition receipt ->
 *   run teardown (auto-chains begin_teardown) -> report
 *
 * The actor is always `user`; the agent is never an actor for ending a lease.
 * All teardown behaviour belongs to `@stint/runtime` and the Phase-5 orchestrator.
 */

import { reduce, userEvents } from "@stint/core";
import { appendTransitionReceipt } from "@stint/proxy";

import { seedFromCredentials } from "../custody.js";
import type { CliDeps } from "../deps.js";
import { CliError, EXIT_CODES } from "../exit.js";
import { assertSafeLeaseId, resolveStoreRoot } from "../paths.js";
import { confirmOrDecline, reportTeardown, resolveLeaseTeardown } from "./teardown-support.js";
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

  // Resolved and checked before any state change, so a missing credential refuses without
  // touching the lease and without a receipt (D-27): that refusal is not a teardown.
  const { ports, resolved, fileCredentials } = await resolveLeaseTeardown(
    deps,
    root,
    leaseId,
    opts,
  );
  const provided = new Set(Object.keys(fileCredentials ?? {}));
  const missing = (await resolved.missingCredentials()).filter(
    (resource) => !provided.has(resource),
  );
  if (missing.length > 0) {
    throw new CliError(
      EXIT_CODES.usage,
      fileCredentials === undefined
        ? "--credentials <file> is required so the lease's OAuth grants can be revoked."
        : "The credentials file does not cover every credential this lease recorded.",
    );
  }

  const declined = await confirmOrDecline(deps, "Revoke this lease? [y/N] ", opts.yes);
  if (declined !== undefined) return declined;

  // Only after consent: a declined revoke leaves nothing under the secrets root.
  if (fileCredentials !== undefined && resolved.expectedResources.length > 0) {
    await seedFromCredentials(deps, ports, leaseId, fileCredentials);
  }

  const now = deps.clock();
  // The state change and its receipt commit under ONE lease lock, so another
  // driver's appends cannot interleave between them (TEAR-06).
  await store.transaction(leaseId, async (current) => {
    const result = reduce(current, userEvents.revoke(), now);
    if (!result.ok) {
      throw new CliError(
        EXIT_CODES.wrongState,
        "The lease can no longer be revoked from its current state.",
      );
    }
    await appendTransitionReceipt(resolved.deps.receiptStore, result.value.transition, now);
    return result.value.lease;
  });

  const finished = await resolved.run(deps.clock());
  return reportTeardown(deps, opts, root, finished);
}
