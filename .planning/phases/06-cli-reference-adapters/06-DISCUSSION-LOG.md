# Phase 6: CLI & Reference Adapters - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-09-29
**Phase:** 6-cli-reference-adapters
**Areas discussed:** Run-command scope, Consent & prompt UX, Receipts output, Store location & layout, Cleanup/retry & revoke semantics, Exit codes & output styling

---

## Run-command scope

| Option | Description | Selected |
|--------|-------------|----------|
| Ship `stint run <lease>` | Live run boots proxy over stdio + terminal HostAdapter; tests drive it with in-process/mock MCP client; Phase 7 plugs in real agent | ✓ |
| Reference HostAdapter only | Adapter tested standalone; run wiring deferred entirely to Phase 7 | |
| run boots proxy, no agent | Command exists but no in-phase live exercise | |

**User's choice:** Ship `stint run <lease>` (Recommended)
**Notes:** SC#2's "during a run" is proven in-phase via an in-process MCP client that triggers real approval prompts + timeout-deny.

### Run wiring

| Option | Description | Selected |
|--------|-------------|----------|
| Stdio, vault seed seam | MCP over stdio; creds via existing Phase 4 seed seam from local fixture; OAuth acquisition deferred to Phase 7 | ✓ |
| Stdio + basic grant acquisition | Adds minimal interactive OAuth seeding into Phase 6 | |
| Let me describe it | User-specified | |

**User's choice:** Stdio, vault seed seam (Recommended)

### Lease reference / manifest source

| Option | Description | Selected |
|--------|-------------|----------|
| Positional id; manifest path arg | `inspect/revoke/cleanup/receipts/run <leaseId>`; `create <manifest-path>` | ✓ |
| Positional id; --manifest flag | `create --manifest <path>` named flag | |
| You decide | Claude picks conventional shape | |

**User's choice:** Positional id; manifest path arg (Recommended)

---

## Consent & prompt UX

| Option | Description | Selected |
|--------|-------------|----------|
| Sectioned summary + typed y/N | Rendered manifest sections + `Grant? [y/N]` defaulting No | ✓ |
| Sectioned summary + typed phrase | Requires typing an explicit phrase to accept | |
| You decide | Claude picks rendering/confirmation | |

**User's choice:** Sectioned summary + typed y/N (Recommended)

### Prompt timeout / non-interactive behavior

| Option | Description | Selected |
|--------|-------------|----------|
| Countdown, auto-deny; non-tty=deny | Countdown UI; core resolves deny on timeout; non-TTY never blocks | ✓ |
| Silent timeout; non-tty=deny | Same deny semantics, no countdown UI | |
| You decide | Claude picks feedback detail | |

**User's choice:** Countdown, auto-deny; non-tty=deny (Recommended)
**Notes:** Adapter only proposes; core's await*Decision owns timeout→deny.

---

## Receipts output

| Option | Description | Selected |
|--------|-------------|----------|
| Human lines + --json flag | Plain-language timeline default, structured TimelineEntry[] under --json | ✓ |
| Human lines only | No JSON mode | |
| You decide | Claude picks format | |

**User's choice:** Human lines + --json flag (Recommended)

### Chain verification / break reporting

| Option | Description | Selected |
|--------|-------------|----------|
| Separate `verify`; report seq+reason | Explicit verify command/flag; non-zero exit + exact brokenAtSeq + reason | ✓ |
| Verify inline on every print | Always verifies before printing timeline | |
| You decide | Claude picks command shape/wording | |

**User's choice:** Separate `verify`; report seq+reason (Recommended)

---

## Store location & layout

| Option | Description | Selected |
|--------|-------------|----------|
| ~/.stint, --store/env override | Home-dir default; `--store`/`STINT_HOME` overrides | ✓ |
| cwd ./.stint, --store override | Project-local default | |
| You decide | Claude picks location | |

**User's choice:** ~/.stint, --store/env override (Recommended)

### On-disk layout & lock granularity

| Option | Description | Selected |
|--------|-------------|----------|
| File per lease/chain + per-file lock | One file per lease + per-lease receipt chain; write-file-atomic + per-file proper-lockfile | ✓ |
| Single aggregate file + global lock | All leases in one file, store-wide lock | |
| You decide | Claude picks layout/lock granularity | |

**User's choice:** File per lease/chain + per-file lock (Recommended)
**Notes:** Windows CI test hammers one lease's transaction() to prove no lost updates/torn files.

---

## Cleanup/retry & revoke semantics

| Option | Description | Selected |
|--------|-------------|----------|
| One `cleanup`, auto-detect, confirm | Single command runs runTeardown or resumes via retryTeardown; [y/N] gate (--yes) | ✓ |
| Separate cleanup + retry, confirm | Two explicit commands | |
| You decide | Claude picks structure | |

**User's choice:** One `cleanup`, auto-detect, confirm (Recommended)

### Revoke behavior

| Option | Description | Selected |
|--------|-------------|----------|
| Confirm, actor user, auto-teardown, report | [y/N] gate (--yes), user-actor revoke auto-chains teardown, prints resulting state | ✓ |
| No confirm, actor user, report | Immediate revoke, no prompt | |
| You decide | Claude picks confirmation/output | |

**User's choice:** Confirm, actor user, auto-teardown, report (Recommended)

---

## Exit codes & output styling

| Option | Description | Selected |
|--------|-------------|----------|
| Distinct non-zero codes + stderr | Distinct codes per failure kind; human to stderr; structured {error,code} under --json | ✓ |
| Simple 0/1 + stderr | Single failure code | |
| You decide | Claude designs code map | |

**User's choice:** Distinct non-zero codes + stderr (Recommended)

### Terminal styling

| Option | Description | Selected |
|--------|-------------|----------|
| picocolors, honor NO_COLOR/non-TTY | Light styling, degrades to plain; --json always uncolored | ✓ |
| Plain text only | No color dependency | |
| You decide | Claude picks approach | |

**User's choice:** picocolors, honor NO_COLOR/non-TTY (Recommended)
**Notes:** picocolors is NOT in CLAUDE.md's stack — research must confirm/add the pin, else fall back to plain text.

---

## Claude's Discretion

- Exact `commander` wiring / `@stint/cli` file layout and `--help` text.
- Exact spelling of the verify command/flag and human wording of consent/timeline/break/error messages.
- Concrete on-disk JSON field layout for lease + receipt-chain files (invariants fixed).
- Exact exit-code integer map (distinct-per-failure-kind fixed).
- Whether interactive prompts use a library or hand-rolled `readline` (deny-by-default/countdown/non-TTY invariants fixed; no heavy dep without research sign-off).

## Deferred Ideas

- payment-reconciler real agent + hybrid e2e test + README — Phase 7.
- Interactive OAuth grant acquisition against a real AS — Phase 7.
- Automatic/background retry of `cleanup_incomplete` — post-v0.1.
- Additional LeaseStore backends + distributed locking — v2.
- Embeddable receipt-timeline UI component — v2.
