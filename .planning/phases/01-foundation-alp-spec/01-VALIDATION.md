---
phase: "1"
slug: "foundation-alp-spec"
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-09-27"
---

# Phase 1 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 5.0.2 + `@vitest/coverage-v8` 5.0.2 (peer: `vite` 8.3.1) |
| **Config file** | none — Wave 0 installs root `vitest.config.ts` with `projects: ['packages/*']` |
| **Quick run command** | `pnpm --filter @stint/spec test` |
| **Full suite command** | `pnpm -r test` |
| **Estimated runtime** | ~20 seconds |

---

## Sampling Rate

- **After every task commit:** Run `pnpm --filter @stint/spec test`
- **After every plan wave:** Run `pnpm -r test`
- **Before `/gsd-verify-work`:** Full suite must be green, `codegen --check` clean, CI green on Linux and Windows
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| TBD (filled by planner) | — | — | FND-01 | — | N/A | smoke | `pnpm install && pnpm -r test` | ❌ W0 | ⬜ pending |
| TBD | — | — | FND-02 | — | N/A | ci | CI workflow run on push | ❌ W0 | ⬜ pending |
| TBD | — | — | FND-03 | — | N/A | unit | `pnpm exec vitest run packages/spec/test/license.test.ts` | ❌ W0 | ⬜ pending |
| TBD | — | — | SPEC-01 | — | N/A | smoke | `node scripts/check-alp-sections.mjs` | ❌ W0 | ⬜ pending |
| TBD | — | — | SPEC-02 | — | Valid manifest accepted | unit | `pnpm exec vitest run packages/spec/test/validate.test.ts -t "valid manifest"` | ❌ W0 | ⬜ pending |
| TBD | — | — | SPEC-03 | — | Unknown enum values rejected (deny by default) | unit | `pnpm exec vitest run packages/spec/test/validate.test.ts -t "rejects unknown"` | ❌ W0 | ⬜ pending |
| TBD | — | — | SPEC-04 | — | `auth.mode` defaults to `hybrid` | unit | `pnpm exec vitest run packages/spec/test/validate.test.ts -t "auth mode default"` | ❌ W0 | ⬜ pending |
| TBD | — | — | SPEC-05 | — | Stale generated types fail the build | unit + ci | `node packages/spec/scripts/codegen.mjs --check` | ❌ W0 | ⬜ pending |
| TBD | — | — | SPEC-06 | — | Invalid publisher signature rejected before consent | unit | `pnpm exec vitest run packages/spec/test/envelope.test.ts` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] Root `vitest.config.ts` with `projects: ['packages/*']`
- [ ] `vite@8.3.1` explicitly in workspace-root devDependencies (vitest peer)
- [ ] `packages/spec/test/` — `validate.test.ts`, `canonical.test.ts`, `envelope.test.ts`, `types.test.ts`, `license.test.ts`
- [ ] `spec/vectors/{valid,invalid,jcs,envelope}/` fixtures
- [ ] `packages/spec/scripts/codegen.mjs` with `--check` mode
- [ ] `packages/{core,proxy,cli}/` stub packages with one smoke test each
- [ ] `.github/workflows/ci.yml`
- [ ] `pnpm.onlyBuiltDependencies` decision recorded in root `package.json`

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| `spec/ALP.md` prose is normatively complete and clear | SPEC-01 | Only section-header presence is mechanically checkable | Read ALP.md end to end; confirm eleven states + transitions, actor list (agent never ends/extends), three auth modes, teardown order, receipts, trust model, trust limits |
| CI green on Linux and Windows | FND-02 | Requires a real GitHub Actions run | Push branch, confirm both matrix jobs pass typecheck, lint, test |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 30s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
