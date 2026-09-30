---
phase: 05-lease-endings-teardown
plan: 04
subsystem: proxy
tags: [oauth, rfc7009, revocation, teardown, credential-vault, receipts, oauth4webapi]

# Dependency graph
requires:
  - phase: 05-lease-endings-teardown
    provides: "05-03: teardown/steps.ts's injectable TeardownStep port, TEARDOWN_STEP_ORDER, createDefaultTeardownSteps (4 happy-path placeholders + real final_receipt), teardown/orchestrate.ts's runTeardown/retryTeardown, teardown/progress.ts's attempted-is-terminal resume rule for revoke_oauth"
provides:
  - "vault/oauth-client.ts: revokeCredential(oauthClient, refreshToken, opts) -- structural RFC 7009 tri-state (RevokeResult: revoked | discarded_revocation_unsupported | failed), support determined from as.revocation_endpoint presence BEFORE any HTTP call (D-20, Pitfall 5)"
  - "vault/credential-vault.ts: CredentialVault.revokeAndDiscardLeaseCredentials(leaseId, now) -- revokes then ALWAYS deletes every credential seeded for a lease regardless of outcome (D-22); CredentialVault.discardLeaseCredentials(leaseId) -- plain discard, no revoke call, for a later step"
  - "teardown/steps.ts: the real revoke_oauth (step 1) implementation -- not_applicable for a hosted-only lease, one teardown_step receipt per credential (D-24), aggregate outcome per credential set (revoked only if ALL revoked; failed if ANY failed; else discarded_revocation_unsupported)"
  - "createDefaultTeardownSteps gains an optional third `vault` parameter -- omitted keeps the pre-05-04 happy-path revoke_oauth placeholder for callers outside this plan's scope"
affects: [05-05, 05-06, 05-07, 05-08]

# Actuals (#2632)
actuals:
  tokens: 7927
  tasks: 3
  commits: 3

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Structural-before-network check (D-20): revokeCredential inspects as.revocation_endpoint's presence FIRST, returning discarded_revocation_unsupported with zero HTTP calls when absent -- the absence of the field is the signal, never a response code"
    - "Always-discard-on-attempt (D-22): revokeAndDiscardLeaseCredentials deletes the vault entry unconditionally after calling revokeCredential, regardless of RevokeResult.kind -- discard is never gated on success"
    - "Per-credential receipts + aggregate progress outcome: a TeardownStep can append MULTIPLE teardown_step receipts internally (one per credential, each carrying its own honest outcome) while still returning a SINGLE aggregate TeardownStepOutcome for orchestrate.ts's own progress-record write and receipt -- orchestrate.ts/progress.ts needed no changes to support this"
    - "Optional trailing seam-widening parameter (Rule 3, mirrors 05-03's ProxyDeps.teardownSteps): createDefaultTeardownSteps(receiptStore, signingKey, vault?) -- omitting vault preserves the exact pre-05-04 happy-path behavior byte-for-byte for the three test files outside this plan's declared scope"

key-files:
  created:
    - packages/proxy/test/revocation-honesty.test.ts
  modified:
    - packages/proxy/src/vault/oauth-client.ts
    - packages/proxy/src/vault/credential-vault.ts
    - packages/proxy/src/teardown/steps.ts
    - packages/proxy/test/refresh-single-flight.test.ts

key-decisions:
  - "revokeCredential collapses EVERY thrown error (network failure, non-2xx, malformed response) to { kind: \"failed\", cause: err } -- no distinction between error types at this layer, since D-20's contract only needs revoked/unsupported/failed, and cause is documented as caller-internal-only (never receipted)"
  - "createDefaultTeardownSteps's new `vault` parameter is OPTIONAL rather than required, so revocation-detection.test.ts, teardown-orchestrate.test.ts, and teardown-fault-matrix.test.ts (all outside this plan's declared files_modified) keep compiling and behaving exactly as before -- only a caller that opts in by passing vault exercises the real structural revoke"
  - "The aggregate step-1 TeardownStepOutcome (revoked | failed | discarded_revocation_unsupported) is computed independently of, and in addition to, the per-credential teardown_step receipts the step appends internally -- orchestrate.ts's own runStepAndPersist still appends ONE more receipt using the returned aggregate, so a multi-credential lease's chain carries N per-credential entries plus 1 aggregate entry, never overwriting or replacing either"
  - "discarded_revocation_unsupported is intentionally NOT a `teardown_succeeded` SUCCESS outcome in progress.ts's existing (05-03, untouched) SUCCESS_OUTCOMES list -- a lease whose AS lacks RFC 7009 support honestly lands cleanup_incomplete forever for that credential (the same permanent-non-cleaned_up shape D-23 already accepts for a genuine failed), since the runtime cannot claim more than \"we discarded our copy\" without overclaiming"

patterns-established:
  - "Vault custody discipline extended to revoke: revokeAndDiscardLeaseCredentials never returns a raw token to its caller (teardown/steps.ts) -- only the closed RevokeResult per credential, mirroring resolveAccessToken's existing never-expose-the-store discipline"

requirements-completed: [TEAR-02, TEAR-05]

coverage:
  - id: D1
    description: "revokeCredential determines RFC 7009 support structurally from as.revocation_endpoint's presence, before any HTTP call -- absent endpoint never makes a network request and returns discarded_revocation_unsupported"
    requirement: "TEAR-02"
    verification:
      - kind: unit
        ref: "packages/proxy/test/revocation-honesty.test.ts#revokeCredential: structural RFC 7009 tri-state (D-20, Pitfall 5, TEAR-02): returns discarded_revocation_unsupported and makes NO HTTP call when as.revocation_endpoint is undefined"
        status: pass
    human_judgment: false
  - id: D2
    description: "A 2xx revoke response maps to revoked and is never upgraded to a stronger claim (Pitfall 5 -- RFC 7009 permits 2xx for an unrecognized/already-invalid token); an erroring/network-failing revoke endpoint maps to failed with no raw error text exposed"
    requirement: "TEAR-02"
    verification:
      - kind: unit
        ref: "packages/proxy/test/revocation-honesty.test.ts#revokeCredential: structural RFC 7009 tri-state: returns revoked (and nothing stronger) on a 2xx response"
        status: pass
      - kind: unit
        ref: "packages/proxy/test/revocation-honesty.test.ts#revokeCredential: structural RFC 7009 tri-state: returns failed (error collapsed, no raw error leaked) when the revoke endpoint errors"
        status: pass
    human_judgment: false
  - id: D3
    description: "Teardown step 1 always discards the runtime's own credential copy for a lease regardless of the revoke outcome (revoked, unsupported, or failed) -- proven by a post-step vault probe (resolveAccessToken rejects) on all three outcomes"
    requirement: "TEAR-02"
    verification:
      - kind: unit
        ref: "packages/proxy/test/revocation-honesty.test.ts#teardown step 1 (revoke_oauth): real implementation over the vault (D-22, D-23, D-33): records step-1 outcome revoked and the credential entry is gone from the vault afterward"
        status: pass
      - kind: unit
        ref: "packages/proxy/test/revocation-honesty.test.ts#teardown step 1: a lease whose revoke is structurally unsupported records discarded_revocation_unsupported AND the credential is STILL discarded (D-22)"
        status: pass
      - kind: unit
        ref: "packages/proxy/test/revocation-honesty.test.ts#teardown step 1: a lease whose revoke fails records failed AND the credential is STILL discarded (D-22)"
        status: pass
    human_judgment: false
  - id: D4
    description: "A hosted-only lease (no seeded OAuth credential) records step 1 not_applicable and makes no revoke call; a second attempt over an already-discarded credential likewise finds nothing and never re-invokes revokeCredential (the data-layer half of D-23's attempted-is-terminal rule)"
    requirement: "TEAR-02"
    verification:
      - kind: unit
        ref: "packages/proxy/test/revocation-honesty.test.ts#teardown step 1: a lease with no seeded credential records not_applicable and makes no revoke call"
        status: pass
      - kind: unit
        ref: "packages/proxy/test/revocation-honesty.test.ts#teardown step 1: after step 1 discards the credential, a second attempt (retry) finds none and does not re-attempt revocation (D-23)"
        status: pass
    human_judgment: false
  - id: D5
    description: "The Pitfall-5 honesty matrix proven end-to-end through step 1 over the real mock AS: 2xx-without-revoking (the mock's real /revoke, always 200, no reuse-detection) records revoked, never a stronger claim; the absent-endpoint distinguisher records discarded_revocation_unsupported; an erroring endpoint records failed -- and no teardown_step receipt for any of the three ever contains either seeded token string (Pitfall 8 scrub discipline)"
    requirement: "TEAR-05"
    verification:
      - kind: unit
        ref: "packages/proxy/test/revocation-honesty.test.ts#Pitfall-5 honesty matrix through step 1 (TEAR-02, TEAR-05): 2xx-without-revoking records revoked"
        status: pass
      - kind: unit
        ref: "packages/proxy/test/revocation-honesty.test.ts#Pitfall-5 honesty matrix: the distinguisher: an AS with NO revocation_endpoint records discarded_revocation_unsupported"
        status: pass
      - kind: unit
        ref: "packages/proxy/test/revocation-honesty.test.ts#Pitfall-5 honesty matrix: an AS whose revoke endpoint errors records failed"
        status: pass
    human_judgment: false

# Metrics
duration: ~35min
completed: 2026-09-29
status: complete
---

# Phase 5 Plan 4: Revocation Honesty (RFC 7009 Structural Tri-State) Summary

**Teardown step 1 now performs a real, structurally-honest RFC 7009 revoke: support is read from AS metadata before any network call, a bare 2xx is never upgraded past `revoked`, every credential is always discarded from the vault regardless of outcome, and the Pitfall-5 "2xx-without-actually-revoking" trap is proven closed end-to-end over a real mock authorization server.**

## Performance

- **Duration:** ~35 min
- **Started:** 2026-09-28T23:25:00Z
- **Completed:** 2026-09-28T23:41:28Z
- **Tasks:** 3
- **Files modified:** 5 (1 created, 4 modified)

## Accomplishments
- `vault/oauth-client.ts`'s `revokeCredential` -- checks `oauthClient.as.revocation_endpoint` FIRST (structurally, before any HTTP call, D-20); a 2xx response maps to `revoked` and nothing stronger (RFC 7009 permits an AS to return 2xx for a token it does not recognize -- Pitfall 5); any thrown error collapses to `failed` with no raw exception ever escaping unclassified
- `vault/credential-vault.ts`'s `revokeAndDiscardLeaseCredentials` -- revokes every credential seeded for a lease (the refresh token never leaves the vault) and then ALWAYS deletes the entry, regardless of whether the revoke succeeded, was unsupported, or failed (D-22); `discardLeaseCredentials` added for a later plain-discard step (05-08-ish, step 4)
- `teardown/steps.ts`'s real `revoke_oauth` (step 1) -- `not_applicable` for a hosted-only lease with no revoke call (D-33); one `teardown_step` receipt per credential carrying that credential's own honest outcome (D-24); the aggregate outcome recorded into `teardownProgress` is `revoked` only if EVERY credential was revoked, `failed` if ANY credential failed, and `discarded_revocation_unsupported` otherwise -- never overclaimed
- `revocation-honesty.test.ts` -- the full TEAR-02 honesty matrix: isolated `revokeCredential` tri-state, vault-level discard-on-every-outcome proof, and the Pitfall-5 end-to-end matrix through step 1 (2xx-without-revoking, absent-endpoint, erroring-endpoint), asserting both the vault discard and the secretless receipt payload in every case

## Task Commits

Each task was committed atomically:

1. **Task 1: Structural RFC 7009 revokeCredential in oauth-client.ts (D-20)** - `06521ef` (feat)
2. **Task 2: Vault revoke-and-discard + real teardown step 1 (D-22, D-23, D-33)** - `ca07322` (feat)
3. **Task 3: Pitfall-5 honesty matrix over the mock AS (TEAR-02, TEAR-05)** - `97701bb` (test)

**Plan metadata:** committed alongside this SUMMARY (see final commit below).

## Files Created/Modified
- `packages/proxy/src/vault/oauth-client.ts` - `RevokeResult` union + `revokeCredential(oauthClient, refreshToken, opts)`
- `packages/proxy/src/vault/credential-vault.ts` - `CredentialVault.revokeAndDiscardLeaseCredentials`, `CredentialVault.discardLeaseCredentials`, `leaseCredentialEntries` helper
- `packages/proxy/src/teardown/steps.ts` - real `revoke_oauth` step (`createRevokeOauthStep`, `aggregateRevokeOutcome`, `revokeResultToOutcome`, `appendTeardownStepReceipt`), `createDefaultTeardownSteps`'s new optional `vault` parameter
- `packages/proxy/test/revocation-honesty.test.ts` - new: the full TEAR-02/TEAR-05 honesty matrix (11 tests)
- `packages/proxy/test/refresh-single-flight.test.ts` - updated `CredentialVault` public-surface snapshot for the two new additive methods

## Decisions Made
- `revokeCredential`'s `failed` branch collapses every thrown error uniformly (no distinction between `oauth.ResponseBodyError` and a plain network failure) -- D-20's contract only needs the closed tri-state, and `cause` is documented caller-internal-only, never forwarded to a receipt
- `createDefaultTeardownSteps`'s new `vault` parameter is OPTIONAL, not required -- preserves exact pre-05-04 compilation and behavior for `revocation-detection.test.ts`, `teardown-orchestrate.test.ts`, and `teardown-fault-matrix.test.ts` (all outside this plan's declared `files_modified`); only a caller that opts in by passing `vault` gets the real structural revoke
- The real `revoke_oauth` step appends its own per-credential `teardown_step` receipts directly (via a private `appendTeardownStepReceipt` helper mirroring `orchestrate.ts`'s private `appendReceipt`) in ADDITION to the single aggregate receipt `orchestrate.ts`'s existing `runStepAndPersist` already appends from the step's returned outcome -- neither `orchestrate.ts` nor `progress.ts` needed any change, since a `TeardownStep.run()` return contract (one `TeardownStepOutcome`) was already sufficient for the aggregate, and appending extra receipts mid-step is invisible to the orchestrator
- `discarded_revocation_unsupported` remains outside `progress.ts`'s (05-03, untouched) `SUCCESS_OUTCOMES` list -- a lease whose AS structurally lacks RFC 7009 support honestly never reaches `cleaned_up` for that credential (same permanent-`cleanup_incomplete` shape D-23 already accepts for a genuine `failed`); this is the honest ceiling the plan's must-haves require, not a gap

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Updated `refresh-single-flight.test.ts`'s `CredentialVault` public-surface snapshot test**
- **Found during:** Task 2 (adding `revokeAndDiscardLeaseCredentials`/`discardLeaseCredentials` to `CredentialVault`)
- **Issue:** A pre-existing test in a file outside this plan's declared scope asserts the EXACT literal list of `CredentialVault`'s own keys (`Object.keys(vault).sort()`); adding the two new, plan-mandated additive methods necessarily changed that list, failing the test
- **Fix:** Updated the expected array to include `discardLeaseCredentials` and `revokeAndDiscardLeaseCredentials` alongside the existing `resolveAccessToken`/`seedCredential`, with a comment noting neither new method returns a raw token (the custody boundary the test exists to protect is unaffected)
- **Files modified:** `packages/proxy/test/refresh-single-flight.test.ts`
- **Verification:** `vitest run` for the file passes; full scoped `packages/proxy/test` + `packages/core/test` suite (312 tests) passes with no other regressions
- **Committed in:** `ca07322` (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 bug -- a direct, mandated consequence of this task's own interface change)
**Impact on plan:** Necessary to keep the full test suite green; no scope creep beyond updating one assertion's expected value list.

## Issues Encountered
None.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Step 1 (`revoke_oauth`) is now real, permanent behavior alongside step 5 (`final_receipt`, 05-03) -- steps 2 (`invalidate_license`), 3 (`cleanup_hook`), and 4 (`delete_cached_data`) remain happy-path placeholders for 05-05/05-06/05-08 to harden, using the same injectable `TeardownStep` port and the same optional-constructor-parameter seam-widening pattern this plan established for `createDefaultTeardownSteps`.
- `CredentialVault.discardLeaseCredentials` (plain discard, no revoke) is ready for step 4 ("delete cached data") to consume once that step is implemented -- it deliberately does nothing to a lease's OAuth credentials that step 1 hasn't already discarded (idempotent no-op on an already-empty lease).
- No blockers.

## Self-Check: PASSED

All 5 created/modified files found on disk; all 3 task commit hashes found in `git log`; `pnpm build` and `tsc -b` pass repo-wide; `vitest run --pool=threads` passes for `packages/proxy/test` (12 files, 116 tests) and `packages/core/test` (196 tests) combined into a 312-test scoped run with no regressions.

---
*Phase: 05-lease-endings-teardown*
*Completed: 2026-09-29*
