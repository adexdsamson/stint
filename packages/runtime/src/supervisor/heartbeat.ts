/**
 * The live-run heartbeat (Phase 9 D-18). A `run` writes a `run_heartbeat`
 * artifact for its lease every `RUN_HEARTBEAT_INTERVAL_SECONDS`, lock-free
 * (the writer is plan 09-08). The supervisor reads it before probing a grant:
 * refreshing the grant's rotating refresh token while a live run serves the
 * lease could make the provider revoke the whole token family, so a live run
 * is never probed.
 */

import { parseRunHeartbeat } from "@stint/core";
import type { LeaseArtifactStore, RunHeartbeat } from "@stint/core";

/** How often a live run refreshes its heartbeat, in seconds. */
export const RUN_HEARTBEAT_INTERVAL_SECONDS = 10;

/** A beat this old or newer, with no `endedAt`, means a run is live, in seconds. */
export const RUN_LIVE_WINDOW_SECONDS = 45;

/**
 * Whether a run is serving `leaseId` at `now` (whole epoch seconds). Absent
 * artifact: false. A beat at most 45 s old with no `endedAt`: true; a future
 * beat counts as live. An unparseable value or a failed read counts as live,
 * because probing beside a live run risks the whole token family while a
 * skipped probe only delays detection to the next call.
 */
export async function isRunLive(artifacts: LeaseArtifactStore, leaseId: string, now: number): Promise<boolean> {
  let raw: unknown;
  try {
    raw = await artifacts.get(leaseId, "run_heartbeat");
  } catch {
    return true;
  }
  if (raw === undefined) return false;
  const beat = parseRunHeartbeat(raw);
  if (beat === undefined) return true;
  if (beat.endedAt !== undefined) return false;
  return now - beat.beatAt <= RUN_LIVE_WINDOW_SECONDS;
}

/** Publishes `beat` for `leaseId`; a plain artifact write, no lease lock. */
export async function writeRunHeartbeat(
  artifacts: LeaseArtifactStore,
  leaseId: string,
  beat: RunHeartbeat,
): Promise<void> {
  await artifacts.put(leaseId, "run_heartbeat", beat);
}
