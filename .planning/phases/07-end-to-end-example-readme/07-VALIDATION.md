---
phase: "7"
slug: "end-to-end-example-readme"
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-09-30"
---

# Phase 7 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Seeded from 07-RESEARCH.md § Validation Architecture. Per-task rows are completed during planning/validate-phase.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 5.0.2 |
| **Config file** | `examples/payment-reconciler/vitest.config.ts` (new — Wave 0); root `vitest.config.ts` (`projects: ["packages/*"]`) stays unchanged so units and e2e remain separate |
| **Quick run command** | `npx --yes pnpm@12.6.0 --filter @stint/example-payment-reconciler exec vitest run <file>` |
| **Full suite command** | `npx --yes pnpm@12.6.0 test:e2e` (root script → example package `vitest run`) |
| **Estimated runtime** | ~30–90 seconds (loopback servers, no sleeps; per-scenario mkdtemp store) |

---

## Sampling Rate

- **After every task commit:** scoped vitest for the touched test file (per memory: never whole-repo — OOM).
- **After every plan wave:** `--filter @stint/example-payment-reconciler exec vitest run` plus scoped `packages/cli`/`packages/core`/`packages/proxy` runs for edited packages.
- **Before `/gsd-verify-work`:** `pnpm test:e2e` green on ubuntu + windows legs; manual `packages/cli/manual/` visible-console check recorded in UAT.
- **Max feedback latency:** ~90 seconds (single e2e file).

Determinism rules (from research): port `0` on `127.0.0.1`; per-scenario `mkdtemp` store; one shared injected clock; approval timeouts 1–2s only where a timeout is the assertion; OAuth expiry forced via `expires_in` mutation on the mock AS.

---

## Per-Task Verification Map

*Requirement-level seed (task IDs assigned during planning). Every row is a Wave 0 gap — nothing exists yet.*

| Req / Behavior | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|----------------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| Hybrid happy: PKCE acquire → license issued → Paystack read → orders write; token never in agent output, license never at any mock service | E2E-01 | T-secrets | no `v4.public.` / access-token substring in agent-visible results or receipts | e2e (in-process) | `vitest run test/e2e.happy.test.ts` | ❌ W0 | ⬜ pending |
| Happy → `completed` (verifyOutcome) → teardown → `cleaned_up`; all 5 steps recorded; `stint verify` passes | E2E-02 | — | verifier runtime-run, agent cannot invoke | e2e | `vitest run test/e2e.happy.test.ts` | ❌ W0 | ⬜ pending |
| Out-of-scope call → `denied: no_binding`; absent from `tools/list`; zero mock hits; denied receipt | E2E-02 | T-scope | deny-by-default | e2e | `vitest run test/e2e.scope-approval.test.ts` | ❌ W0 | ⬜ pending |
| Approval call → scripted approve → sheet updated; scripted deny → `denied: user_denied`, no hit | E2E-02 / PRXY-05 | T-approval | approval bound to args/binding/lease-version hash; timeout denies | e2e | `vitest run test/e2e.scope-approval.test.ts` | ❌ W0 | ⬜ pending |
| Revoke mid-run → `cleaned_up`; next call `denied: lease_not_active`; AS `/revoke` hit once | E2E-02 | — | user-actor revoke auto-chains teardown | e2e | `vitest run test/e2e.revoke-midrun.test.ts` | ❌ W0 | ⬜ pending |
| Cleanup-hook 500 → exit 7, `cleanup_incomplete`, per-step progress; flip → `cleanup` → `cleaned_up`; two distinct jtis | E2E-02 / TEAR-04 | — | idempotent retry, never returns to active | e2e | `vitest run test/e2e.partial-teardown.test.ts` | ❌ W0 | ⬜ pending |
| Built `dist/bin.js` boots over stdio; `tools/list` + one call; approval denies by timeout; stdout protocol-clean | D-03 | — | no secrets on stdout (MCP channel) | smoke | `vitest run test/smoke.built-bin.test.ts` | ❌ W0 | ⬜ pending |
| Launcher spawns with `windowsHide:false`; hidden-console spawn denies by timeout | D-09 | — | fail-safe deny on hidden console | unit | `vitest run test/launcher.test.ts` | ❌ W0 | ⬜ pending |
| License verifies offline; refresh clamped ≤ lease expiry; refused after lease end / after invalidate; never sent to a mock service | LIC-01/02/03/05 | T-secrets | license never to customer resources / agent | e2e + unit | covered in happy + a license-refresh case | ❌ W0 | ⬜ pending |
| Non-loopback `http://` AS still refused (loopback-derived allowInsecureRequests) | D-16 | T-insecure-transport | insecure allowed only for loopback | unit | scoped `packages/cli` test | ❌ W0 | ⬜ pending |
| README has the four sections in order; quickstart commands equal package scripts; verbatim command exits 0 | DOC-01 | — | — | docs test + CI step | `vitest run test/readme.test.ts` + CI `pnpm example:payment-reconciler` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `examples/payment-reconciler/` package skeleton (package.json, tsconfig, tsdown, `vitest.config.ts`) + `pnpm-workspace.yaml` `examples/*` entry + root `tsconfig.json` reference + root `test:e2e`/`example:payment-reconciler` scripts + CI `pnpm test:e2e` step; regenerate `pnpm-lock.yaml`
- [ ] Shared test fixtures: mock services (Paystack read / orders sheet write), mock publisher (issue/reissue/invalidate/cleanup + failure toggle), OAuth acquisition module, visible-console launcher, scenario orchestration
- [ ] Additive `@stint/core` vitest-free reference-issuer subpath + `createLicenseIssuerClient`; additive `@stint/proxy/testing` `forceNextExpiresIn` (+ optional revoke counter)
- [ ] CLI edits (D-14): hybrid predicate, loopback-derived `allowInsecureRequests`, `runLease` extensions (license custody + refresh stage, teardown steps, endpoints map, `verifyOutcome`), `create --publisher` + persistence, publisher-aware teardown-support, barrel exports

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Real visible-console approval prompt (y/n/timeout) on a live Windows console / POSIX tty | HOST-02 / D-08 | Requires an interactive terminal CI cannot provide | Run `packages/cli/manual/mcp-call-visible.mjs` per `packages/cli/manual/README.md`; record y-approve, n-deny, timeout-deny in UAT |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 90s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
