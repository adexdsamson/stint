---
status: testing
phase: 01-foundation-alp-spec
source: [01-VERIFICATION.md]
started: 2026-09-27T15:20:16Z
updated: 2026-09-27T16:05:00Z
---

## Current Test

[testing complete]

## Tests

### 1. Live GitHub Actions CI matrix
expected: All four legs (ubuntu-latest + windows-latest x Node 22.12.0 + 24) go green on GitHub-hosted runners.
result: issue
reported: "Merged to main and pushed (origin 88bd30c); CI run 36331618619 ran. 2 of 4 legs failed: test(ubuntu-latest,22.12.0) and test(windows-latest,22.12.0) both fail at `pnpm install --frozen-lockfile` with ERR_PNPM_UNSUPPORTED_ENGINE — @babel/helper-validator-identifier@8.0.6 (transitive via json-schema-to-typescript) wants node ^22.18.0 || >=24.11.0 but the matrix floor is 22.12.0, and engineStrict is on. Node 24 legs (ubuntu + windows) pass all steps."
severity: major

### 2. spec/ALP.md newcomer read-through (SPEC-01 prose quality)
expected: A reader with no prior exposure to the TypeScript implementation can learn the complete protocol from spec/ALP.md alone — all eleven lease states and transitions, the seven actors (agent never one), the three auth modes, the teardown order, the receipt model, the trust model, and the four trust limits — and can reproduce jcs-sha256:32de102e74d3141a3770c679871dae312691fb3ba522d3f3594f24489c6c704a from Section 4/5 prose alone.
result: pass

## Summary

total: 2
passed: 1
issues: 1
pending: 0
skipped: 0
blocked: 0

## Gaps

- gap_id: G-01-1
  truth: "The declared Node floor installs and runs green in CI on both ubuntu-latest and windows-latest"
  status: resolved
  resolved_by: "inline fix — raised Node floor 22.12.0 -> 22.18.0 (CI matrix, package.json engines, CLAUDE.md, PROJECT.md); frozen-lockfile install re-verified locally; pending live CI confirmation on push"
  resolved_at: 2026-09-27
  reason: "CI run 36331618619: pnpm install --frozen-lockfile fails with ERR_PNPM_UNSUPPORTED_ENGINE on both Node 22.12.0 legs. Transitive dep @babel/helper-validator-identifier@8.0.6 (via json-schema-to-typescript) requires node ^22.18.0 || >=24.11.0; engineStrict:true makes this a hard install error. Node 24 legs pass."
  severity: major
  test: 1
  artifacts:
    - path: ".github/workflows/ci.yml"
      issue: "matrix pins node 22.12.0, which no longer satisfies the resolved dependency tree"
    - path: "package.json"
      issue: "engines.node >=22.12.0 is below the effective floor forced by @babel/helper-validator-identifier@8.0.6 (22.18.0)"
    - path: "pnpm-workspace.yaml"
      issue: "engineStrict:true turns the unsupported-engine warning into a frozen-lockfile install failure"
    - path: ".claude/CLAUDE.md"
      issue: "documents Node 22.12+ as the floor; the real floor is now 22.18.0"
  missing:
    - "Decide the real Node floor (raise to 22.18.0) OR pin @babel/helper-validator-identifier to a 22.12-compatible version via pnpm overrides, then regenerate the lockfile"
    - "Update CI matrix, package.json engines, and CLAUDE.md/PROJECT.md to the chosen floor consistently"
