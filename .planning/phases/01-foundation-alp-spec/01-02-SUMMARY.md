---
phase: 01-foundation-alp-spec
plan: 02
subsystem: spec
tags: [json-schema, ajv, ajv-formats, json-schema-to-typescript, draft-07, codegen, typescript]

requires:
  - phase: 01-foundation-alp-spec (plan 01)
    provides: "Green pnpm monorepo, @stint/spec package scaffold, approved exact package versions"
provides:
  - "spec/manifest.schema.json and spec/envelope.schema.json: canonical draft-07 schemas (D-09..D-21)"
  - "packages/spec/scripts/codegen.mjs: json2ts codegen with --check drift gate and --schema-dir override (D-27)"
  - "Committed generated types (packages/spec/src/generated/{manifest,envelope,schemas}.ts)"
  - "packages/spec/src/errors.ts: SPEC_ERROR_CODES, SpecErrorCode, SpecError, Result (D-31)"
  - "packages/spec/src/validate.ts: validateManifest, validateEnvelopeShape, resolveAuthMode, SUPPORTED_SPEC_VERSIONS"
  - "spec/vectors/{valid,invalid}: 23 conformance vectors consumed by Stint's own tests (D-25)"
affects: [01-03-canonicalization-and-envelope-signing, 02-pure-core-and-hostadapter, 07-e2e-and-readme]

actuals:
  tokens: 34400
  raw_tokens: 34400
  tasks: 3
  commits: 3

tech-stack:
  added:
    - "ajv@8.20.0, ajv-formats@3.0.1 (dependencies of @stint/spec)"
    - "json-schema-to-typescript@16.0.0 (devDependency of @stint/spec)"
  patterns:
    - "codegen.mjs strips the schema's root-level allOf ONLY for type generation (compile() call), keeping the full schema (with allOf) in schemas.ts for Ajv — json-schema-to-typescript emits `type X = {...}` instead of `interface X {...}` for any allOf-bearing node, and if/then conditional-required rules aren't expressible in generated TS types regardless of whether allOf is stripped, so this loses no type information"
    - "Cross-field conditional-required rules (auth.mode -> delegated/hosted, pay -> spend) live in the ROOT schema's allOf referencing nested properties (e.g. properties.auth.properties.mode), not inside the named `Auth` definition's own allOf — keeping named definitions allOf-free avoids the $ref-target-vs-merged-schema title collision that produces an `Auth`/`Auth1` alias split"
    - "Ajv's raw oneOf failure at /job/verifier is collapsed to a single derived error by inspecting the instance's own `type` field and re-validating against only the matching branch's compiled sub-schema (ajv.getSchema('manifest#/definitions/<Branch>')) — see validate.ts collapseVerifierErrors"
    - "Semantic checks (unknown_resource_reference, duplicate_item) run only after the schema itself passes, since they index into a shape that Ajv has already proven complete"

key-files:
  created:
    - spec/manifest.schema.json
    - spec/envelope.schema.json
    - packages/spec/scripts/codegen.mjs
    - packages/spec/src/generated/manifest.ts
    - packages/spec/src/generated/envelope.ts
    - packages/spec/src/generated/schemas.ts
    - packages/spec/src/errors.ts
    - packages/spec/src/validate.ts
    - packages/spec/test/fixtures.ts
    - packages/spec/test/validate.test.ts
    - packages/spec/test/vectors.test.ts
    - packages/spec/test/types.test.ts
    - packages/spec/test/codegen.test.ts
    - spec/vectors/valid/*.json (5)
    - spec/vectors/invalid/*.json (18)
  modified:
    - packages/spec/package.json
    - packages/spec/src/index.ts
    - pnpm-lock.yaml

key-decisions:
  - "Moved the two D-17 auth-mode conditional-required allOf entries out of the `Auth` definition and into the root Manifest schema's own allOf (referencing `properties.auth...`), because leaving allOf inside a named, $ref-referenced definition made json-schema-to-typescript emit a colliding `Auth`/`Auth1` alias pair instead of a clean `Auth` interface — same runtime validation semantics, clean generated type."
  - "codegen.mjs generates TypeScript types from a shallow-cloned schema with the root `allOf` deleted, while schemas.ts (the Ajv-compiled runtime schema) keeps the original schema with allOf intact — json2ts emits `type Manifest = {...}` instead of `interface Manifest {...}` whenever a node has a top-level allOf, and since if/then conditionals add no information the generated types could express anyway, stripping allOf for type-gen only recovers a clean named interface at zero cost to runtime validation."
  - "`ajv.getSchema('manifest#/definitions/<Branch>')` sub-schema lookup is the mechanism for D-18's oneOf-branch collapse — verified empirically against Ajv 8.20.0 before writing validate.ts's collapseVerifierErrors."

requirements-completed: [SPEC-02, SPEC-03, SPEC-04, SPEC-05]

coverage:
  - id: D1
    description: "The payment-reconciler manifest (hybrid, Paystack read, orders sheet write, resource_query verifier) passes the draft-07 schema through validateManifest, and validation never mutates its input (SPEC-02, D-32)"
    requirement: "SPEC-02"
    verification:
      - kind: unit
        ref: "packages/spec/test/validate.test.ts#valid manifest: payment-reconciler passes"
        status: pass
      - kind: unit
        ref: "packages/spec/test/validate.test.ts#auth mode default: validation does not mutate input"
        status: pass
      - kind: unit
        ref: "packages/spec/test/vectors.test.ts#payment-reconciler vector equals the test fixture"
        status: pass
    human_judgment: false
  - id: D2
    description: "Unknown scope access, approval, verifier type and auth mode values are each rejected with exactly one structured invalid_enum error whose allowed list is the fixed vocabulary; a verifier carrying fields from two branches is rejected even though a blind type assertion would accept it (SPEC-03, D-18)"
    requirement: "SPEC-03"
    verification:
      - kind: unit
        ref: "packages/spec/test/validate.test.ts#rejects unknown access value|approval value|verifier type|auth mode|verifier with fields from two branches"
        status: pass
      - kind: unit
        ref: "packages/spec/test/vectors.test.ts#every invalid vector yields exactly its expected errors"
        status: pass
    human_judgment: false
  - id: D3
    description: "auth.delegated accepts a list of provider grants (single accepted, empty rejected with out_of_range); an omitted auth.mode is held to exactly hybrid's requirements and resolveAuthMode returns 'hybrid' for it (SPEC-04)"
    requirement: "SPEC-04"
    verification:
      - kind: unit
        ref: "packages/spec/test/validate.test.ts#auth mode default: omitted mode resolves to hybrid|is held to hybrid requirements"
        status: pass
      - kind: unit
        ref: "packages/spec/test/validate.test.ts#auth.delegated accepts a list of provider grants"
        status: pass
    human_judgment: false
  - id: D4
    description: "Types generated from spec/manifest.schema.json are importable from @stint/spec, and pnpm codegen:check exits non-zero when the schema changes without regenerating (SPEC-05, D-27); both schemas compile under Ajv strict mode"
    requirement: "SPEC-05"
    verification:
      - kind: unit
        ref: "packages/spec/test/codegen.test.ts#codegen check passes on committed output|detects stale types|schemas compile in Ajv strict mode"
        status: pass
      - kind: integration
        ref: "pnpm codegen:check (root script) exits 0 against committed output"
        status: pass
    human_judgment: false
  - id: D5
    description: "Every structured error is Stint-owned (only path/code/message/allowed?, code in SPEC_ERROR_CODES, no Ajv ErrorObject leakage), deterministic (deduped, sorted by path then code), and conformance vectors exercise the same contract as Stint's own tests (D-25, D-31)"
    requirement: ""
    verification:
      - kind: unit
        ref: "packages/spec/test/validate.test.ts#errors are deterministic and Stint-owned"
        status: pass
      - kind: other
        ref: "grep -n \"ErrorObject\" packages/spec/src/index.ts (no output)"
        status: pass
    human_judgment: false

duration: 36min
completed: 2026-09-27
status: complete
---

# Phase 1 Plan 2: Manifest Schema, Codegen and Validator Summary

**draft-07 manifest/envelope schemas with committed json2ts types, an Ajv-backed `validateManifest`/`validateEnvelopeShape` returning Stint-owned structured errors, and 23 conformance vectors — all wired end to end from the payment-reconciler manifest.**

## Performance

- **Duration:** 36 min
- **Started:** 2026-09-27T14:02:00Z (approx., immediately after 01-01's wave-1 tracking commit)
- **Completed:** 2026-09-27T14:38:00Z
- **Tasks:** 3
- **Files created:** 36 (13 source/test files + 23 conformance vectors)
- **Files modified:** 3 (packages/spec/package.json, packages/spec/src/index.ts, pnpm-lock.yaml)

## Accomplishments

- Authored `spec/manifest.schema.json` (draft-07): every field from D-09..D-19 — `Identifier`/`Access`/`ApprovalTrigger`/`AuthMode`/`PublisherRetains` enums and patterns, the `Verifier` `oneOf`+`const` tagged union (`resource_query`/`user_confirm`/`none`), `x-` passthrough (`patternProperties` + `additionalProperties: false`) on every object node, and three root-level `allOf` conditionals (pay-requires-spend, mode-conditional delegated/hosted requirements)
- Authored `spec/envelope.schema.json`: `SignedEnvelope { manifest, signature: { alg: "EdDSA", kid, sig } }`, no `x-` passthrough (nothing outside `manifest` is signed)
- `packages/spec/scripts/codegen.mjs`: generates `manifest.ts`/`envelope.ts` via `json-schema-to-typescript` and a hand-written `schemas.ts` module exporting the raw schema objects for Ajv; `--check` diffs committed output (CRLF-normalized) and exits 1 printing "stale"; `--schema-dir DIR` overrides the schema source directory for the drift test
- `packages/spec/src/errors.ts`: `SPEC_ERROR_CODES` (17 codes), `SpecErrorCode`, `SpecError`, `Result<T>`
- `packages/spec/src/validate.ts`: one Ajv instance (`allErrors: true, strict: true, allowUnionTypes: true`, `ajv-formats`), `validateManifest`/`validateEnvelopeShape` (never mutate input, return the same object reference on success), `resolveAuthMode`, a generic Ajv-keyword-to-Stint-code mapper, a `oneOf` verifier-branch collapse (derives a single clean error from the instance's own `type` field instead of Ajv's noisy multi-branch output), and the two semantic checks not expressible in JSON Schema (`unknown_resource_reference`, `duplicate_item`)
- `packages/spec/src/index.ts`: re-exports `SPEC_VERSION`, the errors module, the validate functions/constants, and all 24 generated types
- 23 conformance vectors in `spec/vectors/{valid,invalid}` (5 valid, 18 invalid — one schema/semantic mutation each), consumed by both `vectors.test.ts` and (implicitly, as the language-agnostic conformance artifact) `spec/ALP.md`'s future conformance section
- `packages/spec/test/{fixtures,validate,vectors,types,codegen}.test.ts`: 39 tests total across the package, all green

## Task Commits

1. **Task 1: End-to-end schema-to-generated-type-to-validateManifest tracer** - `866a140` (feat)
2. **Task 2: Harden the structured-error contract (SPEC-03/SPEC-04 test suite)** - `d01a946` (test)
3. **Task 3: Conformance vectors, generated-type tests, codegen drift gate** - `e8049ba` (feat)

_No separate plan-metadata commit was made in this step — SUMMARY.md and this plan's STATE.md/ROADMAP.md/REQUIREMENTS.md updates are the orchestrator's responsibility per this run's instructions._

## Files Created/Modified

- `spec/manifest.schema.json` — canonical draft-07 manifest schema (D-21)
- `spec/envelope.schema.json` — draft-07 signed-envelope shell schema (D-04)
- `packages/spec/scripts/codegen.mjs` — json2ts codegen + `--check`/`--schema-dir`
- `packages/spec/src/generated/{manifest,envelope,schemas}.ts` — committed generated output
- `packages/spec/src/errors.ts` — `SPEC_ERROR_CODES`/`SpecErrorCode`/`SpecError`/`Result`
- `packages/spec/src/validate.ts` — `validateManifest`/`validateEnvelopeShape`/`resolveAuthMode`
- `packages/spec/src/index.ts` — public re-exports (modified)
- `packages/spec/package.json` — `ajv`/`ajv-formats`/`json-schema-to-typescript` + `codegen`/`codegen:check` scripts (modified)
- `packages/spec/test/{fixtures,validate,vectors,types,codegen}.test.ts` — 39 tests
- `spec/vectors/valid/*.json` (5), `spec/vectors/invalid/*.json` (18) — conformance vectors
- `pnpm-lock.yaml` — updated for the three new/changed dependencies (modified)

## Decisions Made

See frontmatter `key-decisions` for full detail. Summary:
1. Moved D-17's two auth-mode conditionals from the `Auth` definition's own `allOf` to the root schema's `allOf` (referencing `properties.auth...`) to avoid a json2ts `Auth`/`Auth1` name-collision alias — same validation semantics, clean interface.
2. `codegen.mjs` strips the root `allOf` for TYPE GENERATION ONLY (Ajv still validates against the full schema via `schemas.ts`) because json2ts emits `type X = {...}` instead of `interface X {...}` for any allOf-bearing node, and if/then conditionals carry no information the generated types could express anyway.
3. Verified `ajv.getSchema('manifest#/definitions/<Branch>')` sub-schema retrieval live before relying on it for the D-18 `oneOf` collapse.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `Auth`/`Auth1` name collision from allOf inside a $ref-referenced definition**
- **Found during:** Task 1 (initial codegen run)
- **Issue:** With the two D-17 conditionals living inside `definitions.Auth`'s own `allOf`, `json-schema-to-typescript` emitted `export type Auth = Auth1; export interface Auth1 {...}` instead of a clean `Auth` interface — the plan's interfaces block requires plain named types, and the plan explicitly says "fix the schema title rather than aliasing."
- **Fix:** Moved both conditionals to the root Manifest schema's `allOf`, referencing `properties.auth.properties.mode` instead of a bare `mode` property inside the `Auth` node. Verified identical validation behavior (mode omitted/delegated/hosted/hybrid, all four combinations) against the restructured schema before proceeding.
- **Files modified:** spec/manifest.schema.json
- **Verification:** `node -e` script exercising all four mode combinations against a fresh Ajv instance; later covered by `validate.test.ts`'s "auth mode default" test group
- **Committed in:** 866a140 (Task 1 commit)

**2. [Rule 1 - Bug] Root-level allOf forced `type Manifest = {...}` instead of `interface Manifest {...}`**
- **Found during:** Task 1 (acceptance-criteria check: `grep "export interface Manifest"` failed)
- **Issue:** The root schema's own `allOf` (needed for the pay-requires-spend and, after fix #1, the two auth-mode conditionals) made `json-schema-to-typescript` emit the merged shape as a plain `type` alias rather than a named `interface`, even though the resulting field list is identical either way (conditional-required rules aren't expressible in generated TS types regardless).
- **Fix:** `codegen.mjs` now compiles TYPES from a shallow clone of the schema with the root `allOf` deleted, while `schemas.ts` (what `validate.ts` compiles with Ajv) keeps the full schema with `allOf` intact. No loss of runtime validation; the committed types are unaffected in every field/shape sense — only the `type`-vs-`interface` keyword changes.
- **Files modified:** packages/spec/scripts/codegen.mjs
- **Verification:** `grep -n "export interface Manifest" packages/spec/src/generated/manifest.ts` now matches; `pnpm codegen:check` clean
- **Committed in:** 866a140 (Task 1 commit)

**3. [Rule 1 - Bug] TypeScript couldn't narrow a top-level throw-guard across closures**
- **Found during:** Task 1 (`pnpm typecheck`)
- **Issue:** `const validateManifestSchema = ajv.getSchema(...)` followed by a sibling `if (!validateManifestSchema) throw ...` doesn't narrow the type inside the later-defined exported functions that reference `validateManifestSchema` (TS doesn't carry control-flow narrowing of an outer binding into a separate function body).
- **Fix:** Extracted a `requireCompiledSchema(key)` helper that throws-and-returns a non-undefined `ValidateFunction`, removing the need for cross-closure narrowing entirely.
- **Files modified:** packages/spec/src/validate.ts
- **Verification:** `pnpm typecheck` clean
- **Committed in:** 866a140 (Task 1 commit)

**4. [Rule 1 - Bug] Floating-promise and non-null-assertion lint violations**
- **Found during:** Task 1 and Task 2 (`pnpm lint`)
- **Issue:** (a) Calling a branch `ValidateFunction` without consuming its return value tripped `@typescript-eslint/no-floating-promises` (Ajv's `ValidateFunction` call signature can return `Promise<unknown>` for `$async` schemas, even though ours never are). (b) Two test-file casts through an intermediate `Record<string, unknown>[]` array type discarded the generated `[Scope, ...Scope[]]` tuple guarantee, forcing a `!` non-null assertion that `@typescript-eslint/no-non-null-assertion` forbids.
- **Fix:** (a) Prefixed the branch-validator call with `void`. (b) Cast only the specific tuple element (`manifest.scopes[0] as unknown as Record<string, unknown>`) instead of the whole array, keeping the tuple's index-0 guarantee intact so no `!` was needed.
- **Files modified:** packages/spec/src/validate.ts, packages/spec/test/validate.test.ts
- **Verification:** `pnpm lint` clean
- **Committed in:** 866a140 (Task 1), d01a946 (Task 2)

**5. [Rule 1 - Bug] Own test-fixture bug in the duplicate-scope-resource test**
- **Found during:** Task 2 (first `vitest run` of the hardening suite)
- **Issue:** Mutating `manifest.scopes` to introduce a duplicate `paystack.transactions` resource left `auth.delegated`'s second grant (`google_sheets` -> `sheets.orders`) pointing at a resource no longer present in `scopes`, so the test produced an extra, unrelated `unknown_resource_reference` error alongside the expected `duplicate_item` error.
- **Fix:** Updated the test to also constrain `auth.delegated` to a single grant referencing only the resource that still exists, isolating the intended semantic check.
- **Files modified:** packages/spec/test/validate.test.ts
- **Verification:** `vitest run packages/spec/test/validate.test.ts` — 19/19 pass
- **Committed in:** d01a946 (Task 2 commit)

---

**Total deviations:** 5 auto-fixed (all Rule 1 — bugs/blocking issues surfaced by the acceptance criteria and toolchain, not scope changes)
**Impact on plan:** All five were necessary to satisfy the plan's own literal acceptance criteria (clean interface names, no lint/typecheck errors) or to fix a self-introduced test bug. No scope creep — no additional fields, files, or behavior beyond what the three tasks specify.

## TDD Gate Compliance

This plan's frontmatter is `type: execute` (not `type: tdd`), so the strict RED/GREEN gate (`gsd_run check tdd-red-evidence`, INVALID_RED enforcement) does not apply here — but Tasks 2 and 3 carry `tdd="true"`, so this section documents the actual commit sequence against the canonical RED -> GREEN -> REFACTOR pattern for transparency:

- **Task 1 (`type="tracer"`, not TDD):** Built the schema, codegen script, and a complete `validate.ts` (including the `oneOf` collapse and semantic checks that Task 2's action text describes) to get one real, empirically-verified end-to-end baseline before the tracer feedback gate. This is normal tracer scope, not a TDD violation.
- **Task 2 (`tdd="true"`):** Because Task 1's `validate.ts` already implemented the full mapping/collapse/semantic logic, writing Task 2's 19 behavior tests did not produce a genuine RED phase — 18 of 19 passed immediately, and the one failure (`semantic: duplicate scope resources`) was a bug in the new test's own fixture construction, not in `validate.ts`. Committed as a single `test(01-02):` commit; no `feat(01-02):` commit was needed for this task since no production code changed.
- **Task 3 (`tdd="true"`):** Added 23 conformance vectors plus `vectors.test.ts`/`types.test.ts`/`codegen.test.ts`. All content here is test fixtures and test files — no production code changed — so there is no meaningful GREEN phase either; every vector was cross-validated against the already-compiled `dist/index.js` build via a standalone Node script before the vitest suite was written, then all 11 new tests passed on first run. Committed as `feat(01-02):` (a labeling inconsistency — this commit is entirely test/fixture content and would have been more accurately `test(01-02):`; flagged here rather than silently left).

**Net assessment:** no implementation bugs were pinned-then-fixed by a RED->GREEN cycle in Tasks 2/3 because Task 1's tracer front-loaded the implementation; the one genuine "red" moment (Task 2's fixture bug) was caught and fixed before commit. All 39 tests are green and match the plan's exact `<behavior>`/`<acceptance_criteria>` specifications.

## Issues Encountered

None beyond the deviations documented above.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `@stint/spec` now exports a complete, tested manifest/envelope validation surface (`validateManifest`, `validateEnvelopeShape`, `resolveAuthMode`, all generated types, `SPEC_ERROR_CODES`). Plan 01-03 (canonicalization, hashing, envelope signing) builds directly on top of this — `Manifest`, `SignedEnvelope`, and the `Result`/`SpecError` shapes are the exact contracts it consumes.
- `codegen:check` is wired into the root `codegen`/`codegen:check` scripts (already gated in 01-01's CI workflow), so any future schema edit without regeneration will fail CI.
- No blockers carried forward specific to this plan. The cross-phase blocker already on record (STATE.md: "the canonical serializer introduced for the manifest hash (SPEC-06) must be the same one used by receipt chains (RCPT-02)") is unaffected — this plan did not touch canonicalization/hashing (that's plan 01-03's SPEC-06 scope).

---
*Phase: 01-foundation-alp-spec*
*Completed: 2026-09-27*

## Self-Check: PASSED

- All 14 named `key-files.created` entries (plus 23 conformance vector files) verified present on disk via `[ -f ]` checks.
- All three task commits (`866a140`, `d01a946`, `e8049ba`) verified present in `git log --oneline --all`.
- Re-ran plan-level verification after self-check: `pnpm codegen:check`, `pnpm exec vitest run packages/spec/test/validate.test.ts` (19/19), `pnpm typecheck`, `pnpm lint`, `pnpm test` (9 files, 39 tests) all exit 0.
