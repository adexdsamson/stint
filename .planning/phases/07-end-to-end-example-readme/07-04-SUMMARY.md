---
phase: 07-end-to-end-example-readme
plan: 04
subsystem: cli
tags: [runLease, hybrid, endpoints, license-custody, verifyOutcome, teardown, loopback]
requires:
  - phase: 07-end-to-end-example-readme
    provides: "07-03 isLoopbackHttp, createPublisherClient/httpIssuerTransport/licenseClaimsFromManifest, publisher binding, publisher-stub"
provides:
  - "Optional run-profile `endpoints` map (resource identifier -> https/loopback URL), applied by a fetch wrapper around the REST connector"
  - "runLease builds the vault with loopback-derived allowInsecureRequests and real teardownSteps (vault + license custody + cleanup hook + signing key)"
  - "In-memory per-lease license custody with best-effort, clamped per-call refresh (LIC-03/05, D-17)"
  - "RunningLease.verifyOutcome(): host-side resource_query verification -> completed -> auto-chained teardown (D-15)"
  - "@stint/cli barrel exports runLease, createRealDeps, RunningLease, RunLeaseOptions, RunProfile"
  - "test helpers: hybrid-fixture.ts (hybrid lease + mock AS + publisher stub + two loopback customer APIs), publisher-stub `decline` behavior"
affects: [07-05, 07-06, 07-07, 07-08, 07-09]
estimate:
  tokens: 70000
  raw_tokens: 44000
  tasks: 3
  confidence: low
actuals:
  tokens: 10100
  tasks: 3
  commits: 2
plan_head_before: aafea93f386181e791e369b49c4b8d3024b0dcc6
commits: 2
tech-stack:
  added: []
  patterns:
    - "runLease is the single composition point shared by the in-process harness and the spawned `stint run`"
    - "License custody is a closure: held for refresh bookkeeping only, never read out, never passed to the connector"
    - "Best-effort refresh: every failure mode collapses to 'custody unchanged', never a deny and never an expiry move"
key-files:
  created:
    - packages/cli/test/run-lease-hybrid.test.ts
    - packages/cli/test/run-lease-verify.test.ts
    - packages/cli/test/helpers/hybrid-fixture.ts
  modified:
    - packages/cli/src/run/run-lease.ts
    - packages/cli/src/run/profile.ts
    - packages/cli/src/commands/run.ts
    - packages/cli/src/index.ts
    - packages/cli/test/public-api.test.ts
    - packages/cli/test/helpers/publisher-stub.ts
key-decisions:
  - "D-15 checkpoint APPROVED by the human: RunningLease.verifyOutcome() added as a host-side-only method (not an MCP tool)."
  - "verifyOutcome only uses a READ binding carrying a rowAdapter for the verifier resource, because the synthetic verifier read POSTs an empty body; a write binding is never used for it."
  - "hasLicense is true for any hosted/hybrid lease (the publisher holds a license issued at create) whether or not this process holds a copy, so invalidate_license is told for real; discard drops the in-memory reference."
  - "An unreachable or refusing publisher at run start is best-effort (no held license, calls still work); per-call refresh retries (D-17)."
  - "Refresh is single-flight per lease and re-reads the stored lease so it clamps to the CURRENT expiresAt."
requirements-completed: [E2E-01, E2E-02]
status: complete
---

# Phase 7 Plan 4: runLease hybrid composition and host-side verifyOutcome Summary

**`runLease` now works end-to-end for a hybrid lease: identifier-to-URL endpoint mapping, loopback-safe vault, real teardown steps, in-memory clamped license refresh that never leaks the license, and a host-only `verifyOutcome()` that completes a lease through the manifest's `resource_query` verifier and chains teardown to `cleaned_up`.**

## Accomplishments
- Task 1 (tracer): profile `endpoints` parses (https or loopback http only, fixed usage error otherwise, optional so existing profiles are unchanged). `runLease` wraps the outbound fetch with an identifier-to-URL map, builds the vault with `allowInsecureRequests` only when the profile token endpoint is loopback http, and passes real `teardownSteps` built by `createDefaultTeardownSteps` (vault, license collaborator, cleanup hook URL from the verified manifest, runtime signing key). Tracer gate: build plus scoped `run-lease-hybrid.test.ts` passed, and the existing run/teardown suites stayed green before expanding.
- Task 2: in-memory license custody with best-effort per-call refresh before an allowed call (`needsRefresh`, `reissue` clamped to the stored lease's `expiresAt`); `RunningLease.verifyOutcome()`; `run.ts` builds the publisher client from the persisted binding and passes it as `licenseIssuer`; barrel exports plus `public-api.test.ts` assertions.
- Tests: 21 new (10 hybrid/profile, 11 verify/custody). Whole `packages/cli` suite passes (25 files, 285 tests), `tsc -b`, build, eslint and prettier clean on all touched files.

## Verification evidence
- Both loopback customer APIs are reached at the mapped URLs with a Bearer token; `outboundUrls` never contains a bare identifier.
- `forceNextExpiresIn(1)` plus a shared-clock step produces a second `/token` hit over the loopback AS (`tokenEndpointHits` 1 then 2).
- A provider revocation mid-run now runs real teardown (lease lands in `cleanup_incomplete` with `invalidate_license: failed` for a hybrid lease with no publisher client, `final_receipt: ok`) instead of stalling at `tearing_down`.
- `verifyOutcome()` after a satisfying write: `completed` -> `cleaned_up` with `revoke_oauth: revoked`, `invalidate_license: ok`, `cleanup_hook: attested_ok`, `delete_cached_data: ok`, `final_receipt: ok`; exactly one secretless verification receipt naming `actor=verifier`.
- `tools/list` exposes exactly the profile's three tools; guessed completion tool names are denied and the lease stays `active`.
- Every license the stub issued has `exp <= lease.expiresAt` (checked by decoding the PASETO payload), including a refresh at NOW+3500 of a 3600s lease. `refuse` and `decline` reissues leave the lease `active`, `expiresAt` unchanged, and the call succeeds. No issued token appears in anything either customer API received.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `RunLeaseOptions.deps` lacked `keys`**
- **Found during:** Task 1 typecheck
- **Issue:** Real teardown steps need the runtime signing key (`deps.keys.loadOrCreate`), but `deps` was `Pick<CliDeps, "storeFactory" | "receiptStoreFactory" | "clock" | "credentials">`.
- **Fix:** Added `"keys"` to the Pick. Every existing caller passes a full `CliDeps`, so nothing else changed.
- **Files modified:** packages/cli/src/run/run-lease.ts
- **Commit:** 03fd2e4

**2. [Rule 2 - Missing critical] verifier read restricted to a read binding**
- **Found during:** Task 2
- **Issue:** The plan says to use "the profile binding's rowAdapter"; the synthetic verifier read POSTs `{}` to the binding's resource, so selecting a write-access binding could trigger a real write.
- **Fix:** `verifyOutcome` selects only a binding with `access === "read"` and a `rowAdapter` for `job.verifier.resource`; otherwise it throws the fixed-text error pointing at `stint revoke`.
- **Files modified:** packages/cli/src/run/run-lease.ts
- **Commit:** 0154464

Additional (non-deviation) test-support additions: a new shared `hybrid-fixture.ts` and a `decline` behavior in `publisher-stub.ts` (the plan's null-reissue case needed it).

## Known Stubs
None.

## Threat Flags
None. The plan's threat register (T-07-LIC, T-07-COMPLETE, T-07-CLOCK, T-07-INSECURE, T-07-URLMAP) is mitigated and each is asserted by a test above; no new network surface beyond the publisher calls 07-03 already introduced.

## Notes for downstream plans
- `run.ts` (spawned `stint run`) now passes `licenseIssuer` from the persisted publisher binding; a JSON profile cannot carry a `rowAdapter`, so a spawned quickstart ends via `stint revoke --yes` and the in-process harness must supply a binding with a `rowAdapter` to exercise `verifyOutcome()` (as `hybrid-fixture.ts` does).
- One `teardown-license.test.ts` case (delegated lease, `code` was 1) failed once in a whole-package `--pool=threads` run and passed in every re-run (alone twice, whole package twice). It does not touch `runLease`; treated as load-related flake, not investigated further.
- Pre-existing working-tree noise: `packages/cli/src/deps.ts` shows as modified in `git status` with an empty diff; left untouched and uncommitted.

## Self-Check: PASSED
