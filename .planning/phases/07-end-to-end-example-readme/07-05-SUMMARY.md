---
phase: 07-end-to-end-example-readme
plan: 05
subsystem: example
tags: [oauth-pkce, mock-publisher, mock-services, signed-manifest, run-profile, fixtures, loopback]
requires:
  - phase: 07-end-to-end-example-readme
    provides: "07-02 @stint/core/license-issuer + startMockAuthServer forceNextExpiresIn; 07-03 publisher wire protocol (license-http.ts), run-profile endpoints; 07-04 runLease hybrid composition"
provides:
  - "acquireGrant / acquireCredentialsFile / writeCredentialsFile: headless auth-code + PKCE against the mock AS, emitting the --credentials shape per resource"
  - "startMockPublisher: issue/reissue/invalidate (CLI wire protocol) + /alp/cleanup with verifyCleanupToken, single-use jti, scope-to-lease binding and a one-shot failNextCleanup"
  - "startPaystackMock / startOrdersSheetMock / startServices: 127.0.0.1 node:http mocks with a request recorder and assertNoLicenseLeak"
  - "buildSignedManifest / writeManifestFiles: the payment-reconciler vector, loopback cleanup hook, short approvals timeout, fresh publisher key + trust entry"
  - "buildRunProfile / writeJsonProfile / ordersRowAdapter: catalog, bindings, oauth, endpoints map, verifier rowAdapter, and the JSON twin for a spawned stint run"
  - "@stint/cli barrel now also exports loadRunProfile, parseRunProfile, httpIssuerTransport, createPublisherClient"
affects: [07-06, 07-07, 07-08, 07-09]
estimate:
  tokens: 66000
  raw_tokens: 41000
  tasks: 3
  confidence: low
actuals:
  tokens: 13500
  tasks: 3
  commits: 3
plan_head_before: 77434ff8c26c4be6673940b7697e8b0c30b8d21a
commits: 3
tech-stack:
  added: []
  patterns:
    - "Every mock is startX(): Promise<Harness> on 127.0.0.1:0 with observable counters, one-shot fault toggle and stop()"
    - "Publisher signs with the now/exp the runtime sends, so a shared runtime clock and the publisher always agree"
    - "Cleanup bearer honored only for a lease the publisher issued for (scope cleanup:<lease_id>); a failed attempt does not consume the jti"
key-files:
  created:
    - examples/payment-reconciler/src/oauth/acquire.ts
    - examples/payment-reconciler/src/mocks/publisher.ts
    - examples/payment-reconciler/src/mocks/services.ts
    - examples/payment-reconciler/src/manifest.ts
    - examples/payment-reconciler/src/profile.ts
    - examples/payment-reconciler/test/fixtures.test.ts
  modified:
    - packages/cli/src/index.ts
key-decisions:
  - "The mock publisher speaks the real CLI wire protocol ({license} JSON bodies from license-http.ts), not a raw-token body as the plan sketched, so the shipped createPublisherClient/httpIssuerTransport work against it unchanged."
  - "Cleanup authorization is scope-bound: the lease id is read from the verified cleanup:<lease_id> scope and must be one the publisher issued a license for (403 otherwise); with no runtime key pinned the hook fails closed (401)."
  - "The fixtures test round-trips the JSON profile through the CLI's own loadRunProfile, so that loader (plus the publisher client helpers) is now exported from the @stint/cli barrel, additively."
  - "issue_refund is deliberately absent from the catalog and bindings: the pay class is not granted, so the out-of-scope call denies no_binding (Pitfall 12)."
requirements-completed: [E2E-01, E2E-02]
status: complete
---

# Phase 7 Plan 5: Hermetic Backend Fixtures Summary

**The shared, deterministic "real stack minus the shipped runtime" fixtures are in place: a real headless PKCE acquisition against the mock AS, a license-issuing mock publisher with a cleanup failure toggle and single-use jti, recorded 127.0.0.1 Paystack and orders-sheet mocks, and the signed hybrid manifest plus in-code and JSON run profiles.**

## Accomplishments
- Task 1 (tracer): `acquireGrant` runs the headless auth-code + PKCE flow (`fetch` with `redirect: "manual"`, `validateAuthResponse` for state/iss, code exchange with the RFC 8707 `resource` and S256 verifier) and returns a `LoadedCredential` per resource; `forceNextExpiresIn(1)` yields an expiry delta of exactly 1. `startMockPublisher` issues PASETO v4.public licenses that `createLicenseIssuerClient` verifies then mints, refuses reissue after `invalidate`, and can decline reissue on demand. `/alp/cleanup` verifies the EdDSA bearer with `verifyCleanupToken`, returns 500 exactly once after `failNextCleanup()` and 409 for a replayed jti. Tracer gate: build plus the scoped `fixtures.test.ts` passed before expanding.
- Task 2: `startPaystackMock` and `startOrdersSheetMock` (plus `startServices`) record method, url, every header and the raw body. The sheet distinguishes a read (`{}`, including the verifier's synthetic read) from a write (`{ order_id, status }`) by body shape, returns 404 for an unknown order, and exposes live `rows` and `readHits`/`writeHits`. `assertNoLicenseLeak` throws on any `v4.public.` substring in a url, header or body.
- Task 3: `buildSignedManifest` starts from `spec/vectors/valid/payment-reconciler.json`, overrides only `cleanup.hook.url` and `approvals.timeout_seconds`, signs with a fresh publisher key through `@stint/spec/testing` and returns the envelope bytes, trust entry and private key. `buildRunProfile` returns an in-code `RunProfile` (three tools, `mark_order_reconciled` irreversible, `rowAdapter` on the `read_orders` binding, loopback `endpoints`); `writeJsonProfile` writes the JSON twin without the function.
- Verification: 12 tests in `test/fixtures.test.ts` pass; `tsc -b examples/payment-reconciler`, eslint on every new file and the build are clean.

## Verification evidence
- Credential carries non-empty tokens, `resourceIndicator` equal to the requested resource, `clientId`, `revocationEndpoint`, and `expiry = now + 3600`; the AS saw `grant_type=authorization_code`, the `resource` indicator and a `code_verifier`.
- Publisher: issued token starts `v4.public.`, `issueHits`/`reissueHits`/`invalidateHits` count exactly; cleanup sequence `401 (no key) -> 401 (no bearer) -> 401 (forged) -> 403 (foreign lease) -> 500 (armed) -> 200 -> 409 (replay) -> 200` with `seenJtis` recording only accepted jtis and `cleanupHits` 8.
- Services: bearer recorded verbatim; `assertNoLicenseLeak` passes for an access-token request and throws when a `v4.public.` value appears in a header or a body.
- Manifest verifies via `parseEnvelope` + `verifyEnvelope` against its own trust entry, stays `hybrid` with the `resource_query` verifier; the JSON profile round-trips through `loadRunProfile`/`parseRunProfile` and contains no `rowAdapter` and no secret-shaped field.
- `grep` finds no `@stint/core/testing` import under `examples/payment-reconciler` (two doc comments name it as forbidden).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Profile/publisher-client helpers not reachable from the example**
- **Found during:** Task 1/3 test design
- **Issue:** The plan requires the fixtures test to verify the license through the runtime client and to round-trip the JSON profile through `loadRunProfile`/`parseRunProfile`, but neither those nor `httpIssuerTransport` were exported from the `@stint/cli` barrel, and the example cannot import cli internals across package roots.
- **Fix:** Additive barrel exports of `loadRunProfile`, `parseRunProfile`, `createPublisherClient`, `httpIssuerTransport` (existing `public-api` assertions remain valid; they assert presence, not an exact key list).
- **Files modified:** packages/cli/src/index.ts
- **Commit:** 1233e01

**2. [Rule 1 - Plan/protocol mismatch] Publisher returns `{ license }` JSON, not a raw token body**
- **Found during:** Task 1
- **Issue:** The plan text says the issue route returns the raw token string, but the shipped CLI transport (`license-http.ts`) reads `{ license: string | null }` and posts `{ claims, spec_version, now, exp | lease_expires_at }`.
- **Fix:** The mock implements the real wire protocol, so the shipped client and later plans work against it unchanged.
- **Commit:** 1233e01

**3. [Rule 2 - Security] Cleanup hook is scope-bound and fails closed**
- **Found during:** Task 1
- **Issue:** The cleanup request carries only a bearer (no lease id in the URL or body), so the plan's `scope !== cleanup:<leaseId>` check needs a lease id source.
- **Fix:** The publisher remembers the leases it issued for and honors a cleanup bearer only for one of them (403 otherwise); with no runtime public key pinned it answers 401. `setRuntimePublicKey()` pins the key after `stint create`.
- **Commit:** 1233e01

### Test-only adjustments
- Dropped an invented assertion that two resources yield distinct access tokens: the mock AS mints identical tokens within one second, which is a property of the mock, not a defect.

## Authentication gates
None.

## Known Stubs
None. The Paystack and sheet data are intentional fixed mock data; nothing flows to a UI.

## Threat Flags
None. All new surface is loopback test fixtures; the cleanup and license endpoints exist only in the mock and enforce the T-07-REPLAY and T-07-LIC mitigations in the plan's threat register.

## Self-Check: PASSED
- Files present: acquire.ts, publisher.ts, services.ts, manifest.ts, profile.ts, fixtures.test.ts, packages/cli/src/index.ts.
- Commits present: 1233e01, b78baab, e0fcbb6.
