# Phase 2: Lease State Machine & Policy Engine - Context

**Gathered:** 2026-09-27
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 2 delivers the pure, fully-tested enforcement core in `@stint/core`: the code, outside the model, that owns every lifecycle transition and every allow/deny/require_approval decision, so no agent behavior can end, extend, or exceed a lease.

It delivers:

1. A **table-driven pure reducer** for the eleven-state lease machine, matching ALP.md §7.4's normative transition table exactly, with actor attribution (LIFE-01, LIFE-02).
2. **Manifest-hash binding** on the lease and the guarded `activate` / resume paths (LIFE-03).
3. **Per-call expiry** enforcement against an injectable clock, and the **extension** mechanics that fill the `[OPEN: Phase 2]` marker (LIFE-04, LIFE-05).
4. A **pure policy function** returning allow/deny/require_approval from the lease, runtime-owned connector bindings, and an injectable clock, plus the **error-threshold** check that ends a lease in `failed` with actor `policy` (PRXY-02, PRXY-03, LIFE-07).
5. The **`HostAdapter`** contract exported by `@stint/core` (consent, per-call approval, lifecycle notifications) — HOST-01.
6. **Enabling work:** the **`LeaseStore`** contract with an in-memory test double and a shared, reusable contract-test suite (the proxy in Phase 4 and teardown in Phase 5 depend on it).

**Not in this phase:** the live MCP proxy wiring (Phase 4), receipt entry format / hash-chained log (Phase 3), license issuance/refresh internals (Phase 3), the JSON-file `LeaseStore` with Windows atomicity (HOST-03, Phase 6), the CLI `HostAdapter` reference implementation (HOST-02, Phase 6), the predicate grammar for `resource_query` verifiers (Phase 5), and the approval binding-hash format (`[OPEN: Phase 4]`). Phase 2 defines the interfaces those phases fill in.

Requirements: LIFE-01, LIFE-02, LIFE-03, LIFE-04, LIFE-05, LIFE-07, HOST-01, PRXY-02, PRXY-03.

</domain>

<decisions>
## Implementation Decisions

### Lease model & reducer
- **D-01:** Mutable limit counters (running action count, spend total, and the denial/error timestamps used for `error_threshold` and `actions_per_hour`) live **on the `Lease` object** as a single serialized aggregate. Both the reducer and the pure policy function read them, so policy stays a pure function of `(lease, call, binding, now)`.
- **D-02:** The reducer returns a new lease **plus a structured `TransitionRecord`** (at minimum `{ from, event, actor, to, at }`) that the caller persists. Phase 3 receipts consume that record. The `Lease` stays lean — it does not carry its own full transition-log array.
- **D-03:** Reducer signature is `reduce(lease, event, now) => Result<{ lease, transition }>`, following `@stint/spec`'s Result-not-throw convention (D-30). An illegal `(state, event, actor)` triple — i.e. any triple not in ALP.md §7.4 — returns a **structured rejection** (stable code + context), never a throw and never a silent no-op. The injectable clock `now` is passed in for `expire` / `consent_timed_out` reasoning. — **Reversibility:** costly — `reduce` and the `Result`/rejection shape are the public core API that the proxy, teardown, and CLI all call; changing the signature later touches every call site.
- **D-04:** The `Lease` carries a **monotonic `version`** that the reducer increments on every accepted transition. It is needed anyway for the ALP.md §9 approval binding ("bound to ... the lease version") and doubles as a conflict-detection aid alongside the LeaseStore serialization primitive (D-13). — **Reversibility:** costly — `version` becomes part of the persisted lease shape and the approval-binding contract.
- **D-05:** The reducer must be **derived directly from a data table** (a lookup keyed by `(state, event)` yielding `{ actor, to }`), per ALP.md §7.4's rationale — not nested conditionals. The test suite must exercise **every legal transition** and assert **every illegal `(state, event)` / wrong-actor pair is rejected**. — **Reversibility:** one-way — the transition table is the normative ALP.md §7.4 contract; changing a transition changes the published protocol. A cross-check test that the table matches ALP.md §7.4 is in scope.

### Extension & expiry ([OPEN: Phase 2] resolved)
- **D-06:** `extend` (actor `user`) carries an **integer seconds delta**; the new `expires_at = old expires_at + delta`, with `delta` bounded by the manifest's `lease.max_duration_seconds` per extension (each extension is a fresh, consented, bounded step). `extend` is the only event that moves `expires_at` (ALP.md §7.5). — **Reversibility:** costly — the extension-request shape and the per-extension cap become part of the lease API and the ALP.md `[OPEN: Phase 2]` fill-in.
- **D-07:** Per-call expiry (LIFE-04) is enforced by the **policy function first**: `evaluatePolicy` denies a call when `now >= expires_at` with reason `expired`. The actual `expire` **state transition** (actor `clock`) is dispatched separately by the caller through the reducer. Enforcement (deny the call) and state advance (move to `expired`) stay distinct. No timers anywhere; expiry is a pure comparison against injected `now`.
- **D-08:** Lease extension and license refresh are strictly separate (LIFE-05): the extension mechanics above require fresh user consent through the `HostAdapter`; **no license-refresh path may move `expires_at`.** (License refresh internals themselves are Phase 3; Phase 2 only guarantees the reducer has no event by which a refresh could change expiry — only `extend` moves it.)

### Policy engine
- **D-09:** The policy engine is **two pure functions**: `evaluatePolicy(...)` decides one call (allow / deny / require_approval), and a separate pure check reports when the error window is exceeded. When the error check trips, the **caller** feeds an `error_threshold_exceeded` event (actor `policy`) to the reducer. "Decide a call" and "advance state" stay cleanly separated. LIFE-07's boundary: N denials/upstream errors in the window trip `failed`; N-1 do not (explicit test).
- **D-10:** The policy decision type is a **discriminated union with stable reason codes**: `{ decision: 'allow' } | { decision: 'deny', reason } | { decision: 'require_approval', requirement }`. `reason` is a stable code enum (e.g. `no_binding`, `expired`, `over_max_actions`, `over_actions_per_hour`, `over_spend`), mirroring `@stint/spec`'s D-31 approach where host UIs depend on stable codes. — **Reversibility:** costly — the reason-code set is a public API host UIs consume; add codes freely, but renaming/removing breaks consumers.
- **D-11:** Policy gets a tool's classification from a **resolved binding-or-`undefined`**: the caller resolves the runtime-owned `ConnectorBinding` for the tool and passes it; `undefined` → `deny('no_binding')` (PRXY-02). Policy **never reads the manifest** for classification (PRXY-03). A test must assert a manifest labeling a `send` tool as `read` cannot change the tool's binding-derived classification.

### Connector bindings
- **D-12:** A `ConnectorBinding` is `{ tool, resource, access, irreversible }`. A runtime-owned **`BindingSet`** looks bindings up by tool name, and each binding carries **provenance** (built-in vs. user-approved custom) so a run can require an approved custom binding if it wants. Bindings are runtime-owned (not per-lease, not manifest-derived), consistent with ALP.md §9 "the runtime never derives a binding from manifest content." `access` items are only `read | write | send | pay`.

### LeaseStore (enabling work)
- **D-13:** `LeaseStore` is an **async interface**: `load(id) => Lease | undefined`, `save(lease)`, `list()`, `delete(id)`, plus a **serialized read-modify-write primitive** `transaction(id, mutate)` (a.k.a. `withLease`). The per-lease serialization ALP.md §9 requires (no races between state reads, counter updates, and transitions) lives **in the store contract** and is verified by the shared contract test. The in-memory double implements `transaction` with a per-id promise chain; the Phase 6 JSON-file store will use `proper-lockfile` for cross-process (CLI + proxy) safety. — **Reversibility:** costly — `LeaseStore` is the contract Phases 4, 5, and 6 implement/consume; interface changes ripple across them.
- **D-14:** The **in-memory test double** and a **reusable contract-test factory** are exported from a new `@stint/core/testing` subpath (mirroring the `@stint/spec/testing` pattern from D-30). Phase 6's JSON-file store imports and runs the identical suite so the two stores cannot drift.

### HostAdapter (HOST-01)
- **D-15:** `HostAdapter` is a **three-method** interface: `requestConsent`, `requestApproval`, and `notify(event: LifecycleEvent)` where `LifecycleEvent` is a discriminated union (activated, completed, expired, revoked, failed, teardown states, …). One small interface a platform builder implements; new lifecycle events don't grow the method set. — **Reversibility:** costly — `HostAdapter` is a published contract platform builders implement (HOST-01); the CLI reference impl (HOST-02) and every host depend on its shape.
- **D-16:** All `HostAdapter` methods are **async (Promise-returning)**. Consent and approval are inherently out-of-band/interactive (ALP.md §9: dispatched out of band, never via MCP elicitation through the agent's client).
- **D-17:** **Core owns the "timeout → deny/decline" rule.** Core passes the adapter a deadline / `AbortSignal` and treats a non-response (or abort) as deny (approval) / decline (consent). Deny-by-default enforcement is never delegated to third-party adapter code (ALP.md: a timed-out approval denies; approval timeout defaults to deny). The timeout value is injectable for tests.
- **D-18:** `requestApproval` receives a **binding-redacted summary, the `ConnectorBinding`, and an opaque approval-request id** — never raw args (consistent with receipts storing an args-hash only). Core computes/checks the approval binding over resolved args + binding + lease `version`; the Phase 2 interface carries the id, and the binding-**hash** mechanics land in Phase 4 (`[OPEN: Phase 4]`).

### Actor-attribution enforcement (LIFE-02)
- **D-19:** Actor attribution is made **structural**: core exports **actor-namespaced event constructors** (e.g. `userEvents.revoke` / `userEvents.extend` / `userEvents.retryTeardown`, `clockEvents.expire(now)` / `clockEvents.consentTimedOut`, `policyEvents.errorThresholdExceeded`, `providerEvents.grantRevoked`, `publisherEvents.entitlementRevoked`, `verifierEvents.outcomeVerified`, `runtimeEvents.*`). The reducer **independently rejects** any `(state, event, actor)` not in the §7.4 table. The agent boundary (the proxy, Phase 4) only ever turns an agent `tools/call` into a **policy decision** — it never imports these lifecycle-event constructors — so there is no code path from an agent message to a lifecycle transition. This is how "the agent is never an actor" (ALP.md §7.2) is guaranteed in code, not just documented. A test must assert every agent-reachable path cannot end or extend a lease.

### Manifest-hash binding & resume (LIFE-03)
- **D-20:** The `Lease` persists **only the bound hash string** (the prefixed `sha256:` / `jcs-sha256:` form from D-02 of Phase 1) captured at consent. `activate` / resume take the presented `VerifiedManifest` as an argument, recompute its hash via `@stint/spec` `hashManifest`, and **string-compare** against the bound hash. The manifest/envelope itself is not stored on the lease (matches Phase 1 D-08: binds content hash only). Keeps the lease small and serializable.
- **D-21:** A **single shared pure hash guard** (e.g. `verifyBoundHash`) is consumed by **two entry points**: `activateLease` emits `activation_failed` (actor `runtime`) on mismatch; the resume path emits `runtime_failure` (actor `runtime`) on the same mismatch (ALP.md §7.4 / §7.5: activation mismatch → `activation_failed`; resume mismatch → `runtime_failure`). DRY guard, distinct failure events. Safety-critical hash re-check stays inside the tested pure core, not in the caller.

### Claude's Discretion
- Exact TypeScript names for types/functions (`Lease`, `LeaseEvent`, `TransitionRecord`, `PolicyDecision`, `ConnectorBinding`, `BindingSet`, `HostAdapter`, `LifecycleEvent`, `LeaseStore`, `reduce`, `evaluatePolicy`, `activateLease`, `verifyBoundHash`, etc.) as long as they encode the decisions above.
- Exact reason-code string values in `PolicyDecision.deny` beyond the examples in D-10.
- Exact representation of the counter timestamps (array of epoch-seconds vs. a small ring/window struct) as long as sliding windows are computed against injected `now` with no timers.
- Internal layout of the transition table data structure, provided it is a lookup and matches ALP.md §7.4.
- Whether `transaction`/`withLease` is the sole mutation path or `save` is also public, provided the contract test proves serialization.
- Module/file breakdown within `@stint/core` and the `@stint/core/testing` subpath.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Protocol (normative — the reducer and policy MUST match these)
- `spec/ALP.md` §7.1 — the eleven states (terminal vs non-terminal)
- `spec/ALP.md` §7.2 — the seven actors and "the agent is never an actor"
- `spec/ALP.md` §7.3 — the seventeen events and their actors
- `spec/ALP.md` §7.4 — the **normative transition table** the Phase 2 reducer MUST reproduce exactly; `activate` guards
- `spec/ALP.md` §7.5 — expiry per call, extension requires fresh consent, license refresh never moves expiry, resume hash re-check
- `spec/ALP.md` §7.6 — outcome verification (`resource_query` / `user_confirm` / `none`); agent claims never complete a lease
- `spec/ALP.md` §8 — auth modes (`delegated` / `hosted` / `hybrid`) as they bear on `activate` guards
- `spec/ALP.md` §9 — enforcement: runtime-owned bindings, deny by default, allow/deny/require_approval, limits semantics, approvals out-of-band + bound to args/binding/lease-version, `x-` ignored, per-lease serialization
- `spec/manifest.schema.json` — the `limits`, `approvals`, `auth`, `lease` fields the policy engine reads (Phase 1 D-13..D-17)

### Project scope & requirements
- `.planning/PROJECT.md` — design-review decisions: widened termination actors, states list, refresh vs extension, expiry per call, runtime-owned bindings, single HostAdapter, approval-timeout-denies, pluggable LeaseStore
- `.planning/REQUIREMENTS.md` — LIFE-01..05, LIFE-07, HOST-01, PRXY-02, PRXY-03 acceptance text
- `.planning/ROADMAP.md` §Phase 2 — success criteria and the "Enabling work" note (LeaseStore contract + in-memory double + shared contract tests)
- `.planning/phases/01-foundation-alp-spec/01-CONTEXT.md` — Phase 1 decisions this phase builds on (esp. D-01/D-02 hash format, D-08 bind content hash only, D-30 Result API + `/testing` subpath pattern, D-31 stable error codes)

### Stack & pitfalls
- `.claude/CLAUDE.md` — pinned versions; `proper-lockfile` (for the Phase 6 file store), Vitest, TS 5.9.3 strict, ESM-only, Node 22.18+
- `.planning/research/ARCHITECTURE.md` — package boundaries (`spec → core → proxy/cli`), verified-vs-attested chains, manifest verification flow
- `.planning/research/PITFALLS.md` — enforcement/serialization pitfalls

### @stint/spec integration surface (already built in Phase 1)
- `packages/spec/src/index.ts` — `hashManifest`, `validateManifest`, `verifyEnvelope`, `canonicalize`, and the `VerifiedManifest` branded type that `activate`/resume consume
- `packages/spec/src/generated/manifest.ts` — generated manifest types (`limits`, `approvals`, `auth`, `lease`, scopes)

### External standards
- RFC 8785 (JCS) — only via `@stint/spec`'s canonical serializer; Phase 2 must not re-implement hashing

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `@stint/spec` public API: `hashManifest`, `validateManifest`, `verifyEnvelope`, `canonicalize`, `VerifiedManifest` (branded). `activateLease` / `verifyBoundHash` consume `hashManifest` + `VerifiedManifest` — no new hashing in `@stint/core`.
- `@stint/spec/testing` subpath (from Phase 1 D-30): the model to mirror for the new `@stint/core/testing` subpath (in-memory `LeaseStore` double + contract-test factory).
- Generated manifest types in `@stint/spec` supply the `limits`, `approvals`, `auth`, and `lease` shapes the policy engine reads.

### Established Patterns
- ESM-only, TS strict, project references (`composite: true`), `workspace:*` linking (CLAUDE.md).
- Result-not-throw for public functions (D-30); stable machine-readable code enums for anything host UIs consume (D-31).
- `@stint/core` currently holds only a smoke test — this phase is its first real implementation. It already sits at `spec → core → proxy/cli` in the dependency graph.

### Integration Points
- `@stint/core` imports `@stint/spec` (hash + `VerifiedManifest`).
- `@stint/core` exports the `LeaseStore` and `HostAdapter` contracts that Phase 4 (proxy), Phase 5 (teardown), and Phase 6 (JSON-file store, CLI HostAdapter) implement/consume.
- The pure `reduce` + `evaluatePolicy` + error-threshold check are what the Phase 4 proxy routes every live `tools/call` through.

</code_context>

<specifics>
## Specific Ideas

- The reducer is a literal data-table lookup, and a test cross-checks it against ALP.md §7.4 so the code and the spec cannot silently diverge.
- The agent-can-never-act-outside-the-lease guarantee is enforced *structurally* (actor-namespaced constructors + the proxy boundary never importing them), not merely asserted in prose — and a test proves no agent-reachable path can end or extend a lease.
- Everything time-related (expiry, extension bounds, sliding windows, approval/consent timeouts) is driven by an injectable clock/deadline so the whole core is deterministically testable with no real timers.

</specifics>

<deferred>
## Deferred Ideas

- Receipt entry format and the hash-chained, signed receipt log that consumes each `TransitionRecord` — Phase 3 (RCPT-*).
- License issuance / PASETO claims / refresh internals — Phase 3; Phase 2 only guarantees no refresh path moves `expires_at`.
- The live MCP proxy that routes `tools/call` through `evaluatePolicy` and dispatches lifecycle events — Phase 4 (PRXY-01+).
- Approval binding-**hash** format over resolved args + binding + lease version — `[OPEN: Phase 4]`; Phase 2 defines the interface that carries the request id.
- `resource_query` verifier predicate grammar — Phase 5.
- JSON-file `LeaseStore` with NTFS-atomic writes + `proper-lockfile` cross-process locking (HOST-03) — Phase 6; it runs the Phase 2 shared contract-test suite.
- CLI `HostAdapter` reference implementation (HOST-02) — Phase 6.

None of the above were re-scoped into Phase 2; discussion stayed within the phase boundary.

</deferred>

---

*Phase: 02-lease-state-machine-policy-engine*
*Context gathered: 2026-09-27*
