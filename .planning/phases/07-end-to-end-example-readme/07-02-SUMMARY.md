---
phase: 07-end-to-end-example-readme
plan: 02
subsystem: license
tags: [paseto, license-issuer, verify-then-mint, oauth2-mock-server, testing-seam, subpath-export]
requires:
  - phase: 07-end-to-end-example-readme
    provides: "07-01 example package skeleton and built workspace"
provides:
  - "@stint/core/license-issuer subpath: createReferenceLicenseIssuer, createLicenseIssuerClient, LicenseIssuerTransport (no test-runner import)"
  - "@stint/proxy/testing MockAuthHarness.forceNextExpiresIn(seconds) one-shot /token expires_in override"
  - "@stint/proxy/testing MockAuthHarness.revokeHits counter (Events.BeforeRevoke)"
affects: [07-03, 07-04, 07-05, 07-06, 07-07, 07-08, 07-09]
estimate:
  tokens: 62000
  raw_tokens: 38500
  tasks: 3
  confidence: low
actuals:
  tokens: 9300
  tasks: 3
  commits: 2
plan_head_before: f080790e5ebf261fe408441497d8c29898fab620
commits: 2
tech-stack:
  added: []
  patterns:
    - "Verify-then-mint: a received license token is verifyLicense'd against the pinned publisher key before mintHeldLicense wraps it"
    - "Client-side LIC-03 clamp: client computes clampedLicenseExpiry itself and rejects tokens whose exp exceeds it"
    - "Test doubles delegate to the runtime-importable reference implementation so they cannot drift"
key-files:
  created:
    - packages/core/src/license/reference-issuer.ts
    - packages/core/src/license/license-issuer-client.ts
    - packages/core/src/license-issuer.ts
    - packages/core/test/reference-issuer.test.ts
    - packages/core/test/license-issuer-client.test.ts
    - packages/proxy/test/mock-auth-expires.test.ts
  modified:
    - packages/core/package.json
    - packages/core/tsdown.config.ts
    - packages/core/src/testing.ts
    - packages/core/test/public-api.test.ts
    - packages/proxy/src/testing.ts
key-decisions:
  - "D-14 checkpoint APPROVED by the human: additive @stint/core/license-issuer subpath here, CLI edits in 07-03."
  - "createMockLicenseIssuer in @stint/core/testing now delegates to createReferenceLicenseIssuer (kid kept as MOCK_LICENSE_ISSUER_KID); its exports are unchanged and it is still not exported from the root."
  - "The client additionally rejects a validly-signed token whose exp is later than the clamp it computed (does not trust the publisher's clamp)."
  - "createReferenceLicenseIssuer accepts an optional { kid } (additive to the planned zero-arg signature) so the mock can keep its fixed kid."
requirements-completed: [E2E-01, E2E-02]
status: complete
---

# Phase 7 Plan 2: License-issuer subpath and proxy expires_in seam Summary

**A test-runner-free `@stint/core/license-issuer` subpath (reference PASETO issuer plus a verify-then-mint client with a client-side LIC-03 clamp) and a one-shot `forceNextExpiresIn` seam on `@stint/proxy/testing`, both additive.**

## Accomplishments
- Task 0 (checkpoint:decision D-14, gate blocking-human): resolved APPROVE by the human before execution; not re-asked.
- Task 1 (tracer): `createReferenceLicenseIssuer({ kid? })` returns `{ issuer, publicKey }` (a non-test copy of the mock issuer body, importing only paseto plus core license modules). `createLicenseIssuerClient({ publicKey, specVersion, transport })` asks an injected `LicenseIssuerTransport` for a raw token, runs `verifyLicense` with the pinned key, and only then `mintHeldLicense`. `issue` throws a fixed lapsed message once `now >= leaseExpiresAt`; `reissue` returns `null` without touching the transport past the lease; a token minted for a different lease id, a different spec version, a different key, or with an `exp` beyond the client's own clamp is refused with a fixed message that never contains the token. Export mechanics: `./license-issuer` in core `package.json` `exports` plus a third tsdown entry; `testing.ts` mock delegates to the reference issuer. `public-api.test.ts` now pins that the subpath exposes the two factories and that neither they nor `mintHeldLicense`/`issueLicense`/`createMockLicenseIssuer` appear on the root or widen the subpath.
- Tracer gate: `<verify>` (build plus scoped vitest of the two new core tests) passed; re-run after the related suites (public-api, license/*, smoke, lease-store contract, receipts, and the three proxy tests that use `createMockLicenseIssuer`) all green before expanding.
- Task 2: `MockAuthHarness.forceNextExpiresIn(seconds)` arms a one-shot override applied in the existing `Events.BeforeResponse` hook (only on a successful body containing `expires_in`; `forceNextTokenError` takes precedence and is unchanged, and the override survives an errored response). Added `revokeHits` backed by `Events.BeforeRevoke`, which oauth2-mock-server 9.2.0 exposes cleanly. The test proves `expires_in: 1` on exactly the next response then 3600, precedence over an armed error, the revoke counter, and that `packages/proxy/src/index.ts` does not re-export `testing.ts`.

## Task Commits
1. Task 1: `f6da835` feat(07-02): add vitest-free @stint/core/license-issuer subpath
2. Task 2: `4c9cea5` feat(07-02): add forceNextExpiresIn and revokeHits to proxy mock auth harness

## Verification
- `pnpm build` green; `dist/license-issuer.{js,d.ts}` emitted and contains no `vitest`.
- Scoped vitest green: `packages/core/test/{reference-issuer,license-issuer-client,public-api,license/*,smoke,lease-store-contract,receipts/*}` and `packages/proxy/test/{mock-auth-expires,refresh-single-flight,revocation-honesty,entitlement-revocation,license-secretless,teardown-receipts-survive}`.
- `tsc -b` on core and proxy, scoped eslint, and prettier on the new files are clean. Whole-repo runs were not performed (OOM, per project memory).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical functionality] Client rejects a token whose exp exceeds its own clamp**
- **Found during:** Task 1
- **Issue:** The plan asked the client to clamp reissue and not trust the publisher's clamp, but verifying only the signature would still mint a validly-signed token that outlives the lease.
- **Fix:** `verifyThenMint` also refuses when `expEpochSeconds` is later than the `clampedLicenseExpiry` the client computed (T-07-CLOCK), with a dedicated test.
- **Files modified:** packages/core/src/license/license-issuer-client.ts, packages/core/test/license-issuer-client.test.ts
- **Commit:** f6da835

**2. [Rule 3 - Blocking] Acceptance criterion "no substring vitest" in reference-issuer.ts**
- **Found during:** Task 1
- **Issue:** Doc comments mentioned the word vitest, violating the literal acceptance check.
- **Fix:** Reworded comments in the new source files to say "test runner"; the source-scan test asserts no `from "vitest"`/dynamic import across the three new source files.
- **Commit:** f6da835

**3. [Additive signature] `createReferenceLicenseIssuer` takes an optional `{ kid }`**
- Needed so the delegating mock keeps `MOCK_LICENSE_ISSUER_KID`; the zero-arg call from the plan still works.

**Execution-environment note:** Run on the main tree of branch `claude/blissful-maxwell-f27307` (non-worktree mode per orchestrator), so the worktree-only `agent-*` branch-namespace assertion was not applied; the protected-branch assertion passed.

## Known Stubs
None.

## Threat Flags
None. The new surface is the subpath export itself, covered by T-07-PASETO, T-07-CLOCK, T-07-TESTLEAK, and T-07-TOKENLOG in the plan's threat model; all four mitigations are implemented and tested.

## Self-Check: PASSED
