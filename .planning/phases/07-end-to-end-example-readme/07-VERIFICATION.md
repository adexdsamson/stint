---
phase: 07-end-to-end-example-readme
verified: 2026-09-30T18:40:00Z
status: human_needed
score: 8/8 must-haves verified
covered_files:
  - README.md
  - examples/payment-reconciler/src/launcher.ts
  - examples/payment-reconciler/src/scenario.ts
  - examples/payment-reconciler/test/e2e.happy.test.ts
  - examples/payment-reconciler/test/readme.test.ts
  - packages/cli/src/run/loopback.ts
  - packages/cli/src/run/run-lease.ts
  - packages/core/src/license-issuer.ts
covered_digest: "v1:sha256:3b2367e2ae4d2e813bc49d54bb954891bed420c96837ad79b020bb69163580fe"
behavior_unverified: 0
overrides_applied: 0
human_verification:
  - test: "On a live Windows console (and a POSIX tty), run packages/cli/manual/mcp-call-visible.mjs per packages/cli/manual/README.md, then `pnpm example:payment-reconciler` from a real terminal. Answer the approval prompt y, then n, then let it time out."
    expected: "The approval prompt is visible in the same console; y approves the write, n denies (denied: user_denied), no answer denies by timeout. The quickstart's consent prompt also renders."
    why_human: "CI cannot provide a controlling terminal. The windowsHide:false spawn option is unit-pinned and the no-tty fail-safe is automated, but a real visible console prompt cannot be exercised by a test."
---

# Phase 7: End-to-End Example & README Verification Report

**Phase Goal:** The payment-reconciler example proves the whole runtime end to end in hybrid mode, and a newcomer can understand Stint and run the quickstart from the README as written.
**Verified:** 2026-09-30
**Status:** human_needed (all automated truths verified; the real-console approval prompt is an inherent human check)
**Re-verification:** No, initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | E2E-01: example runs hybrid, licensed by a mock publisher, reads mocked Paystack via real OAuth, writes to a mocked orders sheet, entirely through the proxy | VERIFIED | `src/scenario.ts` runs headless PKCE against `startMockAuthServer`, `stint create --publisher`, `runLease` (shipped proxy) behind `InMemoryTransport`, loopback Paystack/sheet mocks. `e2e.happy.test.ts` asserts Bearer-bearing hits on both services, sheet row `reconciled`, >=3 token-endpoint hits, license issued by the publisher. Re-run by me: 9 files / 41 tests pass. |
| 2 | Secrets: access token and license never reach agent-visible output, receipts, CLI output or the store; license never reaches a customer service (LIC-05) | VERIFIED | Happy test scans `results`, `toolNames`, both receipt chains, `cliOutput`, and the full store text against the real bearer tokens the services received plus every issued `v4.public.` token; `assertNoLicenseLeak` over both services. Scan has teeth (asserts bearers are in the secret set). |
| 3 | E2E-02 happy: `completed` via verifier only, then `cleaned_up`, all five steps recorded, `stint verify` passes | VERIFIED | Happy test: transition actor `verifier`/event `outcome_verified`, no completion tool exposed, no `agent` actor anywhere, `teardownProgress` all five steps, `verify` exit 0. Extra case: guessed `complete_lease`/`verify_outcome`/`done` are denied and the lease stays `active`. |
| 4 | E2E-02 denied out-of-scope and approval (approve + deny + timeout) | VERIFIED | `e2e.scope-approval.test.ts`: ungranted `issue_refund` absent from `tools/list`, `denied: no_binding`, zero Paystack hits, denied receipt; approve updates sheet with bearer, deny gives `denied: user_denied` with no write, hang gives timeout denial with no write. |
| 5 | E2E-02 user revoke mid-run | VERIFIED | `e2e.revoke-midrun.test.ts`: `stint revoke` actor `user`, `cleaned_up`, next call `denied: lease_not_active` with no service hit, AS `/revoke` hit exactly once per grant, chains verify. |
| 6 | E2E-02 partial teardown -> `cleanup_incomplete` -> idempotent retry (TEAR-04) | VERIFIED | `e2e.partial-teardown.test.ts`: hook 500 gives exit 7, `cleanup_incomplete`, per-step record; retry exit 0, `cleaned_up`; revoke/invalidate never re-run (wire order and counters); two distinct cleanup jtis; transition sequence never returns to `active`. Deterministic: loopback port 0, per-scenario mkdtemp, injected clock, no sleeps, scripted adapter (tty-free). |
| 7 | DOC-01: README has four sections in order, `pnpm example:payment-reconciler` verbatim equals a real script, pinned by a drift test | VERIFIED | README `##` order: The problem, Auth modes (hybrid default), Trust limits of hosted mode (four spec s13 limits plus v0.1 attested note), Quickstart. Root `package.json` script `example:payment-reconciler` -> `@stint/example-payment-reconciler start` -> `node dist/quickstart.js`. `readme.test.ts` pins section order, exact fenced `pnpm` commands, real `stint` subcommands. I ran the verbatim command: exit 0, merged timeline, ends `finished: cleaned_up (publisher cleanup attested)`. |
| 8 | Research decisions D-14..D-19 | VERIFIED | See below. |

**Score:** 8/8 truths verified (0 present-behavior-unverified)

### Research-decision checks (D-14..D-19)

| Decision | Evidence | Status |
|----------|----------|--------|
| D-14 additive `@stint/core/license-issuer` subpath; `mintHeldLicense`/`issueLicense`/`createMockLicenseIssuer` off root | `packages/core/package.json` exports `./license-issuer`; `src/license-issuer.ts` exports reference issuer + `createLicenseIssuerClient` + PASERK helpers; `src/index.ts` mentions the three only in a "deliberately NOT re-exported" comment; no export. | VERIFIED |
| D-16 loopback-derived `allowInsecureRequests` + mandatory non-loopback negative test | `run/loopback.ts` `isLoopbackHttp` (http AND host in localhost/127.0.0.1/[::1]); used in `run-lease.ts:280`, `teardown-support.ts`, `profile.ts`, `publisher-binding.ts`. `packages/cli/test/loopback.test.ts` has "MANDATORY negative: non-loopback http AS still refused", https, lookalike-host and unparseable cases (8/8 pass, re-run). | VERIFIED |
| D-15 host-side `RunningLease.verifyOutcome()` the agent cannot invoke | `run-lease.ts:349` host method returned in `RunningLease`; not registered as an MCP tool; happy test asserts tool list is exactly the three governed tools and no completion-named tool. | VERIFIED |
| D-08/D-09 visible-console launcher `windowsHide:false` with guard test | `src/launcher.ts:75` hard-codes `windowsHide:false`; `quickstart.ts` uses it; `launcher.test.ts` spy-spawn asserts `windowsHide:false`, `shell` not true, piped stdio. Built-bin smoke proves no-tty fail-safe (deny by timeout, stdout protocol-clean, no secrets). | VERIFIED |
| D-17/D-18/D-19 | README documents v0.1 limits and `[verified]` + `cleanup_hook: attested_ok` marker honestly; two-issue model evidenced by `issueHits` counts in refresh test. | VERIFIED |

### Required Artifacts

| Artifact | Status | Details |
|----------|--------|---------|
| `examples/payment-reconciler/` (src, mocks, oauth, tests, config) | VERIFIED | Substantive (scenario 445 lines, publisher 258, services 231); wired to shipped `@stint/cli`/`proxy`/`core`. |
| `README.md` | VERIFIED | 96 lines, four sections, no `TBD`/`FIXME`/`XXX`. |
| Root scripts `test:e2e`, `example:payment-reconciler` | VERIFIED | Present; CI runs `pnpm test:e2e` on an ubuntu + windows, Node 22.18/24 matrix. |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Example e2e suite | `pnpm --filter @stint/example-payment-reconciler exec vitest run --pool=threads` | 9 files, 41 tests passed | PASS |
| Verbatim quickstart | `pnpm example:payment-reconciler` (no tty) | exit 0; timeline ends `cleaned_up` | PASS |
| Loopback rule incl. negative | `vitest run test/loopback.test.ts` (packages/cli) | 8/8 | PASS |

### Requirements Coverage

| Requirement | Description | Status | Evidence |
|-------------|-------------|--------|----------|
| E2E-01 | Hybrid example: mock publisher, Paystack via OAuth, orders sheet | SATISFIED | Truths 1, 2 |
| E2E-02 | E2E: happy, denied, approval, revoke mid-run, partial teardown | SATISFIED | Truths 3-6 |
| DOC-01 | README: problem, three modes, hosted trust limits, working quickstart | SATISFIED | Truth 7 |

No orphaned requirements: REQUIREMENTS.md maps only E2E-01, E2E-02, DOC-01 to Phase 7.

### Anti-Patterns Found

None blocking. No debt markers in the phase's README/example sources or the checked core/cli files. Stub scan: no static-return or placeholder paths on the rendered/agent-visible data path; service mocks are intentionally mocks per D-06.

### Advisory notes (non-blocking)

1. CI runs `pnpm test:e2e` but not the verbatim `pnpm example:payment-reconciler`. The drift test pins the script wiring and I ran it once manually successfully, so the gap is minor; adding the command as a CI step would fully close the "works as written" loop on the Windows leg.
2. D-09 asked for a unit test that a hidden-console spawn denies by timeout. The launcher test pins `windowsHide:false`; the deny-by-timeout direction is covered by the built-bin smoke (no console answering) rather than a dedicated hidden-spawn test. Fail-safe property is exercised, so not a gap.
3. The quickstart timeline shows `revoke_oauth: revoked` three times for two acquired grants (per-grant/per-resource receipt entries from the Phase 5 teardown step). Cosmetic; AS `/revoke` hits are asserted exact (one per grant) in tests.

### Human Verification Required

#### 1. Real-console approval prompt (HOST-02 / D-08)

**Test:** On a live Windows console and a POSIX tty, run `packages/cli/manual/mcp-call-visible.mjs` per `packages/cli/manual/README.md`, and run `pnpm example:payment-reconciler` from a real terminal; answer y, n, and let one time out.
**Expected:** The prompt is visible in the same console; y approves, n denies (`denied: user_denied`), no answer denies by timeout.
**Why human:** CI cannot provide a controlling terminal; automated tests pin the spawn option and the no-tty fail-safe only.

### Gaps Summary

No gaps. Every must-have is backed by source and by a test I re-ran. The phase goal is achieved; the only open item is the inherently manual real-console prompt check (carried as in Phase 6).

---

_Verified: 2026-09-30_
_Verifier: Claude (gsd-verifier)_
