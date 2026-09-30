---
status: testing
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
  console; answering `y` approves the irreversible write; `n` denies it (`denied: user_denied`);
  letting it time out denies by timeout. The quickstart's consent prompt also renders visibly.
awaiting: user response

## Tests

### 1. Real-console approval prompt (HOST-02 / D-08)
expected: On a live Windows console and a POSIX tty, run `packages/cli/manual/mcp-call-visible.mjs` per `packages/cli/manual/README.md`, then run `pnpm example:payment-reconciler` from a real terminal. The prompt is visible in the same console; `y` approves the write, `n` denies it (`denied: user_denied`), and no answer denies by timeout. The quickstart's consent prompt also renders.
result: [pending]

## Summary

total: 1
passed: 0
issues: 0
pending: 1
skipped: 0
blocked: 0

## Gaps
