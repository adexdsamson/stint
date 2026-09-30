---
phase: 04-mcp-proxy-credential-vault
plan: 07
subsystem: auth
tags: [oauth, credential-vault, mcp-proxy, revocation, lease-lifecycle, typescript]

# Dependency graph
requires:
  - phase: 04-mcp-proxy-credential-vault
    plan: 05
    provides: "vault/credential-vault.ts's CredentialRefreshError(kind: provider_revoked | transient_error) -- D-09's classification this plan's dispatch branch consumes"
  - phase: 04-mcp-proxy-credential-vault
    plan: 06
    provides: "vault/execute-stage.ts's createVaultExecuteStage, which deliberately lets CredentialRefreshError propagate UNCHANGED past the ExecuteStage seam for this plan to catch"
provides:
  - "packages/proxy/src/revocation.ts: applyProviderRevocation(lease, now) -- thin reduce()+providerEvents.grantRevoked() wrapper; isProviderRevocation(kind) -- the provider_revoked/transient_error discriminator"
  - "packages/proxy/src/dispatch.ts: handleCall's catch block classifies a thrown CredentialRefreshError BEFORE the generic execute_failed path -- provider_revoked revokes+denies, transient_error denies-only"
  - "packages/core/src/policy.ts: evaluatePolicy now denies lease_not_active (Step 2, before expiry/caps) for any lease not in the active state -- closes the deny-by-default gap PRXY-07's must_have depends on"
affects: [05-teardown-outcome-verification]

# Actuals (#2632)
actuals:
  tokens: 6600
  tasks: 2
  commits: 4

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "revocation.ts is a single, narrow bridge module: it imports ONLY reduce + providerEvents from @stint/core (never a broader slice of the events module) and is the sole call site dispatch.ts uses to advance lease state on a provider signal -- mirrors the existing 'thin wrapper over a locked-upstream primitive' shape (approval-dispatcher.ts's computeApprovalHash, cap-enforcer.ts's window math)"
    - "dispatch.ts's catch block now classifies BEFORE falling through to the generic execute_failed branch: instanceof CredentialRefreshError is checked first, then err.kind discriminates provider_revoked (revoke + deny) from transient_error (deny only, lease returned UNCHANGED) -- the generic catch remains the fallback for every other thrown value"

key-files:
  created:
    - packages/proxy/src/revocation.ts
    - packages/proxy/test/revocation-detection.test.ts
  modified:
    - packages/proxy/src/dispatch.ts
    - packages/proxy/src/index.ts
    - packages/core/src/policy.ts
    - packages/core/test/policy.test.ts

key-decisions:
  - "Fixed a pre-existing deny-by-default gap in @stint/core/src/policy.ts (Rule 2 - missing critical functionality, not part of this plan's files_modified list): evaluatePolicy never checked lease.state at all, so a revoked/non-active lease's calls would still be evaluated against expiry/caps/approval and could be ALLOWED. This directly contradicted this plan's own must_have ('a subsequent tools/call on the now-revoked lease is denied by evaluatePolicy') and .planning/research/ARCHITECTURE.md's own illustrative pseudocode (line 158), which specified the check but it was dropped during Phase 2's actual implementation and never flagged. Added POLICY_REASON_CODES.lease_not_active (additive) and a Step 2 check (immediately after no_binding, before expiry) -- all 23 existing @stint/core test files use only state:'active' fixtures, so this was a zero-regression addition, not a behavior change to any tested path."
  - "isProviderRevocation(kind) is typed against Exclude<RefreshResult['kind'], 'ok'> (imported from vault/oauth-client.ts) rather than a locally re-declared union, so the dispatch-boundary discriminator is structurally tied to the 04-05 RefreshResult type it narrows -- CredentialRefreshError.kind satisfies the same type by construction, so one function serves both call shapes without a second parallel union."
  - "dispatch.ts's provider_revoked branch calls applyProviderRevocation(lease, now) against the TRANSACTION-LOADED lease (the mutator's own lease parameter, never a stale pre-transaction reference) and returns the resulting revoked lease from the mutator so LeaseStore.transaction saves it atomically with the single denied receipt for the triggering call -- both land in the same per-lease serialized step (D-13)."
  - "Task 1's dispatch-level proofs drive handleCall directly (not the full MCP Client/InMemoryTransport harness every other proxy test file uses) since they are dispatch-branch wiring proofs, not protocol proofs -- a synthetic CredentialRefreshError thrown from a stub ExecuteStage is sufficient and faster. Task 2 uses the full real-mock-AS + real-Client harness specifically because it needs to prove REACHABILITY through the actual oauth4webapi classification path, which Task 1's synthetic error cannot prove."

patterns-established:
  - "revocation.ts is the ONE sanctioned bridge from a vault-layer classification signal to a core lifecycle event -- any future signal needing to advance lease state (e.g. a future publisher-side signal) should follow the same shape: a thin reduce()-wrapping function, never a hand-rolled transition, imported only where the classification is caught."

requirements-completed: [PRXY-07]

coverage:
  - id: D1
    description: "applyProviderRevocation moves an active or granted lease to revoked with actor provider, event grant_revoked, via reduce(); a non-active/non-granted source state returns reduce's own illegal_transition rejection rather than throwing"
    requirement: PRXY-07
    verification:
      - kind: unit
        ref: "packages/proxy/test/revocation-detection.test.ts#applyProviderRevocation (3 tests: active->revoked, granted->revoked, illegal source state rejected)"
        status: pass
    human_judgment: false
  - id: D2
    description: "isProviderRevocation narrows provider_revoked (true) from transient_error (false), the exact discrimination dispatch.ts's catch block relies on"
    requirement: PRXY-07
    verification:
      - kind: unit
        ref: "packages/proxy/test/revocation-detection.test.ts#isProviderRevocation (2 tests)"
        status: pass
    human_judgment: false
  - id: D3
    description: "dispatch.ts's handleCall: a provider_revoked CredentialRefreshError applies applyProviderRevocation, saves the revoked lease inside the per-lease transaction, and denies the triggering call with exactly one receipt; a transient_error denies the call but leaves the lease active (never calls providerEvents.grantRevoked)"
    requirement: PRXY-07
    verification:
      - kind: integration
        ref: "packages/proxy/test/revocation-detection.test.ts#dispatch: applyProviderRevocation wiring (PRXY-07) (2 tests, driven via handleCall directly)"
        status: pass
    human_judgment: false
  - id: D4
    description: "End-to-end: a forced invalid_grant on a real oauth4webapi refresh against a real loopback oauth2-mock-server, driven through a real MCP Client tools/call, denies the call (provider_revoked) and revokes the lease (active->revoked); a SUBSEQUENT tools/call on the now-revoked lease is denied lease_not_active by evaluatePolicy; a forced transient (non-invalid_grant) refresh failure denies the call but leaves the lease active -- never revoked. No assertion depends on the mock's /revoke endpoint's 2xx."
    requirement: PRXY-07
    verification:
      - kind: integration
        ref: "packages/proxy/test/revocation-detection.test.ts#PRXY-07 end-to-end: real mock AS + MCP Client (2 tests)"
        status: pass
    human_judgment: false
  - id: D5
    description: "evaluatePolicy denies lease_not_active for any lease whose state is not active, checked immediately after no_binding and before expiry/caps/approval -- closes the deny-by-default gap the D4 subsequent-call assertion depends on"
    requirement: PRXY-07
    verification:
      - kind: unit
        ref: "packages/core/test/policy.test.ts#LEASE NOT ACTIVE (2 tests: revoked lease, granted/not-yet-activated lease)"
        status: pass
    human_judgment: false

# Metrics
duration: ~25min
completed: 2026-09-28
status: complete
---

# Phase 4 Plan 7: Lazy Customer-Side OAuth Revocation Detection Summary

**A forced `invalid_grant` on the outbound refresh hot path moves the lease `active -> revoked` (actor `provider`) and denies the triggering call inside the per-lease transaction, while a transient upstream blip never revokes -- proven end-to-end against a real `oauth4webapi` refresh, a real loopback `oauth2-mock-server`, and a real MCP `Client`.**

## Performance

- **Duration:** ~25 min
- **Started:** 2026-09-28 (session start)
- **Completed:** 2026-09-28
- **Tasks:** 2
- **Files modified:** 6 (2 created, 4 modified)

## Accomplishments
- `revocation.ts`'s `applyProviderRevocation(lease, now)` is a thin wrapper over `reduce(lease, providerEvents.grantRevoked(), now)` -- the ONE sanctioned provider-actor event constructor (D-19: the agent is never an actor). Legal from `active`/`granted`; any other source state returns `reduce`'s own `illegal_transition` rejection, never a throw. `isProviderRevocation(kind)` narrows the 04-05 `RefreshResult`'s failure kinds so the transient-vs-revocation discrimination is one boolean check.
- `dispatch.ts`'s `handleCall` catch block now classifies a thrown `CredentialRefreshError` BEFORE the generic `execute_failed` fallback: `provider_revoked` applies `applyProviderRevocation` to the transaction-loaded lease (saving `revoked`) and denies the call with reason `provider_revoked`; `transient_error` denies the call with reason `transient_error` and returns the lease UNCHANGED -- the revocation transition and the single `denied` receipt for the triggering call both land inside the ONE per-lease transaction (D-13).
- Fixed a pre-existing gap in `@stint/core/src/policy.ts`: `evaluatePolicy` never checked `lease.state`, so a revoked lease's calls would still reach expiry/caps/approval checks and could be `allow`ed -- a deny-by-default violation this plan's own must_have depends on closing. Added `POLICY_REASON_CODES.lease_not_active` and a new Step 2 check (immediately after `no_binding`, before expiry) with zero regressions across all 23 existing `@stint/core` test files (201 tests, all using `state: "active"` fixtures).
- End-to-end proof: a forced `invalid_grant` via `oauth2-mock-server`'s `Events.BeforeResponse` hook (never the mock's `/revoke` 200 no-op, per 04-RESEARCH.md Pitfall 2/5) on a real `oauth4webapi` refresh, driven through a real MCP `Client` `tools/call`, denies the triggering call (`provider_revoked`), revokes the lease, and a SUBSEQUENT `tools/call` on the now-revoked lease is denied `lease_not_active` -- proving the fix above actually closes the loop. A forced transient (`server_error`) refresh failure denies the call but leaves the lease `active`.
- 9/9 tests in `revocation-detection.test.ts`, full `@stint/proxy` suite (76/76), full `@stint/core` suite (201/201), workspace `tsc -b`, and `tsdown` builds all stay green.

## Task Commits

Each task was committed atomically (Task 1 followed TDD's RED->GREEN cycle per its `tdd="true"` attribute):

1. **Task 1 RED: failing tests for applyProviderRevocation + transient-vs-revocation dispatch wiring** - `d566b5b` (test)
2. **Task 1 GREEN: applyProviderRevocation + dispatch provider-revocation branch** - `dc7d53e` (feat)
3. **Deviation: evaluatePolicy denies lease_not_active** - `1c09340` (fix) -- Rule 2, required for this plan's own must_have; see Deviations below
4. **Task 2: forced-invalid_grant end-to-end revocation proof (PRXY-07)** - `9636cc0` (test)

**Plan metadata:** committed separately after this SUMMARY (see final metadata commit).

## Files Created/Modified
- `packages/proxy/src/revocation.ts` - NEW: `applyProviderRevocation`, `isProviderRevocation`
- `packages/proxy/src/dispatch.ts` - `handleCall`'s catch block classifies `CredentialRefreshError` (provider_revoked -> revoke+deny; transient_error -> deny only) before the generic `execute_failed` fallback
- `packages/proxy/src/index.ts` - barrel exports for `applyProviderRevocation`/`isProviderRevocation`, `PRXY-07`-annotated
- `packages/core/src/policy.ts` - `evaluatePolicy` Step 2: `lease.state !== "active"` -> `deny("lease_not_active")`; `POLICY_REASON_CODES` gains `lease_not_active`
- `packages/core/test/policy.test.ts` - 2 new tests for the `lease_not_active` deny path
- `packages/proxy/test/revocation-detection.test.ts` - NEW: 9 tests across 4 describe blocks (unit: `applyProviderRevocation`/`isProviderRevocation`; dispatch-level synthetic-error wiring; end-to-end real-mock-AS + real-Client revocation and transient-non-revocation proofs)

## Decisions Made
- Fixed the pre-existing `evaluatePolicy` deny-by-default gap (see key-decisions above for full rationale) -- a Rule 2 deviation touching a file outside this plan's declared `files_modified`, but directly required by this plan's own stated must_have and the project's core value proposition ("a prompt-injected or misbehaving agent can never act outside the lease... when the lease ends, for any reason, every credential is revoked").
- `isProviderRevocation`'s parameter type is tied to `Exclude<RefreshResult["kind"], "ok">` rather than a locally re-declared string union, keeping the dispatch-boundary discriminator structurally linked to the 04-05 classification it narrows.
- Task 1's dispatch-level proofs call `handleCall` directly with a synthetic `CredentialRefreshError` (faster, no MCP protocol scaffolding needed for a branch-wiring proof); Task 2 uses the full real-mock-AS + real-`Client` harness specifically to prove reachability through the actual `oauth4webapi`/`oauth.ResponseBodyError` classification path.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `Promise.reject(err)` with an `unknown`-typed parameter tripped `@typescript-eslint/prefer-promise-reject-errors`**
- **Found during:** Task 1 (scoped `eslint` pass on the new test file)
- **Issue:** `makeThrowingExecuteStage(err: unknown)` rejecting with a statically-`unknown`-typed value triggered the lint rule even though every call site passes a real `Error` instance (`CredentialRefreshError`).
- **Fix:** Narrowed the parameter type to `Error`.
- **Files modified:** `packages/proxy/test/revocation-detection.test.ts`
- **Verification:** scoped `eslint` clean; test still passes.
- **Committed in:** `dc7d53e` (folded into Task 1's GREEN commit, since the fix was discovered before the commit)

**2. [Rule 2 - Missing Critical] `evaluatePolicy` never checked `lease.state`, permitting calls on a revoked lease**
- **Found during:** Task 2 planning (deriving the "subsequent call denied" assertion required by this plan's must_have)
- **Issue:** See key-decisions above. Full detail in commit `1c09340`'s message.
- **Fix:** Added `POLICY_REASON_CODES.lease_not_active` and an `evaluatePolicy` Step 2 check.
- **Files modified:** `packages/core/src/policy.ts`, `packages/core/test/policy.test.ts`
- **Verification:** Full `@stint/core` suite (201/201, all 23 test files) and full `@stint/proxy` suite (76/76) green; workspace `tsc -b` clean.
- **Committed in:** `1c09340` (standalone commit, since it precedes and is a prerequisite for Task 2's E2E proof)

---

**Total deviations:** 2 auto-fixed (1 blocking/lint-only, 1 missing-critical/deny-by-default security gap)
**Impact on plan:** The lint fix is cosmetic. The `lease_not_active` fix closes a real security gap that predates this plan (dropped during Phase 2) and was directly required by this plan's own must_have -- necessary for correctness, not scope creep.

## Issues Encountered
None beyond the two deviations above. Both tasks' `<verify>` commands (run exactly as specified in PLAN.md, including the root-level `pnpm build` + filtered/unfiltered `vitest run`) passed on their respective implementation runs. The full `@stint/proxy` suite was re-run three times across the session (after Task 1's fixes, after the `lease_not_active` fix, and after Task 2) with no flakiness in the mock-AS-backed tests.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- PRXY-07 is fully satisfied: lazy customer-side OAuth revocation detection is wired end-to-end from the outbound refresh hot path through to lease state and deny-by-default enforcement on any subsequent call.
- This is the phase's final plan (04-07 of 7). Phase 4 (MCP Proxy & Credential Vault) is now complete: PRXY-01 through PRXY-08 and LIC-05 are all satisfied.
- **Flagged for Phase 5 (teardown):** this plan only *detects* provider-side revocation and moves the lease to `revoked` -- it does NOT perform teardown (credential cleanup, receipted teardown steps) or publisher-side entitlement revocation (LIC-04). Phase 5's teardown flow is the intended consumer of a lease landing in `revoked` via this path, exactly as `revoked:begin_teardown` (actor `runtime`) already specifies in `TRANSITION_TABLE`.
- **Flagged for the verifier:** the `lease_not_active` fix in `@stint/core/src/policy.ts` is a cross-package change outside this plan's declared `files_modified` (`packages/proxy/...`) -- documented above as a Rule 2 deviation with full rationale, since it was required to satisfy this plan's own must_have and closes a real deny-by-default gap.
- No blockers identified.

---
*Phase: 04-mcp-proxy-credential-vault*
*Completed: 2026-09-28*

## Self-Check: PASSED

All claimed created/modified files exist on disk and all claimed commit hashes (`d566b5b`, `dc7d53e`, `1c09340`, `9636cc0`) are present in git history.
