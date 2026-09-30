---
phase: 06-cli-reference-adapters
plan: 03
subsystem: cli
tags: [host-adapter, readline, picocolors, terminal-injection, consent]

requires:
  - phase: 06-cli-reference-adapters
    provides: "@stint/cli scaffold, picocolors pin (06-01)"
  - phase: 02-lease-core
    provides: "HostAdapter contract and await*Decision folding (core-owned deny-by-default)"
provides:
  - "createTerminalHostAdapter: all four HostAdapter methods, deny-by-default via rejection on abort/EOF/no-TTY"
  - "askLine: readline/promises prompt with EOF guard, abort handling and display-only countdown"
  - "renderConsent: ALP section 6 sectioned consent summary, cleanup labelled as attested publisher claim"
  - "sanitizeForTerminal: terminal-injection defense for manifest/receipt text"
  - "createStyle/colorDecision: picocolors.createColors from an explicit decision (false under --json, NO_COLOR, non-TTY)"
affects: [06-04, 06-05, 06-06, 06-07]

actuals:
  tokens: 14000
  tasks: 2
  commits: 2
plan_head_before: 1659e57c4fafd8b2fa3590486222c9f221410e4f
commits: 2

tech-stack:
  added: []
  patterns:
    - "adapter renders and proposes only; non-answers REJECT so core's await*Decision folds them"
    - "color decision computed once by the caller and passed to createStyle(boolean)"
    - "every manifest-derived string goes through sanitizeForTerminal before it is printed"

key-files:
  created:
    - packages/cli/src/adapter/sanitize.ts
    - packages/cli/src/render/style.ts
    - packages/cli/src/adapter/prompt.ts
    - packages/cli/src/adapter/consent-view.ts
    - packages/cli/src/adapter/terminal-host-adapter.ts
    - packages/cli/test/sanitize.test.ts
    - packages/cli/test/style.test.ts
    - packages/cli/test/terminal-host-adapter.test.ts
  modified:
    - packages/cli/src/index.ts

key-decisions:
  - "Non-answers (abort, EOF, no TTY) reject with NoAnswerError/NoTerminalError instead of resolving a decline, keeping the outcome single-sourced in core (D-05)."
  - "Countdown is driven by an injected clock and the constructor's timeout seconds; it is cleared on abort and in finally and never produces an answer."
  - "Consent timeout default 120s (assumption A3); outcome-confirmation reuses the same value for its display-only countdown."

patterns-established:
  - "askLine takes an optional terminal override so terminal-mode readline and the countdown are testable with fake streams"

requirements-completed: [HOST-02]

coverage:
  - id: D1
    description: "Adapter has exactly the four HostAdapter methods; y/yes approve/grant/confirm, anything else is explicit deny/decline/reject"
    requirement: HOST-02
    verification:
      - kind: unit
        ref: "packages/cli/test/terminal-host-adapter.test.ts#requestApproval"
        status: pass
    human_judgment: false
  - id: D2
    description: "Abort, EOF and non-TTY never yield approve/grant/confirm; core folds abort to deny/decline/reject timeout"
    requirement: HOST-02
    verification:
      - kind: unit
        ref: "packages/cli/test/terminal-host-adapter.test.ts#requestApproval / requestConsent / requestOutcomeConfirmation"
        status: pass
    human_judgment: false
  - id: D3
    description: "renderConsent includes every ALP section 6 field, resolves omitted auth.mode to hybrid, labels cleanup as attested, sanitizes hostile strings"
    requirement: HOST-02
    verification:
      - kind: unit
        ref: "packages/cli/test/terminal-host-adapter.test.ts#renderConsent"
        status: pass
    human_judgment: false
  - id: D4
    description: "sanitizeForTerminal strips ESC/CSI/OSC, CR/BS/C1 and bidi; style is plain under a false decision and colorDecision ignores CI/FORCE_COLOR"
    verification:
      - kind: unit
        ref: "packages/cli/test/sanitize.test.ts, packages/cli/test/style.test.ts"
        status: pass
    human_judgment: false
  - id: D5
    description: "Real interactive terminal keypress ergonomics (countdown redraw, typed-character preservation)"
    verification:
      - kind: manual
        ref: "06-VALIDATION.md Manual-Only table (end-of-phase UAT)"
        status: pending
    human_judgment: true

duration: 25min
completed: 2026-09-30
status: complete
---

# Phase 6 Plan 03: Reference terminal HostAdapter Summary

**Four-method terminal HostAdapter outside core, deny-by-default through rejection on every non-answer, with sanitized ALP section 6 consent rendering and createColors-based styling.**

## Accomplishments

- Task 1: `sanitizeForTerminal` (Node's `stripVTControlCharacters` first, then C0/C1/DEL, CR/newline collapse, bidi removal) and `createStyle`/`colorDecision` built on `picocolors.createColors(explicit)`, so `--json`, `NO_COLOR`, non-TTY, and CI/win32 all resolve to plain text.
- Task 2: `askLine` (EOF guard, abort to `undefined`, display-only countdown), `renderConsent`, and `createTerminalHostAdapter` implementing `requestConsent`, `requestApproval`, `requestOutcomeConfirmation` and `notify`. The adapter has no approve/deny timer; abort, EOF, and missing TTY reject and core's `await*Decision` folds them (verified in tests against the real core wrappers).
- Barrel exports added for the adapter, `renderConsent`, `sanitizeForTerminal`, `createStyle`, `colorDecision`.
- Scoped verification: the full `packages/cli` suite passes (9 files, 103 tests); `tsc --noEmit`, per-file eslint (strictTypeChecked) and prettier are clean; `tsdown` builds.

## Task Commits

1. **Task 1: sanitize + style** - `44874ee` (feat)
2. **Task 2: terminal HostAdapter + askLine + consent render** - `296110e` (feat)

## Deviations from Plan

None in behavior. Notes within plan intent:

- `renderConsent(manifest, style)` takes the plain `Manifest` (the adapter passes `request.manifest.manifest`); `style` defaults to an uncoloured style.
- Added optional `errorOutput`, `style` and `terminal` adapter options (defaults: `process.stderr`, uncoloured, `output.isTTY`) so the single stderr line and terminal mode are testable; `consentTimeoutSeconds` is optional with the 120s default.
- Added `colorDecision()` to `style.ts` so the "json/NO_COLOR/TTY" rule lives in one place; the plan left the caller to compute it.
- The Task 1 RED run was not captured before the implementation was written (the first test invocation raced the implementation writes and ran green). Task 2 tests were written before the implementation and passed on first run.
- The `clock` option is treated as epoch seconds (matching lease timestamps) and is used only for the displayed countdown.

## Known Limitations

- Real-terminal keypress UX and the countdown redraw on an actual console are not automated (06-VALIDATION.md manual UAT).
- Outcome-confirmation reuses the consent timeout for its display-only countdown; core still owns the actual timeout.

## Known Stubs

None.

## Threat Flags

None. T-06-09 (terminal injection), T-06-10 (adapter-granted outcome) and T-06-11 (raw args in prompts: approval prompt shows only the redacted summary and binding) are mitigated and covered by tests.

## Self-Check: PASSED

All created files exist; commits `44874ee` and `296110e` are present in `git log`.
