---
phase: "4"
slug: "mcp-proxy-credential-vault"
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-09-28"
---

# Phase 4 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest (5.0.2) |
| **Config file** | vitest.config.ts (repo root) — new `packages/proxy` picked up by workspace |
| **Quick run command** | `npx --yes pnpm@12.6.0 build && npx --yes pnpm@12.6.0 exec vitest run packages/proxy/test/<file>.test.ts` |
| **Full suite command** | `npx --yes pnpm@12.6.0 build && npx --yes pnpm@12.6.0 exec vitest run packages/proxy` |
| **Estimated runtime** | ~30–60 seconds (proxy package scope only; whole-repo run OOMs the sandbox) |

---

## Sampling Rate

- **After every task commit:** Run the quick run command scoped to the task's test file
- **After every plan wave:** Run the full suite command scoped to `packages/proxy`
- **Before `/gsd-verify-work`:** `packages/proxy` suite must be green (plus `packages/core` unaffected)
- **Max feedback latency:** 60 seconds

---

## Per-Task Verification Map

Populated by the planner from the resolved plans. Every task with an `<automated>` verify command should be scoped to a specific test file under `packages/proxy/test/` (never a whole-repo run — the sandbox OOMs). Wave 0 installs `@modelcontextprotocol/sdk`, `oauth4webapi`, `oauth2-mock-server` and scaffolds `packages/proxy`.

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 4-XX-XX | XX | 0 | PRXY-01 | — | package scaffold + deps installed | build | `npx --yes pnpm@12.6.0 build` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `packages/proxy/` — new package scaffold (package.json, tsconfig, src/index.ts, test/)
- [ ] `@modelcontextprotocol/sdk`, `oauth4webapi`, `oauth2-mock-server` installed (each behind a `checkpoint:human-verify` per legitimacy protocol — all three flagged `[SUS] too-new` but are the CLAUDE.md-pinned versions)
- [ ] `packages/proxy/package.json` `engines.node` set to `>=22.18.0` (matches core; currently the roadmap-era template would default to `>=22.12.0`)
- [ ] Shared OAuth test harness fixture wiring `oauth2-mock-server` with `[oauth.allowInsecureRequests]: true` and a `Events.BeforeResponse` hook helper for forcing `invalid_grant`

*Test infrastructure (vitest) already exists from prior phases; only the new package and its deps are Wave 0.*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Package legitimacy of the 3 new npm deps | PRXY-01 | Human must confirm `[SUS] too-new` packages are the intended pinned versions before `pnpm add` | Verify each version against CLAUDE.md stack table; confirm no postinstall scripts; approve at `checkpoint:human-verify` |

*All other phase behaviors (tool filtering, receipts, caps/serialization, approval binding, token injection isolation, revocation detection) have automated adversarial verification.*

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 60s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
