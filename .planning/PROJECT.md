# Stint

## What This Is

Stint is an open spec, the Agent Lease Protocol (ALP), plus a TypeScript SDK for the human-facing lifecycle of specialist AI agents: install, run a scoped job, and uninstall cleanly. It sits on top of MCP and OAuth 2.1 and fills the gap they leave out of scope: user consent, revocation, and uninstall. It serves two audiences equally: platform builders who host agent communities and embed the runtime with their own UX, and agent publishers who ship specialist agents with manifests, licenses and attested receipts.

The core mechanism is a lease runtime that runs as an MCP proxy between the agent and every system it touches. The agent never holds real credentials. Every tool call is checked against the lease by code outside the model, so a prompt-injected agent still cannot exceed its lease.

## Core Value

A prompt-injected or misbehaving agent can never act outside the lease the user granted, and when the lease ends, for any reason, every credential is revoked and the teardown is honestly receipted.

## Requirements

### Validated

(None yet, ship to validate)

### Active

- [ ] Normative ALP spec document (`spec/ALP.md`) covering states, transition rules, actors, auth modes, trust model and trust limits
- [ ] Manifest JSON Schema (source of truth) with generated TypeScript types and an Ajv validator (`@stint/spec`)
- [ ] Lease state machine with explicit, table-driven, fully tested transitions and actor attribution (`@stint/core`)
- [ ] Publisher license issuance and verification with PASETO v4.public, short TTL, refresh bounded by lease expiry
- [ ] Append-only, hash-chained receipt log with signed checkpoints, verified vs attested entries, merged plain-language timeline
- [ ] Teardown orchestrator: revoke OAuth, then invalidate license, then cleanup hook (single-use cleanup token), delete cache, final signed receipt; every partial failure recorded
- [ ] MCP proxy enforcing scopes, limits and approvals per call via runtime-owned connector bindings, deny by default (`@stint/proxy`)
- [ ] Pluggable HostAdapter (consent, per-call approval, lifecycle notifications) with a CLI reference implementation; approval timeout defaults to deny
- [ ] Pluggable LeaseStore with a JSON-file default
- [ ] CLI to create, inspect, revoke and clean up leases and print receipts (`@stint/cli`)
- [ ] `examples/payment-reconciler`: hybrid-mode stub agent (licensed by mock publisher, reads mocked Paystack transactions via OAuth, writes to mocked orders sheet) as the end-to-end test
- [ ] README: the problem, three auth modes, trust limits of hosted mode, quickstart using the example agent

### Out of Scope

- Marketplace / agent discovery: v0.1 is protocol and runtime only
- Multi-agent flows (agent-to-agent delegation of leases): complicates the trust model; revisit after single-agent is proven
- Rich consent UI beyond the host adapter + CLI reference: platforms build their own UI via HostAdapter
- Real payment integrations (real Paystack, real `pay` execution): mocked only; `pay` access is enforced but never executed for real
- npm publishing and release pipeline: v0.1 done = e2e green + README; publishing comes later
- Sandboxing agent network egress: the proxy governs MCP tool calls, not the agent process; documented as a trust assumption

## Context

- MCP (Model Context Protocol) defines tool calls but leaves user consent, revocation and uninstall out of scope. OAuth 2.1 gives delegated tokens but no lease or lifecycle semantics.
- Design review (2026-09-27) surfaced these, now baked into the design:
  - Early termination actors widened: user, verifier, policy (user-consented limits/error threshold), clock, provider (revoked grant), publisher (entitlement revoked), runtime. The agent is never an actor for ending or extending a lease.
  - States: proposed, declined, granted, active, completed, expired, revoked, failed, tearing_down, cleaned_up, cleanup_incomplete.
  - License token refresh (routine, runtime-driven, bounded by lease expiry) is distinct from lease extension (requires fresh consent). Token expiry is not entitlement end.
  - Offline-verifiable licenses cannot be instantly invalidated; revocation latency is bounded by TTL (default 5 min). Invalidation = publisher revocation endpoint + stop refresh.
  - Teardown hook authenticates with a single-use cleanup token scoped to `cleanup:<lease_id>`, since the license is already invalidated at that point.
  - Provider revocation may be unsupported (no RFC 7009); per-credential results are `revoked | discarded_revocation_unsupported | failed`.
  - Customer-side OAuth revocation is detected lazily (invalid_grant / 401).
  - `auth.delegated` is a list (example needs Paystack + Sheets). Any grant revoked by the customer revokes the whole lease.
  - Tool to (resource, access, irreversible) mapping comes from runtime-owned connector bindings, never from the publisher manifest. Users approve custom bindings.
  - Approvals go out of band through the HostAdapter, never via MCP elicitation through the agent's client.
  - `approvals.require_for` uses only `send | pay | irreversible`.
  - Verifier types: `resource_query` (predicate run through the proxy with runtime credentials), `user_confirm`, `none`. Publisher-supplied verifier code is never trusted.
  - Receipts store args hash + binding-redacted summary, never raw args. Runtime signs chain checkpoints (Ed25519). Verified and attested chains keep independent integrity; merged ordering is display-only. Receipts survive cleanup.
  - Manifest carries `spec_version`, publisher signature, and its content hash is bound to the lease at consent.
  - Expiry is enforced per call, not by timers.
- Trust limits to document: attested receipts prove integrity, not completeness; leases cannot stop cross-resource data flow; publisher-side data deletion is attested, not verified; the runtime must be operated by the user or a neutral party.
- Name: Stint. Protocol: ALP (Agent Lease Protocol). npm scope `@stint/*`.

## Constraints

- **Tech stack**: pnpm monorepo, TypeScript strict, Node 20+, Vitest. Cross-platform (developer is on Windows).
- **Libraries**: `@modelcontextprotocol/sdk` (MCP), `oauth4webapi` (OAuth client), `paseto` by panva (PASETO v4.public), `jose` (EdDSA checkpoint signatures), `ajv` (validation), `json-schema-to-typescript` (types), `oauth2-mock-server` (mock AS). `node:crypto` for hashing. No hand-rolled crypto.
- **Security**: deny by default; enforcement never delegated to the model; no secrets in logs or receipts; no credentials exposed to the agent; license never forwarded to customer resources.
- **Testing**: tests for every state transition, every teardown path including partial failure, and scope denial.
- **Access vocabulary**: fixed `read | write | send | pay`. No free-form scopes.
- **License**: Apache-2.0.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Name `stint`, scope `@stint/*` | User choice | — Pending |
| Apache-2.0 | Patent grant suits an open protocol | — Pending |
| Widened termination actor list, agent never an actor | Resolves contradiction between "only user/verifier" and error_threshold/provider/publisher paths | — Pending |
| Runtime ships connector bindings | Publisher-authored mappings could mislabel send as read | — Pending |
| Single HostAdapter (consent + approvals + notifications), CLI reference impl | Community/platform builders control UX; one interface to implement | — Pending |
| Approval timeout defaults to deny | Deny by default | — Pending |
| Pluggable LeaseStore, JSON-file default | Open to community backends, simplest default | — Pending |
| Verifiers: resource_query, user_confirm, none | Publisher verifier code is untrusted | — Pending |
| Single-use cleanup token for uninstall hook | License is invalidated before hook runs | — Pending |
| License TTL default 5 min | Bounds revocation latency | — Pending |
| hybrid is default auth mode | License for entitlement, OAuth for customer systems | — Pending |
| v0.1 done = e2e green + README, no npm publish | Focus on correctness first | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-09-27 after initialization*
