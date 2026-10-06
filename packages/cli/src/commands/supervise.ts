/**
 * `stint-cli supervise --once` (Phase 9 SUP-01, D-05, D-20, D-21): one sweep of
 * the store. Every lease past `expiresAt` is settled and every ended lease is
 * torn down through the runtime's fenced teardown, with no other user action.
 * The sweep itself is the host-agnostic `runSweep` in `@stint/runtime`; this
 * file only builds the ports, renders each event and returns an exit code.
 *
 * Output is quiet: a sweep that changes nothing prints nothing. Human lines go
 * to stderr, one per action. Under `--json` each action is one JSON object per
 * line on stdout and no human line is printed. Every line is fixed text; only
 * a lease id (already validated by `assertSafeLeaseId`), a closed enum value or
 * a resource name that passes `sanitizeForTerminal` is ever interpolated, and
 * no secret, token, record content or upstream error text is printed.
 *
 * Without `--once` the command refuses: the long-running loop arrives in a
 * later plan (D-21).
 */

import { runSweep } from "@stint/runtime";
import type { Lease } from "@stint/core";
import type { SweepEvent } from "@stint/runtime";

import type { CliDeps, GlobalOpts } from "../deps.js";
import { CliError, EXIT_CODES } from "../exit.js";
import {
  sweepCorruptLine,
  sweepExpiredLine,
  sweepLeaseErrorLine,
  sweepRetriedLine,
  sweepStuckLine,
  sweepTornDownLine,
} from "../messages.js";
import { resolveStoreRoot } from "../paths.js";
import { isUnrevokedCleanup, rotateCaveat, stateLabel, unrevokedResources } from "../render/caveat.js";
import { buildRuntimePorts } from "../runtime-ports.js";
import { parseSupervisorConfig } from "./supervise-options.js";

export interface SuperviseOpts extends GlobalOpts {
  readonly once?: boolean | undefined;
  /** Seconds, as the string commander hands over; validated by `parseSupervisorConfig`. */
  readonly retryBase?: string | undefined;
  readonly retryMax?: string | undefined;
  readonly retryCap?: string | undefined;
}

/** The JSON object for one event: scalar fields only. */
async function jsonFor(deps: CliDeps, root: string, event: SweepEvent): Promise<Record<string, unknown>> {
  switch (event.kind) {
    case "expired":
      return { event: "expired", leaseId: event.leaseId };
    case "torn_down":
      return {
        event: "torn_down",
        leaseId: event.leaseId,
        state: event.lease.state,
        unrevoked: await unrevokedFor(deps, root, event.leaseId, event.lease),
      };
    case "corrupt_record":
      return { event: "corrupt_record", leaseId: event.leaseId, reason: "store_corrupt" };
    case "lease_error":
      return { event: "lease_error", leaseId: event.leaseId };
    case "retried":
      return { event: "retried", leaseId: event.leaseId, attempt: event.attempt, state: event.lease.state };
    case "stuck":
      return { event: "stuck", leaseId: event.leaseId, reason: event.reason, attempts: event.attempts };
  }
}

/** The resources whose credential was never revoked upstream, from the verified chain (SPEC-07). Empty unless the lease is an unrevoked cleanup. */
async function unrevokedFor(
  deps: CliDeps,
  root: string,
  leaseId: string,
  lease: Lease,
): Promise<readonly string[]> {
  if (!isUnrevokedCleanup(lease)) return [];
  return unrevokedResources(await deps.receiptStoreFactory(root, leaseId).load("verified"));
}

async function renderHuman(deps: CliDeps, root: string, event: SweepEvent): Promise<void> {
  switch (event.kind) {
    case "expired":
      deps.io.err(`stint: ${sweepExpiredLine(event.leaseId)}\n`);
      return;
    case "torn_down":
      deps.io.err(`stint: ${sweepTornDownLine(event.leaseId, stateLabel(event.lease))}\n`);
      for (const resource of await unrevokedFor(deps, root, event.leaseId, event.lease)) {
        deps.io.err(`stint: ${rotateCaveat(resource)}\n`);
      }
      return;
    case "corrupt_record":
      deps.io.err(`stint: ${sweepCorruptLine(event.leaseId)}\n`);
      return;
    case "lease_error":
      deps.io.err(`stint: ${sweepLeaseErrorLine(event.leaseId)}\n`);
      return;
    case "retried":
      deps.io.err(`stint: ${sweepRetriedLine(event.leaseId, event.attempt, stateLabel(event.lease))}\n`);
      for (const resource of await unrevokedFor(deps, root, event.leaseId, event.lease)) {
        deps.io.err(`stint: ${rotateCaveat(resource)}\n`);
      }
      return;
    case "stuck":
      deps.io.err(`stint: ${sweepStuckLine(event.leaseId, event.reason)}\n`);
      return;
  }
}

async function sweepOnce(deps: CliDeps, opts: SuperviseOpts): Promise<number> {
  if (opts.once !== true) {
    throw new CliError(EXIT_CODES.usage, "Pass --once to run a single sweep.");
  }
  // Validate every flag before any store access.
  const config = parseSupervisorConfig(opts);
  const root = resolveStoreRoot(opts);
  const ports = buildRuntimePorts(deps, root);
  const json = opts.json === true;

  await runSweep(ports, {
    config,
    ...(deps.teardown?.decorateSteps === undefined ? {} : { decorateSteps: deps.teardown.decorateSteps }),
    onEvent: async (event) => {
      if (json) {
        deps.io.out(`${JSON.stringify(await jsonFor(deps, root, event))}\n`);
      } else {
        await renderHuman(deps, root, event);
      }
    },
  });
  return EXIT_CODES.ok;
}

export async function superviseCommand(deps: CliDeps, opts: SuperviseOpts): Promise<number> {
  try {
    return await sweepOnce(deps, opts);
  } catch (error) {
    // stderr only, like `run`: a supervisor's output may be piped to a log shipper.
    if (error instanceof CliError) {
      deps.io.err(`stint: ${error.safeMessage}\n`);
      return error.code;
    }
    deps.io.err("stint: Internal error.\n");
    return EXIT_CODES.internal;
  }
}
