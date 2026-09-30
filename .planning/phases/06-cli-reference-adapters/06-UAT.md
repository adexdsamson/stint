---
status: complete
phase: 06-cli-reference-adapters
source: [06-VERIFICATION.md]
started: 2026-09-30
updated: 2026-09-30
---

## Current Test

[testing complete]

## Tests

### 1. Real-terminal consent + run approval prompts (Windows console / POSIX tty)
expected: On a real Windows console, run `stint create <signed manifest>` and answer y, n, and no answer; then run `stint run <id>` from an MCP host and trigger an approval-gated call, answering y, n, and leaving it unanswered. Consent summary renders readably; the countdown redraws; y grants/approves, n/blank declines/denies, and an unanswered approval is denied after approvals.timeout_seconds. The MCP stdout stream is not corrupted by prompt output.
result: pass
verified: |
  Windows 11 console, Node 26.8.2 (via packages/cli/manual/ probe scripts).
  CONSENT (stint create, over process.stdin): consent view rendered all ALP §6 fields
  readably; countdown displayed and ticked (120s→111s→110s); `y` -> grant + active
  lease id; empty/non-`y` -> decline (deny-by-default). Confirmed `y` grants via
  probe-adapter.mjs ({"decision":"grant"}).
  RUN APPROVAL (stint run, over MCP stdio, controlling terminal): with a VISIBLE
  console spawn (windowsHide:false), the "Approval requested / Approve this action?
  [y/N]" prompt appeared on the controlling terminal; `y` -> call approved and
  dispatched (downstream returned "call failed" only because the reference profile
  binds identifier resources like sheets.orders with no real endpoint — a documented
  06-06 fixture limitation, Phase 7 maps identifiers→endpoints, NOT a gating defect);
  `n` -> denied: user_denied; no answer -> denied: timeout after approvals.timeout_seconds.
  Every run: protocol stream errors [] (stdout/JSON-RPC never corrupted by prompt),
  and no access token leaked into the tool result. CONIN$/CONOUT$ confirmed openable
  and interactive here via probe-tty.mjs.

## Summary

total: 1
passed: 1
issues: 0
pending: 0
skipped: 0
blocked: 0

## Notes / Deferred Follow-Ups

- observation: On Windows, an MCP host that spawns `stint run` via the official SDK's
  `StdioClientTransport` uses `windowsHide: true` (CREATE_NO_WINDOW), giving the child a
  HIDDEN console. The controlling-terminal approval prompt (CONIN$/CONOUT$) then renders to
  a console the user cannot see or answer, so every approval-gated call runs to its timeout
  and is DENIED. This fails SAFE (deny-by-default holds; never approves without a human) and
  SC#2 ("approvals prompt in the terminal") holds in a visible console — so it is a documented
  limitation, not a Phase-6 blocker. Follow-up belongs with the Phase 7 example host wiring:
  decide the supported prompt channel on Windows for hidden-console spawns (e.g. document that
  hosts must spawn with a visible console / attach a tty, or reconsider the spawn-child transport
  topology option for that platform).

## Gaps

[none]
