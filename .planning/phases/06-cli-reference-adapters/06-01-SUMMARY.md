---
phase: 06-cli-reference-adapters
plan: 01
subsystem: cli
tags: [proper-lockfile, write-file-atomic, lease-store, windows, commander, picocolors]

requires:
  - phase: 02-lease-core
    provides: LeaseStore contract + createLeaseStoreContractTests (@stint/core/testing)
provides:
  - "@stint/cli package spine with pinned deps and engines >=22.18.0"
  - "createJsonLeaseStore({ root }): dir-per-lease, Windows-safe, per-lease-locked, atomic LeaseStore passing the shared contract suite unmodified"
  - "atomic-file helpers: withTransientRetry, atomicWriteJson, readJsonRetry, withFileLock, createKeyedQueue, LeaseBusyError, StoreCorruptError"
  - "EXIT_CODES map (0-10) and CliError; resolveStoreRoot / assertSafeLeaseId / leaseDir / leaseFile / leasesRoot"
affects: [06-02, 06-03, 06-04, 06-05, 06-06, 06-07]

actuals:
  tokens: 8800
  tasks: 3
  commits: 2
plan_head_before: 1804e016739cf071153af607bc9d78fc58051818
commits: 2

tech-stack:
  added: [commander@15.0.0, write-file-atomic@^7.0.1, proper-lockfile@4.1.2, picocolors@1.1.1, "@modelcontextprotocol/sdk@1.30.1", jose@6.2.12, "@types/write-file-atomic@4.0.3", "@types/proper-lockfile@4.1.4"]
  patterns:
    - "per-key in-process queue -> proper-lockfile on lease.json -> atomic rename, every fs call wrapped in bounded EPERM/EBUSY/EACCES retry"
    - "lock-free load()/list() (dispatch calls load inside transaction)"
    - "lock acquisition loop owned in-code so the total budget is exact; exhaustion -> LeaseBusyError"

key-files:
  created:
    - packages/cli/src/store/atomic-file.ts
    - packages/cli/src/store/json-lease-store.ts
    - packages/cli/src/paths.ts
    - packages/cli/src/exit.ts
    - packages/cli/vitest.config.ts
    - packages/cli/test/paths.test.ts
    - packages/cli/test/atomic-file.test.ts
    - packages/cli/test/json-lease-store.test.ts
  modified:
    - packages/cli/package.json
    - packages/cli/src/index.ts
    - packages/cli/tsconfig.json
    - eslint.config.js
    - pnpm-lock.yaml
    - .claude/CLAUDE.md

key-decisions:
  - "D-10 checkpoint resolved by the user: dir-per-lease (leases/<id>/lease.json, receipts under leases/<id>/receipts/, lock scoped per lease.json, lock order lease-then-receipts)."
  - "Lock acquisition is a hand-rolled retry loop around proper-lockfile.lock with retries:0 so timeoutMs is an exact total budget (default 30s), not an approximation from a retries/backoff config."
  - "withFileLock hands the work an assertHeld() callback; transaction() calls it between mutate and write so a lost lock never yields a stale overwrite."
  - "Store loads are shape-validated (including state in STATES and id === directory name) and throw StoreCorruptError with a fixed message; file contents are never echoed."

patterns-established:
  - "Fixed, non-interpolated CliError messages carrying an exit code"
  - "Contract-suite reuse: the on-disk store is verified by the same factory as the in-memory double"

requirements-completed: [HOST-03]

coverage:
  - id: D1
    description: "createJsonLeaseStore passes createLeaseStoreContractTests unmodified, including 50 concurrent transaction() calls with no lost updates"
    requirement: HOST-03
    verification:
      - kind: unit
        ref: "packages/cli/test/json-lease-store.test.ts#LeaseStore contract"
        status: pass
    human_judgment: false
  - id: D2
    description: "Lock contention past the budget yields LeaseBusyError (exit 8) with the lease untouched"
    requirement: HOST-03
    verification:
      - kind: unit
        ref: "packages/cli/test/json-lease-store.test.ts#a contending transaction past the lock budget rejects with LeaseBusyError"
        status: pass
    human_judgment: false
  - id: D3
    description: "Transient-retry semantics (EPERM/EBUSY/EACCES retried to the bound, ENOSPC rethrown immediately)"
    verification:
      - kind: unit
        ref: "packages/cli/test/atomic-file.test.ts#withTransientRetry"
        status: pass
    human_judgment: false
  - id: D4
    description: "Path safety, exit-code map, store-root precedence, picocolors CLAUDE.md row"
    verification:
      - kind: unit
        ref: "packages/cli/test/paths.test.ts"
        status: pass
    human_judgment: false

duration: 30min
completed: 2026-09-30
status: complete
---

# Phase 6 Plan 01: @stint/cli spine and JSON LeaseStore Summary

**Windows-safe dir-per-lease JSON LeaseStore (per-id queue, proper-lockfile per lease.json, atomic rename, bounded transient retry) that passes the shared core contract suite unmodified.**

## Performance

- **Duration:** ~30 min
- **Tasks:** 3 (1 decision checkpoint, 1 auto, 1 tracer/TDD)
- **Files modified:** 14

## Accomplishments

- Task 1 (checkpoint:decision) resolved by the user as dir-per-lease.
- Scaffolded `@stint/cli`: pinned runtime and dev deps, engines `>=22.18.0`, `vitest.config.ts` (60s timeout), `EXIT_CODES` (0-10) and `CliError`, path-safety helpers, and the picocolors 1.1.1 row in `.claude/CLAUDE.md` (must be constructed via `createColors(explicit)` per Pitfall 6).
- Tracer: `createJsonLeaseStore` exercised end to end on a real temp-dir store through path resolution, per-id queue, lock, atomic write and retry. The 46 cli-package tests pass, stable across 3 consecutive runs; `tsc -b`, per-file eslint (strictTypeChecked) and prettier are clean; `@stint/cli` builds.

## Task Commits

1. **Task 2: scaffold @stint/cli** - `15f1470` (feat)
2. **Task 3 (tracer): atomic-file + createJsonLeaseStore** - `ff3fcef` (feat)

Task 1 was a decision checkpoint and produced no commit.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] eslint could not parse packages/cli/vitest.config.ts**
- **Found during:** Task 2 lint
- **Issue:** `allowDefaultProject` and the disableTypeChecked override only matched the root `vitest.config.ts`.
- **Fix:** added `packages/*/vitest.config.ts` to both lists in `eslint.config.js`.
- **Commit:** 15f1470

**2. [Rule 3 - Blocking] Barrel export moved from Task 2 to Task 3**
- **Found during:** Task 2
- **Issue:** the plan asks Task 2 to export `createJsonLeaseStore`, but that module is created in Task 3, so the Task 2 commit would not compile and would break `smoke.test.ts`.
- **Fix:** added the barrel export in the Task 3 commit (ff3fcef).

**3. [Rule 2 - Missing critical] `packages/cli/tsconfig.json` referenced no `../spec`**
- **Fix:** added the project reference, since the package now depends on `@stint/spec` (15f1470).

### Design notes (within plan intent)

- `withFileLock` uses `retries: 0` plus an in-code jittered retry loop so `timeoutMs` is an exact total budget. `withTransientRetry` takes an optional injectable `sleep` (third arg) so unit tests do not wait on real backoff.
- Extra tests beyond the plan: torn JSON, malformed shape, lock-free load inside transaction, LeaseBusyError under contention, unsafe-id rejection, and the persisted-shape check.
- The RED and GREEN steps of Task 3 share one commit (the plan specifies one commit per task). RED was confirmed by a failing run (module not found) before implementation.

## Known Limitations

- An approval wait holds the lease lock (T-06-04, accepted): a second-terminal `revoke` waits up to the 30s budget, then fails with `LeaseBusyError` (exit 8). `dispatch.ts` is unchanged.
- The cross-process Windows hammer is scheduled for Wave 2. This plan proves the in-process contract and the lock-contention path only.
- The `.claude/CLAUDE.md` working copy uses CRLF; the new row was added consistently.

## Known Stubs

None.

## Threat Flags

None. New surface (store path from `--store`/`STINT_HOME`/leaseId) is covered by T-06-01, and a lock or corrupt-file failure yields only fixed messages.

## Self-Check: PASSED

All created files exist; commits `15f1470` and `ff3fcef` are present in `git log`.
