---
status: testing
phase: 01-foundation-alp-spec
source: [01-VERIFICATION.md]
started: 2026-09-27T15:20:16Z
updated: 2026-09-27T15:20:16Z
---

## Current Test

number: 1
name: Live GitHub Actions CI matrix (ubuntu + windows x Node 22.12.0 + 24)
expected: |
  After adding a git remote and pushing a branch, all four CI matrix legs pass every step
  (install --frozen-lockfile, build, typecheck, lint, check:alp, codegen:check, test) green on
  GitHub-hosted Linux and Windows runners.
awaiting: user response

## Tests

### 1. Live GitHub Actions CI matrix
expected: All four legs (ubuntu-latest + windows-latest x Node 22.12.0 + 24) go green on GitHub-hosted runners. Requires a remote — none exists yet, so this is deferred to a real push.
result: [pending]

### 2. spec/ALP.md newcomer read-through (SPEC-01 prose quality)
expected: A reader with no prior exposure to the TypeScript implementation can learn the complete protocol from spec/ALP.md alone — all eleven lease states and transitions, the seven actors (agent never one), the three auth modes, the teardown order, the receipt model, the trust model, and the four trust limits — and can reproduce jcs-sha256:32de102e74d3141a3770c679871dae312691fb3ba522d3f3594f24489c6c704a from Section 4/5 prose alone.
result: [pending]

## Summary

total: 2
passed: 0
issues: 0
pending: 2
skipped: 0
blocked: 0

## Gaps
