# Feature Research

**Domain:** Agent authorization / lease / consent lifecycle tooling (MCP gateways, agent auth platforms, authorization policy engines, agent guardrails, agent payment mandates)
**Researched:** 2026-09-27
**Confidence:** MEDIUM (web search across vendor docs, blogs and standards trackers; no primary spec text fetched via curated docs provider — cross-check load-bearing claims, especially MCP auth spec version details and AP2 mandate mechanics, against primary sources before finalizing requirements)

## Landscape Surveyed

- **MCP gateways/proxies:** Docker MCP Gateway, Permit.io MCP Gateway, Cerbos Agent Gateway, Invariant Gateway (Snyk).
- **Agent authorization platforms:** Auth0 for AI Agents, Arcade.dev, Composio, Descope, Stytch, Nango.
- **Policy engines:** Cerbos, Permit.io, OPA (ReBAC/ABAC, externalized authorization, OpenID AuthZEN as the enforcement-point↔policy-engine standard, finalized Jan 2026).
- **Guardrails/scanners:** Invariant Labs (acquired by Snyk, June 2025) — MCP-scan, runtime tracing, contextual policy enforcement.
- **Standards:** MCP Authorization spec (OAuth 2.1-based, evolving through 2026), AP2 (Google's Agent Payments Protocol, announced Sept 2025), IETF Web Bot Auth / agent-identity-via-HTTP-message-signatures (chartering toward WG in 2026).

All of these products solve pieces of "let an agent act with delegated authority safely." None of them own the full lease lifecycle — install → scoped run → guaranteed, receipted uninstall — which is Stint's stated core value.

## Feature Landscape by Stint Package

### Spec / Manifest (`@stint/spec`)

| Feature | Category | Complexity | Notes |
|---------|----------|------------|-------|
| Machine-readable capability/scope declaration (what the agent/tool can touch) | Table stakes | LOW | Every platform surveyed has *some* manifest or scope schema (OAuth scopes, Arcade tool schemas, Docker catalog entries). Ajv-validated JSON Schema is a reasonable, boring choice — don't invent a DSL. |
| Fixed, closed access vocabulary (`read \| write \| send \| pay`) | Differentiator | LOW | Competitors let publishers/servers declare free-form scope strings (OAuth scopes, MCP tool schemas). A closed vocabulary makes "irreversible" and "requires approval" decidable by the runtime, not guessed from a string. Directly protects the core value: the proxy can enforce categories it fully understands. |
| Publisher-signed manifest bound to lease at consent (content hash pinned) | Differentiator | MEDIUM | Prevents manifest swap after consent (publisher changes scopes post-install without re-consent). None of the reviewed agent-auth platforms bind a signed manifest hash into the authorization record — they re-check scopes per token, not per artifact identity. |
| Runtime-owned tool→(resource, access, irreversible) bindings, never publisher-supplied | Differentiator | MEDIUM | Docker/Permit/Composio all let the tool server or publisher describe its own risk level. Stint's design explicitly distrusts that (a publisher could mislabel `send` as `read`). This is the single biggest spec-level differentiator versus the whole gateway category. |
| `spec_version` field for forward compatibility | Table stakes | LOW | MCP itself versions protocol revisions; any spec meant to outlive v0.1 needs this from day one. |

### Lease Lifecycle (`@stint/core`)

| Feature | Category | Complexity | Notes |
|---------|----------|------------|-------|
| Time-bound, expiring grant of access | Table stakes | LOW | Every platform surveyed does short-TTL tokens (OAuth access tokens 15–60 min recommended; AP2 mandates are time-boxed). Table stakes, not a differentiator. |
| Explicit lifecycle states beyond "active/expired" (proposed, granted, active, completed, expired, revoked, failed, tearing_down, cleaned_up, cleanup_incomplete) | Differentiator | MEDIUM | Competitors model a *session* or *connection*, not a full lease with a terminal, auditable teardown state. `cleanup_incomplete` as a first-class, non-hidden state has no analogue in the surveyed products — most silently drop failed revocations into logs, not into the state a consumer must handle. |
| Actor-attributed transitions (user, verifier, policy, clock, provider, publisher, runtime — agent is never an actor for ending/extending) | Differentiator | MEDIUM | Converged human-in-the-loop patterns (OpenAI Operator, AWS Bedrock, LangChain) distinguish *who approved*, but none formalize *who is allowed to end a grant* as a closed actor enum excluding the agent itself. This is a direct enforcement of the core value statement. |
| Per-call expiry enforcement (not timer-based) | Differentiator | LOW-MEDIUM | Most OAuth-based systems rely on token expiry + occasional refresh; a call arriving 1ms after expiry can still succeed if the token hasn't been checked. Enforcing at each proxy call closes that gap — cheap to build, meaningfully different from "trust the token's `exp`". |
| Scope-escalation / re-consent flow (mid-lease request for more access) | Table stakes (pattern), but scoped down for v0.1 | MEDIUM | Named explicitly in current human-in-the-loop literature ("Scope-Escalation Request" pattern). Stint's PROJECT.md defers multi-step extension to license-refresh vs lease-extension distinction — keep, but don't over-build a negotiation protocol in v0.1. |
| Lease extension requires fresh consent, distinct from routine token refresh | Differentiator | MEDIUM | This exact distinction — entitlement token refresh (automatic, bounded) vs lease extension (requires a human) — is not made explicitly by any surveyed agent-auth platform; most treat "refresh token succeeded" as implicit continued authorization. |

### Licensing (publisher entitlement layer)

| Feature | Category | Complexity | Notes |
|---------|----------|------------|-------|
| Offline-verifiable, short-TTL signed tokens (PASETO/JWT-class) | Table stakes | LOW-MEDIUM | Standard pattern across the identity space; PASETO v4.public avoids JWT algorithm-confusion footguns — a reasonable, defensible choice, not novel. |
| Publisher revocation endpoint independent of resource-side OAuth | Differentiator | MEDIUM | Auth0/Arcade/Composio/Descope/Stytch all focus on *resource* delegation (the agent's access to Paystack, Sheets, etc.) — none of them separate "is this agent-publisher relationship still entitled to run at all" from "does this OAuth grant to a customer resource still work." Stint's dual-layer (license = entitlement, OAuth = resource access) is close to a marketplace/SaaS billing concept, not an agent-auth concept, and nobody in this space combines the two under one lease. |
| Bounded revocation latency, explicitly documented (TTL default 5 min) | Differentiator (as an honesty commitment) | LOW | AP2 documents that "mandate revocation needs careful handling" as an open problem it does not solve. Stint turns this into a documented trust limit with a number attached, rather than an unstated gap — this "honest about limits" stance is itself the differentiator, not the TTL mechanism. |
| License refresh bounded strictly by lease expiry (never outlives the lease) | Differentiator | LOW | Prevents the common failure mode of a refresh token silently extending access past what the user actually granted. |

### Receipts (audit / attestation)

| Feature | Category | Complexity | Notes |
|---------|----------|------------|-------|
| Per-call audit/decision log | Table stakes | LOW-MEDIUM | Universal — Permit.io, Cerbos, Docker Gateway, Invariant all log every authorization decision. Missing this would be disqualifying. |
| Tamper-evident, hash-chained log with signed checkpoints | Differentiator | MEDIUM-HIGH | Standard audit logs in the surveyed products are append-only *application* logs (database rows), not cryptographically chained with periodic signed checkpoints. This is closer to certificate-transparency-style logging than typical SaaS audit trails — a real differentiator in tamper evidence, at real implementation cost. |
| Explicit verified-vs-attested distinction (proxy-witnessed fact vs publisher self-report), kept as independent integrity chains | Differentiator | MEDIUM-HIGH | AP2 mandates are cryptographically signed permission slips but conflate "the mandate says X" with "X actually happened." No surveyed product separates "the runtime saw this happen" from "the publisher claims this happened" as two chains merged only for display. This is a direct, defensible answer to the honesty half of Stint's core value ("honest receipts"). |
| Redacted-by-default entries (args hash + binding-redacted summary, never raw args) | Table stakes for a security-conscious product, but not common practice | MEDIUM | Docker Gateway does PII/secret redaction on interceptors; most competitors log raw request bodies. Treat as table stakes for *Stint specifically* given "no secrets in logs" is a stated constraint, even though it's not universal in the category. |
| Human-readable merged timeline (plain-language narrative of what a lease did) | Differentiator | LOW-MEDIUM | Audit UIs in the reviewed products are technical (JSON decision logs, dashboards for security teams). A plain-language "here's what this agent did with your data" surface, aimed at the end user rather than a SOC analyst, is closer to a receipt/statement than a SIEM feed — matches Stint's user-facing framing. |
| Receipts survive cleanup (durable after lease is torn down) | Table stakes for the "honest receipts" claim | LOW | If receipts vanish with the lease, the "honestly receipted teardown" promise is unverifiable after the fact. Non-negotiable given the core value statement. |

### Proxy Enforcement (`@stint/proxy`)

| Feature | Category | Complexity | Notes |
|---------|----------|------------|-------|
| Enforcement point between agent and every tool call, outside the model | Table stakes | MEDIUM | This is the defining pattern of the whole gateway category (Docker, Permit, Cerbos, Invariant Gateway). Stint must have this or it isn't in the category at all — but it's not a differentiator, it's the price of entry. |
| Deny-by-default | Table stakes | LOW | Universal best practice recommended across all surveyed sources; several (Docker profiles, Permit) support allow-lists as opt-in rather than deny-by-default, so this is table stakes to claim but not universally *shipped as default* — worth stating explicitly as a hard requirement rather than assuming the category already does it. |
| Real credentials never reach the agent/model (vaulting pattern) | Table stakes | MEDIUM | Docker Gateway's secrets-store pattern and Arcade's "agent never sees the token" model both do this already; increasingly the expected baseline, not novel, but essential — skipping it would be a critical gap, not just a missed differentiator. |
| Pre/post-call interceptors (argument inspection, response redaction) | Table stakes | MEDIUM | Docker Gateway ships this explicitly (path-traversal/injection detection, PII redaction). Any serious MCP proxy needs at least output redaction; don't reinvent — treat as expected baseline. |
| Verifier types limited to a closed set (`resource_query`, `user_confirm`, `none`), publisher verifier code never trusted | Differentiator | MEDIUM | Contrasts with platforms that let integrators supply arbitrary webhook/callback logic as part of the authorization decision (common in policy-engine integrations). Closing this to a fixed, runtime-executed set removes a whole class of "publisher-supplied code makes the access decision" risk — directly protects "cannot exceed lease" under prompt injection, since the decision logic itself is never agent- or publisher-controlled. |
| Approval routed out-of-band via host, never through MCP elicitation to the agent's own client | Differentiator | MEDIUM | Most human-in-the-loop literature (LangChain middleware, AWS Bedrock return-of-control) routes the interrupt back *through* the same agent loop that could be compromised by injected instructions. Requiring the approval channel to bypass the agent's client entirely is a meaningfully stronger trust boundary and a direct, specific defense of the "prompt-injected agent can never exceed its lease" claim — worth calling out prominently in docs as the mechanism, not just a design note. |
| Prompt-injection / tool-poisoning *detection* (scanning tool descriptions, LLM output classification) | Anti-feature for Stint (deliberately out of scope) | HIGH | This is Invariant/Snyk's core product. Stint's stated design bet is that detection doesn't matter — the lease bounds the blast radius regardless of whether injection is detected. Building a detection layer duplicates a hard, adversarial, never-finished problem (and a well-funded competitor already owns it) instead of the enforcement guarantee Stint is actually selling. State this explicitly as a non-goal to keep scope honest. |
| General-purpose policy DSL / ABAC/ReBAC engine (Cerbos/OPA/Permit style) | Anti-feature for Stint v0.1 | HIGH | Cerbos and Permit compete on expressive policy languages for arbitrary authorization logic. Stint's enforcement model is intentionally narrower (fixed vocabulary + connector bindings + closed verifier set) specifically so a prompt-injected agent can't manipulate a flexible policy surface. Do not add a general policy language; it re-opens the attack surface the closed model exists to shut. |

### Host Integration (`HostAdapter`)

| Feature | Category | Complexity | Notes |
|---------|----------|------------|-------|
| Pluggable interface for consent, per-call approval, lifecycle notifications | Table stakes | MEDIUM | Every platform in this space (Auth0, Descope, Stytch, Permit) ships an SDK/webhook interface so the *host* builds its own UX rather than being handed a fixed UI — validated pattern, not risky. |
| Approval timeout defaults to deny | Table stakes | LOW | Matches deny-by-default; explicitly called out as best practice in human-in-the-loop literature (halt execution, don't proceed on silence). |
| CLI as the reference HostAdapter implementation (not a hosted UI) | Reasonable, not really differentiator or table stakes | LOW-MEDIUM | Commercial competitors ship hosted consent screens because that's their product; an open protocol reference-implementing the adapter via CLI is appropriately scoped for v0.1 and keeps the spec, not a UI, as the deliverable. |
| Rich, polished hosted consent UI | Anti-feature for Stint core | HIGH | This is literally the product Auth0/Descope/Stytch sell. Building one competes with platform builders who are meant to be Stint's *adopters*, not its competitors — correctly out of scope per PROJECT.md. |

### CLI (`@stint/cli`)

| Feature | Category | Complexity | Notes |
|---------|----------|------------|-------|
| Create / inspect / revoke / clean-up lease commands | Table stakes | LOW-MEDIUM | Baseline lifecycle CRUD; every reviewed platform has an equivalent dashboard or CLI surface for connection management. |
| Print human-readable receipts from the CLI | Differentiator (in framing, not mechanism) | LOW | Turns the receipt chain into something a non-technical evaluator can inspect directly, without a hosted dashboard — reinforces "honest receipts" as a first-class, inspectable artifact rather than an internal log. |
| Marketplace/discovery commands (search, install-from-registry) | Anti-feature for v0.1 | MEDIUM-HIGH | Explicitly out of scope per PROJECT.md; matches the finding that catalog breadth (Composio ~many integrations, Arcade ~112) is a *different* competitive axis Stint should not chase. |

### Example / E2E (`examples/payment-reconciler`)

| Feature | Category | Complexity | Notes |
|---------|----------|------------|-------|
| End-to-end example exercising hybrid auth (license + OAuth), a `pay`-class action, and full teardown | Table stakes for credibility | MEDIUM | Every competitor demonstrates its value with a worked example (Arcade/Composio quickstarts, Docker Gateway sample catalog entries). Without one, "cannot exceed lease" is an unverifiable claim. |
| Real payment execution in the example | Anti-feature for v0.1 | N/A | Explicitly out of scope; mocked Paystack matches AP2's own posture of separating "protocol proven" from "tested at real card-network volume" — don't rush real money into a v0.1 proof of concept. |

### Docs

| Feature | Category | Complexity | Notes |
|---------|----------|------------|-------|
| Explicit, written trust-limits section (what receipts do/don't prove, what leases can't stop) | Differentiator | LOW | AP2's own documentation is unusually candid that "agent identity is not solved," "mandate revocation needs careful handling" — that candor is rare and notably absent from commercial agent-auth vendor docs (Auth0/Arcade/Composio marketing tends toward "solved"). Stint documenting its own limits this explicitly (cross-resource data flow, attested-not-verified publisher deletion, neutral-operator assumption) is a credibility differentiator, directly requested in PROJECT.md. |
| Three-auth-modes explainer (licensed / delegated / hybrid) with a quickstart | Table stakes | LOW | Every platform needs an on-ramp; nothing novel about having one, but its absence would be disqualifying. |

## Feature Dependencies

```
Manifest (signed, hash-pinned)
    └──requires──> Spec/Schema validation (Ajv)

Lease Lifecycle (states + actor attribution)
    └──requires──> Manifest (to know what was consented to)
    └──requires──> Receipts (every transition must be receipted)

Licensing (publisher entitlement token)
    └──requires──> Lease Lifecycle (refresh bounded by lease expiry)
    └──feeds──> Teardown Orchestrator (invalidate license before cleanup hook)

Proxy Enforcement (deny-by-default, per-call checks)
    └──requires──> Manifest (runtime-owned connector bindings)
    └──requires──> Lease Lifecycle (per-call expiry + state check)
    └──produces──> Receipts (verified chain)

Receipts (verified + attested chains)
    └──requires──> Proxy Enforcement (source of verified entries)
    └──requires──> Licensing/Publisher hooks (source of attested entries)

Teardown Orchestrator
    └──requires──> Licensing (invalidate before cleanup hook)
    └──requires──> Proxy Enforcement (revoke OAuth grants)
    └──requires──> Receipts (final signed receipt, partial-failure recording)

HostAdapter
    └──requires──> Lease Lifecycle (states to surface as notifications)
    └──enhances──> Proxy Enforcement (out-of-band approval channel)

CLI
    └──requires──> Lease Lifecycle, Receipts, Teardown Orchestrator (wraps all three)

Example/E2E
    └──requires──> everything above (integration proof)

Prompt-injection detection (anti-feature) ──conflicts──> Closed verifier-set enforcement model
General policy DSL (anti-feature) ──conflicts──> Fixed access vocabulary + runtime-owned bindings
Marketplace/discovery (anti-feature) ──conflicts──> v0.1 scope (protocol + runtime only)
```

### Dependency Notes

- **Receipts depend on both Proxy Enforcement and Licensing:** the verified chain comes from the proxy witnessing real tool calls; the attested chain comes from publisher-side claims relayed through licensing. They must be built as independent structures from the start — retrofitting the verified/attested split after receipts already exist as one log is expensive.
- **Teardown Orchestrator depends on Licensing being invalidated first:** the design decision that the cleanup hook uses a single-use token scoped to `cleanup:<lease_id>` *because* the license is already dead at that point means licensing invalidation must be sequenced before cleanup-hook auth is even generated — an ordering dependency, not just a feature list.
- **Closed verifier set conflicts with any future "flexible policy" feature:** if a later milestone is tempted to add a general policy DSL (to compete with Cerbos/Permit on flexibility), that directly undermines the "publisher verifier code is never trusted" guarantee the core value depends on. Flag this conflict for any future roadmap phase that touches proxy enforcement.
- **Detection features (prompt-injection scanning) conflict with the product's positioning, not its architecture:** they could be bolted on without breaking anything, but doing so muddies the pitch ("it doesn't matter if injection succeeds") with a "we also try to prevent injection" claim that Stint cannot make as credibly as Invariant/Snyk, who specialize in it.

## MVP Definition

### Launch With (v0.1 — matches PROJECT.md Active requirements)

- [ ] Normative ALP spec (states, transitions, actors, auth modes, trust model/limits) — nothing else in this space has a comparable open, independent spec; it's the foundation every other package depends on.
- [ ] Manifest schema + Ajv validator + generated types — table stakes, low complexity, unblocks everything downstream.
- [ ] Lease state machine with actor attribution, fully tested transitions — the core differentiator; must be correct before anything is built on top.
- [ ] License issuance/verification (PASETO, short TTL, refresh bounded by lease expiry) — table stakes mechanism, differentiator framing (entitlement separate from resource access).
- [ ] Hash-chained receipt log, verified vs attested, signed checkpoints — the other half of the core value claim; cannot be deferred without gutting "honest receipts."
- [ ] Teardown orchestrator with per-credential outcome recording and partial-failure handling — this *is* "ending the lease revokes everything."
- [ ] MCP proxy enforcing scopes/limits/approvals via runtime-owned connector bindings, deny by default — this *is* "cannot exceed its lease."
- [ ] HostAdapter interface + CLI reference implementation, approval-timeout-defaults-to-deny — needed to prove out-of-band approval, the anti-prompt-injection mechanism.
- [ ] Pluggable LeaseStore, JSON-file default — low cost, keeps the reference runtime usable without a database dependency.
- [ ] CLI (create/inspect/revoke/cleanup/print receipts) — the operable surface for everything above.
- [ ] `examples/payment-reconciler` e2e (hybrid mode, mocked Paystack + Sheets) — the credibility proof; a `pay`-class action end-to-end is the sharpest test of the core claim.
- [ ] README covering the three auth modes and documented trust limits — required for anyone to evaluate the honesty claim at all.

### Add After Validation (v0.1.x)

- [ ] Scope-escalation / mid-lease re-consent flow — named pattern in the industry (Scope-Escalation Request), but PROJECT.md correctly treats it as separable from routine refresh; add once the base lifecycle is proven.
- [ ] Additional LeaseStore backends (Postgres/Redis) — trigger: real hosting deployments need concurrency/durability beyond a JSON file.
- [ ] Additional example agents beyond payment-reconciler (e.g., a `send`-only or `write`-only example) — trigger: need to demonstrate the proxy generalizes beyond one connector shape.
- [ ] Merged human-readable timeline UI beyond CLI text output — trigger: platform builders ask for a richer receipt-rendering component to embed.

### Future Consideration (v2+)

- [ ] Multi-agent delegation (agent-to-agent lease sub-granting) — defer per PROJECT.md; adds a trust-model dimension (who is the actor when a sub-agent oversteps?) that should only be tackled once single-agent leases are proven correct in production.
- [ ] AuthZEN-compatible external policy engine integration — defer until/unless a host wants to plug Stint's enforcement decisions into an existing Cerbos/Permit/OPA deployment; premature before the fixed-vocabulary model is validated.
- [ ] Real payment execution — defer until the mocked e2e has been battle-tested and a real card-network/PSP partnership exists; matches AP2's own admission that real-volume testing is still ahead of the ecosystem.

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|----------------------|----------|
| Lease state machine + actor attribution | HIGH | MEDIUM | P1 |
| Deny-by-default MCP proxy enforcement | HIGH | MEDIUM | P1 |
| Hash-chained, verified/attested receipts | HIGH | MEDIUM-HIGH | P1 |
| Teardown orchestrator with partial-failure recording | HIGH | MEDIUM | P1 |
| Manifest schema + validator | HIGH | LOW | P1 |
| License issuance/verification, refresh bounded by lease | MEDIUM-HIGH | MEDIUM | P1 |
| Out-of-band HostAdapter approval channel | HIGH | MEDIUM | P1 |
| CLI lifecycle commands + receipt printing | MEDIUM | LOW-MEDIUM | P1 |
| e2e payment-reconciler example | HIGH (credibility) | MEDIUM | P1 |
| Documented trust-limits section | MEDIUM-HIGH (credibility) | LOW | P1 |
| Scope-escalation / re-consent flow | MEDIUM | MEDIUM | P2 |
| Additional LeaseStore backends | LOW-MEDIUM | MEDIUM | P2 |
| Merged human-readable timeline UI | MEDIUM | LOW-MEDIUM | P2 |
| Multi-agent delegation | HIGH (long-term) | HIGH | P3 |
| General policy DSL / AuthZEN integration | LOW (for stated core value) | HIGH | P3 |
| Marketplace / discovery | MEDIUM (adoption) | HIGH | P3 |
| Prompt-injection detection layer | LOW (duplicates a competitor's specialty) | HIGH | Do not build |

**Priority key:**
- P1: Must have for launch (v0.1)
- P2: Should have, add when possible (v0.1.x)
- P3: Nice to have, future consideration (v2+)

## Competitor Feature Analysis

| Feature | Agent-auth platforms (Auth0/Arcade/Composio/Descope/Stytch) | MCP gateways (Docker/Permit/Cerbos) | Guardrails (Invariant/Snyk) | Payments (AP2) | Stint's Approach |
|---------|---|---|---|---|---|
| Delegated resource access | Core product (OAuth token vaulting, connector catalogs) | Enforced at gateway, not issued | Not their focus | Not their focus | Reuses OAuth 2.1 via `auth.delegated`; not reinvented — table stakes only |
| Fine-grained scopes | Yes, often free-form per-integration | Yes, via policy | N/A | N/A (mandate scope is transaction-shaped) | Closed vocabulary (`read\|write\|send\|pay`) — deliberately narrower |
| Per-call enforcement outside the model | Not typically (token-based, trust the call site) | Yes — their core pattern | Yes, via gateway/interceptors | N/A | Same pattern, via `@stint/proxy`; table stakes for this category |
| Full lifecycle with guaranteed uninstall/revocation | No — session/connection ends, cleanup is the integrator's problem | No — gateway manages access, not entitlement lifecycle | No | Explicitly unsolved ("revocation needs careful handling") | Core differentiator: teardown orchestrator, per-credential outcomes, `cleanup_incomplete` state |
| Verified vs attested distinction in audit trail | No — single audit log | No — single decision log | Partial (traces are proxy-witnessed only) | No (mandate signature ≠ fulfillment proof) | Core differentiator: two independent chains, merged only for display |
| Publisher entitlement separate from resource access | No | No | No | No | Core differentiator: licensing layer distinct from OAuth |
| Open spec vs proprietary platform | Proprietary SaaS | Docker/Permit proprietary; some open-source components | Proprietary (Snyk-owned) | Open protocol, Google-led | Stint: fully open spec (Apache-2.0), reference runtime only |
| Connector/integration catalog breadth | Core competitive axis (Arcade ~112, Composio "many") | Docker: 100+ verified servers | N/A | N/A | Explicitly not competing here; runtime-owned bindings, not a catalog |

## Sources

- [Permit MCP Gateway overview](https://docs.permit.io/permit-mcp-gateway/overview/)
- [Cerbos: Agent Gateway + Cerbos](https://www.cerbos.dev/ecosystem/agent-gateway)
- [Cerbos: What Is an MCP Gateway?](https://www.cerbos.dev/blog/what-is-an-mcp-gateway)
- [Cerbos: Authorizing MCP Tool Calls at the Gateway or Inside the Proxy](https://www.cerbos.dev/blog/authorizing-mcp-tool-calls-at-the-gateway-or-inside-the-proxy)
- [Cerbos: MCP and Zero Trust](https://www.cerbos.dev/blog/mcp-and-zero-trust-securing-ai-agents-with-identity-and-policy)
- [Arcade.dev: 7 Best AI Agent Authentication Platforms (2026)](https://www.arcade.dev/blog/best-ai-agent-authentication-platforms/)
- [Nango: Best AI Agent Authentication Platforms (2026)](https://nango.dev/blog/best-ai-agent-authentication/)
- [Developers Digest: AI Agent Auth Platforms Compared — Arcade vs Composio vs Nango vs Stytch](https://www.developersdigest.tech/blog/ai-agent-auth-platforms-comparison-2026)
- [V12 Labs: Composio vs Arcade for AI Agent Tool Authentication](https://www.v12labs.io/blog/2026-06-16-ai-agent-tool-authentication-composio-arcade)
- [Scalekit: Auth0 for Agents — Alternatives for B2B AI platforms](https://www.scalekit.com/blog/auth0-alternatives-for-ai-agent-auth)
- [Snyk Labs + Invariant Labs](https://labs.snyk.io/resources/snyk-labs-invariant-labs/)
- [Snyk: Guardrails for Agentic AI — From MCP Scanning to AI-BOM Visibility](https://labs.snyk.io/resources/guardrails-agentic-ai-mcp-aibom/)
- [Snyk: Acquires Invariant Labs to Accelerate Agentic AI Security Innovation](https://snyk.io/news/snyk-acquires-invariant-labs-to-accelerate-agentic-ai-security-innovation/)
- [Eco: AP2 (Agent Payments Protocol) Explained](https://eco.com/support/en/articles/14845479-ap2-agent-payments-protocol-explained)
- [Google Cloud Blog: Announcing Agent Payments Protocol (AP2)](https://cloud.google.com/blog/products/ai-machine-learning/announcing-agents-to-payments-ap2-protocol)
- [arXiv: Identity Management for Agentic AI](https://arxiv.org/pdf/2510.25819)
- [Descope: Diving Into the MCP Authorization Specification](https://www.descope.com/blog/post/mcp-auth-spec)
- [Stytch: MCP authentication and authorization implementation guide](https://stytch.com/blog/MCP-authentication-and-authorization-guide/)
- [Aembit: MCP Authorization — OAuth 2.1, PKCE, and Agent Identity](https://aembit.io/blog/mcp-oauth-2-1-pkce-and-the-future-of-ai-authorization/)
- [Medium: The Evolution of MCP Auth — Every Spec, Every Lesson](https://medium.com/@ayshsandu/the-evolution-of-mcp-auth-every-spec-every-lesson-2024-11-05-2026-07-28-draft-e3f165a12fdb)
- [Docker Blog: AI Guide to the Galaxy — MCP Toolkit and Gateway, Explained](https://www.docker.com/blog/mcp-toolkit-gateway-explained/)
- [Docker: MCP Security Risks, Challenges, and How to Mitigate](https://www.docker.com/blog/mcp-security-explained/)
- [dasroot.net: A Quick Look at Docker MCP Gateway Interceptors](https://dasroot.net/posts/2026/01/docker-mcp-gateway-interceptors-security/)
- [Scalekit: Human-in-the-Loop Tool Calling — Approval Gates for AI Agents](https://www.scalekit.com/blog/human-in-the-loop-tool-calling)
- [DEV Community: Human-in-the-loop patterns for AI agents](https://dev.to/royalpinto007/human-in-the-loop-patterns-for-ai-agents-when-and-how-to-make-an-agent-stop-and-ask-fej)
- [StackAI: Human-in-the-Loop AI Agents — Approval Workflow Design](https://www.stackai.com/insights/human-in-the-loop-ai-agents-how-to-design-approval-workflows-for-safe-and-scalable-automation)

**Confidence caveats:** Findings above are drawn from vendor blogs, comparison articles and standards-tracker summaries (WebSearch, MEDIUM confidence per the source hierarchy), not from primary spec documents fetched directly. Before finalizing roadmap requirements, verify against primary sources: the current MCP Authorization spec revision text itself, the AP2 specification/whitepaper, and the IETF Web Bot Auth charter/drafts, especially any claim about exact spec-version behavior (e.g., "MCP server is now a pure Resource Server," RFC 9728 mandatory status) since these standards were still actively evolving through 2026 at the time of research.

---
*Feature research for: Agent authorization / lease / consent lifecycle tooling (Stint / Agent Lease Protocol)*
*Researched: 2026-09-27*
