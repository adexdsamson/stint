/**
 * Windows-safe atomic JSON file primitives for the JSON `LeaseStore` (HOST-03).
 *
 * Chain per mutation: per-key in-process queue -> `proper-lockfile` lock on the
 * target file -> read -> mutate -> atomic write (temp file + rename), with every
 * fs call wrapped in a bounded transient-error retry, because concurrent
 * readers on Windows make rename/open fail with EPERM/EBUSY/EACCES (RESEARCH
 * Pitfall 1). Nothing here ever logs or embeds file contents in an error.
 */

import { readFile } from "node:fs/promises";

import lockfile from "proper-lockfile";
import writeFileAtomic from "write-file-atomic";

import { CliError, EXIT_CODES } from "../exit.js";

/** The transient fs error codes graceful-fs also retries on win32. */
const TRANSIENT = new Set(["EPERM", "EBUSY", "EACCES"]);

/** Default total wait for a contended lease lock (Pitfall 5). */
export const DEFAULT_LOCK_TIMEOUT_MS = 30_000;

/** Another operation holds the lease lock past the lock budget (CLI-01 concurrency edge). */
export class LeaseBusyError extends CliError {
  constructor() {
    super(
      EXIT_CODES.leaseBusy,
      "The lease is busy: another operation holds it (a call may be awaiting approval). Answer it or wait for its timeout, then retry.",
    );
    this.name = "LeaseBusyError";
  }
}

/** A lease/receipt file on disk is torn, unreadable JSON, or not the expected shape. */
export class StoreCorruptError extends CliError {
  constructor() {
    super(EXIT_CODES.storeCorrupt, "The lease store contains a corrupt or unreadable file.");
    this.name = "StoreCorruptError";
  }
}

function errnoCode(e: unknown): string | undefined {
  if (typeof e === "object" && e !== null && "code" in e) {
    const code = e.code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs `op`, retrying on EPERM/EBUSY/EACCES with jittered backoff (capped at
 * ~100ms per attempt) up to `maxAttempts` total attempts, then rethrows.
 * Anything else (e.g. ENOSPC) is rethrown immediately with no retry.
 */
export async function withTransientRetry<T>(
  op: () => Promise<T>,
  maxAttempts = 50,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await op();
    } catch (e) {
      const code = errnoCode(e);
      if (code === undefined || !TRANSIENT.has(code) || attempt + 1 >= maxAttempts) throw e;
      await sleep(Math.min(5 * 2 ** Math.min(attempt, 5), 100) * (0.5 + Math.random()));
    }
  }
}

/** Atomically replaces `file` with `value` as JSON (temp file + rename, fsync'd), with transient retry. */
export function atomicWriteJson(file: string, value: unknown): Promise<void> {
  // write-file-atomic unlinks its temp file in `finally`, so retrying the whole call is safe.
  return withTransientRetry(() => writeFileAtomic(file, JSON.stringify(value), { fsync: true }));
}

/**
 * Lock-free JSON read with transient retry. Resolves `undefined` when the
 * file does not exist; throws `StoreCorruptError` (with a fixed message, never
 * the file contents) on unparseable JSON.
 */
export async function readJsonRetry(file: string): Promise<unknown> {
  let text: string;
  try {
    text = await withTransientRetry(() => readFile(file, "utf8"));
  } catch (e) {
    if (errnoCode(e) === "ENOENT") return undefined;
    throw e;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new StoreCorruptError();
  }
}

/** Per-key in-process serializer: same key runs strictly one after another; different keys are independent. */
export function createKeyedQueue(): <T>(key: string, work: () => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<unknown>>();
  return function runSerialized<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previousTail = tails.get(key) ?? Promise.resolve();
    // Swallow a prior failure so one rejected task never wedges the chain.
    const next = previousTail.catch(() => undefined).then(work);
    const tail = next.catch(() => undefined);
    tails.set(key, tail);
    // Drop the entry once this task is the last one, so the map cannot grow unbounded.
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return next;
  };
}

export interface FileLockOptions {
  /** Total time to wait for the lock before throwing `LeaseBusyError`. */
  readonly timeoutMs?: number;
}

/**
 * Runs `work` while holding a cross-process lock on `file` (the lock target
 * need not exist yet). `work` receives `assertHeld()`, which throws if the lock
 * was compromised (stale/lost) — call it between mutate and write so a lost
 * lock never produces a stale overwrite (Pitfall 3). `onCompromised` only
 * RECORDS the error; the library default throws from a timer callback and
 * would crash the process.
 */
export async function withFileLock<T>(
  file: string,
  work: (assertHeld: () => void) => Promise<T>,
  opts: FileLockOptions = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let compromised: Error | undefined;

  let release: () => Promise<void>;
  for (let attempt = 0; ; attempt++) {
    try {
      release = await lockfile.lock(file, {
        realpath: false, // lock target may not exist yet (first save)
        stale: 10_000, // heartbeat keeps a live holder fresh through long approval waits
        retries: 0, // we own the retry loop so the total budget is exact
        onCompromised: (e) => {
          compromised = e;
        },
      });
      break;
    } catch (e) {
      if (errnoCode(e) !== "ELOCKED" && !TRANSIENT.has(errnoCode(e) ?? "")) throw e;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new LeaseBusyError();
      await defaultSleep(
        Math.min(
          Math.min(10 * 1.2 ** Math.min(attempt, 20), 100) * (0.5 + Math.random()),
          remaining,
        ),
      );
    }
  }

  const assertHeld = (): void => {
    if (compromised !== undefined) throw compromised;
  };
  try {
    return await work(assertHeld);
  } finally {
    await release().catch(() => undefined);
  }
}
