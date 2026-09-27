---
phase: 02-lease-state-machine-policy-engine
plan: 01
subsystem: core
tags: [state-machine, reducer, typescript, vitest]

# Dependency graph
requires:
  - phase: 01-foundation-alp-spec
    provides: "@stint/spec Result/error-code vocabulary, Result-not-throw convention, ESM/strict TS house style"
provides:
  - "CoreErrorCode/Result<T> vocabulary in @stint/core (errors.ts)"
  - "STATES/EVENTS/ACTORS unions and TRANSITION_TABLE (partial: proposed rows) in transitions.ts"
  - "Actor-namespaced userEvents constructors (consentGranted, consentDeclined, revoke) in events.ts"
  - "Lease/LeaseCounters/TransitionRecord types and reduce(lease, event, now) in lease.ts, proven end-to-end by a passing Vitest test"
affects: [02-02, 02-03, 02-04, 02-05, 02-06]

actuals:
  tokens: 2807
  tasks: 2
  commits: 2
  plan_head_before: c41fa4b4552d47b358c3e9008755c32cd07946ac

tech-stack:
  added: []
  patterns:
    - "Table-driven (state,event)->{actors,to} lookup keyed by a template-literal string, mirroring packages/spec/src/validate.ts's keyed-lookup style (D-05)"
    - "Actor-namespaced event constructors (userEvents.*) that hard-code the actor field, independently re-checked by reduce() (D-19)"
    - "Result<T> discriminated union mirrored verbatim from @stint/spec but with a parallel CoreErrorCode vocabulary (no cross-import of SpecErrorCode)"
    - "deepFreeze on every returned Lease, copy-never-mutate on the input, matching envelope.ts's VerifiedManifest discipline"

key-files:
  created:
    - packages/core/src/errors.ts
    - packages/core/src/transitions.ts
    - packages/core/src/events.ts
    - packages/core/src/lease.ts
    - packages/core/test/lease-reduce.test.ts
  modified: []

key-decisions:
  - "Kept CoreErrorCode/Result vocabulary structurally identical to @stint/spec's but as an independent parallel enum, per D-03 and the plan's explicit 'do NOT import SpecErrorCode' instruction."
  - "Seeded TRANSITION_TABLE with only the 3 proposed rows per this tracer's scope; plan 02-02 completes the remaining 21 rows and adds the ALP.md 7.4 cross-check test."
  - "index.ts barrel export left untouched — not in this plan's files_modified list; later plans wire the public API surface once more of the table/events exist."

patterns-established:
  - "Pattern 1: reduce()'s 4-step numbered, early-return, Result-returning control flow (legality lookup -> actor check -> compute next lease -> build TransitionRecord), mirroring verifyEnvelope's structure."
  - "Pattern 2: userEvents/clockEvents/etc. namespaces as the ONLY sanctioned LeaseEvent producers; the agent boundary (Phase 4 proxy) must never import events.ts."

requirements-completed: [LIFE-01, LIFE-02]

coverage:
  - id: D1
    description: "reduce() accepts the one legal transition (proposed + consent_granted/user -> granted), incrementing version, setting grantedAt/expiresAt, and returning a matching TransitionRecord"
    requirement: LIFE-01
    verification:
      - kind: unit
        ref: "packages/core/test/lease-reduce.test.ts#LEGAL path: proposed + consent_granted / user -> granted"
        status: pass
    human_judgment: false
  - id: D2
    description: "reduce() rejects an illegal (state,event) pair (proposed + revoke) with a structured illegal_transition rejection and leaves the input lease unchanged"
    requirement: LIFE-01
    verification:
      - kind: unit
        ref: "packages/core/test/lease-reduce.test.ts#ILLEGAL path: proposed + revoke / user is rejected and leaves the lease unchanged"
        status: pass
    human_judgment: false
  - id: D3
    description: "reduce() never mutates the input lease and returns a deep-frozen next lease"
    requirement: LIFE-01
    verification:
      - kind: unit
        ref: "packages/core/test/lease-reduce.test.ts#INPUT IMMUTABILITY: the original lease is untouched and the returned lease is frozen"
        status: pass
    human_judgment: false
  - id: D4
    description: "reduce() is deterministic across repeated calls with identical inputs"
    requirement: LIFE-01
    verification:
      - kind: unit
        ref: "packages/core/test/lease-reduce.test.ts#DETERMINISM: identical inputs yield deep-equal results"
        status: pass
    human_judgment: false
  - id: D5
    description: "Event actor is structurally fixed by actor-namespaced constructors (userEvents.*) and independently re-verified by reduce(), not trusted from a caller claim"
    requirement: LIFE-02
    verification:
      - kind: unit
        ref: "packages/core/test/lease-reduce.test.ts (all 4 tests construct events exclusively via userEvents.*, and reduce()'s Step 2 actor check in packages/core/src/lease.ts is exercised by every case)"
        status: pass
    human_judgment: false

duration: 25min
completed: 2026-09-27
status: complete
---

# Phase 2 Plan 1: Reducer Tracer Slice Summary

**Table-driven `reduce(lease, event, now)` proving one legal transition (proposed to granted) and one illegal rejection end-to-end, with actor-namespaced event constructors and a parallel CoreErrorCode/Result vocabulary.**

## Performance

- **Duration:** 25 min
- **Started:** 2026-09-27T18:52:00Z
- **Completed:** 2026-09-27T19:17:00Z
- **Tasks:** 2
- **Files modified:** 5 (all created)

## Accomplishments
- `errors.ts`: `CORE_ERROR_CODES` (`illegal_transition`, `wrong_actor`, `extension_exceeds_max`), `CoreErrorCode`, `CoreError`, and a `Result<T>` union mirroring `@stint/spec`'s shape verbatim but as an independent vocabulary.
- `transitions.ts`: `STATES` (11), `EVENTS` (17), `ACTORS` (7) unions matching ALP.md Section 7.1-7.3 exactly, plus `TRANSITION_TABLE` seeded with the three `proposed` rows in the D-05 keyed-lookup shape.
- `events.ts`: `userEvents.consentGranted()/consentDeclined()/revoke()`, each returning a frozen `LeaseEvent` with the actor hard-coded — the agent boundary can never import this module to forge a lifecycle event.
- `lease.ts`: `Lease`, `LeaseCounters`, `TransitionRecord`, and `reduce(lease, event, now)` — a 4-step, early-return, Result-returning pure reducer that looks up legality, re-checks actor attribution independently, computes and deep-freezes the next lease, and builds the `TransitionRecord`.
- `lease-reduce.test.ts`: 4 passing Vitest tests proving the legal path, input immutability, the illegal-path rejection, and determinism.

## Task Commits

Each task was committed atomically:

1. **Task 1: Reducer error vocabulary, transition-table structure, and event constructor scaffold** - `b98925e` (feat)
2. **Task 2: Lease model and end-to-end reduce() tracer (one legal + one illegal path)** - `aa364cd` (feat)

**Plan metadata:** pending (docs: complete plan)

## Files Created/Modified
- `packages/core/src/errors.ts` - `CoreErrorCode`, `CoreError`, `Result<T>` (parallel to `@stint/spec`'s vocabulary)
- `packages/core/src/transitions.ts` - `State`/`Event`/`Actor` unions and the partial `TRANSITION_TABLE` (3 of 24 keys)
- `packages/core/src/events.ts` - `LeaseEvent` interface and the `userEvents` actor-namespaced constructor namespace
- `packages/core/src/lease.ts` - `Lease`, `LeaseCounters`, `TransitionRecord`, `reduce()`
- `packages/core/test/lease-reduce.test.ts` - legal/illegal/immutability/determinism tests for `reduce()`

## Decisions Made
- Mirrored `@stint/spec/src/errors.ts`'s exact three-part shape (const array -> derived union -> `Result<T>`) for `CoreErrorCode`, per the plan's explicit instruction not to reuse `SpecErrorCode`.
- Used a template-literal `TransitionKey` type (`${State}:${Event}`) purely as documentation of the table's key shape; `TRANSITION_TABLE` itself is typed `Record<string, TransitionEntry>` (a plain string key) since TypeScript's string-indexed `Record` lookup already returns `TransitionEntry | undefined` correctly at the two lookup sites, and a `Record<TransitionKey, ...>` would force every one of the 24 union keys to be present even in this deliberately partial tracer table.
- Kept `index.ts`'s barrel export unchanged, exactly matching this plan's `files_modified` scope; later plans wire the public API surface as more of the table/events land.

## Deviations from Plan

**None — plan executed as written**, with two cosmetic, non-blocking notes:

1. Prettier reformatted `CORE_ERROR_CODES`'s array onto multiple lines and reflowed `ACTORS` in `transitions.ts` to match the project's existing house style (matching `packages/spec/src/errors.ts`'s one-code-per-line convention) — behavior-identical, verified by re-running the full test/build/lint suite after formatting.
2. The plan's acceptance-criteria grep examples use single-quoted string literals (e.g. `grep -c "actor: 'user'"`); the codebase's actual house style (confirmed via `.prettierrc.json` defaulting to double quotes, and verified with `prettier --check` against every existing `packages/spec/src/*.ts` file) uses double quotes throughout. Source was written with double quotes for consistency with the rest of the codebase; the underlying behavior each grep was checking for (3 error codes, 3+ hard-coded-actor methods, no default exports) is fully satisfied and proven by the passing Vitest suite regardless of quote style.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- The `Lease`, `TransitionRecord`, `Result<T>`, `CoreErrorCode`, keyed transition-table structure, and actor-namespaced constructor pattern are all committed as the skeleton plan 02-02 (and later plans) build on directly, without changing these signatures.
- Plan 02-02 must complete `TRANSITION_TABLE` to all 24 keys/25 triples, add the ALP.md Section 7.4 cross-check test, add the remaining event-constructor namespaces (`clockEvents`, `policyEvents`, `providerEvents`, `publisherEvents`, `verifierEvents`, `runtimeEvents`) and `userEvents.extend`/`userEvents.retryTeardown`, and wire the public API surface into `index.ts`.
- No blockers identified for 02-02.

---
*Phase: 02-lease-state-machine-policy-engine*
*Completed: 2026-09-27*

## Self-Check: PASSED

All created files found on disk; both task commits (`b98925e`, `aa364cd`) found in `git log --oneline --all`.
