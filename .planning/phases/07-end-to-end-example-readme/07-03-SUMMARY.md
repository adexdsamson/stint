---
phase: 07-end-to-end-example-readme
plan: 03
subsystem: cli
tags: [loopback, allowInsecureRequests, hybrid, publisher-binding, license-issuer, teardown, paserk]
requires:
  - phase: 07-end-to-end-example-readme
    provides: "07-02 @stint/core/license-issuer subpath (reference issuer, verify-then-mint client)"
provides:
  - "isLoopbackHttp(url): shared loopback-only rule for allowInsecureRequests (D-16)"
  - "run/revoke/cleanup treat hybrid as OAuth-bearing (mode !== hosted)"
  - "stint create --publisher <file>: issue-once activation guard and persisted leases/<id>/publisher.json"
  - "createPublisherClient / httpIssuerTransport / licenseClaimsFromManifest (packages/cli/src/run/license-http.ts)"
  - "loadPublisherBinding / savePublisherBinding / parsePublisherBindingFile"
  - "Real teardown license collaborator: invalidate_license calls the publisher for hosted/hybrid, not_applicable for delegated"
  - "@stint/core/license-issuer importLicensePublicKey / exportLicensePublicKey / isPublicPaserk"
affects: [07-04, 07-05, 07-06, 07-07, 07-08, 07-09]
estimate:
  tokens: 66000
  raw_tokens: 41000
  tasks: 3
  confidence: low
actuals:
  tokens: 11500
  tasks: 3
  commits: 3
plan_head_before: e83bb6fe65544629ee9b18c2863eff8e91269736
commits: 3
tech-stack:
  added: []
  patterns:
    - "Loopback-only insecure-transport rule derived from the URL, never a blanket flag"
    - "Publisher binding is non-secret runtime config persisted beside the lease (like envelope.json)"
    - "Teardown runs in its own process: custody says hasLicense for hosted/hybrid so the publisher is told for real"
key-files:
  created:
    - packages/cli/src/run/loopback.ts
    - packages/cli/src/run/license-http.ts
    - packages/cli/src/store/publisher-binding.ts
    - packages/cli/test/loopback.test.ts
    - packages/cli/test/teardown-license.test.ts
    - packages/cli/test/helpers/publisher-stub.ts
    - packages/core/src/license/public-key.ts
    - packages/core/test/license-public-key.test.ts
  modified:
    - packages/cli/src/commands/run.ts
    - packages/cli/src/commands/teardown-support.ts
    - packages/cli/src/commands/create.ts
    - packages/cli/src/program.ts
    - packages/cli/src/deps.ts
    - packages/cli/test/create.test.ts
    - packages/cli/test/helpers/teardown-rig.ts
    - packages/core/src/license-issuer.ts
    - packages/core/test/public-api.test.ts
key-decisions:
  - "D-14 published-surface change was already APPROVED at the 07-02 checkpoint; not re-asked."
  - "TeardownSeams.allowInsecureRequests was REMOVED (not kept as a test override): the flag is derived from the credentials' endpoints, true only when every endpoint is https or loopback http and at least one is loopback http. A blanket seam could re-open the hole."
  - "Publisher wire protocol defined here: POST JSON; issue/reissue reply { license: string|null }; invalidate 2xx. Failures are fixed-text errors; redirects are refused."
  - "License is verified and dropped at create (D-18 two-issue model); run re-issues for custody in 07-04."
  - "A hosted/hybrid lease with no stored binding records invalidate_license as failed rather than ok."
requirements-completed: [E2E-01, E2E-02]
status: complete
---

# Phase 7 Plan 3: Hybrid-aware CLI and publisher binding Summary

**The CLI now treats hybrid as OAuth-bearing, allows insecure transport only for loopback http (negative test enforced), issues the license once at `create --publisher` and persists the binding, and makes `invalidate_license` a real publisher call.**

## Accomplishments
- Task 1 (tracer): `isLoopbackHttp` returns true only for `http:` with host `localhost`, `127.0.0.1` or `[::1]`; everything else, including lookalikes (`127.0.0.1.evil.test`, `127.0.0.1@evil.test`), https, and unparseable input, is false. `run.ts` and `teardown-support.ts` now use `mode !== "hosted"`. The teardown vault's `allowInsecureRequests` is derived from the credential's token and revocation endpoints. Tracer gate: build plus scoped `loopback.test.ts` passed, and revoke/cleanup/run-approvals stayed green before expanding.
- Task 2: `stint create` on a hosted/hybrid manifest requires `--publisher <file>` (usage exit, fixed text, before any consent). The file is validated (three URLs each https or loopback http, `k4.public` PASERK that actually imports). After consent is granted and before activation, the license is issued once through the verify-then-mint client; any failure reduces the lease to `failed` with a fixed message. On success `leases/<id>/publisher.json` is written beside the envelope. The old "Hosted license issuance is not available" refusal is gone (closes A8).
- Task 3: `buildTeardownDeps` now always passes a license collaborator. Hosted/hybrid with a binding: `/license/invalidate` is called for real (once; not repeated on a `cleanup_incomplete` retry because completed steps are skipped). Delegated: `not_applicable`. Missing binding or unreachable publisher: `failed`.

## Task Commits
1. Task 1: `18596b6` feat(07-03): derive loopback-only allowInsecureRequests and treat hybrid as OAuth-bearing
2. Task 2: `7cd0127` feat(07-03): add create --publisher issue-once activation guard and publisher binding
3. Task 3: `99fd948` feat(07-03): make invalidate_license a real publisher call in teardown

## Verification
- `pnpm build` green; `tsc -b packages/cli packages/core` clean; scoped eslint on all touched source and tests clean; prettier clean on touched files.
- Scoped vitest green: `packages/cli` whole package (262 tests, run twice after one flake, see below), `packages/core/test/{public-api,license-public-key}`.
- `program.ts` still registers the same seven commands; only `--publisher` was added to `create`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] PASERK key import lives in core, not the CLI**
- **Found during:** Task 2
- **Issue:** The binding carries a `k4.public` PASERK string, but `paseto` is not a CLI dependency and `importPaserk` did not exist anywhere. Adding `paseto` to the CLI would change the lockfile.
- **Fix:** Added `importLicensePublicKey`, `exportLicensePublicKey`, `isPublicPaserk` to `@stint/core/license-issuer` (additive, public keys only, fixed-message errors, not on the root entry). Pinned in `public-api.test.ts`.
- **Files modified:** packages/core/src/license/public-key.ts, packages/core/src/license-issuer.ts, packages/core/test/license-public-key.test.ts, packages/core/test/public-api.test.ts
- **Commit:** 7cd0127

**2. [Rule 1 - Bug] Plan said to keep passing `undefined` for delegated so the step returns `not_applicable`**
- **Found during:** Task 3
- **Issue:** With `license` undefined, `createDefaultTeardownSteps` uses a happy-path placeholder that returns `ok`, so delegated leases would keep a false `ok` and the `not_applicable` acceptance criterion could not hold.
- **Fix:** Delegated now gets a collaborator whose custody reports no license, yielding the honest `not_applicable`.
- **Commit:** 99fd948

**3. [Rule 2 - Missing critical functionality] Removed the blanket `TeardownSeams.allowInsecureRequests`**
- **Issue:** Keeping the seam as a test override would let a caller enable insecure transport for any host, contradicting D-16 and the plan's prohibition.
- **Fix:** Field removed from `deps.ts`; `teardown-rig.ts` no longer sets it (its loopback AS is allowed by the derived rule). Also the derived rule refuses a mixed AS where one endpoint is non-loopback http.
- **Commit:** 18596b6

**4. Additional files** beyond the plan's list: `packages/cli/src/run/license-http.ts` (HTTP transport, chosen as a new file), `packages/cli/test/helpers/publisher-stub.ts`, `packages/cli/src/deps.ts`, `packages/cli/test/helpers/teardown-rig.ts`, and the core files above. `packages/cli/src/index.ts` was not changed (nothing exported from the barrel yet, per plan).

## Deferred Issues
- One full-package run of the CLI tests showed a single transient failure in `revoke.test.ts` ("an unknown lease exits 4...", fixture `create` exited 5 with `unknown_publisher`). It did not reproduce in five further runs (file alone x3, whole package x2). The test does not touch code changed here; it looks like a Windows file-timing flake in the fixture's `trust.json` handling. Not fixed (out of scope).

## Known Stubs
None.

## Threat Flags
None beyond the plan's threat model. New network surface is the CLI to publisher HTTP client, covered by T-07-PASETO, T-07-TOKENLOG, T-07-BINDURL (https or loopback-http URLs only, redirects refused, fixed-text errors, tests assert no token/URL/upstream text in output).

## Self-Check: PASSED
