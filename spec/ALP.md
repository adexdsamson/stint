# Agent Lease Protocol (ALP), version alp/0.1

## 1. Introduction

Stint is a lease runtime for specialist AI agents. This document, the Agent Lease Protocol (ALP), specifies the human-facing lifecycle of an agent: install, run a scoped job, and uninstall cleanly.

The protocol's scope is exactly these three phases. Install means a user reviews a publisher's manifest and grants a lease. A scoped job means the agent operates only within the bounds the lease states, enforced by code the agent cannot influence. Uninstall means the lease ends, for any reason, and every credential the runtime holds on the agent's behalf is revoked, with the teardown honestly receipted.

ALP sits on top of two existing specifications and fills the gap each one leaves out of scope.

Rationale: the Model Context Protocol (MCP) defines how an agent discovers and calls tools, but it leaves user consent, revocation and uninstall out of scope; a host that implements only MCP has no normative way to say "this agent's access ends here, and here is proof it actually ended." OAuth 2.1 gives an agent's runtime delegated, scoped access tokens for a customer's own resources, but it has no concept of a lease: no bound duration, no bound job, and no teardown obligation tied to the lease's owner rather than to the token's issuer.

ALP serves two audiences equally. Platform builders host communities of agents and embed a runtime implementation with their own consent and approval user experience. Agent publishers ship specialist agents with a signed manifest, and where applicable a publisher-issued license, and in return receive attested receipts proving what their agent did.

The core guarantee this document specifies: a prompt-injected or otherwise misbehaving agent can never act outside the lease a user granted. Every tool call an agent makes is decided by code outside the model, running in a proxy the agent cannot bypass; the agent never holds a real credential that would let it act directly against a resource.

Non-goals: this document does not specify a marketplace or agent discovery mechanism; multi-agent delegation of a single lease to another agent; prompt-injection detection (the protocol's guarantee is that injection cannot exceed the lease, not that injection is detected or prevented); sandboxing of the agent process's own network egress (Section 13 documents this as a trust limit, not a mechanism this protocol provides); or a general-purpose policy DSL (the access vocabulary is the fixed set defined in Section 2, not an extensible rule language).

## 2. Conventions and Terminology

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY" and "OPTIONAL" in this document are to be interpreted as described in BCP 14 [RFC2119] [RFC8174] when, and only when, they appear in all capitals, as shown here.

Sections and notes beginning "Rationale:" are non-normative; they explain the reasoning behind a requirement but impose no obligation of their own.

Some wire-level details are not yet designed at this stage of the specification. Each such place carries an explicit marker, for example `[OPEN: Phase 2]`, naming the phase of the Stint project's own build that will define it. Implementations MUST NOT invent an interoperable format for anything marked with such a bracketed OPEN marker; a runtime or publisher MAY use a private, non-interoperable representation internally, but MUST NOT advertise cross-implementation compatibility of that representation until this document replaces the marker with a normative definition.

The following terms are used throughout this document:

- **Lease**: a bounded grant of access from a user to an agent, scoped to specific resources, access classes and limits, for at most a bounded duration.
- **Manifest**: a publisher-authored document describing an agent's job, requested scopes, limits, approvals and auth requirements, validated against the canonical manifest schema.
- **Signed Manifest Envelope**: a manifest plus a detached publisher signature over the manifest's canonical bytes.
- **Content Hash**: a self-describing hash of a manifest's canonically serialized bytes, bound to a lease at consent.
- **Runtime**: the software implementing this protocol: the state machine, the proxy, the credential vault and the teardown orchestrator. Operated by the user or a neutral party (Section 12).
- **Proxy**: the runtime component that sits between the agent and every system it touches, presenting an MCP server to the agent and enforcing the lease on every tool call.
- **Host**: the application embedding the runtime and presenting it to a user, via its HostAdapter.
- **HostAdapter**: the pluggable interface a host implements to render consent, per-call approval and lifecycle notifications.
- **Agent**: the publisher-authored process that calls tools through the proxy. Untrusted; never an actor in this protocol's transitions (Section 7.2).
- **Publisher**: the party that authors and signs a manifest, and in hosted or hybrid auth mode issues a license.
- **Provider**: the operator of a customer resource (for example a payments API or a spreadsheet API) that issues delegated OAuth grants.
- **Connector Binding**: a runtime-owned mapping from a tool name to a (resource, access class, irreversible) classification. Never derived from the manifest.
- **Resource**: an opaque identifier for something an agent can be granted access to, resolved by connector bindings.
- **Access Class**: one of the fixed values `read`, `write`, `send` or `pay`.
- **Grant**: a delegated OAuth authorization acquired from a provider for a specific resource.
- **License**: a publisher-issued, offline-verifiable token proving entitlement, used in hosted and hybrid auth modes.
- **Receipt**: an append-only record of one decision or outcome, hash-chained with every other receipt in its chain.
- **Verified Chain**: the hash chain of receipts the runtime itself observed and can prove.
- **Attested Chain**: the hash chain of receipts the runtime relays on trust from the publisher, without independent proof.
- **Checkpoint**: a signed statement summarizing a chain's head at a point in time, used to detect truncation or tampering.
- **Teardown**: the fixed, ordered sequence that runs whenever a lease ends, ending in a final signed receipt.
- **Actor**: the party the runtime attributes a transition to: `user`, `verifier`, `policy`, `clock`, `provider`, `publisher` or `runtime`.
- **Event**: the named occurrence that drives a lease from one state to another, as listed in Section 7.3.

## 3. Protocol Overview

ALP describes a small set of roles interacting around one lease at a time.

- The **user** grants and can end a lease, and is the only actor who can extend one.
- The **host** embeds the runtime and renders every consent and approval decision through its **HostAdapter**; the host trusts the runtime to enforce the lease, and the user trusts the host to render consent faithfully.
- The **runtime** is the software implementing this protocol. It runs an MCP **proxy** between the agent and every resource the agent might touch, holds the lease state machine, and orchestrates teardown.
- The **agent** is the publisher-authored process that calls tools through the proxy. The agent never holds a real credential: no OAuth access token, no license, no cleanup token. Every tool call the agent makes is decided by code outside the model, running in the proxy, which the agent cannot see or influence.
- The **publisher** authors and signs the manifest, and in hosted or hybrid auth mode issues a license.
- **Providers** operate the customer resources (a payments API, a spreadsheet API, and so on) that the agent's job touches, and issue delegated OAuth grants.

A short lifecycle walk-through: the host presents a publisher's signed manifest to the user (Section 6). If the user consents, the runtime binds the manifest's content hash to a new lease, acquires any delegated OAuth grants and any publisher license the auth mode requires, and activates the lease. While active, every tool call the agent makes passes through the proxy, which resolves the call to a runtime-owned connector binding, checks the lease's scopes and limits, and either allows it, denies it, or asks the user for approval through the HostAdapter. The lease ends for one of several reasons (Section 7), after which teardown (Section 10) runs its fixed sequence, and every step is honestly recorded in the receipt log (Section 11), whether it succeeds or not.

```mermaid
flowchart LR
    User -->|consent, approval, revoke| Host
    Host -->|HostAdapter| Runtime
    Agent -->|tools/call| Runtime
    Runtime -->|credential-bearing calls| Providers
    Publisher -->|signed manifest, license| Runtime
```

## 4. Manifest

<!-- ALP-PENDING: 01-05 -->

## 5. Signed Manifest Envelope and Content Hash

<!-- ALP-PENDING: 01-05 -->

## 6. Consent

<!-- ALP-PENDING: 01-05 -->

## 7. Lease Lifecycle

### 7.1 States

A lease occupies exactly one of eleven states at any time. Each state is either non-terminal (further transitions are possible) or terminal (no further transition is legal from it, per the transition table in Section 7.4).

- `proposed`: the runtime has verified the manifest and is presenting it to the user for consent. Non-terminal.
- `declined`: the user declined consent, or the consent request timed out. Terminal.
- `granted`: the user consented; the runtime is acquiring delegated grants and a license before activation. Non-terminal.
- `active`: the lease is live; the agent may call tools within its scope, and the outcome verifier, the clock, the policy engine, or any actor may end it. Non-terminal.
- `completed`: the outcome verifier confirmed the job's outcome. Non-terminal (teardown follows).
- `expired`: the lease's maximum duration elapsed. Non-terminal (teardown follows).
- `revoked`: the user, a resource provider, or the publisher ended the lease early. Non-terminal (teardown follows).
- `failed`: the policy engine's error threshold was exceeded, or the runtime itself failed. Non-terminal (teardown follows).
- `tearing_down`: the teardown orchestrator is running its fixed sequence of steps. Non-terminal.
- `cleaned_up`: teardown completed every step successfully. Terminal.
- `cleanup_incomplete`: at least one teardown step did not complete. Non-terminal, since a retry can resume it.

Rationale: `declined` and `cleaned_up` are the only two states with no outgoing transition in Section 7.4's table. Every other ending state (`completed`, `expired`, `revoked`, `failed`) funnels into `tearing_down`, and `cleanup_incomplete` can only return to `tearing_down`, never to `active`.

```mermaid
stateDiagram-v2
    [*] --> proposed
    proposed --> granted: consent_granted / user
    proposed --> declined: consent_declined / user
    proposed --> declined: consent_timed_out / clock
    granted --> active: activate / runtime
    granted --> failed: activation_failed / runtime
    granted --> revoked: revoke / user
    granted --> revoked: grant_revoked / provider
    granted --> revoked: entitlement_revoked / publisher
    granted --> expired: expire / clock
    active --> active: extend / user
    active --> completed: outcome_verified / verifier
    active --> expired: expire / clock
    active --> revoked: revoke / user
    active --> revoked: grant_revoked / provider
    active --> revoked: entitlement_revoked / publisher
    active --> failed: error_threshold_exceeded / policy
    active --> failed: runtime_failure / runtime
    completed --> tearing_down: begin_teardown / runtime
    expired --> tearing_down: begin_teardown / runtime
    revoked --> tearing_down: begin_teardown / runtime
    failed --> tearing_down: begin_teardown / runtime
    tearing_down --> cleaned_up: teardown_succeeded / runtime
    tearing_down --> cleanup_incomplete: teardown_incomplete / runtime
    cleanup_incomplete --> tearing_down: retry_teardown / user
    cleanup_incomplete --> tearing_down: retry_teardown / runtime
    declined --> [*]
    cleaned_up --> [*]
```

### 7.2 Actors

Every transition in Section 7.4 is attributed to exactly one of seven actors:

- `user`: the human who consented to the lease. Causes `consent_granted`, `consent_declined`, `revoke`, `extend` and `retry_teardown`.
- `verifier`: the outcome verification mechanism named in the manifest's `job.verifier` (Section 7.6). Causes `outcome_verified`.
- `policy`: the runtime's policy engine, evaluating limits such as the error threshold. Causes `error_threshold_exceeded`.
- `clock`: the runtime's injected clock, evaluated on every call rather than by a timer (Section 7.5). Causes `consent_timed_out` and `expire`.
- `provider`: the operator of a customer resource whose OAuth grant was revoked. Causes `grant_revoked`.
- `publisher`: the agent's publisher, revoking entitlement. Causes `entitlement_revoked`.
- `runtime`: the runtime itself, driving activation, failure, teardown and its own retries. Causes `activate`, `activation_failed`, `runtime_failure`, `begin_teardown`, `teardown_succeeded`, `teardown_incomplete` and `retry_teardown`.

The agent is never an actor: no event originating from the agent, including any tool call, tool result or message claiming completion, ends, extends or completes a lease. The runtime MUST attribute each event to the actor that actually produced it: an event's actor is not a caller-supplied claim but a fact the runtime itself establishes from the source of the trigger (a resolved user action, an evaluated predicate, an injected clock, a response from a provider or publisher, or the runtime's own code).

### 7.3 Events

- `consent_granted` (actor `user`): the user approved the manifest presented in `proposed`.
- `consent_declined` (actor `user`): the user declined the manifest presented in `proposed`.
- `consent_timed_out` (actor `clock`): the consent request was not answered before its timeout.
- `activate` (actor `runtime`): every delegated grant is acquired, a license is issued where required, and the presented manifest's content hash equals the consented hash.
- `activation_failed` (actor `runtime`): activation's guards did not hold (Section 7.4).
- `revoke` (actor `user`): the user ended the lease early.
- `grant_revoked` (actor `provider`): a provider revoked one of the lease's delegated OAuth grants.
- `entitlement_revoked` (actor `publisher`): the publisher revoked the agent's entitlement.
- `expire` (actor `clock`): the lease's `lease.max_duration_seconds` elapsed, evaluated against the injected clock.
- `extend` (actor `user`): the user granted fresh consent to move the lease's expiry further out (Section 7.5).
- `outcome_verified` (actor `verifier`): the manifest's `job.verifier` confirmed the job's outcome (Section 7.6).
- `error_threshold_exceeded` (actor `policy`): the manifest's `limits.error_threshold` was exceeded.
- `runtime_failure` (actor `runtime`): the runtime itself failed, including a content-hash mismatch detected on resume.
- `begin_teardown` (actor `runtime`): the runtime started the fixed teardown sequence (Section 10) after any ending state.
- `teardown_succeeded` (actor `runtime`): every teardown step completed.
- `teardown_incomplete` (actor `runtime`): at least one teardown step did not complete.
- `retry_teardown` (actor `user` or `runtime`): teardown was retried from `cleanup_incomplete`.

### 7.4 Transition Table

The following table is normative. Any (state, event, actor) triple not listed here MUST be rejected by an implementation and MUST NOT change the lease's state.

| From | Event | Actor | To |
|------|-------|-------|----|
| proposed | consent_granted | user | granted |
| proposed | consent_declined | user | declined |
| proposed | consent_timed_out | clock | declined |
| granted | activate | runtime | active |
| granted | activation_failed | runtime | failed |
| granted | revoke | user | revoked |
| granted | grant_revoked | provider | revoked |
| granted | entitlement_revoked | publisher | revoked |
| granted | expire | clock | expired |
| active | extend | user | active |
| active | outcome_verified | verifier | completed |
| active | expire | clock | expired |
| active | revoke | user | revoked |
| active | grant_revoked | provider | revoked |
| active | entitlement_revoked | publisher | revoked |
| active | error_threshold_exceeded | policy | failed |
| active | runtime_failure | runtime | failed |
| completed | begin_teardown | runtime | tearing_down |
| expired | begin_teardown | runtime | tearing_down |
| revoked | begin_teardown | runtime | tearing_down |
| failed | begin_teardown | runtime | tearing_down |
| tearing_down | teardown_succeeded | runtime | cleaned_up |
| tearing_down | teardown_incomplete | runtime | cleanup_incomplete |
| cleanup_incomplete | retry_teardown | user | tearing_down |
| cleanup_incomplete | retry_teardown | runtime | tearing_down |

`activate` is guarded: the presented manifest's content hash MUST equal the hash bound at consent, every delegated grant listed in `auth.delegated` MUST be acquired (delegated and hybrid modes), and a license MUST be issued (hosted and hybrid modes). A content-hash mismatch detected at activation yields `activation_failed`; the same mismatch detected on a runtime resume (for example after a restart) yields `runtime_failure` instead, since the lease was already active.

Every accepted transition MUST be recorded as a receipt with its actor (Section 11); the entry format for that receipt is `[OPEN: Phase 3]`.

Rationale: implementations SHOULD derive their state-machine reducer directly from this table, as a data structure rather than nested conditional logic, so that whether a transition is legal becomes a lookup rather than a re-derivation of the rules above.

### 7.5 Expiry, Extension and License Refresh

A lease's `expires_at` equals the time it was granted plus the manifest's `lease.max_duration_seconds`. The runtime MUST evaluate expiry on every tool call against its own clock; correctness MUST NOT depend on a timer that fires independently of calls (Section 13 documents the corresponding trust limit around detection latency).

`extend` is the only transition that moves `expires_at`, and it requires fresh user consent through the HostAdapter; a runtime MUST NOT extend a lease on the agent's request alone. The shape and bounds of an extension request are `[OPEN: Phase 2]`.

License refresh is distinct from lease extension. Refresh is routine and runtime-driven: the runtime renews a hosted or hybrid lease's license before its short TTL expires, without any user interaction. Refresh MUST NOT move `expires_at`, and no refreshed license may carry an expiry later than the lease's own `expires_at`. Token expiry, whether of a license or of a delegated OAuth grant, is not the same thing as entitlement ending; a token can expire and be refreshed many times across one lease's lifetime.

The runtime MUST re-check the manifest's content hash against the hash bound at consent both at activation and whenever the runtime resumes a lease it did not itself keep running continuously (for example after a process restart). A mismatch at activation yields `activation_failed`; a mismatch on resume yields `runtime_failure` (Section 7.3).

### 7.6 Outcome Verification

The manifest's `job.verifier` (Section 4) determines how, if at all, a lease reaches `completed`:

- `resource_query`: the runtime evaluates `job.verifier.predicate` against `job.verifier.resource` through the proxy, using runtime-held credentials, never publisher-supplied code. The predicate grammar is `[OPEN: Phase 5]`.
- `user_confirm`: the runtime asks the user, through the HostAdapter, whether the job's outcome is acceptable, using `job.verifier.prompt`.
- `none`: `completed` is unreachable for this lease; the lease can only end by expiry or by a user or policy action (Section 7.4).

An agent's own claim of being done, whether a tool result, a message, or any other agent-originated signal, never completes a lease; only the verifier actor, established by one of the mechanisms above, causes `outcome_verified` (Section 7.2).

## 8. Authorization Modes

A manifest's `auth.mode` is one of `delegated`, `hosted` or `hybrid`. `hybrid` is the default when `auth.mode` is absent.

- `delegated`: the runtime acquires one delegated OAuth grant per entry in `auth.delegated`, each linking a `provider` to the `resources` it grants access to. OAuth endpoints and client configuration are runtime connector configuration; they are never supplied by the publisher manifest. Access tokens carry RFC 8707 resource indicators and are injected by the proxy only on outbound calls; they are never returned to the agent. If any one customer grant is revoked, whether detected explicitly or lazily via `invalid_grant` or an HTTP 401 from the provider, the runtime MUST revoke the whole lease with actor `provider`.
- `hosted`: the publisher issues a PASETO v4.public license, identified by `auth.hosted.license_issuer` and optionally `auth.hosted.kid`, with a default TTL of 300 seconds. The TTL is not carried in the manifest. The license's claims and the derivation of any implicit assertions are `[OPEN: Phase 3]`. The runtime holds the license; the agent never does, and the license MUST NOT be forwarded to any customer resource.
- `hybrid`: both of the above apply together, a license for entitlement and delegated OAuth grants for customer resources.

## 9. Enforcement

Connector bindings are runtime-owned: they map each tool the proxy exposes to a `(resource, access class, irreversible)` classification. The manifest never names tools, and nothing in a manifest can change a tool's classification. Users approve any custom binding explicitly; the runtime never derives a binding from manifest content. The proxy is deny by default: a call with no matching binding MUST be denied.

Every `tools/call` the proxy receives gets an allow, deny, or require_approval decision from code outside the model: the agent never sees or influences the code that makes that decision.

Limits from the manifest's `limits` object are enforced per lease:

- `limits.actions_per_hour` is evaluated over a sliding 3600-second window.
- `limits.max_actions` is a hard cap on the total number of allowed actions across the lease's lifetime.
- `limits.spend.amount_minor` is tracked in integer minor units of the single currency named in `limits.spend.currency`.
- `limits.error_threshold` (`count` denied calls or upstream errors within `window_seconds`) ends the lease in `failed` with actor `policy` (Section 7.4).

All of the above run under per-lease serialization: state reads, limit-counter updates and transitions for one lease never race against concurrent calls to the same lease.

Approvals come from `approvals.require_for`, which accepts only `send`, `pay` or `irreversible`. `pay` always requires approval even if the manifest omits it from `require_for`. A runtime MAY add approval requirements beyond what the manifest states, but MUST NOT remove one the manifest or this rule requires. Approvals are dispatched out of band through the HostAdapter and MUST NOT be satisfied by MCP elicitation through the agent's own client, since that channel is one the agent itself could influence. Each approval is bound to a hash of the exact resolved arguments, the binding, and the lease version, so that anything changing between approval and execution invalidates the approval rather than silently reusing it; the binding hash format is `[OPEN: Phase 4]`. A timed-out approval denies.

Manifest `x-` prefixed metadata is ignored for every enforcement decision; it is display and audit metadata only.

```mermaid
sequenceDiagram
    participant Agent
    participant Proxy
    participant Policy as Policy Decision
    participant HostAdapter
    participant Provider
    Agent->>Proxy: tools/call
    Proxy->>Policy: evaluatePolicy(lease, call, binding, now)
    alt require_approval
        Policy-->>Proxy: require_approval
        Proxy->>HostAdapter: requestApproval(summary, binding)
        HostAdapter-->>Proxy: approved | denied | timeout
    else deny
        Policy-->>Proxy: deny
    else allow
        Policy-->>Proxy: allow
    end
    Proxy->>Provider: credential-bearing call
    Provider-->>Proxy: result
    Proxy-->>Agent: MCP tool result
    Proxy->>Proxy: append receipt
```

## 10. Teardown

Teardown starts the moment a lease enters `tearing_down` (Section 7.4). It runs a fixed sequence of five steps, in this order:

1. "Revoke" every OAuth grant the lease holds (RFC 7009).
2. "Invalidate" the publisher license: call the publisher's revocation endpoint and stop any refresh loop.
3. Run the publisher's "cleanup hook", authenticated by a single-use cleanup token scoped exactly `cleanup:<lease_id>`. Reuse of this token MUST be rejected. The token format is `[OPEN: Phase 5]`.
4. "Delete" cached lease data held by the runtime.
5. Write the "final signed receipt".

Each OAuth grant's revocation records one of three outcomes: `revoked`, `discarded_revocation_unsupported`, or `failed`. A 2xx response from a revocation endpoint MUST NOT be reported as more than RFC 7009 guarantees: RFC 7009 requires a success response even for a token the provider does not recognize or cannot revoke, so a 2xx alone is not proof of revocation.

A failing step does not stop the remaining steps from running. If every step succeeds, the lease moves to `cleaned_up`; if any step does not complete, the lease moves to `cleanup_incomplete` with every step's individual result recorded (Section 7.4). Retrying teardown resumes idempotently: it MUST NOT repeat a step that already completed. A lease that has entered teardown can never return to `active`. Receipts survive cleanup: the receipt log outlives the lease record itself.

```mermaid
sequenceDiagram
    participant Runtime
    participant OAuthProvider as OAuth Provider
    participant PublisherService as Publisher
    participant CleanupHook as Cleanup Hook
    Runtime->>OAuthProvider: revoke grant (RFC 7009)
    OAuthProvider-->>Runtime: revoked | discarded_revocation_unsupported | failed
    Runtime->>PublisherService: invalidate license
    PublisherService-->>Runtime: ok | failed
    Runtime->>CleanupHook: cleanup:<lease_id> (single use)
    CleanupHook-->>Runtime: ok | failed
    Runtime->>Runtime: delete cached lease data
    Runtime->>Runtime: write final signed receipt
```

## 11. Receipts

Every tool call, allowed or denied, and every state transition and teardown step, appends a receipt. Receipts live in one of two hash chains: the verified chain (facts the runtime itself observed) and the attested chain (publisher-signed claims the runtime relays on trust). Each chain has independent integrity: its own hash links and its own signed checkpoints, hashed with the canonical serialization defined in Section 5. The two chains are never interleaved.

The runtime signs a checkpoint with Ed25519 at least at every lease-ending event, plus a final signed receipt at teardown. The entry format for a receipt and a checkpoint is `[OPEN: Phase 3]`.

A call receipt holds an args hash and a binding-redacted summary; it never holds raw arguments, tokens or the license. Verifying a tampered or truncated chain MUST report the exact point the chain broke, relative to the last valid checkpoint, rather than a generic failure.

The merged timeline a user sees combines both chains for display only, marking each entry `verified` or `attested`; this merge never touches either chain's hash linkage or signatures, and its ordering carries no integrity meaning of its own; only the two chains' own checkpoints do. The merge is display-only.

## 12. Trust Model

The runtime is the protocol's enforcement point. It MUST be operated by the user themselves or by a neutral party; a runtime operated by the publisher, or by any party with an incentive to weaken enforcement, defeats the guarantee in Section 1.

The agent is untrusted: nothing it says, including a claimed tool result or a claimed job outcome, is treated as fact by the state machine or the policy engine (Sections 7 and 9).

The publisher's identity is established by its manifest signature (Section 5); the publisher's other claims, such as data-retention promises, are attested, not independently verified.

Providers are authoritative for their own resources: what a provider's API allows or denies is the provider's decision, not the runtime's to override.

The host is trusted to render consent faithfully: to show the user what the manifest actually requests, not a misleading summary of it.

The system is deny by default at every layer: an unbound tool, an unmatched (state, event, actor) triple, and a timed-out approval all resolve to denial, never to an implicit allow.

## 13. Trust Limits

This protocol has four documented limits that no implementation can remove by building harder:

1. Attested receipts prove integrity, not completeness: a publisher-signed claim proves the publisher said it, not that the claim is the whole truth.
2. Leases cannot stop cross-resource data flow: once an agent legitimately reads a resource, this protocol has no mechanism to prevent that agent from correlating it with data from another resource it also legitimately reads.
3. Publisher-side data deletion is attested, not verified: when a publisher reports that it deleted retained data (`cleanup.publisher_retains`), the runtime cannot independently confirm this; it can only relay the publisher's claim.
4. The runtime must be operated by the user or a neutral party: if it is operated by an interested party instead, every guarantee in this document depends on that operator's honesty rather than on the protocol's own mechanisms.

Additional limits worth stating plainly: the proxy governs MCP tool calls, not the agent process's own network egress, so this protocol makes no claim about traffic the agent process might send outside the proxy. Offline-verifiable licenses (Section 8) cannot be revoked instantly; revocation latency is bounded by the license's TTL, not by the moment revocation is requested. A provider without RFC 7009 support yields `discarded_revocation_unsupported`, not a verified revocation (Section 10). Publisher signing-key custody is outside the runtime's control; a compromised publisher key is a publisher-side incident this protocol cannot detect on its own.

## 14. Security Considerations

Prompt injection: the core guarantee of this protocol (Section 1) is that a prompt-injected agent cannot act outside its lease, because every tool call is decided by code outside the model. This document makes no claim about detecting or preventing the injection itself.

Confused deputy and token passthrough: the runtime MUST NOT forward a raw delegated OAuth token, or the publisher license, to the agent or to any party outside the runtime's trusted boundary; the proxy performs every credential-bearing call itself (Section 9).

Approval TOCTOU: an approval binds a hash of the exact resolved arguments, the binding, and the lease version (Section 9); anything that changes between approval and execution invalidates the approval rather than silently reusing it.

Secrets in errors, logs and receipts: an error caught from an OAuth, HTTP or license library call MUST be sanitized into a fixed, non-interpolated message before it reaches any log or receipt path; receipts never hold raw arguments, tokens or the license (Section 11).

Manifest tampering and key rotation: a lease binds the manifest's content hash at consent (Section 5); any later change to the manifest is detected as a hash mismatch, not silently accepted. Publisher keys rotate by `kid`; a runtime trust store MAY hold multiple keys per publisher to support this.

Clock handling: expiry and license verification MUST use an explicit, tested clock-skew tolerance, never a library's default of zero, and MUST re-evaluate on every call rather than caching a validity result (Section 7.5).

Size and depth caps: a runtime MUST bound manifest size, string field lengths and array sizes (the canonical schema in Section 4 already sets per-field limits) to avoid resource exhaustion from an oversized manifest.

Consent-display spoofing: the host renders consent from manifest fields; a runtime SHOULD restrict the character set of identifiers (Section 4) rendered into a consent screen, so that a manifest's `agent.id` or `publisher.id` cannot smuggle in a display-spoofing sequence.

## 15. Conformance

<!-- ALP-PENDING: 01-05 -->

## 16. References

Normative references:

- [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119): Key words for use in RFCs to Indicate Requirement Levels
- [RFC 8174](https://www.rfc-editor.org/rfc/rfc8174): Ambiguity of Uppercase vs Lowercase in RFC 2119 Key Words
- [RFC 8785](https://www.rfc-editor.org/rfc/rfc8785): JSON Canonicalization Scheme (JCS)
- [RFC 7515](https://www.rfc-editor.org/rfc/rfc7515): JSON Web Signature (JWS)
- [RFC 8037](https://www.rfc-editor.org/rfc/rfc8037): CFRG Elliptic Curve Diffie-Hellman and Signatures in JSON Object Signing and Encryption (JOSE)
- [RFC 8032](https://www.rfc-editor.org/rfc/rfc8032): Edwards-Curve Digital Signature Algorithm (EdDSA)
- [RFC 7009](https://www.rfc-editor.org/rfc/rfc7009): OAuth 2.0 Token Revocation
- [RFC 8707](https://www.rfc-editor.org/rfc/rfc8707): Resource Indicators for OAuth 2.0
- [JSON Schema draft-07](https://json-schema.org/draft-07/json-schema-release-notes): JSON Schema Validation, draft-07
- [OAuth 2.1](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1): The OAuth 2.1 Authorization Framework (Internet-Draft)
- [PASETO v4](https://github.com/paseto-standard/paseto-spec): Platform-Agnostic Security Tokens, version 4
- [Model Context Protocol](https://modelcontextprotocol.io/specification): the Model Context Protocol specification
