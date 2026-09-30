# Phase 7: End-to-End Example & README - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-09-30
**Phase:** 07-end-to-end-example-readme
**Areas discussed:** Windows prompt channel (pre-decided), Agent embodiment & approvals, Quickstart shape, Mock services & OAuth fidelity, Example host & Windows mechanism, Hybrid license issuance, Teardown-failure injection, CI model, Success signal

---

## Pre-discussion setup (branch)

The worktree branch was at Phase 01 only; Phases 1–6 lived on `claude/gsd-plan-phase-1-8cd800`. Per user choice, this worktree's branch was reset (`git reset --hard`) onto that complete line so Phase 7 has its prerequisites. `main` and the prior branch were identical Phase-01-only, so nothing unique was lost.

## Windows prompt channel (direction)

| Option | Description | Selected |
|--------|-------------|----------|
| Document visible-console requirement | Keep controlling-terminal topology; make host + quickstart spawn `stint run` with a visible console | ✓ |
| Add spawn-child transport topology | `stint run` spawns the agent as a child, keeping the real tty free | |
| Separate approval UI/IPC channel | Decouple approvals from the tty entirely | |

**User's choice:** Document/require a visible console; keep the controlling-terminal topology.
**Notes:** Direction confirmed up front; the *mechanism* was refined in the "Example host & Windows mechanism" area below.

## Agent embodiment & how approvals are driven

| Option | Description | Selected |
|--------|-------------|----------|
| Scripted-adapter harness for CI + real spawn for humans | Automated e2e uses a scripted test HostAdapter (deterministic, tty-free); README quickstart uses real spawned `stint run` with a visible console | ✓ |
| Everything through spawned `stint run` + pty in CI | Even the automated test drives approvals through a pseudo-terminal | |
| You decide | Planner picks within the SC2 determinism constraint | |

**User's choice:** Scripted-adapter harness for CI + real spawn for humans.
**Notes:** Also confirmed adding a spawned-binary smoke test (Yes) that boots the built `stint run` over stdio (deny-by-timeout approvals only, no tty).

## Quickstart shape (what a newcomer types)

| Option | Description | Selected |
|--------|-------------|----------|
| Wrapped `pnpm` command + documented CLI lifecycle | Verbatim path is one script; README also shows the raw `stint` lifecycle | ✓ |
| Single wrapped command only | Just the script | |
| Hand-typed `stint` sequence | Newcomer types every lifecycle command | |

**User's choice:** Wrapped `pnpm example:*` command as the verbatim path, plus documented individual CLI steps for understanding.

## Mock services & OAuth fidelity

| Option | Description | Selected |
|--------|-------------|----------|
| Real auth-code + PKCE + refresh vs oauth2-mock-server | Genuine acquisition/refresh through the vault | ✓ |
| Pre-seed tokens into the vault seed seam | Skip acquisition | |

**User's choice:** Real OAuth flow against `oauth2-mock-server` (closes Phase 6's deferred acquisition).

| Option | Description | Selected |
|--------|-------------|----------|
| Local HTTP mock hit through the REST outbound connector | Real socket, real outbound path via `createRestOutboundConnector` | ✓ |
| In-process `outboundFetch` fixture stub | No socket, fixtures only | |

**User's choice:** Local `127.0.0.1` HTTP mocks through the real REST outbound connector.

## Example host & Windows visible-console mechanism

| Option | Description | Selected |
|--------|-------------|----------|
| Example ships a host launcher spawning `stint run` with `windowsHide:false` | Structural fix in the example | ✓ |
| README documents a manual visible-console spawn only | Prose-only | |

**User's choice:** Ship a host launcher (modeled on `manual/mcp-call-visible.mjs`).

| Option | Description | Selected |
|--------|-------------|----------|
| Automated spawn-option assertion + keep manual repro scripts | CI assertion on `windowsHide:false` + manual human check | ✓ |
| Automated assertion only | | |
| Documented manual UAT step only | | |

**User's choice:** Automated assertion + retained manual repro scripts.

## Hybrid license issuance

| Option | Description | Selected |
|--------|-------------|----------|
| Real publisher endpoint: run requests + refreshes, custody holds | Exercises LIC-01/02/03/05 live; closes Phase 6 A8 | ✓ |
| Out-of-band issuance injected via a seed seam | Simpler; issuance-at-activation unexercised | |
| You decide | Planner picks the seam | |

**User's choice:** Mock publisher HTTP server; runtime obtains + refreshes the license, agent never sees it.

## Teardown-failure injection

| Option | Description | Selected |
|--------|-------------|----------|
| Mock publisher's cleanup-hook endpoint returns an error | Cleanup-hook step fails; revoke-OAuth + invalidate-license succeed → cleanup_incomplete | ✓ |
| Mock OAuth revocation endpoint fails | | |
| Inject a failing teardown step via a test seam | | |

**User's choice:** Cleanup-hook endpoint error (retry then reaches cleaned_up).

## CI model

| Option | Description | Selected |
|--------|-------------|----------|
| Dedicated vitest project / CI step for the example | Own process, starts/stops mocks, separate from unit suites | ✓ |
| Part of the normal workspace vitest run | | |
| Standalone `pnpm example:e2e` script outside vitest | | |

**User's choice:** Dedicated vitest project / CI step (Windows + Linux).

## Success signal

| Option | Description | Selected |
|--------|-------------|----------|
| Merged `stint receipts` timeline + one-line summary | Shows the honest audit trail; doubles as CLI-02 demo | ✓ |
| Final state line only | | |
| Agent business output only | | |

**User's choice:** Merged receipts timeline + one-line summary.

---

## Claude's Discretion

- The exact agent call script (concrete tool names/args), provided each E2E-02 scenario is deterministically triggered.
- Mock-server implementation choice (`node:http` vs a tiny helper), provided hermetic `127.0.0.1` binding.
- File/module layout under `examples/payment-reconciler`, wrapper-script name, README wording/structure.
- How the license-issuance and OAuth-acquisition seams are surfaced on `create`/`run` (endpoint in run profile vs flag), provided the never-to-agent/never-to-customer + LIC bounds hold.
- Exact e2e assertion/reporting wording.

## Deferred Ideas

- Real Paystack/Sheets integrations and real `pay` execution — out of scope (mocked only).
- npm publishing / release pipeline — post-v0.1 (ECO-V2-01).
- Additional example agents and an embeddable receipt-timeline UI — v2 (ECO-V2-02/03).
- Reconsidering the `spawn-child` run transport topology as a general Windows default — revisit only if a host cannot provide a visible console.
- Driving the automated e2e through a real pty — rejected for CI (node-pty Windows flakiness); manual real-console path covers it.
