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

import { appendEntry, reduce, runtimeEvents, signCheckpoint, userEvents, verifyChain } from "@stint/core";
import type {
  Lease,
  LeaseStore,
  LifecycleEvent,
  ReceiptEntryInput,
  ReceiptStore,
  Result,
  TeardownStepOutcome,
  TransitionRecord,
} from "@stint/core";
import type { CryptoKey } from "jose";

import { runInLeaseTransaction } from "../concurrency/lease-serializer.js";
import { chainTeardownIfEnded } from "./auto-chain.js";
import { allStepsSucceeded, recordStepOutcome, remainingSteps } from "./progress.js";
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
}

const TERMINAL_END_STATES: ReadonlySet<Lease["state"]> = new Set(["completed", "expired", "revoked", "failed"]);

function stepByName(steps: readonly TeardownStep[], name: TeardownStep["name"]): TeardownStep {
  const step = steps.find((candidate) => candidate.name === name);
  if (step === undefined) {
    throw new Error(`@stint/proxy: no TeardownStep registered for "${name}".`);
  }
  return step;
}

/** Appends `input` onto the persisted verified chain -- reloads the current chain first so `prevHash` always links to the latest entry. */
async function appendReceipt(receiptStore: ReceiptStore, input: ReceiptEntryInput, now: number): Promise<void> {
  const chain = await receiptStore.load("verified");
  const entry = appendEntry(chain, input, now);
  await receiptStore.append("verified", entry);
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
 * a step outcome.
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

/**
 * Applies `apply` (a `reduce()`-shaped transition) to the current lease
 * under the per-lease serializer, appends the resulting `TransitionRecord`
 * as a verified-chain receipt, and returns the next lease. Throws only on
 * an invariant violation (the transition was illegal for the CURRENT lease
 * state) -- a caller-level bug, not an expected business outcome; every
 * caller in this file only invokes it when the precondition is known to
 * hold.
 */
async function applyTransition(
  deps: TeardownDeps,
  now: number,
  apply: (lease: Lease) => Result<{ lease: Lease; transition: TransitionRecord }>,
): Promise<Lease> {
  let record: TransitionRecord | undefined;
  const nextLease = await runInLeaseTransaction(deps.leaseStore, deps.leaseId, (lease) => {
    const result = apply(lease);
    if (!result.ok) {
      throw new Error(`@stint/proxy: teardown transition rejected: ${result.errors[0]?.code ?? "unknown"}.`);
    }
    record = result.value.transition;
    return result.value.lease;
  });
  if (record !== undefined) {
    await appendTransitionReceipt(deps.receiptStore, record, now);
  }
  return nextLease;
}

/** Runs one step, persists its outcome into `teardownProgress` (D-14), and appends its `teardown_step` receipt (D-24) -- the outcome is captured via closure from inside the transaction's mutator, mirroring `dispatch.ts`'s own `handleCall` pattern. */
async function runStepAndPersist(deps: TeardownDeps, name: TeardownStep["name"], now: number): Promise<void> {
  const step = stepByName(deps.steps, name);
  let outcome: TeardownStepOutcome = "failed";

  await runInLeaseTransaction(deps.leaseStore, deps.leaseId, async (lease) => {
    outcome = await runStepOnce(step, lease, now);
    return { ...lease, teardownProgress: recordStepOutcome(lease.teardownProgress ?? {}, name, outcome) };
  });

  await appendReceipt(
    deps.receiptStore,
    { chain: "verified", type: "teardown_step", payload: { step: name, outcome } },
    now,
  );
}

/** Walks every remaining step (in fixed order) from the current lease's persisted progress, then lands `teardown_succeeded`/`teardown_incomplete` and fires `notify` (D-25). Shared by `runTeardown` and `retryTeardown`. */
async function landTeardown(deps: TeardownDeps, now: number): Promise<Lease> {
  const lease = await peekLease(deps);
  const names = remainingSteps(lease.teardownProgress ?? {});

  for (const name of names) {
    await runStepAndPersist(deps, name, now);
  }

  const afterSteps = await peekLease(deps);
  const succeeded = allStepsSucceeded(afterSteps.teardownProgress ?? {});

  const finalLease = await applyTransition(deps, now, (l) =>
    reduce(l, succeeded ? runtimeEvents.teardownSucceeded() : runtimeEvents.teardownIncomplete(), now),
  );

  if (deps.notify !== undefined) {
    const type = finalLease.state === "cleaned_up" ? "cleaned_up" : "cleanup_incomplete";
    await deps.notify({ type, leaseId: deps.leaseId, at: now });
  }

  return finalLease;
}

/**
 * Runs one pass of teardown for `deps.leaseId` (TEAR-01). If the currently
 * persisted lease is in a terminal end state, auto-chains `begin_teardown`
 * first via `chainTeardownIfEnded` (D-18); otherwise the lease is assumed
 * already `tearing_down` (a resume of a prior partial run -- reduce()
 * itself would reject a `begin_teardown` attempt from any other state).
 * Lands `cleaned_up` when all five steps succeed, else `cleanup_incomplete`
 * with every step's outcome honestly recorded (D-15).
 */
export async function runTeardown(deps: TeardownDeps, now: number): Promise<Lease> {
  const lease = await peekLease(deps);

  if (TERMINAL_END_STATES.has(lease.state)) {
    await applyTransition(deps, now, (l) => chainTeardownIfEnded(l, now));
  }

  // D-31 bracketing checkpoint: by this point the terminal-transition +
  // begin_teardown receipts are already appended, whether this call just
  // auto-chained them above or the caller chained them itself before
  // invoking runTeardown (see this module's docstring).
  if (deps.signingKey !== undefined) {
    await signBracketingCheckpoint(deps.receiptStore, deps.signingKey, now);
  }

  return landTeardown(deps, now);
}

/**
 * Explicit recovery from `cleanup_incomplete` (D-15, D-32): dispatches
 * `retry_teardown` (legal from `user` or `runtime`, ALP.md Section 7.4)
 * landing `tearing_down`, then re-runs exactly `landTeardown`'s
 * remaining-steps walk -- `revoke_oauth`, once attempted, is never re-run
 * (D-23). No automatic/background retry anywhere in this module; `actor` is
 * always caller-supplied, never inferred.
 */
export async function retryTeardown(
  deps: TeardownDeps,
  actor: "user" | "runtime",
  now: number,
): Promise<Lease> {
  await applyTransition(deps, now, (l) =>
    reduce(l, actor === "user" ? userEvents.retryTeardown() : runtimeEvents.retryTeardown(), now),
  );

  return landTeardown(deps, now);
}
