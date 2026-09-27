---
phase: 01-foundation-alp-spec
verified: 2026-09-27T17:50:00Z
status: passed
score: 9/9 must-haves verified (requirement-level); 0 behavior-unverified
covered_files: [".claude/CLAUDE.md", ".gitattributes", ".github/workflows/ci.yml", ".planning/PROJECT.md", ".planning/REQUIREMENTS.md", ".planning/phases/01-foundation-alp-spec/01-01-PLAN.md", ".planning/phases/01-foundation-alp-spec/01-01-SUMMARY.md", ".planning/phases/01-foundation-alp-spec/01-02-PLAN.md", ".planning/phases/01-foundation-alp-spec/01-02-SUMMARY.md", ".planning/phases/01-foundation-alp-spec/01-03-PLAN.md", ".planning/phases/01-foundation-alp-spec/01-03-SUMMARY.md", ".planning/phases/01-foundation-alp-spec/01-04-PLAN.md", ".planning/phases/01-foundation-alp-spec/01-04-SUMMARY.md", ".planning/phases/01-foundation-alp-spec/01-05-PLAN.md", ".planning/phases/01-foundation-alp-spec/01-05-SUMMARY.md", ".planning/phases/01-foundation-alp-spec/01-UAT.md", "LICENSE", "package.json", "packages/spec/scripts/codegen.mjs", "packages/spec/src/canonical.ts", "packages/spec/src/envelope.ts", "packages/spec/src/errors.ts", "packages/spec/src/index.ts", "packages/spec/src/jws.ts", "packages/spec/src/testing.ts", "packages/spec/src/validate.ts", "pnpm-workspace.yaml", "scripts/check-alp-sections.mjs", "spec/ALP.md", "spec/envelope.schema.json", "spec/manifest.schema.json", "spec/vectors/README.md"]
covered_digest: "v1:sha256:43043e9cbd19c40a294cd966a8555547904060876f9bb92dff1cf31cfd1782de"
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: human_needed
  previous_score: "9/9 (structural); 2 items deferred to human_verification"
  gaps_closed:
    - "Live GitHub Actions CI matrix (all four legs green) — previously deferred (no git remote existed in that environment); fix commit c349a27 raised the Node floor to 22.18.0 after CI run 36331618619 found both Node 22.12.0 legs failing `pnpm install --frozen-lockfile` (ERR_PNPM_UNSUPPORTED_ENGINE from @babel/*@8.0.6 + ast-kit@3.0.0 under engineStrict). Re-run 36334019190 on main is fully green across all four legs. Independently re-confirmed in this session via `gh run view 36334019190` (not just trusting UAT/SUMMARY narrative) — headSha exactly matches current HEAD c349a27, conclusion success, all four jobs (windows-latest/24, windows-latest/22.18.0, ubuntu-latest/24, ubuntu-latest/22.18.0) show ✓."
    - "spec/ALP.md newcomer read-through / prose quality (SPEC-01) — resolved via human UAT (01-UAT.md Test 2: result pass). No further verifier action needed; recorded as human-attested, not re-litigated."
  gaps_remaining: []
  regressions: []
gaps: []
---

# Phase 1: Foundation & ALP Spec Verification Report

**Phase Goal:** Developers have a green, cross-platform monorepo; readers can learn the whole protocol from one normative document; publishers can author manifests that are validated, typed, hashed and signature-checked.
**Verified:** 2026-09-27T17:50:00Z
**Status:** passed
**Re-verification:** Yes — after gap closure (fix commit c349a27 + UAT resolution of both prior human_needed items)

## What Changed Since the Prior Verification

The prior `01-VERIFICATION.md` (initial run) returned `status: human_needed` with two items neither of which was a code defect at the time — both were verification-environment limitations (no git remote; prose-quality judgment). Since then:

1. **CI defect found and fixed.** Running the human-check surfaced a *real* bug: the declared Node floor (22.12.0) does not actually install under `engineStrict: true`, because the resolved dependency tree (`@babel/helper-validator-identifier@8.0.6` via `json-schema-to-typescript`, `ast-kit@3.0.0`) requires `^22.18.0 || >=24.11.0`. CI run `36331618619` failed both Node 22.12.0 legs at `pnpm install --frozen-lockfile` with `ERR_PNPM_UNSUPPORTED_ENGINE`. Fix commit `c349a27` raised the floor to 22.18.0 in `.github/workflows/ci.yml`, `package.json` engines, `.claude/CLAUDE.md`, and `.planning/PROJECT.md`, and recorded the gap (`G-01-1`) as resolved in `01-UAT.md`.
2. **Both human_needed items closed.** Live CI (Test 1) and ALP.md prose read-through (Test 2) both now show `result: pass` in `01-UAT.md`.

This report independently re-verifies both closures rather than trusting the UAT/SUMMARY narrative at face value (see below), and re-runs the entire automated pipeline against the current tree (HEAD `c349a27`).

## Goal Achievement

### Observable Truths (mapped to ROADMAP.md Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1a | On a fresh clone, `pnpm install && pnpm test` builds and tests every `@stint/*` package green on Node 22.18+ | ✓ VERIFIED | Re-ran in place (current worktree, HEAD c349a27): `npx pnpm@12.6.0 install --frozen-lockfile` → exit 0 ("Lockfile is up to date"); `pnpm build` → all four packages (spec, core, proxy, cli) built via tsdown, exit 0; `pnpm test` → 13 test files, 86 tests passed. |
| 1b | CI runs typecheck, lint and tests on Linux and Windows for every push (static shape) | ✓ VERIFIED | `.github/workflows/ci.yml` matrix is now `os: [ubuntu-latest, windows-latest]` x `node: ["22.18.0", "24"]` (raised from 22.12.0 by c349a27); steps in order: checkout, pnpm/action-setup, setup-node, `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm check:alp`, `pnpm codegen:check`, `pnpm test`; triggers on `push`/`pull_request` with no branch filter. |
| **1b-live** | **CI actually runs green on GitHub-hosted Linux and Windows runners** | **✓ VERIFIED (previously human_needed, now closed)** | Independently re-confirmed via `gh run view 36334019190 --repo adexdsamson/stint`: all four jobs report ✓ — `test (windows-latest, 24)`, `test (windows-latest, 22.18.0)`, `test (ubuntu-latest, 24)`, `test (ubuntu-latest, 22.18.0)`. Cross-checked `gh run view 36334019190 --json headSha,conclusion,event` → `{"conclusion":"success","event":"push","headSha":"c349a27da3478f541ac493df1e679feca4c0a617"}` — the headSha matches this worktree's current HEAD exactly, so the green run corresponds to the tree under verification, not a stale commit. This is machine-observed evidence (not a trusted human claim). |
| 1c | Repo is licensed Apache-2.0 | ✓ VERIFIED | Root `LICENSE` present; all four `package.json` files (`spec`, `core`, `proxy`, `cli`) declare `"license": "Apache-2.0"` and `"name": "@stint/<dir>"`; `packages/spec/test/license.test.ts` asserts this and passes (part of the 86 green tests). |
| **2 (structure)** | A reader can learn the full protocol from `spec/ALP.md`: all eleven states/transitions, actor list (agent never ends/extends), three auth modes, teardown order, receipts, trust model, trust limits | ✓ VERIFIED | `pnpm check:alp` → "ALP check passed" (re-run against current tree). No content or code changes to `spec/ALP.md` since the prior initial verification (only `.claude/CLAUDE.md`/`.planning/PROJECT.md`/CI/package.json/UAT touched by c349a27) — structural facts unchanged. |
| **2 (prose quality)** | Prose is genuinely learnable by a first-time reader; Section 4/5 prose alone reproduces the golden hash | ✓ VERIFIED (previously human_needed, now closed via human UAT) | `01-UAT.md` Test 2 ("spec/ALP.md newcomer read-through (SPEC-01 prose quality)") records `result: pass` — a human reviewer performed the actual read-through and confirmed reproducibility of `jcs-sha256:32de102e74d3141a3770c679871dae312691fb3ba522d3f3594f24489c6c704a` from prose. This is a genuinely non-automatable judgment (readability/pedagogical soundness), correctly resolved by human UAT rather than by this verifier re-litigating it. Independently spot-checked the hash itself: `node -e "crypto.createHash('sha256').update(fs.readFileSync('spec/vectors/jcs/manifest-canonical.json')).digest('hex')"` → `32de102e74d3141a3770c679871dae312691fb3ba522d3f3594f24489c6c704a`, exact match. |
| 3 | A valid manifest passes the draft-07 schema; unknown scope/approval/verifier/auth-mode values are rejected with structured errors; `auth.delegated` accepts a list of grants; `auth.mode` defaults to `hybrid` | ✓ VERIFIED | `spec/manifest.schema.json` draft-07; full 86-test suite green includes `validate.test.ts` and vectors tests (18 invalid + 5 valid). No changes to this area since prior verification; re-confirmed by the full green test run. |
| 4 | A developer imports TS types generated from the schema through `@stint/spec`, and changing the schema without regenerating fails the build | ✓ VERIFIED | `pnpm codegen:check` → exit 0 (re-run against current tree, `node scripts/codegen.mjs --check` reports no drift). `packages/spec/src/generated/manifest.ts` exports `Manifest`; `pnpm typecheck` (`tsc -b`) → exit 0. |
| 5 | The runtime computes the same jcs-sha256 hash regardless of key order/whitespace, and rejects an unverified publisher signature before consent | ✓ VERIFIED | `canonical.test.ts` golden-hash tests pass (part of the 86-test green run); independently reproduced the golden hash via a standalone `node -e` SHA-256 computation over the committed vector file, matching byte for byte. |

**Score:** 9/9 roadmap-level truths verified. Both items previously routed to human verification are now closed: one by machine-observed evidence (live CI run, independently queried via `gh`, matched to current HEAD by SHA) and one by completed human UAT (prose read-through). No remaining human verification items.

### Required Artifacts (Delta Check)

Full artifact inventory was exhaustively verified in the initial (prior) VERIFICATION.md pass and no artifact paths changed except the following, re-checked directly:

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `.github/workflows/ci.yml` | Matrix floor 22.18.0 (not 22.12.0), Linux+Windows | ✓ VERIFIED | `node: ["22.18.0", "24"]` confirmed present; diff against pre-fix version shows only this line changed. |
| `package.json` | `engines.node` >=22.18.0 | ✓ VERIFIED | `"engines": { "node": ">=22.18.0" }` confirmed. |
| `.claude/CLAUDE.md` / `.planning/PROJECT.md` | Floor statements consistent at 22.18+ | ✓ VERIFIED | Both files state "Node 22.18+" with the `@babel/*`/`ast-kit` rationale; `.planning/PROJECT.md`'s decision log records "Node 22.18+ floor (was 22.12+, was 20+) ... — Applied". |
| `.planning/phases/01-foundation-alp-spec/01-UAT.md` | Both tests recorded pass, gap G-01-1 resolved | ✓ VERIFIED | Both tests show `result: pass`; gap entry has `status: resolved`, `resolved_at: 2026-09-27`, citing CI run 36334019190. |
| All other artifacts from initial verification (packages/spec/*, spec/*.schema.json, spec/ALP.md, scripts/check-alp-sections.mjs, spec/vectors/*) | Unchanged | ✓ VERIFIED (regression) | No git diff against these paths since the initial verification; full test/build/lint/typecheck/check:alp/codegen:check pipeline re-run green confirms no regression. |

### Key Link Verification (Delta Check)

| From | To | Via | Status | Details |
|------|----|----|--------|---------|
| `.github/workflows/ci.yml` | `package.json` scripts | CI steps call build/typecheck/lint/check:alp/codegen:check/test | ✓ WIRED | Unchanged step list, all six script names present in documented order; live run 36334019190 confirms every step executed and passed on all four legs. |
| `package.json` engines | `pnpm-workspace.yaml` engineStrict | Install-time enforcement | ✓ WIRED | `engineStrict: true` + `engines.node >=22.18.0` together now correctly reject Node <22.18 at install time and correctly accept 22.18.0/24 — proven by the fixed CI legs going from failing to passing at the exact floor value. |

All other key links (codegen→schema, validate→generated schemas, envelope→canonical, checker→ALP.md/vectors) are unaffected by this fix commit — no source files under `packages/spec/src/`, `spec/ALP.md`, or `scripts/check-alp-sections.mjs` changed. Re-confirmed by the full green pipeline re-run (Behavioral Spot-Checks below).

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|--------------|-------------|-------------|--------|----------|
| FND-01 | 01-01 | Fresh clone + `pnpm install && pnpm test` green, Node 22.18+ | ✓ SATISFIED | Re-run in this session: install/build/typecheck/lint/check:alp/codegen:check/test all exit 0, 86/86 tests pass. |
| FND-02 | 01-01 | CI runs typecheck/lint/tests on Linux+Windows for every push | ✓ SATISFIED | **Upgraded from "needs human" to fully satisfied**: workflow YAML verified + live 4-leg run independently confirmed via `gh run view 36334019190` (headSha matches current HEAD, conclusion success, all 4 jobs ✓). |
| FND-03 | 01-01 | Apache-2.0 license, `@stint/*` package names | ✓ SATISFIED | LICENSE + license.test.ts pass; unchanged since initial verification. |
| SPEC-01 | 01-04, 01-05 | Full protocol learnable from spec/ALP.md | ✓ SATISFIED | Structural checks pass (`pnpm check:alp`); **prose-quality half now satisfied via completed human UAT** (01-UAT.md Test 2: pass). |
| SPEC-02 | 01-02, 01-05 | Manifest validated against draft-07 schema | ✓ SATISFIED | Schema + validateManifest + vectors tests pass (unchanged, re-confirmed). |
| SPEC-03 | 01-02 | Fixed vocabularies rejected with structured errors | ✓ SATISFIED | Vectors/validate tests pass (unchanged, re-confirmed). |
| SPEC-04 | 01-02, 01-03 | auth.delegated list, auth.mode defaults hybrid | ✓ SATISFIED | Tests pass (unchanged, re-confirmed). |
| SPEC-05 | 01-02 | Generated types + codegen:check drift gate | ✓ SATISFIED | `codegen:check` exit 0 against current tree (unchanged, re-confirmed). |
| SPEC-06 | 01-03, 01-05 | Canonical content hash + signature verification before consent | ✓ SATISFIED | Golden hash independently reproduced via standalone SHA-256 computation, exact match (unchanged, re-confirmed). |

No orphaned requirements: all 9 IDs the ROADMAP maps to Phase 1 appear in exactly one plan's `requirements:` frontmatter each.

Note: `.planning/REQUIREMENTS.md`'s own status column (lines 122-130) still reads "Pending" for all nine IDs — this is a bookkeeping field owned by the orchestrator/roadmap workflow, not by this verifier, and does not reflect this report's findings. Flagged here for the orchestrator to update, not treated as a gap.

### Anti-Patterns Found

None. Re-scanned every file touched by the fix commit (`.github/workflows/ci.yml`, `package.json`, `.claude/CLAUDE.md`, `.planning/PROJECT.md`) for `TBD|FIXME|XXX|TODO|HACK|PLACEHOLDER` — no matches. All other covered files were exhaustively scanned in the initial verification pass with no findings, and are unchanged since (confirmed via the passing full-pipeline re-run, which would fail on any regression in `packages/spec/src/*`).

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Frozen-lockfile install at current floor | `npx pnpm@12.6.0 install --frozen-lockfile` | Exit 0, "Lockfile is up to date" | ✓ PASS |
| Full monorepo build | `npx pnpm@12.6.0 build` | All 4 packages built via tsdown, exit 0 | ✓ PASS |
| Typecheck | `npx pnpm@12.6.0 typecheck` (`tsc -b`) | Exit 0 | ✓ PASS |
| Lint | `npx pnpm@12.6.0 lint` (`eslint .`) | Exit 0, no output | ✓ PASS |
| ALP.md structural checker | `npx pnpm@12.6.0 check:alp` | "ALP check passed" | ✓ PASS |
| Codegen drift gate | `npx pnpm@12.6.0 codegen:check` | Exit 0, no drift reported | ✓ PASS |
| Full test suite | `npx pnpm@12.6.0 test` | 13 test files, 86 tests passed | ✓ PASS |
| Golden hash independent reproduction | `node -e` standalone SHA-256 over `spec/vectors/jcs/manifest-canonical.json` | `32de102e74d3141a3770c679871dae312691fb3ba522d3f3594f24489c6c704a` (exact match to committed value) | ✓ PASS |
| Live CI status (not trusting narrative) | `gh run view 36334019190 --repo adexdsamson/stint --json headSha,conclusion,event` | `{"conclusion":"success","event":"push","headSha":"c349a27..."}` — matches current HEAD | ✓ PASS |
| CI matrix floor value in source | `grep node: .github/workflows/ci.yml` | `node: ["22.18.0", "24"]` | ✓ PASS |
| `package.json` engines floor | `grep -A3 engines package.json` | `"node": ">=22.18.0"` | ✓ PASS |

### Human Verification Required

None. Both items from the prior verification are closed:

1. **Live CI matrix** — closed by machine-observed evidence in this session (`gh run view`, SHA-matched to current HEAD), not merely by trusting the UAT claim.
2. **ALP.md prose read-through** — closed by completed human UAT (`01-UAT.md` Test 2, `result: pass`), which is the correct and only valid way to close a genuinely non-automatable judgment call. This verifier does not re-litigate a completed human judgment.

### Gaps Summary

No gaps. All 9 requirement IDs (FND-01/02/03, SPEC-01 through SPEC-06) satisfied, all roadmap Success Criteria verified, full automated pipeline (install, build, typecheck, lint, check:alp, codegen:check, test) green on the current tree (HEAD `c349a27`), and the one real defect this phase's own human-verification step surfaced (Node floor mismatch, gap G-01-1) has been fixed and independently re-confirmed via a live, SHA-matched GitHub Actions run — not merely accepted on SUMMARY/UAT narrative. Phase goal achieved. Ready to proceed.

---

*Verified: 2026-09-27T17:50:00Z*
*Verifier: Claude (gsd-verifier)*
