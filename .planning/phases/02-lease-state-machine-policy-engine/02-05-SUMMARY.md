---
phase: 02-lease-state-machine-policy-engine
plan: 05
subsystem: core
tags: [host-adapter, lifecycle-events, deny-by-default, abort-signal, typescript, vitest]

# Dependency graph
requires:
  - phase: 02-lease-state-machine-policy-engine
    provides: "02-03: ConnectorBinding shape (bindings.ts) carried by ApprovalRequest"
  - phase: 02-lease-state-machine-policy-engine
    provides: "02-02: State/Event vocabulary (transitions.ts) LifecycleEvent's states mirror"
provides:
  - "HostAdapter three-method contract (requestConsent, requestApproval, notify) — HOST-01"
  - "LifecycleEvent discriminated union over the eight notifiable lease states"
  - "ConsentRequest/ConsentDecision, ApprovalRequest/ApprovalDecision types (D-18: no raw-args field)"
  - "awaitApprovalDecision/awaitConsentDecision — core-owned timeout-as-deny/decline wrappers (D-17)"
affects: [02-06, 04-proxy, 06-cli]

actuals:
  tokens: 3443
  tasks: 2
  commits: 2
  plan_head_before: 9cda10fbd6c3b89f78574e07c97d9ee89f8ee4c2

tech-stack:
  added: []
  patterns:
    - "AbortSignal-race wrapper: a Promise that resolves on the signal's 'abort' event (checked up front via signal.aborted) racing the adapter's own Promise, with the adapter's rejection branch resolving the same deny/decline value as the abort branch — no real timer inside core, caller arms the deadline (D-17)"
    - "HostAdapter modeled as a purely-typed three-method interface consumed only through two sanctioned wrapper functions, mirroring @stint/spec's TrustStore/VerifiedManifest 'small interface + guarded entry point' shape"

key-files:
  created:
    - packages/core/src/host-adapter.ts
    - packages/core/test/host-adapter.test.ts
  modified: []

key-decisions:
  - "LifecycleEvent has exactly one member per notifiable lease state (activated, completed, expired, revoked, failed, tearing_down, cleaned_up, cleanup_incomplete) — proposed/declined/granted are omitted as not independently notifiable per the plan's must_haves list, keeping the union tight rather than mirroring transitions.ts's full 11-state STATES array 1:1."
  - "Both wrappers share one structural shape (aborted-signal early-return, abort-listener race, adapter-rejection branch resolving the same sentinel value as abort) rather than a shared generic helper, so awaitApprovalDecision/awaitConsentDecision stay independently readable and each grep-gate-verifiable without a layer of indirection between the two decision-type shapes."
  - "Task 1 and Task 2 committed as two separate atomic commits (interface+types first, wrappers+tests second) by writing the file in two passes, mirroring 02-03's precedent for a plan whose two tasks land in the same file."

patterns-established: []

requirements-completed: [HOST-01, LIFE-05]

coverage:
  - id: D1
    description: "HostAdapter exports exactly three async methods (requestConsent, requestApproval, notify) that a platform builder implements; LifecycleEvent narrows exhaustively on a literal type field; ApprovalRequest exposes only approvalId/summary/binding, no raw-args field"
    requirement: HOST-01
    verification:
      - kind: unit
        ref: "pnpm build && pnpm exec tsc -b packages/core (compile-time: strict-mode compilation of the interface, unions, and grep gates over host-adapter.ts)"
        status: pass
    human_judgment: false
  - id: D2
    description: "awaitApprovalDecision/awaitConsentDecision resolve deny/decline on signal abort, an already-aborted signal, or adapter rejection, with no real timer armed inside core; approve/deny/grant pass through unchanged when the adapter resolves before abort"
    requirement: HOST-01
    verification:
      - kind: unit
        ref: "packages/core/test/host-adapter.test.ts (APPROVE PASSTHROUGH, DENY PASSTHROUGH, APPROVAL TIMEOUT, APPROVAL ADAPTER ERROR, ALREADY ABORTED, CONSENT GRANT PASSTHROUGH, CONSENT TIMEOUT, CONSENT ADAPTER ERROR)"
        status: pass
    human_judgment: false
  - id: D3
    description: "The fresh-consent mechanism a lease extension requires exists via requestConsent/awaitConsentDecision; reduce()'s extend event remains actor-user-only (already enforced by 02-02's transition table) — the Phase 4 proxy wiring that calls requestConsent before dispatching extend is out of this plan's scope"
    requirement: LIFE-05
    verification:
      - kind: unit
        ref: "packages/core/test/host-adapter.test.ts#awaitConsentDecision (CONSENT GRANT PASSTHROUGH, CONSENT TIMEOUT, CONSENT ADAPTER ERROR)"
        status: pass
    human_judgment: false

duration: 9min
completed: 2026-09-27
status: complete
---

# Phase 2 Plan 5: HostAdapter Contract & Core-Owned Timeout-as-Deny Summary

**The single three-method `HostAdapter` interface (`requestConsent`/`requestApproval`/`notify`) plus `awaitApprovalDecision`/`awaitConsentDecision`, the core-owned wrappers that turn adapter abort/non-response/error into deny/decline — never an allow/grant (HOST-01, D-17).**

## Performance

- **Duration:** 9 min
- **Started:** 2026-09-27T19:20:00Z (approx., first Read call)
- **Completed:** 2026-09-27T19:29:00Z
- **Tasks:** 2
- **Files modified:** 2 (both created)

## Accomplishments
- `host-adapter.ts`: `ConsentRequest`/`ConsentDecision`, `ApprovalRequest`/`ApprovalDecision` (the latter carrying only `approvalId`, `summary`, `binding` — no raw-args field, D-18), the `LifecycleEvent` discriminated union (8 notifiable states), and the `HostAdapter` interface (`requestConsent`, `requestApproval`, `notify`, all Promise-returning, D-16).
- `awaitApprovalDecision`/`awaitConsentDecision`: race the adapter call against an `AbortSignal`, resolving deny/timeout (approval) or decline/timeout (consent) on an already-aborted signal, a mid-flight abort, or an adapter rejection — no real timer armed inside core (D-17).
- `host-adapter.test.ts` (8 tests): approve/deny/grant passthrough, approval timeout, approval adapter-error, already-aborted, consent grant passthrough, consent timeout, consent adapter-error. Full monorepo `packages/core/test/` suite: 96 passing across 10 files.

## Task Commits

Each task was committed atomically:

1. **Task 1: HostAdapter interface, LifecycleEvent union, and request/decision types** - `9a8e250` (feat)
2. **Task 2: Core-owned timeout-as-deny / timeout-as-decline wrappers** - `baaac89` (feat)

**Plan metadata:** pending (docs: complete plan)

## Files Created/Modified
- `packages/core/src/host-adapter.ts` - `HostAdapter`, `LifecycleEvent`, `ConsentRequest`/`ConsentDecision`, `ApprovalRequest`/`ApprovalDecision`, `awaitApprovalDecision`, `awaitConsentDecision`
- `packages/core/test/host-adapter.test.ts` - 8 Vitest tests covering passthrough, timeout, adapter-error, and already-aborted cases for both wrappers

## Decisions Made
- `LifecycleEvent` covers exactly the eight lease states the plan's `must_haves.truths` names (`activated | completed | expired | revoked | failed | tearing_down | cleaned_up | cleanup_incomplete`) rather than mirroring all eleven `transitions.ts` `STATES` — `proposed`, `declined`, and `granted` are pre-activation states with no independent "notify the host" event named in this plan's scope.
- Both wrapper functions share one structural shape (early-return on an already-aborted signal, a `Promise` that resolves via an `abort` listener racing the adapter's own call, with the adapter-rejection branch resolving the same sentinel value the abort branch does) rather than factoring out a shared generic helper — keeps each function independently readable and matches the plan's per-function `<behavior>` list without an extra layer of indirection.
- Split Task 1 (interface + types) and Task 2 (wrappers + tests) into two atomic commits against the same file by writing the interface first, committing, then adding the wrapper functions and the test file in a second pass — mirrors 02-03-SUMMARY's precedent for a plan whose two tasks land in one module.

## Deviations from Plan

None - plan executed exactly as written. Both tasks' `<behavior>`, `<acceptance_criteria>`, and `<verify>` blocks pass without modification.

## Issues Encountered
None. `pnpm build`, `pnpm exec tsc -b packages/core --force`, `pnpm lint`, and `vitest run packages/core/test/` (96 tests, 10 files) all pass with zero regressions against 02-01 through 02-04's existing tests.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- `HostAdapter`, `LifecycleEvent`, and the two core-owned timeout wrappers are committed with stable signatures; the Phase 4 proxy can call `awaitApprovalDecision`/`awaitConsentDecision` directly (never `adapter.requestApproval`/`requestConsent` unwrapped) once it arms a real deadline and aborts the signal on timeout.
- `index.ts`'s barrel export was left unchanged (not in this plan's `files_modified` list, matching 02-01/02-03's precedent) — a later plan wires `host-adapter.ts`'s exports into `@stint/core`'s public surface.
- The Phase 4 proxy wiring that calls `awaitConsentDecision` before dispatching `userEvents.extend(...)` (LIFE-05's live enforcement) remains out of scope for Phase 2, as noted in the plan's objective; the reducer already restricts `extend` to actor `user` (02-02).
- The approval binding-hash format over resolved args + binding + lease version remains `[OPEN: Phase 4]` per the plan's objective — `ApprovalRequest` only carries the opaque `approvalId` in this phase.
- No blockers identified for 02-06 or later phases from this plan's deliverables.

---
*Phase: 02-lease-state-machine-policy-engine*
*Completed: 2026-09-27*

## Self-Check: PASSED

All created files found on disk (`packages/core/src/host-adapter.ts`, `packages/core/test/host-adapter.test.ts`); both task commits (`9a8e250`, `baaac89`) found in `git log --oneline --all`.
