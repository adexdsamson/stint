# Phase 2: Lease State Machine & Policy Engine - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-09-27
**Phase:** 02-lease-state-machine-policy-engine
**Areas discussed:** Lease model + reducer output, Policy engine boundary, HostAdapter interface, LeaseStore contract + serialization, Actor-attribution enforcement, Connector-binding representation, Resume + hash-recheck path, Manifest-hash binding on the lease

---

## Lease model + reducer output

| Option | Description | Selected |
|--------|-------------|----------|
| On the Lease object | Single serialized aggregate both reducer and policy read | ✓ |
| Separate LeaseCounters record | Counters keyed by lease id, stored alongside | |
| Derived from transition/receipt log | Recompute by replaying history | |

**User's choice:** On the Lease object (→ CONTEXT D-01)

| Option | Description | Selected |
|--------|-------------|----------|
| Reducer returns lease + TransitionRecord | Structured record caller persists; Phase 3 consumes | ✓ |
| Append log array inside the Lease | Lease carries full transition array | |
| Only current state; history in receipts | Deferred entirely to Phase 3 | |

**User's choice:** Reducer returns lease + TransitionRecord (→ CONTEXT D-02)

| Option | Description | Selected |
|--------|-------------|----------|
| reduce(lease,event,now) => Result | Structured rejection for illegal triple | ✓ |
| reduce throws on illegal transition | Simpler call sites, breaks Result convention | |
| reduce returns lease + changed flag | Loses structured rejection reason | |

**User's choice:** reduce(lease, event, now) => Result (→ CONTEXT D-03)

| Option | Description | Selected |
|--------|-------------|----------|
| extend carries added seconds, capped by manifest | delta bounded by lease.max_duration_seconds | ✓ |
| extend sets rolling new window | expires_at = now + max_duration | |
| extend carries absolute expires_at, uncapped | Caller supplies new absolute expiry | |

**User's choice:** extend carries added seconds, capped by manifest (→ CONTEXT D-06)

---

## Policy engine boundary

| Option | Description | Selected |
|--------|-------------|----------|
| Two pure functions | evaluatePolicy decides call; separate error-threshold check | ✓ |
| One function returns decision + optional state event | Couples call-decision to transition | |
| Fold threshold into the reducer | Reducer owns counter logic | |

**User's choice:** Two pure functions (→ CONTEXT D-09)

| Option | Description | Selected |
|--------|-------------|----------|
| Discriminated union + stable reason codes | allow/deny(reason)/require_approval(requirement) | ✓ |
| Plain enum string | Loses machine-readable reason | |
| boolean + message | Loses require_approval as first-class | |

**User's choice:** Discriminated union + stable reason codes (→ CONTEXT D-10)

| Option | Description | Selected |
|--------|-------------|----------|
| Receives resolved binding-or-undefined | undefined → deny('no_binding'); never reads manifest | ✓ |
| Receives bindings table + tool name | Policy does lookup itself | |
| Caller pre-resolves access class | Loses no-binding signal | |

**User's choice:** Receives resolved binding-or-undefined (→ CONTEXT D-11)

| Option | Description | Selected |
|--------|-------------|----------|
| Policy denies past-expiry; reducer transitions | Enforcement and transition distinct | ✓ |
| Only reducer's expire event guards expiry | Risks a pre-expiry window | |
| Policy both denies and returns expire event | Re-couples decision and transition | |

**User's choice:** Policy denies past-expiry; reducer transitions (→ CONTEXT D-07)

---

## HostAdapter interface

| Option | Description | Selected |
|--------|-------------|----------|
| Three methods: requestConsent, requestApproval, notify | notify takes discriminated LifecycleEvent union | ✓ |
| Per-event notify methods | Interface grows with every event | |
| Consent+approval + EventEmitter notifications | Second contract to document | |

**User's choice:** Three methods (→ CONTEXT D-15)

| Option | Description | Selected |
|--------|-------------|----------|
| All async (Promise-returning) | Fits out-of-band consent/approval | ✓ |
| Sync | Blocking model doesn't fit real UIs | |
| Mixed | Inconsistent contract | |

**User's choice:** All async (→ CONTEXT D-16)

| Option | Description | Selected |
|--------|-------------|----------|
| Core owns it via deadline + AbortSignal | Deny-by-default stays in core | ✓ |
| Adapter must honor timeout | Buggy adapter could fail-open | |
| Shared timeout helper adapters call | Relies on adapter opting in | |

**User's choice:** Core owns it via deadline + AbortSignal (→ CONTEXT D-17)

| Option | Description | Selected |
|--------|-------------|----------|
| Redacted summary + binding + request id; core enforces bind | Never raw args | ✓ |
| Adapter receives raw args and checks binding hash | Exposes raw args to third-party code | |
| Adapter receives only a text prompt | Drops the binding entirely | |

**User's choice:** Redacted summary + binding + request id; core enforces the bind (→ CONTEXT D-18)

---

## LeaseStore contract + serialization

| Option | Description | Selected |
|--------|-------------|----------|
| Async load / save / list / delete | Covers proxy/teardown/CLI needs | ✓ |
| Minimal load / save only | Later phases need list/delete anyway | |
| Event-sourced append / replay | Heavier; receipts own the log | |

**User's choice:** Async load / save / list / delete (→ CONTEXT D-13)

| Option | Description | Selected |
|--------|-------------|----------|
| In the LeaseStore contract as a serialized RMW primitive | transaction(id, mutate); tested; file store uses proper-lockfile | ✓ |
| Core-level in-process mutex only | Won't serialize across CLI + proxy processes | |
| Optimistic version check + retry | Retry loops / lost-update handling | |

**User's choice:** Serialized read-modify-write primitive in the contract (→ CONTEXT D-13)

| Option | Description | Selected |
|--------|-------------|----------|
| Yes — monotonic version per transition | Needed for §9 approval binding | ✓ |
| No — rely on serialization primitive | §9 binding has nothing stable to reference | |

**User's choice:** Yes — version field (→ CONTEXT D-04)

| Option | Description | Selected |
|--------|-------------|----------|
| @stint/core/testing subpath export | Reusable factory; Phase 6 reuses | ✓ |
| Inline in core's test folder only | Phase 6 duplicates; risks drift | |
| In @stint/spec/testing | Wrong package boundary | |

**User's choice:** @stint/core/testing subpath export (→ CONTEXT D-14)

---

## Actor-attribution enforcement

| Option | Description | Selected |
|--------|-------------|----------|
| Actor-namespaced event constructors + reducer table check | No agent-reachable path to a lifecycle event | ✓ |
| Single Event union with actor field, validated by reducer | Nothing stops a wrong call site setting actor | |
| Capability-token gated events | Heavier machinery than needed | |

**User's choice:** Actor-namespaced constructors + reducer table check (→ CONTEXT D-19)

---

## Connector-binding representation

| Option | Description | Selected |
|--------|-------------|----------|
| BindingSet keyed by tool, each with provenance flag | built-in vs. user-approved custom | ✓ |
| Plain Map<tool, {resource, access, irreversible}> | No provenance | |
| Bindings attached per-lease | Duplicates runtime config; drift risk | |

**User's choice:** BindingSet keyed by tool with provenance (→ CONTEXT D-12)

---

## Resume + hash-recheck path

| Option | Description | Selected |
|--------|-------------|----------|
| Shared hash guard, two entry points | activate → activation_failed; resume → runtime_failure | ✓ |
| Single function with mode flag | Mode flag changes safety-critical behavior | |
| Caller (proxy) does the hash re-check | Pushes safety logic out of pure core | |

**User's choice:** Shared hash guard, two entry points (→ CONTEXT D-21)

---

## Manifest-hash binding on the lease

| Option | Description | Selected |
|--------|-------------|----------|
| Only the bound hash string | activate/resume recompute + string-compare | ✓ |
| Full VerifiedManifest on the lease | Bloats every lease record | |
| Hash + a full manifest copy | Redundant; two representations can disagree | |

**User's choice:** Only the bound hash string (→ CONTEXT D-20)

---

## Claude's Discretion

- Exact TypeScript type/function names encoding the decisions.
- Exact `PolicyDecision.deny` reason-code string values beyond the listed examples.
- Internal representation of counter timestamps (array vs. window struct), as long as windows use injected `now` with no timers.
- Internal layout of the transition-table data structure (must match ALP.md §7.4).
- Whether `transaction`/`withLease` is the sole mutation path or `save` is also public, provided the contract test proves serialization.
- Module/file breakdown within `@stint/core` and its `/testing` subpath.

## Deferred Ideas

- Receipt entry format + hash-chained signed log (Phase 3).
- License issuance / PASETO claims / refresh internals (Phase 3).
- Live MCP proxy routing (Phase 4).
- Approval binding-hash format (`[OPEN: Phase 4]`).
- `resource_query` verifier predicate grammar (Phase 5).
- JSON-file LeaseStore + proper-lockfile (HOST-03, Phase 6).
- CLI HostAdapter reference implementation (HOST-02, Phase 6).
