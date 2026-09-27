---
phase: 02-lease-state-machine-policy-engine
plan: 06
subsystem: core
tags: [lease-store, concurrency, contract-testing, public-api, typescript, vitest, tsdown]

# Dependency graph
requires:
  - phase: 02-lease-state-machine-policy-engine
    provides: "02-01 through 02-05: Lease/reduce, full TRANSITION_TABLE, evaluatePolicy/checkErrorThreshold, ConnectorBinding/BindingSet, verifyBoundHash/activateLease/resumeLease, HostAdapter/LifecycleEvent — every Phase 2 symbol this plan wires into the public barrel"
provides:
  - "LeaseStore async CRUD contract + serialized transaction(id, mutate) read-modify-write primitive (lease-store.ts, D-13)"
  - "createInMemoryLeaseStore + createLeaseStoreContractTests reusable suite exported from @stint/core/testing (testing.ts, D-14)"
  - "Complete @stint/core public barrel (index.ts) exporting every Phase 2 symbol; ./testing package export + tsdown second entry"
affects: [04-proxy, 05-teardown, 06-cli]

actuals:
  tokens: 3983
  tasks: 3
  commits: 3
  plan_head_before: bcc6fa33a65f553b7bc705031b146afbfe74ab00

tech-stack:
  added: []
  patterns:
    - "Per-id promise-chain serialization: a Map<string, Promise<unknown>> of tails, each transaction(id, ...) appended via chain.then(work), so same-id operations run strictly one after another while different ids proceed independently (D-13) — no existing analog in the tracked codebase, designed directly from CONTEXT.md D-13 per 02-PATTERNS' 'No Analog Found' note."
    - "Reusable Vitest suite factory: createLeaseStoreContractTests(makeStore) registers describe/it internally (mirroring signManifestForTest's 'importable, reusable across test files' shape but for a test-registering function rather than a fixture-returning one), so Phase 6's JSON-file store re-runs the identical suite and cannot drift from the in-memory double's guarantees."
    - "vitest declared as an optional peerDependency of @stint/core so tsdown/rolldown externalizes it from the ./testing bundle instead of inlining vitest's ~570KB runtime into dist/testing.js."

key-files:
  created:
    - packages/core/src/lease-store.ts
    - packages/core/src/testing.ts
    - packages/core/test/lease-store-contract.test.ts
    - packages/core/test/public-api.test.ts
  modified:
    - packages/core/src/index.ts
    - packages/core/package.json
    - packages/core/tsdown.config.ts

key-decisions:
  - "transaction() swallows a prior transaction's rejection before chaining the next one (previousTail.catch(() => undefined).then(work)), so one failed read-modify-write on an id never wedges every later transaction for that same id."
  - "Added vitest as an optional peerDependency (packages/core/package.json) rather than a regular dependency, since only the ./testing subpath needs it and production consumers of the '.' entry should never pull it in; this also makes tsdown externalize it instead of bundling ~570KB of vitest internals into dist/testing.js (verified: bundle size dropped from 577KB to 5.46KB after the change)."
  - "index.ts barrel exports every Phase 2 symbol grouped by source module in dependency order (errors -> transitions -> events -> lease -> bindings -> policy -> hash-guard -> activate -> host-adapter -> lease-store types), mirroring @stint/spec/src/index.ts's export{values}/export type{Types} split; testing.ts is never imported by index.ts (grep -c \"testing\" returns 0), satisfying D-14's public-entry exclusion."

patterns-established:
  - "Pattern 6: a package's test-utility subpath (./testing) that itself uses the test runner (describe/it/expect) declares that runner as an optional peerDependency so the bundler externalizes it — the first case in this repo where a subpath's own runtime code, not just its consuming test files, imports vitest."

requirements-completed: [HOST-01]

coverage:
  - id: D1
    description: "LeaseStore is an async interface (load/save/list/delete/transaction) with a serialized read-modify-write primitive; the per-lease serialization requirement is documented in the contract"
    requirement: HOST-01
    verification:
      - kind: unit
        ref: "pnpm build && pnpm exec tsc -b packages/core (compile-time: interface shape, grep gates over lease-store.ts)"
        status: pass
    human_judgment: false
  - id: D2
    description: "The in-memory LeaseStore double and createLeaseStoreContractTests factory are exported from @stint/core/testing; the public . entry never re-exports them"
    requirement: HOST-01
    verification:
      - kind: unit
        ref: "packages/core/test/public-api.test.ts#does not export the in-memory LeaseStore test double from the public entry (D-14)"
        status: pass
    human_judgment: false
  - id: D3
    description: "The shared contract suite proves per-lease serialization: 50 concurrent transaction(id, mutate) calls that each increment a version counter produce exactly the final value 50, with no lost updates; independent ids proceed concurrently; an absent id rejects; CRUD empty/round-trip edges hold"
    requirement: HOST-01
    verification:
      - kind: unit
        ref: "packages/core/test/lease-store-contract.test.ts (7 tests: CRUD x4, SERIALIZATION, INDEPENDENT IDS, ABSENT ID) via createLeaseStoreContractTests"
        status: pass
    human_judgment: false
  - id: D4
    description: "@stint/core's public barrel exports reduce, event constructors, evaluatePolicy, checkErrorThreshold, ConnectorBinding/BindingSet, HostAdapter/LifecycleEvent, LeaseStore types, activateLease/resumeLease, verifyBoundHash and their types, while preserving SPEC_VERSION and PACKAGE_NAME"
    requirement: HOST-01
    verification:
      - kind: unit
        ref: "packages/core/test/public-api.test.ts (function-typeof assertions, table/vocabulary presence, SPEC_VERSION/PACKAGE_NAME preservation, type-only import compile check)"
        status: pass
      - kind: unit
        ref: "packages/core/test/smoke.test.ts (unchanged, still passing)"
        status: pass
    human_judgment: false
  - id: D5
    description: "The @stint/core/testing subpath resolves after build: dist/testing.js and dist/testing.d.ts exist, mirroring @stint/spec/testing, so Phase 6's JSON-file store can import and run the identical contract suite"
    requirement: HOST-01
    verification:
      - kind: other
        ref: "ls packages/core/dist/testing.js packages/core/dist/testing.d.ts (both present after pnpm build)"
        status: pass
    human_judgment: false
  - id: D6
    description: "Whole monorepo builds, typechecks, lints, tests, and passes codegen:check green"
    verification:
      - kind: other
        ref: "pnpm build && pnpm typecheck && pnpm lint && pnpm test && pnpm codegen:check (193 tests / 24 files passing)"
        status: pass
    human_judgment: false

duration: 25min
completed: 2026-09-27
status: complete
---

# Phase 2 Plan 6: LeaseStore Contract & Public API Wiring Summary

**Async `LeaseStore` contract with a per-id promise-chain-serialized `transaction()` primitive, an in-memory double + reusable `createLeaseStoreContractTests` suite at `@stint/core/testing`, and the completed `@stint/core` public barrel exporting every Phase 2 symbol — the last plan in Phase 2, leaving the whole monorepo green.**

## Performance

- **Duration:** 25 min
- **Started:** 2026-09-27T19:20:00Z (approx., first Read call)
- **Completed:** 2026-09-27T19:43:00Z
- **Tasks:** 3
- **Files modified:** 7 (4 created, 3 modified)

## Accomplishments
- `lease-store.ts`: `LeaseMutator` type and the `LeaseStore` interface (`load`/`save`/`list`/`delete`/`transaction`), all Promise-returning, with the per-lease serialization requirement (ALP.md Section 9, D-13) documented directly in the contract's docblock.
- `testing.ts`: `createInMemoryLeaseStore()` — a `Map`-backed double whose `transaction(id, mutate)` runs on a per-id promise chain (different ids proceed independently, same-id calls never interleave) — plus `createLeaseStoreContractTests(makeStore)`, a reusable Vitest suite any `LeaseStore` implementation can be run against.
- `lease-store-contract.test.ts`: invokes the shared suite against the in-memory double — 7 passing tests covering CRUD edges, the 50-concurrent-transaction no-lost-updates proof, independent-id concurrency, and absent-id rejection.
- `index.ts`: rewritten to export the complete Phase 2 surface — `reduce`, all seven actor-namespaced event constructor namespaces, `evaluatePolicy`/`checkErrorThreshold`, `ConnectorBinding`/`BindingSet`, `HostAdapter`/`LifecycleEvent` and its request/decision types, `activateLease`/`resumeLease`, `verifyBoundHash`, `LeaseStore`/`LeaseMutator` types, `TRANSITION_TABLE`/`STATES`/`EVENTS`/`ACTORS`, `CORE_ERROR_CODES` — while preserving `SPEC_VERSION` and `PACKAGE_NAME`, and never re-exporting `testing.ts` (D-14).
- `package.json`/`tsdown.config.ts`: added the `./testing` exports block and the second tsdown entry; added `vitest` as an optional peerDependency so the bundler externalizes it instead of inlining ~570KB of vitest internals.
- `public-api.test.ts`: 6 passing tests proving the barrel's function/table/vocabulary exports, `SPEC_VERSION`/`PACKAGE_NAME` preservation, the test double's absence from the public entry, and a type-only-import compile check.
- Whole monorepo: `pnpm build && pnpm typecheck && pnpm lint && pnpm test && pnpm codegen:check` all pass — 193 tests across 24 files, zero regressions.

## Task Commits

Each task was committed atomically:

1. **Task 1: LeaseStore async contract with a serialized read-modify-write primitive** - `d59b3d1` (feat)
2. **Task 2: In-memory LeaseStore double + reusable contract-test factory at @stint/core/testing** - `ddd175e` (feat)
3. **Task 3: Wire the @stint/core public API surface (barrel, ./testing export, tsdown entry) and prove the phase green** - `5ff0ae7` (feat)

**Plan metadata:** pending (docs: complete plan)

## Files Created/Modified
- `packages/core/src/lease-store.ts` - `LeaseMutator`, `LeaseStore` (load/save/list/delete/transaction)
- `packages/core/src/testing.ts` - `createInMemoryLeaseStore`, `createLeaseStoreContractTests`
- `packages/core/test/lease-store-contract.test.ts` - invokes the shared contract suite against the in-memory double
- `packages/core/src/index.ts` - complete public barrel (every Phase 2 symbol; testing.ts never re-exported)
- `packages/core/package.json` - `./testing` exports block, optional `vitest` peerDependency
- `packages/core/tsdown.config.ts` - second entry (`./src/testing.ts`)
- `packages/core/test/public-api.test.ts` - barrel-surface and test-double-absence assertions

## Decisions Made
- `transaction()`'s per-id chain swallows a prior failure (`previousTail.catch(() => undefined).then(work)`) before appending the next transaction, so one rejected read-modify-write (e.g. an absent-id call) never wedges every later transaction queued for that same id.
- Added `vitest` as an **optional peerDependency** of `@stint/core` (not a regular dependency) once `pnpm build` revealed tsdown/rolldown was bundling the entire vitest runtime (577KB) into `dist/testing.js` because it wasn't declared anywhere in `package.json`. This mirrors how `@stint/spec` avoids bundling `jose` (declared as a real dependency) — the only difference is `vitest` is peer/optional since production consumers of the `.` entry never need it, only consumers of `./testing`. Verified: bundle size dropped from 577KB to 5.46KB after the change, with no behavior difference.
- `index.ts` groups exports by source module in the dependency order the plan specified (errors → transitions → events → lease → bindings → policy → hash-guard → activate → host-adapter → lease-store types), following `@stint/spec/src/index.ts`'s `export { values } ... export type { Types }` split per module.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] vitest bundled into dist/testing.js (577KB) instead of externalized**
- **Found during:** Task 3 (first `tsdown` build after adding the `./src/testing.ts` entry)
- **Issue:** `testing.ts` imports `describe`/`it`/`expect` from `vitest` per the plan's explicit instruction, but `vitest` was not declared anywhere in `packages/core/package.json`. tsdown/rolldown only externalizes packages listed in `dependencies`/`peerDependencies`, so it inlined vitest's entire runtime (plus `chai`, `tinybench`, `expect-type`, `@jridgewell/sourcemap-codec`, `magic-string`) into the built `dist/testing.js`, ballooning it to 577KB.
- **Fix:** Added `vitest: "5.0.2"` as an optional `peerDependency` in `packages/core/package.json` (matching the root-pinned version). Reran `pnpm install` (which pnpm did automatically on the next `tsdown` invocation) and rebuilt.
- **Files modified:** `packages/core/package.json`, `pnpm-lock.yaml` (peer resolution entry added under `packages/core`).
- **Verification:** `dist/testing.js` dropped to 5.46KB after the change; `pnpm build && pnpm typecheck && pnpm lint && pnpm test && pnpm codegen:check` all still pass.
- **Committed in:** `5ff0ae7` (Task 3 commit).

### Minor, Cosmetic Acceptance-Criteria Mismatch

**2. The serialization-test grep on `lease-store-contract.test.ts` finds no `Promise.all`/`Array.from`**
- **Found during:** Task 2 self-check against `<acceptance_criteria>`
- **Issue:** The plan's acceptance criteria says `grep -cE "Promise.all|Array.from" packages/core/test/lease-store-contract.test.ts` should return at least 1, but that file is a three-line invocation (`createLeaseStoreContractTests(() => createInMemoryLeaseStore())`) per the plan's own `<action>` text; the actual `Promise.all`/`Array.from`-based 50-concurrent-transaction test lives inside `testing.ts`'s `createLeaseStoreContractTests` factory, not the invocation file.
- **Why not "fixed":** Moving the concurrency-test body into the per-plan test file would defeat D-14's entire purpose — the suite must be reusable so Phase 6's JSON-file store can import and re-run the IDENTICAL test logic, not a copy. Keeping the test body inside the shared factory (and the invocation file thin) is the only way to satisfy D-14's "cannot drift" guarantee. This mirrors the precedent set in 02-01-SUMMARY (quote-style grep mismatch) and 02-03-SUMMARY (reason-code count grep mismatch): the underlying behavior — a 50-concurrent-transaction no-lost-updates proof, verified via `Promise.all`/`Array.from` in `testing.ts` — is fully satisfied and independently proven by the passing test suite (`pnpm exec vitest run packages/core/test/lease-store-contract.test.ts` — 7/7 passing).
- **Impact:** None — cosmetic, informational only; no functional gap.

---

**Total deviations:** 1 auto-fixed (Rule 3, blocking build issue), 1 cosmetic acceptance-criteria note (no functional gap).
**Impact on plan:** No scope creep, no incorrect behavior shipped. All required `<behavior>` assertions, `must_haves.truths`, and the plan's overall `<verification>` block pass.

## Issues Encountered
None beyond the vitest-bundling build issue documented above, which was resolved within Task 3's scope before committing.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- `LeaseStore`, `createInMemoryLeaseStore`, and `createLeaseStoreContractTests` are committed with stable signatures; Phase 4 (proxy) and Phase 5 (teardown) can depend on `LeaseStore` directly, and Phase 6's JSON-file store (HOST-03, `proper-lockfile`-backed) can import `createLeaseStoreContractTests` from `@stint/core/testing` and re-run the identical suite against its own implementation.
- `@stint/core`'s public barrel now exports the complete Phase 2 surface: every Phase 4/5/6 consumer can import `reduce`, `evaluatePolicy`, `checkErrorThreshold`, `ConnectorBinding`/`BindingSet`, `HostAdapter`/`LifecycleEvent`, `activateLease`/`resumeLease`, `verifyBoundHash`, and `LeaseStore`/`LeaseMutator` types directly from `@stint/core`, with no further barrel changes needed for the symbols this phase built.
- This is the final plan in Phase 2 — the whole monorepo (`packages/spec`, `packages/core`, `packages/proxy`, `packages/cli`) builds, typechecks, lints, tests (193 tests / 24 files), and passes `codegen:check` cleanly.
- Existing `.planning/WINDOWS.md` open item (`over_actions_per_hour` unenforced, from 02-03) remains open and unaffected by this plan; PRXY-04 (Phase 4) resolves it.
- No blockers identified for Phase 3 (receipts/licensing) or Phase 4 (proxy).

---
*Phase: 02-lease-state-machine-policy-engine*
*Completed: 2026-09-27*

## Self-Check: PASSED

All created/modified files found on disk (`lease-store.ts`, `testing.ts`, `lease-store-contract.test.ts`, `index.ts`, `package.json`, `tsdown.config.ts`, `public-api.test.ts`); all three task commits (`d59b3d1`, `ddd175e`, `5ff0ae7`) found in `git log --oneline --all`.
