---
phase: 04-mcp-proxy-credential-vault
plan: 02
subsystem: proxy
tags: [mcp-sdk, mcp-server, tools-call, tools-list, receipts, policy-enforcement, typescript]

# Dependency graph
requires:
  - phase: 04-mcp-proxy-credential-vault
    plan: 01
    provides: "@stint/proxy scaffold with pinned @modelcontextprotocol/sdk@1.30.1; LeaseCounters.actionTimestamps"
  - phase: 02-lease-state-machine-policy-engine
    provides: "evaluatePolicy, ConnectorBinding/BindingSet, LeaseStore.transaction, HostAdapter approval types"
  - phase: 03-receipts-licensing
    provides: "appendEntry/verifyChain, ReceiptStore + in-memory double, CallPayload (secretless-by-type)"
provides:
  - "packages/proxy/src/catalog.ts: runtime-owned ToolCatalog (createToolCatalog/resolveCatalogEntry), Object.hasOwn-guarded like @stint/core's BindingSet"
  - "packages/proxy/src/server.ts: createLeaseProxyServer(deps) building a low-level MCP Server, one per lease, with a static filtered tools/list and single tools/call dispatch"
  - "packages/proxy/src/dispatch.ts: handleCall — the single tools/call dispatch point; resolveEffectiveBinding (the one place unbound-or-out-of-scope collapses to no_binding); ExecuteStage/ApprovalStage/CapEnforcer seams + DEFAULT_* production-safe implementations"
  - "packages/proxy/src/concurrency/lease-serializer.ts: runInLeaseTransaction, a thin wrapper over LeaseStore.transaction"
  - "packages/proxy/src/receipts/call-receipt.ts: buildCallPayload/appendCallReceipt — the secretless per-call receipt builder"
  - "packages/proxy/src/testing.ts: createEchoExecuteStage, an in-memory ExecuteStage double"
  - "packages/proxy/src/index.ts: finalized public barrel (createLeaseProxyServer, ProxyDeps, seam types, catalog builders, call-receipt helpers)"
affects: [04-03, 04-04, 04-05, 04-06, 04-07]

# Actuals (#2632)
actuals:
  tokens: 11300
  tasks: 3
  commits: 4

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "resolveEffectiveBinding (dispatch.ts) is the ONE place tools/list visibility and tools/call authorization both resolve a binding through — collapses to undefined (deny no_binding) whenever a tool is unbound OR its binding is out of the lease's granted scope/resource, so the two surfaces can never drift apart"
    - "The whole authorize -> execute -> receipt flow for one tools/call runs inside a single LeaseStore.transaction mutator closure, with the receipt append in a finally block so it runs exactly once even when execute throws"
    - "Three injected seams (ExecuteStage/ApprovalStage/CapEnforcer) with named DEFAULT_* production-safe implementations (execute throws, approve denies, enforceCaps authorizes+commits actionCount/actionTimestamps) let plans 04-03/04-04/04-05 fill in real behavior without touching dispatch.ts"

key-files:
  created:
    - packages/proxy/src/catalog.ts
    - packages/proxy/src/dispatch.ts
    - packages/proxy/src/server.ts
    - packages/proxy/src/concurrency/lease-serializer.ts
    - packages/proxy/src/receipts/call-receipt.ts
    - packages/proxy/test/server-tracer.test.ts
    - packages/proxy/test/call-receipts.test.ts
  modified:
    - packages/proxy/src/testing.ts
    - packages/proxy/src/index.ts

key-decisions:
  - "resolveEffectiveBinding collapses BOTH a truly-unbound tool AND a bound-but-out-of-scope/out-of-resource tool to `undefined` before calling evaluatePolicy, so both cases deny with the SAME reason (no_binding) and appear identically in the receipt — this resolves the plan's flagged 'unclassified' PRXY-01 edge exactly as the plan's must_haves asserted."
  - "An errored execute() is receipted as outcome: denied (CallPayload's outcome is a two-value enum) with a fixed, generic redactedSummary ('execute_failed') that never echoes the underlying error's message, since a connector error could carry request/arg material."
  - "The low-level MCP Server (not McpServer) is used deliberately per RESEARCH.md Pattern 1; its @typescript-eslint/no-deprecated warning is suppressed with two narrow, justified eslint-disable-next-line comments rather than a package-wide rule exemption."
  - "ApprovalStage's require_approval branch was implemented in this tracer plan (not deferred) since ProxyDeps already declares the seam; DEFAULT_APPROVAL_STAGE denies by default, matching the deny-on-timeout discipline plan 04-04 will wire for real."

patterns-established:
  - "Every mutating call-handling path in @stint/proxy goes through runInLeaseTransaction (concurrency/lease-serializer.ts) instead of calling leaseStore.transaction directly — a single, greppable entry point, though the actual serialization is entirely LeaseStore's (no second mutex, per RESEARCH.md's Don't Hand-Roll)."
  - "CallPayload is built ONLY from binding.tool/binding.resource and outcome/detail reason codes — never from raw resolvedArgs or an underlying error's message — so a secret-looking arg value cannot reach a receipt by construction, not by review discipline."

requirements-completed: [PRXY-01, RCPT-01]

coverage:
  - id: D1
    description: "tools/list is computed once at construction from the injected catalog x BindingSet, filtered by this lease's granted scopes/resources — the one permitted read tool is the only tool listed"
    requirement: PRXY-01
    verification:
      - kind: unit
        ref: "packages/proxy/test/server-tracer.test.ts#tools/list shows exactly the one permitted tool"
        status: pass
    human_judgment: false
  - id: D2
    description: "tools/list excludes a cataloged-but-out-of-scope-access tool and a cataloged-but-out-of-scope-resource tool"
    requirement: PRXY-01
    verification:
      - kind: unit
        ref: "packages/proxy/test/server-tracer.test.ts#tools/list excludes an out-of-scope-access tool and an out-of-scope-resource tool"
        status: pass
    human_judgment: false
  - id: D3
    description: "a tools/call on the permitted read tool flows resolveBinding -> evaluatePolicy (allow) -> ExecuteStage -> and returns the connector result"
    requirement: PRXY-01
    verification:
      - kind: unit
        ref: "packages/proxy/test/server-tracer.test.ts#tools/call on the permitted tool returns the echo body and appends exactly one allowed receipt"
        status: pass
    human_judgment: false
  - id: D4
    description: "a direct tools/call naming a completely unbound tool, and one naming an out-of-scope-but-cataloged tool, are both denied no_binding even though hidden from tools/list — an agent naming a hidden tool directly still cannot invoke it"
    requirement: PRXY-01
    verification:
      - kind: unit
        ref: "packages/proxy/test/server-tracer.test.ts#a tools/call naming a completely unbound tool is denied no_binding and appends one denied receipt"
        status: pass
      - kind: unit
        ref: "packages/proxy/test/server-tracer.test.ts#a tools/call naming an out-of-scope-but-cataloged tool directly is still denied no_binding"
        status: pass
    human_judgment: false
  - id: D5
    description: "every tools/call (allowed or denied) appends exactly one verified-chain receipt, built from the secretless CallPayload, inside the per-lease transaction"
    requirement: RCPT-01
    verification:
      - kind: unit
        ref: "packages/proxy/test/call-receipts.test.ts#an allowed call appends exactly one receipt (chain length delta == 1)"
        status: pass
      - kind: unit
        ref: "packages/proxy/test/call-receipts.test.ts#a denied call appends exactly one receipt (chain length delta == 1)"
        status: pass
    human_judgment: false
  - id: D6
    description: "two calls with identical args produce two distinct receipts (equal argsHash, distinct seq — never merged); a denied call with no arguments field still receipts against hashCanonical({})"
    requirement: RCPT-01
    verification:
      - kind: unit
        ref: "packages/proxy/test/call-receipts.test.ts#two calls with identical args produce two receipts, equal argsHash, distinct seq"
        status: pass
      - kind: unit
        ref: "packages/proxy/test/call-receipts.test.ts#a denied call with no `arguments` field appends one receipt whose argsHash equals hashCanonical({})"
        status: pass
    human_judgment: false
  - id: D7
    description: "N concurrent tools/call requests against one lease leave a gap-free seq 0..N-1 verified chain that verifyChain reports ok over"
    requirement: RCPT-01
    verification:
      - kind: unit
        ref: "packages/proxy/test/call-receipts.test.ts#N concurrent tools/calls produce seq 0..N-1 with no gaps, and verifyChain reports ok"
        status: pass
    human_judgment: false
  - id: D8
    description: "a secret-looking arg value never appears in a stored receipt payload or redactedSummary, for both an allowed and a denied call, checked both by type (CallPayload's exact key set) and by value"
    requirement: RCPT-01
    verification:
      - kind: unit
        ref: "packages/proxy/test/call-receipts.test.ts#an allowed call carrying a secret-looking arg leaks it into neither the payload nor redactedSummary"
        status: pass
      - kind: unit
        ref: "packages/proxy/test/call-receipts.test.ts#a denied call carrying a secret-looking arg leaks it into neither the payload nor redactedSummary"
        status: pass
    human_judgment: false

# Metrics
duration: ~25min
completed: 2026-09-28
status: complete
---

# Phase 4 Plan 2: Tracer — MCP Proxy Dispatch, Runtime-Owned Catalog & Per-Call Receipts Summary

**A low-level MCP `Server` per lease with a policy-filtered `tools/list`, a single `tools/call` dispatch point that runs `resolveBinding -> evaluatePolicy -> ExecuteStage/ApprovalStage/CapEnforcer -> receipt append` entirely inside one per-lease `LeaseStore.transaction`, proven end-to-end with a real MCP `Client` over `InMemoryTransport`.**

## Performance

- **Duration:** ~25 min
- **Started:** 2026-09-28T14:50 (approx)
- **Completed:** 2026-09-28T15:15
- **Tasks:** 3
- **Files modified:** 9

## Accomplishments
- `@stint/proxy` now has a working agent-facing MCP server (`createLeaseProxyServer`): one low-level `Server` per lease, `tools/list` computed once at construction from the runtime-owned catalog x `BindingSet`, filtered to exactly the tools this lease's granted scopes/resources permit.
- The single `CallToolRequestSchema` handler (`dispatch.ts`'s `handleCall`) is the ONE dispatch point every `tools/call` flows through — `resolveEffectiveBinding` collapses BOTH a truly-unbound tool and a bound-but-out-of-scope tool to the same `no_binding` denial, so a tool hidden from `tools/list` can never be invoked by naming it directly.
- Every `tools/call`, allowed or denied, appends exactly one secretless verified-chain receipt (`CallPayload`: `resource`/`argsHash`/`redactedSummary`/`outcome` only), built and appended inside the same per-lease `LeaseStore.transaction` the call's authorization runs in — proven gap-free and `verifyChain`-valid under 20 concurrent calls against one lease.
- Three clean injected seams (`ExecuteStage`, `ApprovalStage`, `CapEnforcer`) with production-safe `DEFAULT_*` implementations are in place for plans 04-03 (sliding-window caps), 04-04 (real out-of-band approvals), and 04-05 (vault-backed execute) to fill in without editing `dispatch.ts`.
- A real MCP `Client` driven over `InMemoryTransport.createLinkedPair()` proves the whole path end-to-end (no mocked transport layer): lists the one permitted tool, calls it, gets the echo result back, and the verified chain holds exactly one `allowed` receipt.

## Task Commits

Each task was committed atomically:

1. **Task 1: End-to-end "call a permitted read tool" — one path only** - `c9c0dfa` (feat)
2. **Task 2: PRXY-01 completeness — filtering + direct-name denial + barrel** - `60e2f12` (feat)
3. **Task 3: RCPT-01 receipt guarantees — one per call, secretless, ordered** - `99acb26` (test)
4. **Lint fix (Rule 3 — blocking): silence `@typescript-eslint/no-deprecated` for the deliberate low-level `Server`** - `948b259` (fix)

**Plan metadata:** committed separately after this SUMMARY (see final metadata commit).

## Files Created/Modified
- `packages/proxy/src/catalog.ts` - runtime-owned `ToolCatalog` (`createToolCatalog`/`resolveCatalogEntry`), `Object.hasOwn`-guarded exactly like `@stint/core`'s `BindingSet`
- `packages/proxy/src/dispatch.ts` - `handleCall`, `resolveEffectiveBinding`, the `ExecuteStage`/`ApprovalStage`/`CapEnforcer` seam interfaces + `DEFAULT_*` implementations, `CallContext`
- `packages/proxy/src/server.ts` - `ProxyDeps`, `createLeaseProxyServer` (low-level `Server`, static filtered `tools/list`, single `tools/call` handler)
- `packages/proxy/src/concurrency/lease-serializer.ts` - `runInLeaseTransaction`, a thin wrapper over `LeaseStore.transaction`
- `packages/proxy/src/receipts/call-receipt.ts` - `buildCallPayload`/`appendCallReceipt`
- `packages/proxy/src/testing.ts` - added `createEchoExecuteStage`
- `packages/proxy/src/index.ts` - finalized public barrel, grouped + requirement-annotated
- `packages/proxy/test/server-tracer.test.ts` - the end-to-end tracer plus PRXY-01 completeness tests
- `packages/proxy/test/call-receipts.test.ts` - RCPT-01 receipt-guarantee tests

## Decisions Made
- `resolveEffectiveBinding` (dispatch.ts) is the single place both `tools/list`'s visibility filter and `tools/call`'s authorization resolve a binding through, so the two surfaces can never silently drift — this is the planner's asserted resolution of PRXY-01's flagged "unclassified" edge, confirmed by the Task 2 tests.
- An errored `execute()` call is receipted with `outcome: "denied"` and a fixed, generic `redactedSummary` ("execute_failed") — never the underlying error's message, since a connector error could carry request/arg material the receipt must never leak.
- Kept the low-level `Server` per RESEARCH.md Pattern 1; suppressed the resulting `@typescript-eslint/no-deprecated` lint error with two narrow, justified `eslint-disable-next-line` comments rather than a package-wide exemption.
- Implemented the `require_approval` branch in `handleCall` now (not deferred to 04-04), since `ProxyDeps` already declares the `approve: ApprovalStage` seam and `DEFAULT_APPROVAL_STAGE` denies by default — consistent with the deny-on-timeout discipline the real HostAdapter-backed implementation will provide in plan 04-04.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `@typescript-eslint/no-deprecated` failing lint on the deliberate low-level `Server` use**
- **Found during:** post-Task-3 scoped lint pass (`eslint packages/proxy/src packages/proxy/test`)
- **Issue:** `@modelcontextprotocol/sdk`'s low-level `Server` class carries its own `@deprecated` docstring ("Only use `Server` for advanced use cases"), which the workspace's type-aware ESLint config flags as an error at both the `new Server(...)` call site and the `Server` return-type annotation.
- **Fix:** Added a docstring explaining why `Server` (not `McpServer`) is the correct choice here (RESEARCH.md Pattern 1 — JSON-Schema catalog vs. `McpServer.registerTool()`'s Zod-only `inputSchema`), plus two narrow `eslint-disable-next-line @typescript-eslint/no-deprecated` comments at the two exact call sites.
- **Files modified:** `packages/proxy/src/server.ts`
- **Verification:** `eslint packages/proxy/src packages/proxy/test` exits clean; `tsc -b` and all 14 proxy tests still pass.
- **Committed in:** `948b259`

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** Necessary to keep the package lint-clean without weakening the deliberate architectural choice (low-level `Server`) RESEARCH.md documents. No scope creep.

## Issues Encountered
None beyond the lint fix above. All three tasks' `<verify>` blocks passed on the implementation's first test run; no dispatch.ts/call-receipt.ts hardening was needed for Task 3's RCPT-01 edges — Task 1/2's per-lease-transaction + finally-path receipt design already satisfied them.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- `catalog.ts`, `server.ts`, `dispatch.ts`, `concurrency/lease-serializer.ts`, and `receipts/call-receipt.ts` exist with clean, tested seams (`ExecuteStage`, `ApprovalStage`, `CapEnforcer`) that plans 04-03, 04-04, and 04-05 implement against without editing `dispatch.ts`.
- `DEFAULT_CAP_ENFORCER.authorize` always allows (no additional limit beyond `evaluatePolicy`'s own checks) — plan 04-03 supplies the real `actions_per_hour` sliding-window check using `LeaseCounters.actionTimestamps` (already scaffolded in 04-01).
- `DEFAULT_APPROVAL_STAGE.requestApproval` always denies — plan 04-04 supplies the real out-of-band `HostAdapter`-backed implementation with the approval commitment hash (D-11) and a real `AbortSignal` timeout.
- `DEFAULT_EXECUTE_STAGE.execute` always throws "no OutboundConnector configured" — plan 04-05 supplies the vault-backed `ExecuteStage` (credential resolution, single-flight refresh, scrubbed errors).
- No blockers identified for 04-03 onward.

---
*Phase: 04-mcp-proxy-credential-vault*
*Completed: 2026-09-28*

## Self-Check: PASSED

All claimed created/modified files exist on disk and all claimed commit hashes (`c9c0dfa`, `60e2f12`, `99acb26`, `948b259`) are present in git history.
