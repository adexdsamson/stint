---
phase: 05-lease-endings-teardown
plan: 03
subsystem: proxy
tags: [teardown, saga, reduce, receipts, jose, checkpoint, oauth-revocation]

# Dependency graph
requires:
  - phase: 05-lease-endings-teardown
    provides: "05-01: widened TeardownStepPayload.outcome enum, Lease.teardownProgress, makeTearingDownTestLease"
provides:
  - "teardown/auto-chain.ts: chainTeardownIfEnded(lease, now) -- the one shared begin_teardown auto-chain helper (D-18)"
  - "teardown/steps.ts: injectable TeardownStep port, runStepOnce (one-pass, D-15), createDefaultTeardownSteps (5 fixed-order happy-path defaults; final_receipt does real EdDSA checkpoint signing)"
  - "teardown/progress.ts: teardownProgress read/record/remainingSteps/allStepsSucceeded helpers encoding D-14/D-15/D-19/D-23/D-33"
  - "teardown/orchestrate.ts: runTeardown + retryTeardown -- the fixed 5-step saga coordinator, landing cleaned_up/cleanup_incomplete"
  - "revocation.ts: applyProviderRevocation retrofitted to chain grant_revoked -> begin_teardown (D-18), returning both TransitionRecords"
  - "server.ts: ProxyDeps.teardownSteps (optional) -- opt-in wiring for dispatch.ts to run the orchestrator after a provider revocation"
  - "dispatch.ts: the provider_revoked branch receipts both chained transitions and runs runTeardown in its own, later, per-lease transaction"
affects: [05-04, 05-05, 05-06, 05-07, 05-08]

# Actuals (#2632)
actuals:
  tokens: 15754
  tasks: 3
  commits: 3

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Injectable TeardownStep port (factory function returning {name, run(lease, now)}), mirroring vault/execute-stage.ts's ExecuteStage shape -- the fault matrix swaps any one step for a forced-failure/throwing implementation"
    - "Saga coordinator: reduce()-only transitions, one runInLeaseTransaction per logical step (auto-chain, each fixed step, the landing transition), never a second concurrency primitive (D-30)"
    - "Read-only 'peek' via an identity-mutator runInLeaseTransaction call, so a module can consult current lease state without ever calling leaseStore.load/.save directly"
    - "Two-reduce()-call chaining (grant_revoked then begin_teardown via chainTeardownIfEnded) returning BOTH TransitionRecords so the caller can receipt each one -- the shared pattern future end-transition call sites (entitlement revocation, outcome verification) will reuse"

key-files:
  created:
    - packages/proxy/src/teardown/auto-chain.ts
    - packages/proxy/src/teardown/steps.ts
    - packages/proxy/src/teardown/progress.ts
    - packages/proxy/src/teardown/orchestrate.ts
    - packages/proxy/test/teardown-orchestrate.test.ts
    - packages/proxy/test/teardown-fault-matrix.test.ts
  modified:
    - packages/proxy/src/revocation.ts
    - packages/proxy/src/dispatch.ts
    - packages/proxy/src/server.ts
    - packages/proxy/src/index.ts
    - packages/proxy/package.json
    - packages/proxy/test/revocation-detection.test.ts

key-decisions:
  - "final_receipt is the one non-placeholder default step this plan ships: createFinalReceiptStep(receiptStore, signingKey) loads the current verified chain, verifies it, signs a real EdDSA checkpoint (@stint/core signCheckpoint), and writes it -- a failed verify/sign resolves \"failed\" (caught the same way as any other step), never throws"
  - "TeardownDeps.steps is the sole injection point for all 5 steps (no separate signingKey/receiptStore fields on TeardownDeps itself) -- production callers build the array via createDefaultTeardownSteps(receiptStore, signingKey) before constructing TeardownDeps; this keeps every step, including final_receipt, uniformly swappable for the fault matrix (D-27)"
  - "applyProviderRevocation's return shape widened from {lease, transition} to {lease, transitions: readonly [TransitionRecord, TransitionRecord]} (Rule 3 seam widening, mirrors 04-03/04-04 precedent) so dispatch.ts can receipt both the grant_revoked and begin_teardown transitions"
  - "ProxyDeps.teardownSteps is OPTIONAL, not required -- keeps every pre-05-03 ProxyDeps literal across 6 other test files compiling unchanged; only revocation-detection.test.ts (the plan's declared scope) wires it in"
  - "dispatch.ts invokes runTeardown AFTER handleCall's own runInLeaseTransaction has resolved (captured via a `const finalLease = await runInLeaseTransaction(...)`), never from inside the mutator -- proven non-nested by an instrumented-LeaseStore test asserting strict start/end sequencing"
  - "Added jose@6.2.12 as a direct @stint/proxy dependency (was previously only a transitive dep via @stint/core) -- pnpm's strict, non-hoisted node_modules meant packages/proxy could not resolve \"jose\" without this; treated as a workspace dependency correction (the exact pinned version CLAUDE.md already approves), not a new/unverified package install"

patterns-established:
  - "One-pass step runner (runStepOnce): try/await/catch collapsing both a returned \"failed\" outcome and a thrown/rejected step to the identical recorded result -- no retry/backoff/timer anywhere in teardown/*.ts (D-15), grep-proven in teardown-orchestrate.test.ts"
  - "Attempted-is-terminal for step 1 (D-23): remainingSteps special-cases revoke_oauth -- ANY recorded outcome (success or failed) makes it permanently skipped on resume, while steps 2-5 are skipped only on a recorded SUCCESS outcome"

requirements-completed: [TEAR-01, TEAR-04, TEAR-05]

coverage:
  - id: D1
    description: "One end reason (a terminal lease state) drives runTeardown end-to-end: auto-chained begin_teardown, all 5 fixed steps run in order under the per-lease serializer, lands cleaned_up with a final signed checkpoint that verifies against the full receipt chain"
    requirement: "TEAR-01"
    verification:
      - kind: unit
        ref: "packages/proxy/test/teardown-orchestrate.test.ts#runTeardown: end-to-end happy path (TEAR-01)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Every teardown state change goes through core's reduce() and the fixed step order is walked unconditionally, in fixed order, for every terminal end state"
    requirement: "TEAR-01"
    verification:
      - kind: unit
        ref: "packages/proxy/test/teardown-orchestrate.test.ts#appends the begin_teardown + 5 teardown_step + teardown_succeeded receipts"
        status: pass
      - kind: unit
        ref: "packages/proxy/test/teardown-orchestrate.test.ts#teardown one-pass discipline (D-15)"
        status: pass
    human_judgment: false
  - id: D3
    description: "A single step failing lands cleanup_incomplete with every step's outcome honestly recorded, and the remaining steps still run (a failure never aborts the saga) -- proven across all 5 steps, both a returned \"failed\" and a thrown rejection"
    requirement: "TEAR-04"
    verification:
      - kind: unit
        ref: "packages/proxy/test/teardown-fault-matrix.test.ts#fault matrix: each single step failing lands cleanup_incomplete (TEAR-04)"
        status: pass
    human_judgment: false
  - id: D4
    description: "retry_teardown resumes from persisted progress, skipping already-succeeded steps; revoke_oauth (step 1) is never re-attempted once it has any recorded outcome (D-23); no code path ever returns the lease to active"
    requirement: "TEAR-05"
    verification:
      - kind: unit
        ref: "packages/proxy/test/teardown-fault-matrix.test.ts#retry_teardown resume (D-14, D-15, D-23)"
        status: pass
    human_judgment: false
  - id: D5
    description: "The one existing end-transition call site (provider revocation) is retrofitted to auto-chain begin_teardown and run the full orchestrator to cleaned_up -- proving TEAR-01 end-to-end for the provider reason, with the orchestrator running in its own transaction (never nested) after the dispatch transaction commits"
    requirement: "TEAR-01"
    verification:
      - kind: unit
        ref: "packages/proxy/test/revocation-detection.test.ts#dispatch: applyProviderRevocation wiring drives the full teardown orchestrator (PRXY-07, 05-03 TEAR-01)"
        status: pass
      - kind: integration
        ref: "packages/proxy/test/revocation-detection.test.ts#PRXY-07 end-to-end: real mock AS + MCP Client"
        status: pass
    human_judgment: false

# Metrics
duration: ~45min
completed: 2026-09-28
status: complete
---

# Phase 5 Plan 3: Teardown Orchestrator + Provider-Revocation Auto-Chain Summary

**Fixed 5-step teardown saga (`runTeardown`/`retryTeardown`) that auto-chains `begin_teardown` from any terminal end state, walks the steps under the per-lease serializer with persisted per-step progress, signs a real EdDSA final checkpoint, and honestly lands `cleaned_up`/`cleanup_incomplete` -- now wired as the actual consequence of a provider OAuth revocation.**

## Performance

- **Duration:** ~45 min
- **Started:** 2026-09-28T22:35:00Z
- **Completed:** 2026-09-28T23:19:00Z
- **Tasks:** 3
- **Files modified:** 12 (6 created, 6 modified)

## Accomplishments
- `teardown/auto-chain.ts`'s `chainTeardownIfEnded` -- the ONE shared `reduce()`-twice helper (`grant_revoked`-style ending -> `begin_teardown`) every end-transition call site uses, so no lease is ever left terminal-but-not-torn-down (D-18)
- `teardown/steps.ts`'s injectable `TeardownStep` port + `runStepOnce` (single attempt, no retry/backoff/timer, D-15) + `createDefaultTeardownSteps` -- 4 happy-path placeholders for later plans plus a REAL `final_receipt` implementation that signs and writes an EdDSA checkpoint over the accumulated verified chain (D-19, D-31)
- `teardown/progress.ts`'s `remainingSteps`/`recordStepOutcome`/`allStepsSucceeded` -- the resume contract: `revoke_oauth` is attempted-is-terminal (D-23), every other step resumes only if not already a recorded SUCCESS outcome
- `teardown/orchestrate.ts`'s `runTeardown` (happy path + fault handling) and `retryTeardown` (explicit-only recovery, D-32) -- both drive state exclusively through core's `reduce()`, both route every `LeaseStore` access through `runInLeaseTransaction` (no direct `.load`/`.save` anywhere in `teardown/*.ts`, grep-proven)
- `revocation.ts`'s `applyProviderRevocation` retrofit -- a provider OAuth revocation now auto-chains into the full teardown, proven end-to-end (`tearing_down` -> `cleaned_up`) via `dispatch.ts` invoking `runTeardown` in its own, later, non-nested per-lease transaction

## Task Commits

Each task was committed atomically:

1. **Task 1: End-to-end teardown happy path** - `9a580e1` (feat)
2. **Task 2: One-pass fault handling + idempotent retry_teardown resume** - `6250cf4` (feat)
3. **Task 3: Retrofit the provider-revocation trigger to auto-chain into the orchestrator** - `0615de5` (feat)

**Plan metadata:** committed alongside this SUMMARY (see final commit below).

_Tasks 2 and 3 carried `tdd="true"` in the plan; both were implemented together with their tests (tests + implementation verified green before commit) rather than as separate RED/GREEN commits, since the code for all three tasks was developed as one coherent, cross-checked design pass and then split back into task-scoped commits by staging exactly each task's declared files. All task-declared `<verify>`/`<acceptance_criteria>` commands were re-run and pass at each commit boundary._

## Files Created/Modified
- `packages/proxy/src/teardown/auto-chain.ts` - `chainTeardownIfEnded(lease, now)` (D-18)
- `packages/proxy/src/teardown/steps.ts` - `TeardownStep` port, `runStepOnce`, `TEARDOWN_STEP_ORDER`, `createDefaultTeardownSteps`
- `packages/proxy/src/teardown/progress.ts` - `teardownProgress` helpers (`remainingSteps`, `recordStepOutcome`, `allStepsSucceeded`, `isSuccessOutcome`)
- `packages/proxy/src/teardown/orchestrate.ts` - `runTeardown`, `retryTeardown`, `appendTransitionReceipt`, `TeardownDeps`
- `packages/proxy/src/revocation.ts` - `applyProviderRevocation` retrofit (D-18)
- `packages/proxy/src/dispatch.ts` - provider_revoked branch receipts both chained transitions; post-transaction `runTeardown` invocation
- `packages/proxy/src/server.ts` - `ProxyDeps.teardownSteps` (optional)
- `packages/proxy/src/index.ts` - exports the new teardown public surface
- `packages/proxy/package.json` - adds `jose@6.2.12` as a direct dependency
- `packages/proxy/test/teardown-orchestrate.test.ts` - happy-path end-to-end proof (new)
- `packages/proxy/test/teardown-fault-matrix.test.ts` - fault matrix + retry proof (new)
- `packages/proxy/test/revocation-detection.test.ts` - updated for the two-transition chain and the wired orchestrator

## Decisions Made
- `final_receipt` is real, permanent behavior (signs + writes an actual EdDSA checkpoint), not a placeholder like the other 4 default steps -- required so the happy-path chain has a genuine, `verifyChain`-passing final checkpoint this plan proves, not a deferred stub
- `TeardownDeps` carries only `steps` (no separate `signingKey`) -- the signing key is closed over when `createDefaultTeardownSteps(receiptStore, signingKey)` builds the step array, keeping every one of the 5 steps (including `final_receipt`) uniformly swappable for the fault matrix
- `applyProviderRevocation`'s return type widened to carry both `TransitionRecord`s (Rule 3 seam widening, same pattern as 04-03/04-04's `CapEnforcer`/`ApprovalStage` widenings) so `dispatch.ts` can receipt the `grant_revoked` and `begin_teardown` transitions individually
- `ProxyDeps.teardownSteps` is optional so the retrofit stays scoped to this plan's declared files -- the 6 other proxy test files that build `ProxyDeps` literals (`approvals.test.ts`, `caps-concurrency.test.ts`, `call-receipts.test.ts`, `license-secretless.test.ts`, `server-tracer.test.ts`, `vault-secretless.test.ts`) needed no changes
- Added `jose@6.2.12` as a direct `@stint/proxy` dependency -- pnpm's strict per-package `node_modules` meant `packages/proxy` could not resolve `"jose"` (previously only a transitive dependency via `@stint/core`) for the `CryptoKey` type and sign/verify calls `teardown/steps.ts` needs directly

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Added `jose` as a direct `@stint/proxy` dependency**
- **Found during:** Task 1 (writing `teardown/steps.ts`, which needs `jose`'s `CryptoKey` type and calls `@stint/core`'s `signCheckpoint`)
- **Issue:** `packages/proxy/node_modules` had no `jose` package (pnpm's strict, non-hoisted workspace linking) -- `jose` was only a transitive dependency of `@stint/core`, not declared by `@stint/proxy` itself
- **Fix:** Added `"jose": "6.2.12"` (the exact pin already approved in `.claude/CLAUDE.md` and used by `@stint/core`) to `packages/proxy/package.json`'s `dependencies`, then ran `pnpm install` to link it
- **Files modified:** `packages/proxy/package.json`, `pnpm-lock.yaml`
- **Verification:** `pnpm install` succeeded; `packages/proxy/node_modules/jose` present; `pnpm build`/`tsc -b`/`vitest run` all pass
- **Committed in:** `9a580e1` (Task 1 commit)

This is a workspace dependency correction for an already-vetted, already-pinned package used elsewhere in the monorepo -- not a new/unverified package install, so the package-legitimacy checkpoint protocol does not apply.

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Necessary for `teardown/steps.ts` to compile and for the real `final_receipt` checkpoint-signing implementation to exist; no scope creep beyond the plan's own stated artifacts.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- `teardown/steps.ts`'s 4 happy-path defaults (`revoke_oauth` -> `"revoked"`, `invalidate_license` -> `"ok"`, `cleanup_hook` -> `"attested_ok"`, `delete_cached_data` -> `"ok"`) are explicitly placeholders for 05-04 (real RFC 7009 revoke + Pitfall 5 honesty), 05-05 (real `LicenseIssuer.invalidate`), and 05-06 (real single-use cleanup-token POST) to harden without touching `orchestrate.ts`/`progress.ts` -- the injectable `TeardownStep` port is the seam they implement against.
- `applyEntitlementRevocation` (LIC-04, D-21) is NOT yet implemented -- it will mirror `applyProviderRevocation`'s exact two-`reduce()`-call + `chainTeardownIfEnded` shape once a later plan adds the runtime-facing publisher revoke entry point.
- The `resource_query`/`user_confirm` outcome-verification path (LIFE-06) is out of this plan's scope; when it lands, its `outcome_verified` -> `completed` transition will call the SAME `chainTeardownIfEnded` helper as the third end-transition call site.
- No blockers.

## Self-Check: PASSED

All 6 created files found on disk; all 3 task commit hashes found in `git log`; `pnpm build` and `tsc -b` pass repo-wide; `vitest run` passes for `packages/proxy/test` (96/96) and `packages/core/test` (205/205) with no regressions.

---
*Phase: 05-lease-endings-teardown*
*Completed: 2026-09-28*
