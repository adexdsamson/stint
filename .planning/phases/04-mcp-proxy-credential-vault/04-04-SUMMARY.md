---
phase: 04-mcp-proxy-credential-vault
plan: 04
subsystem: proxy
tags: [approvals, toctou, content-hash, mcp-proxy, host-adapter, typescript]

# Dependency graph
requires:
  - phase: 04-mcp-proxy-credential-vault
    plan: 02
    provides: "the ApprovalStage/ExecuteStage/CapEnforcer seams inside dispatch.ts's handleCall, running entirely inside one per-lease runInLeaseTransaction; DEFAULT_APPROVAL_STAGE denying by default"
  - phase: 02-lease-state-machine-policy-engine
    provides: "HostAdapter, awaitApprovalDecision (deny-by-default on abort/throw, D-17), ApprovalRequirement"
  - phase: 01-spec-foundation
    provides: "@stint/spec's hashCanonical/canonicalize (RFC 8785 JCS) -- the single serializer reused for the approval commitment hash"
provides:
  - "packages/proxy/src/approvals/approval-dispatcher.ts: computeApprovalHash(resolvedArgs, binding, leaseVersion) -- the confirmed D-11 tuple hashCanonical({ args, tool, provenance, leaseVersion }); createApprovalDispatcher(adapter, timeoutSeconds, clock) -- the real ApprovalStage: binding-redacted ApprovalRequest, module-private pending-approval Map, armed AbortController/setTimeout, resolves ONLY via awaitApprovalDecision; verifyCommitment(approvalId, currentHash) -- the sole recompute-and-match read path, consumes the entry on read"
  - "packages/proxy/src/dispatch.ts: handleCall's require_approval branch holds via ApprovalStage, then recomputes the commitment from the CURRENT args + freshly re-resolved binding + freshly-loaded lease version and denies approval_drifted on any mismatch before enforceCaps/execute run; CallContext gains leaseVersion; ApprovalDecision/ApprovalStage widened with approvalId/verifyCommitment"
  - "packages/proxy/src/index.ts: barrel exports createApprovalDispatcher, computeApprovalHash, PendingApproval as the production ProxyDeps.approve wiring"
affects: [04-05, 04-06, 04-07]

# Actuals (#2632)
actuals:
  tokens: 9310
  tasks: 3
  commits: 3

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Approval commitment is a content-addressed hashCanonical({ args, tool, provenance, leaseVersion }) minted at hold time (before the out-of-band wait) and recomputed at execution time from state re-derived fresh (re-resolved binding, freshly-loaded lease) -- never reused from pre-hold closures -- so all three D-11 drift vectors (arg change, binding hot-swap, mid-flight lease-version bump) collapse to the same approval_drifted denial via one verifyCommitment equality check"
    - "The pending-approval record is a module-private Map<approvalId, {commitmentHash, requestedAt}> whose ONLY read path (verifyCommitment) consumes the entry on read -- a single commitment can never be checked twice, and an unknown/already-consumed id always denies rather than throwing"
    - "createApprovalDispatcher is the one place in @stint/proxy that arms a REAL timer (setTimeout -> AbortController.abort()) sourced from timeoutSeconds -- deliberately different from evaluatePolicy's pure now-comparison expiry check, because an interactive out-of-band human wait genuinely needs a real deadline, not a re-checkable snapshot"

key-files:
  created:
    - packages/proxy/src/approvals/approval-dispatcher.ts
    - packages/proxy/test/approvals.test.ts
  modified:
    - packages/proxy/src/dispatch.ts
    - packages/proxy/src/index.ts
    - packages/proxy/test/caps-concurrency.test.ts

key-decisions:
  - "Task 1 checkpoint (pre-cleared by the orchestrator, user selected proposed-tuple): the D-11 commitment hash is hashCanonical({ args: resolvedArgs, tool: binding.tool, provenance: binding.provenance, leaseVersion: lease.version }) -- resolving D-11's ambiguous 'tool + provenance/version' wording as binding.provenance (not a per-binding version field ConnectorBinding doesn't have) plus the lease's own version. Flagged for the verifier as the binding resolution of this ambiguity."
  - "CallContext (dispatch.ts, 04-02-owned) widened with a leaseVersion field, and ApprovalStage widened with a verifyCommitment(approvalId, currentHash) method plus an optional approvalId on ApprovalDecision -- a minimal, additive seam extension (mirrors 04-03's precedent widening CapEnforcer) needed so dispatch.ts can carry the hash-tuple inputs to the dispatcher and read a held approval's commitment back for the recompute-and-match. DEFAULT_APPROVAL_STAGE and the pre-existing caps-concurrency.test.ts ALWAYS_APPROVE double were both updated to satisfy the widened interface."
  - "The recompute-and-match in dispatch.ts re-derives BOTH the binding (a fresh resolveEffectiveBinding(deps.bindings, ...) call, not the pre-hold `binding` closure) and the lease version (a fresh deps.leaseStore.load(deps.leaseId), not the transaction's closed-over `lease` parameter) at execution time -- this is what makes a binding hot-swap or an out-of-band leaseStore.save() bypassing the transaction's own serialization actually observable and catchable, rather than silently trusting the pre-hold snapshot."
  - "The arg-drift D-11 vector is tested via a test-local ApprovalStage double that mints a commitment over deliberately different args than the ones dispatch.ts recomputes against, rather than a HostAdapter that mutates args mid-hold -- because the HostAdapter interface deliberately never receives resolvedArgs (D-18, raw args never reach the out-of-band adapter), so a literal 'adapter mutates args' race is architecturally impossible by design, not an untested gap. The binding-hot-swap and lease-version-bump vectors ARE exercised through the real createApprovalDispatcher + a stub HostAdapter that mutates deps.bindings / calls leaseStore.save directly during the hold, since HostAdapter callbacks do have closure access to those shared, mutable objects in the test harness."
  - "All three D-11 drift outcomes and a failed recompute collapse to one proxy-owned deny reason, approval_drifted -- distinct from evaluatePolicy's POLICY_REASON_CODES (no_binding/expired/over_*) and from the approval decision's own user_denied/timeout, since drift is detected by dispatch.ts itself, not by evaluatePolicy or the ApprovalStage's own decision."

patterns-established:
  - "approvals/approval-dispatcher.ts: module-private Map + consume-on-read verifyCommitment is the pattern any future single-use, content-addressed commitment (e.g. a Phase 6 persisted-approval re-consent flow) should mirror -- an unknown or already-checked id always denies, never throws."

requirements-completed: [PRXY-05]

coverage:
  - id: D1
    description: "computeApprovalHash is a pure function of the confirmed D-11 tuple (args, tool, provenance, leaseVersion) via hashCanonical -- equal for equal inputs, and any single-field drift (args, tool, provenance, or leaseVersion) changes the hash"
    requirement: PRXY-05
    verification:
      - kind: unit
        ref: "packages/proxy/test/approvals.test.ts#createApprovalDispatcher: commitment hash (computeApprovalHash)"
        status: pass
    human_judgment: false
  - id: D2
    description: "createApprovalDispatcher arms a real timer from timeoutSeconds and resolves only through awaitApprovalDecision -- a never-resolving adapter denies timeout once the timer fires, and a decision arriving one tick past the deadline still loses the race and denies (boundary)"
    requirement: PRXY-05
    verification:
      - kind: unit
        ref: "packages/proxy/test/approvals.test.ts#createApprovalDispatcher: armed timeout"
        status: pass
    human_judgment: false
  - id: D3
    description: "an adapter that throws denies (never allows), and the ApprovalRequest sent to the adapter never carries a raw call argument"
    requirement: PRXY-05
    verification:
      - kind: unit
        ref: "packages/proxy/test/approvals.test.ts#createApprovalDispatcher: deny-by-default"
        status: pass
    human_judgment: false
  - id: D4
    description: "an approved, un-drifted call executes end-to-end and appends exactly one allowed receipt"
    requirement: PRXY-05
    verification:
      - kind: integration
        ref: "packages/proxy/test/approvals.test.ts#PRXY-05 approval integration: approve executes"
        status: pass
    human_judgment: false
  - id: D5
    description: "all three D-11 drift vectors (arg drift, binding hot-swap, mid-flight lease-version bump) deny the reused approval as approval_drifted, recomputed and matched inside the per-lease transaction"
    requirement: PRXY-05
    verification:
      - kind: integration
        ref: "packages/proxy/test/approvals.test.ts#PRXY-05 approval integration: drift denies the reused approval"
        status: pass
    human_judgment: false
  - id: D6
    description: "a never-answered approval denies timeout end-to-end through the full dispatch + receipt path, appending exactly one denied receipt"
    requirement: PRXY-05
    verification:
      - kind: integration
        ref: "packages/proxy/test/approvals.test.ts#PRXY-05 approval integration: timeout denies at the boundary"
        status: pass
    human_judgment: false
  - id: D7
    description: "a pay call is held via the ApprovalStage even when approvals.require_for omits it"
    requirement: PRXY-05
    verification:
      - kind: integration
        ref: "packages/proxy/test/approvals.test.ts#PRXY-05 approval integration: pay always requires approval"
        status: pass
    human_judgment: false

# Metrics
duration: ~30min
completed: 2026-09-28
status: complete
---

# Phase 4 Plan 4: TOCTOU-Safe Out-of-Band Approvals Summary

**Fills the 04-02 `ApprovalStage` seam with a real `HostAdapter`-backed dispatcher: every `send`/`pay`/`irreversible` call is held out-of-band, bound to a content-addressed `hashCanonical({args, tool, provenance, leaseVersion})` commitment, recomputed and exact-matched at execution against freshly re-derived state, and denied on any of the three D-11 drift vectors or a real armed timeout.**

## Performance

- **Duration:** ~30 min
- **Started:** 2026-09-28T18:2x (approx, first file read)
- **Completed:** 2026-09-28T18:37
- **Tasks:** 3 (Task 1 checkpoint pre-cleared by orchestrator; Task 2 TDD RED+GREEN; Task 3 wiring + integration tests)
- **Files modified:** 5 (2 created, 3 modified)

## Accomplishments
- `approvals/approval-dispatcher.ts`'s `computeApprovalHash` implements the Task-1-confirmed D-11 tuple verbatim (`hashCanonical({ args: resolvedArgs, tool: binding.tool, provenance: binding.provenance, leaseVersion: lease.version })`) over `@stint/spec`'s canonical serializer only -- no second serializer, no `JSON.stringify`.
- `createApprovalDispatcher` is the real `ApprovalStage`: builds a binding-redacted `ApprovalRequest` (no raw args anywhere, D-18), mints a commitment into a module-private, consume-on-read `Map`, arms a real `AbortController`/`setTimeout` from `timeoutSeconds`, and resolves ONLY through `@stint/core`'s `awaitApprovalDecision` -- a slow, throwing, or hostile `HostAdapter` can never turn a held call into an allow.
- `dispatch.ts`'s `require_approval` branch (the exact seam 04-02 left open, no other flow changed) now recomputes the commitment at execution time from state re-derived FRESH -- a new `resolveEffectiveBinding` call and a new `leaseStore.load` -- rather than trusting the pre-hold closures, so a binding hot-swap or an out-of-band lease-version bump during the hold is actually observable and denies `approval_drifted`, closing all three D-11 TOCTOU vectors.
- Proven end-to-end over the real 04-02 MCP server (`InMemoryTransport`): approve-executes appends one `allowed` receipt; each of the three drift vectors independently denies; a never-answered approval denies `timeout` (including the exact-deadline-vs-one-tick-past boundary) with one `denied` receipt; `pay` is held even when `approvals.require_for` omits it. The 04-02 tracer and the full 44-test `@stint/proxy` suite stay green.

## Task Commits

Each task was committed atomically (Task 2 followed the RED-GREEN TDD cycle per its `tdd="true"` attribute):

1. **Task 1: Lock the approval commitment-hash input tuple** - pre-cleared checkpoint, no code; resolution implemented verbatim in Task 2.
2. **Task 2 (RED): failing tests for commitment hash, armed timeout, deny-by-default** - `eac3186` (test)
3. **Task 2 (GREEN): implement approval dispatcher** - `0e265a4` (feat)
4. **Task 3: wire require_approval into dispatch + drift/timeout/pay-always tests** - `87e28be` (feat)

**Plan metadata:** committed separately after this SUMMARY (see final metadata commit).

## Files Created/Modified
- `packages/proxy/src/approvals/approval-dispatcher.ts` - NEW: `computeApprovalHash`, `createApprovalDispatcher` (armed timeout, deny-by-default, module-private pending-approval store), `verifyCommitment`, `PendingApproval`
- `packages/proxy/src/dispatch.ts` - `require_approval` branch holds via `ApprovalStage` then recompute-and-matches before proceeding; `CallContext`/`ApprovalDecision`/`ApprovalStage` widened; `DEFAULT_APPROVAL_STAGE` updated to match
- `packages/proxy/src/index.ts` - barrel: exported `createApprovalDispatcher`, `computeApprovalHash`, `PendingApproval`, `PRXY-05`-annotated
- `packages/proxy/test/approvals.test.ts` - NEW: 9 unit tests (commitment hash, armed timeout, deny-by-default) + 7 integration tests (approve-executes, 3 drift vectors, timeout, pay-always), 16 total, all green
- `packages/proxy/test/caps-concurrency.test.ts` - `ALWAYS_APPROVE` double updated (`approvalId` + `verifyCommitment`) to satisfy the widened `ApprovalStage` interface (Rule 3)

## Decisions Made
- Task 1's checkpoint (pre-cleared by the orchestrator; user selected `proposed-tuple`) locked the D-11 commitment tuple as `hashCanonical({ args: resolvedArgs, tool: binding.tool, provenance: binding.provenance, leaseVersion: lease.version })` -- resolving D-11's "tool + provenance/version" wording as `binding.provenance` plus the lease's own `version` (not a per-binding version field `ConnectorBinding` doesn't carry). Flagged for the verifier as this plan's resolution of that ambiguity.
- Widened the 04-02 `ApprovalStage` seam (`CallContext` gains `leaseVersion`; `ApprovalDecision` gains optional `approvalId`; `ApprovalStage` gains `verifyCommitment`) -- a minimal, additive extension (Rule 3, mirroring 04-03's precedent widening `CapEnforcer`) required so `dispatch.ts` can supply the commitment-hash inputs and read a held approval's stored commitment back for the recompute-and-match. `DEFAULT_APPROVAL_STAGE` and the pre-existing `caps-concurrency.test.ts` `ALWAYS_APPROVE` double were both updated to keep the build green.
- The recompute-and-match re-derives the binding (fresh `resolveEffectiveBinding`) and the lease version (fresh `leaseStore.load`) at execution time rather than reusing the pre-hold `binding`/`lease` closures -- this is the specific design choice that makes a binding hot-swap or an out-of-band `leaseStore.save()` (bypassing the transaction's own serialization) actually observable, closing the mid-flight-mutation vector the plan's `flagged_assumptions` called out.
- The arg-drift vector is tested via a test-local `ApprovalStage` double that mints a stale commitment directly, rather than a `HostAdapter` mutating args mid-hold, because `HostAdapter.requestApproval` deliberately never receives `resolvedArgs` (D-18) -- a literal "adapter mutates args" race is architecturally impossible by design here, not an untested gap. The binding-hot-swap and lease-version-bump vectors ARE exercised through the real `createApprovalDispatcher` + a stub `HostAdapter`, since those adapters have closure access to the shared, mutable `deps.bindings`/`leaseStore` test objects.
- All three drift outcomes and a failed recompute share one proxy-owned deny reason, `approval_drifted`, distinct from `evaluatePolicy`'s `POLICY_REASON_CODES` and from the approval decision's own `user_denied`/`timeout` reasons.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Widened the 04-02 `ApprovalStage`/`CallContext`/`ApprovalDecision` seam**
- **Found during:** Task 2 (writing `approval-dispatcher.ts` against the 04-02 seam)
- **Issue:** The 04-02 `CallContext` had no `leaseVersion` field (needed to compute the D-11 commitment tuple), and `ApprovalStage` had no way for `dispatch.ts` to read a held approval's stored commitment back for the recompute-and-match at execution time.
- **Fix:** Added `leaseVersion: number` to `CallContext`; added optional `approvalId` to `ApprovalDecision`; added `verifyCommitment(approvalId, currentHash): boolean` to `ApprovalStage`. Updated `DEFAULT_APPROVAL_STAGE` (dispatch.ts) and `caps-concurrency.test.ts`'s `ALWAYS_APPROVE` double to implement the widened interface.
- **Files modified:** `packages/proxy/src/dispatch.ts`, `packages/proxy/test/caps-concurrency.test.ts`
- **Verification:** Workspace `tsc -b` clean; full `@stint/proxy` suite (44 tests) passes with no regression; scoped `eslint packages/proxy/src packages/proxy/test` clean.
- **Committed in:** `0e265a4` (approval-dispatcher.ts's own use of the widened types) and `87e28be` (the seam widening itself + the existing-file fix)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Minimal, additive interface widening required for the plan's own D-11 recompute-and-match behavior to be implementable and typecheck. No scope creep -- dispatch.ts's overall flow (evaluate -> approve -> authorize caps -> execute -> commit, receipt in `finally`) is unchanged; only the `require_approval` branch itself gained the recompute-and-match step, exactly as the plan specified.

## Issues Encountered
None beyond the seam-widening deviation above. Both Task 2's `<verify>` command and Task 3's `<verify>` command passed on their respective implementation runs; the full `@stint/proxy` suite and a `tsdown` build were also run as extra confirmation and both succeeded.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- `approvals/approval-dispatcher.ts`, the widened `ApprovalStage` seam, and the D-11 commitment-hash contract are all in place, tested, and exported from the barrel -- PRXY-05 is fully satisfied (out-of-band hold, all three drift vectors denied, timeout denies by default, receipted).
- **Flagged for the verifier:** the pending-approval `Map` is in-process only (Phase 4 scope, per the plan's own `flagged_assumptions`) -- restart-survival of a mid-flight approval is out of scope; Phase 6 persists it.
- **Flagged for the verifier:** the D-11 tuple's "provenance/version" ambiguity was resolved as `binding.provenance` + `lease.version` (Task 1 checkpoint, `proposed-tuple`) -- confirm this reading matches spec/ALP.md Section 9's intent if that section is revisited.
- Plan 04-05 (vault-backed `ExecuteStage`) can proceed against `dispatch.ts`'s `ExecuteStage` seam, untouched by this plan.
- No blockers identified for 04-05 onward.

---
*Phase: 04-mcp-proxy-credential-vault*
*Completed: 2026-09-28*

## Self-Check: PASSED

All claimed created/modified files exist on disk and all claimed commit hashes (`eac3186`, `0e265a4`, `87e28be`) are present in git history.
