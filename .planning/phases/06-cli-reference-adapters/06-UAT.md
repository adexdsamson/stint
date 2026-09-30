---
status: testing
phase: 06-cli-reference-adapters
source: [06-VERIFICATION.md]
started: 2026-09-30
updated: 2026-09-30
---

## Current Test

number: 1
name: Real-terminal consent + run approval prompts (Windows console / POSIX tty)
expected: |
  Consent summary renders readably; countdown redraws; y grants/approves,
  n/blank declines/denies, and an unanswered approval is denied after
  approvals.timeout_seconds. The MCP stdout stream is not corrupted by prompt output.
awaiting: user response

## Tests

### 1. Real-terminal consent + run approval prompts (Windows console / POSIX tty)
expected: On a real Windows console (and ideally a POSIX tty), run `stint create <signed manifest>` and answer y, n, and no answer; then run `stint run <id> --profile ... --credentials ...` from an MCP host and trigger an approval-gated call, answering y, n, and leaving it unanswered. Consent summary renders readably; the countdown redraws; y grants/approves, n/blank declines/denies, and an unanswered approval is denied after approvals.timeout_seconds. The MCP stdout stream is not corrupted by prompt output. (why human: openControllingTerminal — CONIN$/CONOUT$ or /dev/tty — and the live readline countdown were only exercised through injected seams / fake streams per assumption A1 in terminal.ts; a real console cannot be driven by automated tests.)
result: [pending]

## Summary

total: 1
passed: 0
issues: 0
pending: 1
skipped: 0
blocked: 0

## Gaps
