---
phase: 06-cli-reference-adapters
plan: 05
subsystem: cli
tags: [receipts, verify, timeline, hash-chain, checkpoint, render]

requires:
  - phase: 06-cli-reference-adapters
    provides: "JSON ReceiptStore (06-02), frozen program.ts, CliDeps, harness, sanitize/style (06-03, 06-04)"
  - phase: 03-receipts-licensing
    provides: "mergeTimeline, verifyChain, verifyAttestedChain, RECEIPT_VERIFY_REASONS"
provides:
  - "stint receipts: merged plain-language timeline, one sanitized [verified]/[attested] line per entry, --json = mergeTimeline output"
  - "stint verify: checkpoint-anchored verifyChain + verifyAttestedChain, exact brokenAtSeq and reason, exit 6 on a break"
  - "REASON_MESSAGES: Record<ReceiptVerifyReason, string> over all five reasons (compile-time complete)"
affects: [06-06, 06-07, 07-example]

actuals:
  tokens: 8100
  tasks: 2
  commits: 2
plan_head_before: 347b6cd8b94e9dbeef6c0b34ea8ab58b8d5022e8
commits: 2

tech-stack:
  added: []
  patterns:
    - "Thin renderers: commands load, call core, print; no integrity logic in the CLI"
    - "Receipt-derived text is read defensively (unknown payload fields render as '?') and sanitized before printing"

key-files:
  created:
    - packages/cli/src/render/timeline.ts
    - packages/cli/src/render/verify.ts
    - packages/cli/test/receipts.test.ts
    - packages/cli/test/verify.test.ts
  modified:
    - packages/cli/src/commands/receipts.ts
    - packages/cli/src/commands/verify.ts

key-decisions:
  - "The checkpoint public key is only loaded when a checkpoint exists; a missing key is passed as undefined so the core verifier reports checkpoint_sig_invalid (fail closed, exit 6) rather than the command crashing."
  - "A verify pass on a non-empty chain with no checkpoint prints a dim note that removal or edits of the newest entries cannot be detected without one."
  - "`receipts --verify` delegates wholly to verify (per plan), so it prints verification results instead of the timeline."
  - "receipts prints 'No receipts recorded for this lease.' on an empty timeline (exit 0); --json prints []."

requirements-completed: [CLI-02]

coverage:
  - id: D1
    description: "receipts prints one tagged line per entry, chronological across chains; transitions/teardown/claims described; verified-only when attested is empty"
    requirement: CLI-02
    verification:
      - kind: unit
        ref: "packages/cli/test/receipts.test.ts"
        status: pass
    human_judgment: false
  - id: D2
    description: "receipts --json equals mergeTimeline output and contains no ANSI; argsHash and attestation signatures never printed; control sequences in receipt text neutralized; malformed hand-edited entry does not throw"
    requirement: CLI-02
    verification:
      - kind: unit
        ref: "packages/cli/test/receipts.test.ts"
        status: pass
    human_judgment: false
  - id: D3
    description: "verify: clean chains exit 0 with counts; mid-chain edit at N reports N+1 hash_mismatch exit 6; final-entry edit undetected without a checkpoint and caught at checkpoint.count-1 with one; tail delete -> truncated; swap -> reordered; altered checkpoint and missing runtime key -> checkpoint_sig_invalid; untrusted attested claim -> claim_sig_invalid"
    requirement: CLI-02
    verification:
      - kind: unit
        ref: "packages/cli/test/verify.test.ts"
        status: pass
    human_judgment: false
  - id: D4
    description: "REASON_MESSAGES covers every RECEIPT_VERIFY_REASONS value (typed Record, plus a runtime key-equality test)"
    requirement: CLI-02
    verification:
      - kind: unit
        ref: "packages/cli/test/verify.test.ts#has a plain-language message for every reason in the enum"
        status: pass
    human_judgment: false

duration: 12min
completed: 2026-09-30
status: complete
---

# Phase 6 Plan 05: receipts and verify Summary

**`stint receipts` (merged plain-language timeline tagged verified/attested, `--json`) and `stint verify` (checkpoint-anchored chain check reporting the exact break locus and a five-reason message table), both as thin renderers over `@stint/core`.**

## Accomplishments

- `render/timeline.ts`: one line per entry as `<ISO ts> [verified|attested] <description>`. Only secretless-by-type fields are shown (resource, outcome, redacted summary, transition and teardown vocabulary, publisher and claim type). `argsHash`, `claimHash` and signatures are never printed. Every receipt-derived value is `sanitizeForTerminal`-ed; a missing or non-string field renders as `?`.
- `commands/receipts.ts`: `assertSafeLeaseId`, unknown lease exits 4, loads both chains, `mergeTimeline`, `--json` prints the array unchanged. An absent receipts directory reads as two empty chains.
- `render/verify.ts`: `REASON_MESSAGES: Record<ReceiptVerifyReason, string>` (five reasons, Pitfall 9) and `renderVerifyResult`.
- `commands/verify.ts`: per-chain entries plus `readCheckpoint`, runtime public key passed whenever any checkpoint exists (Pitfall 8), `verifyChain` for verified and `verifyAttestedChain` (with the trust store) for attested. Exit 0 or `EXIT_CODES.chainBroken`; `--json` emits `{ verified, attested }`.
- Tests work on real on-disk chain files edited between CLI calls. The 179-test `packages/cli` suite passes; `tsc --noEmit`, eslint on all six files, prettier and `tsdown` build are clean.

## Task Commits

1. **Task 1: receipts timeline** - `ba6b9c2` (feat)
2. **Task 2: verify with five-reason table** - `957b452` (feat)

## Deviations from Plan

None functionally. `program.ts` was not touched; only the two command stub bodies were replaced. Verification was scoped to `packages/cli` (whole-repo runs OOM in this sandbox), not the plan's repo-root `pnpm build && typecheck`.

## Known Limitations

- A chain with no stored checkpoint verifies only its internal hash links; edits to or removal of the newest entries are undetectable until a checkpoint exists. `verify` says so in a note. Nothing in the CLI writes checkpoints yet, so real leases will show this note until the run/revoke plans (06-06/06-07) sign one.
- `receipts --verify` prints only verification results (delegation per plan), although the flag help says "also verify".
- The positive path for a validly signed attested claim is not exercised in the CLI tests (no detached-sign helper is exported for tests); core owns that coverage.

## Known Stubs

None in this plan. Remaining interface stubs: `run.ts`, `revoke.ts`, `cleanup.ts` (later plans).

## Threat Flags

None beyond the plan's register. T-06-16 (checkpoint-anchored verify, exact locus, exit 6), T-06-17 (no args/secrets in output, sanitized) and T-06-18 (typed reason table) are mitigated and tested.

## Self-Check: PASSED

All four created files and both modified files exist; commits `ba6b9c2` and `957b452` are in `git log`.
