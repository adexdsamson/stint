---
phase: 01-foundation-alp-spec
plan: 01
subsystem: infra
tags: [pnpm, tsdown, vitest, eslint, typescript-eslint, tsc-project-references, apache-2.0, github-actions]

requires: []
provides:
  - "Green pnpm monorepo: package.json (packageManager pnpm@12.6.0, engines >=22.12.0, ESM), pnpm-workspace.yaml (strictDepBuilds, engineStrict, allowBuilds map)"
  - "Four buildable @stint/* packages (spec, core, proxy, cli) with tsdown builds, tsc -b project references, and one Vitest smoke test each"
  - "@stint/spec exports SPEC_VERSION = \"alp/0.1\"; the D-26 workspace dependency graph (spec <- core <- proxy, cli <- core+proxy) proven end to end by real cross-package imports"
  - "Apache-2.0 LICENSE plus packages/spec/test/license.test.ts enumerating packages/* from disk"
  - ".gitattributes LF normalization and a GitHub Actions CI workflow (ubuntu-latest + windows-latest x Node 22.12.0 + 24)"
affects: [02-pure-core-and-hostadapter, 03-receipts-and-licensing, 04-proxy-runtime, 05-teardown-and-verification, 06-cli-and-reference-hosts]

actuals:
  tokens: 26797
  raw_tokens: 26797
  tasks: 2
  commits: 2

tech-stack:
  added:
    - "pnpm@12.6.0 (workspace/monorepo package manager, invoked via `npx pnpm@12.6.0` — see Decisions)"
    - "typescript@5.9.3 with composite project references (tsc -b)"
    - "tsdown@0.21.10 (rolldown-based bundler for each package's dist/)"
    - "vitest@5.0.2 with vite@8.3.1 peer, test.projects (not vitest.workspace.ts)"
    - "eslint@9.39.5 flat config + @eslint/js@9.39.5 + typescript-eslint@8.70.1 (strictTypeChecked)"
    - "prettier@3.9.9 (formatting only, not a CI gate yet)"
  patterns:
    - "Every package is ESM (\"type\": \"module\"), tsdown config sets platform: \"node\" and fixedExtension: false so build output stays .js/.d.ts (matching the package.json exports map) instead of tsdown's platform:\"node\" default of .mjs/.d.mts"
    - "Each package tsconfig.json extends ../../tsconfig.base.json, composite: true, rootDir \".\", outDir \".tsc\" (gitignored, kept apart from tsdown's dist/), include [\"src\",\"test\"]"
    - "Root test script is `pnpm build && vitest run`; CI runs build before typecheck/lint so cross-package types resolve through dist/ declarations"
    - "eslint.config.js gives vitest.config.ts / packages/*/tsdown.config.ts (only reachable via projectService allowDefaultProject) a second, later config block applying tseslint.configs.disableTypeChecked, because the synthesized default-project program has no strictNullChecks and several strictTypeChecked rules error out otherwise"

key-files:
  created:
    - package.json
    - pnpm-workspace.yaml
    - pnpm-lock.yaml
    - .gitignore
    - .gitattributes
    - .prettierrc.json
    - .prettierignore
    - tsconfig.base.json
    - tsconfig.json
    - vitest.config.ts
    - eslint.config.js
    - LICENSE
    - .github/workflows/ci.yml
    - packages/spec/package.json
    - packages/spec/tsconfig.json
    - packages/spec/tsdown.config.ts
    - packages/spec/src/index.ts
    - packages/spec/test/smoke.test.ts
    - packages/spec/test/license.test.ts
    - packages/core/package.json
    - packages/core/tsconfig.json
    - packages/core/tsdown.config.ts
    - packages/core/src/index.ts
    - packages/core/test/smoke.test.ts
    - packages/proxy/package.json
    - packages/proxy/tsconfig.json
    - packages/proxy/tsdown.config.ts
    - packages/proxy/src/index.ts
    - packages/proxy/test/smoke.test.ts
    - packages/cli/package.json
    - packages/cli/tsconfig.json
    - packages/cli/tsdown.config.ts
    - packages/cli/src/index.ts
    - packages/cli/test/smoke.test.ts
  modified: []

key-decisions:
  - "Package-legitimacy checkpoint (Task 1) approved verbatim: pnpm@12.6.0, typescript@5.9.3, vitest@5.0.2, vite@8.3.1, tsdown@0.21.10, eslint@9.39.5, @eslint/js@9.39.5, typescript-eslint@8.70.1, prettier@3.9.9, @types/node@22.20.4, ajv@8.20.0, ajv-formats@3.0.1, json-schema-to-typescript@16.0.0, jose@6.2.12, canonicalize@5.1.0. Only pnpm itself has pre/postinstall scripts (its own binary bootstrap); every repo/maintainer matched the upstream project; typescript-eslint 10.11.0 from CLAUDE.md's research table does not exist on the registry, 8.70.1 is the correct pin. This exact set is what plans 01-02 and 01-03 must install."
  - "pnpm invocation: local Node is v26.8.2, global pnpm is 10.34.5, no corepack (dropped in Node 26). Writing packageManager: pnpm@12.6.0 to package.json did NOT trigger a working self-switch — `pnpm --version` inside the repo failed with `ENOENT` against a partially-materialized `.tools/pnpm/12.6.0` symlink target (repeated across 4 separate download attempts, none completing successfully in this sandboxed Windows/Git-Bash environment). Fell back to the pre-approved path: every workspace command in this plan was run as `npx --yes pnpm@12.6.0 <cmd>`, which resolved and ran pnpm 12.6.0 correctly every time. No global install was performed."
  - "tsdown's `platform: \"node\"` defaults `fixedExtension` to `true`, which forces `.mjs`/`.d.mts` output — this collided with the plan's own exports map (`./dist/index.js` / `./dist/index.d.ts`) and broke @stint/core's import of @stint/spec at test time. Fixed by adding `fixedExtension: false` to every package's tsdown.config.ts, keeping `platform: \"node\"` as specified elsewhere in the plan."
  - "typescript-eslint 8.x's `disableTypeChecked` export is a single flat config object, not an array (unlike `strictTypeChecked`), so `.map(...)` over it threw `TypeError: ... is not a function`. Fixed eslint.config.js to spread it directly with a `files` filter instead of mapping."
  - "Added a second disableTypeChecked config block (after the projectService block) scoped to vitest.config.ts and packages/*/tsdown.config.ts specifically, because those files only exist in the eslint projectService's synthesized allowDefaultProject program, which lacks strictNullChecks — several strictTypeChecked rules (no-unnecessary-boolean-literal-compare, no-unnecessary-condition, no-useless-default-assignment) hard error without it."

requirements-completed: [FND-01, FND-02, FND-03]

coverage:
  - id: D1
    description: "Fresh clone + pnpm install && pnpm test builds every @stint/* package and passes every smoke test on Node 22.12+ (FND-01), in dependency order, with an engine-strict Node 22.12.0 floor"
    requirement: "FND-01"
    verification:
      - kind: integration
        ref: "fresh-clone: git clone + pnpm install --frozen-lockfile + pnpm test/typecheck/lint against the Task 3 commit"
        status: pass
      - kind: integration
        ref: "pnpm install --frozen-lockfile --config.node-version=22.12.0 --config.engine-strict=true"
        status: pass
      - kind: unit
        ref: "vitest run (5 test files, 9 tests) across packages/{spec,core,proxy,cli}"
        status: pass
    human_judgment: false
  - id: D2
    description: "CI runs install, build, typecheck, lint, codegen:check and test on ubuntu-latest and windows-latest for Node 22.12.0 and 24, with read-only permissions and build ordered before typecheck/lint (FND-02)"
    requirement: "FND-02"
    verification:
      - kind: other
        ref: "node one-liner asserting .github/workflows/ci.yml contains ubuntu-latest, windows-latest, 22.12.0, pnpm/action-setup@v6, actions/setup-node@v7, contents: read, and the full pnpm step sequence"
        status: pass
    human_judgment: true
    rationale: "The workflow's static shape is asserted above, but a live matrix run (4 legs: 2 OS x 2 Node versions actually executing on GitHub-hosted runners) cannot be proven locally — this repo has no remote yet. Plan text defers this to a human-check at end of phase once a remote exists (VALIDATION.md FND-02 manual-only row)."
  - id: D3
    description: "Apache-2.0 LICENSE and every @stint/* package.json (license + name) asserted by a disk-enumerating test (FND-03)"
    requirement: "FND-03"
    verification:
      - kind: unit
        ref: "packages/spec/test/license.test.ts (2 tests: LICENSE content, per-package license/name enumeration)"
        status: pass
    human_judgment: false

duration: 28min
completed: 2026-09-27
status: complete
---

# Phase 1 Plan 1: Foundation pnpm Monorepo Summary

**Four-package (@stint/spec, core, proxy, cli) pnpm/tsdown/Vitest/ESLint monorepo, Apache-2.0 licensed, with a Linux+Windows GitHub Actions CI matrix on Node 22.12.0 and 24 — proven end to end by a real cross-package import chain (spec -> core -> proxy -> cli).**

## Performance

- **Duration:** ~28 min (Tasks 2-3; Task 1's human-verify checkpoint and its approval wait are excluded)
- **Completed:** 2026-09-27
- **Tasks:** 2 (Task 1's package-legitimacy checkpoint was completed in a prior session — see Prior State)
- **Files created:** 33
- **Commits:** 2

## Accomplishments

- Root pnpm workspace (`package.json`, `pnpm-workspace.yaml` with `strictDepBuilds`/`engineStrict`/`allowBuilds`, `pnpm-lock.yaml`) targeting Node >=22.12.0, pnpm@12.6.0, ESM-only
- TypeScript composite project references (`tsconfig.base.json` + per-package `tsconfig.json`) wired through `tsc -b`, with each package's build output (`tsdown`) and typecheck output (`.tsc`, gitignored) kept separate
- `@stint/spec` exports `SPEC_VERSION = "alp/0.1"`; `@stint/core` re-exports it via `workspace:*` and adds `PACKAGE_NAME`; `@stint/proxy` and `@stint/cli` replicate the same shape, each importing one symbol from their declared upstream package, proving the full D-26 dependency graph (spec -> core -> proxy, cli -> core + proxy) through real imports, not stubs
- Root Vitest config (`test.projects`, no `vitest.workspace.ts`) runs all 5 test files (spec smoke + license, core/proxy/cli smoke) — 9 tests total, all passing
- Flat ESLint config with `typescript-eslint` `strictTypeChecked` for `.ts` files via `projectService`, and a narrower `disableTypeChecked` override for the two config files (`vitest.config.ts`, `packages/*/tsdown.config.ts`) that only exist via `allowDefaultProject`
- Apache-2.0 `LICENSE` plus `packages/spec/test/license.test.ts`, which enumerates `packages/*` from disk so a future package missing `license`/`name` fields fails the suite
- `.gitattributes` (`* text=auto eol=lf`) for byte-identical checkouts across OSes
- `.github/workflows/ci.yml`: push/pull_request triggers (no branch filter), `contents: read`, `ubuntu-latest` + `windows-latest` x Node `22.12.0`/`24` matrix, steps in the required order (checkout -> pnpm/action-setup -> setup-node -> install --frozen-lockfile -> build -> typecheck -> lint -> codegen:check -> test)
- Fresh-clone verification (`git clone` into a temp dir, `pnpm install --frozen-lockfile && pnpm test && pnpm typecheck && pnpm lint`) passes against the committed state
- Engine-strict install (`--config.node-version=22.12.0 --config.engine-strict=true`) passes — no dependency rejects the Node 22.12.0 floor

## Task Commits

Task 1 (package-legitimacy checkpoint) produced no commit — it is a `checkpoint:human-verify` gate only, approved by the human in the prior session (see Prior State below).

1. **Task 2: End-to-end workspace tracer (install, build, typecheck, lint, test through @stint/core -> @stint/spec)** - `b79d1a9` (feat)
2. **Task 3: Expand to all four packages, Apache-2.0 licensing, LF line endings, formatting config, CI matrix** - `2d8c874` (feat)

_No separate plan-metadata commit was made — this SUMMARY and STATE.md/ROADMAP.md updates are the orchestrator's responsibility per this run's instructions._

## Files Created/Modified

- `package.json` - root workspace manifest, scripts (build/typecheck/lint/test/codegen/codegen:check/format), exact devDependency pins
- `pnpm-workspace.yaml` - workspace globs, `strictDepBuilds: true`, `engineStrict: true`, empty `allowBuilds: {}` (no dependency reported an unreviewed build script)
- `pnpm-lock.yaml` - committed lockfile
- `.gitignore` / `.gitattributes` / `.prettierrc.json` / `.prettierignore` - hygiene and formatting config
- `tsconfig.base.json` / `tsconfig.json` - shared compiler options; root solution file referencing all four packages
- `vitest.config.ts` - `test.projects: ["packages/*"]`
- `eslint.config.js` - flat config, type-aware linting via `projectService`, with default-project override for config files
- `LICENSE` - Apache License 2.0 full text
- `.github/workflows/ci.yml` - CI matrix workflow
- `packages/{spec,core,proxy,cli}/{package.json,tsconfig.json,tsdown.config.ts,src/index.ts,test/smoke.test.ts}` - four packages, each building and testing independently and via the workspace root
- `packages/spec/test/license.test.ts` - FND-03 license/name assertions

## Decisions Made

See frontmatter `key-decisions` for full detail. Summary:
1. Task 1's approved package list is locked verbatim for plans 01-02/01-03.
2. `packageManager` self-switch did not work in this sandboxed environment (ENOENT against a partial `.tools/pnpm/12.6.0` install); every command instead ran via `npx --yes pnpm@12.6.0 <cmd>`, per the pre-approved fallback. No global pnpm install was performed.
3. `tsdown`'s `platform: "node"` default (`fixedExtension: true`) conflicted with the plan's `.js`/`.d.ts` exports map — fixed with an explicit `fixedExtension: false` in every package's `tsdown.config.ts`.
4. `typescript-eslint@8.70.1`'s `disableTypeChecked` is a single config object, not an array — fixed the `.map()` call in `eslint.config.js`.
5. Added an eslint override for `vitest.config.ts`/`packages/*/tsdown.config.ts` disabling type-aware rules, because `projectService`'s `allowDefaultProject` synthesizes a non-strict program for those files.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] tsdown output extension mismatch broke the @stint/core -> @stint/spec import**
- **Found during:** Task 2 (workspace tracer)
- **Issue:** With `platform: "node"` set (as the plan specifies), tsdown 0.21.10 defaults `fixedExtension` to `true`, emitting `dist/index.mjs` / `dist/index.d.mts`. The plan's package.json `exports` map (and the plan's own "Build and resolution model" context) declared `./dist/index.js` / `./dist/index.d.ts`. Vitest failed with "Failed to resolve entry for package @stint/spec."
- **Fix:** Added `fixedExtension: false` to every package's `tsdown.config.ts`, keeping `platform: "node"` and `format: "esm"` as specified. Output now matches the declared exports map exactly.
- **Files modified:** packages/{spec,core,proxy,cli}/tsdown.config.ts
- **Verification:** `pnpm test` (all 5 test files pass, including the cross-package import)
- **Committed in:** b79d1a9 (spec/core), 2d8c874 (proxy/cli)

**2. [Rule 3 - Blocking] `typescript-eslint`'s `disableTypeChecked` is not an array**
- **Found during:** Task 2 (workspace tracer, `pnpm lint`)
- **Issue:** `eslint.config.js` called `.map()` on `tseslint.configs.disableTypeChecked`, which in typescript-eslint 8.70.1 is a single flat config object (unlike `strictTypeChecked`, which is an array) — `.map is not a function`.
- **Fix:** Changed to `{ ...tseslint.configs.disableTypeChecked, files: [...] }`.
- **Files modified:** eslint.config.js
- **Verification:** `pnpm lint` runs without a config-loading TypeError
- **Committed in:** b79d1a9

**3. [Rule 1 - Bug] Type-aware ESLint rules hard-errored on config files under `allowDefaultProject`**
- **Found during:** Task 2 (workspace tracer, `pnpm lint`)
- **Issue:** `vitest.config.ts` and `packages/*/tsdown.config.ts` are only included via `projectService.allowDefaultProject`, whose synthesized default program does not enable `strictNullChecks`. Three `strictTypeChecked` rules (`no-unnecessary-boolean-literal-compare`, `no-unnecessary-condition`, `no-useless-default-assignment`) require it and errored on every such file.
- **Fix:** Added a second, later config block applying `tseslint.configs.disableTypeChecked` specifically to `vitest.config.ts` and `packages/*/tsdown.config.ts`.
- **Files modified:** eslint.config.js
- **Verification:** `pnpm lint` exits 0 with no errors
- **Committed in:** b79d1a9

---

**Total deviations:** 3 auto-fixed (3 Rule 1/3 blocking-issue/bug fixes, 0 Rule 2, 0 Rule 4)
**Impact on plan:** All three fixes were necessary to make the plan's own stated toolchain choices (tsdown `platform: "node"`, `.js`/`.d.ts` exports, typescript-eslint `strictTypeChecked`) actually work together on the exact pinned versions from Task 1. No scope creep — no additional packages, files, or behavior beyond what Tasks 2 and 3 specify.

## Issues Encountered

- `packageManager`-driven pnpm self-switch (`manage-package-manager-versions`) did not complete successfully in this sandboxed Windows/Git-Bash session across four attempts — the download step created working binaries in a temp directory (`.tools/pnpm/12.6.0_tmp_*`) but the symlink pnpm relies on (`.tools/pnpm/12.6.0 -> ...tmp_dir`) was not resolvable when pnpm's own Windows process tried to spawn it (`ENOENT`). Followed the pre-approved fallback (`npx --yes pnpm@12.6.0 <cmd>`) for every command in this plan; it worked reliably. No further action needed unless a later plan wants native `pnpm <cmd>` to work directly — that would require diagnosing the symlink resolution issue in this specific environment.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- The full toolchain path (install -> build -> typecheck -> lint -> test) is proven green on this machine, on a fresh clone, and against an engine-strict Node 22.12.0 floor. Plans 01-02 (ALP.md spec + codegen) and 01-03 build directly on this foundation and must install exactly the Task 1-approved package versions.
- **Blocker/concern carried forward:** FND-02's live CI matrix (4 legs actually running on GitHub-hosted `ubuntu-latest`/`windows-latest` runners) cannot be verified until this repo has a remote — plan text and VALIDATION.md both mark this as a manual-only check deferred to end of phase. The workflow YAML's static shape is fully asserted here; only the live run is outstanding.
- `pnpm <cmd>` (without the `npx` prefix) does not currently work standalone in this sandboxed dev environment due to the self-switch symlink issue above — future plans/sessions in this same environment should continue using `npx --yes pnpm@12.6.0 <cmd>` until/unless that's resolved, or should re-check `pnpm --version` first since it may work fine in CI or on a real Windows machine outside this sandbox.

---
*Phase: 01-foundation-alp-spec*
*Completed: 2026-09-27*

## Self-Check: PASSED

- All 34 `key-files.created` entries verified present on disk.
- Both task commits (`b79d1a9`, `2d8c874`) verified present in `git log --oneline --all`.
- Re-ran plan-level verification after self-check: `pnpm install`, `pnpm test` (5 test files, 9 tests passed), `pnpm typecheck`, `pnpm lint` all exit 0.
