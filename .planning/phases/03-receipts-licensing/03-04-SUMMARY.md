---
phase: 03-receipts-licensing
plan: 04
subsystem: receipts
tags: [receipt-store, contract-test-factory, in-memory-double, public-barrel, rcpt-02, rcpt-03]

# Dependency graph
requires:
  - phase: 03-receipts-licensing
    plan: 01
    provides: "ReceiptEntry/Checkpoint generated types, GENESIS_PREV_HASH, appendEntry/verifyChain, RECEIPT_VERIFY_REASONS vocabulary"
  - phase: 03-receipts-licensing
    plan: 02
    provides: "signCheckpoint/verifyCheckpoint (jose EdDSA)"
  - phase: 03-receipts-licensing
    plan: 03
    provides: "verifyAttestedEntry/verifyAttestedChain, mergeTimeline/TimelineEntry"
provides:
  - "packages/core/src/receipts/receipt-store.ts: the ReceiptStore interface (append/load/readCheckpoint/writeCheckpoint), related-but-distinct from LeaseStore, documenting the append-only guarantee as the normative contract Phase 6's JSON-file store implements against"
  - "packages/core/src/testing.ts: createInMemoryReceiptStore() + createReceiptStoreContractTests(makeStore) -- the shared suite both this in-memory double and the Phase 6 JSON-file store run"
  - "packages/core/src/index.ts: the receipts public barrel (appendEntry, verifyChain, GENESIS_PREV_HASH, canonicalizeEntry, signCheckpoint, verifyCheckpoint, verifyAttestedEntry, verifyAttestedChain, mergeTimeline, RECEIPT_VERIFY_REASONS/ReceiptVerifyReason, ReceiptStore, ReceiptEntry/Checkpoint + payload types) -- ./testing's test doubles stay unexported"
affects: [phase-04-proxy, phase-05-teardown, phase-06-json-stores]

# Actuals (#2632)
actuals:
  tokens: 5001
  tasks: 3
  commits: 3
  plan_head_before: fffbd844a0fe6153a841d079beddcba2d1c8b9a1

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "ReceiptStore's in-memory double stores each chain as its own Map entry (one Map<ReceiptChain, ReceiptEntry[]> plus one Map<ReceiptChain, Checkpoint>), lazily creating a chain's array on first read/append rather than pre-seeding both known chain names -- mirrors createInMemoryLeaseStore's closure-over-Map shape, scoped to append/load/checkpoint instead of full CRUD+transaction."
    - "createReceiptStoreContractTests builds its own fixture entries via appendEntry (chain.ts) rather than hand-constructing raw ReceiptEntry literals, so the contract suite exercises the same production entry-construction path Phase 4/5/6 callers will use."

key-files:
  created:
    - packages/core/src/receipts/receipt-store.ts
    - packages/core/test/receipts/receipt-store-contract.test.ts
  modified:
    - packages/core/src/testing.ts
    - packages/core/src/index.ts
    - packages/core/test/public-api.test.ts

key-decisions:
  - "ReceiptStore's method names (append/load/readCheckpoint/writeCheckpoint) and per-chain Map-of-arrays internal representation are Claude's Discretion (03-CONTEXT.md) -- chosen to mirror LeaseStore's async CRUD shape as closely as the smaller append/load/checkpoint surface allows."
  - "The receipts public barrel re-exports ReceiptEntry/ReceiptChain/Checkpoint and the four payload/entry variant types directly from @stint/spec (not re-declared in @stint/core), matching how the license barrel re-exports LicenseClaims etc. from their owning modules -- @stint/core never hand-writes a type @stint/spec already generates."
  - "Fixed a pre-existing eslint restrict-template-expressions violation in the new contract-test factory (numeric loop index interpolated into a template literal) by wrapping with String(i) -- a Rule 1 lint fix required for this plan's own verification gate (pnpm lint) to pass."

patterns-established:
  - "A ReceiptStore's contract-test factory builds its fixture chain incrementally via appendEntry so the persisted entries' prevHash linkage is genuinely valid (not a stand-in shape), letting the INTEGRITY test assert the loaded chain passes the real verifyChain rather than a hand-rolled hash."

requirements-completed: [RCPT-02, RCPT-03]

coverage:
  - id: D1
    description: "@stint/core exports a ReceiptStore interface (append entry, load chain, read checkpoint, write checkpoint) related-but-distinct from LeaseStore, in its own file"
    requirement: RCPT-02
    verification:
      - kind: unit
        ref: "packages/core/test/receipts/receipt-store-contract.test.ts (11 tests via createReceiptStoreContractTests + 5 direct round-trip tests)"
        status: pass
    human_judgment: false
  - id: D2
    description: "@stint/core/testing exports createInMemoryReceiptStore() and createReceiptStoreContractTests(makeStore), mirroring the Phase 2 LeaseStore double/contract pattern; Phase 6's JSON-file store will run the identical suite"
    requirement: RCPT-02
    verification:
      - kind: unit
        ref: "packages/core/test/receipts/receipt-store-contract.test.ts invokes createReceiptStoreContractTests(createInMemoryReceiptStore)"
        status: pass
    human_judgment: false
  - id: D3
    description: "The contract suite proves append-only integrity: appended entries load back in order, the persisted chain still passes verifyChain, and a written checkpoint reads back unchanged"
    requirement: RCPT-03
    verification:
      - kind: unit
        ref: "createReceiptStoreContractTests' EMPTY/APPEND ORDER/INTEGRITY/ISOLATION/CHECKPOINT/CHECKPOINT ISOLATION cases (6 assertions)"
        status: pass
    human_judgment: false
  - id: D4
    description: "The @stint/core public barrel exports the receipts surface (appendEntry, verifyChain, signCheckpoint, verifyCheckpoint, verifyAttestedChain, mergeTimeline, ReceiptStore + generated ReceiptEntry/Checkpoint types, the receipt reason codes); ./testing is never re-exported from the main entry"
    requirement: RCPT-02
    verification:
      - kind: unit
        ref: "packages/core/test/public-api.test.ts (3 new tests: presence check, non-leak check for createInMemoryReceiptStore/createReceiptStoreContractTests, type-only compile check)"
        status: pass
    human_judgment: false

duration: ~20min
completed: 2026-09-28
status: complete
---

# Phase 3 Plan 4: ReceiptStore Persistence Contract Summary

**A distinct `ReceiptStore` interface (append/load/checkpoint read-write), an in-memory double, and a reusable `createReceiptStoreContractTests` suite factory in `@stint/core/testing` mirroring the Phase 2 `LeaseStore` pattern exactly, plus the `@stint/core` public barrel now exporting the full receipts surface (chains, checkpoints, attested verification, display-only merge) without leaking any test double.**

## Performance

- **Duration:** ~20 min
- **Completed:** 2026-09-28
- **Tasks:** 3 (Task 1 `tdd="true"` tracer, Task 2 `tdd="true"`, Task 3 `type="auto"`)
- **Files touched:** 5 (2 created, 3 modified)

## Accomplishments

- Built `packages/core/src/receipts/receipt-store.ts`: the `ReceiptStore` interface (`append`, `load`, `readCheckpoint`, `writeCheckpoint`), documented as the normative append-only contract Phase 6's JSON-file store implements against, kept in its own file and never folded into `LeaseStore`.
- Extended `packages/core/src/testing.ts` with `createInMemoryReceiptStore()`: a closure-over-`Map` double (one map of chain -> entry array, one map of chain -> latest checkpoint), mirroring `createInMemoryLeaseStore`'s shape.
- Extended `packages/core/src/testing.ts` with `createReceiptStoreContractTests(makeStore)`: a reusable `describe`/`it` factory proving append order, `verifyChain` still `ok` on a loaded chain, verified/attested chain and checkpoint isolation, and checkpoint round-trip byte-equality — the identical suite Phase 6's JSON-file `ReceiptStore` will run.
- Wrote `packages/core/test/receipts/receipt-store-contract.test.ts`: 5 direct round-trip tests plus the invoked `createReceiptStoreContractTests(createInMemoryReceiptStore)` factory suite (6 tests), 11 total.
- Extended `packages/core/src/index.ts`'s public barrel with the full receipts surface: `appendEntry`, `verifyChain`, `GENESIS_PREV_HASH`, `canonicalizeEntry`, `signCheckpoint`, `verifyCheckpoint`, `verifyAttestedEntry`, `verifyAttestedChain`, `mergeTimeline`, `RECEIPT_VERIFY_REASONS`/`ReceiptVerifyReason`, `ReceiptStore`, and the generated `ReceiptEntry`/`ReceiptChain`/`Checkpoint`/payload-variant types re-exported from `@stint/spec` — `./testing`'s doubles stay unexported (D-14, T-03-11).
- Extended `packages/core/test/public-api.test.ts` with presence, non-leak, and type-compile assertions for the new receipts surface.
- Ran the full receipts-half verification gate: `pnpm build` and `pnpm typecheck` pass repo-wide; `packages/core` (194 tests), `packages/proxy`+`packages/cli` (4 tests) pass via scoped `--pool=threads` vitest; `packages/spec` passes 79/80 (the 1 failure is the pre-existing, out-of-scope `codegen.test.ts` regression already logged in `deferred-items.md` since 03-03); `pnpm run check:alp` and `codegen:check` both pass.

## Task Commits

1. **Task 1: Tracer - ReceiptStore interface + createInMemoryReceiptStore append/load round-trip** - `93a4f67` (feat)
2. **Task 2: createReceiptStoreContractTests factory with append-only integrity assertions** - `f7ae5d9` (feat)
3. **Task 3: Wire the @stint/core receipts public barrel and prove the surface** - `a03911f` (feat)

**Plan metadata:** pending (this commit)

## Files Created/Modified

- `packages/core/src/receipts/receipt-store.ts` (new) — `ReceiptStore` interface
- `packages/core/test/receipts/receipt-store-contract.test.ts` (new) — 11 tests
- `packages/core/src/testing.ts` (modified) — `createInMemoryReceiptStore`, `createReceiptStoreContractTests`
- `packages/core/src/index.ts` (modified) — receipts public barrel exports
- `packages/core/test/public-api.test.ts` (modified) — 3 new tests extending the existing HOST-01 suite

## Decisions Made

See `key-decisions` in the frontmatter: `ReceiptStore`'s exact method names/internal representation (Claude's Discretion per 03-CONTEXT.md), re-exporting the generated receipt/checkpoint types directly from `@stint/spec` rather than re-declaring them in `@stint/core`, and the Rule 1 lint fix in the contract-test factory.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Lint] Fixed `restrict-template-expressions` errors in the contract-test factory**
- **Found during:** Task 3's verification gate (`pnpm lint` scoped per-file, per this project's OOM-avoidance convention)
- **Issue:** `createReceiptStoreContractTests`'s `APPEND ORDER`/`INTEGRITY` test cases (added in Task 2) interpolated a numeric loop index directly into a template literal (`` `state-${i}` ``), which this project's eslint config's `@typescript-eslint/restrict-template-expressions` rule rejects for `number` types by default.
- **Fix:** Wrapped both interpolations with `String(i)`/`String(i + 1)`. No behavior change — the fixture values were already numeric-suffixed strings.
- **Files modified:** `packages/core/src/testing.ts`
- **Verification:** `eslint` re-run clean on all 5 touched files; `pnpm build`, `pnpm typecheck`, and the scoped `vitest run` suites (194 core tests, 79/80 spec tests, 4 proxy/cli tests) all still pass after the fix.
- **Committed in:** `a03911f` (Task 3 commit, since the affected file — `testing.ts` — was already committed in Task 2 and the fix surfaced only while running Task 3's own verification gate)

None of the above required an architectural change (Rule 4) or introduced scope creep — both fixes were necessary for this plan's own stated verification gate to pass.

## Issues Encountered

- **Pre-existing, out-of-scope test failure (not introduced by this plan):** `packages/spec/test/codegen.test.ts`'s "codegen check detects stale types" test fails with `ENOENT`. This is the Phase 1/03-01 regression already documented in `.planning/phases/03-receipts-licensing/deferred-items.md` (confirmed unrelated: neither `codegen.mjs` nor `codegen.test.ts` was touched by this plan). Not fixed here per the Scope Boundary rule.
- **Sandbox memory constraints (environment, not code):** identical to every prior Phase 3 plan — repo-wide `vitest run`/`eslint .` are known to OOM in this sandbox. Worked around by scoping `vitest run` to `packages/core` (194 tests), `packages/spec` (79/80, the 1 pre-existing failure above), and `packages/proxy`+`packages/cli` (4 tests) separately with `--pool=threads`, and running `eslint` per-file on every file this plan touched (clean after the Rule 1 fix). `pnpm build`, `pnpm typecheck`, `pnpm run check:alp`, and `codegen:check` were run repo-wide without issue.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- `ReceiptStore`, `createInMemoryReceiptStore`, and `createReceiptStoreContractTests` are ready for Phase 4's proxy (per-call receipt persistence, RCPT-01) and Phase 5's teardown (final signed receipt, RCPT-07) to build against; Phase 6's JSON-file `ReceiptStore` runs the identical contract suite so it cannot silently diverge from the in-memory guarantees.
- The `@stint/core` public barrel now exports the complete receipts surface Phase 4/5 need (`appendEntry`, `verifyChain`, `signCheckpoint`, `verifyAttestedChain`, `mergeTimeline`, `ReceiptStore`) alongside the licensing surface 03-06 already wired.
- This is the final plan of Phase 3 (Receipts & Licensing). Both receipts (RCPT-02..06) and licensing (LIC-01..03) requirement sets are now fully green end-to-end in `@stint/core`; LIC-04 (revocation), LIC-05's adversarial runtime test, RCPT-01/RCPT-07 (live proxy/teardown emission) remain explicitly out of Phase 3's scope per `03-CONTEXT.md`, deferred to Phase 4/5.
- `.planning/phases/03-receipts-licensing/deferred-items.md`'s `codegen.test.ts` regression remains open for whichever future plan/phase next touches `packages/spec/scripts/codegen.mjs` or its test suite.
- No blockers identified for Phase 4.

## Self-Check: PASSED

All key files confirmed present on disk (`receipt-store.ts`, `receipt-store-contract.test.ts`, plus the modified `testing.ts`, `index.ts`, `public-api.test.ts`) and all three task commits (`93a4f67`, `f7ae5d9`, `a03911f`) confirmed present in `git log --oneline --all`. `git diff --diff-filter=D` across all three commits returned no deleted files.

---
*Phase: 03-receipts-licensing*
*Completed: 2026-09-28*
