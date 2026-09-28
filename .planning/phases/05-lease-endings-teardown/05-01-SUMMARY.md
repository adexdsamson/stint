---
phase: 05-lease-endings-teardown
plan: 01
subsystem: core
tags: [json-schema, receipts, lease-model, teardown, ajv, json-schema-to-typescript]

# Dependency graph
requires:
  - phase: 03-receipts-licensing
    provides: spec/receipt.schema.json, packages/spec/src/generated/receipt.ts, TeardownStepEntry/TeardownStepPayload
  - phase: 04-proxy-runtime
    provides: LeaseCounters.actionTimestamps additive-field precedent, @stint/core/testing conventions
provides:
  - Widened TeardownStepPayload.outcome enum (ok, not_applicable, attested_ok added)
  - Regenerated packages/spec/src/generated/receipt.ts and schemas.ts (codegen, never hand-edited)
  - Lease.teardownProgress optional field, plus TeardownStepName/TeardownStepOutcome/TeardownProgress types
  - makeTestLease (now exported) and makeTearingDownTestLease fixtures from @stint/core/testing
affects: [05-lease-endings-teardown]

# Actuals (#2632)
actuals:
  tokens: 2856
  tasks: 2
  commits: 4

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Schema-first, generated-types-never-hand-edited: edit spec/receipt.schema.json, run codegen, never touch generated/receipt.ts by hand"
    - "Additive-only @stint/core type extension mirroring LeaseCounters.actionTimestamps (Phase 4 precedent)"

key-files:
  created:
    - packages/core/test/lease-teardown-progress.test.ts
  modified:
    - spec/receipt.schema.json
    - packages/spec/src/generated/receipt.ts
    - packages/spec/src/generated/schemas.ts
    - packages/spec/test/types.test.ts
    - packages/core/src/lease.ts
    - packages/core/src/testing.ts
    - packages/core/src/index.ts

key-decisions:
  - "Added the widened-enum RED/GREEN test to packages/spec/test/types.test.ts (the nearest existing spec type test) rather than a new file, using Ajv-compiled receiptSchema for a real runtime assertion since TS literal-type mismatches don't fail under vitest's esbuild transform"
  - "Exported makeTestLease (was module-private) from @stint/core/testing per the plan's explicit option, since makeTearingDownTestLease and future Phase 5 proxy tests build on it"
  - "TeardownProgress must be a mapped type alias (type X = { [K in ...]?: V }), not an interface with an in-clause -- PATTERNS.md's suggested interface syntax is invalid TypeScript (TS7061), caught by pnpm typecheck and fixed inline (Rule 1)"

patterns-established:
  - "Ajv-compiled generated schema exports (receiptSchema) used directly in spec tests to prove enum widening at the validation layer, not just the type layer"

requirements-completed: [TEAR-01, TEAR-04, RCPT-07]

coverage:
  - id: D1
    description: "TeardownStepPayload.outcome enum widened to ok/not_applicable/attested_ok (plus existing revoked/discarded_revocation_unsupported/failed/cleanup_incomplete), with generated types regenerated via codegen"
    requirement: "RCPT-07"
    verification:
      - kind: unit
        ref: "packages/spec/test/types.test.ts#TeardownStepPayload.outcome widened enum (D-24)"
        status: pass
      - kind: unit
        ref: "packages/spec/test/codegen.test.ts#codegen check passes on committed output"
        status: pass
      - kind: integration
        ref: "packages/core/test/receipts/chain-golden.test.ts (golden-hash vector unchanged)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Lease.teardownProgress optional field added (additive), round-trips through LeaseStore and survives reduce() transitions unchanged; absent until teardown starts"
    requirement: "TEAR-01"
    verification:
      - kind: unit
        ref: "packages/core/test/lease-teardown-progress.test.ts#Lease.teardownProgress (D-14)"
        status: pass
      - kind: unit
        ref: "pnpm typecheck (tsc -b, project references)"
        status: pass
    human_judgment: false
  - id: D3
    description: "makeTearingDownTestLease fixture exported from @stint/core/testing for constructing partially-torn-down leases in downstream Phase 5 tests"
    requirement: "TEAR-04"
    verification:
      - kind: unit
        ref: "packages/core/test/lease-teardown-progress.test.ts#makeTearingDownTestLease produces a tearing_down lease with a caller-supplied partial progress record"
        status: pass
      - kind: unit
        ref: "packages/core/test/public-api.test.ts"
        status: pass
    human_judgment: false
  - id: D4
    description: "Outcome vocabulary can express every fixed-order teardown step for every auth mode (null cleanup hook -> not_applicable, hosted/delegated-only step -> not_applicable, never ok/failed)"
    human_judgment: true
    rationale: "This plan only lands the additive type/schema vocabulary (D-13/D-33's outcome values exist and type-check); the actual step logic that DECIDES which outcome a given auth mode/hook combination maps to is implemented by a later Phase 5 plan (teardown/steps.ts). Flagged 'backstop' in the plan's own must_haves -- no runnable assertion exists yet to auto-pass this."

# Metrics
duration: ~20min
completed: 2026-09-28
status: complete
---

# Phase 5 Plan 1: Teardown Outcome Vocabulary + Lease.teardownProgress Summary

**Widened the receipt schema's TeardownStepPayload.outcome enum (ok/not_applicable/attested_ok) and added an optional, additive Lease.teardownProgress field plus a makeTearingDownTestLease fixture, so every later Phase 5 teardown task compiles against the final shape.**

## Performance

- **Duration:** ~20 min
- **Started:** 2026-09-28T21:56:00Z
- **Completed:** 2026-09-28T22:05:00Z
- **Tasks:** 2
- **Files modified:** 7 (1 created, 6 modified)

## Accomplishments
- `TeardownStepPayload.outcome` (spec/receipt.schema.json) widened to 7 members: `revoked`, `discarded_revocation_unsupported`, `failed`, `cleanup_incomplete` (unchanged), plus new `ok`, `not_applicable`, `attested_ok` -- regenerated `packages/spec/src/generated/receipt.ts` and `schemas.ts` via `codegen`, never hand-edited
- Golden-hash receipt vector (`packages/core/test/receipts/chain-golden.test.ts`) still passes byte-identically -- the enum widening is additive-safe
- `Lease.teardownProgress?: TeardownProgress` added to `packages/core/src/lease.ts` alongside `TeardownStepName`/`TeardownStepOutcome`/`TeardownProgress` types -- optional so every existing call site keeps compiling, absent until teardown starts (D-14)
- `reduce()` required no edit: its existing `{ ...lease, ... }` `deepFreeze` spread already carries `teardownProgress` forward unchanged across any transition
- `makeTestLease` exported (was module-private) and new `makeTearingDownTestLease(id, overrides?)` fixture added to `@stint/core/testing`, both exported for downstream Phase 5 teardown-step tests

## Task Commits

Each task followed the RED -> GREEN TDD cycle:

1. **Task 1: Widen TeardownStepPayload.outcome enum + regenerate spec types**
   - `f2ed6d0` - `test(05-01): add failing test for widened TeardownStepPayload.outcome enum`
   - `472c4dd` - `feat(05-01): widen TeardownStepPayload.outcome enum`
2. **Task 2: Add optional Lease.teardownProgress field + teardown types + tearing-down fixture**
   - `b68c6a2` - `test(05-01): add failing test for Lease.teardownProgress`
   - `53df70a` - `feat(05-01): add optional Lease.teardownProgress + teardown fixtures`

**Plan metadata:** committed alongside this SUMMARY (see final commit below).

_No REFACTOR commits were needed -- both implementations were minimal, additive changes with no obvious cleanup opportunity after GREEN._

## Files Created/Modified
- `spec/receipt.schema.json` - Widened `TeardownStepPayload.outcome` enum with 3 additive members
- `packages/spec/src/generated/receipt.ts` - Regenerated via `json2ts` (codegen)
- `packages/spec/src/generated/schemas.ts` - Regenerated raw-schema export (codegen)
- `packages/spec/test/types.test.ts` - Added type-level + Ajv-validation assertions for the widened enum
- `packages/core/src/lease.ts` - Added `TeardownStepName`/`TeardownStepOutcome`/`TeardownProgress` types and optional `Lease.teardownProgress` field
- `packages/core/src/testing.ts` - Exported `makeTestLease`; added `makeTearingDownTestLease`
- `packages/core/src/index.ts` - Exported the three new teardown types from the public barrel
- `packages/core/test/lease-teardown-progress.test.ts` - New: round-trip, reduce-carry-forward, absent-by-default, and fixture tests

## Decisions Made
- Placed the widened-enum test in `packages/spec/test/types.test.ts` (plan's suggested "nearest existing spec type test") rather than creating a new file, using an Ajv-compiled `receiptSchema` validation assertion as the real RED/GREEN signal (a plain TS literal-type mismatch doesn't fail under vitest's esbuild transform, which strips types without checking them)
- Exported `makeTestLease` from `@stint/core/testing` (previously module-private) per the plan's explicit option, since `makeTearingDownTestLease` composes it and future Phase 5 proxy/teardown-step tests will need a base lease fixture too
- `TeardownProgress` is a mapped **type alias** (`type X = { [K in Name]?: Outcome }`), not an interface with an in-clause as PATTERNS.md's illustrative snippet showed -- TypeScript rejects mapped-type syntax inside an `interface` (TS7061: "A mapped type may not declare properties or methods")

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed invalid mapped-type-in-interface syntax (TS7061)**
- **Found during:** Task 2 (GREEN phase, `pnpm typecheck`)
- **Issue:** Initial `TeardownProgress` implementation followed 05-PATTERNS.md's illustrative code verbatim -- `export interface TeardownProgress { readonly [step in TeardownStepName]?: TeardownStepOutcome; }` -- which is invalid TypeScript. Mapped-type syntax (`[K in Union]`) is only legal inside a `type` alias, never inside an `interface`.
- **Fix:** Changed to `export type TeardownProgress = { readonly [step in TeardownStepName]?: TeardownStepOutcome; };` -- identical resulting shape, valid syntax.
- **Files modified:** `packages/core/src/lease.ts`
- **Verification:** `pnpm typecheck` (tsc -b) passes; `packages/core/test/lease-teardown-progress.test.ts` all 4 tests pass; full `packages/core/test/` suite (24 files, 205 tests) passes with no regressions.
- **Committed in:** `53df70a` (Task 2 GREEN commit)

---

**Total deviations:** 1 auto-fixed (1 bug)
**Impact on plan:** Trivial syntax fix caught immediately by typecheck before the GREEN commit; no scope creep, no behavior change from what the plan specified.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- The widened receipt-outcome enum and `Lease.teardownProgress` field are the two additive shapes every later Phase 5 plan (teardown orchestrator, the 5 injectable `TeardownStep`s, cleanup-token minting, revocation retrofit) compiles against -- ready for plan 05-02.
- D4 (the auth-mode-to-outcome mapping logic: null cleanup hook -> `not_applicable`, hosted/delegated-only step -> `not_applicable`) is vocabulary-only in this plan; the actual step-decision logic is deferred to the plan implementing `packages/proxy/src/teardown/steps.ts`, per 05-PATTERNS.md's file classification.
- No blockers.

---
*Phase: 05-lease-endings-teardown*
*Completed: 2026-09-28*
