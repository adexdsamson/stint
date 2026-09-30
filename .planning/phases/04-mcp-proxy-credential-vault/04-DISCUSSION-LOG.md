# Phase 4: MCP Proxy & Credential Vault - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-09-28
**Phase:** 04-mcp-proxy-credential-vault
**Areas discussed:** Downstream call surface, OAuth lifecycle scope, Limit enforcement, Agent tool schemas, Upstream error classification, Session→lease binding, Approval arg-hash mechanics, Binding/catalog authorship, Receipt emission timing

---

## Area selection

The user was presented four candidate gray areas (Downstream call surface, OAuth lifecycle scope, Limit enforcement, Agent tool schemas) and selected **all four**. After those completed, the user chose to explore Upstream error classification, then a further four (Session→lease binding, Approval arg-hash mechanics, Binding/catalog authorship, Receipt emission timing) — all selected. Nine areas total.

---

## Downstream call surface

| Option | Description | Selected |
|--------|-------------|----------|
| Abstract OutboundConnector port | Interface `execute(binding, args, credential)`; transport lives in the impl; Phase 4 ships port + reference impl, Phase 7 mocks | ✓ |
| Generic HTTP/REST outbound | Vault does a real `fetch()` with injected header; bakes HTTP into the proxy | |
| Real MCP Client per connector | `@modelcontextprotocol/sdk` Client per downstream MCP server; forces mock-MCP-servers in tests | |

**User's choice:** Abstract OutboundConnector port.
**Notes:** Follow-up on injection boundary — user chose **"Port receives the raw credential"**: vault resolves the token, passes it into the port, port attaches and calls; vault wraps the call in the scrubber; port impl is trusted-boundary code, agent-facing response path is the untrusted side.

---

## OAuth lifecycle scope

| Option | Description | Selected |
|--------|-------------|----------|
| Inject / refresh / detect-revoke only | Hot path against pre-seeded tokens; acquisition deferred | ✓ |
| Full acquisition flow too | Also implement auth-code + PKCE acquisition in Phase 4 | |
| You decide | Defer boundary to planning | |

**User's choice:** Inject / refresh / detect-revoke only.
**Notes:** Follow-up on the resulting seams — user chose **"Seed via a vault-load seam; refresh via oauth4webapi"**: narrow seed seam for tokens; real `oauth4webapi` refresh-token grant against `oauth2-mock-server` with RFC 8707 resource, discharging the roadmap's Phase 4 research flag.

---

## Limit enforcement

Three sub-decisions.

### Rate window
| Option | Description | Selected |
|--------|-------------|----------|
| Sliding 60-min window via timestamps | Deny if count in `[now-3600s, now]` exceeds limit; reuses `denialErrorTimestamps` pattern | ✓ |
| Fixed hourly bucket | Resets each clock hour; allows 2x burst at boundary | |
| You decide | | |

### Counter home
| Option | Description | Selected |
|--------|-------------|----------|
| In the lease snapshot, mutated under the per-lease serializer | Extend `LeaseCounters`; survives restart; single source of truth | ✓ |
| Proxy in-memory only | Map in the proxy; resets on restart | |
| You decide | | |

### Spend amount
| Option | Description | Selected |
|--------|-------------|----------|
| Binding declares how to extract amount+currency | Runtime-owned binding declares the amount arg; extracted pre-authorization | ✓ |
| Proxy computes spend post-response | Read charged amount after the call; enforcement after-the-fact | |
| You decide | | |

**User's choice:** Sliding window; counters in lease snapshot (additive `LeaseCounters` change); binding-declared pre-authorization amount extraction.
**Notes:** Core's `policy.ts` documents that `over_actions_per_hour`'s counter was intentionally left unbuilt for Phase 4 to add.

---

## Agent tool schemas

| Option | Description | Selected |
|--------|-------------|----------|
| Runtime-owned tool catalog, paired with bindings | Catalog carries name/description/inputSchema; `tools/list` filters it; core `ConnectorBinding` stays minimal | ✓ |
| Extend ConnectorBinding itself | Add description/inputSchema onto the core type | |
| Derive from downstream tool schemas | Fetch + re-expose; lets downstream metadata influence the agent surface (tool-poisoning risk) | |

**User's choice:** Runtime-owned tool catalog, paired with bindings.

---

## Upstream error classification

| Option | Description | Selected |
|--------|-------------|----------|
| Narrow revocation signal, everything else → threshold | Only `invalid_grant` / 401-403-after-failed-refresh → revoked; all else → LIFE-07 threshold | ✓ |
| Any auth-shaped error → revoked | Any 401/403 immediately revokes | |
| You decide | | |

**User's choice:** Narrow revocation signal.
**Notes:** A 401 first triggers a single-flight refresh; only a failing refresh (`invalid_grant`) is revocation — the clean interaction with the refresh-race pitfall.

---

## Session→lease binding

| Option | Description | Selected |
|--------|-------------|----------|
| One proxy Server instance per lease | Lease fixed at construction; never a call parameter; agent cannot switch leases | ✓ |
| Multi-lease proxy with session mapping | Map each session/transport to a leaseId server-side | |
| You decide | | |

**User's choice:** One proxy Server instance per lease.

---

## Approval arg-hash mechanics

| Option | Description | Selected |
|--------|-------------|----------|
| Canonical args + binding identity + lease version | Hash via `@stint/spec` serializer; recompute + exact-match at execution; covers all three drift vectors | ✓ |
| Args + lease version only | Omits binding identity; leaves binding-swap drift open | |
| You decide | | |

**User's choice:** Canonical args + binding identity + lease version.

---

## Binding/catalog authorship

| Option | Description | Selected |
|--------|-------------|----------|
| Injected at construction, with shipped built-ins available | Catalog + BindingSet passed at construction; ships built-ins for example connectors; custom via `user_approved_custom` | ✓ |
| Hardcoded built-ins only | Fixed built-in catalog; no injection seam | |
| You decide | | |

**User's choice:** Injected at construction, with shipped built-ins available.

---

## Receipt emission timing

| Option | Description | Selected |
|--------|-------------|----------|
| One outcome receipt after resolution, guaranteed via finally | Exactly one verified-chain receipt per call (allowed/denied/errored), in a `finally` path, inside the serializer | ✓ |
| Two-phase: decision receipt + outcome receipt | Receipt at decision + at outcome; doubles chain volume | |
| You decide | | |

**User's choice:** One outcome receipt after resolution, guaranteed via finally.

---

## Claude's Discretion

- Exact TypeScript names / module layout in `@stint/proxy`.
- Additive field name/shape for action timestamps on core `LeaseCounters`.
- `OutboundConnector` port signature and reference-impl transport.
- Vault seed-seam signature and pending-approval record storage location.
- Exact `redactedSummary` contents and stable denied/errored reason strings.
- Binding-declared pay amount/currency field name/shape.

## Deferred Ideas

- Initial OAuth grant acquisition (auth-code + PKCE, consent redirect) — Phase 6/7.
- OAuth revocation execution, license invalidation, cleanup hook, entitlement revocation → `revoked` (actor `publisher`) — Phase 5.
- Outcome verification (LIFE-06) — Phase 5.
- JSON-file `LeaseStore`/`ReceiptStore` with Windows atomicity — Phase 6.
- CLI reference HostAdapter with plain-language approval summaries — Phase 6.
- Multi-lease proxy multiplexing — v2.
- Real downstream MCP Client connectors behind the port — post-v0.1.
