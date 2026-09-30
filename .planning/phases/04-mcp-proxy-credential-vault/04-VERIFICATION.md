---
phase: 04-mcp-proxy-credential-vault
verified: 2026-09-28T20:20:00Z
status: passed
score: 5/5 must-haves verified
covered_files:
  - ".planning/REQUIREMENTS.md"
  - ".planning/phases/04-mcp-proxy-credential-vault/04-01-PLAN.md"
  - ".planning/phases/04-mcp-proxy-credential-vault/04-01-SUMMARY.md"
  - ".planning/phases/04-mcp-proxy-credential-vault/04-02-PLAN.md"
  - ".planning/phases/04-mcp-proxy-credential-vault/04-02-SUMMARY.md"
  - ".planning/phases/04-mcp-proxy-credential-vault/04-03-PLAN.md"
  - ".planning/phases/04-mcp-proxy-credential-vault/04-03-SUMMARY.md"
  - ".planning/phases/04-mcp-proxy-credential-vault/04-04-PLAN.md"
  - ".planning/phases/04-mcp-proxy-credential-vault/04-04-SUMMARY.md"
  - ".planning/phases/04-mcp-proxy-credential-vault/04-05-PLAN.md"
  - ".planning/phases/04-mcp-proxy-credential-vault/04-05-SUMMARY.md"
  - ".planning/phases/04-mcp-proxy-credential-vault/04-06-PLAN.md"
  - ".planning/phases/04-mcp-proxy-credential-vault/04-06-SUMMARY.md"
  - ".planning/phases/04-mcp-proxy-credential-vault/04-07-PLAN.md"
  - ".planning/phases/04-mcp-proxy-credential-vault/04-07-SUMMARY.md"
  - ".planning/phases/04-mcp-proxy-credential-vault/04-CONTEXT.md"
  - "packages/core/src/lease.ts"
  - "packages/core/src/policy.ts"
  - "packages/core/src/testing.ts"
  - "packages/proxy/package.json"
  - "packages/proxy/src/approvals/approval-dispatcher.ts"
  - "packages/proxy/src/caps/cap-enforcer.ts"
  - "packages/proxy/src/catalog.ts"
  - "packages/proxy/src/concurrency/lease-serializer.ts"
  - "packages/proxy/src/connectors/outbound-connector.ts"
  - "packages/proxy/src/dispatch.ts"
  - "packages/proxy/src/index.ts"
  - "packages/proxy/src/receipts/call-receipt.ts"
  - "packages/proxy/src/revocation.ts"
  - "packages/proxy/src/server.ts"
  - "packages/proxy/src/testing.ts"
  - "packages/proxy/src/vault/credential-vault.ts"
  - "packages/proxy/src/vault/execute-stage.ts"
  - "packages/proxy/src/vault/oauth-client.ts"
  - "packages/proxy/src/vault/scrub.ts"
covered_digest: "v1:sha256:4659dc52708c3ea021eb8ae0c05f0dca1535db778b531fd043f4e5cec6fd1b38"
behavior_unverified: 0
overrides_applied: 0
---

# Phase 4: MCP Proxy & Credential Vault Verification Report

**Phase Goal:** "An agent connected over MCP can only see and call what its lease permits, never holds a real credential, and leaves a receipt for every call it makes."

**Verified:** 2026-09-28T20:20:00Z
**Status:** passed
**Re-verification:** No — initial verification (a prior verifier attempt stalled before writing a report; no partial VERIFICATION.md existed to resume from)

## Method

Verified goal-backward by reading the actual source under `packages/proxy/src/**` and `packages/core/src/{policy,lease}.ts` against all 7 plan/summary pairs and `04-CONTEXT.md`'s locked decisions (D-01 through D-13), then cross-checked every must-have claim against the real test files (`packages/proxy/test/*.test.ts`, `packages/core/test/policy.test.ts`) rather than trusting SUMMARY.md's coverage tables. Ran exactly one narrowly-scoped command: `npx --yes pnpm@12.6.0 exec vitest run packages/proxy --pool=threads` → **9 test files, 76/76 tests passed**, matching 04-07-SUMMARY's claimed final count. No whole-repo command was run.

## Goal Achievement

### Observable Truths (Success Criteria)

| # | Truth (ROADMAP success criterion) | Status | Evidence |
|---|---|---|---|
| 1 | Agent sees only lease-permitted tools; every `tools/call` (allowed/denied) appends a receipt with args hash + binding-redacted summary; no raw args/secrets in any receipt | ✓ VERIFIED | `server.ts`'s `tools/list` handler filters `Object.keys(deps.catalog)` through `dispatch.ts`'s `resolveEffectiveBinding` (same function `handleCall` uses for authorization — cannot drift). `dispatch.ts`'s `finally` block calls `appendCallReceipt` unconditionally on every path (allow/deny/error/revoke). `receipts/call-receipt.ts`'s `buildCallPayload` constructs `CallPayload` ONLY from `binding.tool`/`binding.resource`/outcome/detail — never `resolvedArgs` — so a raw arg is a type-level impossibility, not a review discipline. `packages/proxy/test/server-tracer.test.ts` proves `tools/list` shows exactly the permitted tool and excludes out-of-scope-access/resource tools, and a direct call to a hidden tool still denies `no_binding`. `packages/proxy/test/call-receipts.test.ts` proves exactly-one-receipt-per-call, no merging of identical-arg calls, empty-args still hash to `hashCanonical({})`, gap-free `seq` under 20 concurrent calls with `verifyChain` passing, and a secret-looking arg leaks into neither payload nor `redactedSummary` for both allowed and denied outcomes. |
| 2 | Concurrent calls against one lease never exceed `actions_per_hour`/action cap/spend limit (per-lease serialization); concurrent refreshes of one credential collapse to exactly one refresh | ✓ VERIFIED | All counter mutation (`actionCount`, `actionTimestamps`, `spentMinor`) happens only inside `runInLeaseTransaction` → `LeaseStore.transaction`, the Phase-2 contract-tested per-id promise-chain primitive (already proven "50 concurrent transactions, no lost updates" in `packages/core/src/testing.ts`). `caps/cap-enforcer.ts`'s `createCapEnforcer` implements the sliding `(now-3600, now]` window (strict `>`, mirrors `checkErrorThreshold`). `packages/proxy/test/caps-concurrency.test.ts` proves the L-th/M-th/exact-S boundary for `actions_per_hour`/`max_actions`/`spend` individually, AND a K=12-concurrent-calls-vs-J=5-limit test yielding exactly 5 allowed / 7 denied with `actionTimestamps` length exactly 5 — read verbatim, not paraphrased from the SUMMARY. `vault/credential-vault.ts`'s `resolveAccessToken` uses a strict per-`leaseId:resource` promise-chain single-flight guard; `packages/proxy/test/refresh-single-flight.test.ts` proves N=20 concurrent same-key calls produce exactly 1 real token-endpoint hit (counted via `oauth2-mock-server`'s `Events.BeforeResponse`, not inferred from absence of error) and N-across-2-keys produce exactly 2 hits (per-credential, not global). |
| 3 | `send`/`pay`/`irreversible` calls held via HostAdapter out-of-band; approval bound to hash of exact args+binding+lease-version; drifted args deny; unanswered approval denies on timeout | ✓ VERIFIED | `approvals/approval-dispatcher.ts`'s `createApprovalDispatcher` is the ONLY caller of `@stint/core`'s `awaitApprovalDecision` (never MCP elicitation); arms a real `AbortController`/`setTimeout` from `timeout_seconds`. `computeApprovalHash` = `hashCanonical({args, tool, provenance, leaseVersion})` via `@stint/spec`'s single canonical serializer. `dispatch.ts`'s `handleCall` recomputes the hash from a FRESH `resolveEffectiveBinding` + FRESH `leaseStore.load` at execution time (never the pre-hold closures) and denies `approval_drifted` on any mismatch. `packages/proxy/test/approvals.test.ts` proves: hash changes on any of args/tool/provenance/leaseVersion drift; a never-resolving adapter denies `timeout` once the real timer fires, including the exact-deadline-vs-one-tick-past boundary; a throwing adapter denies (never allows); no raw arg ever reaches `ApprovalRequest`; end-to-end over the real MCP server — approve-executes (1 allowed receipt), all three D-11 drift vectors (arg/binding-hot-swap/lease-version-bump) independently deny `approval_drifted`, timeout denies (1 denied receipt), and `pay` is always held even when `approvals.require_for` omits it. |
| 4 | Adversarial tests show OAuth tokens (RFC 8707) injected only on outbound calls, never in agent-facing responses/errors; publisher license never forwarded to a customer resource | ✓ VERIFIED | `connectors/outbound-connector.ts`'s `createRestOutboundConnector` is the ONLY place a token is attached to a real request (bearer header); its `OutboundCredential` shape carries `{ accessToken }` only — no license field exists on the type. `vault/execute-stage.ts`'s `createVaultExecuteStage` wraps every port call in `vault/scrub.ts`'s `scrubCredential`/`scrubError` (exact-known-value stripping, never a generic regex, confirmed by reading `scrub.ts` directly) on BOTH the success and throw paths. `packages/proxy/test/vault-secretless.test.ts`'s "PRXY-06 adversarial" suite drives a real MCP `Client` against an echoing connector (leaks the token into its response body) and a throwing connector (leaks it into a thrown error) — the seeded token string appears in neither the `CallToolResult` nor the receipt chain for either adversarial port. `packages/proxy/test/license-secretless.test.ts` mints a real `HeldLicense` via `@stint/core/testing`, wires it into `createVaultExecuteStage`'s `licenseAccessor` (deliberately never read — confirmed in source, an eslint-disable documents the inert acceptance), and proves the port's `credential` argument is `{ accessToken }` only, and the reference REST connector's actual outbound request/headers carry the access token only, never the license value. |
| 5 | Provider-side OAuth revocation (`invalid_grant`/401) moves the lease to `revoked`, actor `provider` | ✓ VERIFIED | `vault/oauth-client.ts`'s `classifyTokenError` maps `oauth.ResponseBodyError` with `.error === "invalid_grant"` to `provider_revoked`; anything else to `transient_error` (D-09's narrow signal). `revocation.ts`'s `applyProviderRevocation` is a thin `reduce(lease, providerEvents.grantRevoked(), now)` wrapper — the sole provider-actor transition path. `dispatch.ts`'s catch block classifies a thrown `CredentialRefreshError` BEFORE the generic `execute_failed` fallback: `provider_revoked` applies the transition to the transaction-loaded lease and denies the triggering call (both land inside the same `LeaseStore.transaction`, D-13); `transient_error` denies only, lease returned unchanged. `packages/proxy/test/revocation-detection.test.ts`'s end-to-end suite forces `invalid_grant` via `oauth2-mock-server`'s `Events.BeforeResponse` hook on a REAL `oauth4webapi` refresh, driven through a REAL MCP `Client` `tools/call` — asserts the lease is `revoked`, and a SUBSEQUENT call on it is denied `lease_not_active`. A forced `server_error` (transient) leaves the lease `active`. Also verified directly in `packages/core/src/policy.ts`: the `lease_not_active` deny check (added this phase to close a pre-existing Phase-2 deny-by-default gap) sits at Step 2, immediately after `no_binding` and before expiry/caps/approval — correct enforcement order, confirmed by reading the source, not just the docstring claim. `packages/core/test/policy.test.ts` has zero non-`active`-state fixtures anywhere else, confirming the fix is additive with no regression to the other 201 core tests (SUMMARY's claim; consistent with what the test file itself shows — no other test constructs a non-active lease). |

**Score:** 5/5 success criteria verified (0 present-but-behavior-unverified)

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|---|---|---|---|---|
| PRXY-01 | 04-02 | Agent sees only lease-permitted tools | ✓ SATISFIED | `resolveEffectiveBinding` shared filter; `server-tracer.test.ts` |
| PRXY-04 | 04-01, 04-03 | `actions_per_hour`/action cap/spend enforced under concurrency | ✓ SATISFIED | `caps/cap-enforcer.ts`, `LeaseCounters.actionTimestamps`; `caps-concurrency.test.ts` (boundary + K-vs-J concurrency proof) |
| PRXY-05 | 04-04 | Approval held out-of-band, hash-bound, timeout denies | ✓ SATISFIED | `approvals/approval-dispatcher.ts`; `approvals.test.ts` |
| PRXY-06 | 04-06 | OAuth token injected outbound-only, never agent-facing | ✓ SATISFIED | `vault/execute-stage.ts` + `vault/scrub.ts`; `vault-secretless.test.ts` |
| PRXY-07 | 04-05, 04-07 | Provider revocation detected, lease → `revoked` | ✓ SATISFIED | `revocation.ts`, `policy.ts`'s `lease_not_active`; `revocation-detection.test.ts` |
| PRXY-08 | 04-05 | Token refresh serialized per credential | ✓ SATISFIED | `vault/credential-vault.ts`'s single-flight guard; `refresh-single-flight.test.ts` (counted-hit proof) |
| RCPT-01 | 04-02 | Every call receipts, secretless | ✓ SATISFIED | `receipts/call-receipt.ts`; `call-receipts.test.ts` |
| LIC-05 | 04-06 | License never forwarded to customer resource | ✓ SATISFIED | `vault/execute-stage.ts`'s inert `licenseAccessor`; `license-secretless.test.ts` |

**Orphaned requirements:** None — REQUIREMENTS.md's traceability table maps exactly these 8 IDs to Phase 4, and all 8 appear in at least one plan's `requirements:` frontmatter (04-01: PRXY-04; 04-02: PRXY-01, RCPT-01; 04-03: PRXY-04; 04-04: PRXY-05; 04-05: PRXY-08; 04-06: PRXY-06, LIC-05; 04-07: PRXY-07).

### Flagged Items — Verified Against Source

Per the task instructions, both flagged items were checked directly against real source rather than accepted from the summaries:

1. **PRXY-04 deferred from 04-01 to 04-03**: `packages/proxy/src/caps/cap-enforcer.ts`'s `createCapEnforcer()` genuinely implements the sliding-window `actions_per_hour` gate (`countWithinWindow`/`pruneWindow`, strict `(now-3600, now]`), and `packages/proxy/test/caps-concurrency.test.ts`'s "PRXY-04 concurrency" describe block proves K=12 concurrent calls against one lease with `actions_per_hour=5` yield exactly 5 allowed/7 denied — read directly, this is a real end-to-end proof over the real 04-02 MCP server, not a unit-level approximation. **Meets PRXY-04's concurrent-enforcement acceptance.**

2. **04-07's `lease_not_active` deny check in `evaluatePolicy`**: Read `packages/core/src/policy.ts` directly — the check is `Step 2`, positioned immediately after `Step 1` (`no_binding`) and before `Step 3` (`expired`)/caps/approval, exactly matching the docstring's stated order and spec/ALP.md's deny-by-default discipline (a lease that isn't `active` can never reach expiry/caps/approval checks). `packages/core/test/policy.test.ts` has two new tests (revoked lease, granted-not-yet-active lease) and zero non-`active`-state fixtures anywhere else in the file — consistent with the SUMMARY's zero-regression claim. **Placed correctly; regression-free per the test file's own fixture set.**

### Anti-Patterns Found

Scanned all `packages/proxy/src/**` files plus `packages/core/src/policy.ts` and `packages/core/src/lease.ts` for `TODO|FIXME|XXX|HACK|PLACEHOLDER|not yet implemented|coming soon`, empty-return stubs, and hardcoded-empty-data patterns.

One match: `packages/proxy/src/testing.ts:48` — `export const PROXY_TESTING_PLACEHOLDER = "@stint/proxy/testing";`. This is a test-only sentinel constant (not exported from the production `./index.ts` barrel) that proves the `./testing` subpath builds; it carries no runtime behavior and is documented in the file's own header as exactly that. Not a functional stub — no severity assigned.

No other debt markers, empty implementations, or hardcoded-empty-data patterns found in any enforcement-path file.

### Behavioral Spot-Checks / Test Execution

| Check | Command | Result | Status |
|---|---|---|---|
| Full `@stint/proxy` suite | `npx --yes pnpm@12.6.0 exec vitest run packages/proxy --pool=threads` | 9 test files, 76/76 tests passed | ✓ PASS |
| `lease_not_active` placement + order | Direct source read, `packages/core/src/policy.ts` | Step 2, after `no_binding`, before `expired`/caps/approval | ✓ PASS |
| PRXY-04 concurrency boundary | Direct test-source read, `caps-concurrency.test.ts` | K=12/J=5 → 5 allowed, 7 denied, `actionTimestamps.length === 5` | ✓ PASS |

No whole-repo command was run, per the task's explicit constraint. `packages/spec/test/codegen.test.ts` was not touched.

### Human Verification Required

None. Every success criterion was verifiable against source + existing automated tests without needing a live server, UI, or external service interaction.

### Gaps Summary

None. All 5 phase success criteria and all 8 mapped requirement IDs (PRXY-01, PRXY-04, PRXY-05, PRXY-06, PRXY-07, PRXY-08, RCPT-01, LIC-05) are genuinely implemented and tested — verified by reading the actual `packages/proxy/src/**` and `packages/core/src/policy.ts` source, not by trusting the 7 SUMMARY.md files' coverage tables. Both flagged items (PRXY-04's deferred concurrency proof, and 04-07's `lease_not_active` cross-package fix) were independently confirmed correct against source. The single running of the proxy test suite (76/76 green) matches the cumulative count claimed across all 7 summaries.

---

*Verified: 2026-09-28T20:20:00Z*
*Verifier: Claude (gsd-verifier)*
