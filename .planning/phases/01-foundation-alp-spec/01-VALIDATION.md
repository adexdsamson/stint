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
| **Full suite command** | `pnpm test` (root script builds every package, then runs `vitest run` across `packages/*`) |
| **Estimated runtime** | ~20 seconds |

---

## Sampling Rate

- **After every task commit:** Run `pnpm --filter @stint/spec test`
- **After every plan wave:** Run `pnpm test`
- **Before `/gsd-verify-work`:** Full suite must be green, `pnpm codegen:check` and `pnpm check:alp` clean, CI green on Linux and Windows
- **Max feedback latency:** 30 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 01-01-T1 | 01-01 | 1 | (all) | T-01-SC | No package installed before human legitimacy approval | checkpoint | blocking-human checkpoint (never auto-approved) | n/a | ⬜ pending |
| 01-01-T2 | 01-01 | 1 | FND-01 | T-01-03 | Build scripts denied by default (strictDepBuilds) | smoke (tracer) | `pnpm install && pnpm test` then `pnpm typecheck && pnpm lint` | ❌ W0 | ⬜ pending |
| 01-01-T3 | 01-01 | 1 | FND-01 | n/a | N/A | smoke | fresh clone: `git clone` to temp, `pnpm install --frozen-lockfile && pnpm test && pnpm typecheck && pnpm lint`; engine-strict install at Node 22.12.0 | ❌ W0 | ⬜ pending |
| 01-01-T3 | 01-01 | 1 | FND-02 | T-01-01 | CI token read-only, no secrets | ci | static check of `.github/workflows/ci.yml` (node one-liner) + human-check live run | ❌ W0 | ⬜ pending |
| 01-01-T3 | 01-01 | 1 | FND-03 | n/a | N/A | unit | `pnpm exec vitest run packages/spec/test/license.test.ts` | ❌ W0 | ⬜ pending |
| 01-02-T1 | 01-02 | 2 | SPEC-02, SPEC-05 | T-01-05 | Valid manifest accepted only through validateManifest | unit (tracer) | `pnpm exec vitest run packages/spec/test/validate.test.ts -t "valid manifest"` + `pnpm codegen:check` | ❌ W0 | ⬜ pending |
| 01-02-T2 | 01-02 | 2 | SPEC-03 | T-01-05 | Unknown enum values rejected (deny by default) | unit | `pnpm exec vitest run packages/spec/test/validate.test.ts -t "rejects unknown"` | ❌ W0 | ⬜ pending |
| 01-02-T2 | 01-02 | 2 | SPEC-04 | T-01-06 | `auth.mode` defaults to `hybrid`; validation never mutates input | unit | `pnpm exec vitest run packages/spec/test/validate.test.ts -t "auth mode default"` | ❌ W0 | ⬜ pending |
| 01-02-T3 | 01-02 | 2 | SPEC-05 | n/a | Stale generated types fail the build | unit + ci | `pnpm exec vitest run packages/spec/test/codegen.test.ts` + `pnpm codegen:check` + `pnpm typecheck` | ❌ W0 | ⬜ pending |
| 01-02-T3 | 01-02 | 2 | SPEC-02, SPEC-03 | n/a | Every invalid vector rejected with its exact errors | unit | `pnpm exec vitest run packages/spec/test/vectors.test.ts` | ❌ W0 | ⬜ pending |
| 01-03-T1 | 01-03 | 3 | SPEC-06 | T-01-10 | Invalid publisher signature rejected before consent | unit (tracer) | `pnpm exec vitest run packages/spec/test/envelope.test.ts -t "sign and verify"` | ❌ W0 | ⬜ pending |
| 01-03-T2 | 01-03 | 3 | SPEC-06 | T-01-13 | Hash stable under key order and whitespace; golden vectors | unit | `pnpm exec vitest run packages/spec/test/canonical.test.ts -t "golden hash"` + sha256sum cross-check | ❌ W0 | ⬜ pending |
| 01-03-T3 | 01-03 | 3 | SPEC-06 | T-01-11, T-01-12, T-01-14, T-01-15 | Publisher-scoped keys, alg pinned, size cap, no key material in errors | unit | `pnpm exec vitest run packages/spec/test/envelope.test.ts packages/spec/test/envelope-vectors.test.ts packages/spec/test/brand.test.ts` | ❌ W0 | ⬜ pending |
| 01-04-T1..T3 | 01-04 | 2 | SPEC-01 | T-01-19, T-01-20 | No agent actor; attested never shown as verified | smoke | `pnpm check:alp` plus mutation negative checks | ❌ W0 | ⬜ pending |
| 01-05-T1..T2 | 01-05 | 4 | SPEC-01, SPEC-02, SPEC-06 | T-01-21, T-01-25 | Spec example bound to vector; signing input documented | smoke | `pnpm check:alp` plus mutation negative checks | ❌ W0 | ⬜ pending |

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
- [ ] Build-script policy recorded in `pnpm-workspace.yaml` as `strictDepBuilds: true` plus an explicit `allowBuilds` map (pnpm 11+ removed `onlyBuiltDependencies`; verified at pnpm.io/settings/build)
- [ ] `packages/spec/test/license.test.ts`, `packages/spec/test/vectors.test.ts`, `packages/spec/test/codegen.test.ts`, `packages/spec/test/envelope-vectors.test.ts`, `packages/spec/test/brand.test.ts`
- [ ] `scripts/check-alp-sections.mjs` with `--file` option

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
