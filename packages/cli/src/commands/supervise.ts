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
 *
 * Clock guard (SUP-06, D-19): when the wall clock jumps forward by more than
 * `--clock-jump-threshold` seconds (default 3600) beyond the monotonic time that passed
 * since the previous sweep, the supervisor prints one line with the jump and the fix,
 * stops settling lease expiry and keeps retrying, tearing down ended leases and probing.
 * The pause is a marker file in the store, so a restart and `--once` honour it too.
 * `stint-cli supervise --confirm-clock`, run from another terminal or a script, writes a
 * confirmation bound to the current pause; it takes no lock and asks nothing. The running
 * supervisor accepts it on its next sweep and resumes expiry. A marker that cannot be read
 * keeps expiry paused, `--once` exits 10 for it and `--confirm-clock` refuses it (exit 10).
 */

import { RuntimeError, createSweepState, runSweep } from "@stint/runtime";
import type { Lease } from "@stint/core";
import type {
  RunSweepOptions,
  RuntimePorts,
  SupervisorConfig,
  SweepEvent,
  SweepState,
} from "@stint/runtime";

import type { CliDeps, GlobalOpts } from "../deps.js";
import { CliError, EXIT_CODES } from "../exit.js";
import {
  confirmClockDoneLine,
  confirmClockNoPauseLine,
  sweepClockConfirmedLine,
  sweepClockMarkerUnreadableLine,
  sweepClockPausedLine,
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
import {
  isUnrevokedCleanup,
  rotateCaveat,
  stateLabel,
  unrevokedResources,
} from "../render/caveat.js";
import { buildRuntimePorts } from "../runtime-ports.js";
import { StoreCorruptError } from "../store/atomic-file.js";
import { createFileSupervisorControl } from "../store/supervisor-control.js";
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
  /** Seconds of forward clock jump that pause lease expiry; validated by `parseSupervisorConfig`. */
  readonly clockJumpThreshold?: string | undefined;
  /** Confirm the clock after a reported jump (writes the confirmation and exits); not valid with `--once`. */
  readonly confirmClock?: boolean | undefined;
}

/** What the sweep counts as corrupt stored data: this CLI's store error or the runtime's `store_corrupt`. */
function isStoreCorrupt(error: unknown): boolean {
  return (
    error instanceof StoreCorruptError ||
    (error instanceof RuntimeError && error.code === "store_corrupt")
  );
}

/** The JSON object for one event: scalar fields only. */
async function jsonFor(
  deps: CliDeps,
  root: string,
  event: SweepEvent,
): Promise<Record<string, unknown>> {
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
      return {
        event: "retried",
        leaseId: event.leaseId,
        attempt: event.attempt,
        state: event.lease.state,
      };
    case "stuck":
      return {
        event: "stuck",
        leaseId: event.leaseId,
        reason: event.reason,
        attempts: event.attempts,
        repeat: event.repeat,
      };
    case "clock_paused":
      return { event: "clock_paused", jumpSeconds: event.jumpSeconds, repeat: event.repeat };
    case "clock_confirmed":
      return { event: "clock_confirmed" };
    case "clock_marker_unreadable":
      return { event: "clock_marker_unreadable" };
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
      deps.io.err(
        `stint: ${sweepRetriedLine(event.leaseId, event.attempt, stateLabel(event.lease))}\n`,
      );
      for (const resource of await unrevokedFor(deps, root, event.leaseId, event.lease)) {
        deps.io.err(`stint: ${rotateCaveat(resource)}\n`);
      }
      return;
    case "stuck":
      deps.io.err(`stint: ${sweepStuckLine(event.leaseId, event.reason)}\n`);
      return;
    case "clock_paused":
      deps.io.err(`stint: ${sweepClockPausedLine(event.jumpSeconds)}\n`);
      return;
    case "clock_confirmed":
      deps.io.err(`stint: ${sweepClockConfirmedLine()}\n`);
      return;
    case "clock_marker_unreadable":
      deps.io.err(`stint: ${sweepClockMarkerUnreadableLine()}\n`);
      return;
  }
}

/** What every sweep, in either mode, is given besides the event sink and the stop signal. */
function sweepOptions(
  deps: CliDeps,
  config: SupervisorConfig,
  state: SweepState,
  root: string,
): RunSweepOptions {
  const monotonicMs = deps.supervise?.monotonicMs;
  return {
    config,
    state,
    isStoreCorrupt,
    // The pause and its confirmation live in the store, so every sweep of either mode honours them (D-19).
    control: createFileSupervisorControl(root),
    ...(monotonicMs === undefined ? {} : { monotonicMs }),
    // The stuck line already names the lease, the reason and the fix. A second generic terminal line
    // would break one line per action (D-20); other hosts get the event through the same seam (D-04).
    notify: () => Promise.resolve(),
    ...(deps.teardown?.decorateSteps === undefined
      ? {}
      : { decorateSteps: deps.teardown.decorateSteps }),
  };
}

/** Renders one event: a JSON object on stdout under `--json`, else the fixed human line(s) on stderr. */
async function renderEvent(
  deps: CliDeps,
  root: string,
  json: boolean,
  event: SweepEvent,
): Promise<void> {
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
  const marker = { unreadable: false };
  // One state for the run: a stuck lease is announced once here, never on every event.
  const state = createSweepState();

  await runSweep(ports, {
    ...sweepOptions(deps, config, state, root),
    onEvent: async (event) => {
      if (event.kind === "stuck") stuckLeases.add(event.leaseId);
      if (event.kind === "corrupt_record") corruptLeases.add(event.leaseId);
      if (event.kind === "clock_marker_unreadable") marker.unreadable = true;
      await renderEvent(deps, root, json, event);
    },
  });
  if (corruptLeases.size > 0 || marker.unreadable) return EXIT_CODES.storeCorrupt;
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
          ...sweepOptions(deps, config, state, root),
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
  if (lost() && !stop.aborted)
    throw new CliError(EXIT_CODES.leaseBusy, supervisorLockLostMessage());
  return EXIT_CODES.ok;
}

/**
 * `--confirm-clock` (SUP-06, D-19): writes a confirmation bound to the current pause and returns. No lock, no
 * prompt and no sweep, so it works from another terminal or a script while a supervisor runs. With no pause
 * it writes nothing. A pause marker that cannot be read is a `StoreCorruptError` (exit 10) and is left as is.
 */
async function confirmClock(deps: CliDeps, root: string, json: boolean): Promise<number> {
  const control = createFileSupervisorControl(root);
  const pause = await control.readPause();
  if (pause === undefined) {
    if (json) deps.io.out(`${JSON.stringify({ event: "no_clock_pause" })}\n`);
    else deps.io.err(`stint: ${confirmClockNoPauseLine()}\n`);
    return EXIT_CODES.ok;
  }
  await control.writeConfirm({ v: 1, id: pause.id });
  if (json) deps.io.out(`${JSON.stringify({ event: "clock_confirm_written" })}\n`);
  else deps.io.err(`stint: ${confirmClockDoneLine()}\n`);
  return EXIT_CODES.ok;
}

async function runSupervise(deps: CliDeps, opts: SuperviseOpts): Promise<number> {
  // Validate every flag before any store access.
  const config = parseSupervisorConfig(opts);
  const intervalSeconds = parseSweepInterval(opts);
  const json = opts.json === true;
  if (opts.confirmClock === true) {
    if (opts.once === true)
      throw new CliError(EXIT_CODES.usage, "--confirm-clock cannot be used with --once.");
    return await confirmClock(deps, resolveStoreRoot(opts), json);
  }
  const root = resolveStoreRoot(opts);

  // Signals are listened for before the store and the lock are touched, so a Ctrl-C during startup is
  // also a graceful stop (G-09-1): on Windows a press before this point hits the OS default console
  // handler, which kills the process with STATUS_CONTROL_C_EXIT before any listener exists. Only the
  // long-running mode listens; --once and --confirm-clock keep the default Ctrl-C behaviour, and a
  // host without the seam never aborts. An already-aborted signal is handled by sweepForever, which
  // checks it before the first sweep.
  const noStop = { signal: new AbortController().signal, dispose: (): void => undefined };
  const shutdown = opts.once === true ? noStop : (deps.supervise?.shutdown?.() ?? noStop);
  try {
    const ports = buildRuntimePorts(deps, root);
    // One supervisor per store, in either mode (D-21): refused with exit 8 before any sweep.
    const lock = await acquireSupervisorLock(root, {
      staleMs: deps.supervise?.lockStaleMs,
      acquireWindowMs: deps.supervise?.lockAcquireWindowMs,
    });
    try {
      if (opts.once === true) return await sweepOnceLocked(deps, config, root, ports, json);
      return await sweepForever(
        deps,
        config,
        root,
        ports,
        json,
        intervalSeconds,
        shutdown.signal,
        lock,
      );
    } finally {
      await lock.release();
    }
  } finally {
    shutdown.dispose();
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
