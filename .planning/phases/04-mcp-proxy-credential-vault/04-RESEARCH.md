# Phase 4: MCP Proxy & Credential Vault - Research

**Researched:** 2026-09-28
**Domain:** MCP proxy (Policy Enforcement Point) wiring pure `@stint/core` decisions to live I/O — agent-facing MCP server, OAuth 2.1 delegated-grant credential vault (RFC 7009/8707), per-lease concurrency, out-of-band approvals, per-call receipts.
**Confidence:** HIGH — every claim about the pinned packages below was either read directly from the installed package's shipped `.d.ts`/source, or exercised hands-on against a running `oauth2-mock-server` instance in this session (see `## Hands-On Verification Log`). The two `[ASSUMED]` items are logged in `## Assumptions Log`.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01:** The vault reaches downstream resources through an abstract `OutboundConnector` port in `@stint/proxy` (`execute(binding, resolvedArgs, credential) → result`). The port implementation is where transport (HTTP/REST, or future real MCP client) lives; Phase 4 ships the port + at least one reference impl, Phase 7 supplies mocks. Keeps the vault and enforcement path transport-agnostic and adversarially testable with no live network. — Reversibility: costly.
- **D-02:** The port receives the raw credential. The vault resolves the token and passes it into `execute(...)`; the port attaches it (header/param) and makes the call. The vault wraps the port call in the credential scrubber, so any thrown error or echoed request is stripped of token material before it can propagate. The port implementation is trusted-boundary code; the untrusted boundary is the agent-facing `Server` response/error path, where the adversarial "token never leaks" test is aimed. — Reversibility: costly.
- **D-03:** Phase 4 owns the runtime hot path only: outbound injection with RFC 8707 resource indicators, per-credential single-flight refresh, and lazy `invalid_grant`/401 revocation detection. The initial auth-code + PKCE acquisition / consent flow is out of scope for Phase 4 (deferred to CLI/example wiring).
- **D-04:** Tokens enter the vault via a narrow "load/seed credential" seam (`leaseId + resource → { accessToken, refreshToken, expiry, tokenEndpoint, resourceIndicator }`) that both Phase 4 tests and the future acquisition flow use. Refresh is real: `oauth4webapi`'s refresh-token grant against `oauth2-mock-server`, with the RFC 8707 `resource` on the request, so single-flight refresh and `invalid_grant` detection are exercised end-to-end without the interactive redirect. — Reversibility: costly.
- **D-05:** `actions_per_hour` uses a sliding 60-minute window via per-action timestamps (deny `over_actions_per_hour` if the count within `[now-3600s, now]` would exceed the limit), reusing the exact `denialErrorTimestamps` pattern already in `LeaseCounters`. No fixed-bucket burst loophole. Prune aged-out timestamps.
- **D-06:** Enforcement counters (the new action-timestamp list, `actionCount`, `spentMinor`) live in the lease snapshot, mutated as part of each call's serialized read-modify-write through the `LeaseStore`, under the existing per-lease serializer. Counters survive restart and are the single source of truth. Requires a small additive change to `@stint/core`'s `LeaseCounters` to carry the per-action timestamps `actions_per_hour` needs. — Reversibility: costly.
- **D-07:** A `pay` call's amount + currency (minor units) is extracted pre-authorization from resolved args per a runtime-owned, binding-declared amount source (the `ConnectorBinding` for a pay-capable tool declares which arg holds the amount/currency). The proxy passes it as `PolicyCall.spendMinor` to `evaluatePolicy` before the call executes, so the cap is enforced ahead of spending, never after the fact. — Reversibility: costly.
- **D-08:** A runtime-owned tool catalog supplies the agent-facing MCP tool definitions (name, description, `inputSchema`) for `tools/list`, paired with (not merged into) the `ConnectorBinding`. `tools/list` is computed by filtering the catalog to the lease's scoped, bound tools. `@stint/core`'s `ConnectorBinding` stays minimal (classification only: `tool, resource, access, irreversible, provenance`) — MCP presentation concerns live in the proxy-owned catalog. Nothing agent- or publisher-supplied, and nothing fetched live from downstream, drives the agent-facing surface. — Reversibility: costly.
- **D-09:** Narrow revocation signal, everything else → error threshold. Only a documented signal set counts as provider revocation → `revoked` (actor `provider`): OAuth `invalid_grant`, or a 401/403 that persists after a single-flight refresh attempt also fails with `invalid_grant`. All other upstream failures (5xx, timeouts, network errors, non-auth 4xx) count toward the LIFE-07 error threshold. A single transient blip never revokes. — Reversibility: costly.
- **D-10:** One proxy `Server` instance per lease. The proxy is constructed for a specific `leaseId`; the lease is fixed by instantiation, never a call parameter, so the agent can never name or switch leases. `tools/list` and every `tools/call` resolve against that one lease. Multi-lease multiplexing is a v2 concern. — Reversibility: costly.
- **D-11:** The approval hash covers `canonicalize(resolved args) + binding identity (tool + provenance/version) + lease version`, computed via the existing `@stint/spec` canonical serializer (the same one receipts use — no new serializer). The pending-approval record stores that hash; at execution the proxy recomputes and requires an exact match, else the call is a new request requiring new approval (the reused approval is denied). The core `awaitApprovalDecision` (Phase 2 D-17) remains the only sanctioned way to call `requestApproval`; the proxy arms the actual timeout/`AbortSignal`. — Reversibility: costly.
- **D-12:** The runtime-owned tool catalog + `BindingSet` are injected at proxy construction (platform/runtime-owned, never the manifest). `@stint/proxy` also ships built-in catalogs/bindings for the example's known connectors (Paystack, Sheets), which a platform can pass through or extend. User-approved custom bindings use the existing `user_approved_custom` provenance already on `ConnectorBinding`. — Reversibility: reversible.
- **D-13:** Exactly one verified-chain outcome receipt per `tools/call`, recording the final outcome (allowed + result summary, denied + reason, or errored + reason), written in a guaranteed `finally`/settled path so even a thrown mid-call error still produces a receipt. Denied calls receipt too. The append happens inside the per-lease serializer so chain order matches call order. Summary is binding-redacted (`argsHash` + `redactedSummary` only) and secretless by type. Uses the existing `appendEntry` over the `ReceiptStore` (in-memory now; JSON impl Phase 6). — Reversibility: costly.

**Locked upstream — do not re-litigate:**
- PEP/PDP split — proxy is a thin dispatcher; all decisions come from core's pure `evaluatePolicy`. No policy/`if(scope…)` logic in the transport layer.
- Bindings runtime-owned, never manifest — nothing in `@stint/proxy` reads `access`/`resource` from manifest JSON for enforcement.
- Dual-server topology — agent-facing server + downstream client/port per connector.
- Approvals out-of-band through HostAdapter only — never MCP elicitation through the agent's client; timeout defaults to deny.
- Vault injection-without-exposure — token never returned to the agent by construction; error scrubbing at the vault boundary.
- `HeldLicense` opaque type + `readLicenseToken` single accessor — license never to agent, never to customer resource.
- Per-lease serialization mutex keyed by `leaseId`; cross-lease stays concurrent.
- Per-credential single-flight refresh — callers await an in-flight refresh; never two redemptions of one refresh token.
- Per-call expiry, injectable clock, no timers; no cached "still valid" boolean.

### Claude's Discretion

- Exact TypeScript names/module layout in `@stint/proxy` (`server.ts`, `vault/`, `connectors/` or `outbound/`, `concurrency/`, `oauth/`, `bindings.ts`, tool catalog) per ARCHITECTURE's suggested structure.
- The precise additive field name/shape added to core `LeaseCounters` for action timestamps (D-06), provided it is additive and the serialized read-modify-write stays correct.
- The `OutboundConnector` port's exact signature and the reference impl's transport (D-01), provided credential handling matches D-02.
- The seed-seam signature (D-04) and the pending-approval record's storage location (D-11), provided the invariants hold.
- Exact `redactedSummary` contents (D-13) and stable reason strings for denied/errored receipts, provided no secret/raw-arg can appear by type.
- How the binding declares the pay amount/currency source (D-07) — field name/shape on the binding or catalog entry.

### Deferred Ideas (OUT OF SCOPE)

- Initial OAuth grant acquisition (auth-code + PKCE, consent redirect, AS discovery) that seeds the vault — CLI (Phase 6) / example (Phase 7), against the D-04 seed seam.
- OAuth revocation execution, license invalidation, cleanup hook, and entitlement revocation → `revoked` (actor `publisher`) — Phase 5 teardown (LIC-04, TEAR-*). Phase 4 only detects provider-side revocation.
- Outcome verification (`resource_query` predicate through the proxy, `user_confirm`) — Phase 5 (LIFE-06).
- JSON-file `LeaseStore`/`ReceiptStore` with NTFS-atomic writes + locking — Phase 6 (HOST-03).
- CLI reference HostAdapter rendering approvals in the terminal — Phase 6 (HOST-02).
- Multi-lease proxy multiplexing (session→lease mapping) — v2.
- Real downstream MCP `Client` connectors (vs the mock/REST reference impl) behind the `OutboundConnector` port — post-v0.1.

</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| PRXY-01 | Agent connects to the proxy as an MCP server and sees only tools permitted by its lease | `## Architecture Patterns` Pattern 1 (dual-server, per-lease `Server`) + `## Code Examples` "Agent-facing `Server` skeleton"; MCP SDK hands-on finding on `Server` vs `McpServer` below |
| PRXY-04 | `actions_per_hour`, total action cap and `spend` limits enforced per lease under concurrent calls (per-lease serialization) | `## Architecture Patterns` Pattern 7 (already built in `@stint/core`'s `LeaseStore.transaction`); `## Code Examples` "Sliding-window action-timestamp counter" |
| PRXY-05 | Calls requiring approval held via HostAdapter, bound to a hash of exact args/binding/lease version; timeout denies | `## Code Examples` "Approval commitment hash"; `## Common Pitfalls` Pitfall 3 |
| PRXY-06 | Proxy injects OAuth access tokens (RFC 8707) only on outbound calls; no token in any agent-facing response/error (adversarial tests) | `## Hands-On Verification Log` steps 1 & 4; `## Don't Hand-Roll` credential scrubbing row; `InMemoryTransport` adversarial-test pattern |
| PRXY-07 | Customer-side OAuth revocation (`invalid_grant`/401) moves lease to `revoked` (actor `provider`) | `## Hands-On Verification Log` step 4 (`ResponseBodyError.error === 'invalid_grant'`); `## Common Pitfalls` Pitfall 5 |
| PRXY-08 | Token refresh serialized per credential | `## Architecture Patterns` Pattern 7 applied to the vault; `## Common Pitfalls` Pitfall 6; oauth2-mock-server has **no** native reuse-detection, so the test must count server hits (see Hands-On Verification Log) |
| RCPT-01 | Every tool call, allowed or denied, appends a receipt with args hash and binding-redacted summary | `## Code Examples` "Per-call receipt in a `finally` path"; reuses `appendEntry`/`ReceiptStore` from Phase 3 unchanged |
| LIC-05 | License never forwarded to customer resources (tested) | `## Architecture Patterns` Pattern 3; `HeldLicense`/`readLicenseToken` already built (Phase 3 D-15) — Phase 4 only wires the injection-without-exposure call site |

</phase_requirements>

## Summary

Phase 4 wires the fully-tested, dependency-free decision logic already built in `@stint/core` (Phases 2-3: `evaluatePolicy`, `reduce`, `LeaseStore`, `ReceiptStore`, `HeldLicense`, license refresh) to a live MCP proxy in `@stint/proxy`. Nothing in this phase invents new policy or state-machine logic — the entire job is I/O: run an MCP server the agent connects to, run an OAuth 2.1 client (`oauth4webapi`) that never lets a token reach the agent, serialize concurrent calls per lease, hold approvals out-of-band, and append exactly one receipt per call.

Three hands-on findings materially change what CLAUDE.md and the CONTEXT.md canonical refs assumed, and the planner must account for all three:

1. **`@modelcontextprotocol/sdk@1.30.1`'s low-level `Server` class carries an SDK-authored `@deprecated` tag** ("Use `McpServer` instead... Only use `Server` for advanced use cases") — but the high-level `McpServer.registerTool()`'s `inputSchema` parameter is typed `ZodRawShapeCompat | AnySchema` where `AnySchema = z3.ZodTypeAny | z4.$ZodType` (Zod only, verified by reading the shipped `zod-compat.d.ts`), **not** raw JSON Schema as CLAUDE.md's stack table claims. The wire-format `Tool.inputSchema` (what `tools/list` actually sends) *is* JSON-Schema-shaped (`{type:"object", properties, required}`), and the low-level `Server.setRequestHandler(ListToolsRequestSchema/CallToolRequestSchema, ...)` accepts that shape directly with zero conversion. Given D-08's runtime-owned JSON-Schema catalog and D-10's "one static `Server` per lease, tools/list computed once at construction," Stint's proxy is exactly the "advanced use case" the deprecation note carves out — **recommend the low-level `Server`**, not `McpServer`, and flag the caveat for the planner (see `## State of the Art`).
2. **`oauth2-mock-server@9.2.0`'s `/revoke` endpoint unconditionally returns 200** and performs no state tracking — confirmed by reading its source (`revokeHandler` always resolves `{statusCode: 200}`) and by hands-on testing (redeeming a refresh token *after* "revoking" its access token still succeeds). This is Pitfall 5 made concrete: **the mock server cannot organically produce `invalid_grant` for PRXY-07's revocation-detection tests.** The only way to simulate real provider-side revocation is the `Events.BeforeResponse` hook, forcing `{error: 'invalid_grant'}` on the next token-endpoint response — verified hands-on to produce `oauth.ResponseBodyError` with `.error === 'invalid_grant'` and `.status === 400` from `processRefreshTokenResponse`.
3. **`oauth4webapi` defaults to HTTPS-only** and throws `OperationProcessingError` (`OAUTH_HTTP_REQUEST_FORBIDDEN`) against `oauth2-mock-server`'s plain-HTTP `localhost` endpoints unless every call site passes `[oauth.allowInsecureRequests]: true` — an easy omission that will silently block every Phase 4 OAuth test until discovered.

**Primary recommendation:** Build the agent-facing surface on the low-level `Server` (not `McpServer`) with a statically-precomputed `tools/list` per lease instance; implement the vault's refresh/revocation hot path with `oauth4webapi` against `oauth2-mock-server`, remembering `allowInsecureRequests` on every call and that `/revoke` must be treated as unverifiable (Pitfall 5) with revocation-detection tests driven through `Events.BeforeResponse`, not `/revoke` itself.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Agent-facing tool discovery (`tools/list`) | API/Backend (`@stint/proxy`) | — | Computed once per lease at `Server` construction from the runtime-owned catalog × `BindingSet`; never a passthrough of any downstream schema (D-08, D-10). |
| Call authorization decision | API/Backend, delegated to pure core | — | `@stint/proxy` never decides; it calls `@stint/core`'s `evaluatePolicy` (already built, Phase 2). The proxy is PEP, core is PDP. |
| Per-lease concurrency / rate-limit counters | API/Backend (`LeaseStore.transaction`) | — | Already built in Phase 2 (D-13); Phase 4 only needs to route every mutating call through it and add the `actions_per_hour` timestamp field (D-06). |
| OAuth token storage & refresh | API/Backend (Credential Vault) | — | In-process, keyed by `leaseId:resource`; never persisted to `LeaseStore`/receipts (secretless boundary, D-02). |
| Downstream credential-bearing calls | API/Backend (`OutboundConnector` port) → external Provider | External Provider (customer resource) | Port is trusted-boundary code (D-02); the actual HTTP/REST call happens here, never proxied through the agent. |
| Approval UX | Host/Platform (via `HostAdapter`) | API/Backend (dispatch + timeout arming) | Core already defines the interface and deny-on-timeout rule (Phase 2 D-17); Phase 4 arms the real `AbortSignal` deadline from `manifest.approvals.timeout_seconds`. |
| Receipt persistence | API/Backend (`ReceiptStore`, in-memory double) | — | Already built (Phase 3); Phase 4 calls `appendEntry` + `store.append` per call inside the per-lease serializer. |

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@modelcontextprotocol/sdk` | **1.30.1** `[VERIFIED: npm registry, published 2026-09-23T16:06:59Z]` | Agent-facing MCP server; wire types (`Tool`, `CallToolRequest`, `ListToolsRequestSchema`, `CallToolRequestSchema`) | Official TS SDK; already pinned by CLAUDE.md and confirmed current on the npm registry this session. |
| `oauth4webapi` | **3.8.8** `[VERIFIED: npm registry, published 2026-09-05T10:22:40Z]` | OAuth 2.1 client for delegated grants: refresh-token grant with RFC 8707 `resource`, RFC 7009 revocation | Spec-strict, zero-dependency; hands-on tested this session against `oauth2-mock-server` (resource param transmission + revocation call + `invalid_grant` detection all confirmed — see Hands-On Verification Log). |
| `@stint/core` (workspace) | `workspace:*` | `evaluatePolicy`, `reduce`, `LeaseStore`, `ReceiptStore`, `HeldLicense`, license refresh, `checkErrorThreshold` | Already built (Phases 2-3); Phase 4 imports it, never re-derives decisions. |
| `@stint/spec` (workspace) | `workspace:*` | `canonicalize`/`hashCanonical` for the approval-commitment hash (D-11) | No new serializer permitted anywhere in this repo. |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `oauth2-mock-server` | **9.2.0** `[VERIFIED: npm registry, published 2026-09-04T08:15:59Z]` (devDependency) | Mock OAuth 2.1 AS for refresh + revocation tests | Every Phase 4 OAuth test; requires `[oauth.allowInsecureRequests]: true` on every `oauth4webapi` call and the RS256-key caveat below (Hands-On Verification Log). |
| `@modelcontextprotocol/sdk`'s `InMemoryTransport` (`sdk/inMemory` export) | ships with 1.30.1 | In-process linked `Client`↔`Server` transport pair for adversarial tests | Use for PRXY-06's "token never leaks to the agent" tests: drive a real `Client` against the proxy's `Server` with zero real process/socket, assert no substring of the credential ever appears in any `CallToolResult`/error. `InMemoryTransport.createLinkedPair()` confirmed present via `.d.ts` inspection this session. |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Low-level `Server` + manual `setRequestHandler` | `McpServer.registerTool()` | Rejected for the catalog/binding wiring specifically: `registerTool`'s `inputSchema` only accepts Zod schemas (verified from `zod-compat.d.ts`), forcing either a JSON-Schema→Zod conversion step or hand-duplicated Zod definitions — exactly what CLAUDE.md wanted to avoid by assuming raw-JSON-Schema support. `McpServer` remains fine for anything *not* needing per-lease static tool filtering (none of Phase 4's surface). |
| `oauth4webapi`'s `additionalParameters` for `resource` | A first-class `resource` option | No such first-class option exists on `refreshTokenGrantRequest`/`revocationRequest` in 3.8.8 — confirmed via `.d.ts`; RFC 8707 resource indicators are sent via the generic `additionalParameters: URLSearchParams \| Record<string,string> \| string[][]` on `TokenEndpointRequestOptions`. This is the library's documented mechanism, not a workaround. |

**Installation:**
```bash
pnpm --filter @stint/proxy add @modelcontextprotocol/sdk@1.30.1 oauth4webapi@3.8.8
pnpm --filter @stint/proxy add -D oauth2-mock-server@9.2.0
```

**Version verification:** confirmed this session via `npm view <pkg> version` against the live registry (see table above for exact publish timestamps). All three match CLAUDE.md's existing pins exactly — no drift to reconcile.

## Package Legitimacy Audit

| Package | Registry | Age (latest publish) | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----------------------|-----------|--------------|---------|-------------|
| `@modelcontextprotocol/sdk` | npm | published 2026-09-23 (5 days old) | 63.7M/wk | github.com/modelcontextprotocol/typescript-sdk | `[SUS]` (reason: `too-new`) | Approved — official Anthropic/MCP org repo, no `postinstall`, not deprecated, 63.7M weekly downloads. The "too-new" signal reflects the latest version's publish date (active maintenance cadence), not package trustworthiness. Planner should still add a `checkpoint:human-verify` before install per protocol. |
| `oauth4webapi` | npm | published 2026-09-05 (23 days old) | 16.0M/wk | github.com/panva/oauth4webapi | `[SUS]` (reason: `too-new`) | Approved — panva is the maintainer of `jose`/`paseto` already pinned and researched in CLAUDE.md; no `postinstall`, not deprecated, 16M weekly downloads. Same "too-new = recent release" caveat as above; add `checkpoint:human-verify` before install. |
| `oauth2-mock-server` | npm | published 2026-09-04 (24 days old) | 235.6K/wk | github.com/axa-group/oauth2-mock-server | `[SUS]` (reason: `too-new`) | Approved — devDependency only (never ships to production code), AXA-group-maintained, no `postinstall`, not deprecated. Add `checkpoint:human-verify` before install. |

**Packages removed due to `[SLOP]` verdict:** none.
**Packages flagged as suspicious `[SUS]`:** all three, uniformly for `too-new` (a signal about the recency of the specific pinned version's publish timestamp, not package legitimacy). All three are the exact versions CLAUDE.md already pinned after its own registry research; this session's independent `npm view` calls reproduced identical version numbers. The planner MUST still insert a `checkpoint:human-verify` task before the `pnpm add` step per the Package Legitimacy Gate protocol, even though this research treats all three as safe to proceed with.

## Architecture Patterns

### System Architecture Diagram

```
┌─────────────┐   MCP (stdio/InMemoryTransport)   ┌──────────────────────────────────────────┐
│ Agent (LLM) │ ────────────────────────────────▶ │ @stint/proxy — one Server per leaseId     │
│  untrusted  │ ◀──────────────────────────────── │                                            │
└─────────────┘   tools/list, tools/call, result   │  ┌────────────┐  ┌─────────────────────┐  │
                                                    │  │ tools/list │  │ tools/call handler   │  │
                                                    │  │ (static,   │  │ (single dispatch     │  │
                                                    │  │  built at  │  │  point, per D-10)     │  │
                                                    │  │  construct)│  └──────────┬───────────┘  │
                                                    │  └─────┬──────┘             │              │
                                                    │        │ reads              ▼              │
                                                    │        │        ┌───────────────────────┐  │
                                                    │        │        │ 1. resolveBinding      │  │
                                                    │        │        │ 2. evaluatePolicy      │──┼──▶ @stint/core (pure PDP)
                                                    │        │        │    (deny/approve/allow)│  │
                                                    │        │        └──────────┬─────────────┘  │
                                                    │        ▼                   │                │
                                                    │  ┌──────────────┐          │ require_approval
                                                    │  │ Runtime-owned│          ▼                │
                                                    │  │ tool catalog │   ┌─────────────────┐     │
                                                    │  │ × BindingSet │   │ awaitApprovalDec│─────┼──▶ HostAdapter (out-of-band)
                                                    │  │  (D-08, D-12)│   │ ision + real     │     │
                                                    │  └──────────────┘   │ AbortSignal      │     │
                                                    │                     └─────────────────┘     │
                                                    │  allow ─────────────────────┐               │
                                                    │                             ▼               │
                                                    │  ┌──────────────────────────────────────┐   │
                                                    │  │ Per-lease serializer (LeaseStore       │   │
                                                    │  │ .transaction) — counters + version     │   │
                                                    │  └──────────────┬──────────────────────-─┘   │
                                                    │                 ▼                            │
                                                    │  ┌──────────────────────────────────────┐    │
                                                    │  │ Credential Vault                      │    │
                                                    │  │  - resolves token (refresh if needed, │    │
                                                    │  │    single-flight per credential)      │    │
                                                    │  │  - wraps call in scrubber              │    │
                                                    │  └──────────────┬───────────────────────-┘    │
                                                    │                 ▼                             │
                                                    │  ┌──────────────────────────────────────┐     │
                                                    │  │ OutboundConnector port (D-01/D-02)     │────┼──▶ Provider (Paystack/Sheets,
                                                    │  │  execute(binding, args, credential)    │     │    mocked in Phase 7)
                                                    │  └──────────────┬───────────────────────-┘     │
                                                    │                 ▼                              │
                                                    │  ┌──────────────────────────────────────┐      │
                                                    │  │ finally: appendEntry + ReceiptStore    │      │
                                                    │  │  .append (RCPT-01, exactly one/call)   │      │
                                                    │  └──────────────────────────────────────┘       │
                                                    └───────────────────────────────────────────────--┘
```

### Recommended Project Structure

```
packages/proxy/src/
├── index.ts             # public surface (PACKAGE_NAME + exported factory)
├── server.ts             # agent-facing Server construction, tools/list + tools/call handlers
├── catalog.ts            # runtime-owned tool catalog (JSON-Schema inputSchema) x BindingSet pairing (D-08)
├── concurrency/
│   └── lease-serializer.ts  # thin wrapper: every mutating op goes through LeaseStore.transaction
├── vault/
│   ├── credential-vault.ts  # token store keyed leaseId:resource, single-flight refresh (D-04, PRXY-08)
│   ├── oauth-client.ts      # oauth4webapi wiring: refresh grant, revocation request, resource indicators
│   └── scrub.ts             # error/response credential scrubbing (D-02)
├── connectors/
│   └── outbound-connector.ts  # OutboundConnector port + one reference (REST) impl (D-01)
├── approvals/
│   └── approval-dispatcher.ts  # computes commitment hash (D-11), arms real AbortSignal timeout
└── receipts/
    └── call-receipt.ts      # builds ReceiptEntryInput from a call outcome, finally-path append (D-13)
```

### Pattern 1: PEP/PDP split via a per-lease, statically-scoped low-level `Server`

**What:** Construct one `@modelcontextprotocol/sdk` low-level `Server` per `leaseId` (D-10). At construction, compute `tools/list`'s contents once by filtering the runtime-owned catalog (D-08) against the `BindingSet` for the tools this lease's `manifest.scopes` actually cover — register that as a static handler for `ListToolsRequestSchema`. Register a *single* handler for `CallToolRequestSchema` that is the one and only dispatch point: resolve binding → `evaluatePolicy` → (deny | require_approval | allow) → vault/connector → receipt.

**When to use:** Exactly Stint's shape — a fixed, pre-known set of tools per session, where "what's visible" must never depend on anything the agent or a live downstream fetch can influence.

**Why the low-level `Server`, not `McpServer`:** `McpServer.registerTool()` is the SDK's recommended high-level API in general, but its `inputSchema` parameter is Zod-typed only (verified — see `## Hands-On Verification Log` and `## State of the Art`). The runtime-owned catalog (D-08) is defined in JSON Schema (to pair with the Ajv-validated manifest/binding pipeline already used elsewhere in this repo). The low-level `Server`'s wire-level `Tool.inputSchema` field *is* JSON-Schema-shaped already, so `setRequestHandler(ListToolsRequestSchema, ...)` returning `{ tools: catalogEntries }` requires zero schema conversion. The SDK's own `@deprecated` note on `Server` reads "Only use `Server` for advanced use cases" — a per-lease, policy-gated, statically-filtered tool list is exactly that.

**Example:**
```typescript
// Source: read directly from @modelcontextprotocol/sdk@1.30.1's shipped
// dist/esm/server/index.d.ts and dist/esm/types.d.ts this session.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { evaluatePolicy, resolveBinding } from "@stint/core";

export function createLeaseProxyServer(leaseId: string, deps: ProxyDeps): Server {
  const server = new Server(
    { name: "stint-proxy", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  // D-08/D-10: computed once, from the runtime-owned catalog, never a
  // passthrough of anything the manifest or a downstream server supplies.
  const visibleTools = deps.catalog.filter((entry) =>
    deps.leaseScopes.includes(resolveBinding(deps.bindings, entry.name)?.resource ?? ""),
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: visibleTools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    // `request.params.name` / `request.params.arguments` — the ONLY dispatch
    // point; every call, allowed or denied, flows through here (PRXY-01).
    return deps.serializer.run(leaseId, () => deps.handleCall(request.params));
  });

  return server;
}
```

### Pattern 2: `OutboundConnector` port + credential vault (D-01, D-02)

**What:** The vault never performs the HTTP call itself. It resolves a fresh/valid `accessToken` (refreshing under the single-flight guard if needed), then calls `port.execute(binding, resolvedArgs, credential)`. The port attaches the credential (header/param) and performs the actual request. The vault wraps that call: any thrown error, or any value the port would otherwise return unmodified, passes through a scrubber that strips known token substrings before it can reach the `tools/call` response path.

**When to use:** Any call requiring a real credential — this is the ONLY place in the proxy a raw access token or the license token is ever read out of its holder.

**Example:**
```typescript
// Illustrative — no upstream source; composes D-01/D-02 as decided.
export interface OutboundConnector {
  execute(
    binding: ConnectorBinding,
    resolvedArgs: Record<string, unknown>,
    credential: { accessToken: string },
  ): Promise<{ status: number; body: unknown }>;
}

async function callWithVault(
  vault: CredentialVault,
  port: OutboundConnector,
  leaseId: string,
  binding: ConnectorBinding,
  resolvedArgs: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const credential = await vault.resolveAccessToken(leaseId, binding.resource); // single-flight refresh inside
  try {
    return await port.execute(binding, resolvedArgs, credential);
  } catch (err) {
    throw scrubCredential(err, credential.accessToken); // never let raw token substrings escape
  }
}
```

### Pattern 3: RFC 8707 resource indicators + RFC 7009 revocation via `oauth4webapi`

**What:** `resource` (RFC 8707) is not a first-class parameter on any `oauth4webapi` grant-request function — it is sent through the generic `additionalParameters` option, present on every `TokenEndpointRequestOptions`/`RevocationRequestOptions`. Revocation is a two-call sequence: `revocationRequest(...)` then `processRevocationResponse(response)`, which resolves `undefined` on success per RFC 7009 (a 2xx body carries no meaningful content).

**When to use:** Every refresh-token grant against a delegated OAuth resource, and every teardown-time (Phase 5) revocation call.

**Example (hands-on verified this session — see Verification Log for full output):**
```typescript
// Source: oauth4webapi@3.8.8's shipped build/index.d.ts, exercised against a
// live oauth2-mock-server@9.2.0 instance this session.
import * as oauth from "oauth4webapi";

const refreshResp = await oauth.refreshTokenGrantRequest(as, client, clientAuth, refreshToken, {
  additionalParameters: { resource: "https://api.paystack.example/v1" }, // RFC 8707
});
const tokens = await oauth.processRefreshTokenResponse(as, client, refreshResp);
// Verified this session: the mock AS's raw token-request body DID include
// `resource: 'https://api.paystack.example/v1'`.

const revokeResp = await oauth.revocationRequest(as, client, clientAuth, tokens.access_token);
const result = await oauth.processRevocationResponse(revokeResp); // undefined = "success", per RFC 7009
```

### Pattern 4: Detecting real provider revocation (D-09, PRXY-07)

**What:** Catch `oauth.ResponseBodyError` from `processRefreshTokenResponse`/`processGenericTokenEndpointResponse` and inspect its `.error` field. Only `err.error === "invalid_grant"` (optionally after a same-credential refresh retry also fails the same way) counts as D-09's narrow revocation signal; every other error (network failure, 5xx, a non-auth 4xx) feeds the LIFE-07 error-threshold counter instead.

**Example (hands-on verified — `err.constructor.name === "ResponseBodyError"`, `err.error === "invalid_grant"`, `err.code === "OAUTH_RESPONSE_BODY_ERROR"`, `err.status === 400`):**
```typescript
try {
  const resp = await oauth.refreshTokenGrantRequest(as, client, clientAuth, refreshToken, opts);
  return await oauth.processRefreshTokenResponse(as, client, resp);
} catch (err) {
  if (err instanceof oauth.ResponseBodyError && err.error === "invalid_grant") {
    return { kind: "provider_revoked" as const }; // -> providerEvents.grantRevoked() through reduce()
  }
  return { kind: "transient_error" as const, cause: err }; // -> feeds checkErrorThreshold, never revokes
}
```

### Anti-Patterns to Avoid

- **Using `McpServer.registerTool()` with a raw JSON-Schema object cast to `any` as `inputSchema`:** it will pass TypeScript only via an unsafe cast and will not exercise the SDK's actual JSON-Schema conversion path the way the catalog's Ajv-validated schema needs — use the low-level `Server` instead (Pattern 1).
- **Trusting `oauth2-mock-server`'s `/revoke` HTTP 200 as proof of revocation in a test:** it always returns 200 regardless of token validity (verified — see Hands-On Verification Log). A test asserting "revocation worked" against `/revoke` alone is testing nothing; assert against `processRevocationResponse` returning `undefined` (spec conformance) and separately assert D-09's detection logic using the `Events.BeforeResponse` hook.
- **Omitting `[oauth.allowInsecureRequests]: true` in tests:** every `oauth4webapi` call against the mock server's plain-HTTP localhost endpoint throws `OAUTH_HTTP_REQUEST_FORBIDDEN` without it — confirmed hands-on.
- **Deriving the approval timeout from a hardcoded constant instead of `manifest.approvals.timeout_seconds`:** the generated `Approvals` type (`packages/spec/src/generated/manifest.ts`) declares `timeout_seconds: number` as a required field — this is the deadline the proxy must arm on the real `AbortSignal`, not an invented default.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| In-process Client↔Server transport for adversarial tests | A fake stdio pipe / custom duplex stream | `@modelcontextprotocol/sdk`'s `InMemoryTransport.createLinkedPair()` | Ships with the SDK (verified via `.d.ts` this session), purpose-built for exactly this "drive a real `Client` against a `Server` with no real process" test shape. |
| Approval/receipt content hashing | A second hash function "just for approvals" | `@stint/spec`'s `canonicalize`/`hashCanonical` (already imported by `@stint/core`'s receipt chain) | D-11 explicitly reuses the receipt-chain serializer; a second serializer reopens Pitfall 7 (non-canonical serialization). |
| Per-lease mutex / rate-limit counters | A new `Map<leaseId, Promise>` queue in `@stint/proxy` | `@stint/core`'s `LeaseStore.transaction(id, mutate)` (already built, Phase 2 D-13) | The serialization guarantee is already implemented, contract-tested, and is what `LeaseCounters`' extra timestamp field (D-06) will live inside — building a second, proxy-local mutex would create two sources of truth for the same lease. |
| Credential-leak scrubbing | A generic string-redaction regex library | A narrow, explicit `scrubCredential(err, knownTokenValue)` that only strips the exact known secret value(s) in scope for the current call | Regex-based generic secret scanners produce both false negatives (a token shaped differently than expected) and false positives; Pitfall 8 calls for a compile-time-enforced boundary, not best-effort pattern matching — the vault always knows the exact string to strip because it just resolved it. |
| RFC 7009 revocation confirmation | Trusting the revoke call's 2xx | Positive confirmation via a subsequent call returning `invalid_grant`/401 (Pattern 4), OR (Phase 5, teardown) explicitly recording `discarded_revocation_unsupported` | RFC 7009 mandates success even for an unrecognized/already-invalid token — a 2xx is not proof (Pitfall 5, confirmed hands-on against the mock server this session). |

**Key insight:** every piece of "hard" logic this phase might be tempted to hand-roll (hashing, per-entity serialization, decision logic) was already built and tested in Phases 2-3. Phase 4's actual net-new code is thin: MCP transport wiring, OAuth HTTP calls, and glue that routes one into the other through the existing pure functions.

## Common Pitfalls

### Pitfall 1: `McpServer.registerTool()`'s Zod-only `inputSchema` silently blocking the JSON-Schema catalog

**What goes wrong:** A plan that assumes CLAUDE.md's claim ("`registerTool()` accepts... a raw JSON Schema") will either hit a TypeScript error or resort to an unsafe cast, and the tool schema actually advertised to the agent may not match what Ajv validates elsewhere.
**Why it happens:** CLAUDE.md's own sourcing note says this was "read from shipped `.d.ts` files" — but for a different aspect of the SDK (the `AnySchema` type param name suggested "any schema shape" without inspecting what `AnySchema` itself resolves to).
**How to avoid:** Use the low-level `Server` + `setRequestHandler(ListToolsRequestSchema, ...)` returning the catalog's native JSON-Schema `Tool[]` directly (Pattern 1) — confirmed to require no conversion.
**Warning signs:** Any `as any` cast on an `inputSchema` argument to `registerTool`; a task description that says "use `McpServer.registerTool` for the catalog."

### Pitfall 2: Testing revocation detection against `oauth2-mock-server`'s real `/revoke` endpoint

**What goes wrong:** A test that calls `revocationRequest` + `processRevocationResponse`, sees `undefined` (success), then tries to redeem the same refresh token again expecting failure — and the redemption succeeds, because the mock server tracks no revocation state at all.
**Why it happens:** `/revoke` is described in the README as "Always returns 200 per RFC 7009," which reads like a real revoke; RFC 7009 itself permits (does not require) this exact no-op behavior.
**How to avoid:** Test PRXY-07's detection path via `Events.BeforeResponse` on the mock server's `service`, forcing `{error: 'invalid_grant'}` on the next token-endpoint response, and assert the proxy's revocation-signal classifier (Pattern 4) fires. Test RFC 7009 *call shape* (the request reaches `/revoke`, gets 200, `processRevocationResponse` resolves `undefined`) as a separate, narrower assertion that does NOT imply the token is actually dead.
**Warning signs:** A test titled "revocation detected" that only asserts on `/revoke`'s response, never on a subsequent `invalid_grant`.

### Pitfall 3: Missing `[oauth.allowInsecureRequests]: true` against the mock AS

**What goes wrong:** Every `oauth4webapi` call (`discoveryRequest`, `refreshTokenGrantRequest`, `revocationRequest`, …) against `oauth2-mock-server`'s `http://localhost:<port>` throws `OperationProcessingError` code `OAUTH_HTTP_REQUEST_FORBIDDEN` before any HTTP request is even sent.
**Why it happens:** `oauth4webapi` defaults to HTTPS-only as a hard security guard; `localhost` is not special-cased.
**How to avoid:** Pass `{ [oauth.allowInsecureRequests]: true }` (the exported `unique symbol`, not a string key) in the options object of every call made against the mock server in tests. Never do this against a production endpoint — the option is explicitly `@deprecated`/discouraged for anything but local dev/test.
**Warning signs:** `OAUTH_HTTP_REQUEST_FORBIDDEN` in test output; any test helper constructing `oauth4webapi` options without importing `allowInsecureRequests`.

### Pitfall 4: Discovering the mock AS with the wrong `algorithm` option

**What goes wrong:** `oauth.discoveryRequest(issuerUrl, { algorithm: 'oauth2' })` against `oauth2-mock-server` fails with `OAUTH_RESPONSE_IS_NOT_CONFORM` (unexpected HTTP status).
**Why it happens:** `oauth2-mock-server` only serves `/.well-known/openid-configuration` (the OIDC discovery path), not `/.well-known/oauth-authorization-server` (the RFC 8414 plain-OAuth2 path `algorithm: 'oauth2'` requests).
**How to avoid:** Use `oauth.discoveryRequest(issuerUrl, { algorithm: 'oidc', [oauth.allowInsecureRequests]: true })` (the default `algorithm`) against this mock server.
**Warning signs:** `OAUTH_RESPONSE_IS_NOT_CONFORM` immediately after starting the mock server.

### Pitfall 5: Signing-key/`alg` mismatch breaking ID-token validation on the refresh grant

**What goes wrong:** `processRefreshTokenResponse` throws `OperationProcessingError` ("unexpected JWT alg header parameter") because the mock server's discovery document hardcodes `id_token_signing_alg_values_supported: ["RS256"]` regardless of which key algorithm was actually generated.
**Why it happens:** `oauth2-mock-server`'s refresh-token grant also issues an `id_token` (confirmed by reading its source: `grantsIssuingIdToken` includes `"refresh_token"`), and `oauth4webapi` validates that token's `alg` against the (always-`RS256`) advertised value.
**How to avoid:** Generate the mock server's signing key with `RS256` (`await server.issuer.keys.generate('RS256')`), not `EdDSA` or another algorithm, when using this library's refresh/authorization-code flows.
**Warning signs:** `unexpected JWT "alg" header parameter` with `expected: ['RS256']` in the error's `cause`.

### Pitfall 6: Proving single-flight refresh without server-side reuse detection

**What goes wrong:** A PRXY-08 test that fires N concurrent calls expecting an about-to-expire token to refresh, then asserts "no error was thrown" — passes trivially even with a broken (non-single-flight) implementation, because the mock server happily honors every redemption of the same refresh token with no rotation/reuse penalty (confirmed hands-on: the same seed refresh token was redeemed twice in a row with no failure).
**Why it happens:** Real providers (Okta/Auth0/Google) implement reuse-detection that would naturally fail a double-redemption race; this mock does not, so a naive test gives a false pass.
**How to avoid:** Assert the *call count* the mock server actually received, not just the absence of an error — e.g. install an `Events.BeforeTokenSigning` (or a custom route hook) that increments a counter, fire N concurrent `vault.resolveAccessToken()` calls for the same credential, and assert exactly one token-endpoint hit occurred.
**Warning signs:** A "single-flight refresh" test with no assertion on how many requests reached the mock server.

## Code Examples

### Sliding-window `actions_per_hour` counter (D-05, D-06)

```typescript
// Source: composed directly from @stint/core/src/policy.ts's checkErrorThreshold
// (verified, packages/core/src/policy.ts:153-163) — the identical timestamp-list
// pattern, applied to the new additive LeaseCounters field per D-05/D-06.
// `LeaseCounters` today (verified, packages/core/src/lease.ts:18-22):
//   readonly actionCount: number;
//   readonly spentMinor: number;
//   readonly denialErrorTimestamps: readonly number[];
// D-06's additive field follows the identical shape, e.g. `actionTimestamps: readonly number[]`.
function isWithinActionsPerHour(
  actionTimestamps: readonly number[],
  limitPerHour: number,
  now: number,
): boolean {
  const windowStart = now - 3600;
  const inWindowCount = actionTimestamps.filter((ts) => ts > windowStart).length;
  return inWindowCount < limitPerHour; // deny if this call would meet/exceed the limit
}
```

### Approval commitment hash (D-11)

```typescript
// Source: composed from @stint/spec's canonicalize (already imported by
// @stint/core's receipt chain, packages/core/src/receipts/chain.ts:40) per
// D-11's explicit "same serializer, no new one" instruction.
import { canonicalize } from "@stint/spec";

function computeApprovalHash(
  resolvedArgs: Record<string, unknown>,
  binding: { tool: string; provenance: string },
  leaseVersion: number,
): string {
  return canonicalize({
    args: resolvedArgs,
    bindingTool: binding.tool,
    bindingProvenance: binding.provenance,
    leaseVersion,
  });
}
// At execution time: recompute with the CURRENT resolved args/binding/lease
// version and require an exact match against the stored pending-approval
// hash; any drift (args changed, binding hot-swapped, lease mutated
// mid-flight) is a NEW request, not a reuse of the old approval.
```

### Per-call receipt in a `finally` path (D-13, RCPT-01)

```typescript
// Source: composed from @stint/core's appendEntry/ReceiptStore contract
// (packages/core/src/receipts/chain.ts, packages/core/src/receipts/receipt-store.ts) —
// verified: `appendEntry` never throws for the happy path, returns a
// ReceiptEntry the caller passes to `store.append(chain, entry)`.
async function handleCallWithReceipt(
  leaseId: string,
  toolCall: { tool: string; args: Record<string, unknown> },
  deps: { store: ReceiptStore; loadedChain: readonly ReceiptEntry[] },
): Promise<CallToolResult> {
  let outcome: CallPayload;
  let result: CallToolResult;
  try {
    result = await dispatchCall(leaseId, toolCall); // policy -> vault -> connector
    outcome = { argsHash: hashArgs(toolCall.args), redactedSummary: summarize(result), decision: "allowed" };
  } catch (err) {
    result = { content: [{ type: "text", text: "call failed" }], isError: true };
    outcome = { argsHash: hashArgs(toolCall.args), redactedSummary: "error", decision: "errored" };
    throw err; // still finally-appends below before propagating
  } finally {
    const entry = appendEntry(deps.loadedChain, { chain: "verified", type: "call", payload: outcome! }, Date.now() / 1000 | 0);
    await deps.store.append("verified", entry); // exactly one entry per call, inside the per-lease serializer
  }
  return result;
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| Low-level MCP `Server` + manual `setRequestHandler` as the primary/only pattern (what `ARCHITECTURE.md`'s Pattern 2 example code shows) | SDK now offers `McpServer` as the recommended high-level API, with `Server` explicitly downgraded to "advanced use cases" | Confirmed in the installed `@modelcontextprotocol/sdk@1.30.1`'s `server/index.d.ts` docstring (`@deprecated Use McpServer instead...`) | Not a functional break — `Server` still works identically and is still exported/supported — but a plan that copies ARCHITECTURE.md's example verbatim should note it is deliberately choosing the "advanced" path for a documented reason (D-08's JSON-Schema catalog), not by oversight. |
| ROADMAP.md's research flag cites "the current MCP Authorization spec" without a pinned version | Current published spec version is **2026-07-28** (fetched this session from modelcontextprotocol.io); the version likely in scope when ROADMAP.md was written was **2025-06-18** | Between those two revisions: Dynamic Client Registration was downgraded from SHOULD to a deprecated fallback (OAuth Client ID Metadata Documents is now primary), an `iss`-parameter validation step (RFC 9207) was added to the authorization-response flow, and a Step-Up Authorization / scope-challenge flow was added | Low direct impact on Phase 4: none of this touches the RFC 8707 resource-parameter requirement or the token-passthrough-forbidden principle, which are unchanged word-for-word between the two versions (verified — both fetched and diffed this session) and are exactly what D-01/D-02/D-04 already encode. The spec's own scope note also still says STDIO transports "SHOULD NOT follow this specification, and instead retrieve credentials from the environment" — relevant if the CLI-hosted proxy (Phase 6) runs over stdio, since the agent-facing leg then falls outside this spec's normative MUSTs entirely; only the proxy's downstream OAuth-client leg (to Paystack/Sheets, governed by plain OAuth 2.1 + RFC 8707 + RFC 7009, not by the MCP Authorization spec) is what Phase 4 actually implements. |
| `packages/proxy/package.json` declares `"engines": {"node": ">=22.12.0"}` | `packages/core/package.json` already declares `">=22.18.0"` (bumped in a prior phase per git history: "fix(03): WR-02 bump packages/core engines.node floor to match repo root") | Phase 3 code review | `packages/proxy`'s `engines.node` floor is stale relative to the rest of the monorepo and CLAUDE.md's documented 22.18+ floor (forced by `@babel/*@8.0.6`/`ast-kit@3.0.0` in the resolved dep tree). Recommend a one-line fix as part of this phase's Wave 0 alongside adding the new dependencies. |

**Deprecated/outdated:**
- `@modelcontextprotocol/sdk`'s low-level `Server` class is SDK-deprecated in favor of `McpServer`, but remains fully functional and is the right choice for Phase 4 specifically (see Pattern 1's rationale).

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|----------------|
| A1 | The example connectors (Paystack, Sheets) referenced by D-12's built-in catalog will be exposed as REST-shaped mocks in Phase 7, not real downstream MCP servers — so the `OutboundConnector` reference impl in Phase 4 should be an HTTP/REST client, not an MCP `Client`. | `## Architecture Patterns` Pattern 2, `## Don't Hand-Roll` | If Phase 7 instead ships a real MCP-shaped mock server, the reference `OutboundConnector` impl would need an MCP `Client` instead of a REST client — low risk since D-01 already scopes "REST, or future real MCP client" as an open transport choice and the port abstraction absorbs this either way. |
| A2 | `manifest.approvals.timeout_seconds` (confirmed present as a required field on the generated `Approvals` type) is the correct/only source for the real `AbortSignal` deadline the proxy arms per D-11/Phase 2 D-17, with no additional runtime-configured floor/ceiling. | `## Anti-Patterns to Avoid`, `## Architectural Responsibility Map` | If a runtime-side minimum/maximum bound on the manifest-declared timeout turns out to be a locked decision elsewhere not yet surfaced to this research, the planner should confirm against CONTEXT.md/PROJECT.md before hardcoding a pass-through. |

**If this table is empty:** N/A — see rows above; both are moderate-confidence inferences, not directly stated in CONTEXT.md, and are flagged for confirmation rather than treated as locked.

## Open Questions

1. **Exact field name/shape for D-06's `LeaseCounters` addition**
   - What we know: it must be additive, timestamp-array-shaped (mirroring `denialErrorTimestamps`), and live in the lease snapshot.
   - What's unclear: the exact field name (`actionTimestamps`? `actionsPerHourTimestamps`?) — explicitly left to Claude's Discretion in CONTEXT.md.
   - Recommendation: name it `actionTimestamps` for symmetry with the existing `denialErrorTimestamps`, appended on every allowed call (not denied — `actions_per_hour` counts successful actions per spec/ALP.md §9, distinct from the error-threshold's denial/error timestamps).

2. **Where the pending-approval record lives between `require_approval` and the retried `tools/call`**
   - What we know: it must store the D-11 commitment hash, keyed so a later call with a matching approval-request id can look it up.
   - What's unclear: in-memory `Map` inside the proxy process (simplest, but lost on restart) vs. persisted via `LeaseStore.transaction` alongside counters (survives restart, consistent with D-06's "counters survive restart" reasoning).
   - Recommendation: in-memory is acceptable for Phase 4 (CONTEXT.md explicitly leaves this to discretion and defers the JSON-file `LeaseStore` to Phase 6); flag for Phase 6 whether it needs to move into persisted state once restart-survival matters end-to-end.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | All of `@stint/proxy` | ✓ | v26.8.2 (well above the 22.18+ floor) | — |
| pnpm (via `npx --yes pnpm@12.6.0`) | Install/build/test | ✓ | 12.6.0 | — (corepack self-switch confirmed broken in this sandbox per prior session memory; `npx --yes pnpm@12.6.0` is the required invocation) |
| Network access to npm registry | Installing the three new packages | ✓ | — | — |
| `oauth2-mock-server` | All OAuth tests (PRXY-06/07/08) | ✓ (self-contained, no external network) | 9.2.0, hands-on verified this session | — |
| Real Paystack/Sheets APIs | N/A | N/A | — | Never used — mocked per PROJECT.md's "Out of Scope: real payment integrations" |

**Missing dependencies with no fallback:** none.
**Missing dependencies with fallback:** none — all required tooling is available in this environment.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest 5.0.2 (pinned, already used by `packages/core`, `packages/proxy` has a working `test/smoke.test.ts`) |
| Config file | `vitest.config.ts` (repo root) |
| Quick run command | `npx --yes pnpm@12.6.0 --filter @stint/proxy test` |
| Full suite command | `npx --yes pnpm@12.6.0 test` (root — runs `pnpm build && vitest run` across the workspace; scope to `--filter` in this sandbox per prior-session OOM note) |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| PRXY-01 | `tools/list` returns only lease-scoped tools; unbound tool call denied | unit/integration | `vitest run test/server.test.ts -t "tools/list"` | ❌ Wave 0 |
| PRXY-04 | Concurrent calls never exceed `actions_per_hour`/`max_actions`/`spend` | integration (concurrency) | `vitest run test/concurrency.test.ts` | ❌ Wave 0 |
| PRXY-05 | Approval held via HostAdapter, bound to commitment hash; drifted args denied; timeout denies | unit/integration | `vitest run test/approvals.test.ts` | ❌ Wave 0 |
| PRXY-06 | No token in any agent-facing response/error (adversarial) | integration (`InMemoryTransport` + real `Client`) | `vitest run test/vault-secretless.test.ts` | ❌ Wave 0 |
| PRXY-07 | `invalid_grant`/401-after-failed-refresh → `revoked` (actor `provider`) | integration (`oauth2-mock-server` + `Events.BeforeResponse`) | `vitest run test/revocation-detection.test.ts` | ❌ Wave 0 |
| PRXY-08 | Concurrent refreshes of one credential → exactly one refresh request | integration (hit-counting hook against `oauth2-mock-server`) | `vitest run test/refresh-single-flight.test.ts` | ❌ Wave 0 |
| RCPT-01 | Every call (allowed/denied/errored) appends exactly one receipt | unit/integration | `vitest run test/call-receipts.test.ts` | ❌ Wave 0 |
| LIC-05 | License token never forwarded to a customer resource (tested) | integration (assert `OutboundConnector.execute`'s credential arg never carries license shape) | `vitest run test/license-secretless.test.ts` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `npx --yes pnpm@12.6.0 --filter @stint/proxy test`
- **Per wave merge:** `npx --yes pnpm@12.6.0 --filter @stint/proxy test && npx --yes pnpm@12.6.0 --filter @stint/core test`
- **Phase gate:** Full suite green before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `packages/proxy/test/server.test.ts` — covers PRXY-01
- [ ] `packages/proxy/test/concurrency.test.ts` — covers PRXY-04
- [ ] `packages/proxy/test/approvals.test.ts` — covers PRXY-05
- [ ] `packages/proxy/test/vault-secretless.test.ts` — covers PRXY-06, LIC-05
- [ ] `packages/proxy/test/revocation-detection.test.ts` — covers PRXY-07
- [ ] `packages/proxy/test/refresh-single-flight.test.ts` — covers PRXY-08
- [ ] `packages/proxy/test/call-receipts.test.ts` — covers RCPT-01
- [ ] `packages/proxy/package.json` — add `@modelcontextprotocol/sdk`, `oauth4webapi` as dependencies and `oauth2-mock-server` as a devDependency; bump `engines.node` to `>=22.18.0` (see State of the Art)

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes | Delegated OAuth 2.1 via `oauth4webapi`; never hand-rolled token handling |
| V3 Session Management | yes | Per-lease `Server` instance (D-10) is the session boundary; no session identifier the agent can use to address another lease |
| V4 Access Control | yes | `evaluatePolicy` (existing, `@stint/core`) is the sole decision point; proxy never re-implements access checks |
| V5 Input Validation | yes | Tool call `arguments` validated against the runtime-owned catalog's JSON Schema before dispatch (Ajv, already a project dependency) |
| V6 Cryptography | yes (via existing modules) | Approval/receipt hashing reuses `@stint/spec`'s `canonicalize`/`hashCanonical` (RFC 8785 JCS + SHA-256) — no new crypto primitive introduced by this phase |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Confused deputy / token passthrough (agent tricks proxy into forwarding a real credential) | Elevation of Privilege | D-01/D-02: port receives the raw credential but the agent-facing boundary never does; MCP Authorization spec (2026-07-28) states the identical principle normatively — "MCP servers MUST NOT accept or transit any other tokens" applied here to the proxy-as-OAuth-client leg |
| TOCTOU between approval and execution | Tampering | D-11's content-addressed commitment hash over resolved args + binding + lease version, recomputed and exact-matched at execution |
| Refresh-token rotation race causing spurious full-credential loss | Denial of Service | Single-flight refresh per credential (PRXY-08) — verified this session that the mock server has no natural reuse-detection to catch a bug here, so tests must assert request *count*, not just absence of error |
| Secrets leaking through thrown errors from OAuth/HTTP libraries | Information Disclosure | D-02's scrubber wraps every `OutboundConnector.execute` call; `ResponseBodyError`'s `.cause`/`.response` fields (confirmed to carry the full parsed JSON error body) must never be forwarded unmodified into a `tools/call` error result |
| Tool-poisoning / rug-pull via a live-fetched or manifest-declared tool schema | Spoofing / Tampering | D-08: `tools/list` is computed exclusively from the runtime-owned catalog × `BindingSet`, never from the manifest or any downstream server's live schema |

## Sources

### Primary (HIGH confidence)
- `@modelcontextprotocol/sdk@1.30.1` — installed and inspected directly this session: `dist/esm/server/index.d.ts` (Server class + `@deprecated` note), `dist/esm/server/mcp.d.ts` (`McpServer.registerTool`), `dist/esm/server/zod-compat.d.ts` (`AnySchema` = Zod-only), `dist/esm/types.d.ts` (`ToolSchema`, `CallToolRequestSchema`, `CallToolResultSchema`), `dist/esm/inMemory.d.ts` (`InMemoryTransport`), `package.json` (transitive `ajv@^8.17.1`, `jose@^6.1.3`).
- `oauth4webapi@3.8.8` — installed and inspected directly this session: `build/index.d.ts` (`refreshTokenGrantRequest`, `revocationRequest`, `processRevocationResponse`, `TokenEndpointRequestOptions.additionalParameters`, `allowInsecureRequests`, `ResponseBodyError`); exercised hands-on end-to-end against a live `oauth2-mock-server` instance (full transcript below).
- `oauth2-mock-server@9.2.0` — installed and inspected directly this session: `README.md` ("Always returns 200 per RFC 7009"), `dist/oauth2-server-BKcc5jqv.mjs` source (`revokeHandler` unconditional 200, `tokenHandler`'s grant-type switch, `grantsIssuingIdToken` including `refresh_token`, hardcoded `id_token_signing_alg_values_supported: ["RS256"]`).
- `packages/core/src/*.ts`, `packages/proxy/src/index.ts`, `packages/proxy/package.json`, `packages/core/package.json`, `packages/core/src/index.ts`, `packages/core/src/testing.ts` — read directly this session.
- `spec/ALP.md` — sections 7-14 read directly this session (states, actors, events, transition table, auth modes, enforcement, teardown, receipts, trust model/limits, security considerations).
- `packages/spec/src/generated/manifest.ts` — read directly this session (`Access`, `ApprovalTrigger`, `Limits`, `ErrorThreshold`, `Approvals` types).
- https://modelcontextprotocol.io/specification/versioning — fetched this session; confirmed current spec version is `2026-07-28`.
- https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization — fetched this session; full normative text on resource-parameter/token-passthrough/STDIO-opt-out.
- https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization — fetched this session for diff comparison against the current version.

### Secondary (MEDIUM confidence)
- CLAUDE.md's own "Technology Stack" section — cross-checked (npm registry versions matched exactly this session); the `registerTool`/`AnySchema` claim did NOT hold up under this session's direct `.d.ts` inspection and is corrected in `## State of the Art`.

### Tertiary (LOW confidence)
- None — every claim in this document is either read from an installed package's source/`.d.ts`, read from this repo's existing code/spec, fetched from the official MCP spec site, or exercised hands-on this session.

## Hands-On Verification Log

Full session transcript (executed via `node test-oauth.mjs` against `oauth4webapi@3.8.8` + `oauth2-mock-server@9.2.0` installed in a scratch directory):

```
Issuer URL: http://localhost:58802
Discovered revocation_endpoint: http://localhost:58802/revoke
Discovered token_endpoint: http://localhost:58802/token

--- Refresh grant result ---
access_token (truncated): eyJ0eXAiOiJKV1QiLCJr...
new refresh_token: 05480398-ebec-4aa2-aeb5-1b22936261fa
Captured request body sent to mock AS: {
  resource: 'https://api.paystack.example/v1',
  refresh_token: 'seed-refresh-token',
  grant_type: 'refresh_token',
  client_id: 'stint-test-client'
}
Did the request body include resource=https://api.paystack.example/v1 ? true

--- Revocation response ---
status: 200
processRevocationResponse result (undefined = success per spec): undefined

--- Second refresh with the SAME (never-really-revoked) refresh token ---
Did it succeed despite "revocation"? true

--- Step 4: forced invalid_grant via BeforeResponse hook ---
Threw as expected. err.constructor.name: ResponseBodyError
err.error: invalid_grant
err.code: OAUTH_RESPONSE_BODY_ERROR
err instanceof oauth.ResponseBodyError: true
```

This transcript is the primary evidence behind: RFC 8707 `resource` transmission (step 1), RFC 7009 revocation call shape (step 2), the mock server's `/revoke` no-op behavior (step 3, Pitfall 5/2), and the D-09 revocation-signal classifier's expected exception shape (step 4, Pattern 4).

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all three new packages' versions confirmed live against the npm registry this session and match CLAUDE.md's existing pins exactly.
- Architecture: HIGH — Patterns 1-4 either reuse already-built, already-tested `@stint/core` surface (read directly this session) or were exercised hands-on this session (OAuth flows).
- Pitfalls: HIGH — all six pitfalls in this document were either directly triggered and observed in this session (allowInsecureRequests, algorithm mismatch, RS256/alg mismatch) or confirmed by reading the mock server's actual source code (the `/revoke` no-op, the lack of refresh-token reuse detection).

**Research date:** 2026-09-28
**Valid until:** 30 days (stable, pinned-version stack; re-verify if any of the three new package versions are bumped, or if the MCP spec advances past 2026-07-28 before planning executes)
