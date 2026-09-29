---
phase: 05-lease-endings-teardown
plan: 05
subsystem: proxy
tags: [license, license-issuer, teardown, revocation, entitlement, publisher, receipts]

# Dependency graph
requires:
  - phase: 05-lease-endings-teardown
    provides: "05-03: teardown/auto-chain.ts's chainTeardownIfEnded, teardown/steps.ts's injectable TeardownStep port + createDefaultTeardownSteps, teardown/orchestrate.ts's runTeardown/retryTeardown/appendTransitionReceipt"
  - phase: 05-lease-endings-teardown
    provides: "05-04: teardown/steps.ts's real revoke_oauth (step 1) + createDefaultTeardownSteps's optional vault parameter, the Rule-3 seam-widening pattern this plan repeats for license"
provides:
  - "license-issuer.ts: LicenseIssuer.invalidate(leaseId) -- additive port method (D-21)"
  - "testing.ts: createMockLicenseIssuer's mock now tracks invalidated lease ids and refuses reissue (returns null) for them"
  - "revocation.ts: applyEntitlementRevocation(lease, now) -- the LIC-04 runtime-facing entry, mirrors applyProviderRevocation verbatim"
  - "teardown/steps.ts: LicenseCustody seam ({ hasLicense, discard }) + the real invalidate_license (step 2) implementation; createDefaultTeardownSteps gains an optional trailing `license` parameter"
  - "packages/proxy/test/entitlement-revocation.test.ts: full LIC-04 unit + end-to-end coverage"
affects: [05-06, 05-07, 05-08]

# Actuals (#2632)
actuals:
  tokens: 7019
  tasks: 3
  commits: 3

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "LicenseCustody seam (steps.ts): { hasLicense(leaseId): boolean; discard(leaseId): void } -- a per-lease HeldLicense presence/discard interface with no production implementation yet (no per-lease license store exists in the runtime until a later phase actually holds licenses at request time); a caller supplies a double alongside a LicenseIssuer to exercise the real step, exactly like 05-04's vault? parameter did for revoke_oauth"
    - "Two-collaborator optional seam widening: createDefaultTeardownSteps's 4th parameter is a single { issuer, custody } object (not two separate optional params) so the two collaborators for step 2 are always supplied together or not at all -- avoids a half-configured state where only one is present"
    - "applyEntitlementRevocation mirrors applyProviderRevocation byte-for-byte (same two-reduce()-call + chainTeardownIfEnded shape) -- the third of three end-transition call sites this phase's D-18 pattern was designed for (provider, entitlement, and eventually outcome-verification)"

key-files:
  created:
    - packages/proxy/test/entitlement-revocation.test.ts
  modified:
    - packages/core/src/license/license-issuer.ts
    - packages/core/src/testing.ts
    - packages/core/test/license/refresh.test.ts
    - packages/proxy/src/revocation.ts
    - packages/proxy/src/teardown/steps.ts
    - packages/proxy/src/index.ts

key-decisions:
  - "LicenseIssuer.invalidate is additive (Promise<void>, no thrown business errors) -- the mock implementation tracks invalidated lease ids in a plain Set and checks it at the top of reissue; no background loop anywhere, matching D-21's 'stop refresh means discard custody + refuse reissue'"
  - "LicenseCustody is defined as an interface only, with no production implementation shipped this plan -- the runtime does not yet hold per-lease HeldLicense state at request time (that lands whenever a later phase actually wires hosted-license issuance into the live call path), so tests supply an in-memory Map-based double, exactly mirroring how 05-04's vault? parameter worked before a real vault existed for it"
  - "createDefaultTeardownSteps's new 4th parameter is a single optional `license: { issuer, custody }` object rather than two independent optional parameters -- keeps the two step-2 collaborators atomic (both present or both absent) and avoids a caller passing only one by mistake"
  - "The end-to-end test (Task 3) uses a real 2xx RFC 7009 revoke over the loopback mock AS (not an absent/erroring endpoint) so step 1 reaches the SUCCESS outcome 'revoked' and the run can actually land cleaned_up -- TEAR-02's own honesty matrix (05-04) already covers the unsupported/failed tri-state branches in isolation"

patterns-established: []

requirements-completed: [LIC-04]

coverage:
  - id: D1
    description: "LicenseIssuer gains an additive invalidate(leaseId) port method; the mock implementation refuses reissue for an invalidated lease (returns null) and treats invalidating an unknown lease as an idempotent no-op"
    requirement: "LIC-04"
    verification:
      - kind: unit
        ref: "packages/core/test/license/refresh.test.ts#LicenseIssuer.invalidate (LIC-04, D-21): refuses reissue for a lease after invalidate -- returns null, no background loop"
        status: pass
      - kind: unit
        ref: "packages/core/test/license/refresh.test.ts#LicenseIssuer.invalidate (LIC-04, D-21): invalidate for an unknown lease resolves without throwing (idempotent no-op)"
        status: pass
    human_judgment: false
  - id: D2
    description: "applyEntitlementRevocation moves an active/granted lease through entitlement_revoked (actor publisher) then auto-chained begin_teardown, landing tearing_down; returns reduce's illegal_transition rejection (not a throw) from an illegal source state"
    requirement: "LIC-04"
    verification:
      - kind: unit
        ref: "packages/proxy/test/entitlement-revocation.test.ts#applyEntitlementRevocation (LIC-04, D-21): moves an active lease through entitlement_revoked (publisher) then begin_teardown (runtime), landing tearing_down"
        status: pass
      - kind: unit
        ref: "packages/proxy/test/entitlement-revocation.test.ts#applyEntitlementRevocation (LIC-04, D-21): moves a granted lease to tearing_down (the other legal entitlement_revoked source state)"
        status: pass
      - kind: unit
        ref: "packages/proxy/test/entitlement-revocation.test.ts#applyEntitlementRevocation (LIC-04, D-21): returns reduce's illegal_transition rejection (not a throw) for a non-active/non-granted source state"
        status: pass
    human_judgment: false
  - id: D3
    description: "Real teardown step 2 (invalidate_license): a hosted/hybrid lease with a held license calls LicenseIssuer.invalidate and discards the license custody (outcome ok, custody empty afterward, reissue refused); a delegated-only lease with no license records not_applicable and never calls the issuer"
    requirement: "LIC-04"
    verification:
      - kind: unit
        ref: "packages/proxy/test/entitlement-revocation.test.ts#teardown step 2 (invalidate_license): a hosted/hybrid lease with a held license invalidates + discards -> outcome ok, custody empty afterward"
        status: pass
      - kind: unit
        ref: "packages/proxy/test/entitlement-revocation.test.ts#teardown step 2 (invalidate_license): a delegated-only lease with no held license records not_applicable and never calls the issuer"
        status: pass
    human_judgment: false
  - id: D4
    description: "The full LIC-04 path end-to-end: a hosted/hybrid active lease with a held license + seeded credential reaches cleaned_up via applyEntitlementRevocation -> runTeardown, with LicenseIssuer.invalidate actually called, license custody empty, the OAuth credential discarded, the revoke leg's persisted actor publisher, the cleaned_up notify fired, and no license token or credential string in any receipt"
    requirement: "LIC-04"
    verification:
      - kind: unit
        ref: "packages/proxy/test/entitlement-revocation.test.ts#LIC-04 end-to-end: entitlement revocation -> teardown -> license + credential gone (Task 3): a hosted/hybrid active lease with a held license + seeded credential reaches cleaned_up with the license invalidated, custody + credential gone, publisher actor, notify fired, and no secret in any receipt"
        status: pass
    human_judgment: false

# Metrics
duration: ~30min
completed: 2026-09-29
status: complete
---

# Phase 5 Plan 5: Publisher Entitlement Revocation (LIC-04) Summary

**`applyEntitlementRevocation` mirrors the provider-revocation path verbatim (`entitlement_revoked` actor `publisher` -> auto-chained `begin_teardown`), and teardown step 2 now really invalidates + discards the hosted license via an additive `LicenseIssuer.invalidate` port and a `LicenseCustody` discard seam -- proven end-to-end to `cleaned_up` with no license or credential surviving teardown.**

## Performance

- **Duration:** ~30 min
- **Started:** 2026-09-29T00:35:00Z
- **Completed:** 2026-09-29T01:02:45Z
- **Tasks:** 3
- **Files modified:** 7 (1 created, 6 modified)

## Accomplishments
- `LicenseIssuer.invalidate(leaseId): Promise<void>` -- additive port method (D-21); the mock `LicenseIssuer` in `@stint/core/testing` tracks invalidated lease ids and refuses `reissue` (returns `null`) for them, no background refresh loop anywhere
- `applyEntitlementRevocation(lease, now)` in `packages/proxy/src/revocation.ts` -- the LIC-04 runtime-facing entry point, mirroring `applyProviderRevocation`'s exact two-`reduce()`-call + `chainTeardownIfEnded` shape (`entitlement_revoked` actor `publisher` -> `begin_teardown` actor `runtime`), exported from `packages/proxy/src/index.ts` as the sanctioned bridge a later phase's platform/publisher webhook wires to
- `teardown/steps.ts`'s real `invalidate_license` (step 2): a new `LicenseCustody` seam (`{ hasLicense(leaseId), discard(leaseId) }`) plus `createInvalidateLicenseStep` -- `not_applicable` for a delegated-only lease (no license in custody, no issuer call, D-33), otherwise calls `LicenseIssuer.invalidate` then discards custody -> `ok`; `createDefaultTeardownSteps` gains an optional trailing `license: { issuer, custody }` parameter (Rule 3 seam widening, mirrors 05-04's `vault?` parameter)
- `packages/proxy/test/entitlement-revocation.test.ts` -- full LIC-04 coverage: `applyEntitlementRevocation` unit tests (active/granted -> `tearing_down`, illegal source -> rejection not throw), step 2 unit tests (hosted/hybrid -> `ok` + empty custody + refused reissue; delegated-only -> `not_applicable`, no issuer call), and a full end-to-end test proving the path lands `cleaned_up` with the license invalidated, custody empty, the OAuth credential discarded, the revoke leg's actor `publisher`, `notify` fired, and no secret (license token or credential) anywhere in the serialized receipt chain

## Task Commits

Each task was committed atomically:

1. **Task 1: LicenseIssuer.invalidate port + mock impl (D-21)** - `13a38ce` (feat)
2. **Task 2: applyEntitlementRevocation entry + real teardown step 2 (D-21, D-33)** - `ae21907` (feat)
3. **Task 3: LIC-04 end-to-end test (entitlement -> teardown -> license invalidated + discarded)** - `0211590` (test)

**Plan metadata:** committed alongside this SUMMARY (see final commit below).

_Tasks carried `tdd="true"` in the plan; each was implemented alongside its own tests (implementation + tests verified green together) rather than as separate RED/GREEN commits, since the plan's declared `<files>` split cleanly per task and each task's `<verify>`/`<acceptance_criteria>` were re-run and passed at each commit boundary._

## Files Created/Modified
- `packages/core/src/license/license-issuer.ts` - additive `LicenseIssuer.invalidate(leaseId): Promise<void>`
- `packages/core/src/testing.ts` - mock `LicenseIssuer`'s `invalidate` + reissue-refusal tracking
- `packages/core/test/license/refresh.test.ts` - `invalidate` refuse-reissue + idempotent-unknown-lease tests
- `packages/proxy/src/revocation.ts` - `applyEntitlementRevocation` (LIC-04, D-21)
- `packages/proxy/src/teardown/steps.ts` - `LicenseCustody` interface, `createInvalidateLicenseStep`, `createDefaultTeardownSteps`'s new `license` parameter
- `packages/proxy/src/index.ts` - exports `applyEntitlementRevocation` and the `LicenseCustody` type
- `packages/proxy/test/entitlement-revocation.test.ts` - new: full LIC-04 unit + end-to-end coverage (6 tests)

## Decisions Made
- `LicenseIssuer.invalidate` follows the port's existing async-Promise, no-thrown-business-error style (mirrors `reissue`) -- the mock's refusal logic lives entirely in a `Set<string>` of invalidated lease ids, checked once at the top of `reissue`
- `LicenseCustody` ships as an interface only (no production implementation this plan) -- the runtime does not yet hold per-lease `HeldLicense` state at request time; tests build a small in-memory `Map`-based double, exactly mirroring how 05-04's `vault?` parameter worked before a concrete vault caller existed for it
- `createDefaultTeardownSteps`'s 4th parameter is one `{ issuer, custody }` object rather than two independent optional parameters, so the step's two collaborators are always supplied together — avoiding a half-wired configuration where only one exists
- The end-to-end test uses a real 2xx RFC 7009 revoke over the loopback mock AS (not an absent/erroring endpoint) so step 1 reaches the SUCCESS outcome `revoked` and the run can actually land `cleaned_up` — the unsupported/failed tri-state branches are already TEAR-02's own coverage (05-04's `revocation-honesty.test.ts`), not re-proven here

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

The first draft of the Task 3 end-to-end test used an `OAuthClient` with no `revocation_endpoint` (to keep the test dependency-free), which correctly discarded the credential but recorded step 1's outcome as `discarded_revocation_unsupported` -- not a `teardown_succeeded` SUCCESS outcome (05-04's `progress.ts`), so the run honestly landed `cleanup_incomplete` instead of the `cleaned_up` the test asserted. Fixed by switching to the same real loopback mock-AS harness (`startMockAuthServer`) `revocation-honesty.test.ts` uses for its 2xx-revoke happy path, so step 1 reaches `revoked` (a SUCCESS outcome) and the full run reaches `cleaned_up` as the test intends. This is expected, correct teardown-honesty behavior (D-20/D-23), not a bug in the implementation under test.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- Steps 1 (`revoke_oauth`, 05-04), 2 (`invalidate_license`, this plan), and 5 (`final_receipt`, 05-03) are now all real, permanent implementations; only step 3 (`cleanup_hook`) remains a happy-path placeholder for 05-06's real single-use cleanup-token POST to harden, using the exact same injectable `TeardownStep` port and optional-constructor-parameter seam-widening pattern established across 05-03/05-04/this plan.
- `LicenseCustody` has no production implementation yet -- whichever later phase wires the runtime's actual per-lease hosted-license holding (issuing a license at request time and keeping the `HeldLicense` somewhere the runtime can later discard) must implement this interface; the seam and its contract (`hasLicense`/`discard`) are already proven against the real `invalidate_license` step.
- No blockers.

## Self-Check: PASSED

All 7 created/modified files found on disk; all 3 task commit hashes found in `git log`; `pnpm build` and `tsc -b` pass repo-wide; `vitest run --pool=threads` passes for `packages/proxy/test` + `packages/core/test` combined (37 files, 320 tests) with no regressions.

---
*Phase: 05-lease-endings-teardown*
*Completed: 2026-09-29*
