---
phase: 04-mcp-proxy-credential-vault
plan: 06
subsystem: auth
tags: [oauth, credential-vault, mcp-proxy, secretless, typescript]

# Dependency graph
requires:
  - phase: 04-mcp-proxy-credential-vault
    plan: 02
    provides: "dispatch.ts's ExecuteStage seam, CallContext, DEFAULT_EXECUTE_STAGE, @stint/proxy/testing subpath convention"
  - phase: 04-mcp-proxy-credential-vault
    plan: 05
    provides: "vault/credential-vault.ts's CredentialVault.resolveAccessToken (the single token read path), SeededCredential, CredentialRefreshError"
provides:
  - "packages/proxy/src/connectors/outbound-connector.ts: OutboundConnector port (D-01), createRestOutboundConnector reference REST impl attaching the bearer token"
  - "packages/proxy/src/vault/scrub.ts: scrubCredential/scrubError -- narrow, exact-value-only credential scrubber (D-02)"
  - "packages/proxy/src/vault/execute-stage.ts: createVaultExecuteStage(vault, connector, licenseAccessor?) -- the real, vault-backed ExecuteStage implementing 04-02's seam"
  - "packages/proxy/src/testing.ts: createEchoingCredentialConnector/createThrowingCredentialConnector -- adversarial OutboundConnector test doubles"
  - "packages/proxy/src/dispatch.ts: ExecuteStage.execute widened to accept an explicit now parameter (Rule 3)"
affects: [04-07]

# Actuals (#2632)
actuals:
  tokens: 9959
  tasks: 3
  commits: 3

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "vault/execute-stage.ts wraps every OutboundConnector.execute(...) call in try/catch, applying scrubCredential to the success-path return value and scrubError to any thrown error before either can propagate toward dispatch.ts's agent-facing boundary -- the token read from the vault (vault.resolveAccessToken) is the sole knownSecrets value each call scrubs against"
    - "scrub.ts's scrubUnknown walks strings/arrays/plain-objects recursively via an internal unknown-typed helper, with explicit `as unknown[]` / `as Record<string, unknown>` casts after Array.isArray/typeof-object narrowing to avoid TypeScript's any-widening on Array.isArray and Object.entries -- keeps the whole module free of unsafe-* lint violations under strictTypeChecked"

key-files:
  created:
    - packages/proxy/src/connectors/outbound-connector.ts
    - packages/proxy/src/vault/scrub.ts
    - packages/proxy/src/vault/execute-stage.ts
    - packages/proxy/test/vault-secretless.test.ts
    - packages/proxy/test/license-secretless.test.ts
  modified:
    - packages/proxy/src/dispatch.ts
    - packages/proxy/src/testing.ts
    - packages/proxy/src/index.ts

key-decisions:
  - "Widened the 04-02 ExecuteStage seam (execute gains an explicit `now: number` second parameter) as a Rule 3 blocking fix -- the vault-backed implementation must resolve tokens against the injected clock (matching the credential vault's own per-call-expiry, no-Date.now() discipline from 04-05), and dispatch.ts's handleCall already computes `now` at the top, so threading it through the seam is a one-line, additive change. Mirrors 04-03's CapEnforcer and 04-04's ApprovalStage widening precedent. Existing implementations (DEFAULT_EXECUTE_STAGE, testing.ts's createEchoExecuteStage) needed no changes -- a function with fewer declared parameters still satisfies an interface method requiring more (standard JS calling-convention compatibility)."
  - "createVaultExecuteStage accepts an optional licenseAccessor (a HeldLicense carrier) but never reads it -- it exists purely so a hosted/hybrid deployment's construction context can prove, by the license-secretless.test.ts adversarial test, that a license present in context still never reaches OutboundConnector.execute's credential argument (LIC-05, D-15). The eslint-disable-next-line on the unused parameter documents this deliberately-inert acceptance rather than silently dropping the parameter."
  - "scrubError creates a NEW Error object (message/stack/every other own property scrubbed) rather than mutating the thrown error in place -- the original error (and any secret substring it carries) is never returned or exposed past the function, even transiently."
  - "The vault-backed ExecuteStage's own scrub is defense-in-depth on the throw path: dispatch.ts's existing catch block (04-02) already replaces ANY execute() error with a generic 'call failed' CallToolResult, never echoing the underlying message toward the agent -- so the throwing-connector adversarial test would pass even without scrubError. scrubError is still implemented per the plan's explicit D-02 requirement, and matters for any future code path (e.g. logging, receipt enrichment) that might inspect the thrown error directly."
  - "The reference OutboundConnector's OAuthClient/CredentialVault wiring in both secretless test files uses a type-satisfying stub OAuthClient (issuer/client_id only, oauth.None() clientAuth) rather than a real oauth2-mock-server harness, since every seeded credential's expiry is set far in the future -- resolveAccessToken never triggers a refresh, so the stub's fields are never read. Keeps the adversarial proofs focused on the scrub boundary, not OAuth wiring already proven in 04-05."

patterns-established:
  - "connectors/outbound-connector.ts + vault/scrub.ts + vault/execute-stage.ts is the injection-without-exposure triad: the port is the ONLY place a token is attached to a real request, the scrubber is the ONLY place a return value/error is sanitized, and the ExecuteStage is the ONLY place both are composed around the vault's single resolveAccessToken read. Any future connector or vault-adjacent code should compose through this triad, not re-derive scrubbing or credential injection independently."

requirements-completed: [PRXY-06, LIC-05]

coverage:
  - id: D1
    description: "OutboundConnector port matches the D-01 signature (execute(binding, resolvedArgs, credential) -> {status, body}); createRestOutboundConnector attaches credential.accessToken as a bearer Authorization header on the outbound request -- the only place a token is placed on a real request"
    requirement: PRXY-06
    verification:
      - kind: unit
        ref: "packages/proxy/test/vault-secretless.test.ts#createRestOutboundConnector > attaches the credential as a bearer Authorization header on the outbound request"
        status: pass
    human_judgment: false
  - id: D2
    description: "scrubCredential/scrubError strip only the exact known secret string(s) from a returned value (including nested objects/arrays) and a thrown error's message/echoed fields, never a generic secret-shaped regex -- a lookalike-but-unknown secret string survives untouched"
    requirement: PRXY-06
    verification:
      - kind: unit
        ref: "packages/proxy/test/vault-secretless.test.ts#scrubCredential (4 tests: string, nested object/array, untouched-when-no-match, exact-match-only)"
        status: pass
      - kind: unit
        ref: "packages/proxy/test/vault-secretless.test.ts#scrubError (3 tests: message, echoed field, never mutates original)"
        status: pass
    human_judgment: false
  - id: D3
    description: "The vault-backed ExecuteStage resolves the access token via CredentialVault.resolveAccessToken (the sole read path), calls the injected OutboundConnector with { accessToken } only, and scrubs both the success-path result and any thrown error before returning toward dispatch.ts's agent-facing boundary"
    requirement: PRXY-06
    verification:
      - kind: integration
        ref: "packages/proxy/test/vault-secretless.test.ts#PRXY-06 adversarial > an echoing connector's leaked token is scrubbed from the CallToolResult and the receipt chain"
        status: pass
      - kind: integration
        ref: "packages/proxy/test/vault-secretless.test.ts#PRXY-06 adversarial > a throwing connector's leaked token never reaches the client-surfaced error or the receipt chain"
        status: pass
    human_judgment: false
  - id: D4
    description: "The publisher license is never forwarded to a customer resource -- OutboundConnector.execute's credential argument carries { accessToken } only, even when the ExecuteStage is constructed with a real HeldLicense present in its context; the license token value appears in no port argument nor in the reference REST connector's actual outbound request/headers"
    requirement: LIC-05
    verification:
      - kind: integration
        ref: "packages/proxy/test/license-secretless.test.ts#LIC-05 > credential arg carries { accessToken } only -- the license value appears in no port argument"
        status: pass
      - kind: integration
        ref: "packages/proxy/test/license-secretless.test.ts#LIC-05 > the reference REST connector's outbound request carries the access token only -- never the license"
        status: pass
    human_judgment: false
  - id: D5
    description: "The 04-02 tracer (real MCP Client over InMemoryTransport, tools/list + tools/call + receipt guarantees) stays green with dispatch.ts's widened ExecuteStage seam"
    requirement: PRXY-06
    verification:
      - kind: integration
        ref: "packages/proxy/test/server-tracer.test.ts (all tests, run alongside this plan's changes)"
        status: pass
    human_judgment: false

# Metrics
duration: ~25min
completed: 2026-09-28
status: complete
---

# Phase 4 Plan 6: Injection-Without-Exposure -- Vault-Backed ExecuteStage & Credential Scrubber Summary

**`OutboundConnector` port + reference REST impl, a narrow exact-value credential scrubber, and `createVaultExecuteStage` composing them into 04-02's `ExecuteStage` seam -- proven adversarially against an echoing/throwing connector (PRXY-06) and a real minted `HeldLicense` in context (LIC-05).**

## Performance

- **Duration:** ~25 min
- **Started:** 2026-09-28 (session start)
- **Completed:** 2026-09-28
- **Tasks:** 3
- **Files modified:** 8 (5 created, 3 modified)

## Accomplishments
- `connectors/outbound-connector.ts`'s `OutboundConnector` port matches D-01 exactly (`execute(binding, resolvedArgs, credential) -> {status, body}`); `createRestOutboundConnector` is the Phase 4 reference REST implementation and the ONLY place a token is attached to a real outbound request (a bearer `Authorization` header) -- no enforcement-path code imports it directly, it is always constructor-injected.
- `vault/scrub.ts`'s `scrubCredential`/`scrubError` strip only the exact known secret string(s) supplied, walking strings/arrays/objects recursively, never a generic secret-shaped regex -- a lookalike-but-unregistered secret string survives untouched, proven by a dedicated unit test.
- `vault/execute-stage.ts`'s `createVaultExecuteStage` is the real, vault-backed `ExecuteStage`: resolves the token via the 04-05 vault's sole `resolveAccessToken` read path, calls the injected port with `{ accessToken }` only, and wraps the whole call in the scrubber so a returned value or thrown error can never carry the raw token past this boundary. A `licenseAccessor` construction parameter is accepted and deliberately never read, so a license present in context still cannot reach the port (LIC-05).
- Two adversarial `OutboundConnector` test doubles (`createEchoingCredentialConnector`, `createThrowingCredentialConnector`) drive real MCP `Client` `tools/call` requests through the vault-backed stage over `InMemoryTransport`; the seeded access-token value appears in NEITHER the `CallToolResult` the client receives NOR any client-surfaced error NOR the receipt chain, for both adversarial ports.
- `license-secretless.test.ts` mints a real `HeldLicense` via `@stint/core/testing`'s `createMockLicenseIssuer`, wires it into the vault-backed stage's construction context, and proves (via a spy connector AND the reference REST connector) that the port's `credential` argument is `{ accessToken }` only and the license token value never appears in any port argument or actual outbound request/header.
- `dispatch.ts`'s `ExecuteStage.execute` was widened to accept an explicit `now` parameter (Rule 3) so the vault-backed stage resolves tokens against the injected clock, never `Date.now()` -- the full proxy test suite (67 tests, 8 files) including the 04-02 tracer stayed green throughout.

## Task Commits

Each task was committed atomically:

1. **Task 1: OutboundConnector port + reference REST impl + credential scrubber** - `4c91eee` (feat)
2. **Task 2: Vault-backed ExecuteStage -- inject token, scrub boundary, never forward license** - `265241c` (feat)
3. **Task 3: Adversarial secretless proofs (PRXY-06 token, LIC-05 license)** - `a0737e6` (test)

**Plan metadata:** committed separately after this SUMMARY (see final metadata commit).

## Files Created/Modified
- `packages/proxy/src/connectors/outbound-connector.ts` - NEW: `OutboundConnector`, `OutboundCredential`, `FetchLike`, `createRestOutboundConnector`
- `packages/proxy/src/vault/scrub.ts` - NEW: `scrubCredential`, `scrubError`
- `packages/proxy/src/vault/execute-stage.ts` - NEW: `LicenseAccessor`, `createVaultExecuteStage`
- `packages/proxy/src/dispatch.ts` - `ExecuteStage.execute` widened to accept `now`; call site and docstrings updated
- `packages/proxy/src/testing.ts` - added `createEchoingCredentialConnector`, `createThrowingCredentialConnector`
- `packages/proxy/src/index.ts` - barrel exports for the new port, scrubber, and vault-backed ExecuteStage
- `packages/proxy/test/vault-secretless.test.ts` - NEW (Task 1) + extended (Task 3): scrub/OutboundConnector unit tests, PRXY-06 adversarial end-to-end proofs
- `packages/proxy/test/license-secretless.test.ts` - NEW: LIC-05 adversarial proofs

## Decisions Made
- Widened `ExecuteStage.execute` to `(ctx, now)` as a Rule 3 blocking fix (mirrors 04-03/04-04's seam-widening precedent) -- the vault's per-call-expiry discipline (no `Date.now()`, no internal timer) required threading the injected clock through the seam; existing zero/one-arg implementations stayed valid unmodified.
- `createVaultExecuteStage`'s `licenseAccessor` parameter is accepted-but-inert by design, existing solely to let `license-secretless.test.ts` prove a license present in context still never reaches the port.
- `scrubError` always constructs a new `Error` rather than mutating the original in place, so the raw thrown error (and any secret it carries) is never exposed past the scrub boundary even transiently.
- Both secretless test files seed the vault with a far-future-expiry credential and a type-satisfying stub `OAuthClient`, avoiding a real mock-AS harness since no refresh is exercised -- keeps the adversarial proofs scoped to the scrub boundary (already-proven OAuth wiring lives in 04-05's tests).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Widened `ExecuteStage.execute` to accept an explicit `now` parameter**
- **Found during:** Task 2 (implementing `createVaultExecuteStage`)
- **Issue:** The 04-02 `ExecuteStage` seam's `execute(ctx)` had no way to receive the current time. The vault-backed implementation must call `vault.resolveAccessToken(leaseId, resource, now)` against the SAME injected clock discipline the credential vault itself enforces (D-04: per-call expiry, no cached "still valid" boolean, no internal timer) -- using `Date.now()` directly inside the stage would silently violate that locked-upstream discipline.
- **Fix:** Widened `ExecuteStage.execute(ctx: CallContext, now: number)`; `dispatch.ts`'s `handleCall` (which already computes `now` at the top) now passes it through at the one call site. `DEFAULT_EXECUTE_STAGE` and `testing.ts`'s `createEchoExecuteStage` needed no changes since a function with fewer declared parameters still satisfies an interface requiring more.
- **Files modified:** `packages/proxy/src/dispatch.ts`
- **Verification:** `pnpm typecheck` clean; scoped `eslint` clean; full proxy test suite (67/67) including `server-tracer.test.ts` stayed green.
- **Committed in:** `265241c` (Task 2 commit)

**2. [Rule 3 - Blocking] `@typescript-eslint/no-base-to-string` on a `BodyInit` value**
- **Found during:** Task 3 (`license-secretless.test.ts`'s REST-connector assertion)
- **Issue:** `String(capturedInit.body)` triggered `@typescript-eslint/no-base-to-string` since `RequestInit['body']` is typed `BodyInit | null | undefined`, a union including types without a meaningful `toString()`.
- **Fix:** Replaced with a `typeof capturedInit?.body === "string"` narrowing check instead of an unconditional `String()` call -- the reference REST connector always sends a `JSON.stringify`-produced string body, so the narrowed branch is exercised in practice.
- **Files modified:** `packages/proxy/test/license-secretless.test.ts`
- **Verification:** scoped `eslint` clean; test still asserts the intended substring-absence.
- **Committed in:** `a0737e6` (Task 3 commit, fixed before commit)

---

**Total deviations:** 2 auto-fixed (both Rule 3 - blocking, typecheck/lint-only or an additive interface-seam widening required for correctness)
**Impact on plan:** Both fixes were necessary to keep the vault-backed stage honoring the project's injected-clock discipline and the workspace's strict-mode lint gate green. No scope creep -- neither changes the plan's designed contracts.

## Issues Encountered
None beyond the two deviations above. All three tasks' `<verify>` commands passed on their respective implementation runs. The full `@stint/proxy` suite (67 tests across 8 files, including the 04-02 tracer and all prior plans' suites) stayed green after every task, and a full workspace `tsc -b` + `pnpm build` succeeded throughout.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- `connectors/outbound-connector.ts`, `vault/scrub.ts`, and `vault/execute-stage.ts` exist, are tested, and are exported from the barrel -- PRXY-06 and LIC-05 are fully satisfied (adversarial echo/throw proofs for the token, adversarial spy + real-REST-connector proofs for the license).
- `dispatch.ts`'s `ExecuteStage` seam is no longer a stub -- `createVaultExecuteStage(vault, connector, licenseAccessor?)` is the production-real implementation a deployment wires into `ProxyDeps.execute`.
- **Flagged for 04-07:** `vault/execute-stage.ts` deliberately lets a `CredentialRefreshError` (`provider_revoked`/`transient_error`, D-09) from `vault.resolveAccessToken` propagate UNCHANGED past this stage (it sits outside the try/catch that wraps the port call) -- 04-07's revocation wiring is the intended catch site; this plan does not catch or classify it.
- **Flagged for the verifier:** RESEARCH.md's Assumption A1 (the REST-shaped reference `OutboundConnector` impl assumes Phase 7's example connectors are REST mocks, not real downstream MCP servers) remains unresolved by this plan -- the port abstraction absorbs either outcome without a signature change.
- No blockers identified for 04-07 onward.

---
*Phase: 04-mcp-proxy-credential-vault*
*Completed: 2026-09-28*

## Self-Check: PASSED

All claimed created/modified files exist on disk and all claimed commit hashes (`4c91eee`, `265241c`, `a0737e6`) are present in git history.
