# Phase 4: MCP Proxy & Credential Vault - Context

**Gathered:** 2026-09-28
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 4 delivers `@stint/proxy` — the **live trust boundary** that wires the pure Phase 2/3 decision logic to real I/O. It is the Policy Enforcement Point (PEP): a thin dispatcher that owns all side effects and never contains policy logic itself.

It delivers:

1. **Agent-facing MCP server** (`@modelcontextprotocol/sdk` `Server`) that lists only the tools the lease permits (`tools/list` filtered to scoped, bound tools) and intercepts every `tools/call`, routing each through core's pure `evaluatePolicy` (PRXY-01).
2. **Per-lease serialization + limit enforcement** so concurrent calls never exceed `actions_per_hour`, the total action cap, or the `spend` limit; per-credential single-flight refresh (PRXY-04, PRXY-08).
3. **Out-of-band approvals** for `send`/`pay`/`irreversible`, held through the HostAdapter, bound to a content-addressed hash so a call whose args/binding/lease-version drifted after approval is denied; unanswered → deny on timeout (PRXY-05).
4. **Credential vault** that injects OAuth access tokens (with RFC 8707 resource indicators) only on outbound calls, never leaks a token to any agent-facing response or error, and holds the publisher license without ever forwarding it to a customer resource (PRXY-06, LIC-05).
5. **Lazy customer-side revocation detection** — an `invalid_grant`/401-after-failed-refresh moves the lease to `revoked` (actor `provider`) (PRXY-07).
6. **Per-call receipts** — exactly one verified-chain receipt per call (allowed/denied/errored), args-hash + binding-redacted summary only (RCPT-01).

**Not in this phase:** initial OAuth grant acquisition (auth-code + PKCE / consent redirect) — deferred to CLI (Phase 6) / example (Phase 7), entered here via a vault seed seam; teardown / OAuth revocation *execution* + entitlement revocation → `revoked` actor `publisher` (LIC-04, TEAR-\* — Phase 5); outcome verification (LIFE-06 — Phase 5); the JSON-file `LeaseStore`/`ReceiptStore` with Windows atomicity (Phase 6); CLI HostAdapter reference impl (Phase 6).

Requirements: PRXY-01, PRXY-04, PRXY-05, PRXY-06, PRXY-07, PRXY-08, RCPT-01, LIC-05.

</domain>

<decisions>
## Implementation Decisions

Decisions below are what this discussion resolved. Decisions already locked upstream (PROJECT.md ## Context, research docs, prior CONTEXT.md) are listed under "Locked upstream — do not re-litigate" and are binding but not re-derived here.

### Downstream call surface (the vault's outbound path)
- **D-01:** The vault reaches downstream resources through an **abstract `OutboundConnector` port** in `@stint/proxy` (`execute(binding, resolvedArgs, credential) → result`). The port implementation is where transport (HTTP/REST, or future real MCP client) lives; Phase 4 ships the port + at least one reference impl, Phase 7 supplies mocks. Keeps the vault and enforcement path transport-agnostic and adversarially testable with no live network. — **Reversibility:** costly — the port is the seam the example (Phase 7) and any real connector implement against; changing its shape ripples into every connector impl.
- **D-02:** **The port receives the raw credential.** The vault resolves the token and passes it into `execute(...)`; the port attaches it (header/param) and makes the call. The vault **wraps the port call in the credential scrubber**, so any thrown error or echoed request is stripped of token material before it can propagate. The **port implementation is trusted-boundary code**; the untrusted boundary is the agent-facing `Server` response/error path, where the adversarial "token never leaks" test is aimed. — **Reversibility:** costly — the trust-boundary framing (port trusted, agent-facing untrusted) is what the LIC-05/PRXY-06 secretless tests assert against.

### OAuth grant lifecycle scope
- **D-03:** Phase 4 owns the **runtime hot path only**: outbound injection with RFC 8707 resource indicators, per-credential single-flight refresh, and lazy `invalid_grant`/401 revocation detection. The **initial auth-code + PKCE acquisition / consent flow is out of scope** for Phase 4 (deferred to CLI/example wiring). Matches the roadmap's Phase 4 success criteria exactly.
- **D-04:** Tokens enter the vault via a **narrow "load/seed credential" seam** (`leaseId + resource → { accessToken, refreshToken, expiry, tokenEndpoint, resourceIndicator }`) that both Phase 4 tests and the future acquisition flow use. **Refresh is real**: `oauth4webapi`'s refresh-token grant against `oauth2-mock-server`, with the RFC 8707 `resource` on the request, so single-flight refresh and `invalid_grant` detection are exercised end-to-end without the interactive redirect. This satisfies the roadmap's Phase 4 hands-on RFC 7009/8707 research flag. — **Reversibility:** costly — the seed seam shape is what Phase 6/7 acquisition wiring targets.

### Limit enforcement (PRXY-04)
- **D-05:** `actions_per_hour` uses a **sliding 60-minute window via per-action timestamps** (deny `over_actions_per_hour` if the count within `[now-3600s, now]` would exceed the limit), reusing the exact `denialErrorTimestamps` pattern already in `LeaseCounters`. No fixed-bucket burst loophole. Prune aged-out timestamps.
- **D-06:** Enforcement counters (the new action-timestamp list, `actionCount`, `spentMinor`) live **in the lease snapshot**, mutated as part of each call's serialized read-modify-write through the `LeaseStore`, under the existing per-lease serializer. Counters survive restart and are the single source of truth. **Requires a small additive change to `@stint/core`'s `LeaseCounters`** to carry the per-action timestamps `actions_per_hour` needs (core left this counter unbuilt — see `policy.ts` note that `over_actions_per_hour`'s counter "isn't part of the `LeaseCounters` aggregate this phase built"). — **Reversibility:** costly — additive change to a core type consumed by policy + receipts; keep it additive.
- **D-07:** A `pay` call's **amount + currency (minor units) is extracted pre-authorization from resolved args per a runtime-owned, binding-declared amount source** (the `ConnectorBinding` for a pay-capable tool declares which arg holds the amount/currency). The proxy passes it as `PolicyCall.spendMinor` to `evaluatePolicy` **before** the call executes, so the cap is enforced ahead of spending, never after the fact. Runtime-owned, so a publisher cannot hide or misreport the amount. — **Reversibility:** costly — extends the runtime-owned binding shape.

### Agent-facing tool schemas (PRXY-01)
- **D-08:** A **runtime-owned tool catalog** supplies the agent-facing MCP tool definitions (name, description, `inputSchema`) for `tools/list`, **paired with** (not merged into) the `ConnectorBinding`. `tools/list` is computed by filtering the catalog to the lease's scoped, bound tools. `@stint/core`'s `ConnectorBinding` **stays minimal** (classification only: `tool, resource, access, irreversible, provenance`) — MCP presentation concerns live in the proxy-owned catalog. Nothing agent- or publisher-supplied, and nothing fetched live from downstream, drives the agent-facing surface (keeps the tool-poisoning / rug-pull boundary absolute). — **Reversibility:** costly — the catalog↔binding pairing is what PRXY-01 filtering and the runtime-owned invariant depend on.

### Upstream error classification
- **D-09:** **Narrow revocation signal, everything else → error threshold.** Only a documented signal set counts as provider revocation → `revoked` (actor `provider`): OAuth `invalid_grant`, or a 401/403 that persists after a **single-flight refresh attempt also fails** with `invalid_grant`. All other upstream failures (5xx, timeouts, network errors, non-auth 4xx) count toward the LIFE-07 error threshold (each appends a denied/error receipt; N-in-window → `failed`, actor `policy`). A single transient blip never revokes. This is the clean interaction with the refresh-race pitfall: a 401 first triggers refresh; only a failing refresh is revocation. — **Reversibility:** costly — the signal→outcome mapping is what the PRXY-07 vs LIFE-07 tests assert.

### Session → lease binding
- **D-10:** **One proxy `Server` instance per lease.** The proxy is constructed for a specific `leaseId`; the lease is fixed by instantiation, never a call parameter, so the agent can never name or switch leases. `tools/list` and every `tools/call` resolve against that one lease. Multi-lease multiplexing is a v2 concern. — **Reversibility:** costly — a later multi-lease proxy would change the construction API and session model.

### Approval commitment (TOCTOU-safe, PRXY-05)
- **D-11:** The approval hash covers **canonicalize(resolved args) + binding identity (tool + provenance/version) + lease version**, computed via the **existing `@stint/spec` canonical serializer** (the same one receipts use — no new serializer). The pending-approval record stores that hash; at execution the proxy **recomputes and requires an exact match**, else the call is a *new* request requiring new approval (the reused approval is denied). Covers all three documented drift vectors: arg drift, binding hot-swap, mid-flight lease mutation. The core `awaitApprovalDecision` (Phase 2 D-17) remains the only sanctioned way to call `requestApproval`; the proxy arms the actual timeout/`AbortSignal`. — **Reversibility:** costly — the hash-input set is the PRXY-05 / TOCTOU test contract.

### Binding + catalog authorship
- **D-12:** The runtime-owned tool catalog + `BindingSet` are **injected at proxy construction** (platform/runtime-owned, never the manifest). `@stint/proxy` also **ships built-in catalogs/bindings** for the example's known connectors (Paystack, Sheets), which a platform can pass through or extend. User-approved custom bindings use the existing `user_approved_custom` provenance already on `ConnectorBinding`. — **Reversibility:** reversible — construction-parameter shape, local to proxy setup.

### Receipt emission (RCPT-01)
- **D-13:** **Exactly one verified-chain outcome receipt per `tools/call`**, recording the final outcome (allowed + result summary, denied + reason, or errored + reason), written in a **guaranteed `finally`/settled path** so even a thrown mid-call error still produces a receipt. Denied calls receipt too. The append happens **inside the per-lease serializer** so chain order matches call order. Summary is binding-redacted (`argsHash` + `redactedSummary` only) and secretless by type (Phase 3 D-16). Uses the existing `appendEntry` over the `ReceiptStore` (in-memory now; JSON impl Phase 6). — **Reversibility:** costly — "exactly one honest receipt per call, secretless" is the RCPT-01 acceptance contract.

### Locked upstream — do not re-litigate
These are binding from PROJECT.md ## Context, the research docs, and prior CONTEXT.md; the proxy conforms, it does not re-decide them:
- **PEP/PDP split** — proxy is a thin dispatcher; all decisions come from core's pure `evaluatePolicy`. No policy/`if(scope…)` logic in the transport layer (ARCHITECTURE Pattern 1 / Anti-Pattern 1).
- **Bindings runtime-owned, never manifest** — nothing in `@stint/proxy` reads `access`/`resource` from manifest JSON for enforcement (PITFALL 1, PRXY-03; spec §9).
- **Dual-server topology** — agent-facing `Server` + downstream `Client`/port per connector (ARCHITECTURE Pattern 2).
- **Approvals out-of-band through HostAdapter only** — never MCP elicitation through the agent's client; timeout defaults to deny (Anti-Pattern 3; Phase 2 D-17).
- **Vault injection-without-exposure** — token never returned to the agent by construction; error scrubbing at the vault boundary (ARCHITECTURE Pattern 3, PITFALL 2/8).
- **`HeldLicense` opaque type + `readLicenseToken` single accessor** — license never to agent, never to customer resource (Phase 3 D-15, LIC-05).
- **Per-lease serialization mutex** keyed by `leaseId`; cross-lease stays concurrent (ARCHITECTURE Pattern 7).
- **Per-credential single-flight refresh** — callers await an in-flight refresh; never two redemptions of one refresh token (PITFALL 6, PRXY-08).
- **Per-call expiry, injectable clock, no timers; no cached "still valid" boolean** (PITFALL 10).

### Claude's Discretion
- Exact TypeScript names/module layout in `@stint/proxy` (`server.ts`, `vault/`, `connectors/` or `outbound/`, `concurrency/`, `oauth/`, `bindings.ts`, tool catalog) per ARCHITECTURE's suggested structure.
- The precise additive field name/shape added to core `LeaseCounters` for action timestamps (D-06), provided it is additive and the serialized read-modify-write stays correct.
- The `OutboundConnector` port's exact signature and the reference impl's transport (D-01), provided credential handling matches D-02.
- The seed-seam signature (D-04) and the pending-approval record's storage location (D-11), provided the invariants hold.
- Exact `redactedSummary` contents (D-13) and stable reason strings for denied/errored receipts, provided no secret/raw-arg can appear by type.
- How the binding declares the pay amount/currency source (D-07) — field name/shape on the binding or catalog entry.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Protocol (normative — code MUST match)
- `spec/ALP.md` §9 — connector bindings are runtime-owned; the runtime never derives a binding from manifest content
- `spec/ALP.md` §7.x — lease states/transitions and actor list; `revoked` (actor `provider`), `failed` (actor `policy`), agent never an ending/extending actor
- `spec/ALP.md` §8 — hosted-license claims + implicit assertion (license held, never forwarded — LIC-05)
- `spec/ALP.md` §11 — receipts: dual chains, args-hash + redacted-summary only, verified-chain per-call entries (RCPT-01)
- `spec/ALP.md` §5 — canonical serialization (RFC 8785 JCS) reused for the approval commitment hash (D-11)
- `spec/ALP.md` §13 — trust limits: offline license revocation is TTL-bounded (surface in UX later)
- `spec/ALP.md` §14 — security: secrets never in errors/logs/receipts; token passthrough forbidden; explicit clock-skew, re-check per call

### Project scope & requirements
- `.planning/PROJECT.md` — ## Context (runtime-owned bindings, out-of-band approvals, secretless vault, lazy revocation detection, multi-grant lease semantics), ## Constraints
- `.planning/REQUIREMENTS.md` — PRXY-01, PRXY-04..08, RCPT-01, LIC-05 acceptance text (and PRXY-02/03 already-built policy surface)
- `.planning/ROADMAP.md` §Phase 4 — success criteria + research flag (oauth4webapi RFC 7009/8707 hands-on vs oauth2-mock-server; pin MCP Authorization spec; confirm `@modelcontextprotocol/sdk@1.30.1` dual server/client topology)

### Research (read before planning)
- `.planning/research/ARCHITECTURE.md` — Patterns 1 (PEP/PDP), 2 (dual-server), 3 (credential vault), 7 (per-lease serialization); Tool Call / Approval / Lease-End data flows; suggested `@stint/proxy` structure; build order steps 7–9
- `.planning/research/PITFALLS.md` — Pitfall 1 (binding trust source), 2 (confused deputy / token passthrough), 3 (TOCTOU approval→execution), 5 (RFC 7009 silent no-op), 6 (refresh-token rotation race), 8 (secrets in errors/receipts), 10 (expiry/time). "Looks Done But Isn't" checklist + Pitfall-to-Phase mapping
- `.planning/research/STACK.md`, `.planning/research/FEATURES.md`, `.planning/research/SUMMARY.md`

### Prior phase context
- `.planning/phases/02-lease-state-machine-policy-engine/02-CONTEXT.md` — `evaluatePolicy`, `ConnectorBinding`/`BindingSet`, `LeaseCounters`, `HostAdapter`/`awaitApprovalDecision` (D-17), `LeaseStore` contract + `@stint/core/testing` double
- `.planning/phases/03-receipts-licensing/03-CONTEXT.md` — `appendEntry`/`verifyChain`/`signCheckpoint`, `ReceiptStore` double, `HeldLicense`/`readLicenseToken` (D-15), `needsRefresh`/`clampedLicenseExpiry`, secretless-by-type receipt inputs (D-16)

### Stack & existing code
- `.claude/CLAUDE.md` — pinned versions: `@modelcontextprotocol/sdk@1.30.1`, `oauth4webapi@3.8.8`, `oauth2-mock-server@9.2.0`, `paseto@4.0.1`, `jose@6.2.12`; TS 5.9.3 strict, ESM-only, Node 22.18+
- `packages/core/src/index.ts` — the full `@stint/core` public surface the proxy consumes (policy, bindings, host-adapter, lease-store, license, receipts)
- `packages/core/src/policy.ts` — `evaluatePolicy`, `PolicyCall` (`spendMinor`), `POLICY_REASON_CODES` (incl. unbuilt `over_actions_per_hour`), `checkErrorThreshold`
- `packages/core/src/lease.ts` — `LeaseCounters` (the additive-change target for D-06)
- `packages/core/src/bindings.ts` — `ConnectorBinding`/`BindingSet`/`BindingProvenance` (extension target for D-07)
- `packages/core/src/host-adapter.ts` — `ApprovalRequest`/`ApprovalDecision`/`awaitApprovalDecision`
- `packages/proxy/` — current stub (`src/index.ts`, `test/smoke.test.ts`) to build out

### External standards
- RFC 8707 (resource indicators), RFC 7009 (token revocation) — via `oauth4webapi`; MCP Authorization spec (pin current text per research flag); RFC 8785 (JCS) via `@stint/spec`

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `@stint/core` `evaluatePolicy` + `PolicyCall`/`ApprovalRequirement`/`PolicyDecision` — the pure PDP the proxy calls per `tools/call`; the proxy adds nothing but I/O around it.
- `@stint/core` `ConnectorBinding`/`BindingSet`/`resolveBinding`/`createBindingSet` — runtime-owned classification the proxy pairs with its tool catalog (D-08) and extends for pay-amount source (D-07).
- `@stint/core` `LeaseCounters` (`actionCount`, `spentMinor`, `denialErrorTimestamps`) + `checkErrorThreshold` — enforcement counters home (D-06), with an additive timestamp field for `actions_per_hour`.
- `@stint/core` `awaitApprovalDecision` (deny-by-default, `AbortSignal`-driven) + `HostAdapter`/`ApprovalRequest`/`ApprovalDecision` — the only sanctioned approval path; proxy arms the timeout (D-11).
- `@stint/core` `HeldLicense`/`readLicenseToken`, `needsRefresh`, `clampedLicenseExpiry`, `verifyLicense` — license custody + refresh decision for the vault.
- `@stint/core` `appendEntry`/`verifyChain` + `ReceiptStore` (in-memory double in `@stint/core/testing`) — per-call receipt emission (D-13).
- `@stint/spec` `canonicalize`/`hashCanonical` — the single serializer for the approval commitment hash (D-11); no new serializer.
- `@stint/core/testing` `LeaseStore`/`ReceiptStore` doubles + contract-test factories — used for Phase 4 tests without the Phase 6 JSON impls.

### Established Patterns
- ESM-only, TS strict, project references (`composite: true`), `workspace:*` linking; `spec → core → proxy/cli`.
- Result-not-throw for pure functions; stable machine-readable code enums (policy reasons, verify reasons) for host/CLI consumption.
- Injectable clock, no timers, deterministic tests (the proxy arms real timers/`AbortSignal`s; core stays timerless).
- Runtime-owned enforcement inputs; nothing publisher/manifest/downstream-supplied drives authorization or the agent-facing surface.
- `@stint/core/testing` never re-exported from the public entry — testing utilities stay testing-only.

### Integration Points
- `@stint/proxy` imports `@stint/core` (pure decisions) and `@stint/spec` (serializer) — no new hashing, no policy logic in transport.
- Proxy owns all I/O: agent-facing MCP `Server`, the `OutboundConnector` port (D-01), the credential vault, `oauth4webapi` refresh (D-04), per-lease serializer + counters (D-06), receipt appends (D-13).
- The `OutboundConnector` port (D-01) and vault seed seam (D-04) are the seams Phase 7's example (and Phase 6 CLI/acquisition) implement against.
- Provider-revocation *detection* here (D-09, PRXY-07) feeds Phase 5 teardown (revocation *execution*, LIC-04/TEAR-\*).

</code_context>

<specifics>
## Specific Ideas

- The `OutboundConnector` port makes the whole enforcement path adversarially testable with no live network — the "token never leaks to the agent" test targets the agent-facing `Server` boundary, with the port impl explicitly inside the trust boundary (D-01/D-02).
- Refresh is genuinely exercised (`oauth4webapi` refresh grant vs `oauth2-mock-server`, RFC 8707 `resource` on the request), even though interactive acquisition is deferred — this is what discharges the roadmap's Phase 4 research flag (D-04).
- Sliding-window rate limiting reuses the exact timestamp-list pattern already proven for the error threshold in `LeaseCounters` (D-05/D-06).
- Pay amount is enforced *before* the call, extracted per a runtime-owned binding-declared source, so a publisher can't understate a charge and the cap can't be blown by the tripping call (D-07).
- One `Server` per lease means the agent literally cannot address another lease — the safest v0.1 shape (D-10).
- The approval commitment hash reuses the `@stint/spec` canonical serializer, closing all three TOCTOU drift vectors (D-11).
- Exactly one guaranteed receipt per call via a `finally` path, appended inside the per-lease serializer so chain order = call order (D-13).

</specifics>

<deferred>
## Deferred Ideas

- Initial OAuth grant acquisition (auth-code + PKCE, consent redirect, AS discovery) that seeds the vault — CLI (Phase 6) / example (Phase 7), against the D-04 seed seam.
- OAuth revocation *execution*, license invalidation, cleanup hook, and entitlement revocation → `revoked` (actor `publisher`) — Phase 5 teardown (LIC-04, TEAR-\*). Phase 4 only *detects* provider-side revocation.
- Outcome verification (`resource_query` predicate through the proxy, `user_confirm`) — Phase 5 (LIFE-06).
- JSON-file `LeaseStore`/`ReceiptStore` with NTFS-atomic writes + locking (concurrent counters persist correctly on Windows) — Phase 6 (HOST-03), run against the Phase 2/3 contract suites.
- CLI reference HostAdapter rendering approvals in the terminal with plain-language "this will send $X to Y" summaries derived from the binding — Phase 6 (HOST-02).
- Multi-lease proxy multiplexing (session→lease mapping) — v2.
- Real downstream MCP `Client` connectors (vs the mock/REST reference impl) behind the `OutboundConnector` port — post-v0.1.

None of the above were re-scoped into Phase 4; discussion stayed within the phase boundary.

</deferred>

---

*Phase: 04-mcp-proxy-credential-vault*
*Context gathered: 2026-09-28*
