/**
 * The supervisor's single-instance lock (Phase 9 SUP-07, D-21): one supervisor
 * sweeps a store at a time, in either mode. It is a `proper-lockfile` lock on
 * `<store>/supervisor/supervisor`, the same mkdir-based mechanism the lease
 * store already uses, so it works on Windows.
 *
 * The lock survives a hard kill (Task Scheduler "End", `taskkill`, power loss)
 * until it is stale, so a restart right after one waits for the old lock to go
 * stale instead of refusing: acquisition retries every 250 ms for the stale
 * time plus two seconds, then refuses with exit 8. While the holder lives the
 * library refreshes the lock; if the refresh fails (the directory was removed,
 * or the host stalled past the stale time) the `compromised` promise resolves
 * and the loop must stop sweeping. The library's default `onCompromised` throws
 * from a timer callback and would crash the process, so a handler that only
 * records it is always supplied.
 *
 * The fence still guarantees one teardown driver per lease if this lock were
 * ever bypassed; the lock only stops two supervisors racing probes and output.
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import lockfile from "proper-lockfile";

import { CliError, EXIT_CODES } from "../exit.js";
import { supervisorBusyMessage } from "../messages.js";
import { supervisorDir } from "../paths.js";

/** proper-lockfile refuses a stale time under 5000 ms. */
const MIN_STALE_MS = 5000;
const DEFAULT_STALE_MS = 10_000;
/** How long past the stale time a restart keeps trying before it refuses (T-09-44). */
const ACQUIRE_SLACK_MS = 2000;
const RETRY_EVERY_MS = 250;

function errnoCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

export interface SupervisorLockOptions {
  /** How long a lock whose holder stopped refreshing it is kept; default 10000, never below 5000. */
  readonly staleMs?: number | undefined;
  /** How long to keep trying while a live holder has the lock; default the stale time plus 2000. */
  readonly acquireWindowMs?: number | undefined;
}

export interface SupervisorLock {
  /** Releases the lock. Safe to call more than once; never throws. */
  release(): Promise<void>;
  /** Resolves (never rejects) when the lock is lost while held: the holder must stop sweeping. */
  readonly compromised: Promise<void>;
}

/**
 * Takes the supervisor lock for the store at `root`, creating `<root>/supervisor`
 * when missing. Rejects with a `CliError` of exit 8 and the fixed busy message
 * when a live holder keeps it past the acquisition window.
 */
export async function acquireSupervisorLock(root: string, opts: SupervisorLockOptions = {}): Promise<SupervisorLock> {
  const staleMs = Math.max(MIN_STALE_MS, opts.staleMs ?? DEFAULT_STALE_MS);
  const windowMs = opts.acquireWindowMs ?? staleMs + ACQUIRE_SLACK_MS;
  const dir = supervisorDir(root);
  await mkdir(dir, { recursive: true });
  const target = path.join(dir, "supervisor");

  let markCompromised: () => void = () => undefined;
  const compromised = new Promise<void>((resolve) => {
    markCompromised = resolve;
  });

  const deadline = Date.now() + windowMs;
  let release: () => Promise<void>;
  for (;;) {
    try {
      release = await lockfile.lock(target, {
        realpath: false, // the target is never created, only its `.lock` directory
        stale: staleMs,
        retries: 0, // this loop owns the retry budget so the window is exact
        onCompromised: () => {
          markCompromised();
        },
      });
      break;
    } catch (error) {
      if (errnoCode(error) !== "ELOCKED") throw error;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new CliError(EXIT_CODES.leaseBusy, supervisorBusyMessage());
      await delay(Math.min(RETRY_EVERY_MS, remaining));
    }
  }

  let released = false;
  return {
    compromised,
    release: async () => {
      if (released) return;
      released = true;
      try {
        await release();
      } catch {
        // already lost or removed: nothing left to release
      }
    },
  };
}
