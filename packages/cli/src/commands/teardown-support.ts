/**
 * Shared wiring for `revoke` and `cleanup`. Both are thin hosts over
 * `@stint/runtime`: `resolveLeaseTeardown` asks the runtime to assemble the
 * lease's teardown (`resolveTeardown`) from the CLI's storage ports, and
 * `reportTeardown` prints the result. There is no teardown logic, no vault and
 * no step construction here.
 *
 * Credentials live in the `SecretStore`, not in this process: the optional
 * `--credentials` file is parsed here (a malformed file fails before any
 * prompt) but only copied into the store, by the calling command, once the user
 * has confirmed. A credential the store cannot produce makes the runtime's
 * preflight block the teardown honestly instead of receipting a false success.
 */

import { setTimeout as delay } from "node:timers/promises";

import type { Lease, LeaseStore } from "@stint/core";
import { DEFAULT_FENCE_TTL_SECONDS, TeardownFencedError } from "@stint/proxy";
import { resolveTeardown } from "@stint/runtime";
import type { ResolvedTeardown, RuntimePorts } from "@stint/runtime";

import type { CliDeps, GlobalOpts } from "../deps.js";
import { CliError, EXIT_CODES } from "../exit.js";
import { teardownBusyMessage } from "../messages.js";
import { isUnrevokedCleanup, rotateCaveat, stateLabel, unrevokedResources } from "../render/caveat.js";
import type { LoadedCredential } from "../run/credentials.js";
import { buildRuntimePorts } from "../runtime-ports.js";
import { toCliError } from "../runtime-errors.js";

export interface TeardownCommandOpts extends GlobalOpts {
  readonly yes?: boolean | undefined;
  readonly credentials?: string | undefined;
}

/**
 * Resolves the runtime teardown for one lease and parses the optional
 * credentials file. Does NOT seed the store: the caller does that after the
 * user confirms, so declining leaves nothing written. A thrown `RuntimeError`
 * becomes the matching `CliError`.
 */
export async function resolveLeaseTeardown(
  deps: CliDeps,
  root: string,
  leaseId: string,
  opts: TeardownCommandOpts,
): Promise<{
  readonly ports: RuntimePorts;
  readonly resolved: ResolvedTeardown;
  readonly fileCredentials: Readonly<Record<string, LoadedCredential>> | undefined;
}> {
  const ports = buildRuntimePorts(deps, root);
  const fileCredentials =
    opts.credentials === undefined || opts.credentials === ""
      ? undefined
      : await deps.credentials.load(opts.credentials);
  try {
    const resolved = await resolveTeardown(ports, {
      leaseId,
      ...(deps.teardown?.decorateSteps === undefined
        ? {}
        : { decorateSteps: deps.teardown.decorateSteps }),
    });
    return { ports, resolved, fileCredentials };
  } catch (error) {
    throw toCliError(error);
  }
}

/** One poll of the fence wait: a second, matching the one-second granularity of lease time. */
const FENCE_POLL_MS = 1000;
/** Total wait for another driver's live fence: the same budget as the lease lock (user resolution 5). */
const DEFAULT_FENCE_WAIT_MS = 30_000;

/**
 * Runs one teardown attempt for a user's `revoke` or `cleanup` (D-13). When
 * another driver (a supervisor, a live `run`, another command) holds a live
 * teardown fence the attempt is refused with `TeardownFencedError("held")` before
 * any step runs; this waits for that driver quietly, polling once a second for
 * at most 30 s, and then:
 *
 * - the other driver landed the lease (fence released, state `cleaned_up` or
 *   `cleanup_incomplete`): that lease is returned, so the user sees one honest
 *   outcome and no step ran here;
 * - the fence was released without landing, or expired (a crashed holder): the
 *   attempt runs again, taking the fence over with a receipt;
 * - the fence is still live when the wait runs out: exit 8 with the fixed
 *   `teardownBusyMessage` naming `stint-cli cleanup <id>`.
 *
 * A `stale` fence error and every other error propagate unchanged. Nothing is
 * printed while waiting.
 */
export async function withFenceWait(
  deps: CliDeps,
  store: LeaseStore,
  leaseId: string,
  attempt: () => Promise<Lease>,
): Promise<Lease> {
  const sleep = deps.teardown?.sleep ?? ((ms: number) => delay(ms));
  const budgetMs = deps.teardown?.fenceWaitMs ?? DEFAULT_FENCE_WAIT_MS;
  let waitedMs = 0;

  for (;;) {
    try {
      return await attempt();
    } catch (error) {
      if (!(error instanceof TeardownFencedError) || error.kind !== "held") throw error;
    }

    // Wait until the other driver lets go, lands the lease, or its fence lapses.
    for (;;) {
      if (waitedMs >= budgetMs) {
        throw new CliError(EXIT_CODES.leaseBusy, teardownBusyMessage(leaseId));
      }
      await sleep(FENCE_POLL_MS);
      waitedMs += FENCE_POLL_MS;

      const current = await store.load(leaseId);
      if (current === undefined) throw new CliError(EXIT_CODES.leaseNotFound, "Lease not found.");
      const fence = current.fence;
      const at = deps.clock();
      // Mirrors the proxy's rule: live means in the future and no more than one TTL ahead.
      const live =
        fence !== undefined && fence.expiresAt > at && fence.expiresAt - at <= DEFAULT_FENCE_TTL_SECONDS;
      if (live) continue;
      const released = fence === undefined || fence.expiresAt === 0;
      if (released && (current.state === "cleaned_up" || current.state === "cleanup_incomplete")) {
        return current;
      }
      break;
    }
  }
}

/**
 * The `[y/N]` gate before a destructive action. Returns an exit code when the
 * user declined (nothing changed), or `undefined` to proceed. With no terminal
 * and no `--yes` it refuses, so consent is never assumed.
 */
export async function confirmOrDecline(
  deps: CliDeps,
  question: string,
  yes: boolean | undefined,
): Promise<number | undefined> {
  if (yes === true) return undefined;
  const answer = await deps.confirm?.(question);
  if (answer === undefined) {
    throw new CliError(
      EXIT_CODES.usage,
      "No interactive terminal is available to confirm; pass --yes to proceed.",
    );
  }
  if (!answer) {
    deps.io.err("stint: Aborted; nothing was changed.\n");
    return EXIT_CODES.consentDeclined;
  }
  return undefined;
}

/** Prints the resulting state and points at the signed trail; maps it to an exit code. */
export async function reportTeardown(
  deps: CliDeps,
  opts: GlobalOpts,
  root: string,
  lease: Lease,
  extra: Readonly<Record<string, unknown>> = {},
): Promise<number> {
  const done = lease.state === "cleaned_up";
  const incomplete = lease.state === "cleanup_incomplete";
  if (!done && !incomplete) {
    throw new CliError(EXIT_CODES.internal, "Internal error.");
  }
  const progress = lease.teardownProgress ?? {};
  // SPEC-07: a cleaned-up lease can still hold a credential that was never revoked upstream.
  // Exit 0 is always paired with this caveat, derived from the verified chain.
  const unrevoked = isUnrevokedCleanup(lease)
    ? unrevokedResources(await deps.receiptStoreFactory(root, lease.id).load("verified"))
    : [];

  if (opts.json === true) {
    deps.io.out(
      `${JSON.stringify({ leaseId: lease.id, state: lease.state, teardown: progress, unrevoked, ...extra })}\n`,
    );
  } else {
    deps.io.out(`Lease ${lease.id}: ${stateLabel(lease)}\n`);
    for (const [step, outcome] of Object.entries(progress)) {
      deps.io.out(`  ${step}: ${outcome}\n`);
    }
    for (const resource of unrevoked) {
      deps.io.err(`stint: ${rotateCaveat(resource)}\n`);
    }
    if (incomplete) {
      deps.io.err(
        `stint: Teardown did not finish. Run "stint-cli cleanup ${lease.id}" to resume it.\n`,
      );
    }
    deps.io.err(
      `stint: See the signed per-step trail with "stint-cli receipts ${lease.id}" and "stint-cli verify ${lease.id}".\n`,
    );
  }
  return done ? EXIT_CODES.ok : EXIT_CODES.cleanupIncomplete;
}
