---
phase: "06"
slug: "cli-reference-adapters"
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-09-29"
---

# Phase 06 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 5.x |
| **Config file** | `vitest.config.ts` (workspace root) |
| **Quick run command** | `npx --yes pnpm@12.6.0 exec vitest run <scoped test files>` |
| **Full suite command** | `npx --yes pnpm@12.6.0 exec vitest run packages/cli packages/core packages/proxy` |
| **Estimated runtime** | ~60 seconds (scoped); whole-repo runs can OOM in sandbox — scope by package/file |

---

## Sampling Rate

- **After every task commit:** Run the task's scoped `npx --yes pnpm@12.6.0 exec vitest run <files>`
- **After every plan wave:** Run the wave's package-scoped suite
- **Before `/gsd-verify-work`:** Full scoped suite must be green
- **Max feedback latency:** 60 seconds

---

## Per-Task Verification Map

> Seeded draft — filled per task from the finalized PLAN.md files.

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 06-01-01 | 01 | 1 | HOST-03 | — | JSON LeaseStore passes shared contract suite; no lost updates / torn files under concurrency | unit/integration | `npx --yes pnpm@12.6.0 exec vitest run packages/cli/test/json-lease-store.test.ts` | ❌ W0 | ⬜ pending |

---

## Wave 0 Requirements

- [ ] JSON-store + concurrency test files scaffolded (stubs) for HOST-03
- [ ] CLI command test harness / in-process MCP client fixture for CLI-01/CLI-02 and HOST-02
- [ ] Windows-CI concurrency test wired to run on `windows-latest`

*Filled from finalized plans during Wave 0.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Real interactive TTY consent/approval keypress UX | HOST-02 | True interactive TTY keystrokes can't be fully automated; non-TTY + timeout paths ARE automated | Run `stint create <manifest>` and `stint run <id>` in a real terminal; confirm deny-by-default and visible countdown |

*Non-TTY, timeout-deny, and deny-by-default paths all have automated coverage; only real keypress ergonomics are manual.*

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 60s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
