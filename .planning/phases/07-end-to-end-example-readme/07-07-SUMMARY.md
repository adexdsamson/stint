---
phase: 07-end-to-end-example-readme
plan: 07
subsystem: example
tags: [e2e, deny-by-default, approvals, revoke, partial-teardown, idempotent-retry, receipts]
requires:
  - phase: 07-end-to-end-example-readme
    provides: "07-06 runScenario harness (agent stub, scripted adapter, scenario knobs) and the happy-path e2e"
provides:
  - "e2e.scope-approval.test.ts: out-of-scope denial plus approve/deny/timeout approvals"
  - "e2e.revoke-midrun.test.ts: user revoke mid-run to cleaned_up and a denied post-revoke call"
  - "e2e.partial-teardown.test.ts: cleanup-hook 500 to cleanup_incomplete (exit 7) and idempotent retry to cleaned_up"
affects: [07-08, 07-09]
estimate:
  tokens: 52000
  raw_tokens: 32500
  tasks: 3
  confidence: low
actuals:
  tokens: 4300
  tasks: 3
  commits: 3
plan_head_before: efd3bee66f348666ad986afbda1f5626acd4c3a4
commits: 3
tech-stack:
  added: []
  patterns:
    - "Distinct cleanup jtis are observed with a pass-through spy on global fetch that decodes each bearer's (non-secret) jti claim, since the publisher mock only remembers accepted jtis"
    - "A failing first teardown and a retrying one are two separate scenarios, so the intermediate state (cleanup_incomplete, per-step progress) is asserted directly rather than inferred"
key-files:
  created:
    - examples/payment-reconciler/test/e2e.scope-approval.test.ts
    - examples/payment-reconciler/test/e2e.revoke-midrun.test.ts
    - examples/payment-reconciler/test/e2e.partial-teardown.test.ts
  modified: []
key-decisions:
  - "No edits to the shared harness: all three files are new tests that only call runScenario."
requirements-completed: [E2E-02]
status: complete
---

# Phase 7 Plan 7: Scope, approval, revoke and partial-teardown e2e Summary

**The four remaining E2E-02 scenarios (denied out-of-scope call, approve/deny/timeout approvals, user revoke mid-run, and a partial teardown that retries idempotently) pass deterministically through the shipped runtime, with zero customer-service hits on every denial and no harness changes.**

## Accomplishments
- Task 1 (tracer): ungranted `pay`-class `issue_refund` is absent from `tools/list`, returns `denied: no_binding`, produces no Paystack or sheet traffic, and leaves one denied receipt against resource `unresolved`; a later in-scope call still works and the lease stays active. Approvals: approved `mark_order_reconciled` writes the sheet with a Bearer token; the refused one returns `denied: user_denied` with no write and an unchanged row; receipts read `allowed, denied`. An unanswered approval (`hang`, 1s timeout) denies with a timeout reason and no write. Tracer gate (scoped test re-run after the final edit) passed before expanding.
- Task 2: `stint revoke` mid-run exits 0 and the lease reaches `cleaned_up` with all five teardown steps; the next agent call is `denied: lease_not_active` with no service hit and a denied receipt as the last verified entry; the `revoke` transition's actor is `user`; `stint verify` exits 0.
- Task 3: with the cleanup hook failing once, the first teardown exits 7 and lands `cleanup_incomplete` with progress `revoke_oauth: revoked, invalidate_license: ok, cleanup_hook: failed, delete_cached_data: ok, final_receipt: ok`. With retry, `stint cleanup` exits 0 and reaches `cleaned_up` with `cleanup_hook: attested_ok`; `/revoke` and `/license/invalidate` totals equal an uninterrupted teardown and, on the wire, nothing but the hook is called after the first cleanup attempt; two cleanup attempts carry distinct jtis and the publisher accepted only the second; the transition sequence after `revoke` is `revoked, tearing_down, cleanup_incomplete, tearing_down, cleaned_up` (never `active`, never actor `agent`).

## Verification evidence
- Scoped `e2e.scope-approval`, `e2e.revoke-midrun` and `e2e.partial-teardown`: 12 tests pass (re-run twice, stable). `eslint` over `examples/payment-reconciler/test` and `tsc -b examples/payment-reconciler` are clean; `git diff --stat` versus the plan base touches only the three test files.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Plan inaccuracy] AS `/revoke` is hit once per grant, not once in total**
- **Found during:** Task 2
- **Issue:** The plan and VALIDATION row say "AS `/revoke` hit exactly once", but the scenario acquires two grants (Paystack and the orders sheet), and teardown correctly revokes each once, so `revokeHits` is 2.
- **Fix:** The test asserts `revokeHits` equals the number of acquired grants (2): exactly one revoke per grant, none from the post-revoke denied call, none extra.
- **Files modified:** examples/payment-reconciler/test/e2e.revoke-midrun.test.ts
- **Commit:** 4470350

**2. [Rule 3 - Blocking] The distinct-jti assertion needed an observation point the harness does not expose**
- **Found during:** Task 3
- **Issue:** The publisher mock records only ACCEPTED jtis (`seenJtis`), so the failed first attempt's token is invisible and two distinct jtis could not be shown from `runScenario`'s observables. The prohibition forbids editing the harness.
- **Fix:** The test wraps `globalThis.fetch` with a pass-through `vi.spyOn`, decodes each cleanup bearer's `jti` claim (not a secret), and asserts two distinct jtis with only the second accepted.
- **Files modified:** examples/payment-reconciler/test/e2e.partial-teardown.test.ts
- **Commit:** 9268753

**3. [Rule 1 - Test expectation] A failed-predicate verification is itself a denied call receipt**
- **Found during:** Task 1
- **Issue:** My first draft ended the out-of-scope scenario with `verify`; the verifier's `predicate_false` (no write happened) is correctly receipted as a denied call, so the "exactly one denied receipt" assertion saw two.
- **Fix:** The scenario ends with `none`, so the single denied receipt is the `no_binding` one.
- **Files modified:** examples/payment-reconciler/test/e2e.scope-approval.test.ts
- **Commit:** e2885ba

## Known Stubs
None.

## Threat Flags
None. Test-only additions over loopback; the plan's register (T-07-SCOPE, T-07-APPROVAL, T-07-REPLAY, T-07-STALE) is asserted by the tests above.

## Self-Check: PASSED
- Files present: the three test files.
- Commits present: e2885ba, 4470350, 9268753.
