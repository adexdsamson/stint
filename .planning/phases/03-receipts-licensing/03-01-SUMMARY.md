---
phase: 03-receipts-licensing
plan: 01
subsystem: receipts
tags: [json-schema, draft-07, hash-chain, canonicalization, jcs, codegen, alp-spec]

# Dependency graph
requires:
  - phase: 01-foundation-alp-spec
    provides: "@stint/spec's canonicalize/hashCanonical (RFC 8785 JCS) and the schema-to-generated-types codegen pipeline"
  - phase: 02-lease-state-machine-policy-engine
    provides: "TransitionRecord shape (from/event/actor/to) mirrored by the transition receipt payload; Result-not-throw + stable-code convention"
provides:
  - "spec/receipt.schema.json and spec/checkpoint.schema.json: the normative draft-07 wire format for receipt entries and checkpoints"
  - "Generated TypeScript types (ReceiptEntry discriminated union, Checkpoint) exported from @stint/spec"
  - "packages/core/src/receipts/chain.ts: appendEntry/verifyChain, pure, single-serializer hash-chaining with GENESIS_PREV_HASH"
  - "packages/core/src/receipts/errors.ts: RECEIPT_VERIFY_REASONS/ReceiptVerifyReason vocabulary, independent of SpecErrorCode/CoreErrorCode"
  - "spec/vectors/receipts/ golden vector: fixed 3-entry chain, canonical bytes, independently-verified head hash"
  - "spec/ALP.md section 11 resolved normatively (receipt/checkpoint entry format)"
affects: [03-02, 03-03, 03-04, 03-05, 03-06, phase-04-proxy, phase-05-teardown, phase-06-json-stores]

# Actuals (#2632)
actuals:
  tokens: 9971
  tasks: 3
  commits: 2

# Tech tracking
tech-stack:
  added: ["jose@6.2.12 (direct @stint/core dependency, used starting plan 03-02)"]
  patterns:
    - "Root-level oneOf discriminated union in JSON Schema (per-variant Entry definitions, each with a type const) instead of allOf/if-then, so json-schema-to-typescript emits a clean TS union without the allOf-strip codegen path"
    - "Recompute-on-verify hash chain: prevHash is the only stored link; the entry's own hash is never persisted"
    - "Receipt-local Result<T>/error vocabulary mirrors @stint/core's Result<T> shape without importing CoreError/CoreErrorCode (parallel, independent vocabularies)"

key-files:
  created:
    - spec/receipt.schema.json
    - spec/checkpoint.schema.json
    - packages/spec/src/generated/receipt.ts
    - packages/spec/src/generated/checkpoint.ts
    - packages/core/src/receipts/chain.ts
    - packages/core/src/receipts/errors.ts
    - spec/vectors/receipts/chain-input.json
    - spec/vectors/receipts/chain-canonical.txt
    - spec/vectors/receipts/chain-expected-hash.txt
    - packages/core/test/receipts/chain-golden.test.ts
  modified:
    - packages/spec/scripts/codegen.mjs
    - packages/spec/src/generated/schemas.ts
    - packages/spec/src/index.ts
    - packages/core/package.json
    - spec/ALP.md
    - spec/vectors/README.md

key-decisions:
  - "Task 1 checkpoint (human-confirmed): ReceiptEntry = { seq, ts, chain, type, prevHash, payload }; prevHash linkage is Option A (entry N.prevHash = hashCanonical(entry N-1), genesis links to a fixed constant); GENESIS_PREV_HASH = \"jcs-sha256:\" + \"0\".repeat(64); Checkpoint = { chain, count, headHash, ts, sig }."
  - "Chose a root-level oneOf of four fully-specified Entry definitions (CallEntry/TransitionEntry/TeardownStepEntry/AttestedClaimEntry) over an allOf+if/then design, so json-schema-to-typescript generates a clean `ReceiptEntry = CallEntry | TransitionEntry | TeardownStepEntry | AttestedClaimEntry` union with no allOf-strip needed."
  - "Golden vector is a 3-entry fixed chain (transition, call, teardown_step) on the verified chain, covering genesis link + intermediate link + final link; attested_claim payload shape is schema-defined but not exercised by this vector."

patterns-established:
  - "Receipt schemas close over additionalProperties: false with no x- passthrough (unlike manifest.schema.json) — receipts are runtime-internal audit records, not publisher-extensible documents."
  - "chain.ts's ReceiptEntryInput is a hand-written discriminated union (not derived via Omit<ReceiptEntry, ...>) to preserve type<->payload correlation that TypeScript's Omit over a union type would otherwise lose."

requirements-completed: [RCPT-02]

coverage:
  - id: D1
    description: "Draft-07 receipt.schema.json/checkpoint.schema.json exist and generate TypeScript types via codegen:check; @stint/core imports the generated types, never hand-writes them"
    requirement: RCPT-02
    verification:
      - kind: unit
        ref: "pnpm --filter @stint/spec run codegen:check"
        status: pass
    human_judgment: false
  - id: D2
    description: "appendEntry/verifyChain hash-chain receipts exclusively through @stint/spec's canonicalize/hashCanonical; a golden-hash fixture pins exact canonical bytes and head hash, verified independently via sha256sum; verifyChain reports the exact hash_mismatch break point"
    requirement: RCPT-02
    verification:
      - kind: unit
        ref: "packages/core/test/receipts/chain-golden.test.ts (8 tests)"
        status: pass
    human_judgment: false
  - id: D3
    description: "spec/ALP.md section 11 resolves its [OPEN: Phase 3] marker with the normative receipt/checkpoint entry format, linking (not pasting) the schemas; the stray duplicate marker in section 7.4 is also resolved"
    requirement: RCPT-02
    verification:
      - kind: other
        ref: "pnpm run check:alp"
        status: pass
    human_judgment: false

duration: ~25min
completed: 2026-09-28
status: complete
---

# Phase 3 Plan 1: Receipt Chain Tracer Summary

**Draft-07 receipt/checkpoint schemas with generated TypeScript types, a pure `appendEntry`/`verifyChain` hash chain over `@stint/spec`'s single canonical serializer, a golden-hash conformance vector verified independently via `sha256sum`, and `spec/ALP.md` section 11 resolved normatively.**

## Performance

- **Duration:** ~25 min
- **Started:** 2026-09-27T23:55:00+01:00 (approximate; Task 1's checkpoint:decision paused for human confirmation before this session's build work began)
- **Completed:** 2026-09-28T00:20:03+01:00
- **Tasks:** 3 (Task 1 checkpoint:decision, Task 2 tracer build, Task 3 spec resolution)
- **Files modified:** 17

## Accomplishments
- Confirmed (Task 1, human-verified checkpoint) the one-way receipt/checkpoint wire format: ReceiptEntry field set, prevHash linkage direction (Option A), the GENESIS_PREV_HASH constant, and the Checkpoint field set.
- Built `spec/receipt.schema.json` (root-level `oneOf` over four fully-specified per-type entry variants: `call`/`transition`/`teardown_step`/`attested_claim`) and `spec/checkpoint.schema.json`, extended `packages/spec/scripts/codegen.mjs`'s targets and `schemasContent` template, and regenerated `receipt.ts`/`checkpoint.ts`/`schemas.ts` — `codegen:check` passes.
- Implemented `packages/core/src/receipts/chain.ts` (`appendEntry`, `verifyChain`, `GENESIS_PREV_HASH`, `canonicalizeEntry`) hashing exclusively through `@stint/spec`'s `canonicalize`/`hashCanonical`, never `node:crypto` directly.
- Implemented `packages/core/src/receipts/errors.ts` (`RECEIPT_VERIFY_REASONS`, `ReceiptVerifyReason`, `ChainVerifyFailure`, a local `Result<T>`), kept independent of both `SpecErrorCode` and `CoreErrorCode`.
- Authored the `spec/vectors/receipts/` golden vector (3-entry fixed chain), with the head hash independently verified via `sha256sum` over the committed canonical-bytes file, matching the `jcs/` vector convention exactly.
- Wrote `packages/core/test/receipts/chain-golden.test.ts` (8 tests, all passing): golden byte/hash reproduction, empty-chain and genesis-link edges, exact tamper break-point reporting, and `appendEntry` replay parity against the fixture.
- Resolved `spec/ALP.md` section 11's `[OPEN: Phase 3]` marker with the normative entry/checkpoint format, linking to (never pasting) the two schema files; `check:alp` passes.

## Task Commits

1. **Task 1: Confirm the one-way published wire formats** - no commit (decision-only checkpoint; confirmed via orchestrator, see Key Decisions)
2. **Task 2: Tracer - schemas, codegen, deps, chain.ts append/verify, golden vector end-to-end** - `b1c8f37` (feat)
3. **Task 3: Resolve spec/ALP.md section 11 receipt and checkpoint entry format** - `563f1cb` (docs)

**Plan metadata:** pending (this commit)

## Files Created/Modified
- `spec/receipt.schema.json` - draft-07 ReceiptEntry schema, oneOf over 4 typed entry variants
- `spec/checkpoint.schema.json` - draft-07 Checkpoint schema
- `packages/spec/scripts/codegen.mjs` - added receipt/checkpoint codegen targets + schemasContent exports
- `packages/spec/src/generated/receipt.ts`, `checkpoint.ts`, `schemas.ts` - regenerated
- `packages/spec/src/index.ts` - re-exports the new generated types (deviation, see below)
- `packages/core/package.json` - added `jose@6.2.12` direct dependency
- `packages/core/src/receipts/chain.ts` - appendEntry/verifyChain, pure, single-serializer
- `packages/core/src/receipts/errors.ts` - RECEIPT_VERIFY_REASONS vocabulary
- `packages/core/test/receipts/chain-golden.test.ts` - 8 tests
- `spec/vectors/receipts/chain-input.json`, `chain-canonical.txt`, `chain-expected-hash.txt` - golden vector
- `spec/ALP.md` - section 11 normative resolution + section 7.4 stray-marker fix
- `spec/vectors/README.md` - new `receipts/` subsection

## Decisions Made
- Task 1 checkpoint confirmed the wire format verbatim as proposed (see frontmatter `key-decisions`); no amendments were requested.
- Chose a root-level `oneOf` discriminated union (four complete `*Entry` schema definitions) over an `allOf`+`if/then` design for `receipt.schema.json`, since it produces a clean generated TypeScript union (`ReceiptEntry = CallEntry | TransitionEntry | TeardownStepEntry | AttestedClaimEntry`) with no reliance on codegen's allOf-strip path.
- Golden vector uses a 3-entry chain (transition, call, teardown_step) rather than exercising all four payload types, to keep the fixture minimal while still covering the genesis link, an intermediate link, and the final head-hash link.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Re-exported generated receipt/checkpoint types from `packages/spec/src/index.ts`**
- **Found during:** Task 2
- **Issue:** The plan's `files_modified` list did not include `packages/spec/src/index.ts`, but `@stint/spec`'s `package.json` `exports` map only exposes `"."` and `"./testing"` — a deep subpath import like `@stint/spec/generated/receipt.js` from `packages/core` would fail at runtime with `ERR_PACKAGE_PATH_NOT_EXPORTED`. Without this export, `chain.ts` could not import `ReceiptEntry`/`CallPayload`/etc. at all.
- **Fix:** Added `export type { ReceiptEntry, ReceiptChain, CallEntry, CallPayload, TransitionEntry, TransitionPayload, TeardownStepEntry, TeardownStepPayload, AttestedClaimEntry, AttestedClaimPayload }` from `./generated/receipt.js` and `export type { Checkpoint }` from `./generated/checkpoint.js`, mirroring the exact precedent already set for `Manifest`/`SignedEnvelope`. The raw schema objects (`receiptSchema`/`checkpointSchema`) were deliberately NOT added to the index barrel, matching the existing precedent that `manifestSchema`/`envelopeSchema` are internal-only (consumed by `validate.ts`'s ajv compilation, never exported publicly).
- **Files modified:** packages/spec/src/index.ts
- **Verification:** `pnpm typecheck` and `pnpm build` both pass; `packages/core/src/receipts/chain.ts` compiles importing `ReceiptEntry`/`CallPayload`/etc. from `@stint/spec`.
- **Committed in:** b1c8f37 (Task 2 commit)

**2. [Rule 1 - Bug] Resolved a stray duplicate `[OPEN: Phase 3]` marker in section 7.4**
- **Found during:** Task 3
- **Issue:** Section 7.4 (Transition Table) contained its own `[OPEN: Phase 3]` marker ("the entry format for that receipt is `[OPEN: Phase 3]`") that named the exact same receipt entry format Task 3 just resolved normatively in section 11. Leaving it unresolved would have produced a self-contradictory spec document (a marker claiming "not yet defined" for a concept the same document now defines normatively two sections later).
- **Fix:** Replaced the sentence with a cross-reference to section 11 ("in the entry format Section 11 defines normatively"), removing the stale marker.
- **Files modified:** spec/ALP.md
- **Verification:** `pnpm run check:alp` passes; `grep -n "OPEN: Phase 3" spec/ALP.md` shows only section 8's intentionally-deferred marker (license claims, resolved by plan 03-05) remaining.
- **Committed in:** 563f1cb (Task 3 commit)

---

**Total deviations:** 2 auto-fixed (1 blocking, 1 bug)
**Impact on plan:** Both auto-fixes were necessary for correctness (Rule 3 fix was required for the code to compile at all; Rule 1 fix prevented a contradictory published spec document). No scope creep — neither deviation touched files outside this plan's direct concern.

## Issues Encountered
None beyond the two auto-fixed deviations above.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- The receipt/checkpoint wire format is now locked and normative; plan 03-02 (checkpoint signing via `jose`) and later plans (`ReceiptStore`, `mergeTimeline`, licensing) can build directly on `ReceiptEntry`/`Checkpoint`/`appendEntry`/`verifyChain` without further format churn.
- `spec/ALP.md` section 8's `[OPEN: Phase 3]` marker (license claims + implicit assertion) remains, intentionally, for plan 03-05.
- No blockers identified for the remaining Phase 3 plans.

## Self-Check: PASSED

All key files confirmed present on disk (chain.ts, errors.ts, receipt.schema.json, checkpoint.schema.json, chain-input.json, chain-expected-hash.txt, chain-golden.test.ts) and both task commits (`b1c8f37`, `563f1cb`) confirmed present in `git log --oneline --all`.

---
*Phase: 03-receipts-licensing*
*Completed: 2026-09-28*
