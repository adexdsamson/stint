---
phase: 06-cli-reference-adapters
plan: 02
subsystem: cli
tags: [receipt-store, proper-lockfile, write-file-atomic, concurrency, windows, vitest]

requires:
  - phase: 06-cli-reference-adapters
    provides: atomic-file helpers (withFileLock, atomicWriteJson, readJsonRetry, createKeyedQueue), createJsonLeaseStore, path layout (06-01)
  - phase: 03-receipts-licensing
    provides: ReceiptStore contract + createReceiptStoreContractTests (@stint/core/testing)
provides:
  - "createJsonReceiptStore({ root, leaseId }): per-lease, append-only ReceiptStore passing the shared contract suite unmodified"
  - "HOST-03 concurrency hammer: in-process (50 tx + 4 readers) and cross-process (3 writers x 20 + 1 reader) proofs of no lost updates and no torn files"
affects: [06-03, 06-05, 06-07]

actuals:
  tokens: 4100
  tasks: 2
  commits: 2
plan_head_before: e5bc249635139e5377c1bb2b1ec488115ff1203c
commits: 2

tech-stack:
  added: []
  patterns:
    - "receipt file lock = per-file keyed queue -> proper-lockfile on the chain file -> read -> append -> atomic rename"
    - "cross-process test workers import the BUILT dist, coordinate shutdown via a sentinel file, and print one counters-only JSON line"

key-files:
  created:
    - packages/cli/src/store/json-receipt-store.ts
    - packages/cli/test/json-receipt-store.test.ts
    - packages/cli/test/json-store-concurrency.test.ts
    - packages/cli/test/fixtures/hammer-worker.mjs
  modified:
    - packages/cli/src/index.ts

key-decisions:
  - "Receipt files are locked per chain file (verified.json / attested.json / checkpoint-<chain>.json), so the two chains never contend and never share bytes."
  - "The store validates only container shape on load (array of objects / object) and throws StoreCorruptError with the fixed message; entry contents and hashes are left to verifyChain."
  - "Reader worker stops on a <root>/reader-stop sentinel file rather than a timer, so the test asserts final state only."

patterns-established:
  - "Contract-suite reuse for the receipt store, same as the lease store"
  - "Worker fixtures use the built dist and never print lease or receipt contents"

requirements-completed: [HOST-03]

coverage:
  - id: D1
    description: "createJsonReceiptStore passes createReceiptStoreContractTests unmodified (empty, append order, integrity via verifyChain, chain isolation, checkpoint round-trip and isolation)"
    requirement: HOST-03
    verification:
      - kind: unit
        ref: "packages/cli/test/json-receipt-store.test.ts#ReceiptStore contract"
        status: pass
    human_judgment: false
  - id: D2
    description: "Append-only under 20 concurrent appends, per-lease isolation, unsafe id rejected, torn or wrong-shape chain file is StoreCorruptError"
    requirement: HOST-03
    verification:
      - kind: unit
        ref: "packages/cli/test/json-receipt-store.test.ts#createJsonReceiptStore (JSON-store specifics)"
        status: pass
    human_judgment: false
  - id: D3
    description: "In-process hammer: 50 concurrent transaction() + 4 reader loops leave version 50, zero torn reads, and only lease.json in the lease dir"
    requirement: HOST-03
    verification:
      - kind: unit
        ref: "packages/cli/test/json-store-concurrency.test.ts#in-process"
        status: pass
    human_judgment: false
  - id: D4
    description: "Cross-process hammer: 3 writer processes x 20 + 1 reader process leave version 60, 0 parse errors, 0 non-transient errors"
    requirement: HOST-03
    verification:
      - kind: unit
        ref: "packages/cli/test/json-store-concurrency.test.ts#cross-process"
        status: pass
    human_judgment: false
  - id: D5
    description: "Windows CI (windows-latest x Node 22.18/24) runs the cross-process leg via the existing build-first `pnpm test`"
    requirement: HOST-03
    verification:
      - kind: manual
        ref: ".github/workflows/ci.yml (unchanged) - confirm green windows-latest run after push"
        status: not-run
    human_judgment: false

duration: 8min
completed: 2026-09-30
status: complete
---

# Phase 6 Plan 02: JSON ReceiptStore and HOST-03 concurrency hammer Summary

**Append-only per-lease JSON ReceiptStore that passes the shared core contract suite unmodified, plus a two-tier (in-process and cross-process) hammer proving no lost updates and no torn files.**

## Performance

- **Duration:** ~8 min
- **Tasks:** 2 (both auto)
- **Files:** 4 created, 1 modified

## Accomplishments

- `createJsonReceiptStore({ root, leaseId })` persists `verified.json`, `attested.json` and `checkpoint-<chain>.json` under `leases/<id>/receipts/`, reusing `withFileLock` and `atomicWriteJson` from 06-01 with no new locking logic. It contains no hash code. Exported from the `@stint/cli` barrel.
- The in-process hammer (50 concurrent `transaction()` plus 4 reader loops) ends at `version === 50` with no torn or backwards reads, and the lease dir holds only `lease.json` (no temp files, no lock dir).
- The cross-process hammer (3 writer processes x 20 plus 1 reader process, each importing the built `dist/index.js`) ends at `version === 60` with 0 parse errors and all exit codes 0. Stable across 3 consecutive runs.
- Whole `packages/cli` suite: 6 files, 58 tests pass under `--pool=threads`. Per-file eslint and prettier are clean.

## Task Commits

1. **Task 1: JSON ReceiptStore** - `a6bcd60` (feat)
2. **Task 2: concurrency hammer** - `aa800f8` (test)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `packages/cli/src/index.ts` barrel export for the receipt store**
- **Found during:** Task 1
- **Issue:** the plan's `files_modified` omits the barrel, but `createJsonReceiptStore` must be reachable from the package (06-05/06-07 consume it).
- **Fix:** exported `createJsonReceiptStore` and `JsonReceiptStoreOptions`.
- **Commit:** a6bcd60

### Design notes (within plan intent)

- Extra tests beyond the plan: 20 concurrent appends stay ordered and complete, two leases are isolated, unsafe lease id rejected at construction, torn or wrong-shaped chain file yields `StoreCorruptError` on load and append.
- The reader worker stops on a sentinel file, and the hammer test never asserts on timing. It also asserts the lease dir contains exactly `["lease.json"]` in both tiers.
- The cross-process test fails with an explicit message if `packages/cli/dist` is not built, rather than skipping, so the proof cannot silently vanish.

## Known Limitations

- The windows-latest CI run of the cross-process leg has not yet been observed. The local run is on Windows 11 (Node dev machine) and green, but the CI matrix result is confirmed only after a push.
- A per-chain file rewrite on `append` is O(n) in chain length. Acceptable for lease-scoped receipt logs; a segmented or JSONL layout is a possible later optimization.

## Known Stubs

None.

## Threat Flags

None. Receipt files are secretless by type, the worker prints counters only, and the lease id is validated before any path is built (T-06-01).

## Self-Check: PASSED

All created files exist; commits `a6bcd60` and `aa800f8` are present in `git log`.
