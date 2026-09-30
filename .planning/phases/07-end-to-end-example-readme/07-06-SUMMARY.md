---
phase: 07-end-to-end-example-readme
plan: 06
subsystem: example
tags: [e2e, tracer, agent-stub, scripted-adapter, scenario, hybrid, license-custody, receipts]
requires:
  - phase: 07-end-to-end-example-readme
    provides: "07-04 runLease hybrid composition and RunningLease.verifyOutcome; 07-05 fixtures (acquire, mock publisher, service mocks, signed manifest, run profile)"
provides:
  - "runAgent / connectAgent: a real MCP Client over an injected Transport, holding no credentials and no license"
  - "createScriptedAdapter: propose-only HostAdapter (consent, ordered approvals incl. hang, outcome) with request and notify recorders"
  - "runScenario: reusable in-process orchestrator (verify / revoke / expire-cleanup ends, failed-cleanup + retry, post-end call, short-lived token, step hooks over a shared clock) returning plain-value observables"
  - "e2e.happy.test.ts: hybrid happy path to cleaned_up plus secret/license/LIC-02/LIC-03/verifier-only assertions"
affects: [07-07, 07-08, 07-09]
estimate:
  tokens: 64000
  raw_tokens: 40000
  tasks: 2
  confidence: low
actuals:
  tokens: 10500
  tasks: 2
  commits: 3
plan_head_before: c30d1c8772af31d3c55be10f0173d5b295eba3d5
commits: 3
tech-stack:
  added: []
  patterns:
    - "runScenario returns snapshots (arrays copied, counters read) so every observable is safe to read after all servers stopped"
    - "Step hooks receive live handles (shared clock, AS, publisher, services, manifest) so a test moves time or arms a one-shot fault without sleeping"
    - "Scan for secrets over every agent-visible and persisted surface using the real bearer tokens the services received, not just fixtures"
key-files:
  created:
    - examples/payment-reconciler/src/agent.ts
    - examples/payment-reconciler/src/scripted-adapter.ts
    - examples/payment-reconciler/src/scenario.ts
    - examples/payment-reconciler/test/e2e.happy.test.ts
  modified:
    - packages/proxy/src/verification/resource-query.ts
    - packages/proxy/src/verification/user-confirm.ts
    - packages/proxy/test/verification.test.ts
key-decisions:
  - "The shared clock is one mutable object (`now`, `advance`) read by the runtime, the publisher and credential acquisition; scenario step hooks move it, so license refresh and lease-expiry clamping are driven without sleeping."
  - "The scenario places the trust file and manifest in the store root (so `stint verify` finds the trust entry) and keeps credentials in a sibling directory, so a whole-store scan for secrets is meaningful."
  - "The verifier's completion is now receipted as its own transition (actor verifier), and the verification receipt precedes it, so the merged timeline ends in the terminal state (see deviation 1)."
requirements-completed: [E2E-01, E2E-02]
status: complete
---

# Phase 7 Plan 6: Agent stub, scripted adapter and runScenario Summary

**The hybrid happy path now runs end to end in one process through the shipped runtime (PKCE acquisition, license issued and held, Paystack read, approved orders write, host-side verifier, teardown) to `cleaned_up`, with the security invariants asserted and a reusable agent/adapter/scenario harness ready for the remaining scenarios.**

## Accomplishments
- Task 1 (tracer): `agent.ts` (real MCP `Client`, transport-only, no license/vault imports), `scripted-adapter.ts` (answers consent, per-call approvals in order, outcome confirmation; records everything; an unscripted approval throws so core folds it to deny; `"hang"` lets core's own timeout be the assertion) and `scenario.ts` (`runScenario`). The happy scenario creates a hybrid lease with `stint create --publisher`, pins the runtime key on the publisher, serves the lease through `runLease` behind an `InMemoryTransport` pair, runs the agent script, ends through `verifyOutcome()`, and returns the final lease, both receipt chains, the merged timeline, service recorders, AS/publisher counters, exit codes and CLI output. Tracer gate (build plus the scoped test) passed before expanding.
- Task 2: eight scoped tests. Secret non-leak across agent results, tool names, both receipt chains, CLI output and the whole store directory (using the real bearer tokens the services received); `assertNoLicenseLeak` on both recorders; LIC-02 offline verification of every issued license; LIC-03 refresh clamp via a clock hook (two reissues, the last clamped exactly to lease expiry); no completion tool, completed transition actor `verifier`, guessed `complete_lease`/`verify_outcome`/`done` tools denied with the lease still `active`; five teardown steps, the `cleanup_hook: attested_ok` marker, `stint verify` exit 0 and `[verified]` in the receipts timeline.

## Verification evidence
- Happy run: lease `cleaned_up`; teardown progress `revoke_oauth: revoked, invalidate_license: ok, cleanup_hook: attested_ok, delete_cached_data: ok, final_receipt: ok`; Paystack saw one bearer-authorized request; the sheet saw read, write, verifier read in that order; the scripted adapter was asked exactly once (the irreversible write); publisher saw 2 issues, 1 invalidation, 1 accepted single-use cleanup call.
- Refresh scenario: `issueHits` 2, `reissueHits` 2; issued license expiries were `NOW+300, NOW+300, NOW+550, expiresAt` (the last would have been `expiresAt+200` unclamped); the expired Paystack token refreshed over the loopback AS (`tokenEndpointHits >= 3`).
- Scoped `e2e.happy.test.ts`, `fixtures.test.ts` and `skeleton.test.ts`: 21 tests pass. `tsc -b examples/payment-reconciler`, eslint and the build are clean. Proxy `verification.test.ts` and `teardown-receipts-survive.test.ts` (18 tests) and cli `run-lease-verify`, `run-approvals`, `run-lease-hybrid` (36 tests) pass after the runtime fix.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Verifier completion was not receipted and the trail did not end in the terminal state**
- **Found during:** Task 1 (the plan's "merged timeline ends in the terminal state" and "completed transition actor is verifier" assertions)
- **Issue:** `completeViaVerifier` folded `outcome_verified` and the chained `begin_teardown` into one transition mutator, so only `completed -> tearing_down` (actor runtime) was receipted: the verifier's own `active -> completed` act never reached the signed trail. The verification receipt was also appended after `cleaned_up`, so the last timeline entry was a call receipt, not the terminal transition.
- **Fix:** `completeViaVerifier` now applies and receipts the two transitions separately (`verifier:outcome_verified active>completed`, then `runtime:begin_teardown completed>tearing_down`); both `runResourceQueryVerification` and `runUserConfirmVerification` append the verification receipt before the completion it triggers. `verification.test.ts` asserts the ordered transitions, the receipt order and the terminal last entry.
- **Files modified:** packages/proxy/src/verification/resource-query.ts, packages/proxy/src/verification/user-confirm.ts, packages/proxy/test/verification.test.ts
- **Commit:** e6e8785

## Notes for downstream plans
- Pre-existing, left as is: `revoke_oauth` appears as three `teardown_step` receipts for two grants (one per resource plus the orchestrator's own); all three say `revoked`. Not asserted on in this plan.
- Pre-existing prettier drift in `packages/proxy/src/verification/*.ts` and `verification.test.ts` (dirty at HEAD before this plan); not reformatted to keep the diff scoped.
- `runScenario` covers the knobs plans 07-07 needs (`end`, `approvals` incl. `"hang"`, `consent`, `approvalTimeoutSeconds`, `failNextCleanup`, `retryCleanup`, `postEndCall`, `forceShortAccessTokenLifetime`, step `before` hooks, and a `cli()` for store-local commands). The mock AS binds `localhost` (from `@stint/proxy/testing`), the other servers `127.0.0.1`.
- `packages/cli/src/deps.ts` still shows as modified with an empty diff (pre-existing working-tree noise); untouched.

## Known Stubs
None.

## Threat Flags
None. The only new surface is test/example code over loopback; the plan's threat register (T-07-SECRETS, T-07-LIC, T-07-COMPLETE, T-07-CLOCK, T-07-APPROVAL) is asserted by the tests above.

## Self-Check: PASSED
- Files present: agent.ts, scripted-adapter.ts, scenario.ts, e2e.happy.test.ts, resource-query.ts, user-confirm.ts, verification.test.ts.
- Commits present: e6e8785, 6fe91e1, 2737eaf.
