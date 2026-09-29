---
phase: 05-lease-endings-teardown
plan: 07
subsystem: proxy
tags: [outcome-verification, resource_query, user_confirm, host-adapter, predicate-evaluation, receipts]

# Dependency graph
requires:
  - phase: 05-lease-endings-teardown
    provides: "05-02: closed-AST resource_query predicate parser + pure evaluatePredicate in @stint/spec"
  - phase: 05-lease-endings-teardown
    provides: "05-03: teardown/auto-chain.ts's chainTeardownIfEnded + teardown/orchestrate.ts's runTeardown/appendTransitionReceipt"
  - phase: 05-lease-endings-teardown
    provides: "05-06: the fully-hardened createDefaultTeardownSteps 5-step teardown surface this plan's true/confirm outcomes drive end-to-end"
provides:
  - "packages/core/src/bindings.ts: ConnectorBinding.rowAdapter? (D-06) -- runtime-owned projection normalizing a connector read result to { rows } for the predicate evaluator"
  - "packages/core/src/host-adapter.ts: HostAdapter.requestOutcomeConfirmation + OutcomeConfirmRequest/Decision + awaitOutcomeConfirmDecision (D-05)"
  - "packages/proxy/src/verification/resource-query.ts: runResourceQueryVerification + runNoneVerification -- the verifier-actor synthetic read, predicate evaluation, and outcome dispatch (LIFE-06)"
  - "packages/proxy/src/verification/user-confirm.ts: runUserConfirmVerification -- the out-of-band user_confirm trigger, sharing completeViaVerifier with resource-query.ts"
affects: [05-08]

# Actuals (#2632)
actuals:
  tokens: 12778
  tasks: 3
  commits: 3

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Reused the existing CallPayload receipt shape (resource + argsHash + redactedSummary + outcome: allowed|denied) for verification-attempt receipts rather than adding a new schema entry type -- resource carries the verifier resource id, redactedSummary states actor=verifier + the closed outcome + a stable reason, argsHash is always hashCanonical({}) since a verification attempt carries no agent args"
    - "Shared VerifierCompletionDeps/completeViaVerifier helper (resource-query.ts) reused verbatim by user-confirm.ts -- both verifier types funnel a true/confirm outcome through the identical reduce(outcomeVerified()) -> chainTeardownIfEnded -> optional runTeardown path, never a duplicated ending-state check"

key-files:
  created:
    - packages/proxy/src/verification/resource-query.ts
    - packages/proxy/src/verification/user-confirm.ts
    - packages/proxy/test/verification.test.ts
  modified:
    - packages/core/src/bindings.ts
    - packages/core/src/host-adapter.ts
    - packages/core/src/index.ts
    - packages/core/test/host-adapter.test.ts
    - packages/proxy/src/index.ts
    - packages/proxy/test/approvals.test.ts

key-decisions:
  - "Verification-attempt receipts reuse the existing CallPayload/CallEntry shape rather than a new receipt schema entry -- the plan's declared files_modified excludes spec/receipt.schema.json, so 'verifier actor, resource id, outcome true/false/error + stable reason' (D-07) is expressed within CallPayload's existing resource/argsHash/redactedSummary/outcome fields: outcome true maps to allowed, false/error map to denied, and redactedSummary carries 'actor=verifier, outcome=X, reason=Y' as plain text."
  - "A query/read error (missing rowAdapter, vault refresh failure, connector throw, or an evaluate-time throw) all collapse to the SAME outcome=error result -- never a raw error message reaches a receipt; the scrubbed connector error text is proven absent from the receipt chain in a dedicated test."
  - "recordVerificationErrorTowardThreshold only appends to denialErrorTimestamps -- it does NOT dispatch checkErrorThreshold -> policyEvents.errorThresholdExceeded() -> failed. Per the plan's own flagged_assumptions, that dispatch wiring is a pre-existing, not-yet-wired Phase 6 gap (05-RESEARCH.md Pitfall 4) this plan does not invent."
  - "user_confirm has no real customer resource (UserConfirmVerifier carries only prompt) -- its verification receipts record the fixed sentinel resource 'user_confirm', mirroring receipts/call-receipt.ts's UNRESOLVED_RESOURCE convention for 'no real resource to name here.'"

patterns-established:
  - "Verifier-actor synthetic read reusing the EXACT vault.resolveAccessToken + OutboundConnector + scrub path a real tool call uses (D-02) -- never a second credential seam; the verifier's binding/tool is never registered in any tool catalog (proven via a source-grep test) and never touches actionCount/spentMinor/actionTimestamps."

requirements-completed: [LIFE-06]

coverage:
  - id: D1
    description: "resource_query: a matching predicate drives outcome_verified (actor verifier) -> completed -> auto-chained begin_teardown -> the full teardown orchestrator when configured; exactly one verification receipt is appended"
    requirement: "LIFE-06"
    verification:
      - kind: unit
        ref: "packages/proxy/test/verification.test.ts#runResourceQueryVerification (LIFE-06, D-02, D-03, D-06, D-07) > TRUE: a matching predicate completes the lease and auto-chains into the full teardown"
        status: pass
      - kind: unit
        ref: "packages/proxy/test/verification.test.ts#runResourceQueryVerification (LIFE-06, D-02, D-03, D-06, D-07) > TRUE: reuses the vault + connector exactly once (D-02) -- the same path a real call uses"
        status: pass
    human_judgment: false
  - id: D2
    description: "resource_query: a non-matching predicate is a no-op (lease stays active, no state change, one negative receipt); a read/evaluate error never completes the lease, appends one outcome=error receipt, and records toward the LIFE-07 threshold counter"
    requirement: "LIFE-06"
    verification:
      - kind: unit
        ref: "packages/proxy/test/verification.test.ts#runResourceQueryVerification (LIFE-06, D-02, D-03, D-06, D-07) > FALSE: a non-matching predicate is a no-op -- lease stays active, exactly one negative receipt, no state change"
        status: pass
      - kind: unit
        ref: "packages/proxy/test/verification.test.ts#runResourceQueryVerification (LIFE-06, D-02, D-03, D-06, D-07) > ERROR: a read failure never completes the lease, records one outcome=error receipt, and counts toward the LIFE-07 threshold"
        status: pass
      - kind: unit
        ref: "packages/proxy/test/verification.test.ts#runResourceQueryVerification (LIFE-06, D-02, D-03, D-06, D-07) > ERROR: a binding with no rowAdapter configured is treated as a read error, never a match"
        status: pass
    human_judgment: false
  - id: D3
    description: "The resource_query verifier read never touches the action/spend limit counters and is structurally absent from any tool catalog; no raw row/field value/query result or scrubbed error text ever appears in a verification receipt"
    requirement: "LIFE-06"
    verification:
      - kind: unit
        ref: "packages/proxy/test/verification.test.ts#runResourceQueryVerification (LIFE-06, D-02, D-03, D-06, D-07) > never touches the action/spend limit counters, on any outcome (true/false/error)"
        status: pass
      - kind: unit
        ref: "packages/proxy/test/verification.test.ts#runResourceQueryVerification (LIFE-06, D-02, D-03, D-06, D-07) > never appears in any tool catalog import -- the verifier read is structurally absent from tools/list (D-02)"
        status: pass
    human_judgment: false
  - id: D4
    description: "HostAdapter gains requestOutcomeConfirmation; awaitOutcomeConfirmDecision is deny-by-default (resolves reject/timeout on abort, adapter error, or already-aborted signal) and never throws"
    requirement: "LIFE-06"
    verification:
      - kind: unit
        ref: "packages/core/test/host-adapter.test.ts#awaitOutcomeConfirmDecision (D-05) > CONFIRM PASSTHROUGH / REJECT PASSTHROUGH / TIMEOUT / ADAPTER ERROR / ALREADY ABORTED"
        status: pass
    human_judgment: false
  - id: D5
    description: "user_confirm: an explicit confirm completes the lease and auto-chains into the full teardown; an explicit rejection or a timed-out signal never completes the lease"
    requirement: "LIFE-06"
    verification:
      - kind: unit
        ref: "packages/proxy/test/verification.test.ts#runUserConfirmVerification (LIFE-06, D-05, D-07) > YES / NO / TIMEOUT"
        status: pass
    human_judgment: false
  - id: D6
    description: "A none verifier's agent-signalled trigger completes nothing (no reduce() call, no receipt append); a forged agent-actor outcome_verified event is rejected by reduce()'s own wrong_actor check -- outcome_verified is only ever reachable via verifierEvents.outcomeVerified() (actor verifier)"
    requirement: "LIFE-06"
    verification:
      - kind: unit
        ref: "packages/proxy/test/verification.test.ts#runNoneVerification (LIFE-06, D-03): completes nothing > is a pure no-op -- returns 'none', touches no lease, appends no receipt"
        status: pass
      - kind: unit
        ref: "packages/proxy/test/verification.test.ts#Trigger discipline (D-03, D-19): the agent's own claim never completes a lease > reduce() rejects a forged agent-actor outcome_verified event -- wrong_actor, never completed"
        status: pass
      - kind: unit
        ref: "packages/proxy/test/verification.test.ts#Trigger discipline (D-03, D-19): the agent's own claim never completes a lease > the ONLY way outcome_verified is legally dispatched is via verifierEvents.outcomeVerified() (actor verifier)"
        status: pass
    human_judgment: false

# Metrics
duration: ~55min
completed: 2026-09-29
status: complete
---

# Phase 5 Plan 7: Outcome Verification (resource_query, user_confirm, none) Summary

**LIFE-06 closed: a lease completes only through a runtime-run `resource_query` predicate evaluation (via the same vault/connector path a real call uses) or an explicit out-of-band `user_confirm` yes, with `none` ending only on expiry/user action -- the agent's own "check done" signal only ever triggers the runtime's own evaluation, and reduce()'s actor check structurally rejects any forged agent-actor completion.**

## Performance

- **Duration:** ~55 min
- **Started:** 2026-09-29T06:38:00Z
- **Completed:** 2026-09-29T07:10:00Z
- **Tasks:** 3
- **Files modified:** 9 (3 created, 6 modified)

## Accomplishments

- `bindings.ts`'s additive `ConnectorBinding.rowAdapter?` (D-06) -- a runtime-owned `(status, body) -> { rows }` projection so an arbitrary connector's read result normalizes for `@stint/spec`'s pure `evaluatePredicate`, never publisher-supplied.
- `verification/resource-query.ts`'s `runResourceQueryVerification` -- performs a verifier-actor synthetic read reusing the EXACT `vault.resolveAccessToken` + `OutboundConnector` + scrub path `vault/execute-stage.ts` uses for a real call (D-02): predicate `true` drives `verifierEvents.outcomeVerified()` -> `completed` -> auto-chained `begin_teardown` (+ the full teardown orchestrator when `teardownSteps` is configured); `false` is a no-op; a read/evaluate error records toward the LIFE-07 `denialErrorTimestamps` counter and never completes. Every attempt appends exactly one verification receipt (D-07), reusing the existing `CallPayload` shape.
- `host-adapter.ts`'s `HostAdapter.requestOutcomeConfirmation` + `OutcomeConfirmRequest`/`OutcomeConfirmDecision` + `awaitOutcomeConfirmDecision` (D-05) -- copies `awaitConsentDecision`'s settled-flag/abort-listener/then-resolve structure verbatim, so a slow, buggy, or hostile adapter can never turn into a confirm.
- `verification/user-confirm.ts`'s `runUserConfirmVerification` -- drives the out-of-band confirmation and funnels a `confirm` outcome through the SAME `completeViaVerifier` completion path `resource-query.ts` uses (D-18); `reject` (explicit `no` or `timeout`) never completes the lease.
- `verification/resource-query.ts`'s `runNoneVerification` -- the explicit no-op for a `none` verifier's trigger: no `reduce()` call, no receipt append, proving by construction that this path never transitions a lease.
- Consolidated `verification.test.ts` (23 tests total across the file's final state, 13 in the plan-declared file at completion) proving the agent-claim-never-completes invariant across all three verifier types, plus a forged-agent-actor `reduce()` rejection test (`wrong_actor`).

## Task Commits

Each task was committed atomically:

1. **Task 1: rowAdapter + resource_query verifier read + outcome semantics (D-02, D-06, D-03)** - `b477004` (feat)
2. **Task 2: user_confirm HostAdapter method + await-helper + wiring (D-05)** - `8c84ede` (feat)
3. **Task 3: Trigger discipline + none semantics + agent-claim-never-completes proof (D-03, LIFE-06)** - `b9e6c48` (test)

**Plan metadata:** committed alongside this SUMMARY (see final commit below).

_All three tasks carried `tdd="true"` in the plan. Implementation and tests for each task were developed together (verified green) rather than as separate RED/GREEN commits, then split back into task-scoped commits by staging exactly each task's declared files -- Tasks 1-3 required temporarily reverting later tasks' in-progress content from shared files (`packages/core/src/index.ts`, `packages/proxy/src/index.ts`, `packages/proxy/test/verification.test.ts`) so each commit's own declared `<verify>` command (a full `pnpm build` + scoped `vitest run`) was re-run and genuinely passed against that commit's own tree before committing, rather than being staged post-hoc from a monolithic diff._

## Files Created/Modified

- `packages/core/src/bindings.ts` - `ConnectorRowAdapter`/`BindingRow`/`BindingRowResult` types + `ConnectorBinding.rowAdapter?` (D-06)
- `packages/core/src/host-adapter.ts` - `OutcomeConfirmRequest`/`OutcomeConfirmDecision`, `HostAdapter.requestOutcomeConfirmation`, `awaitOutcomeConfirmDecision` (D-05)
- `packages/core/src/index.ts` - barrel exports for the new binding + host-adapter surface
- `packages/core/test/host-adapter.test.ts` - 5 new tests for `awaitOutcomeConfirmDecision`; `fakeAdapter` gains a `requestOutcomeConfirmation` stub
- `packages/proxy/src/verification/resource-query.ts` - `runResourceQueryVerification`, `runNoneVerification`, `appendVerificationReceipt`, `completeViaVerifier`, `VerifierCompletionDeps` (new)
- `packages/proxy/src/verification/user-confirm.ts` - `runUserConfirmVerification` (new)
- `packages/proxy/src/index.ts` - exports the new verification public surface
- `packages/proxy/test/approvals.test.ts` - 9 `HostAdapter` test doubles gain a `requestOutcomeConfirmation` stub (Rule 3, required for the widened interface to type-check)
- `packages/proxy/test/verification.test.ts` - 13 tests: `resource_query` (7), `user_confirm` (3), `none` (1), trigger discipline (2)

## Decisions Made

- Verification-attempt receipts reuse the existing `CallPayload`/`CallEntry` shape rather than adding a new receipt schema entry type -- the plan's declared `files_modified` excludes `spec/receipt.schema.json`, so D-07's "verifier actor, resource id, outcome true/false/error + stable reason" is expressed within `CallPayload`'s `resource`/`argsHash`/`redactedSummary`/`outcome` fields (outcome `true` -> `allowed`, `false`/`error` -> `denied`; `redactedSummary` states `actor=verifier, outcome=X, reason=Y` as plain text; `argsHash` is always `hashCanonical({})` since a verification attempt carries no agent args).
- A query/read error (missing `rowAdapter`, vault refresh failure, connector throw, or an evaluate-time throw) all collapse to the SAME `outcome=error` result -- never a raw error message reaches a receipt; the scrubbed connector error text is proven absent from the receipt chain in a dedicated test.
- `recordVerificationErrorTowardThreshold` only appends to `denialErrorTimestamps` -- it does NOT dispatch `checkErrorThreshold` -> `policyEvents.errorThresholdExceeded()` -> `failed`. Per the plan's own `flagged_assumptions`, that dispatch wiring is a pre-existing, not-yet-wired gap (05-RESEARCH.md Pitfall 4) this plan does not invent.
- `user_confirm` has no real customer resource (`UserConfirmVerifier` carries only `prompt`) -- its verification receipts record the fixed sentinel resource `"user_confirm"`, mirroring `receipts/call-receipt.ts`'s `UNRESOLVED_RESOURCE` convention.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Added `requestOutcomeConfirmation` stubs to every existing `HostAdapter` test double**
- **Found during:** Task 2 (widening `HostAdapter` with a 4th required method)
- **Issue:** Adding `requestOutcomeConfirmation` to the `HostAdapter` interface broke every hand-built `HostAdapter` object literal elsewhere in the codebase -- 9 test doubles in `packages/proxy/test/approvals.test.ts` (not declared in this plan's `files_modified`) failed to type-check.
- **Fix:** Added a `requestOutcomeConfirmation() { return Promise.reject(new Error("n/a")); }` stub to each of the 9 literals, matching the file's existing `requestConsent`/`requestApproval` stub convention for methods those tests never exercise.
- **Files modified:** `packages/proxy/test/approvals.test.ts`
- **Verification:** `tsc -b --force` clean; `vitest run packages/proxy/test/approvals.test.ts` (9/9) unchanged in behavior.
- **Committed in:** `8c84ede` (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Necessary for the widened `HostAdapter` interface to compile; no scope creep, no behavior change to `approvals.test.ts`'s own assertions.

## Issues Encountered

None beyond the deviation above.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- LIFE-06 is fully closed: all three verifier types (`resource_query`, `user_confirm`, `none`) are implemented, tested, and funnel a completion outcome through the SAME `completeViaVerifier` -> `chainTeardownIfEnded` -> `runTeardown` path every other Phase 5 end reason uses (D-18).
- `resource-query.ts`/`user-confirm.ts` are standalone functions -- this plan does NOT wire an agent-facing "check done" MCP tool/signal into `dispatch.ts`'s `tools/call` flow; that trigger-entry-point wiring (if needed) is out of this plan's declared scope and was not implied by its files_modified.
- Plan 05-08 is the last plan in Phase 5; no blockers identified for it from this plan's work.

---
*Phase: 05-lease-endings-teardown*
*Completed: 2026-09-29*

## Self-Check: PASSED

- FOUND: packages/core/src/bindings.ts
- FOUND: packages/core/src/host-adapter.ts
- FOUND: packages/proxy/src/verification/resource-query.ts
- FOUND: packages/proxy/src/verification/user-confirm.ts
- FOUND: packages/proxy/test/verification.test.ts
- FOUND: packages/core/test/host-adapter.test.ts
- FOUND commit b477004 (feat(05-07): resource_query verifier (D-02, D-03, D-06, D-07))
- FOUND commit 8c84ede (feat(05-07): user_confirm HostAdapter method + await-helper (D-05))
- FOUND commit b9e6c48 (test(05-07): trigger discipline + none semantics + agent-claim proof (D-03))
- Re-ran Task 1 `<verify>`: `pnpm build && vitest run packages/proxy/test/verification.test.ts` -- passed at that commit's tree (7/7 resource_query tests)
- Re-ran Task 2 `<verify>`: `pnpm build && vitest run packages/core/test/host-adapter.test.ts packages/proxy/test/verification.test.ts` -- passed at that commit's tree (23/23)
- Re-ran Task 3 `<verify>`: `pnpm build && vitest run packages/proxy/test/verification.test.ts` -- passed at HEAD (13/13)
- Full re-run at HEAD: `tsc -b --force` clean; `eslint` clean on all changed files; `vitest run --pool=threads packages/core/test packages/proxy/test` -- 39 files, 351/351 tests passed
- Acceptance criteria re-verified for all three tasks (see plan-level `<verification>` block): resource_query true/false/error semantics, user_confirm yes/no/timeout semantics, none completes nothing, agent claim never completes any verifier type, verification receipts secretless (no raw rows/values/scrubbed-error-text), verifier read reuses the vault/connector path and never touches tools/list or action/spend counters.

plan_head_before: a8bc0987217b60fc1101eb57b3073592df5328fd
