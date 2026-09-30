/**
 * `activateLease` and `resumeLease` — the two guarded entry points that
 * bind lease activation and resume to the manifest content hash consented
 * to at grant time (LIFE-03). Both consume the ONE shared `verifyBoundHash`
 * guard (D-21): the safety-critical re-check lives inside the tested pure
 * core, not in either caller, so no future caller can forget it.
 *
 * `activateLease` (granted -> active|failed): a hash match dispatches
 * `runtimeEvents.activate()`; a mismatch dispatches
 * `runtimeEvents.activationFailed()` (ALP.md Section 7.4 activate guard).
 *
 * `resumeLease` (active, post-restart): a hash mismatch dispatches
 * `runtimeEvents.runtimeFailure()` — the distinct resume-path failure event
 * (ALP.md Section 7.5). A match is not itself a state-changing event in
 * Section 7.4, so a matching resume returns an ok Result with the lease
 * unchanged and no `TransitionRecord` (nothing to record — no transition
 * occurred).
 *
 * Only the pure content-hash guard is implemented here. Acquiring delegated
 * grants and issuing the license are the other activate guards in ALP.md
 * Section 7.4, but they are I/O and belong to Phases 3-4 — later callers
 * check those preconditions before calling `activateLease`.
 */

import { reduce } from "./lease.js";
import type { Lease, TransitionRecord } from "./lease.js";
import { runtimeEvents } from "./events.js";
import { verifyBoundHash } from "./hash-guard.js";
import type { Result } from "./errors.js";
import type { VerifiedManifest } from "@stint/spec";

export function activateLease(
  lease: Lease,
  verifiedManifest: VerifiedManifest,
  now: number,
): Result<{ lease: Lease; transition: TransitionRecord }> {
  const matches = verifyBoundHash(lease.boundHash, verifiedManifest);
  const event = matches ? runtimeEvents.activate() : runtimeEvents.activationFailed();
  return reduce(lease, event, now);
}

export function resumeLease(
  lease: Lease,
  verifiedManifest: VerifiedManifest,
  now: number,
): Result<{ lease: Lease; transition: TransitionRecord | undefined }> {
  const matches = verifyBoundHash(lease.boundHash, verifiedManifest);
  if (matches) {
    return { ok: true, value: { lease, transition: undefined } };
  }
  return reduce(lease, runtimeEvents.runtimeFailure(), now);
}
