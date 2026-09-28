---
phase: 03-receipts-licensing
plan: 05
subsystem: licensing
tags: [paseto, ed25519, pasetov4public, jwt-alternative, license, implicit-assertion, clock-skew]

# Dependency graph
requires:
  - phase: 03-receipts-licensing
    plan: 01
    provides: "@stint/core error-vocabulary and Result<T> conventions (errors.ts pattern); spec/ALP.md structure this plan edits section 8 of"
provides:
  - "packages/core/src/license/implicit-assertion.ts: deriveImplicitAssertion(leaseId, specVersion), the single shared derivation issue.ts and verify.ts both import"
  - "packages/core/src/license/issue.ts: issueLicense (paseto@4.0.1 factory-composition Sign), LicenseClaims/LicenseJobClaim/LicenseLimitsClaim types"
  - "packages/core/src/license/verify.ts: verifyLicense (paseto@4.0.1 factory-composition Verify), LICENSE_CLOCK_SKEW_SECONDS (5s), VerifiedLicense"
  - "packages/core/src/license/errors.ts: LICENSE_VERIFY_REASONS fixed vocabulary (license_claim_invalid, license_invalid_signature, license_verification_failed)"
  - "spec/ALP.md section 8: [OPEN: Phase 3] resolved with the normative hosted-license claim set and implicit-assertion derivation"
  - "spec/vectors/license/: claims.json, public-key.jwk.json, implicit-assertion-input.txt, valid-token.txt (fixed jti, reproducible), invalid-wrong-lease.txt"
affects: [03-06, phase-04-proxy, phase-07-mock-publisher]

# Actuals (#2632)
actuals:
  tokens: 8323
  tasks: 4
  commits: 4

# Tech tracking
tech-stack:
  added: ["paseto@4.0.1 (exact pin, panva, PASETO v4.public factory-composition API)"]
  patterns:
    - "issue.ts/verify.ts compose paseto@4.0.1's factory API: `new PublicProtocol(SignFactory)` / `new PublicProtocol(VerifyFactory)` from the root `paseto` module plus `paseto/v4/public` -- never the classic 3.x V4.sign/V4.verify static namespace"
    - "verify.ts's err() helper mirrors packages/spec/src/envelope.ts's discipline: every PasetoError subclass (ClaimValidationError, InvalidTokenError, InvalidKeyError) and any other throw collapses to one fixed, non-interpolated LicenseVerifyReason -- the library's own exception text is never forwarded"
    - "exp/nbf are always set as explicit RFC 3339 claims derived from the caller's injected epoch-seconds clock (new Date(epochSeconds*1000).toISOString()); paseto's own expiresIn option is never used, since it cannot express the LIC-03 min(now+ttl, lease.expiresAt) clamp a caller already applied"
    - "kid lives only in the token's (authenticated, public/non-secret) footer, a plain JSON.stringify({kid}) -- not canonicalized, since the footer plays no role in any hash chain, unlike the implicit assertion which reuses @stint/spec's canonicalize"

key-files:
  created:
    - packages/core/src/license/implicit-assertion.ts
    - packages/core/src/license/issue.ts
    - packages/core/src/license/verify.ts
    - packages/core/src/license/errors.ts
    - packages/core/test/license/issue.test.ts
    - packages/core/test/license/verify.test.ts
    - spec/vectors/license/claims.json
    - spec/vectors/license/public-key.jwk.json
    - spec/vectors/license/implicit-assertion-input.txt
    - spec/vectors/license/valid-token.txt
    - spec/vectors/license/invalid-wrong-lease.txt
  modified:
    - packages/core/package.json
    - spec/ALP.md
    - spec/vectors/README.md

key-decisions:
  - "Task 1 checkpoint (blocking-human): human confirmed paseto@4.0.1 legitimacy before install -- maintainer panva (same as trusted jose/oauth4webapi), 4.0.1 published via GitHub Actions OIDC trusted-publish, zero runtime dependencies, and the shipped v4/public.d.ts/index.d.ts confirmed as the factory-composition API (PublicProtocol/SignFactory/VerifyFactory), not classic 3.x V4.sign/V4.verify."
  - "Task 2 checkpoint (one-way decision): confirmed the section 8 license wire format verbatim -- custom claims lease_id/job/limits (snake_case); registered exp/iat/nbf/jti; kid in footer; implicit assertion over lease_id + the MANIFEST's own spec_version (Option A, not @stint/spec's runtime SPEC_VERSION constant); 300s TTL as runtime config only, never in the manifest. This exact format is what issue.ts/verify.ts/spec/ALP.md sec 8/the vectors all implement."
  - "LicenseJobClaim = { description: string } and LicenseLimitsClaim = { max_actions: number, actions_per_hour: number | null } (Claude's Discretion per CONTEXT.md): a purpose-built subset of the manifest's Job/Limits shapes, not those types verbatim -- the manifest types carry an `[k: string]: unknown` x-extension index signature that is not JSON-value-compatible with paseto's ClaimsInput generic constraint, and Job.verifier has no meaning inside an entitlement license."
  - "jti defaults to crypto.randomUUID() with an optional caller-supplied override, letting production issuance generate a fresh id per call while the license vector generation used a fixed value for byte-reproducibility (Ed25519 signing is deterministic per RFC 8032, so identical claims+key+clock+jti reproduce an identical token)."
  - "Error mapping: ClaimValidationError -> license_claim_invalid; InvalidTokenError and InvalidKeyError -> license_invalid_signature; any other throw -> license_verification_failed (the catch-all default, never leaving a code path unmapped)."
  - "A token issued for a different lease_id is rejected via the implicit-assertion mechanism itself (its bytes no longer match what the token was signed under, so paseto's own signature authentication fails as InvalidTokenError) rather than a redundant manual lease_id claim comparison after verification."

patterns-established:
  - "License verification failures are a Result<VerifiedLicense> with a fixed LicenseVerifyReason vocabulary, deliberately independent of SpecErrorCode, CoreErrorCode, and ReceiptVerifyReason (mirrors receipts/errors.ts's own documented discipline) -- future license-adjacent modules (LicenseIssuer port, refresh) should follow the same independent-vocabulary pattern rather than reusing or aliasing this one."

requirements-completed: [LIC-01, LIC-02]

coverage:
  - id: D1
    description: "issueLicense issues a PASETO v4.public license carrying lease_id/job/limits as custom claims and exp/iat/nbf/jti as registered claims, with kid in the footer and a 300s-scale default TTL set as an explicit clamped exp claim (never paseto's expiresIn)"
    requirement: LIC-01
    verification:
      - kind: unit
        ref: "packages/core/test/license/issue.test.ts (5 tests: deriveImplicitAssertion determinism/differentiation, round-trip, exp-decodes-to-clamped-value)"
        status: pass
    human_judgment: false
  - id: D2
    description: "verifyLicense verifies offline with the publisher public key using one shared deriveImplicitAssertion and an explicit, tested LICENSE_CLOCK_SKEW_SECONDS tolerance (never the library's zero default); a wrong-lease token, an expired-beyond-skew token, and a tampered signature are all rejected with fixed, non-interpolated reason codes, never the paseto exception text"
    requirement: LIC-02
    verification:
      - kind: unit
        ref: "packages/core/test/license/verify.test.ts (12 tests: golden-vector accept/reject, D-14 clock-skew boundary x3, D-16 tampered-signature + no-secret-in-error)"
        status: pass
    human_judgment: false
  - id: D3
    description: "spec/ALP.md section 8's [OPEN: Phase 3] marker is resolved with the normative hosted-license claim set and implicit-assertion derivation; check:alp passes"
    verification:
      - kind: other
        ref: "node scripts/check-alp-sections.mjs -- ALP check passed; node -e assertion confirming section 8 no longer contains \"[OPEN: Phase 3]\""
        status: pass
    human_judgment: false

duration: ~50min (across 2 blocking-human checkpoints: package legitimacy, section-8 wire-format decision)
completed: 2026-09-28
status: complete
---

# Phase 3 Plan 5: PASETO v4.public License Issue/Verify Summary

**PASETO v4.public license issuance and offline verification with one shared implicit-assertion derivation, an explicit 5-second clock-skew tolerance (never the library's zero default), and `spec/ALP.md` section 8 resolved with the license conformance vector pinned.**

## Performance

- **Duration:** ~50 min (includes 2 blocking-human checkpoints: package-legitimacy gate, section-8 wire-format decision)
- **Completed:** 2026-09-28
- **Tasks:** 4 (Task 1 `checkpoint:human-verify`, Task 2 `checkpoint:decision`, Tasks 3-4 `type="auto" tdd="true"`)
- **Files modified:** 15 (11 created, 4 modified)

## Accomplishments

- Human-verified `paseto@4.0.1` legitimacy (maintainer `panva`, OIDC trusted-publish, zero dependencies, factory-composition API confirmed from the shipped `.d.ts`) before installing it exact-pinned into `packages/core/package.json`.
- Confirmed the one-way section 8 license wire format with the user: snake_case custom claims (`lease_id`, `job`, `limits`), registered `exp`/`iat`/`nbf`/`jti`, `kid` in the footer, implicit assertion over `lease_id` + the manifest's own `spec_version` (not `@stint/spec`'s runtime constant).
- Built `packages/core/src/license/implicit-assertion.ts`: `deriveImplicitAssertion(leaseId, specVersion)`, the single shared derivation (canonical `@stint/spec` bytes of `{ lease_id, spec_version }`) imported by both `issue.ts` and `verify.ts` -- never recomputed twice.
- Built `packages/core/src/license/issue.ts`: `issueLicense` composing `paseto@4.0.1`'s factory API (`PublicProtocol` + `SignFactory`); sets `exp`/`nbf` as explicit RFC 3339 claims from the caller's injected epoch-seconds clock (never `expiresIn`); `kid` carried only in the footer; `jti` defaults to `crypto.randomUUID()` with an optional fixed override for reproducible vectors.
- Built `packages/core/src/license/verify.ts`: `verifyLicense` composing `PublicProtocol` + `VerifyFactory`, the single call site of paseto's `Verify`; exports `LICENSE_CLOCK_SKEW_SECONDS = 5`, always passed explicitly; every `PasetoError` subclass (`ClaimValidationError`, `InvalidTokenError`, `InvalidKeyError`) and any other throw maps to one of `errors.ts`'s three fixed reason codes, never forwarding the library's own exception text.
- Resolved `spec/ALP.md` section 8's `[OPEN: Phase 3]` marker with the normative hosted-license claim set and implicit-assertion derivation; `check:alp` passes.
- Authored `spec/vectors/license/` (claims, public key JWK, implicit-assertion input, a reproducible valid token with a fixed `jti`, and a wrong-lease invalid token) and documented the set in `spec/vectors/README.md`.
- Wrote `packages/core/test/license/issue.test.ts` (5 tests) and `packages/core/test/license/verify.test.ts` (12 tests, including the D-14 clock-skew boundary and D-16 tampered-signature/no-secret-in-error cases) -- 17 tests total, all passing; confirmed no module outside `issue.ts`/`verify.ts` imports a `paseto` type.

## Task Commits

Each task was committed atomically (Tasks 3 and 4 each followed a RED -> GREEN split per their `tdd="true"` marking):

1. **Task 1: Package legitimacy gate - confirm paseto@4.0.1 before install** - `3b6fabb` (chore)
2. **Task 2: Confirm the one-way section 8 license wire format** - checkpoint only, no code; decision recorded in this SUMMARY and honored verbatim by Tasks 3-4
3. **Task 3 RED: failing tests for implicit assertion, issue, verify** - `1c6d023` (test)
   **Task 3 GREEN: implement license issue/verify, resolve spec sec 8** - `7f65841` (feat)
4. **Task 4: clock-skew boundary + error-mapping tests** - `ceaa1df` (test; no `verify.ts` changes needed, see Issues Encountered)

**Plan metadata:** pending (this commit)

_Note: Tasks 3 used a genuine RED/GREEN split (5/7 tests failed on the intended "not implemented" stub throw or on not-yet-authored vector files at RED time, not on import/syntax errors); Task 4's new tests passed immediately against the existing Task 3 implementation, which already satisfied the D-14/D-16 boundary requirements._

## Files Created/Modified

- `packages/core/src/license/implicit-assertion.ts` - `deriveImplicitAssertion`, the one shared implicit-assertion function
- `packages/core/src/license/issue.ts` - `issueLicense`, `LicenseClaims`/`LicenseJobClaim`/`LicenseLimitsClaim`
- `packages/core/src/license/verify.ts` - `verifyLicense`, `LICENSE_CLOCK_SKEW_SECONDS`, `VerifiedLicense`
- `packages/core/src/license/errors.ts` - `LICENSE_VERIFY_REASONS`, `LicenseVerifyReason`, `Result<T>`
- `packages/core/test/license/issue.test.ts` - 5 tests (implicit-assertion + round-trip + exp-decode)
- `packages/core/test/license/verify.test.ts` - 12 tests (golden vector + D-14 boundary + D-16 sanitization)
- `packages/core/package.json` - `paseto` added, exact-pinned `4.0.1`
- `spec/ALP.md` - section 8 `[OPEN: Phase 3]` resolved
- `spec/vectors/README.md` - new `license/` subsection documenting the vector set
- `spec/vectors/license/claims.json`, `public-key.jwk.json`, `implicit-assertion-input.txt`, `valid-token.txt`, `invalid-wrong-lease.txt` - the license conformance vector

## Decisions Made

See `key-decisions` in the frontmatter for the full list (checkpoint outcomes, claim sub-shape design, `jti` default, error-code mapping, and the implicit-assertion-based lease rejection mechanism). All were within the plan's stated "Claude's Discretion" scope (CONTEXT.md) except Tasks 1-2, which were explicit human checkpoints.

## Deviations from Plan

None - plan executed exactly as written, including both blocking-human checkpoints. The discretionary design choices above (claim sub-shapes, `jti` default) are within CONTEXT.md's explicitly delegated "Claude's Discretion" scope, not deviations from a specified design.

## Issues Encountered

- **Wrong paseto import path (self-caught during RED phase):** Initially imported `PublicProtocol` from `paseto/v4/public` in a test file; that submodule only exports the version-specific factories (`SignFactory`, `VerifyFactory`, `GenerateKeyPairFactory`, etc.), not the composing `PublicProtocol` constructor, which lives in the root `paseto` module. Fixed before the RED-phase commit by splitting the import correctly (`import { PublicProtocol } from "paseto"` + `import { GenerateKeyPairFactory } from "paseto/v4/public"`).
- **Task 4 produced no source changes:** Task 4's new boundary/tamper/sanitization tests all passed immediately against the Task 3 implementation, since `verify.ts`'s `LICENSE_CLOCK_SKEW_SECONDS` tolerance and `err()` mapping were already correct. This is expected for a task whose job is proving an existing invariant at its exact boundary, not adding new behavior -- confirmed by re-running `tsc -b` and `eslint` clean, and grepping `packages/core/src` to confirm only `issue.ts`/`verify.ts` import `paseto`.
- **Sandbox memory constraints (environment, not code):** Repo-wide `vitest run` and `eslint .` are known to OOM in this sandbox. Worked around identically to prior Phase 3 plans: `vitest run <files> --pool=threads` scoped to the license test files (and separately to all of `packages/core` for a regression check: 142/142 tests passed), and `eslint` invoked per-file rather than repo-wide.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `issueLicense`/`verifyLicense`/`deriveImplicitAssertion` are ready for 03-06 and for Phase 4's proxy (license hold + inject + never-forward, LIC-03/LIC-05) and Phase 7's mock publisher to build on.
- Not yet built (explicitly out of this plan's `files_modified` scope): the injectable `LicenseIssuer` port and `@stint/core/testing` mock publisher (D-11), and `needsRefresh`/the clamped-TTL refresh decision (LIC-03) -- these consume `issueLicense`/`verifyLicense` as-is and were not part of this plan's file list.
- No blockers identified for the remaining Phase 3 plans.

## Self-Check: PASSED

All key files confirmed present on disk (`implicit-assertion.ts`, `issue.ts`, `verify.ts`, `errors.ts`, `issue.test.ts`, `verify.test.ts`, all five `spec/vectors/license/*` files, `spec/ALP.md`, `spec/vectors/README.md`, `packages/core/package.json`) and all four task commits (`3b6fabb`, `1c6d023`, `7f65841`, `ceaa1df`) confirmed present in `git log --oneline --all`.

---
*Phase: 03-receipts-licensing*
*Completed: 2026-09-28*
