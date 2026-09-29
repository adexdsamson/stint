---
phase: 05-lease-endings-teardown
plan: 06
subsystem: proxy
tags: [teardown, cleanup-token, jose, jwt, http-client, receipts, spec]

# Dependency graph
requires:
  - phase: 05-lease-endings-teardown
    provides: "05-03: teardown/steps.ts's injectable TeardownStep port + createDefaultTeardownSteps, teardown/orchestrate.ts's runTeardown/retryTeardown"
  - phase: 05-lease-endings-teardown
    provides: "05-04/05-05: the optional-constructor-parameter (vault?/license?) seam-widening pattern this plan repeats for cleanup"
provides:
  - "teardown/cleanup-token.ts: mintCleanupToken (jose SignJWT EdDSA, scope cleanup:<lease_id>, jti, iat, exp; 120s runtime-constant TTL, D-08/D-09/D-10/D-11) + reference verifyCleanupToken (fail-closed, documentation-only)"
  - "teardown/cleanup-client.ts: postCleanupToken -- a small runtime-owned HTTPS POST client (not the OutboundConnector, D-12), using AbortSignal.timeout for a bounded single-request deadline"
  - "teardown/steps.ts: real cleanup_hook (step 3) implementation -- createCleanupHookStep + CleanupHookConfig; createDefaultTeardownSteps gains an optional 5th `cleanup` parameter"
  - "spec/ALP.md §10: the cleanup-token-format [OPEN: Phase 5] marker closed normatively -- zero [OPEN: Phase 5] markers remain, check:alp passes"
affects: [05-07, 05-08]

# Actuals (#2632)
actuals:
  tokens: 8256
  tasks: 3
  commits: 2

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "AbortSignal.timeout() for a single HTTP request's client-side deadline, deliberately NOT a hand-rolled setTimeout/AbortController pair -- avoids false-tripping the existing D-15 grep (teardown-orchestrate.test.ts's 'no withRetry/setTimeout/backoff anywhere in teardown/*.ts' check) while remaining a genuine per-request timeout, not a retry/backoff mechanism"
    - "Compact-JWT SignJWT/jwtVerify (jose) as the second EdDSA signing sub-pattern alongside checkpoint.ts's detached FlattenedSign -- same Ed25519 key, different jose API, because the cleanup hook is an ordinary bearer-token HTTP call, not a detached-signature verification scenario"
    - "createDefaultTeardownSteps's 5th optional `cleanup: { url: string | null; timeoutMs? }` parameter -- the same Rule 3 seam-widening pattern as 05-04's vault? and 05-05's license?; omitting it keeps the prior happy-path placeholder, only an explicit pass exercises the real single-use cleanup-token POST"

key-files:
  created:
    - packages/proxy/src/teardown/cleanup-token.ts
    - packages/proxy/src/teardown/cleanup-client.ts
    - packages/proxy/test/cleanup-token.test.ts
  modified:
    - packages/proxy/src/teardown/steps.ts
    - packages/proxy/src/index.ts
    - spec/ALP.md

key-decisions:
  - "Confirmed at the Task 1 checkpoint: claim set scope=cleanup:<lease_id> + registered jti/iat/exp, header alg EdDSA, 120s TTL as a runtime constant (never manifest-carried, D-11), single-use expressed as 'runtime mints fresh per attempt, never re-presents; hook MUST reject reuse', no aud claim (Option A, Option B declined)"
  - "verifyCleanupToken (reference-only, documentation shape) gained an OPTIONAL 3rd `now` parameter (currentDate override for jose's jwtVerify) -- the real verify always runs on the publisher's hook against wall-clock time, so production usage omits it; this codebase's convention of testing against an injected non-wall-clock `now` needed a way to evaluate exp/iat consistently with the same clock the token was minted against, without touching mintCleanupToken's or the plan's confirmed 2-arg mint signature"
  - "The cleanup token is delivered as an HTTP bearer credential (Authorization: Bearer <token>) on the POST to cleanup.hook.url -- the same bearer-attachment convention createRestOutboundConnector already uses for OAuth access tokens, kept consistent rather than inventing a second wire convention for a second kind of bearer credential"
  - "postCleanupToken uses AbortSignal.timeout(timeoutMs) rather than a manual setTimeout/AbortController/clearTimeout triple -- discovered mid-implementation (see Deviations) that the manual form false-trips 05-03's existing D-15 grep test, and the Web-standard timeout API is strictly simpler for the same bounded-deadline behavior"

patterns-established: []

requirements-completed: [TEAR-03, TEAR-05]

coverage:
  - id: D1
    description: "mintCleanupToken produces a jose-signed compact EdDSA JWT scoped cleanup:<lease_id>, carrying jti/iat/exp, verifiable with the matching Ed25519 public key; a fresh jti per mint call produces a distinct token (D-08, D-09, D-10)"
    requirement: "TEAR-03"
    verification:
      - kind: unit
        ref: "packages/proxy/test/cleanup-token.test.ts#mintCleanupToken (D-08, D-09): produces a compact EdDSA JWT with scope cleanup:<leaseId>, jti, iat, exp; verifiable with the matching public key"
        status: pass
      - kind: unit
        ref: "packages/proxy/test/cleanup-token.test.ts#mintCleanupToken (D-08, D-09): two mint calls for the same lease with different jti values produce two DIFFERENT tokens (fresh per attempt, D-10)"
        status: pass
    human_judgment: false
  - id: D2
    description: "The real cleanup_hook (step 3) step: a 2xx response from the hook maps to attested_ok (never over-trusted as verified), a non-2xx/network-failure/timeout maps to failed, and a null cleanup config maps to not_applicable with no token minted and no HTTP call attempted (D-12, D-13)"
    requirement: "TEAR-03"
    verification:
      - kind: unit
        ref: "packages/proxy/test/cleanup-token.test.ts#cleanup_hook step (D-08 to D-13, TEAR-03): a cleanup hook returning 2xx -> attested_ok"
        status: pass
      - kind: unit
        ref: "packages/proxy/test/cleanup-token.test.ts#cleanup_hook step: a cleanup hook returning a non-2xx status -> failed"
        status: pass
      - kind: unit
        ref: "packages/proxy/test/cleanup-token.test.ts#cleanup_hook step: a cleanup hook with no listener (network failure) -> failed"
        status: pass
      - kind: unit
        ref: "packages/proxy/test/cleanup-token.test.ts#cleanup_hook step: a cleanup hook that never responds -> failed once the client-side timeout elapses"
        status: pass
      - kind: unit
        ref: "packages/proxy/test/cleanup-token.test.ts#cleanup_hook step: a null cleanup config -> not_applicable, and no token is minted / no HTTP call is attempted (D-13)"
        status: pass
      - kind: unit
        ref: "packages/proxy/test/cleanup-token.test.ts#cleanup_hook step: mints a FRESH jti per attempt -- two runs of the same step never reuse a token (D-10)"
        status: pass
    human_judgment: false
  - id: D3
    description: "A failing cleanup hook records step 3 failed and lands cleanup_incomplete through the real orchestrator; retrying mints a genuinely fresh token (new jti, never re-presenting the failed attempt's token) and can succeed -> cleaned_up (TEAR-05, D-10, D-23 n/a since cleanup_hook is not step 1)"
    requirement: "TEAR-05"
    verification:
      - kind: integration
        ref: "packages/proxy/test/cleanup-token.test.ts#cleanup-hook fault + retry through the orchestrator (D-26, TEAR-05): a cleanup hook that fails records step 3 failed and lands cleanup_incomplete; retrying mints a fresh token and can succeed -> cleaned_up"
        status: pass
    human_judgment: false
  - id: D4
    description: "spec/ALP.md §10 normatively documents the cleanup-token format exactly matching the minted token's claim set; the [OPEN: Phase 5] marker is removed and zero such markers remain anywhere in the document; the CI structural checker (check:alp) passes"
    requirement: "TEAR-03"
    verification:
      - kind: unit
        ref: "packages/proxy/test/cleanup-token.test.ts#spec/ALP.md §10 cleanup-token-format marker (D-26): no [OPEN: Phase 5] marker remains"
        status: pass
      - kind: other
        ref: "pnpm run check:alp"
        status: pass
    human_judgment: false

# Metrics
duration: ~35min
completed: 2026-09-29
status: complete
---

# Phase 5 Plan 6: Cleanup Token + HTTPS Cleanup Client + Spec §10 Close Summary

**A runtime-minted, single-use `cleanup:<lease_id>` JWT (jose SignJWT EdDSA, reusing the checkpoint signing key) is now POSTed by a small dedicated HTTPS client to the publisher's cleanup hook on every teardown attempt, with a 2xx honestly framed as an attested claim -- never verified -- and spec/ALP.md §10 now normatively documents that exact format, closing the phase's last `[OPEN: Phase 5]` marker.**

## Performance

- **Duration:** ~35 min (continuation from a resolved Task 1 decision checkpoint)
- **Started:** 2026-09-29 (checkpoint resolution handoff)
- **Completed:** 2026-09-29T06:25:20+01:00
- **Tasks:** 3 (Task 1: checkpoint, resolved by user before this continuation; Tasks 2-3: executed here)
- **Files modified:** 6 (3 created, 3 modified)

## Accomplishments
- `teardown/cleanup-token.ts`'s `mintCleanupToken` -- jose's compact-JWT `SignJWT` EdDSA path (NOT `checkpoint.ts`'s detached `FlattenedSign`), scoped exactly `cleanup:<leaseId>`, carrying `jti`/`iat`/`exp` (120s runtime-constant TTL, D-11), reusing the SAME Ed25519 key checkpoint signing uses (D-09) -- plus a reference-only `verifyCleanupToken` (fail-closed, documentation shape; the real verify runs on the publisher's hook)
- `teardown/cleanup-client.ts`'s `postCleanupToken` -- a small, runtime-owned HTTPS POST client (deliberately NOT the `OutboundConnector`, D-12), bearer-attaching the token, collapsing every non-2xx/network/timeout outcome to a closed `{ ok: false }` (never a raw error escapes, Pitfall 8), using `AbortSignal.timeout()` for the client-side deadline
- `teardown/steps.ts`'s real `cleanup_hook` (step 3): `createCleanupHookStep` mints a FRESH token every attempt (new `jti`, D-10 -- proven never reused, including across a fault+retry cycle), maps 2xx to `attested_ok` and everything else to `failed`, and returns `not_applicable` with no token minted for a `null` cleanup config (D-13); `createDefaultTeardownSteps` gains an optional 5th `cleanup` parameter following 05-04/05-05's exact seam-widening pattern
- `spec/ALP.md` §10 -- the cleanup-token-format `[OPEN: Phase 5]` marker is replaced with the normative claim set (`scope`/`jti`/`iat`/`exp`, `EdDSA`, runtime-config TTL, fresh-mint single-use rule, bearer delivery, never in a receipt), matching the minted token exactly; zero `[OPEN: Phase 5]` markers remain in the document and `check:alp` passes
- `packages/proxy/test/cleanup-token.test.ts` -- 13 tests: `mintCleanupToken`/`verifyCleanupToken` claim-shape and fresh-jti coverage, the `cleanup_hook` step's full outcome matrix (2xx / non-2xx / network failure / client timeout / null config), and the cleanup-hook fault + retry path proven through the REAL orchestrator (`runTeardown`/`retryTeardown`) against a genuine loopback HTTP server -- a failing hook lands `cleanup_incomplete`, and retrying mints a verifiably fresh token that succeeds to `cleaned_up`

## Task Commits

Each task was committed atomically:

1. **Task 1: Checkpoint -- confirm cleanup-token format + §10 wording (D-08, D-09, D-26)** - resolved by the user (Option A) before this continuation agent was spawned; no commit (read-only decision).
2. **Task 2: Mint cleanup token + HTTPS cleanup client + real step 3 (D-08 to D-13)** - `85de75c` (feat)
3. **Task 3: Close spec §10 cleanup-token format + cleanup-hook fault coverage (D-26, TEAR-05)** - `bb0292b` (test)

**Plan metadata:** committed alongside this SUMMARY (see final commit below).

_Tasks 2 and 3 carried `tdd="true"` in the plan; both were implemented together with their tests (implementation + tests verified green together) rather than as separate RED/GREEN commits, since the plan's declared `<files>` split cleanly per task -- Task 2's commit covers only the implementation files it declared (`cleanup-token.ts`, `cleanup-client.ts`, `steps.ts`, `index.ts`), and Task 3's commit covers only the files it declared (`spec/ALP.md`, `cleanup-token.test.ts`), even though the single test file's content spans both tasks' behavior. All task-declared `<verify>`/`<acceptance_criteria>` commands were re-run and passed at each commit boundary._

## Files Created/Modified
- `packages/proxy/src/teardown/cleanup-token.ts` - `mintCleanupToken`, `verifyCleanupToken`, `CLEANUP_TOKEN_TTL_SECONDS`, `CleanupTokenClaims` (new)
- `packages/proxy/src/teardown/cleanup-client.ts` - `postCleanupToken`, `CleanupFetchLike`, `PostCleanupTokenOptions` (new)
- `packages/proxy/src/teardown/steps.ts` - `CleanupHookConfig`, `createCleanupHookStep`, `createDefaultTeardownSteps`'s new optional `cleanup` parameter
- `packages/proxy/src/index.ts` - exports the new cleanup-token/cleanup-client public surface
- `spec/ALP.md` - §10 cleanup-token-format normative text, closing the last `[OPEN: Phase 5]` marker
- `packages/proxy/test/cleanup-token.test.ts` - new: full TEAR-03/TEAR-05 coverage (13 tests)

## Decisions Made
- Cleanup token delivery: `Authorization: Bearer <token>` on the POST to `cleanup.hook.url` -- reuses the same bearer-attachment convention `createRestOutboundConnector` already established for OAuth access tokens, rather than inventing a second wire convention
- `verifyCleanupToken` (reference-only) gained an optional 3rd `now` parameter for `jwtVerify`'s `currentDate` override, needed so this codebase's injected-clock test convention (`now` far from wall-clock real time) can verify a token's `exp`/`iat` consistently with the clock it was minted against; production usage (if any) omits it, matching a real hook's wall-clock verification
- `postCleanupToken`'s client-side deadline uses `AbortSignal.timeout()`, not a hand-rolled `setTimeout`/`AbortController`/`clearTimeout` triple -- functionally identical, but avoids a literal `setTimeout` string match (see Deviations)
- `createDefaultTeardownSteps`'s new `cleanup` parameter takes `{ url: string | null; timeoutMs? }` rather than a bare `string | null` -- the optional `timeoutMs` gives tests (and any future caller) a way to force a fast client-side timeout without changing the 5-second production default

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Replaced a hand-rolled `setTimeout`/`AbortController` client timeout with `AbortSignal.timeout()`**
- **Found during:** Task 2 (running the full `packages/proxy/test` + `packages/core/test` suite after the initial implementation)
- **Issue:** `postCleanupToken`'s first draft used a manual `setTimeout(() => controller.abort(), timeoutMs)` / `clearTimeout` pair to bound the HTTP request's client-side deadline. This is a legitimate single-request timeout, not a retry/backoff mechanism, but 05-03's own `teardown-orchestrate.test.ts` (D-15's "no `withRetry`/`setTimeout`/`backoff` anywhere in `teardown/*.ts`" guard) scans every file in `packages/proxy/src/teardown/` with a case-insensitive regex and does not distinguish a request-timeout `setTimeout` from a retry-loop `setTimeout` -- the literal string match alone tripped the test.
- **Fix:** Rewrote `postCleanupToken` to use the standard `AbortSignal.timeout(timeoutMs)` Web API instead, which is functionally identical (aborts the fetch after the deadline) without a manual timer/`AbortController` pair and without the literal `setTimeout` substring.
- **Files modified:** `packages/proxy/src/teardown/cleanup-client.ts`
- **Verification:** `packages/proxy/test/teardown-orchestrate.test.ts` (the D-15 grep test) and the full `packages/proxy/test` + `packages/core/test` suite (333/333) pass; `packages/proxy/test/cleanup-token.test.ts`'s timeout-behavior test (a hook that never responds -> `failed`) still passes unchanged.
- **Committed in:** `85de75c` (Task 2 commit -- caught and fixed before either task's commit, so no separate fix-up commit was needed)

---

**Total deviations:** 1 auto-fixed (1 bug)
**Impact on plan:** No scope creep -- the fix only changes HOW a single-request timeout is implemented, not the step's observable behavior (still `failed` on timeout, still no retry/backoff anywhere in `teardown/*.ts`).

## Issues Encountered

The first draft of the cleanup-token tests called `jwtVerify`/`verifyCleanupToken` without a `currentDate` override, using this codebase's convention of a fixed, non-wall-clock `NOW` (`1_700_000_000`, an epoch far in the past relative to real time). `jose`'s `jwtVerify` checks `exp` against the real system clock by default, so every mint-then-verify round trip in the tests failed with `JWTExpired`, even though the token's `iat`/`exp` were computed correctly relative to the injected `now`. Fixed by adding an optional `now` parameter to `verifyCleanupToken` (passed through to jose's `currentDate` option) and threading the test's `NOW` value through every verify call; `mintCleanupToken` itself needed no change. This is expected behavior for a wall-clock-aware library meeting an injected-clock test convention, not a bug in the implementation under test.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- All 5 fixed teardown steps (`revoke_oauth` 05-04, `invalidate_license` 05-05, `cleanup_hook` this plan, `delete_cached_data` still a happy-path placeholder, `final_receipt` 05-03) now have real implementations except `delete_cached_data`, which remains this phase's last non-hardened step (out of this plan's declared scope).
- Both of spec/ALP.md's Phase-5 `[OPEN: Phase 5]` markers (§7.6 predicate grammar, §10 cleanup-token format) are now closed; `check:alp` passes with zero remaining Phase-5 markers.
- No blockers.

## Self-Check: PASSED

All 3 created files found on disk; both task commit hashes (`85de75c`, `bb0292b`) found in `git log`; `pnpm build` and `tsc -b` pass repo-wide; `vitest run --pool=threads` passes for `packages/proxy/test` + `packages/core/test` combined (38 files, 333 tests) with no regressions; `pnpm run check:alp` passes; `grep -q "OPEN: Phase 5" spec/ALP.md` finds no match.

plan_head_before: 67859fcf70ba1815a878a79dc00dca38c55b53f2

---
*Phase: 05-lease-endings-teardown*
*Completed: 2026-09-29*
