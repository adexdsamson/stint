/**
 * The abortable sleep of the `supervise` loop (Phase 9 D-21, T-09-42). It is the
 * only timer the supervisor arms: one bounded wait between sweeps, never a
 * per-lease timer. It resolves, and never rejects, when the signal aborts, so a
 * stop request ends the wait at once. The caller bounds `ms` (a whole number of
 * seconds, at most 2147483), so it can never exceed the 2^31-1 ms timer limit.
 */

import { setTimeout as delay } from "node:timers/promises";

export async function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  try {
    await delay(ms, undefined, { signal });
  } catch {
    // an aborted wait is the normal way out; nothing to report
  }
}
