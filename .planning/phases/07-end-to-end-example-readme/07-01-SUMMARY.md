---
phase: 07-end-to-end-example-readme
plan: 01
subsystem: infra
tags: [pnpm-workspace, tsdown, vitest, tsc-references, eslint, github-actions]
requires:
  - phase: 06-cli-reference-adapters
    provides: "@stint/cli, @stint/proxy, @stint/core, @stint/spec workspace packages the example depends on"
provides:
  - "@stint/example-payment-reconciler workspace package (examples/payment-reconciler) that builds and runs one green test via its own vitest project"
  - "examples/* pnpm workspace importer with regenerated pnpm-lock.yaml (frozen-lockfile safe)"
  - "Root scripts test:e2e and example:payment-reconciler; dedicated CI pnpm test:e2e step"
affects: [07-02, 07-03, 07-04, 07-05, 07-06, 07-07, 07-08, 07-09]
estimate:
  tokens: 44000
  tasks: 2
  confidence: low
actuals:
  tokens: 4500
  tasks: 2
  commits: 2
plan_head_before: a79ff9b0ee477f5b0531f0ef351b34ad641f2e79
commits: 2
tech-stack:
  added: []
  patterns:
    - "Example e2e is a separate vitest project run via pnpm test:e2e; root vitest projects stays packages/* only (D-04)"
key-files:
  created:
    - examples/payment-reconciler/package.json
    - examples/payment-reconciler/tsconfig.json
    - examples/payment-reconciler/tsdown.config.ts
    - examples/payment-reconciler/vitest.config.ts
    - examples/payment-reconciler/src/index.ts
    - examples/payment-reconciler/test/skeleton.test.ts
  modified:
    - pnpm-workspace.yaml
    - pnpm-lock.yaml
    - tsconfig.json
    - eslint.config.js
    - package.json
    - .github/workflows/ci.yml
key-decisions:
  - "Root vitest.config.ts left unchanged (projects: packages/*) so units and e2e stay separate and the whole-repo run does not OOM (D-04)."
  - "All third-party deps pinned exactly to versions already in the lockfile; no new packages introduced."
requirements-completed: [E2E-01, E2E-02, DOC-01]
status: complete
---

# Phase 7 Plan 1: Example Package Skeleton Summary

**`@stint/example-payment-reconciler` workspace package with regenerated lockfile, tsc composite reference, eslint coverage, and a dedicated `pnpm test:e2e` CI step, proven by one green skeleton test.**

## Accomplishments
- Task 1 (tracer): created the package (package.json, tsconfig, tsdown, vitest configs, `src/index.ts` exporting `PACKAGE_NAME`, `test/skeleton.test.ts`), added `examples/*` to `pnpm-workspace.yaml`, regenerated `pnpm-lock.yaml` (importer `examples/payment-reconciler`). `pnpm install --frozen-lockfile` passes, `pnpm build` emits the package, and the filtered vitest run is green.
- Task 2: added the composite reference in root `tsconfig.json`, extended both eslint `allowDefaultProject` / `disableTypeChecked` lists to `examples/*/{tsdown,vitest}.config.ts`, added root scripts `test:e2e` and `example:payment-reconciler`, and a `pnpm test:e2e` step after `pnpm test` in CI.
- Tracer gate: `<verify>` passed end-to-end (install, build, vitest) and was re-run after Task 2 (`pnpm build`, `pnpm typecheck`, scoped eslint, `pnpm test:e2e` all green).

## Task Commits
1. Task 1: `e3c72de` feat(07-01): scaffold payment-reconciler example package with workspace importer
2. Task 2: `830837c` chore(07-01): wire example into tsc refs, eslint, root scripts and CI e2e step

## Deviations from Plan
None - plan executed exactly as written.

Notes: `start` script (`node dist/quickstart.js`) points at a bin that plan 07 adds, as the plan specified. `prettier --check` flags `eslint.config.js` (a pre-existing long-line formatting drift at HEAD, unrelated to this change; CI does not run format:check) and reports CRLF warnings on working-copy files only (git normalizes to LF).

## Known Stubs
None.

## Threat Flags
None. No new network/auth/file surface; T-07-LOCKDRIFT mitigated (lockfile regenerated and committed, frozen-lockfile verified), T-07-E2ESEP mitigated (root vitest projects unchanged).

## Self-Check: PASSED
- examples/payment-reconciler/{package.json,tsconfig.json,tsdown.config.ts,vitest.config.ts,src/index.ts,test/skeleton.test.ts} present; commits e3c72de and 830837c present.
