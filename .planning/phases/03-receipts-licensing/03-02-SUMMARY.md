---
phase: 03-receipts-licensing
plan: 02
subsystem: receipts
tags: [ed25519, jose, eddsa, hash-chain, checkpoint, tamper-detection]

# Dependency graph
requires:
  - phase: 03-receipts-licensing
    plan: 01
    provides: "ReceiptEntry/Checkpoint generated types, GENESIS_PREV_HASH, appendEntry/verifyChain skeleton, RECEIPT_VERIFY_REASONS vocabulary"
provides:
  - "packages/core/src/receipts/checkpoint.ts: signCheckpoint/verifyCheckpoint (jose EdDSA, injectable keypair, never forwards jose's exception text)"
  - "packages/core/src/receipts/chain.ts: verifyChain extended with checkpoint anchoring (truncated, checkpoint_sig_invalid) and reorder/mutation break-locus distinction (reordered vs hash_mismatch)"
  - "spec/vectors/receipts/checkpoint-*: fixed test Ed25519 keypair, checkpoint summary input, canonical signing bytes, and pinned deterministic signature"
affects: [03-03, 03-04, 03-05, 03-06, phase-04-proxy, phase-05-teardown, phase-06-json-stores]

# Actuals (#2632)
actuals:
  tokens: 8236
  tasks: 3
  commits: 3

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "verifyChain is async (checkpoint-signature verification is inherently async via jose's Web Crypto EdDSA); the no-checkpoint call path performs no awaited work but keeps the same Promise-returning signature so callers never need two call shapes"
    - "Reorder-vs-mutation disambiguation: precompute every entry's canonical hash once per verifyChain call, then a broken prevHash link is 'reordered' if it matches some OTHER entry present in the chain (or the entry's own seq no longer matches its array position), and 'hash_mismatch' only when it matches nothing in the chain"

key-files:
  created:
    - packages/core/src/receipts/checkpoint.ts
    - packages/core/test/receipts/checkpoint.test.ts
    - packages/core/test/receipts/verify-chain.test.ts
    - spec/vectors/receipts/checkpoint-input.json
    - spec/vectors/receipts/checkpoint-signing-input.txt
    - spec/vectors/receipts/checkpoint-key.jwk.json
    - spec/vectors/receipts/checkpoint-expected-sig.txt
  modified:
    - packages/core/src/receipts/chain.ts
    - packages/core/test/receipts/chain-golden.test.ts
    - spec/vectors/README.md

key-decisions:
  - "checkpoint.ts mirrors packages/spec/src/jws.ts exactly: one shared CHECKPOINT_HEADER = { alg: 'EdDSA' } as const at module scope, FlattenedSign/flattenedVerify, try/catch-to-boolean verify that never forwards jose's exception text."
  - "verifyChain's two new optional parameters (checkpoint, checkpointPublicKey) are independent optionals, not a bundled object, matching the plan's literal wording; a checkpoint supplied without a matching public key fails closed as checkpoint_sig_invalid (deny-by-default, per PROJECT.md)."
  - "checkpoint-expected-sig.txt was added as a vector file beyond the plan's literal files_modified list (Rule 2: the plan's own acceptance criterion 'signature matches the pinned vector' cannot be satisfied without a file to pin it in; mirrors the existing chain-expected-hash.txt convention exactly)."
  - "The reorder/mutation test's payload-mutation case mutates the MIDDLE entry (seq 1), not the entry it reports the break at (seq 2) — this is not a plan-text mismatch but the correct consequence of the recompute-on-verify design (D-04): no per-entry hash is ever stored, so a payload mutation is only observable at the NEXT entry, whose prevHash was computed from the now-stale content. Documented inline in the test."

patterns-established:
  - "A checkpoint anchor's own signature is checked BEFORE the chain walk begins (fail fast on an untrusted anchor); the chain walk itself is unchanged whether or not a checkpoint is present, and only the post-walk length comparison differs (truncated check)."

requirements-completed: [RCPT-03, RCPT-06]

coverage:
  - id: D1
    description: "signCheckpoint/verifyCheckpoint sign and verify Ed25519 checkpoints with an injected keypair, mirroring jws.ts's detached-EdDSA shape; every failure mode collapses to a fixed outcome; the signature over the fixed vector input is reproducible with the committed test keypair"
    requirement: RCPT-03
    verification:
      - kind: unit
        ref: "packages/core/test/receipts/checkpoint.test.ts (6 tests)"
        status: pass
    human_judgment: false
  - id: D2
    description: "verifyChain, given a signed checkpoint anchor, detects truncation (reason 'truncated') and an invalid checkpoint signature (reason 'checkpoint_sig_invalid'), each with the exact brokenAtSeq"
    requirement: RCPT-06
    verification:
      - kind: unit
        ref: "packages/core/test/receipts/verify-chain.test.ts (checkpoint-anchoring describe block, 5 tests)"
        status: pass
    human_judgment: false
  - id: D3
    description: "verifyChain reports 'reordered' with the exact brokenAtSeq for a transposed chain, and 'hash_mismatch' with the exact brokenAtSeq for a payload mutation - all four break reasons now report the exact break point"
    requirement: RCPT-06
    verification:
      - kind: unit
        ref: "packages/core/test/receipts/verify-chain.test.ts (reorder-vs-mutation describe block, 2 tests) + chain-golden.test.ts (8 tests, regression-checked)"
        status: pass
    human_judgment: false

duration: ~35min
completed: 2026-09-28
status: complete
---

# Phase 3 Plan 2: Ed25519 Checkpoints and Exact Break-Locus Reporting Summary

**Ed25519-signed checkpoints via `jose` (mirroring `jws.ts` exactly) plus `verifyChain` extended to anchor against a signed checkpoint and to report all four exact break reasons — `hash_mismatch`, `reordered`, `truncated`, `checkpoint_sig_invalid` — each with a precise `brokenAtSeq`.**

## Performance

- **Duration:** ~35 min
- **Completed:** 2026-09-28
- **Tasks:** 3 (all `type="auto" tdd="true"`, no checkpoints)
- **Files modified:** 10 (7 created, 3 modified)

## Accomplishments

- Built `packages/core/src/receipts/checkpoint.ts`: `signCheckpoint`/`verifyCheckpoint` over `{ chain, count, headHash, ts }`, canonicalized via `@stint/spec`'s `canonicalize` (the same serializer `chain.ts` uses), signed/verified with `jose`'s `FlattenedSign`/`flattenedVerify` and a single shared `CHECKPOINT_HEADER` constant — an exact structural mirror of `packages/spec/src/jws.ts`.
- Authored `spec/vectors/receipts/checkpoint-input.json` / `checkpoint-signing-input.txt` / `checkpoint-key.jwk.json` / `checkpoint-expected-sig.txt`: a fixed test Ed25519 keypair, the checkpoint summary anchoring the 03-01 golden chain, its canonical signing bytes, and the pinned deterministic EdDSA signature (verified reproducible by signing twice in a scratch script before committing).
- Wrote `packages/core/test/receipts/checkpoint.test.ts` (6 tests): sign/verify round trip, wrong-key false, mutated-headHash false, malformed-signature false, and the pinned-vector reproduction.
- Extended `verifyChain` in `packages/core/src/receipts/chain.ts` to accept an optional `Checkpoint` and its public key: verifies the checkpoint's own signature first (`checkpoint_sig_invalid`, including when no public key is supplied), then reports `truncated` when the chain is shorter than the checkpoint's `count`. `verifyChain` is now `async` (checkpoint verification is inherently async); `chain-golden.test.ts` (03-01) was updated to `await` it and still passes unchanged in behavior.
- Extended `verifyChain` further to distinguish `reordered` (an entry's `seq` no longer matches its position, or its `prevHash` matches some OTHER entry present in the chain) from `hash_mismatch` (a broken link matching nothing in the chain) — implemented by precomputing every entry's canonical hash once per call.
- Wrote `packages/core/test/receipts/verify-chain.test.ts` (7 tests): checkpoint-anchoring ok/truncated/checkpoint_sig_invalid (including missing-key) cases, plus a transposition case (`reordered`) and a payload-mutation case (`hash_mismatch`), each asserting the exact `brokenAtSeq`.
- Updated `spec/vectors/README.md`'s `receipts/` section to document the four new checkpoint vector files.

## Task Commits

1. **Task 1: Tracer - signCheckpoint/verifyCheckpoint over the golden chain** - `5a9fb48` (feat)
2. **Task 2: Extend verifyChain with checkpoint anchoring - truncated and checkpoint_sig_invalid** - `76ae37f` (feat)
3. **Task 3: verifyChain reorder and mutation break-locus** - `be83007` (feat)

**Plan metadata:** pending (this commit)

## Files Created/Modified

- `packages/core/src/receipts/checkpoint.ts` - signCheckpoint/verifyCheckpoint, CHECKPOINT_HEADER
- `packages/core/src/receipts/chain.ts` - verifyChain extended: checkpoint anchoring + reorder/mutation distinction; now async
- `packages/core/test/receipts/checkpoint.test.ts` - 6 tests
- `packages/core/test/receipts/verify-chain.test.ts` - 7 tests
- `packages/core/test/receipts/chain-golden.test.ts` - updated to await the now-async verifyChain (03-01 regression check, still 8 tests passing)
- `spec/vectors/receipts/checkpoint-input.json`, `checkpoint-signing-input.txt`, `checkpoint-key.jwk.json`, `checkpoint-expected-sig.txt` - checkpoint conformance vector
- `spec/vectors/README.md` - documents the new `receipts/checkpoint-*` vector files

## Decisions Made

- Mirrored `packages/spec/src/jws.ts`'s detached-EdDSA shape in `checkpoint.ts` exactly, per the plan's `read_first` guidance and D-07 — no new sign/verify pattern invented.
- Kept `verifyChain`'s two new parameters (`checkpoint`, `checkpointPublicKey`) as independent optionals rather than a bundled object, matching the plan's literal wording; a checkpoint present without a matching public key fails closed as `checkpoint_sig_invalid` rather than silently skipping anchoring, consistent with PROJECT.md's deny-by-default constraint.
- Split the originally-combined Task 2 + Task 3 implementation into two separate commits by temporarily reverting the reorder-distinguishing logic for the Task 2 commit, then reapplying it for Task 3, so each task's commit accurately reflects only that task's scope (per the atomic-per-task commit requirement).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical functionality] Added `checkpoint-expected-sig.txt` vector file (not in the plan's literal `files_modified` list)**
- **Found during:** Task 1
- **Issue:** The plan requires `checkpoint.test.ts` to assert "the signature matches the pinned vector," but the plan's three named vector files (`checkpoint-input.json`, `checkpoint-signing-input.txt`, `checkpoint-key.jwk.json`) hold only the summary, its canonical bytes, and the keypair — none of them can hold the expected signature output without conflating "input" with "expected output."
- **Fix:** Added a fourth vector file, `checkpoint-expected-sig.txt`, mirroring the existing `chain-expected-hash.txt` convention exactly (a single pinned value, no trailing newline). The signature was computed via a scratch script using the committed test keypair and verified to be reproducible (signed twice, byte-identical) before being committed, consistent with Ed25519's deterministic-signature guarantee (RFC 8032).
- **Files modified:** spec/vectors/receipts/checkpoint-expected-sig.txt (new), spec/vectors/README.md (documents it)
- **Verification:** `checkpoint.test.ts`'s "golden vector" test asserts `checkpoint.sig` equals this file's trimmed content; passes.
- **Committed in:** 5a9fb48 (Task 1 commit)

**2. [Rule 3 - Blocking] Updated `chain-golden.test.ts` (03-01) to await the now-async `verifyChain`**
- **Found during:** Task 2
- **Issue:** `verifyCheckpoint` (Task 1) is inherently async (jose's Web Crypto-backed EdDSA operations return Promises). Once Task 2 required `verifyChain` to optionally call `verifyCheckpoint`, `verifyChain` itself had to become `async` — a synchronous function cannot conditionally await based on an argument. This broke `chain-golden.test.ts`'s four existing synchronous `verifyChain(...)` call sites (03-01's own test file), which would otherwise assert against an unresolved `Promise` object instead of a `Result`.
- **Fix:** Updated all four call sites in `chain-golden.test.ts` to `await verifyChain(...)` and made their enclosing `it` callbacks `async`. No assertions or fixture data changed — the golden-hash/tamper-detection behavior is identical, only the calling convention changed.
- **Files modified:** packages/core/test/receipts/chain-golden.test.ts
- **Verification:** `pnpm exec vitest run packages/core/test/receipts/chain-golden.test.ts` - 8/8 tests pass, unchanged from 03-01's original assertions.
- **Committed in:** 76ae37f (Task 2 commit)

**3. [Rule 1 - Style] Prettier line-wrap reformatting carried onto Task 1's already-committed files**
- **Found during:** Task 2 (running the repo-wide `prettier --write` pass before committing Task 2's new files)
- **Issue:** `checkpoint.ts` and `checkpoint.test.ts` (committed in Task 1) had several lines exceeding the project's configured line width; the formatting pass run before Task 2's commit reformatted them alongside Task 2's own files.
- **Fix:** Accepted `prettier --write`'s reformatting (line-wrapping only, no logic change); re-ran typecheck/lint/tests to confirm no behavior changed.
- **Files modified:** packages/core/src/receipts/checkpoint.ts, packages/core/test/receipts/checkpoint.test.ts
- **Verification:** `pnpm typecheck` and the full checkpoint/verify-chain/chain-golden test suite (21 tests) pass unchanged.
- **Committed in:** 76ae37f (Task 2 commit, alongside Task 2's own changes, documented there)

---

**Total deviations:** 3 auto-fixed (1 missing-functionality, 1 blocking, 1 style)
**Impact on plan:** All three were necessary for correctness or for the plan's own acceptance criteria to be checkable at all. No scope creep — every change stayed within `packages/core/src/receipts/`, its tests, and the `spec/vectors/receipts/` fixture directory this plan already owns.

## Issues Encountered

**Sandbox memory constraints (environment, not code):** Running the whole-repo `vitest run` (all packages, default forks pool) and the whole-repo `eslint .` both hit `FATAL ERROR: ... out of memory` / Rust allocator crashes in this sandboxed Windows environment, unrelated to this plan's code. Worked around by (a) scoping `vitest run --pool=threads` to the specific test files being verified (matching the plan's own `<verify>` commands, which already scope to specific files) and (b) invoking `eslint` directly via `node --max-old-space-size=2048 node_modules/eslint/bin/eslint.js <specific files>` instead of the repo-wide `pnpm lint` script. All targeted runs (typecheck, lint, and the plan's exact test-file targets) passed cleanly; the full `@stint/core` suite (130 tests) was also run and confirmed passing with `--pool=threads`.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `checkpoint.ts` (`signCheckpoint`/`verifyCheckpoint`) and the extended `verifyChain` (checkpoint anchoring + all four break reasons) are ready for 03-03's `ReceiptStore` and `mergeTimeline` work, and for Phase 4's proxy / Phase 5's teardown to call `signCheckpoint` at lease-ending events (D-06).
- No blockers identified for the remaining Phase 3 plans.

## Self-Check: PASSED

All key files confirmed present on disk (checkpoint.ts, chain.ts, checkpoint.test.ts, verify-chain.test.ts, chain-golden.test.ts, all four checkpoint-* vector files, spec/vectors/README.md) and all three task commits (`5a9fb48`, `76ae37f`, `be83007`) confirmed present in `git log --oneline --all` (verified via direct `[ -f ... ]` file checks and `git log --oneline --all | grep` for each hash).

---
*Phase: 03-receipts-licensing*
*Completed: 2026-09-28*
