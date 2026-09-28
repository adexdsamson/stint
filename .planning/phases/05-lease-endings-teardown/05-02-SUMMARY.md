---
phase: 05-lease-endings-teardown
plan: 02
subsystem: spec
tags: [predicate-grammar, resource_query, manifest-validation, ajv, closed-ast, alp-spec]

# Dependency graph
requires:
  - phase: 01-spec-foundation
    provides: "@stint/spec's Result/SpecError vocabulary, validateManifest/collectSemanticErrors, generated Manifest/ResourceQueryVerifier types, spec/ALP.md structural checker"
provides:
  - "Closed-AST resource_query predicate parser + pure evaluator in @stint/spec (packages/spec/src/predicate/{ast,parse,evaluate}.ts), exported from the public barrel"
  - "Manifest-time invalid_predicate validation gate in collectSemanticErrors"
  - "spec/ALP.md Section 7.6 (and Section 4) normative predicate grammar, closing both predicate-grammar [OPEN: Phase 5] markers"
affects: [05-07-outcome-verification-proxy, teardown, verification]

# Actuals (#2632)
actuals:
  tokens: 7630
  tasks: 2
  commits: 2

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Hand-written recursive-descent parser (no eval/new Function) for a deliberately closed, minimal DSL, mirroring the Result-not-throw discipline of validate.ts/chain.ts"
    - "Semantic (post-schema) manifest validation rule for a field the JSON Schema can only bound as an unconstrained string (predicate: minLength 1, maxLength 1000)"

key-files:
  created:
    - packages/spec/src/predicate/ast.ts
    - packages/spec/src/predicate/parse.ts
    - packages/spec/src/predicate/evaluate.ts
    - packages/spec/test/predicate.test.ts
  modified:
    - packages/spec/src/errors.ts
    - packages/spec/src/index.ts
    - packages/spec/src/validate.ts
    - packages/spec/test/validate.test.ts
    - spec/ALP.md

key-decisions:
  - "Grammar surface confirmed at the Task 1 checkpoint (resumed this session): aggregates exactly count/sum/exists; single optional field OP literal filter, no AND/OR, no nesting; outer compare = != < <= > >= against a numeric literal; exists compared as a numeric truthiness count (exists(...) >= 1), never a boolean literal; invalid_predicate is the fixed SpecError code for any parse/grammar failure."
  - "sum's aggregate-field reference syntax (sum(rows.amount [where ...])) was Claude's Discretion within D-01's bound (not specified by the checkpoint, which only confirmed the count/exists example) -- chosen to keep the grammar closed, unambiguous, and BNF-describable without inventing a second clause type."
  - "invalid_predicate was added to SPEC_ERROR_CODES in Task 2's commit (not Task 3's, as the plan's action text literally proposed) -- Rule 3 blocking-issue fix, because parse.ts's own Result<PredicateAst> rejection needed the code to exist to type-check under tsc -b. Task 3's own errors.ts action is a documented no-op."
  - "validate.ts's collectSemanticErrors constructs its own fixed, non-interpolated invalid_predicate SpecError rather than forwarding parsePredicate's internal error message, per T-05-02-I (never echo raw predicate internals in an error)."

patterns-established:
  - "Closed-AST DSL pattern: hand-written tokenizer/recursive-descent parser producing a readonly discriminated-union AST, paired with a pure no-I/O evaluator -- reusable for any future manifest-authored expression language that must stay closed (grammar size = attack surface)."

requirements-completed: [LIFE-06]

coverage:
  - id: D1
    description: "resource_query predicate parses to a closed AST via the aggregate+compare grammar (count/sum/exists, optional single filter, = != < <= > >= compare); parses the spec's own conformance example verbatim and evaluates correctly against fixture rows"
    requirement: "LIFE-06"
    verification:
      - kind: unit
        ref: "packages/spec/test/predicate.test.ts#parsePredicate > parses the spec's own conformance example verbatim"
        status: pass
      - kind: unit
        ref: "packages/spec/test/predicate.test.ts#evaluatePredicate > evaluates true when a reconciled row is present (spec example)"
        status: pass
    human_judgment: false
  - id: D2
    description: "A manifest whose job.verifier.type is resource_query and whose predicate is unparseable or out-of-grammar is rejected by validateManifest with a structured invalid_predicate SpecError, before consent; user_confirm/none verifiers never trigger predicate parsing"
    requirement: "LIFE-06"
    verification:
      - kind: unit
        ref: "packages/spec/test/validate.test.ts#semantic: resource_query verifier with an out-of-grammar predicate is rejected with invalid_predicate"
        status: pass
      - kind: unit
        ref: "packages/spec/test/validate.test.ts#semantic: user_confirm verifier never triggers predicate parsing"
        status: pass
    human_judgment: false
  - id: D3
    description: "spec/ALP.md Section 7.6 (and Section 4) close the predicate-grammar OPEN Phase 5 marker with the full normative grammar matching the implemented parser; the CI structural checker passes and no predicate-grammar marker remains"
    requirement: "LIFE-06"
    verification:
      - kind: other
        ref: "pnpm run check:alp"
        status: pass
      - kind: other
        ref: "grep -c 'OPEN: Phase 5' spec/ALP.md == 1 (only the untouched Section 10 cleanup-token marker remains)"
        status: pass
    human_judgment: false

duration: ~15min (continuation session; excludes the original session's Task 1 checkpoint dialogue)
completed: 2026-09-28
status: complete
---

# Phase 5 Plan 2: Resource-Query Predicate Grammar Summary

**Closed-AST aggregate+compare predicate grammar (count/sum/exists) parsed and evaluated from one `@stint/spec` definition, gated at manifest validation with a new `invalid_predicate` SpecError, and normatively closed in spec/ALP.md Section 7.6/4.**

## Performance

- **Duration:** ~15 min (this continuation session; Task 1's checkpoint decision was reached in a prior session)
- **Completed:** 2026-09-28T22:38:36Z
- **Tasks:** 2 of 3 (Task 1 was a decision checkpoint resolved before this session started; Tasks 2-3 executed here)
- **Files modified:** 9 (4 created, 5 modified)

## Accomplishments

- Built a hand-written, closed recursive-descent parser (`packages/spec/src/predicate/parse.ts`) for the `resource_query` predicate grammar: `count`/`sum`/`exists` aggregates over `rows`, an optional single `field OP literal` filter, and an outer numeric compare (`= != < <= > >=`) -- no `AND`/`OR`, no nesting, never `eval`/`new Function`/any interpreter.
- Built a pure, no-I/O evaluator (`evaluate.ts`) that applies the optional filter, computes the aggregate, and applies the outer compare against normalized `{ field: value }` rows.
- Verified the parser accepts the spec's own conformance example verbatim (`count(rows where status = 'reconciled') >= 1`) and the evaluator returns the correct boolean against fixture rows containing/lacking a matching row, including `sum` and `exists` cases.
- Exported `PredicateAst`, `Aggregate`, `CompareOp`, `PredicateFilter`, `PredicateRow`, `parsePredicate`, `evaluatePredicate` from `@stint/spec`'s public barrel, so the Phase 5 proxy verifier (05-07) can import the same AST type and pure evaluator rather than re-parsing or re-defining the grammar (D-28).
- Extended `collectSemanticErrors` (`validate.ts`) with a third semantic check: a `resource_query` verifier's predicate is parsed at manifest-validation time; an out-of-grammar or unparseable predicate is rejected with `{ path: "/job/verifier/predicate", code: "invalid_predicate" }`, before consent, the same gate as an unknown scope (D-04). `user_confirm`/`none` verifiers never trigger predicate parsing.
- Closed both predicate-grammar `[OPEN: Phase 5]` markers in `spec/ALP.md` (Section 4's `job.verifier.resource_query` bullet and Section 7.6's `resource_query` outcome-verification bullet) with the full normative aggregate+compare BNF grammar, matching the implemented parser exactly. The Section 10 cleanup-token `[OPEN: Phase 5]` marker (closed by plan 05-06) was left untouched; exactly one `OPEN: Phase 5` marker remains in the document.

## Task Commits

Task 1 (checkpoint:decision) was resolved in the prior session with no commits; the resume prompt confirmed no commits existed for 05-02 before this session (`git log --oneline --all | grep -F "05-02"` returned nothing at start).

1. **Task 2: Closed-AST predicate parser + pure evaluator (D-01, D-28)** - `c13f76c` (feat)
2. **Task 3: Manifest-time predicate gate + close spec §7.6/§4 markers (D-04, D-26)** - `b5dae25` (feat)

**Plan metadata:** committed alongside this SUMMARY (see final commit below).

## Files Created/Modified

- `packages/spec/src/predicate/ast.ts` - `Aggregate`/`CompareOp`/`PredicateFilter`/`PredicateAst` closed types + the grammar's BNF documented in the module docstring
- `packages/spec/src/predicate/parse.ts` - `parsePredicate(source): Result<PredicateAst>`, hand-written tokenizer/recursive-descent, never throws
- `packages/spec/src/predicate/evaluate.ts` - `evaluatePredicate(ast, rows): boolean`, pure, no I/O
- `packages/spec/test/predicate.test.ts` - 18 tests: conformance example, sum/exists/count, filter matching, AND/OR rejection, malformed-input never-throws, type-mismatch never-matches
- `packages/spec/src/errors.ts` - added `invalid_predicate` to the additive `SPEC_ERROR_CODES` array
- `packages/spec/src/index.ts` - barrel exports for the new predicate module
- `packages/spec/src/validate.ts` - `collectSemanticErrors` gains the `resource_query` predicate-grammar gate
- `packages/spec/test/validate.test.ts` - 5 new tests: valid/out-of-grammar/unparseable predicates, user_confirm/none never triggering parsing
- `spec/ALP.md` - Section 4 and Section 7.6 predicate-grammar prose closed normatively; both markers removed, Section 10 marker untouched

## Decisions Made

- Task 1's checkpoint (resolved before this session): grammar exactly as D-01 bounds it (count/sum/exists, single optional filter, numeric outer compare), `exists` evaluated as a numeric truthiness compare (`exists(...) >= 1`, never a boolean literal), `invalid_predicate` as the fixed SpecError code, and the §7.6 BNF wording must match the implemented parser exactly.
- `sum`'s aggregate-field syntax (`sum(rows.amount [where ...])`) was Claude's Discretion within D-01's bound -- the checkpoint's own conformance example only exercised `count`, so the `sum` field-reference notation was designed to keep the grammar closed and BNF-expressible without adding a second clause shape.
- `invalid_predicate` was added to `SPEC_ERROR_CODES` in Task 2's own commit rather than Task 3's (see Deviations below).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Pulled the `invalid_predicate` SPEC_ERROR_CODES addition forward from Task 3 into Task 2**
- **Found during:** Task 2 (closed-AST parser + evaluator)
- **Issue:** `parse.ts`'s `invalidPredicate()` helper constructs a `SpecError` with `code: "invalid_predicate"` per the Task 1 checkpoint decision ("invalid_predicate is the SpecError code for any parse/grammar failure"), but the plan's task split placed the `SPEC_ERROR_CODES` array edit in Task 3. Running `tsc -b --force` after Task 2's initial implementation failed with `Type '"invalid_predicate"' is not assignable to type ...` because the code didn't exist yet in the union.
- **Fix:** Added `"invalid_predicate"` to `SPEC_ERROR_CODES` (`errors.ts`) as part of Task 2's commit instead of Task 3's, since the checkpoint decision governs the parser's own Result type, not just the manifest-validation error `validate.ts` constructs independently.
- **Files modified:** `packages/spec/src/errors.ts` (committed in Task 2's commit, not Task 3's)
- **Verification:** `tsc -b --force` and `pnpm --filter @stint/spec build` both clean after the fix; Task 3's own `errors.ts` action is consequently a documented no-op (the entry was already present).
- **Committed in:** `c13f76c` (Task 2 commit)

**2. [Rule 3 - Blocking] Removed literal `eval(`/`new Function` substrings from doc comments**
- **Found during:** Task 2 (closed-AST parser + evaluator)
- **Issue:** The plan's acceptance criteria require `grep -rn "eval(\|new Function" packages/spec/src/predicate` to return no matches. The initial docstrings in `ast.ts`/`parse.ts` described the "never eval / never new Function" prohibition using those exact substrings, which the acceptance-criteria grep would itself match (a false positive against documentation, not code).
- **Fix:** Reworded the docstrings to describe the same prohibition ("never interprets the predicate string as executable code of any kind") without using the literal `eval(` / `new Function` strings.
- **Files modified:** `packages/spec/src/predicate/ast.ts`, `packages/spec/src/predicate/parse.ts`
- **Verification:** `grep -rn "eval(\|new Function" packages/spec/src/predicate` returns no matches (confirmed before Task 2's commit).
- **Committed in:** `c13f76c` (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (both Rule 3 - blocking issues discovered while satisfying the plan's own acceptance criteria)
**Impact on plan:** Both fixes were necessary for the plan's stated acceptance criteria and type-check discipline to actually hold; no scope creep, no architectural change, no narrowing of the confirmed grammar.

## Issues Encountered

None. This was a continuation session: verified via `git log --oneline --all | grep -F "05-02"` (no output) that no commits existed for this plan before starting, then executed Tasks 2-3 per the already-confirmed checkpoint decision.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `@stint/spec` now exports `PredicateAst`/`parsePredicate`/`evaluatePredicate` as the single shared grammar definition; plan 05-07 (proxy-side outcome verification) can import these directly for the synthetic-read verifier without re-parsing or re-defining the grammar (D-28's key link).
- `spec/ALP.md` has exactly one remaining `OPEN: Phase 5` marker (Section 10's cleanup-token format), owned by plan 05-06.
- No blockers identified for downstream Phase 5 plans (05-03 through 05-08).

---
*Phase: 05-lease-endings-teardown*
*Completed: 2026-09-28*

## Self-Check: PASSED

- FOUND: packages/spec/src/predicate/ast.ts
- FOUND: packages/spec/src/predicate/parse.ts
- FOUND: packages/spec/src/predicate/evaluate.ts
- FOUND: packages/spec/src/validate.ts
- FOUND: packages/spec/test/predicate.test.ts
- FOUND: spec/ALP.md
- FOUND commit c13f76c (feat(05-02): add closed-AST predicate parser + pure evaluator)
- FOUND commit b5dae25 (feat(05-02): manifest-time invalid_predicate gate + close spec predicate markers)
- Re-ran `<verify>` for Task 2: `pnpm --filter @stint/spec build && vitest run packages/spec/test/predicate.test.ts` -- 18/18 passed
- Re-ran `<verify>` for Task 3: `pnpm --filter @stint/spec build && vitest run packages/spec/test/validate.test.ts && pnpm run check:alp && grep -c 'OPEN: Phase 5' spec/ALP.md == 1` -- 24/24 passed, check:alp passed, marker count confirmed 1
- `tsc -b --force` clean; `eslint` clean on all changed files
- Acceptance criteria re-verified: no `eval(`/`new Function` matches under `packages/spec/src/predicate`; spec conformance string parses and evaluates correctly; `PredicateAst`/`parsePredicate`/`evaluatePredicate` importable from `@stint/spec` barrel; `invalid_predicate` present in `SPEC_ERROR_CODES`; exactly one `OPEN: Phase 5` marker remains in `spec/ALP.md`
