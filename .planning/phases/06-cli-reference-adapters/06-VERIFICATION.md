---
phase: 06-cli-reference-adapters
verified: 2026-09-30T09:30:00Z
status: human_needed
score: 4/4 must-haves verified
covered_files:
  - ".planning/phases/06-cli-reference-adapters/06-01-PLAN.md"
  - ".planning/phases/06-cli-reference-adapters/06-01-SUMMARY.md"
  - ".planning/phases/06-cli-reference-adapters/06-02-PLAN.md"
  - ".planning/phases/06-cli-reference-adapters/06-02-SUMMARY.md"
  - ".planning/phases/06-cli-reference-adapters/06-03-PLAN.md"
  - ".planning/phases/06-cli-reference-adapters/06-03-SUMMARY.md"
  - ".planning/phases/06-cli-reference-adapters/06-04-PLAN.md"
  - ".planning/phases/06-cli-reference-adapters/06-04-SUMMARY.md"
  - ".planning/phases/06-cli-reference-adapters/06-05-PLAN.md"
  - ".planning/phases/06-cli-reference-adapters/06-05-SUMMARY.md"
  - ".planning/phases/06-cli-reference-adapters/06-06-PLAN.md"
  - ".planning/phases/06-cli-reference-adapters/06-06-SUMMARY.md"
  - ".planning/phases/06-cli-reference-adapters/06-07-PLAN.md"
  - ".planning/phases/06-cli-reference-adapters/06-07-SUMMARY.md"
  - "packages/cli/src/adapter/terminal-host-adapter.ts"
  - "packages/cli/src/commands/create.ts"
  - "packages/cli/src/commands/verify.ts"
  - "packages/cli/src/program.ts"
  - "packages/cli/src/store/atomic-file.ts"
  - "packages/cli/src/store/json-lease-store.ts"
covered_digest: "v1:sha256:1efa77508b1ca3b521641aeceb33b06bd77651ac2a5b1bc90bef334bf7795781"
behavior_unverified: 0
overrides_applied: 0
human_verification:
  - test: "On a real Windows console (and ideally a POSIX tty), run `stint create <signed manifest>` and answer y, n, and no answer; then run `stint run <id> --profile ... --credentials ...` from an MCP host and trigger an approval-gated call, answering y, n, and leaving it unanswered."
    expected: "Consent summary renders readably; countdown redraws; y grants/approves, n/blank declines/denies, and an unanswered approval is denied after approvals.timeout_seconds. The MCP stdout stream is not corrupted by prompt output."
    why_human: "openControllingTerminal (CONIN$/CONOUT$ or /dev/tty) and the live readline countdown were only exercised through injected seams / fake streams (assumption A1 in terminal.ts); a real console cannot be driven by automated tests."
---

# Phase 6: CLI & Reference Adapters Verification Report

**Phase Goal:** A user can run the whole lease lifecycle from a terminal, and the HostAdapter and LeaseStore plug-in contracts are proven implementable outside core and proxy.
**Verified:** 2026-09-30
**Status:** human_needed (all automated checks pass; one known real-terminal UAT item)
**Re-verification:** No, initial verification

## Goal Achievement

### Observable Truths (ROADMAP Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | User can create a lease from a manifest via CLI after a consent prompt rendered from the manifest (scopes, limits, approvals, auth mode, verifier), then inspect, revoke, and run/retry cleanup | VERIFIED | `create.ts` runs parse, `verifyEnvelope` against the trust store, then `awaitConsentDecision` via the adapter, then `reduce`/`activateLease`/`save`. `consent-view.ts` `renderConsent` emits Scopes, Limits, Approvals, Authentication (`resolveAuthMode`), Completion check (verifier) and Cleanup sections. `revoke.ts` is a user-actor revoke that calls `runTeardown`. `cleanup.ts` routes `runTeardown` / `retryTeardown` / no-op / refuse. `inspect.ts` present. `program.ts` registers all seven commands. Tests: create.test (17), inspect.test (6), revoke.test (11), cleanup.test (10) pass. `node dist/bin.js --help` lists the commands. |
| 2 | Per-call approvals prompt in the terminal via the reference HostAdapter; unanswered prompt denies on timeout | VERIFIED (real-console behaviour routed to human) | `terminal-host-adapter.ts` implements all four HostAdapter methods, rejects on abort/EOF/no-TTY so core folds to deny. `run-lease.ts` wires `createApprovalDispatcher(adapter, approvals.timeout_seconds, clock)`. That dispatcher arms a real `setTimeout` and calls `awaitApprovalDecision`, which resolves deny/timeout. run-approvals.test asserts y approves, n denies, unanswered call returns `denied: timeout` after ~1s with 0 downstream fetches, and no-TTY denies immediately. |
| 3 | User can print receipts as one merged plain-language timeline marking verified and attested entries, and verify chain integrity, with a tampered file reported at the exact break | VERIFIED | `receipts.ts` calls `mergeTimeline(verified, attested)` and `renderTimeline` (tags `[verified]` / `[attested]`, sanitized, no argsHash/signature). `verify.ts` passes checkpoints plus runtime public key to `verifyChain` / `verifyAttestedChain`; `render/verify.ts` prints `broken at entry N` with a fixed reason for all 5 enum values. verify.test asserts payload edit at entry N+1 reports `broken at entry 2 [hash_mismatch]` (exit 6), `--json` `brokenAtSeq: 1`, tail edit via checkpoint, truncated, reordered, altered checkpoint, and untrusted attested claim. |
| 4 | JSON-file LeaseStore passes the same contract suite as in-memory plus a concurrent read/write test (atomic writes, locking, no lost updates or torn files) | VERIFIED | `json-lease-store.test.ts` runs `createLeaseStoreContractTests` (from `@stint/core/testing`) unmodified against `createJsonLeaseStore`; `json-receipt-store.test.ts` likewise runs `createReceiptStoreContractTests`. `json-store-concurrency.test.ts`: 50 concurrent in-process transactions with 4 readers gives version 50, 0 torn reads, only `lease.json` left; cross-process 3 writers x 20 plus a reader process gives version 60, 0 parse errors. Ran on this Windows machine. Implementation: `proper-lockfile` + `write-file-atomic` (temp+rename, fsync) + transient EPERM/EBUSY retry + lock-compromise guard (`atomic-file.ts`). |

**Score:** 4/4 truths verified (0 present-but-behavior-unverified)

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/cli/src/store/json-lease-store.ts`, `atomic-file.ts`, `json-receipt-store.ts` | On-disk LeaseStore/ReceiptStore | VERIFIED | Substantive, wired via `real-deps.ts`; consumed by all commands |
| `packages/cli/src/adapter/terminal-host-adapter.ts`, `prompt.ts`, `consent-view.ts`, `sanitize.ts` | Reference HostAdapter | VERIFIED | Wired into `create` (via `deps.adapterFactory`) and `run` |
| `packages/cli/src/commands/{create,inspect,run,revoke,cleanup,receipts,verify}.ts` | Seven commands | VERIFIED | All registered in `program.ts`, none stubbed |
| `packages/cli/src/render/{timeline,verify,style}.ts` | Plain-language rendering | VERIFIED | Exhaustive `Record<ReceiptVerifyReason,string>` table |
| `packages/cli/src/run/{run-lease,profile,terminal,credentials}.ts` | Stdio MCP proxy runner | VERIFIED | Composes existing proxy seams; no enforcement logic duplicated |
| `packages/cli/dist/` | Built bin | VERIFIED | `dist/bin.js --help` runs and lists commands |

### Key Link Verification

| From | To | Via | Status |
|------|----|-----|--------|
| `create.ts` | core `awaitConsentDecision` / `activateLease` | direct call, timeout armed by `AbortController` | WIRED |
| `run-lease.ts` | proxy `createApprovalDispatcher` | `approve:` in `ProxyDeps` with manifest timeout | WIRED |
| `revoke.ts` / `cleanup.ts` | proxy `runTeardown` / `retryTeardown` | `teardown-support.ts` builds real-vault `TeardownDeps` | WIRED |
| `receipts.ts` | core `mergeTimeline` | direct call | WIRED |
| `verify.ts` | core `verifyChain`/`verifyAttestedChain` | with checkpoint and public key | WIRED |
| `json-lease-store.ts` | `atomic-file.ts` | queue, lock, atomic write | WIRED |
| `bin.ts` | `real-deps.ts` / `main` | exit code mapping | WIRED |

### Data-Flow Trace (Level 4)

Renderers consume real store loads (`receipts.load`, `store.load`), not literals. Consent renders from the signature-verified manifest object. FLOWING.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Full CLI package suite | `pnpm --filter @stint/cli exec vitest run --pool=threads` | 21 files, 241 tests passed | PASS |
| Typecheck | `pnpm exec tsc --noEmit -p packages/cli/tsconfig.json` | no errors | PASS |
| Built bin | `node packages/cli/dist/bin.js --help` | lists create/inspect/run/revoke/cleanup/receipts/verify | PASS |

### Probe Execution

Step 7c: SKIPPED. No probe scripts declared by the phase plans.

### Requirements Coverage

| Requirement | Source Plan(s) | Description | Status | Evidence |
|-------------|----------------|-------------|--------|----------|
| HOST-02 | 06-03, 06-04, 06-06, 06-07 | CLI reference HostAdapter renders consent, prompts approvals, default deny on timeout | SATISFIED | terminal-host-adapter, consent-view, run-lease wiring; tests above. Real-console check is human item |
| HOST-03 | 06-01, 06-02 | LeaseStore interface; JSON-file default with atomic writes/locking passing concurrent test on Windows | SATISFIED | contract suite plus hammer tests pass on Windows |
| CLI-01 | 06-04, 06-06, 06-07 | Create (with consent), inspect, revoke, run/retry cleanup | SATISFIED | commands and tests above |
| CLI-02 | 06-05 | Merged plain-language receipts timeline and chain verification | SATISFIED | receipts/verify commands and tests |

All four IDs appear in the PLAN frontmatter and are marked Complete in REQUIREMENTS.md (lines 73, 74, 78, 79; traceability rows 164-167). No orphaned Phase 6 requirements.

### Anti-Patterns Found

None. No TBD/FIXME/XXX/TODO/HACK markers in `packages/cli/src`; no stubs, empty handlers, or hardcoded-empty render data.

Informational (not blocking, documented in code comments):
- `runLease` deliberately omits `teardownSteps`. A mid-run revocation leaves the lease `tearing_down` and `stint cleanup` finishes it (covered by the cleanup test for `tearing_down`).
- `create` refuses hosted/hybrid manifests until license issuance exists (Phase 7); this is an explicit, tested refusal before consent.
- Consent timeout of 120s is an assumed default (A3), since the manifest has no field for it.

### Human Verification Required

#### 1. Real terminal prompts (create consent, run approvals, deny on timeout)

**Test:** On a real Windows console (ideally also a POSIX tty), run `stint create <signed manifest>` and answer y, n, and nothing; then serve a lease with `stint run` from an MCP host and trigger an approval-gated call, answering y, n, and leaving it unanswered.
**Expected:** The consent summary is readable; the countdown redraws; y grants/approves; n or blank declines/denies; an unanswered approval is denied after `approvals.timeout_seconds`; prompt output never lands on the MCP stdout channel.
**Why human:** `openControllingTerminal` (`CONIN$`/`CONOUT$`, `/dev/tty`) and the live readline countdown are covered only via injected seams and fake streams. This is the known end-of-phase UAT item, not a gap.

### Gaps Summary

No gaps. All four success criteria are backed by implemented, wired code and passing tests (241/241 in `@stint/cli`, including the cross-process concurrency hammer on Windows). The only outstanding item is the pre-declared real-terminal manual check.

---

_Verified: 2026-09-30_
_Verifier: Claude (gsd-verifier)_
