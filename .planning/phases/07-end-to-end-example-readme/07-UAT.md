---
status: complete
phase: 07-end-to-end-example-readme
source: [07-VERIFICATION.md]
started: 2026-09-30T00:00:00Z
updated: 2026-09-30T00:00:00Z
---

## Current Test

number: 1
name: Real-console approval prompt (HOST-02 / D-08)
expected: |
  On a live Windows console (and a POSIX tty): the approval prompt is visible in the same
  console; answering `y` approves the call; `n` denies it (`denied: user_denied`); letting it
  time out denies by timeout. The consent prompt also renders visibly.
awaiting: none

## Tests

### 1. Real-console approval prompt (HOST-02 / D-08)
expected: On a live Windows console, run `packages/cli/manual/mcp-call-visible.mjs` per `packages/cli/manual/README.md`, plus the quickstart. The prompt is visible in the same console; `y` approves, `n` denies (`denied: user_denied`), no answer denies by timeout (`denied: timeout`).
result: passed
evidence: |
  Verified on Windows 11 PowerShell console (2026-09-30).
  - Quickstart (`pnpm example:payment-reconciler`): the consent prompt rendered visibly with a live
    countdown and accepted `y`; the lease activated and ran to `cleaned_up`. The irreversible write's
    approval prompt was visible; the timeout case denied correctly.
  - `mcp-call-visible.mjs` (dedicated y/n/timeout, lease 600dd20c):
      * `y`  -> approval granted; the call proceeded to execution (then failed downstream only because
                this bare fixture targets a non-existent test host — NOT a denial). Distinct from the
                denied outcomes below, which is the proof the `y` was accepted.
      * `n`  -> `denied: user_denied`.
      * (no answer, ~15s) -> `denied: timeout`.
    All runs: prompt visible in the same console, `protocol stream errors: []`, `secret leaked: false`.
  The Phase-6 hidden-console finding (every approval times out with no chance to answer) is resolved.

## Summary

total: 1
passed: 1
issues: 0
pending: 0
skipped: 0
blocked: 0

## Gaps
