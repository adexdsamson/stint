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
 * A lease that is stuck (D-01, D-04) prints one stuck line naming the reason and
 * the exact fix, once per run, and makes `--once` exit 7 so cron can alert. No
 * flag abandons a stuck lease or declares its credential handled (D-03).
 *
 * An idle active lease is probed at its provider every `--probe-interval` seconds
 * (default 900, 0 disables). A revoked grant prints one line and the lease is torn
 * down; a probe that fails any other way prints nothing (SUP-04, D-15, D-17).
 *
 * A lease record the store cannot read, or a lease whose receipts, envelope or
 * secrets are corrupt, is reported once as one line naming the lease id and
 * `store_corrupt` (never the file contents) and skipped; the sweep carries on
 * with every other lease and never modifies, renames or deletes the corrupt file.
 * `--once` then exits 10, which takes precedence over the 7 of a stuck lease
 * (SUP-05, D-23).
 *
 * Without `--once` the command is a long-running loop (SUP-07, D-21, D-22):
 * it sweeps, sleeps `--sweep-interval` seconds (default 30) and repeats until it
 * is told to stop. A stop request (Ctrl-C) lets the pass in flight finish its
 * current step, starts nothing new, releases the pass's fence and the store lock
 * and exits 0; a second signal terminates at once. An idle sweep prints nothing and
 * the loop prints no startup or heartbeat line. In either mode a second supervisor
 * on the same store is refused with exit 8, and a supervisor whose lock is lost
 * stops sweeping and exits 8. Signals reach this file only through the injected
 * `deps.supervise.shutdown` seam; it never reads the host runtime directly.
 */

import { RuntimeError, createSweepState, runSweep } from "@stint/runtime";
import type { Lease } from "@stint/core";
import type { RunSweepOptions, RuntimePorts, SupervisorConfig, SweepEvent, SweepState } from "@stint/runtime";

import type { CliDeps, GlobalOpts } from "../deps.js";
import { CliError, EXIT_CODES } from "../exit.js";
import {
  sweepCorruptLine,
  supervisorLockLostMessage,
  sweepExpiredLine,
  sweepFailedLine,
  sweepGrantRevokedLine,
  sweepLeaseErrorLine,
  sweepRetriedLine,
  sweepStuckLine,
  sweepTornDownLine,
} from "../messages.js";
import { resolveStoreRoot } from "../paths.js";
import { isUnrevokedCleanup, rotateCaveat, stateLabel, unrevokedResources } from "../render/caveat.js";
import { buildRuntimePorts } from "../runtime-ports.js";
import { StoreCorruptError } from "../store/atomic-file.js";
import { acquireSupervisorLock } from "../store/supervisor-lock.js";
import type { SupervisorLock } from "../store/supervisor-lock.js";
import { abortableSleep } from "../supervise-timing.js";
import { parseSupervisorConfig, parseSweepInterval } from "./supervise-options.js";

export interface SuperviseOpts extends GlobalOpts {
  readonly once?: boolean | undefined;
  /** Seconds, as the string commander hands over; validated by `parseSupervisorConfig`. */
  readonly retryBase?: string | undefined;
  readonly retryMax?: string | undefined;
  readonly retryCap?: string | undefined;
  /** Seconds between grant probes of an idle lease; `0` disables; validated by `parseSupervisorConfig`. */
  readonly probeInterval?: string | undefined;
  /** Seconds before an unchanged corrupt record is reported again; validated by `parseSupervisorConfig`. */
  readonly corruptRepeat?: string | undefined;
  /** Seconds between sweeps in the long-running mode; validated by `parseSweepInterval`. */
  readonly sweepInterval?: string | undefined;
}

/** What the sweep counts as corrupt stored data: this CLI's store error or the runtime's `store_corrupt`. */
function isStoreCorrupt(error: unknown): boolean {
  return error instanceof StoreCorruptError || (error instanceof RuntimeError && error.code === "store_corrupt");
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
      return { event: "corrupt_record", leaseId: event.leaseId };
    case "lease_error":
      return { event: "lease_error", leaseId: event.leaseId };
    case "grant_revoked":
      return { event: "grant_revoked", leaseId: event.leaseId };
    case "retried":
      return { event: "retried", leaseId: event.leaseId, attempt: event.attempt, state: event.lease.state };
    case "stuck":
      return {
        event: "stuck",
        leaseId: event.leaseId,
        reason: event.reason,
        attempts: event.attempts,
        repeat: event.repeat,
      };
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
    case "grant_revoked":
      deps.io.err(`stint: ${sweepGrantRevokedLine(event.leaseId)}\n`);
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

/** What every sweep, in either mode, is given besides the event sink and the stop signal. */
function sweepOptions(deps: CliDeps, config: SupervisorConfig, state: SweepState): RunSweepOptions {
  return {
    config,
    state,
    isStoreCorrupt,
    // The stuck line already names the lease, the reason and the fix. A second generic terminal line
    // would break one line per action (D-20); other hosts get the event through the same seam (D-04).
    notify: () => Promise.resolve(),
    ...(deps.teardown?.decorateSteps === undefined ? {} : { decorateSteps: deps.teardown.decorateSteps }),
  };
}

/** Renders one event: a JSON object on stdout under `--json`, else the fixed human line(s) on stderr. */
async function renderEvent(deps: CliDeps, root: string, json: boolean, event: SweepEvent): Promise<void> {
  if (json) {
    deps.io.out(`${JSON.stringify(await jsonFor(deps, root, event))}\n`);
  } else {
    await renderHuman(deps, root, event);
  }
}

/** One sweep, then the exit code cron reads: 10 for a corrupt record, ahead of 7 for a stuck lease, else 0 (D-23, D-04). */
async function sweepOnceLocked(
  deps: CliDeps,
  config: SupervisorConfig,
  root: string,
  ports: RuntimePorts,
  json: boolean,
): Promise<number> {
  const stuckLeases = new Set<string>();
  const corruptLeases = new Set<string>();
  // One state for the run: a stuck lease is announced once here, never on every event.
  const state = createSweepState();

  await runSweep(ports, {
    ...sweepOptions(deps, config, state),
    onEvent: async (event) => {
      if (event.kind === "stuck") stuckLeases.add(event.leaseId);
      if (event.kind === "corrupt_record") corruptLeases.add(event.leaseId);
      await renderEvent(deps, root, json, event);
    },
  });
  if (corruptLeases.size > 0) return EXIT_CODES.storeCorrupt;
  return stuckLeases.size > 0 ? EXIT_CODES.cleanupIncomplete : EXIT_CODES.ok;
}

/**
 * The long-running mode (SUP-07, D-21, D-22): sweep, sleep one bounded interval, repeat until told to
 * stop. One `SweepState` spans the whole loop so a stuck lease is re-announced once, the probe schedule
 * survives and a corrupt record is reported once per change or quiet period. A stop request (`stop`) or
 * a lost lock ends the loop: the pass in flight stops between steps and no new lease is started. A
 * sweep that fails as a whole is told once per failure streak and retried at the next interval.
 */
async function sweepForever(
  deps: CliDeps,
  config: SupervisorConfig,
  root: string,
  ports: RuntimePorts,
  json: boolean,
  intervalSeconds: number,
  stop: AbortSignal,
  lock: SupervisorLock,
): Promise<number> {
  const sleep = deps.supervise?.sleep ?? abortableSleep;
  const state = createSweepState();

  // One signal for everything the loop awaits: the operator's stop request or a lost lock.
  const halt = new AbortController();
  let lockLost = false;
  // Read through functions: a bare read after an await or in a loop is narrowed by control-flow analysis.
  const lost = (): boolean => lockLost;
  const halted = (): boolean => halt.signal.aborted;
  const onStop = (): void => {
    halt.abort();
  };
  if (stop.aborted) onStop();
  else stop.addEventListener("abort", onStop, { once: true });
  void lock.compromised.then(() => {
    lockLost = true;
    halt.abort();
  });

  let failing = false;
  try {
    while (!halted()) {
      try {
        await runSweep(ports, {
          ...sweepOptions(deps, config, state),
          onEvent: (event) => renderEvent(deps, root, json, event),
          signal: halt.signal,
        });
        failing = false;
      } catch {
        if (!failing) {
          if (json) deps.io.out(`${JSON.stringify({ event: "sweep_failed" })}\n`);
          else deps.io.err(`stint: ${sweepFailedLine()}\n`);
        }
        failing = true;
      }
      if (halted()) break;
      await sleep(intervalSeconds * 1000, halt.signal);
    }
  } finally {
    stop.removeEventListener("abort", onStop);
  }
  if (lost() && !stop.aborted) throw new CliError(EXIT_CODES.leaseBusy, supervisorLockLostMessage());
  return EXIT_CODES.ok;
}

async function runSupervise(deps: CliDeps, opts: SuperviseOpts): Promise<number> {
  // Validate every flag before any store access.
  const config = parseSupervisorConfig(opts);
  const intervalSeconds = parseSweepInterval(opts);
  const root = resolveStoreRoot(opts);
  const ports = buildRuntimePorts(deps, root);
  const json = opts.json === true;

  // One supervisor per store, in either mode (D-21): refused with exit 8 before any sweep.
  const lock = await acquireSupervisorLock(root, {
    staleMs: deps.supervise?.lockStaleMs,
    acquireWindowMs: deps.supervise?.lockAcquireWindowMs,
  });
  try {
    if (opts.once === true) return await sweepOnceLocked(deps, config, root, ports, json);
    // Signals are listened for only in the long-running mode; a host without the seam never aborts.
    const shutdown = deps.supervise?.shutdown?.() ?? { signal: new AbortController().signal, dispose: () => undefined };
    try {
      return await sweepForever(deps, config, root, ports, json, intervalSeconds, shutdown.signal, lock);
    } finally {
      shutdown.dispose();
    }
  } finally {
    await lock.release();
  }
}

export async function superviseCommand(deps: CliDeps, opts: SuperviseOpts): Promise<number> {
  try {
    return await runSupervise(deps, opts);
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
