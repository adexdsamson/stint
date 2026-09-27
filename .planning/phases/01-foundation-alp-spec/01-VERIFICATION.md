---
phase: 01-foundation-alp-spec
verified: 2026-09-27T16:20:00Z
status: human_needed
score: 9/9 must-haves verified (requirement-level); 0 behavior-unverified
covered_files: [".gitattributes", ".github/workflows/ci.yml", ".planning/REQUIREMENTS.md", ".planning/phases/01-foundation-alp-spec/01-01-PLAN.md", ".planning/phases/01-foundation-alp-spec/01-01-SUMMARY.md", ".planning/phases/01-foundation-alp-spec/01-02-PLAN.md", ".planning/phases/01-foundation-alp-spec/01-02-SUMMARY.md", ".planning/phases/01-foundation-alp-spec/01-03-PLAN.md", ".planning/phases/01-foundation-alp-spec/01-03-SUMMARY.md", ".planning/phases/01-foundation-alp-spec/01-04-PLAN.md", ".planning/phases/01-foundation-alp-spec/01-04-SUMMARY.md", ".planning/phases/01-foundation-alp-spec/01-05-PLAN.md", ".planning/phases/01-foundation-alp-spec/01-05-SUMMARY.md", "LICENSE", "package.json", "packages/spec/scripts/codegen.mjs", "packages/spec/src/canonical.ts", "packages/spec/src/envelope.ts", "packages/spec/src/errors.ts", "packages/spec/src/index.ts", "packages/spec/src/jws.ts", "packages/spec/src/testing.ts", "packages/spec/src/validate.ts", "pnpm-workspace.yaml", "scripts/check-alp-sections.mjs", "spec/ALP.md", "spec/envelope.schema.json", "spec/manifest.schema.json", "spec/vectors/README.md"]
covered_digest: "v1:sha256:915006500935bc01f23f570681f485d732f0ff87ce36e95cba862b7b81e8a615"
behavior_unverified: 0
overrides_applied: 0
human_verification:
  - test: "Add a GitHub remote, push a branch, and confirm all four CI matrix legs (ubuntu-latest + windows-latest x Node 22.12.0 + 24) pass every step (install --frozen-lockfile, build, typecheck, lint, check:alp, codegen:check, test)."
    expected: "All four legs go green on GitHub-hosted runners."
    why_human: "This repo currently has no git remote (confirmed: `git remote -v` prints nothing), so a live GitHub Actions run cannot be executed or observed from this environment. The workflow YAML's static shape is fully verified (Success Criterion 1 / FND-02) but the actual multi-OS, multi-Node-version execution requires a real CI run, which VALIDATION.md and both 01-01-SUMMARY.md and 01-01-PLAN.md explicitly defer to a manual-only check at end of phase."
  - test: "Read spec/ALP.md end to end as a newcomer and confirm the document alone (without reading the source code) teaches all eleven lease states and their transitions, the seven actors (with the agent never one), the three auth modes, the teardown order, the receipt model, the trust model, and the four trust limits; separately, attempt to reproduce the content hash and signature check from Section 5's prose alone."
    expected: "A reader with no prior exposure to the TypeScript implementation can learn the complete protocol from this one document, and can compute jcs-sha256:32de102e74d3141a3770c679871dae312691fb3ba522d3f3594f24489c6c704a from the annotated example using only Section 4/5 prose."
    why_human: "Prose completeness, clarity and pedagogical soundness are reading-comprehension judgments that scripts/check-alp-sections.mjs cannot evaluate; it only proves structural presence (headings, tables, required phrases, diagram counts), not that the writing is actually clear and correct to a first-time reader. VALIDATION.md lists this explicitly as a manual-only row for SPEC-01, and both 01-04-SUMMARY.md and 01-05-SUMMARY.md flag it as outstanding by design pending end-of-phase human review."
---

# Phase 1: Foundation & ALP Spec Verification Report

**Phase Goal:** Developers have a green, cross-platform monorepo; readers can learn the whole protocol from one normative document; publishers can author manifests that are validated, typed, hashed and signature-checked.
**Verified:** 2026-09-27T16:20:00Z
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths (mapped to ROADMAP.md Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1a | On a fresh clone, `pnpm install && pnpm test` builds and tests every `@stint/*` package green on Node 22.12+ | ✓ VERIFIED | Ran `git clone` into a fresh temp dir, then `pnpm install --frozen-lockfile && pnpm test && pnpm typecheck && pnpm lint` — all exit 0; Vitest reports 13 test files, 86 tests passed. Root `pnpm test` also independently re-run in-place: same result. |
| 1b | CI runs typecheck, lint and tests on Linux and Windows for every push (static shape) | ✓ VERIFIED | `.github/workflows/ci.yml` contains matrix `os: [ubuntu-latest, windows-latest]` x `node: ["22.12.0", "24"]`, `permissions: contents: read`, triggers `push`/`pull_request` (no branch filter), and steps in order: checkout, pnpm/action-setup, setup-node, `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm check:alp`, `pnpm codegen:check`, `pnpm test`. |
| 1b-live | CI actually runs green on GitHub-hosted Linux and Windows runners | ⚠️ HUMAN VERIFICATION NEEDED | No git remote exists (`git remote -v` empty) — a live 4-leg run cannot be observed from this environment. Correctly deferred per VALIDATION.md's manual-only row. See Human Verification section. |
| 1c | Repo is licensed Apache-2.0 | ✓ VERIFIED | Root `LICENSE` contains "Apache License", "Version 2.0, January 2004"; `packages/spec/test/license.test.ts` enumerates `packages/*` from disk and asserts `license: "Apache-2.0"` + `name: "@stint/<dir>"` on each — test passes (part of the 86 green tests). All four package.json files confirmed by direct grep: spec, core, proxy, cli all `"license": "Apache-2.0"`. |
| 2 | A reader can learn the full protocol from `spec/ALP.md`: all eleven states/transitions, actor list (agent never ends/extends), three auth modes, teardown order, receipts, trust model, trust limits | ✓ VERIFIED (structure) / ⚠️ HUMAN VERIFICATION NEEDED (prose quality) | `spec/ALP.md` (573 lines) contains all 16 required headings in order, exactly one `stateDiagram-v2` naming all eleven states, a 25-row transition table (Section 7.4) with the exact header, Section 7.2's "The agent is never an actor" sentence, three `sequenceDiagram` blocks, Section 10's five-step teardown list, Section 13's four exact trust-limit phrases verbatim ("integrity, not completeness", "cross-resource data flow", "attested, not verified", "operated by the user or a neutral party"). `pnpm check:alp` passes; six negative mutations (state-diagram removal, heading rename, agent-actor injection, path-back-to-active injection, trust-limit-phrase mutation, teardown-step mutation) were independently re-run against this checkout and all correctly rejected with non-zero exit and a specific error message (spot-checked two: stateDiagram removal → "expected exactly one mermaid stateDiagram-v2 block, found 0"; agent-actor row → "transition table row (active, expire, agent) has an actor outside the seven-actor list"). Prose *completeness and clarity* to a first-time reader is a judgment call the checker cannot make — see Human Verification. |
| 3 | A valid manifest passes the draft-07 schema; unknown scope/approval/verifier/auth-mode values are rejected with structured errors; `auth.delegated` accepts a list of grants; `auth.mode` defaults to `hybrid` | ✓ VERIFIED | `spec/manifest.schema.json` is draft-07 with the full field set. `pnpm exec vitest run packages/spec/test/validate.test.ts -t "rejects unknown"` → 4 passed (access, approval, verifier type, auth mode, each with exact `{path, code: invalid_enum, allowed}`). Vectors test (18 invalid + 5 valid vectors) passes as part of the 86-test full run. `resolveAuthMode` on a mode-less manifest test passes ("auth mode default: omitted mode resolves to hybrid"). |
| 4 | A developer imports TS types generated from the schema through `@stint/spec`, and changing the schema without regenerating fails the build | ✓ VERIFIED | `pnpm codegen:check` exits 0 against the committed generated files; `packages/spec/test/codegen.test.ts` includes a drift test (mutates a temp schema copy, proves `--check` exits 1 with "stale"); `packages/spec/src/generated/manifest.ts` contains `export interface Manifest`; `pnpm typecheck` passes with `types.test.ts`'s `@ts-expect-error` assertions enforced. |
| 5 | The runtime computes the same jcs-sha256 hash regardless of key order/whitespace, and rejects an unverified publisher signature before consent | ✓ VERIFIED | `packages/spec/test/canonical.test.ts -t "golden hash"` → 3 passed. Independently re-verified: `sha256sum spec/vectors/jcs/manifest-canonical.json` matches the committed `jcs-sha256:32de102e74...` value byte for byte (re-ran the exact shell comparison from the plan, exit 0). `verifyEnvelope` implements the 10-step procedure with signature verification (step 6) strictly before manifest validation (step 8) and before any value is returned; `VerifiedManifest` is a module-private-branded type only `verifyEnvelope` can mint (proven by `brand.test.ts`'s `@ts-expect-error`, enforced by `pnpm typecheck`). |

**Score:** 9/9 roadmap-level truths structurally and behaviorally verified; 2 of them (1b-live, and the prose-quality half of truth 2) additionally require human judgment that cannot be produced by this environment, per explicit instruction and per the phase's own VALIDATION.md.

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `package.json` | Root workspace manifest, pnpm@12.6.0, engines >=22.12.0, ESM | ✓ VERIFIED | Present, contains all required fields/scripts |
| `pnpm-workspace.yaml` | strictDepBuilds, engineStrict, allowBuilds map | ✓ VERIFIED | `strictDepBuilds: true`, `engineStrict: true`, `allowBuilds: {}` |
| `LICENSE` | Apache-2.0 full text | ✓ VERIFIED | Confirmed title/version/terms-terminator |
| `.gitattributes` | LF normalization | ✓ VERIFIED | `* text=auto eol=lf` (first line) |
| `.github/workflows/ci.yml` | Linux+Windows matrix, Node 22.12.0+24 | ✓ VERIFIED | Static shape confirmed; live run is human-check |
| `packages/{spec,core,proxy,cli}/*` | Four buildable packages | ✓ VERIFIED | All build via `pnpm build`; smoke tests pass; dependency graph (spec←core←proxy,cli) proven by real imports |
| `spec/manifest.schema.json` | Draft-07 canonical schema | ✓ VERIFIED | Contains draft-07 `$schema`, full field set, conditionals |
| `spec/envelope.schema.json` | Envelope shell schema | ✓ VERIFIED | `{manifest, signature: {alg, kid, sig}}`, no x- passthrough |
| `packages/spec/scripts/codegen.mjs` | json2ts codegen + `--check` | ✓ VERIFIED | `--check` mode works; drift test passes |
| `packages/spec/src/errors.ts` | SPEC_ERROR_CODES, SpecError, Result | ✓ VERIFIED | Exports present, no Ajv leakage (`grep ErrorObject` empty) |
| `packages/spec/src/validate.ts` | validateManifest, validateEnvelopeShape, resolveAuthMode | ✓ VERIFIED | All exported, behavior-tested |
| `packages/spec/src/canonical.ts` | canonicalize, hashCanonical, hashManifest, isContentHash | ✓ VERIFIED | RFC 8785 golden vectors pass |
| `packages/spec/src/jws.ts` | JWS_PROTECTED_HEADER, sign/verify detached | ✓ VERIFIED | Internal only, not re-exported (tested) |
| `packages/spec/src/envelope.ts` | verifyEnvelope, parseEnvelope, TrustStore, VerifiedManifest | ✓ VERIFIED | 10-step procedure implemented and tested |
| `packages/spec/src/testing.ts` | @stint/spec/testing signing helpers | ✓ VERIFIED | Subpath export only, not on public entry |
| `spec/ALP.md` | Complete normative document | ✓ VERIFIED | All 16 sections present, checker-gated |
| `scripts/check-alp-sections.mjs` | Structural checker | ✓ VERIFIED | Runs in CI, six negative directions independently re-confirmed |
| `spec/vectors/{valid,invalid,jcs,envelope}/` | Conformance vectors | ✓ VERIFIED | 5 valid, 18 invalid, 5 jcs, 8 envelope files, all present and consumed by tests |
| `spec/vectors/README.md` | Vector guide | ✓ VERIFIED | Present, documents all four directories |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|----|--------|---------|
| `packages/core/src/index.ts` | `packages/spec/src/index.ts` | `workspace:*` import of `SPEC_VERSION` | ✓ WIRED | Cross-package import proven by passing smoke test through built `dist/` |
| `package.json` test script | `packages/*/package.json` | `pnpm -r build` before `vitest run` | ✓ WIRED | Confirmed: `pnpm test` script is `pnpm build && vitest run`; build ran first in every test invocation observed |
| `.github/workflows/ci.yml` | `package.json` scripts | CI steps call build/typecheck/lint/check:alp/codegen:check/test | ✓ WIRED | All six pnpm script names present in the workflow file in the documented order |
| `packages/spec/scripts/codegen.mjs` | `spec/manifest.schema.json` | `compile()` + byte copy into `src/generated` | ✓ WIRED | `codegen:check` passes; generated types match |
| `packages/spec/src/validate.ts` | `packages/spec/src/generated/schemas.ts` | Ajv-compiled schemas | ✓ WIRED | Validation tests pass against real Ajv-compiled schema |
| `packages/spec/src/envelope.ts` | `packages/spec/src/canonical.ts` | `canonicalize()` for both signature payload and hash input | ✓ WIRED | `hashCanonicalText` reuses the exact bytes verified in step 6, per source read |
| `packages/spec/src/envelope.ts` | `packages/spec/src/validate.ts` | `validateManifest` on the reparsed canonical text | ✓ WIRED | Step 8 of the procedure, confirmed in source |
| `scripts/check-alp-sections.mjs` | `spec/ALP.md` §7.4 | Parses transition table, rejects agent actors/paths to active | ✓ WIRED | Re-ran both negative mutations live; both correctly rejected |
| `scripts/check-alp-sections.mjs` | `spec/vectors/valid/payment-reconciler.json` | Deep-equality of §4's annotated example | ✓ WIRED | `pnpm check:alp` passes on the committed document (this check is active, part of the checker's full rule set) |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|--------------|-------------|-------------|--------|----------|
| FND-01 | 01-01 | Fresh clone + `pnpm install && pnpm test` green, Node 22.12+ | ✓ SATISFIED | Fresh-clone re-run in this session: exit 0, 86 tests pass |
| FND-02 | 01-01 | CI runs typecheck/lint/tests on Linux+Windows for every push | ✓ SATISFIED (static) / ? NEEDS HUMAN (live) | Workflow YAML fully verified; live 4-leg run needs a remote (none exists) |
| FND-03 | 01-01 | Apache-2.0 license, `@stint/*` package names | ✓ SATISFIED | LICENSE + license.test.ts pass |
| SPEC-01 | 01-04, 01-05 | Full protocol learnable from spec/ALP.md | ✓ SATISFIED (structure) / ? NEEDS HUMAN (prose quality) | All structural/safety checks pass; readability is a human judgment |
| SPEC-02 | 01-02, 01-05 | Manifest validated against draft-07 schema | ✓ SATISFIED | Schema + validateManifest + vectors all pass |
| SPEC-03 | 01-02 | Fixed vocabularies rejected with structured errors | ✓ SATISFIED | Named tests pass with exact (path, code, allowed) |
| SPEC-04 | 01-02, 01-03 | auth.delegated list, auth.mode defaults hybrid | ✓ SATISFIED | Tests pass; array-order-changes-hash test also passes (SPEC-04 ordering edge in 01-03) |
| SPEC-05 | 01-02 | Generated types + codegen:check drift gate | ✓ SATISFIED | codegen:check passes; drift test proves failure direction |
| SPEC-06 | 01-03, 01-05 | Canonical content hash + signature verification before consent | ✓ SATISFIED | Golden hash independently reproduced via sha256sum; verifyEnvelope tested exhaustively |

No orphaned requirements: all 9 IDs the ROADMAP maps to Phase 1 (FND-01/02/03, SPEC-01 through SPEC-06) appear in exactly one plan's `requirements:` frontmatter each, with no gaps.

### Anti-Patterns Found

None. Scanned all `packages/*/src`, `packages/*/scripts`, `scripts/`, and `spec/ALP.md` for `TBD|FIXME|XXX`, `TODO|HACK|PLACEHOLDER`, "coming soon"/"not yet implemented", and empty-return stub patterns. Three `return null` matches in `envelope.ts` and `validate.ts` were inspected directly and are legitimate nullable-lookup helper returns (`readEd25519PublicJwk`, a manifest-shape reader), not stubs — each is immediately followed by real logic that consumes the non-null case, and the helpers are exercised by the passing test suite.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Fresh clone builds and tests green | `git clone` to temp + `pnpm install --frozen-lockfile && pnpm test && pnpm typecheck && pnpm lint` | Exit 0, 13 files/86 tests passed | ✓ PASS |
| Engine-strict Node 22.12.0 floor install | `pnpm install --frozen-lockfile --config.node-version=22.12.0 --config.engine-strict=true` | Exit 0 | ✓ PASS |
| SPEC-03 vocabulary rejection | `vitest run validate.test.ts -t "rejects unknown"` | 4 passed | ✓ PASS |
| SPEC-06 golden hash | `vitest run canonical.test.ts -t "golden hash"` | 3 passed | ✓ PASS |
| SPEC-06 independent hash oracle | `sha256sum` comparison against committed hash | Match | ✓ PASS |
| ALP.md structural checker (positive) | `pnpm check:alp` | "ALP check passed" | ✓ PASS |
| ALP.md checker rejects missing state diagram | mutated copy, checker run | Exit 1, correct error message | ✓ PASS |
| ALP.md checker rejects agent-actor row | mutated copy, checker run | Exit 1, correct error message | ✓ PASS |
| Full pipeline | `pnpm build && pnpm typecheck && pnpm lint && pnpm check:alp && pnpm codegen:check && pnpm test` | All exit 0 | ✓ PASS |

### Human Verification Required

#### 1. Live GitHub Actions CI matrix

**Test:** Add a GitHub remote, push a branch, and confirm all four matrix legs (ubuntu-latest + windows-latest x Node 22.12.0 + 24) pass every step.
**Expected:** All four legs pass install, build, typecheck, lint, check:alp, codegen:check, test.
**Why human:** No git remote exists in this environment; the workflow's static shape is fully verified but a live multi-runner execution cannot be observed here. VALIDATION.md explicitly lists this as a manual-only row for FND-02.

#### 2. ALP.md prose completeness and clarity

**Test:** Read `spec/ALP.md` end to end as a newcomer with no prior exposure to the TypeScript implementation. Confirm the eleven states and transitions, seven actors (agent never one), three auth modes, teardown order, receipts, trust model and four trust limits are all genuinely learnable from the prose alone, and that Section 5's prose is sufficient to independently reproduce the content hash and signature check.
**Expected:** The document reads as coherent, complete and correct to a first-time reader; the described procedure matches the shipped implementation exactly (all structural facts already machine-verified; only readability/correctness-of-explanation is open).
**Why human:** `scripts/check-alp-sections.mjs` can only test structural presence (headings, tables, phrase occurrence, diagram counts) — it cannot judge whether the writing is actually clear, unambiguous or pedagogically sound. This is explicitly flagged as an open item in both 01-04-SUMMARY.md and 01-05-SUMMARY.md, deferred to end-of-phase human review per VALIDATION.md's manual-only row for SPEC-01.

### Gaps Summary

No gaps. Every must-have truth, artifact and key link from all five plans' frontmatter, and every ROADMAP.md Phase 1 Success Criterion, is verified present, substantive and wired, with independent re-execution (not just re-reading SUMMARY.md claims) of the full build/test/typecheck/lint/check:alp/codegen:check pipeline, a fresh clone, an engine-strict install, a fresh sha256sum hash reproduction, and six ALP.md checker negative-direction mutations. The only open items are the two human-only checks explicitly anticipated by this phase's own VALIDATION.md (live CI execution requiring a git remote that does not yet exist, and prose-quality judgment that no script can make) — both are routed to human_verification rather than treated as failures, per the task's explicit instruction.

---

*Verified: 2026-09-27T16:20:00Z*
*Verifier: Claude (gsd-verifier)*
