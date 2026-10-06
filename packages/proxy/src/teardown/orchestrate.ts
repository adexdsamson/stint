/**
 * `runTeardown`/`retryTeardown` -- the fixed 5-step saga coordinator
 * (TEAR-01, TEAR-04, TEAR-05). Every state change goes through core's pure
 * `reduce()` (D-16); every `LeaseStore` access goes through
 * `runInLeaseTransaction` (D-30) -- this file never calls
 * `leaseStore.load`/`.save` directly, only the serialized `.transaction()`
 * primitive, so a resume can never observe a torn write.
 *
 * `runTeardown` auto-chains `begin_teardown` from any terminal end state via
 * the shared `chainTeardownIfEnded` helper (D-18), then walks every step not
 * already recorded as succeeded, in fixed order (D-33), appending one
 * `teardown_step` receipt per step (D-24) and persisting its outcome into
 * `teardownProgress` immediately after it runs (D-14) -- so a crash between
 * steps loses no progress. It lands `teardown_succeeded` -> `cleaned_up`
 * only when every step's recorded outcome is a SUCCESS outcome (D-19), else
 * `teardown_incomplete` -> `cleanup_incomplete`; a step failure never aborts
 * the loop (D-15) -- the remaining steps still run. `retryTeardown` is the
 * explicit-only recovery path (D-32): it dispatches `retry_teardown`
 * (legal from `user` or `runtime`) and re-runs exactly the same
 * remaining-steps walk from persisted progress -- `revoke_oauth`, once
 * attempted, is never re-run (D-23). Neither function arms a timer or
 * self-schedules; one pass per call (D-15).
 *
 * Concurrent drivers (Phase 8 TEAR-06): two drivers may run on one lease (a
 * live `run` process and a supervisor, or two CLI processes). Every step runs
 * inside ONE lease transaction that first rechecks the lease against the
 * pass baseline (the `teardownProgress` snapshot read at pass start): a step
 * another driver already recorded, a recorded success, or `revoke_oauth` with
 * any recorded outcome is skipped, so a real outcome is never overwritten by
 * a later pass. A step's outcome and its `teardown_step` receipt, and a
 * transition and its receipt, are written inside the SAME lease transaction,
 * so the receipts of two drivers can never interleave or fork the chain. A
 * rejected entry or landing transition is tolerated rather than thrown: the
 * driver that lost joins the pass in flight, or returns the lease the other
 * driver already landed. `lease.transition` and `teardown.step` telemetry is
 * emitted only for work this driver itself performed.
 *
 * Fencing (Phase 9 D-09 to D-11): with `deps.fence` set, exactly one driver
 * holds a lease's teardown pass. The pass acquires a lease-record fence (see
 * `fence.ts`) before its entry transition, renews it inside every step
 * transaction from a live clock, and releases it in the same write as the
 * landing transition. A second driver is refused while the fence is live: it
 * throws `TeardownFencedError("held")` before any step runs, so a step that
 * failed is never re-run by a racing joiner (this closes the Phase 8 D-29
 * limit for every fenced caller). A crashed driver's fence is taken over once
 * its TTL has passed, inside one lease transaction that appends a verified
 * `teardown_takeover` receipt, and the new driver resumes from
 * `teardownProgress`: no recorded step is repeated. A step that was in flight
 * at the crash may run again (at-least-once), because its outcome was never
 * recorded. A driver whose fence was taken over throws
 * `TeardownFencedError("stale")` and runs no further step. Without
 * `deps.fence` the Phase 8 joining behaviour applies: a second driver joins the
 * pass in flight and cannot be told apart from crash recovery, so it may re-run
 * a step the first driver just recorded as failed (no step ever succeeds twice
 * and the chain never forks).
 *
 * Fail closed on missing credentials (Phase 8 TEAR-07, D-11): when
 * `deps.credentialCheck` is supplied, both entry points first run a PREFLIGHT
 * (never a sixth step, D-02). If revoke_oauth has no recorded outcome and the
 * check reports a credential the lease recorded but the runtime cannot
 * produce, NO step runs, NO transition is performed, NO checkpoint is signed
 * and the lease state is left exactly as it was. One `teardown_blocked`
 * receipt (reason `credentials_unavailable`, the missing resource names
 * de-duplicated and sorted) is appended inside a lease transaction, skipped
 * when the chain tail already records the identical block, and
 * `TeardownBlockedError` is thrown. A check that throws counts as every
 * expected credential missing.
 *
 * `runTeardown` OPTIONALLY signs a SECOND checkpoint bracketing the
 * terminal-transition boundary (D-31, this plan, 05-08): when
 * `deps.signingKey` is supplied, right before any of the 5 fixed steps run
 * -- covering BOTH call shapes production end-transition call sites use
 * (`revocation.ts`'s `applyProviderRevocation`/`applyEntitlementRevocation`
 * and `verification/resource-query.ts`'s `completeViaVerifier`, which chain
 * the terminal transition + `begin_teardown` themselves and pass an
 * already-`tearing_down` lease into `runTeardown`) AND the simpler shape
 * where `runTeardown` performs that auto-chain itself (a lease constructed
 * directly in a terminal end state, e.g. this plan's own
 * `teardown-all-entries.test.ts`). Either way, by the moment this checkpoint
 * signs, the terminal-transition + `begin_teardown` receipts are already
 * appended to the verified chain, so the checkpoint's `headHash`/`count`
 * genuinely anchors "the lease has ended" independently of whichever step
 * outcome follows. Together with `final_receipt`'s (step 5's) own
 * checkpoint, both "lease ended" and "teardown done" become non-repudiable
 * even if teardown never completes -- a crash between the two checkpoints
 * still leaves the earlier one standing (`ReceiptStore.writeCheckpoint`
 * replaces the prior stored checkpoint, but each signed `Checkpoint` value
 * remains independently verifiable via `verifyCheckpoint` regardless of
 * whether it is still the CURRENTLY stored one, D-04/D-09). Omitting
 * `signingKey` (Rule 3 seam widening) keeps every pre-05-08 caller
 * compiling and behaving exactly as before.
 */

import { reduce, runtimeEvents, safeEmit, signCheckpoint, userEvents, verifyChain } from "@stint/core";
import type {
  Lease,
  LeaseStore,
  LifecycleEvent,
  ReceiptEntryInput,
  ReceiptStore,
  Result,
  TeardownFence,
  TeardownProgress,
  TeardownStepOutcome,
  Telemetry,
  TransitionRecord,
} from "@stint/core";
import type { CryptoKey } from "jose";

import { runInLeaseTransaction } from "../concurrency/lease-serializer.js";
import { appendReceiptEntry } from "../receipts/append.js";
import { chainTeardownIfEnded } from "./auto-chain.js";
import {
  TeardownFencedError,
  acquireFence,
  assertFenceHolder,
  releaseFence,
  releasedFence,
  renewedFence,
} from "./fence.js";
import type { FenceToken, TeardownFenceConfig } from "./fence.js";
import { allStepsSucceeded, isSuccessOutcome, recordStepOutcome, remainingSteps } from "./progress.js";
import { runStepOnce } from "./steps.js";
import type { TeardownStep } from "./steps.js";

/**
 * Every construction-time dependency `runTeardown`/`retryTeardown` need.
 * `steps` MUST be exactly the 5 fixed-order `TeardownStep`s (D-33) --
 * production callers build it via `steps.ts`'s `createDefaultTeardownSteps`;
 * fault-matrix tests (Task 2) substitute a forced-failure step for any one
 * name. `notify` is optional, fire-and-forget (D-25) -- reuses the existing
 * `LifecycleEvent` union, never a new interface surface.
 */
export interface TeardownDeps {
  readonly leaseStore: LeaseStore;
  readonly receiptStore: ReceiptStore;
  readonly leaseId: string;
  readonly steps: readonly TeardownStep[];
  readonly notify?: (event: LifecycleEvent) => Promise<void>;
  /**
   * OPTIONAL (Rule 3 seam widening, D-31, this plan 05-08): when supplied,
   * `runTeardown` signs and writes a checkpoint bracketing the
   * terminal-transition boundary, over the verified chain's head at that
   * point -- see this module's own docstring for the full rationale.
   * Omitting it keeps every pre-05-08 caller compiling and behaving exactly
   * as before; only a caller that opts in gets the bracketing checkpoint.
   */
  readonly signingKey?: CryptoKey;
  /**
   * OPTIONAL observational sink (Phase 8): one `teardown.step` event per step
   * this driver ran and one `lease.transition` event per transition this
   * driver performed. A faulty sink never changes an outcome.
   */
  readonly telemetry?: Telemetry;
  /**
   * OPTIONAL (Phase 8 TEAR-07): the credential preflight. Absent keeps the
   * pre-08-08 behavior exactly. See this module's docstring.
   */
  readonly credentialCheck?: TeardownCredentialCheck;
  /**
   * OPTIONAL (Phase 9 D-09): the teardown fence. Absent keeps every code path
   * exactly as before. When supplied, `runTeardown`/`retryTeardown` hold a
   * lease-record fence for the pass; see this module's docstring and
   * `fence.ts`. `clock` is read live for every fence time (never the pass
   * `now`).
   */
  readonly fence?: TeardownFenceConfig;
}

/**
 * The credential preflight contract: `expected` is every resource name the
 * lease recorded a credential for at grant time; `missing` resolves the subset
 * the runtime cannot currently produce. `missing` rejecting is treated as every
 * `expected` credential being missing (fail closed).
 */
export interface TeardownCredentialCheck {
  readonly expected: readonly string[];
  readonly missing: () => Promise<readonly string[]>;
}

/** Fixed message: a resource name is never interpolated (it may be hostile). */
const BLOCKED_MESSAGE = "Teardown is blocked: credentials are unavailable.";

/** Thrown by `runTeardown`/`retryTeardown` when the credential preflight blocks the teardown. `resources` is the normalized list also written to the `teardown_blocked` receipt. */
export class TeardownBlockedError extends Error {
  readonly reason = "credentials_unavailable" as const;
  readonly resources: readonly string[];

  constructor(resources: readonly string[]) {
    super(BLOCKED_MESSAGE);
    this.name = "TeardownBlockedError";
    this.resources = resources;
  }
}

const BLOCKED_RESOURCE_PLACEHOLDER = "unknown";
const BLOCKED_MAX_RESOURCES = 64;
const BLOCKED_MAX_NAME_LENGTH = 128;

/** De-duplicates, replaces an unwritable name (empty or over 128 characters) with `unknown`, sorts ascending and caps at the schema bound, so one missing set always yields one payload. */
function normalizeBlockedResources(names: readonly string[]): string[] {
  const unique = new Set<string>();
  for (const name of names) {
    const writable = typeof name === "string" && name.length >= 1 && name.length <= BLOCKED_MAX_NAME_LENGTH;
    unique.add(writable ? name : BLOCKED_RESOURCE_PLACEHOLDER);
  }
  return [...unique].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).slice(0, BLOCKED_MAX_RESOURCES);
}

function sameResources(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((name, index) => name === b[index]);
}

const TERMINAL_END_STATES: ReadonlySet<Lease["state"]> = new Set(["completed", "expired", "revoked", "failed"]);

function stepByName(steps: readonly TeardownStep[], name: TeardownStep["name"]): TeardownStep {
  const step = steps.find((candidate) => candidate.name === name);
  if (step === undefined) {
    throw new Error(`@stint/proxy: no TeardownStep registered for "${name}".`);
  }
  return step;
}

/** Appends `input` onto the persisted verified chain through the shared conflict-tolerant helper, which reloads the current chain so `seq`/`prevHash` always link to the latest entry. */
async function appendReceipt(receiptStore: ReceiptStore, input: ReceiptEntryInput, now: number): Promise<void> {
  await appendReceiptEntry(receiptStore, input, now);
}

/** A read-only "peek" at the current lease, routed through `runInLeaseTransaction` (identity mutator) so this file never calls `leaseStore.load` directly (D-30). */
function peekLease(deps: TeardownDeps): Promise<Lease> {
  return runInLeaseTransaction(deps.leaseStore, deps.leaseId, (lease) => lease);
}

/**
 * Signs and writes a checkpoint bracketing the terminal-transition boundary
 * (D-31, 05-08): loads the currently-persisted verified chain, verifies it,
 * and -- only if it verifies -- signs a checkpoint over its `headHash`/
 * `count` and writes it. Mirrors `steps.ts`'s `createFinalReceiptStep`
 * discipline exactly (same `verifyChain` + `signCheckpoint` shape), except
 * this is not a fixed teardown step: a chain that fails to verify here is an
 * invariant violation (this function only ever runs immediately after this
 * module's own `appendTransitionReceipt` call, so the chain it loads is
 * necessarily self-consistent), so it throws rather than silently recording
 * a step outcome. Two drivers signing it under a race is harmless.
 */
async function signBracketingCheckpoint(
  receiptStore: ReceiptStore,
  signingKey: CryptoKey,
  now: number,
): Promise<void> {
  const chain = await receiptStore.load("verified");
  const verified = await verifyChain(chain);
  if (!verified.ok) {
    throw new Error(
      "@stint/proxy: verified chain failed to verify before signing the terminal-transition checkpoint (D-31).",
    );
  }
  const checkpoint = await signCheckpoint("verified", verified.value.count, verified.value.headHash, now, signingKey);
  await receiptStore.writeCheckpoint(checkpoint);
}

/**
 * Appends `transition` as a verified-chain `transition` receipt -- exported
 * so a caller that already dispatched a `reduce()` transition inside its
 * OWN per-lease transaction (e.g. `revocation.ts`'s retrofitted
 * `applyProviderRevocation`, chained inside `dispatch.ts`'s existing
 * `runInLeaseTransaction`) can receipt it without opening a second,
 * redundant transaction on the same lease id.
 */
export async function appendTransitionReceipt(
  receiptStore: ReceiptStore,
  transition: TransitionRecord,
  now: number,
): Promise<void> {
  await appendReceipt(
    receiptStore,
    {
      chain: "verified",
      type: "transition",
      payload: { from: transition.from, event: transition.event, actor: transition.actor, to: transition.to },
    },
    now,
  );
}

/** What `applyTransition` did: the lease as it stands after the call, the transition this driver performed (if any) and the rejection code when it performed none. */
interface TransitionAttempt {
  readonly lease: Lease;
  readonly record: TransitionRecord | undefined;
  readonly rejection: string | undefined;
}

function emitTransition(deps: TeardownDeps, record: TransitionRecord): void {
  safeEmit(deps.telemetry, {
    name: "lease.transition",
    leaseId: deps.leaseId,
    from: record.from,
    to: record.to,
    actor: record.actor,
  });
}

function rejectedTransitionError(rejection: string | undefined): Error {
  return new Error(`@stint/proxy: teardown transition rejected: ${rejection ?? "unknown"}.`);
}

function isLanded(state: Lease["state"]): boolean {
  return state === "cleaned_up" || state === "cleanup_incomplete";
}

/**
 * Applies `apply` (a `reduce()`-shaped transition) to the current lease under
 * the per-lease serializer and appends the resulting `TransitionRecord` as a
 * verified-chain receipt INSIDE the same transaction, so the state change and
 * its receipt commit under one lease lock. A rejected transition (another
 * driver already moved the lease) leaves the lease unchanged and is reported
 * through `rejection` rather than thrown; callers decide what it means.
 */
async function applyTransition(
  deps: TeardownDeps,
  now: number,
  apply: (lease: Lease) => Result<{ lease: Lease; transition: TransitionRecord }>,
): Promise<TransitionAttempt> {
  let record: TransitionRecord | undefined;
  let rejection: string | undefined;
  const lease = await runInLeaseTransaction(deps.leaseStore, deps.leaseId, async (current) => {
    const result = apply(current);
    if (!result.ok) {
      rejection = result.errors[0]?.code ?? "unknown";
      return current;
    }
    await appendTransitionReceipt(deps.receiptStore, result.value.transition, now);
    record = result.value.transition;
    return result.value.lease;
  });
  if (record !== undefined) emitTransition(deps, record);
  return { lease, record, rejection };
}

/**
 * Runs one step, persists its outcome into `teardownProgress` (D-14) and
 * appends its `teardown_step` receipt (D-24) inside ONE lease transaction.
 * The mutator first rechecks the lease against the pass `baseline`: it skips
 * the step when the lease is no longer `tearing_down`, when another driver
 * already recorded the step since the baseline was read, when `revoke_oauth`
 * has any recorded outcome (D-23), or when the step already succeeded. A
 * recorded real outcome is therefore never overwritten by a later pass.
 */
async function runStepAndPersist(
  deps: TeardownDeps,
  name: TeardownStep["name"],
  baseline: TeardownProgress,
  now: number,
  token: FenceToken | undefined,
): Promise<"ran" | "skipped"> {
  const step = stepByName(deps.steps, name);
  let outcome: TeardownStepOutcome | undefined;

  await runInLeaseTransaction(deps.leaseStore, deps.leaseId, async (lease) => {
    // Fenced pass: the holder check is the first statement, so a driver whose
    // fence was taken over never runs a step. Every return below renews the
    // fence from the live clock (a skipped step too); the renewal that follows
    // a step that ran is read AFTER the step finished, so a slow step does not
    // spend its own lease.
    if (deps.fence !== undefined && token !== undefined) assertFenceHolder(lease, token);
    const renew = (): { fence?: TeardownFence } =>
      deps.fence !== undefined && token !== undefined ? { fence: renewedFence(token, deps.fence) } : {};
    const fresh = lease.teardownProgress ?? {};
    const recorded = fresh[name];
    if (
      lease.state !== "tearing_down" ||
      recorded !== baseline[name] ||
      (name === "revoke_oauth" && recorded !== undefined) ||
      isSuccessOutcome(recorded)
    ) {
      return { ...lease, ...renew() };
    }
    const ran = await runStepOnce(step, lease, now);
    await appendReceipt(
      deps.receiptStore,
      { chain: "verified", type: "teardown_step", payload: { step: name, outcome: ran } },
      now,
    );
    outcome = ran;
    return { ...lease, ...renew(), teardownProgress: recordStepOutcome(fresh, name, ran) };
  });

  if (outcome === undefined) return "skipped";
  safeEmit(deps.telemetry, { name: "teardown.step", leaseId: deps.leaseId, step: name, outcome });
  return "ran";
}

/** Walks every remaining step (in fixed order) from the pass baseline, then lands `teardown_succeeded`/`teardown_incomplete` exactly once and fires `notify` (D-25) only for the driver that landed it. Shared by `runTeardown` and `retryTeardown`. */
async function landTeardown(deps: TeardownDeps, now: number, token: FenceToken | undefined): Promise<Lease> {
  const baseline = (await peekLease(deps)).teardownProgress ?? {};

  for (const name of remainingSteps(baseline)) {
    await runStepAndPersist(deps, name, baseline, now, token);
  }

  let landed: TransitionRecord | undefined;
  const finalLease = await runInLeaseTransaction(deps.leaseStore, deps.leaseId, async (lease) => {
    if (deps.fence !== undefined && token !== undefined) assertFenceHolder(lease, token);
    const released = deps.fence !== undefined && token !== undefined ? { fence: releasedFence(token) } : {};
    if (lease.state !== "tearing_down") return { ...lease, ...released };
    const succeeded = allStepsSucceeded(lease.teardownProgress ?? {});
    const result = reduce(
      lease,
      succeeded ? runtimeEvents.teardownSucceeded() : runtimeEvents.teardownIncomplete(),
      now,
    );
    if (!result.ok) throw rejectedTransitionError(result.errors[0]?.code);
    await appendTransitionReceipt(deps.receiptStore, result.value.transition, now);
    landed = result.value.transition;
    return { ...result.value.lease, ...released };
  });

  if (landed === undefined) return finalLease;
  emitTransition(deps, landed);

  if (deps.notify !== undefined) {
    const type = finalLease.state === "cleaned_up" ? "cleaned_up" : "cleanup_incomplete";
    await deps.notify({ type, leaseId: deps.leaseId, at: now });
  }

  return finalLease;
}

/**
 * The tolerant entry rule shared by `runTeardown` and `retryTeardown`: after
 * a rejected entry transition, a lease already `tearing_down` means another
 * driver started the pass (join it: returns `undefined`); a lease already
 * landed is returned as is; any other state rethrows the original invariant
 * error.
 */
function afterRejectedEntry(attempt: TransitionAttempt): Lease | undefined {
  if (attempt.lease.state === "tearing_down") return undefined;
  if (isLanded(attempt.lease.state)) return attempt.lease;
  throw rejectedTransitionError(attempt.rejection);
}

/**
 * The TEAR-07 preflight. Returns at once without a `credentialCheck`. Otherwise
 * one lease transaction (the mutator always returns the lease unchanged)
 * skips when the lease is not in a state the entry point would act on or when
 * revoke_oauth already has a recorded outcome, asks the check which
 * credentials are missing (a throw means every expected one), and appends one
 * `teardown_blocked` receipt unless the chain tail already records the
 * identical block. Doing the dedupe and the append inside the transaction is
 * what makes two concurrent blocked drivers write one entry. Throws
 * `TeardownBlockedError` after the transaction when anything is missing.
 */
async function assertCredentialsAvailable(
  deps: TeardownDeps,
  mode: "run" | "retry",
  now: number,
): Promise<void> {
  const check = deps.credentialCheck;
  if (check === undefined) return;

  let blocked: string[] = [];
  await runInLeaseTransaction(deps.leaseStore, deps.leaseId, async (lease) => {
    const eligible =
      mode === "run"
        ? TERMINAL_END_STATES.has(lease.state) || lease.state === "tearing_down"
        : lease.state === "cleanup_incomplete" || lease.state === "tearing_down";
    if (!eligible) return lease;
    if (lease.teardownProgress?.revoke_oauth !== undefined) return lease;

    let missing: readonly string[];
    try {
      missing = await check.missing();
    } catch {
      missing = check.expected;
    }
    const [first, ...rest] = normalizeBlockedResources(missing);
    if (first === undefined) return lease;
    const resources: [string, ...string[]] = [first, ...rest];

    const chain = await deps.receiptStore.load("verified");
    const tail = chain.at(-1);
    const alreadyRecorded =
      tail?.type === "teardown_blocked" &&
      sameResources(tail.payload.resources, resources);
    if (!alreadyRecorded) {
      await appendReceipt(
        deps.receiptStore,
        { chain: "verified", type: "teardown_blocked", payload: { reason: "credentials_unavailable", resources } },
        now,
      );
    }
    blocked = resources;
    return lease;
  });

  if (blocked.length === 0) return;
  safeEmit(deps.telemetry, {
    name: "teardown.blocked",
    leaseId: deps.leaseId,
    reason: "credentials_unavailable",
    resourceCount: blocked.length,
  });
  throw new TeardownBlockedError(blocked);
}

/**
 * Runs one pass of teardown for `deps.leaseId` (TEAR-01). If the currently
 * persisted lease is in a terminal end state, auto-chains `begin_teardown`
 * first via `chainTeardownIfEnded` (D-18); otherwise the lease is assumed
 * already `tearing_down` (a resume of a prior partial run, or a pass another
 * driver started -- reduce() itself would reject a `begin_teardown` attempt
 * from any other state). A lease already `cleaned_up`/`cleanup_incomplete` is
 * returned untouched. Lands `cleaned_up` when all five steps succeed, else
 * `cleanup_incomplete` with every step's outcome honestly recorded (D-15).
 */
export async function runTeardown(deps: TeardownDeps, now: number): Promise<Lease> {
  await assertCredentialsAvailable(deps, "run", now);
  const lease = await peekLease(deps);

  if (isLanded(lease.state)) return lease;
  if (!TERMINAL_END_STATES.has(lease.state) && lease.state !== "tearing_down") {
    throw rejectedTransitionError("illegal_transition");
  }

  const token = deps.fence === undefined ? undefined : await acquireFence(deps, deps.fence);
  try {
    if (TERMINAL_END_STATES.has(lease.state)) {
      const attempt = await applyTransition(deps, now, (l) => chainTeardownIfEnded(l, now));
      if (attempt.record === undefined) {
        const landed = afterRejectedEntry(attempt);
        if (landed !== undefined) {
          if (token !== undefined) await releaseFence(deps, token);
          return landed;
        }
      }
    }

    // D-31 bracketing checkpoint: by this point the terminal-transition +
    // begin_teardown receipts are already appended, whether this call just
    // auto-chained them above or the caller chained them itself before
    // invoking runTeardown (see this module's docstring).
    if (deps.signingKey !== undefined) {
      await signBracketingCheckpoint(deps.receiptStore, deps.signingKey, now);
    }

    return await landTeardown(deps, now, token);
  } catch (error) {
    await releaseAfterError(deps, token, error);
    throw error;
  }
}

/** After an error escapes a fenced pass: release the fence once, best effort, unless the error says the fence is no longer ours. Never masks the original error. */
async function releaseAfterError(deps: TeardownDeps, token: FenceToken | undefined, error: unknown): Promise<void> {
  if (token === undefined || error instanceof TeardownFencedError) return;
  try {
    await releaseFence(deps, token);
  } catch {
    // swallowed: the original error is what the caller must see
  }
}

/**
 * Explicit recovery from `cleanup_incomplete` (D-15, D-32): dispatches
 * `retry_teardown` (legal from `user` or `runtime`, ALP.md Section 7.4)
 * landing `tearing_down`, then re-runs exactly `landTeardown`'s
 * remaining-steps walk -- `revoke_oauth`, once attempted, is never re-run
 * (D-23). No automatic/background retry anywhere in this module; `actor` is
 * always caller-supplied, never inferred. A second concurrent caller whose
 * `retry_teardown` is rejected joins the pass in flight or returns the lease
 * the first caller already landed.
 */
export async function retryTeardown(
  deps: TeardownDeps,
  actor: "user" | "runtime",
  now: number,
): Promise<Lease> {
  await assertCredentialsAvailable(deps, "retry", now);
  const token = deps.fence === undefined ? undefined : await acquireFence(deps, deps.fence);
  try {
    const attempt = await applyTransition(deps, now, (l) =>
      reduce(l, actor === "user" ? userEvents.retryTeardown() : runtimeEvents.retryTeardown(), now),
    );
    if (attempt.record === undefined) {
      const landed = afterRejectedEntry(attempt);
      if (landed !== undefined) {
        if (token !== undefined) await releaseFence(deps, token);
        return landed;
      }
    }

    return await landTeardown(deps, now, token);
  } catch (error) {
    await releaseAfterError(deps, token, error);
    throw error;
  }
}
