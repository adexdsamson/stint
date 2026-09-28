---
phase: 04-mcp-proxy-credential-vault
plan: 05
subsystem: auth
tags: [oauth4webapi, oauth2-mock-server, credential-vault, single-flight, rfc8707, rfc7009, typescript]

# Dependency graph
requires:
  - phase: 04-mcp-proxy-credential-vault
    plan: 02
    provides: "@stint/proxy scaffold, dispatch.ts's ExecuteStage seam (04-06 target), @stint/proxy/testing subpath convention"
  - phase: 04-mcp-proxy-credential-vault
    plan: 04
    provides: "approvals/approval-dispatcher.ts precedent for a module-scoped, consume-on-read store and an injected-clock factory function"
provides:
  - "packages/proxy/src/vault/oauth-client.ts: SeededCredential, RefreshResult, OAuthClient, RefreshOptions, refreshAccessToken (oauth4webapi refresh-token grant + RFC 8707 resource indicator), classifyTokenError (D-09 narrow revocation signal)"
  - "packages/proxy/src/vault/credential-vault.ts: CredentialVault, createCredentialVault(oauthClient, clock, refreshOpts) -- secretless token custody, per-call expiry, per-credential single-flight refresh; CredentialRefreshError carrying provider_revoked/transient_error for 04-07"
  - "packages/proxy/src/testing.ts: startMockAuthServer -- loopback oauth2-mock-server (RS256), tokenEndpointHits counter, lastTokenRequestBody capture, forceNextTokenError one-shot override"
  - "packages/proxy/src/index.ts: barrel exports for the vault's public surface, PRXY-08-annotated"
affects: [04-06, 04-07]

# Actuals (#2632)
actuals:
  tokens: 6700
  tasks: 3
  commits: 3

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "createCredentialVault's token Map and single-flight tails Map are closed over inside the factory function (not a true module-level singleton like held-license.ts's WeakMap or approval-dispatcher.ts's pendingApprovals Map) -- each createCredentialVault() call gets its own isolated store, which still satisfies D-02's 'never exported' custody requirement while avoiding cross-instance/cross-test state leakage that a literal module-level Map would introduce for a leaseId:resource-keyed store"
    - "Single-flight refresh is proven by request COUNT (oauth2-mock-server's tokenEndpointHits, via Events.BeforeResponse), never by absence of an error -- the mock server has no native refresh-token reuse detection, so a broken (non-single-flight) implementation would pass a naive 'no throw' test while still double-redeeming"
    - "allowInsecureRequests is never hardcoded in oauth-client.ts -- it is threaded through an explicit, opt-in RefreshOptions.allowInsecureRequests flag; only the loopback mock-AS test harness ever sets it true, so a future production OAuthClient wiring gets oauth4webapi's HTTPS-only guard by default rather than needing to remember to remove a hardcoded bypass"

key-files:
  created:
    - packages/proxy/src/vault/oauth-client.ts
    - packages/proxy/src/vault/credential-vault.ts
    - packages/proxy/test/refresh-single-flight.test.ts
  modified:
    - packages/proxy/src/testing.ts
    - packages/proxy/src/index.ts

key-decisions:
  - "The credential Map + single-flight tails Map live in createCredentialVault's closure, not at module scope -- unlike approval-dispatcher.ts's deliberately-shared pendingApprovals Map, a shared module-level credential store would let unrelated test cases (or, in production, unrelated proxy instances) silently observe each other's leaseId:resource keys. Closure-private storage still satisfies 'module-private, never exported' (D-02) since nothing outside the module -- not even other createCredentialVault() instances -- can reach it."
  - "The single-flight guard is a strict per-id promise CHAIN (the exact @stint/core/testing runSerialized idiom, keyed leaseId:resource), not a shared dedup-promise map. Each queued call re-checks the record's expiry before doing network work, so only the first call in a chain ever finds the token still expired; every call behind it runs after that refresh landed and short-circuits on the now-fresh token with zero extra hits. This produces the same externally-observable guarantee (exactly one refresh per key under N-way concurrency, all callers converge on one token) with a smaller, precedent-matching implementation."
  - "SeededCredential.tokenEndpoint is carried through the D-04 seed-seam shape but NOT consumed by this plan's refreshAccessToken/OAuthClient wiring -- the injected OAuthClient bundles one discovered AuthorizationServer per vault instance, and every credential resolved through that vault instance refreshes against it. Multi-provider dispatch by a per-credential tokenEndpoint is out of scope this phase and flagged for whichever later phase wires multiple distinct authorization servers behind one vault."
  - "CredentialRefreshError.kind carries D-09's classification (provider_revoked | transient_error) as a typed, throw-not-swallow signal -- resolveAccessToken never returns a stale/placeholder token on a failed refresh; 04-07's revocation wiring is the intended catch site."

patterns-established:
  - "vault/oauth-client.ts + vault/credential-vault.ts: the refresh-classification split (oauth-client.ts owns the raw oauth4webapi call + D-09 signal classification; credential-vault.ts owns custody, expiry, and single-flight) is the shape future OAuth-integration work in this codebase (revocation execution, initial acquisition) should extend, not re-derive."

requirements-completed: [PRXY-08]

coverage:
  - id: D1
    description: "refreshAccessToken sends the RFC 8707 resource indicator on the token request and returns { kind: 'ok', accessToken, refreshToken, expiry } on a successful refresh against a real loopback oauth2-mock-server"
    requirement: PRXY-08
    verification:
      - kind: integration
        ref: "packages/proxy/test/refresh-single-flight.test.ts#oauth-client: refreshAccessToken (PRXY-08 foundation) > a successful refresh returns ok with a new access token, refresh token, and expiry"
        status: pass
      - kind: integration
        ref: "packages/proxy/test/refresh-single-flight.test.ts#oauth-client: refreshAccessToken (PRXY-08 foundation) > the refresh request carries the RFC 8707 resource indicator"
        status: pass
    human_judgment: false
  - id: D2
    description: "classifyTokenError/refreshAccessToken implement D-09's narrow revocation signal: a forced invalid_grant classifies as provider_revoked, any other token-endpoint error classifies as transient_error"
    requirement: PRXY-08
    verification:
      - kind: integration
        ref: "packages/proxy/test/refresh-single-flight.test.ts#oauth-client: refreshAccessToken (PRXY-08 foundation) > a forced invalid_grant classifies the refresh as provider_revoked"
        status: pass
      - kind: integration
        ref: "packages/proxy/test/refresh-single-flight.test.ts#oauth-client: refreshAccessToken (PRXY-08 foundation) > a forced non-invalid_grant token-endpoint error classifies the refresh as transient_error"
        status: pass
    human_judgment: false
  - id: D3
    description: "seedCredential + resolveAccessToken round-trip an unexpired token with zero token-endpoint hits; an expired token triggers exactly one refresh; the raw token store is unreachable from the returned CredentialVault"
    requirement: PRXY-08
    verification:
      - kind: integration
        ref: "packages/proxy/test/refresh-single-flight.test.ts#credential-vault: single-flight refresh (PRXY-08) > seedCredential + resolveAccessToken round-trip an unexpired token without any token-endpoint hit"
        status: pass
      - kind: integration
        ref: "packages/proxy/test/refresh-single-flight.test.ts#credential-vault: single-flight refresh (PRXY-08) > an expired token triggers exactly one refresh"
        status: pass
      - kind: unit
        ref: "packages/proxy/test/refresh-single-flight.test.ts#credential-vault: single-flight refresh (PRXY-08) > the raw token store is not reachable from any exported symbol"
        status: pass
    human_judgment: false
  - id: D4
    description: "N=20 concurrent resolveAccessToken calls for the SAME leaseId:resource collapse to exactly 1 token-endpoint hit with all N resolving to the one shared refreshed token -- the PRXY-08 single-flight crux, proven by a real request counter, not by absence of an error"
    requirement: PRXY-08
    verification:
      - kind: integration
        ref: "packages/proxy/test/refresh-single-flight.test.ts#credential-vault: single-flight refresh (PRXY-08) > N concurrent resolveAccessToken calls for the SAME leaseId:resource collapse to exactly one token-endpoint hit and one shared token"
        status: pass
    human_judgment: false
  - id: D5
    description: "N concurrent calls across TWO DIFFERENT leaseId:resource keys refresh independently, producing exactly 2 token-endpoint hits (the single-flight guard is per-credential, not global)"
    requirement: PRXY-08
    verification:
      - kind: integration
        ref: "packages/proxy/test/refresh-single-flight.test.ts#credential-vault: single-flight refresh (PRXY-08) > N concurrent calls across two DIFFERENT leaseId:resource keys produce exactly two hits (independent per credential)"
        status: pass
    human_judgment: false
  - id: D6
    description: "a forced invalid_grant during a vault-driven refresh rejects resolveAccessToken with CredentialRefreshError(kind: provider_revoked) -- never swallowed as a stale success -- and the vault's own refresh carries the RFC 8707 resource indicator"
    requirement: PRXY-08
    verification:
      - kind: integration
        ref: "packages/proxy/test/refresh-single-flight.test.ts#credential-vault: single-flight refresh (PRXY-08) > a forced invalid_grant during vault refresh rejects with CredentialRefreshError(provider_revoked)"
        status: pass
      - kind: integration
        ref: "packages/proxy/test/refresh-single-flight.test.ts#credential-vault: single-flight refresh (PRXY-08) > the vault's refresh carries the RFC 8707 resource indicator"
        status: pass
    human_judgment: false

# Metrics
duration: ~35min
completed: 2026-09-28
status: complete
---

# Phase 4 Plan 5: Credential Vault Refresh Hot Path Summary

**`oauth4webapi` refresh-token grant with RFC 8707 resource indicators, per-credential single-flight refresh proven by counting real token-endpoint hits against a loopback `oauth2-mock-server`, and a `provider_revoked`/`transient_error` classifier 04-07 consumes.**

## Performance

- **Duration:** ~35 min
- **Started:** 2026-09-28 (session start)
- **Completed:** 2026-09-28
- **Tasks:** 3
- **Files modified:** 5 (3 created, 2 modified)

## Accomplishments
- `vault/oauth-client.ts`'s `refreshAccessToken` performs a real `oauth4webapi` refresh-token grant carrying the RFC 8707 `resource` indicator (via `additionalParameters`, the library's documented mechanism), and `classifyTokenError` implements D-09's narrow revocation signal: only `oauth.ResponseBodyError` with `.error === "invalid_grant"` classifies as `provider_revoked`; every other failure (forced 5xx-style errors, network errors) classifies as `transient_error`.
- `testing.ts`'s `startMockAuthServer` spins a real loopback `oauth2-mock-server` (RS256 signing key — required, since the mock's refresh grant also issues an `id_token` validated against a hardcoded `RS256`-only discovery document), exposing a live `tokenEndpointHits` counter, `lastTokenRequestBody` capture, and a one-shot `forceNextTokenError` — all wired through a single `Events.BeforeResponse` hook, matching 04-RESEARCH.md's hands-on findings exactly (Pitfalls 2/5/6).
- `vault/credential-vault.ts`'s `createCredentialVault` is the D-02/D-04 secretless custody boundary: a closure-private token store (never exported, mirrors `held-license.ts`'s single-accessor discipline), per-call expiry against an injected clock (no cached "still valid" boolean, no internal timer), and a per-`leaseId:resource` single-flight guard reusing `@stint/core/testing`'s exact `runSerialized` promise-chain idiom.
- The PRXY-08 crux is proven by request COUNT, not by absence of an error: 20 concurrent `resolveAccessToken` calls for one credential produce exactly 1 token-endpoint hit and all 20 resolve to the same refreshed token; 20 concurrent calls split across 2 distinct credentials produce exactly 2 hits, proving the guard is per-credential, not global.
- A forced `invalid_grant` propagates end-to-end through the vault as a typed, throw-not-swallow `CredentialRefreshError(kind: "provider_revoked")` — the exact signal 04-07's revocation wiring is meant to catch.

## Task Commits

Each task was committed atomically:

1. **Task 1: Mock-AS test harness + oauth-client refresh/classification** - `950c488` (feat)
2. **Task 2: Credential vault — seed seam, per-call expiry, single-flight refresh** - `346dd53` (feat)
3. **Task 3: Single-flight proof by counting token-endpoint hits (PRXY-08)** - `fa60e68` (test)

**Plan metadata:** committed separately after this SUMMARY (see final metadata commit).

## Files Created/Modified
- `packages/proxy/src/vault/oauth-client.ts` - NEW: `SeededCredential`, `RefreshResult`, `OAuthClient`, `RefreshOptions`, `refreshAccessToken`, `classifyTokenError`
- `packages/proxy/src/vault/credential-vault.ts` - NEW: `CredentialVault`, `createCredentialVault`, `CredentialRefreshError`
- `packages/proxy/src/testing.ts` - added `startMockAuthServer`/`MockAuthHarness` (mock-AS harness, RS256 key, hit counter, forced-error hook)
- `packages/proxy/src/index.ts` - barrel exports for the vault's public surface, `PRXY-08`-annotated
- `packages/proxy/test/refresh-single-flight.test.ts` - NEW: 11 tests across two describe blocks (oauth-client-level classification/RFC-8707 coverage; credential-vault-level round-trip, single-flight concurrency proof, cross-key independence, revocation propagation)

## Decisions Made
- The credential store and single-flight `tails` map are closed over inside `createCredentialVault`'s factory function rather than declared at module scope (unlike `approval-dispatcher.ts`'s deliberately-shared `pendingApprovals` Map) — this still satisfies D-02's "module-private, never exported" custody requirement while preventing cross-instance/cross-test key collisions on a `leaseId:resource`-keyed store. Documented as a `tech-stack.patterns` entry above for the verifier.
- Single-flight is implemented as a strict per-key promise chain (the literal `@stint/core/testing` `runSerialized` idiom), not a shared dedup-promise. Every queued call re-checks expiry before touching the network, so only the first call in a chain ever refreshes; this produces the identical externally-observable guarantee (exactly one hit, all callers converge on one token) with a smaller implementation matching the plan's explicit reuse instruction.
- `allowInsecureRequests` is never hardcoded in `oauth-client.ts` — it's threaded through an explicit, opt-in `RefreshOptions.allowInsecureRequests` flag that only the mock-AS test harness sets `true`, so `oauth4webapi`'s HTTPS-only default guard stays intact for any future production `OAuthClient` wiring by default rather than requiring a bypass to be explicitly removed later.
- `SeededCredential.tokenEndpoint` is carried per D-04's seed-seam shape but not consumed by this plan's single-AS `OAuthClient` wiring (one discovered `AuthorizationServer` per vault instance). Flagged for whichever later phase wires multiple distinct authorization servers behind one vault.
- `CredentialRefreshError.kind` (`"provider_revoked" | "transient_error"`) is the typed signal `resolveAccessToken` throws on a failed refresh — never a swallowed/stale-token success — for 04-07's revocation wiring to catch.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `CredentialRefreshError.cause` needed an `override` modifier**
- **Found during:** Task 3 (`pnpm typecheck` after the concurrency test additions)
- **Issue:** `tsc -b` failed with TS4114 ("This member must have an 'override' modifier because it overrides a member in the base class 'Error'") — the workspace's target `lib` includes `Error.cause` as a base-class member, and `CredentialRefreshError`'s own `readonly cause?: unknown` field shadows it without the required modifier.
- **Fix:** Added `override` to `CredentialRefreshError.cause`'s declaration. Typecheck-only fix, no behavior change.
- **Files modified:** `packages/proxy/src/vault/credential-vault.ts`
- **Verification:** `pnpm typecheck` clean; scoped `eslint`, `pnpm build`, and the full `refresh-single-flight.test.ts` suite (11/11) all still pass.
- **Committed in:** `fa60e68` (folded into the Task 3 commit, since the fix was discovered while verifying Task 3 and no separate task boundary applied)

**2. [Rule 2 - Missing Critical] `Events.BeforeResponse` handler parameters required explicit typing**
- **Found during:** Task 1 (scoped `eslint` pass on `testing.ts`)
- **Issue:** `OAuth2Service extends EventEmitter`, and Node's `EventEmitter.on` overloads type callback parameters as implicit `any` for string event names — `@typescript-eslint/no-unsafe-member-access` flagged every `.body`/`.statusCode` access on the handler's `response`/`req` parameters.
- **Fix:** Explicitly typed the handler as `(response: MutableResponse, req: TokenRequestIncomingMessage) => void`, importing both types from `oauth2-mock-server`.
- **Files modified:** `packages/proxy/src/testing.ts`
- **Verification:** `eslint packages/proxy/src/testing.ts` clean; Task 1's scoped vitest run still green.
- **Committed in:** `950c488` (Task 1 commit)

---

**Total deviations:** 2 auto-fixed (1 blocking, 1 missing-critical/type-safety)
**Impact on plan:** Both fixes are typecheck/lint-only corrections required to keep the workspace's strict-mode gates green; neither changes runtime behavior or the plan's designed contracts. No scope creep.

## Issues Encountered
None beyond the two deviations above. All three tasks' `<verify>` commands passed on their respective implementation runs; the concurrency proof (`N=20` same-key, `N=10`×2 cross-key) was additionally re-run 3× standalone to rule out timing flakiness before committing Task 3 — stable at exactly 1 hit / exactly 2 hits every run. The full `@stint/proxy` suite (55 tests across 6 files) and a full workspace `tsc -b` both stayed green after the final fix.

## User Setup Required

None - no external service configuration required. `oauth2-mock-server` is devDependency-only, already installed (04-01), and self-contained (no external network).

## Next Phase Readiness
- `vault/oauth-client.ts` and `vault/credential-vault.ts` exist, are tested, and are exported from the barrel — PRXY-08 is fully satisfied (single-flight refresh proven by counted server hits, provider_revoked/transient_error classification in place).
- **Not wired this plan (by design — out of this plan's `files_modified` scope):** `dispatch.ts`'s `ExecuteStage` seam still throws "no OutboundConnector configured" (04-02's `DEFAULT_EXECUTE_STAGE`). Plan 04-06 is the vault-backed `ExecuteStage` implementation that calls `resolveAccessToken` and wires the `OutboundConnector` port (D-01) plus the credential scrubber (D-02).
- **Flagged for the verifier:** `SeededCredential.tokenEndpoint` is carried per D-04's shape but unused by this plan's single-`OAuthClient`-per-vault wiring; multi-provider dispatch is out of scope and not silently assumed.
- **Flagged for 04-07:** `CredentialRefreshError.kind` is the exact `provider_revoked`/`transient_error` signal D-09 specifies; 04-07's revocation wiring should catch this type rather than re-deriving classification from a raw `oauth4webapi` error.
- No blockers identified for 04-06 onward.

---
*Phase: 04-mcp-proxy-credential-vault*
*Completed: 2026-09-28*

## Self-Check: PASSED

All claimed created/modified files exist on disk and all claimed commit hashes (`950c488`, `346dd53`, `fa60e68`) are present in git history.
