---
phase: 03-receipts-licensing
plan: 06
subsystem: licensing
tags: [license-refresh, held-license, brand-type, license-issuer-port, lic-03, lic-05]

# Dependency graph
requires:
  - phase: 03-receipts-licensing
    plan: 05
    provides: "packages/core/src/license/issue.ts (issueLicense), verify.ts (verifyLicense, LICENSE_CLOCK_SKEW_SECONDS), errors.ts (LICENSE_VERIFY_REASONS) -- the reference sign/verify primitives this plan's LicenseIssuer port composes"
provides:
  - "packages/core/src/license/refresh.ts: needsRefresh(exp, now, refreshBeforeSeconds), clampedLicenseExpiry(now, defaultTtlSeconds, leaseExpiresAt), DEFAULT_LICENSE_TTL_SECONDS (300) -- pure, no paseto import, the LIC-03 no-refreshed-token-outlives-the-lease guarantee"
  - "packages/core/src/license/held-license.ts: HeldLicense (opaque branded handle, no public data fields), mintHeldLicense, readLicenseToken -- the LIC-05 by-construction custody guarantee"
  - "packages/core/src/license/license-issuer.ts: LicenseIssuer port (issue/reissue), injected -- Phase 4 (proxy hold+inject) and Phase 7 (mock publisher) build on this"
  - "packages/core/src/testing.ts: createMockLicenseIssuer() -- a LicenseIssuer backed by a fresh test Ed25519 keypair, composing issueLicense + mintHeldLicense"
  - "packages/core/src/index.ts: license public barrel (needsRefresh, clampedLicenseExpiry, DEFAULT_LICENSE_TTL_SECONDS, verifyLicense, LICENSE_CLOCK_SKEW_SECONDS, LICENSE_VERIFY_REASONS, HeldLicense + readLicenseToken, LicenseIssuer, LicenseClaims/LicenseJobClaim/LicenseLimitsClaim, VerifiedLicense) -- issueLicense and ./testing deliberately NOT re-exported"
affects: [phase-04-proxy, phase-07-mock-publisher]

# Actuals (#2632)
actuals:
  tokens: 5355
  tasks: 3
  commits: 5

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "HeldLicense's opaque handle stores its wrapped token in a module-private WeakMap<HeldLicense, string> keyed by object identity, not as a public interface field -- stricter than @stint/spec's VerifiedManifest brand (which exposes plain public fields), because the wrapped value here IS the secret. The interface itself declares only the unexported unique-symbol brand field, so there is no property path to the token at all outside held-license.ts; readLicenseToken is proven the sole accessor by a type-level @ts-expect-error on `held.token`, not just by docstring convention."
    - "LicenseIssuer.reissue owns the LIC-03 clamp: it calls clampedLicenseExpiry internally and returns null (refusing the refresh) rather than the caller having to remember to clamp before calling issue -- refresh.ts stays a pure, paseto-free decision layer; the port implementation is where the clamp is actually enforced against a real signing call."
    - "issueLicense (03-05) keeps returning a raw string -- it is the reference signing primitive a LicenseIssuer implementation composes, not something core proper calls. The mock issuer wraps issueLicense's output in mintHeldLicense immediately, so no bare token ever crosses the issuer boundary; this preserved 03-05's issue.test.ts/verify.test.ts unchanged rather than forcing every existing call site to unwrap a HeldLicense."

key-files:
  created:
    - packages/core/src/license/refresh.ts
    - packages/core/src/license/held-license.ts
    - packages/core/src/license/license-issuer.ts
    - packages/core/test/license/refresh.test.ts
    - packages/core/test/license/held-license.test.ts
  modified:
    - packages/core/src/license/issue.ts
    - packages/core/src/testing.ts
    - packages/core/src/index.ts
    - packages/core/test/public-api.test.ts

key-decisions:
  - "Sequencing deviation (Rule 3, blocking dependency): the plan's Task 1 file list (refresh.ts, license-issuer.ts, testing.ts, refresh.test.ts) required a HeldLicense return type for LicenseIssuer.issue/reissue, but held-license.ts was scoped to Task 2. Built held-license.ts as an enabling dependency in Task 1 (correct except deliberately unfrozen), then made Task 2's RED/GREEN cycle target specifically the still-outstanding, genuinely testable behavior (frozen-after-minting) rather than re-deriving the whole file from scratch. Documented explicitly in both task commit messages."
  - "issueLicense's signature is unchanged (still returns Promise<string>) rather than wrapping it in a HeldLicense directly, per the plan's own 'issueLicense (or the issuer)' discretion. Changing issueLicense's return type would have broken 03-05's existing issue.test.ts (which passes the raw token straight to verifyLicense) -- that test file isn't in this plan's file list, so it was out of scope to touch. Instead, the mock LicenseIssuer (this plan's actual new custody boundary) is the sole place that calls mintHeldLicense on issueLicense's output. issue.ts gained a documentation-only addition clarifying this custody boundary for any future LicenseIssuer implementation (Phase 7's mock publisher)."
  - "HeldLicense's raw token lives in a module-private WeakMap, not a public interface field -- a stricter reading of D-15's 'reachable only through one narrow accessor' than @stint/spec's VerifiedManifest analog (whose fields ARE public, since none of them are secret). Proved with an explicit type-level @ts-expect-error asserting `held.token` does not exist on the type, in addition to the brand-construction @ts-expect-error."
  - "LicenseIssuer.reissue(claims, specVersion, now, leaseExpiresAt, jti?) computes the clamp internally via clampedLicenseExpiry and returns null on refusal, rather than requiring the caller to pre-compute and pass an already-clamped expEpochSeconds. Keeps the port's contract self-enforcing: any implementation of reissue that skips the clamp is a code-review-visible bug in that implementation, not a caller mistake."

patterns-established:
  - "An opaque handle whose payload is secret-shaped (not just integrity-shaped) should store its payload in a module-private WeakMap rather than a typed public field, even when following the VerifiedManifest brand pattern otherwise -- the brand alone stops literal construction, but a public field is still directly readable on a genuine instance. Future secret-carrying handles (e.g. any Phase 4/5 credential-vault value) should follow this stricter variant, not the plain-field VerifiedManifest variant."

requirements-completed: [LIC-03]

coverage:
  - id: D1
    description: "needsRefresh(exp, now, refreshBeforeSeconds) is a pure per-call boundary decision (true once now >= exp - refreshBeforeSeconds), holding no state between calls"
    requirement: LIC-03
    verification:
      - kind: unit
        ref: "packages/core/test/license/refresh.test.ts (4 tests: below boundary, at boundary, past boundary, repeated-call statelessness)"
        status: pass
    human_judgment: false
  - id: D2
    description: "clampedLicenseExpiry(now, defaultTtlSeconds, leaseExpiresAt) returns min(now+ttl, leaseExpiresAt) and null once now >= leaseExpiresAt -- refresh refused, exercised end-to-end through the mock LicenseIssuer whose reissue's verified exp never exceeds leaseExpiresAt"
    requirement: LIC-03
    verification:
      - kind: unit
        ref: "packages/core/test/license/refresh.test.ts (4 pure clamp/refuse cases + 3 end-to-end mock-issuer reissue cases, verified via verifyLicense)"
        status: pass
    human_judgment: false
  - id: D3
    description: "HeldLicense is an opaque, minted-only handle; external construction fails to compile; the raw token is reachable only through readLicenseToken; the handle is frozen after minting -- LIC-05 custody enforced by construction"
    requirement: LIC-05 (compile-time guarantee; Phase 4 adds the adversarial runtime test)
    verification:
      - kind: unit
        ref: "packages/core/test/license/held-license.test.ts (5 tests: brand @ts-expect-error + throws, no-public-field @ts-expect-error, round-trip, frozen, throws-on-unminted)"
        status: pass
      - kind: other
        ref: "pnpm typecheck exits 0 -- both @ts-expect-error assertions hold"
        status: pass
    human_judgment: false
  - id: D4
    description: "@stint/core's main barrel exports the license public surface (needsRefresh, clampedLicenseExpiry, verifyLicense, LICENSE_CLOCK_SKEW_SECONDS, HeldLicense + readLicenseToken, LicenseIssuer) and never re-exports issueLicense or ./testing's createMockLicenseIssuer"
    verification:
      - kind: unit
        ref: "packages/core/test/public-api.test.ts (3 new tests: presence check, D-11/D-14 non-leak check, type-only compile check)"
        status: pass
    human_judgment: false

duration: ~45min
completed: 2026-09-28
status: complete
---

# Phase 3 Plan 6: Bounded License Refresh & Held-License Custody Summary

**A pure, clamped-per-call refresh decision (`needsRefresh`/`clampedLicenseExpiry`) that mathematically cannot mint a token outliving its lease, an opaque `HeldLicense` handle whose raw token lives in a module-private `WeakMap` (not a public field) so no code outside `license/` can ever read it except through one accessor, and the injectable `LicenseIssuer` port wiring them together -- exercised end-to-end through a mock issuer and wired into `@stint/core`'s public barrel.**

## Performance

- **Duration:** ~45 min
- **Completed:** 2026-09-28
- **Tasks:** 3 (Task 1 `tdd="true"`, Task 2 `tdd="true"`, Task 3 `type="auto"`)
- **Commits:** 5 (2 RED/GREEN pairs + 1 wiring commit)
- **Files touched:** 9 (5 created, 4 modified)

## Accomplishments

- Built `packages/core/src/license/refresh.ts`: `needsRefresh(exp, now, refreshBeforeSeconds)` and `clampedLicenseExpiry(now, defaultTtlSeconds, leaseExpiresAt)`, both pure epoch-seconds functions importing no `paseto` type -- the LIC-03 "no refreshed token can ever outlive the lease" guarantee, boundary-tested.
- Built `packages/core/src/license/held-license.ts`: `HeldLicense`, an opaque branded handle with NO public data fields at all (the raw token lives in a module-private `WeakMap<HeldLicense, string>`, not a typed interface property) -- `mintHeldLicense` and `readLicenseToken` are the only two functions that can ever touch the wrapped string. Frozen after minting.
- Built `packages/core/src/license/license-issuer.ts`: the injectable `LicenseIssuer` port (`issue`/`reissue`), where `reissue` internally applies the LIC-03 clamp and refuses (returns `null`) rather than ever signing an over-long expiry.
- Extended `packages/core/src/testing.ts` with `createMockLicenseIssuer()`: a `LicenseIssuer` backed by a fresh test Ed25519 keypair, composing the reference `issueLicense` (03-05) and wrapping its output in `mintHeldLicense` -- never handing a bare token to a caller.
- Wired `packages/core/src/index.ts`'s license public barrel: `needsRefresh`, `clampedLicenseExpiry`, `DEFAULT_LICENSE_TTL_SECONDS`, `verifyLicense`, `LICENSE_CLOCK_SKEW_SECONDS`, `LICENSE_VERIFY_REASONS`/`LicenseVerifyReason`, `HeldLicense` + `readLicenseToken`, `LicenseIssuer`, and the license claim types -- deliberately never exporting `issueLicense` or anything from `./testing`.
- 28 license-module tests pass (17 from 03-05 unchanged + 11 new in `refresh.test.ts`), 5 new in `held-license.test.ts`, 9 in `public-api.test.ts` (4 pre-existing + 5 new/extended assertions) -- all green.

## Task Commits

Each `tdd="true"` task followed a genuine RED -> GREEN split (target assertions failed intentionally on the behavior, not on import/compile errors):

1. **Task 1 RED:** `6f7abb9` (test) -- `refresh.test.ts` written against an intentionally-wrong `refresh.ts` stub (`needsRefresh` always `false`; `clampedLicenseExpiry` never clamps or refuses); 8/11 assertions failed on the target behavior.
2. **Task 1 GREEN:** `fb779d8` (feat) -- real `needsRefresh`/`clampedLicenseExpiry` implementation; all 11 assertions pass, including the end-to-end mock-issuer reissue.
3. **Task 2 RED:** `06d03f9` (test) -- `held-license.test.ts` written against `held-license.ts` (built ahead of schedule in Task 1 as an enabling dependency, deliberately left unfrozen); 1/5 assertions (frozen-after-minting) failed intentionally; the other 4 (brand, no-public-field, round-trip, throws-on-unminted) passed immediately since that mechanism was necessarily already built and correct in Task 1.
4. **Task 2 GREEN:** `4e232d1` (feat) -- `mintHeldLicense` now calls `Object.freeze`; all 5 assertions pass; `issue.ts` gained a documentation-only addition on the custody boundary; `pnpm typecheck` confirms both `@ts-expect-error` brand assertions hold.
5. **Task 3:** `111b0d2` (feat) -- license public barrel wired into `index.ts`; `public-api.test.ts` extended with presence, non-leak, and type-compile checks; full verification gate run (see below).

**Plan metadata:** pending (this commit).

## Files Created/Modified

- `packages/core/src/license/refresh.ts` (new) -- `needsRefresh`, `clampedLicenseExpiry`, `DEFAULT_LICENSE_TTL_SECONDS`
- `packages/core/src/license/held-license.ts` (new) -- `HeldLicense`, `mintHeldLicense`, `readLicenseToken`
- `packages/core/src/license/license-issuer.ts` (new) -- `LicenseIssuer` port interface
- `packages/core/src/license/issue.ts` (modified) -- documentation-only addition on the mint-at-the-issuer-boundary custody rule
- `packages/core/src/testing.ts` (modified) -- `createMockLicenseIssuer`, `MockLicenseIssuer`, `MOCK_LICENSE_ISSUER_KID`
- `packages/core/src/index.ts` (modified) -- license public barrel exports
- `packages/core/test/license/refresh.test.ts` (new) -- 11 tests
- `packages/core/test/license/held-license.test.ts` (new) -- 5 tests
- `packages/core/test/public-api.test.ts` (modified) -- 3 new tests extending the existing HOST-01 suite

## Decisions Made

See `key-decisions` in the frontmatter for the full list: the Task 1/Task 2 held-license.ts sequencing deviation, keeping `issueLicense`'s signature unchanged (mock issuer wraps it instead), the WeakMap-based (not public-field) custody storage, and `reissue` owning the clamp internally.

## Deviations from Plan

### Auto-fixed / Adjusted Issues

**1. [Rule 3 - blocking dependency] `held-license.ts` built ahead of the plan's Task 2 schedule**
- **Found during:** Task 1
- **Issue:** Task 1's own action text requires `LicenseIssuer`'s `issue`/`reissue` to return a `HeldLicense`, but `held-license.ts` was scoped to Task 2's `<files>` list -- a genuine forward reference that would not compile if executed literally in the listed order.
- **Fix:** Built `held-license.ts` (brand, `mintHeldLicense`, `readLicenseToken`) in Task 1, deliberately leaving it unfrozen so Task 2 still had a genuinely-RED-able behavior (frozen-after-minting) to drive its own RED/GREEN cycle, rather than silently pre-completing Task 2's work.
- **Files modified:** `packages/core/src/license/held-license.ts`
- **Commits:** `6f7abb9` (created, unfrozen), `4e232d1` (frozen, GREEN)

**2. [Discretion, not a deviation] `issueLicense`'s signature left unchanged**
- The plan's Task 2 action text offered "issueLicense (or the issuer)" as the choice for where `HeldLicense`-wrapping happens. Chose "the issuer" (the mock `LicenseIssuer` in `testing.ts`) specifically to avoid breaking 03-05's `issue.test.ts`, which is not in this plan's file list and calls `issueLicense`'s raw-string return directly.

None of the above are unresolved -- both are documented, intentional choices within the plan's stated discretion or the standard auto-fix rules.

## Issues Encountered

- **Pre-existing, out-of-scope test failure (not introduced by this plan):** `packages/spec/test/codegen.test.ts`'s "codegen check detects stale types" test fails with `ENOENT` on `receipt.schema.json`. This is a Phase 1 regression from 03-01's `codegen.mjs` change, already documented in `.planning/phases/03-receipts-licensing/deferred-items.md` (found during 03-03, confirmed still present and still unrelated here via `git log` on both files -- neither was touched by this plan). Not fixed here per the Scope Boundary rule.
- **Sandbox memory constraints (environment, not code):** identical to every prior Phase 3 plan -- repo-wide `vitest run`/`eslint .` are known to OOM in this sandbox. Worked around by scoping `vitest run` to `packages/core` (180 tests), `packages/spec` (79/80, the 1 failure being the pre-existing item above), and `packages/proxy`/`packages/cli` (4 tests) separately, and running `eslint` per-file on every file this plan touched (clean). `pnpm build`, `pnpm typecheck`, and `pnpm run check:alp` were run repo-wide without issue (these are not the OOM-prone commands).

## User Setup Required

None -- no external service configuration required.

## Next Phase Readiness

- `LicenseIssuer`, `createMockLicenseIssuer`, `needsRefresh`/`clampedLicenseExpiry`, and `HeldLicense`/`readLicenseToken` are ready for Phase 4's proxy (hold + inject-on-outbound-calls-only + the LIC-05 adversarial "never forwarded to the agent" test) and Phase 7's mock publisher (which reuses `createMockLicenseIssuer`'s shape per 03-05's own readiness note).
- Phase 3's licensing half (LIC-01, LIC-02 from 03-05; LIC-03 from this plan) is now fully green end-to-end. LIC-04 (revocation) and LIC-05's adversarial runtime test remain explicitly out of Phase 3's scope per `03-CONTEXT.md`.
- No blockers identified for 03-04 (receipts wave, runs next) or any later Phase 3/4 plan. 03-04 also edits `testing.ts`/`index.ts`; this plan's additions are purely additive (new exports/functions), so 03-04 should merge without conflict as long as it appends rather than reorders.

## Self-Check: PASSED

All 8 key files confirmed present on disk (`refresh.ts`, `held-license.ts`, `license-issuer.ts`, `refresh.test.ts`, `held-license.test.ts`, plus the modified `testing.ts`, `index.ts`, `public-api.test.ts`) and all 5 commits (`6f7abb9`, `fb779d8`, `06d03f9`, `4e232d1`, `111b0d2`) confirmed present in `git log --oneline --all`. `git diff --diff-filter=D 28cfb55 HEAD` returned no deleted files.

---
*Phase: 03-receipts-licensing*
*Completed: 2026-09-28*
