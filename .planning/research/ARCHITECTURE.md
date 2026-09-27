# Architecture Research

**Domain:** Agent lease runtime / MCP proxy gateway with OAuth delegation, signed licenses, tamper-evident audit log
**Researched:** 2026-09-27
**Confidence:** MEDIUM-HIGH (MCP gateway patterns and Trillian/CT log design are well-documented industry patterns; the specific combination — lease lifecycle + dual-chain receipts + connector-bound scope enforcement — is Stint's own synthesis, so those parts are HIGH confidence in reasoning but unverified against a prior art implementation)

## Standard Architecture

### System Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│  AGENT PROCESS (untrusted)                                            │
│  Publisher-authored agent, holds no real credentials                  │
└───────────────────────────────┬────────────────────────────────────--┘
                                 │ MCP (stdio/HTTP) — tools/list, tools/call
                                 ▼
┌──────────────────────────────────────────────────────────────────────┐
│  @stint/proxy  — MCP Proxy Server (PEP)                               │
│  ┌────────────┐ ┌───────────────┐ ┌──────────────┐ ┌───────────────┐ │
│  │ tools/list │ │ tools/call    │ │ Approval      │ │ Receipt       │ │
│  │ filter     │ │ interceptor   │ │ dispatcher    │ │ writer        │ │
│  └─────┬──────┘ └──────┬────────┘ └──────┬───────┘ └──────┬────────┘ │
│        │               │  calls PDP      │  calls out      │ appends │
│        │               ▼                 ▼                 ▼         │
│        │        ┌─────────────────────────────┐    ┌──────────────┐  │
│        │        │  @stint/core Policy Engine   │    │ Receipt Log  │  │
│        │        │  (pure fn: lease+call→verdict)│   │ (hash chain) │  │
│        │        └───────────────┬───────────────┘    └──────────────┘ │
│        │                        │ reads                                │
│        │                        ▼                                     │
│        │        ┌─────────────────────────────┐                       │
│        └───────▶│  Connector Binding Registry  │◀── runtime-owned,     │
│                 │  tool → (resource, access,   │    never from          │
│                 │  irreversible)                │    publisher manifest │
│                 └───────────────┬───────────────┘                     │
│                                 │                                      │
│                 ┌───────────────▼───────────────┐                     │
│                 │  Credential Vault              │                     │
│                 │  (injects real tokens outbound,│                     │
│                 │   agent never sees them)       │                     │
│                 └───────────────┬───────────────┘                     │
└─────────────────────────────────┼─────────────────────────────────────┘
                                   │ authenticated calls, real credentials
                                   ▼
                 ┌─────────────────────────────────────┐
                 │  Downstream MCP servers / resources  │
                 │  (Paystack, Sheets, etc.)             │
                 └───────────────────────────────────────┘

  Cross-cutting, driven by @stint/core state machine + HostAdapter:
  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐
  │ Lease State   │  │ HostAdapter  │  │ LeaseStore    │  │ Teardown      │
  │ Machine       │  │ (consent,    │  │ (persistence) │  │ Orchestrator  │
  │ (table-driven)│  │ approval,    │  │ JSON default  │  │ (saga)        │
  │               │  │ notify)      │  │               │  │               │
  └──────────────┘  └──────────────┘  └──────────────┘  └───────────────┘
```

### Component Responsibilities

| Component | Responsibility | Typical Implementation |
|-----------|----------------|------------------------|
| MCP Proxy Server (PEP) | Sits between agent's MCP client and every downstream MCP server; intercepts `tools/list` and `tools/call`; filters visible tools per lease; calls PDP for every call; never contains policy logic itself | `@modelcontextprotocol/sdk` `Server` on the agent-facing side, `Client` instance(s) on the downstream side, one Client per connector; PEP is a thin dispatcher, not a decision-maker |
| Policy Engine (PDP) | Pure function `(lease, call, bindings) → verdict` — no I/O, no clock reads except via injected `now`, no side effects; decides allow / deny / require-approval | Exported function in `@stint/core`, unit-testable with table-driven fixtures, no dependency on proxy or transport |
| Connector Binding Registry | Runtime-owned mapping of tool name → `{resource, access: read\|write\|send\|pay, irreversible}`; source of truth the PDP consults, never the publisher manifest | Static table shipped with `@stint/proxy`, keyed by connector id + tool name; versioned so publisher tool renames don't silently escalate access |
| Credential Vault | Holds OAuth access tokens and license tokens; injects them into outbound requests to downstream MCP servers/resources; never returns them through any response path back to the agent | In-process module inside `@stint/proxy`, keyed by `lease_id` + resource; tokens live only in vault memory/store, never serialized into MCP responses or receipts |
| Approval Dispatcher | For calls flagged `require_for` (send/pay/irreversible), pauses the call and asks the HostAdapter out-of-band; never via MCP elicitation through the agent's own client | Promise that resolves/rejects based on HostAdapter callback; timeout defaults to deny |
| Receipt Log | Append-only, hash-chained record of every decision and call outcome; periodic signed checkpoints; two independently-chained sub-logs (verified vs attested) merged only for display | Modeled on Certificate Transparency / Trillian: Merkle-ish hash chain (or simple linked hash chain for v0.1 scale), Ed25519-signed checkpoint every N entries or on lease-ending events |
| Lease State Machine | Table-driven, pure transition function `(state, event, actor) → state` with full actor attribution; the single source of truth for what states/transitions are legal | `@stint/core`, transition table as data (not a switch statement), exhaustively tested |
| Teardown Orchestrator | Saga-style: revoke OAuth → invalidate license → run cleanup hook (single-use token) → delete cache → write final signed receipt; each step independently retryable; partial failure recorded, not swallowed | Orchestration (not choreography) — a single sequential coordinator in `@stint/core`/`@stint/proxy`, since there is one lease per saga and steps must run in a fixed order |
| HostAdapter | Pluggable interface: consent, per-call approval, lifecycle notifications; platform builders implement their own UX; CLI ships a reference implementation | Interface in `@stint/core`, CLI implementation in `@stint/cli` (prompts) |
| LeaseStore | Pluggable persistence for lease records and receipt log; JSON-file default | Interface in `@stint/core`, `@stint/cli`/`@stint/proxy` ships JSON-file impl |

## Recommended Project Structure

```
packages/
├── spec/                       # @stint/spec — schema is the source of truth
│   ├── schema/
│   │   └── manifest.schema.json
│   ├── src/
│   │   ├── types.ts             # generated from schema (json-schema-to-typescript)
│   │   └── validate.ts          # Ajv validator wrapper
│   └── ALP.md                   # normative spec doc (states, transitions, actors, trust model)
├── core/                       # @stint/core — pure logic, no I/O, no MCP, no network
│   ├── src/
│   │   ├── state-machine/
│   │   │   ├── transitions.ts   # table-driven transition table (data, not switch)
│   │   │   ├── reduce.ts        # pure (state, event, actor) → state
│   │   │   └── states.ts        # enum + guards
│   │   ├── policy/
│   │   │   ├── evaluate.ts      # pure PDP: (lease, call, bindings, now) → verdict
│   │   │   └── bindings.ts      # connector binding registry types
│   │   ├── license/
│   │   │   ├── issue.ts         # PASETO v4.public issuance (publisher side, mocked)
│   │   │   └── verify.ts        # PASETO verify + refresh-bound-by-lease-expiry logic
│   │   ├── receipts/
│   │   │   ├── chain.ts         # hash-chain append, verify
│   │   │   ├── checkpoint.ts    # Ed25519 signed checkpoint
│   │   │   └── merge.ts         # merge verified + attested chains for display
│   │   ├── teardown/
│   │   │   └── orchestrate.ts   # saga: ordered steps, partial-failure recording, retry
│   │   ├── host-adapter.ts      # HostAdapter interface
│   │   └── lease-store.ts       # LeaseStore interface
│   └── test/                    # exhaustive transition/teardown/denial tests
├── proxy/                      # @stint/proxy — MCP server + I/O + vault
│   ├── src/
│   │   ├── server.ts             # agent-facing MCP Server (tools/list, tools/call handlers)
│   │   ├── downstream/
│   │   │   └── client-pool.ts    # per-connector MCP Client instances
│   │   ├── vault/
│   │   │   └── credential-vault.ts  # token store + outbound injection
│   │   ├── connectors/
│   │   │   └── bindings.ts       # runtime-owned tool→(resource,access,irreversible) table
│   │   ├── concurrency/
│   │   │   └── lease-mutex.ts    # per-lease serialization, rate-limit counters
│   │   └── oauth/
│   │       └── delegated.ts      # oauth4webapi wiring for downstream OAuth
├── cli/                         # @stint/cli — HostAdapter reference impl + commands
│   ├── src/
│   │   ├── commands/            # create, inspect, revoke, cleanup, receipts
│   │   ├── host-adapter.ts       # terminal-prompt HostAdapter implementation
│   │   └── lease-store-json.ts   # JSON-file LeaseStore impl
└── examples/
    └── payment-reconciler/       # e2e test agent: hybrid mode, mocked Paystack + Sheets
```

### Structure Rationale

- **`spec/`** has zero runtime dependencies on the others — it's pure schema/types, so it must build first and is safe to consume from `core`, `proxy`, and `cli` alike.
- **`core/`** contains zero I/O: no filesystem, no network, no MCP SDK import. This is what makes the state machine and policy engine "pure function" testable without mocking transports — a deliberate constraint, not an accident. It depends only on `spec` for types.
- **`proxy/`** is where all I/O and untrusted-boundary code lives: the MCP server, the downstream MCP clients, the vault, OAuth calls. It depends on `core` for decisions but owns all side effects.
- **`cli/`** is a consumer of both — it's the reference HostAdapter and default LeaseStore, proving the plug-in interfaces are implementable outside `core`/`proxy`.
- Connector bindings live in `proxy/`, not `spec/` or a publisher-supplied file, enforcing the "runtime owns tool→access mapping" decision from PROJECT.md — a publisher manifest cannot smuggle in a mislabeled `send` as `read`.

## Architectural Patterns

### Pattern 1: PEP/PDP split (Policy Enforcement Point / Policy Decision Point)

**What:** The MCP proxy (PEP) is a thin dispatcher that intercepts every `tools/list` and `tools/call`, but contains no policy logic itself. It calls a pure decision function (PDP) in `@stint/core` that takes `(lease, call, connector bindings, now)` and returns a verdict (`allow | deny | require_approval`). This mirrors how MCP security gateways in the wild (e.g. the agent-governance-toolkit MCP-SECURITY-GATEWAY spec) separate "intercept + enforce" from "decide."

**When to use:** Any system where enforcement must be independent of the untrusted actor (the agent/LLM) — the model must never be able to talk its way past the check because the check runs in code it cannot see or influence, and that code is separated from the transport code so it can be tested without a live MCP session.

**Trade-offs:** Adds one more layer of indirection (PEP calls PDP, doesn't decide itself) but this is exactly what makes the policy engine unit-testable as a pure function with table-driven fixtures, and keeps `core` free of MCP SDK, network, and filesystem dependencies.

**Example:**
```typescript
// @stint/core/src/policy/evaluate.ts — PDP, pure
export function evaluatePolicy(
  lease: Lease,
  call: ToolCallRequest,
  bindings: ConnectorBindingRegistry,
  now: Date
): PolicyVerdict {
  const binding = bindings.resolve(call.connector, call.tool);
  if (!binding) return { decision: "deny", reason: "unbound_tool" };
  if (lease.state !== "active") return { decision: "deny", reason: "lease_not_active" };
  if (now > lease.expiresAt) return { decision: "deny", reason: "expired" };
  if (!lease.scopes.includes(binding.resource)) return { decision: "deny", reason: "out_of_scope" };
  if (lease.approvals.require_for.includes(binding.access)) {
    return { decision: "require_approval", binding };
  }
  return { decision: "allow", binding };
}

// @stint/proxy/src/server.ts — PEP, calls the pure fn, owns I/O
async function handleToolCall(req: ToolCallRequest) {
  const verdict = evaluatePolicy(await store.getLease(req.leaseId), req, bindings, new Date());
  if (verdict.decision === "deny") return denyResponse(verdict.reason);
  if (verdict.decision === "require_approval") return await approvalDispatcher.ask(req, verdict);
  return await vault.callWithCredentials(verdict.binding, req);
}
```

### Pattern 2: Dual-server MCP proxy topology (agent-facing server + downstream clients)

**What:** The proxy runs an MCP `Server` on the agent-facing side (the agent connects to Stint as if Stint were the tool provider) and one MCP `Client` per downstream connector on the resource-facing side (Stint connects to Paystack's/Sheets' actual MCP servers, or wraps REST APIs as MCP-shaped calls). `tools/list` on the agent-facing server is computed dynamically per lease — it is never a passthrough of the downstream servers' tool lists; it's filtered to only the tools whose connector bindings are in scope for that lease.

**When to use:** Any gateway that must present a restricted, per-session view of tools to an untrusted client while holding full-privilege connections to real backends. This is the standard MCP gateway shape (per Tyk, TrueFoundry, and Speakeasy's MCP gateway writeups).

**Trade-offs:** Requires maintaining a live Client per connector per active lease (connection pooling), and tool schemas must be kept in sync between the downstream server's real schema and what the proxy re-exposes — but this is what makes tool discovery itself policy-enforced, not just the calls.

**Example:**
```typescript
// tools/list is lease-scoped, not a passthrough
server.setRequestHandler(ListToolsRequestSchema, async (req) => {
  const lease = await store.getLease(sessionLeaseId(req));
  const visible = bindings.allFor(lease.connectors)
    .filter(b => lease.scopes.includes(b.resource));
  return { tools: visible.map(toMcpToolSchema) };
});
```

### Pattern 3: Credential vault — injection without exposure

**What:** The vault holds real OAuth access tokens and the publisher license token, keyed by `lease_id` + resource. The agent-facing proxy layer only ever passes an opaque `lease_id` + tool call; the vault resolves that to real credentials and attaches them to the outbound HTTP/MCP call to the downstream server. No code path returns a token value in a response to the agent, and receipts store only an args hash + redacted summary — never raw args or tokens. This matches the "secretless broker" pattern: the broker matches request→route, swaps a placeholder for the real credential, and the caller never touches the secret.

**When to use:** Whenever an untrusted or semi-trusted caller (here: a possibly prompt-injected agent) must trigger authenticated actions but must not be able to exfiltrate the credential itself, even via error messages or side channels.

**Trade-offs:** Centralizes a lot of trust in the vault process — it must be carefully isolated from any code path that serializes responses back toward the agent (including error messages, which must be scrubbed of token values before being returned).

**Example:**
```typescript
class CredentialVault {
  private tokens = new Map<string, ResourceCredential>(); // keyed by `${leaseId}:${resource}`

  async callWithCredentials(binding: ConnectorBinding, req: ToolCallRequest) {
    const cred = this.tokens.get(`${req.leaseId}:${binding.resource}`);
    if (!cred) throw new Error("no_credential_bound"); // never includes cred value
    try {
      return await downstreamClients.get(binding.connector).call(req.tool, req.args, {
        headers: { Authorization: `Bearer ${cred.accessToken}` }, // injected here only
      });
    } catch (err) {
      throw scrubCredentials(err, cred); // strip token from any echoed request/error
    }
  }
}
```

### Pattern 4: Table-driven, pure state machine

**What:** Lease states (`proposed, declined, granted, active, completed, expired, revoked, failed, tearing_down, cleaned_up, cleanup_incomplete`) and their legal transitions are defined as a data table — `{from, event, actor, to, guard?}[]` — not as nested switch/if logic. The reducer `reduce(state, event, actor) → state | Error` is a pure function: same inputs always produce the same output, with `now` and any external facts passed in as event payload rather than read internally.

**When to use:** Any system where "what transitions are legal, from where, by whom" needs to be exhaustively tested and audited — critical here because the actor list is wide (user, verifier, policy, clock, provider, publisher, runtime — never the agent) and getting this wrong means an agent could effectively trigger a state change it shouldn't be able to.

**Trade-offs:** A data-driven table is slightly more indirection to read than a switch statement, but it turns "is this transition legal" into a lookup, makes the transition table itself dumpable/printable (useful for the spec doc and for tests that assert full coverage), and cleanly separates "is this transition structurally legal" from "should we do it right now" (guards).

**Event sourcing vs snapshot:** Recommend **event log + current-state snapshot**, not pure event sourcing replay. The receipt log already gives an append-only event history for audit purposes (hash-chained, signed). The `LeaseStore` should persist the *current* lease state snapshot for fast reads (every proxy call needs the state cheaply, and per-call enforcement — not timer-based — means this is a hot path). Reconstructing state by replaying the full receipt log on every read would be wasteful and unnecessary since the receipt log's job is audit/proof, not being the primary read model. Keep them related but distinct: state transitions are *recorded as* receipts (so the audit trail is derivable and cross-checkable against the snapshot), but the snapshot in LeaseStore is the source of truth for "what state is this lease in right now."

**Example:**
```typescript
const TRANSITIONS: Transition[] = [
  { from: "proposed", event: "user_consent", actor: "user", to: "granted" },
  { from: "proposed", event: "user_decline", actor: "user", to: "declined" },
  { from: "granted", event: "activate", actor: "runtime", to: "active" },
  { from: "active", event: "complete", actor: "runtime", to: "completed" },
  { from: "active", event: "expire", actor: "clock", to: "expired" },
  { from: "active", event: "revoke", actor: "user", to: "revoked" },
  { from: "active", event: "error_threshold", actor: "policy", to: "revoked" },
  { from: "active", event: "grant_revoked", actor: "provider", to: "revoked" },
  { from: "active", event: "entitlement_revoked", actor: "publisher", to: "revoked" },
  { from: "active", event: "runtime_failure", actor: "runtime", to: "failed" },
  // terminal states all funnel into tearing_down
  { from: ["completed", "expired", "revoked", "failed"], event: "begin_teardown", actor: "runtime", to: "tearing_down" },
  { from: "tearing_down", event: "teardown_ok", actor: "runtime", to: "cleaned_up" },
  { from: "tearing_down", event: "teardown_partial_failure", actor: "runtime", to: "cleanup_incomplete" },
];

export function reduce(state: LeaseState, event: LeaseEvent, actor: Actor): LeaseState {
  const t = TRANSITIONS.find(t =>
    (Array.isArray(t.from) ? t.from.includes(state) : t.from === state) &&
    t.event === event.type && t.actor === actor
  );
  if (!t) throw new IllegalTransitionError(state, event, actor);
  return t.to;
}
```

### Pattern 5: Teardown as a retryable saga with partial-failure recording

**What:** Teardown is a fixed, ordered sequence — revoke OAuth grant(s) → invalidate publisher license → run cleanup hook (authenticated with a single-use `cleanup:<lease_id>` token, since the license is already dead) → delete local cache → write final signed receipt. This is orchestration, not choreography (a single coordinator owns the order — there's exactly one lease per saga, no need for a distributed event bus). Each step's outcome is recorded independently: `revoked | discarded_revocation_unsupported | failed` for credential revocation, similar tri-state outcomes for the other steps. A step failing does not abort the saga — teardown continues through remaining steps and the lease lands in `cleanup_incomplete` rather than silently succeeding or hanging.

**When to use:** Any multi-step external-system cleanup where individual steps can independently fail (revocation endpoint down, cleanup webhook timing out) and honesty about partial failure matters more than pretending success — directly serving Stint's core value ("teardown is honestly receipted").

**Trade-offs:** Compensating transactions in the classic saga sense (undo a completed step) mostly don't apply here — teardown steps are inherently one-directional (you can't "un-revoke" a credential to retry a later step). What Stint needs instead is **idempotent, individually-retryable steps with terminal-state recording per step**, closer to a "best-effort ordered cleanup with an incident record" than a classic reversible saga. Retries should use bounded exponential backoff per step, feeding into `cleanup_incomplete` (not an infinite retry loop) when a step's retry budget is exhausted.

**Example:**
```typescript
type StepOutcome = "ok" | "discarded_unsupported" | "failed";
type TeardownStep = { name: string; run: () => Promise<StepOutcome> };

async function orchestrateTeardown(lease: Lease, steps: TeardownStep[]): Promise<TeardownResult> {
  const results: Record<string, StepOutcome> = {};
  for (const step of steps) {
    results[step.name] = await withRetry(step.run, { maxAttempts: 3, backoffMs: 500 })
      .catch(() => "failed" as const);
    await receiptLog.append({ type: "teardown_step", step: step.name, outcome: results[step.name] });
  }
  const allOk = Object.values(results).every(r => r === "ok" || r === "discarded_unsupported");
  const finalState = allOk ? "cleaned_up" : "cleanup_incomplete";
  await receiptLog.appendSignedCheckpoint({ leaseId: lease.id, finalState, results });
  return { finalState, results };
}
```

### Pattern 6: Hash-chained receipt log with signed checkpoints (scaled-down CT/Trillian)

**What:** Every receipt (policy decision, tool call outcome, teardown step, state transition) is appended to a log where each entry includes `hash(previous_entry || this_entry_content)`, forming a hash chain. Periodically (and always at lease-ending events), the runtime signs a **checkpoint** — a small signed statement of `{lease_id, entry_count, head_hash, timestamp}` — with an Ed25519 key (`jose`). This is Certificate Transparency's Signed Tree Head / Trillian's checkpoint concept scaled down from a Merkle tree serving millions of certs to a simple linear hash chain per lease, since Stint's log is single-writer, single-lease, and doesn't need inclusion proofs against a global tree — just tamper-evidence and non-repudiation of the sequence for one lease's lifetime.

**When to use:** Any audit trail where "was anything altered or reordered after the fact" must be cheaply verifiable by a third party (the user, a dispute mediator) without trusting the runtime's live database — exactly Stint's requirement that receipts "survive cleanup" and prove integrity even after the lease and its credentials are gone.

**Trade-offs:** A full Merkle tree (as Trillian uses) supports efficient inclusion/consistency proofs across a huge multi-tenant log; Stint doesn't need that at v0.1 scale (one hash chain per lease, small entry counts) — a simple linked hash chain with periodic signed checkpoints gives the same tamper-evidence property with far less implementation complexity. Revisit a Merkle structure only if receipts are ever aggregated cross-lease into a single shared, publicly-verifiable log.

**Two independently-chained logs — verified vs attested:** Stint keeps two separate hash chains per lease: a **verified** chain (entries the runtime itself observed and can prove, e.g. "policy allowed this call," "OAuth token was successfully used") and an **attested** chain (entries the runtime is relaying on trust from elsewhere, e.g. publisher-reported "data deleted"). Each chain has its own independent integrity (its own hash links and its own checkpoint signature) — **do not interleave them into one chain**, because that would let a weak attested claim silently borrow the cryptographic strength of a verified one. Merging is **display-only**: a read-side function that timestamp-sorts entries from both chains into one human-readable timeline without touching either chain's hash linkage or signatures.

**Example:**
```typescript
interface ReceiptEntry { seq: number; timestamp: string; type: string; payload: unknown; prevHash: string; }
interface Chain { kind: "verified" | "attested"; entries: ReceiptEntry[]; }

function appendToChain(chain: Chain, payload: unknown, type: string): Chain {
  const prevHash = chain.entries.at(-1)?.prevHash ?? GENESIS_HASH;
  const entry: ReceiptEntry = {
    seq: chain.entries.length,
    timestamp: new Date().toISOString(),
    type, payload,
    prevHash: sha256(prevHash + canonicalize({ type, payload })),
  };
  return { ...chain, entries: [...chain.entries, entry] };
}

function signCheckpoint(chain: Chain, key: PrivateKey): Checkpoint {
  const head = chain.entries.at(-1)?.prevHash ?? GENESIS_HASH;
  return { kind: chain.kind, count: chain.entries.length, head, signature: ed25519Sign(key, head) };
}

// display-only merge — never used for verification
function mergeForDisplay(verified: Chain, attested: Chain): TimelineEntry[] {
  return [...verified.entries, ...attested.entries]
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    .map(e => ({ ...e, chain: verified.entries.includes(e) ? "verified" : "attested" }));
}
```

### Pattern 7: Per-lease serialization and rate-limit counters

**What:** All state-mutating operations for a given `lease_id` (transitions, receipt appends, rate-limit counter increments) run through a per-lease async mutex/queue, so concurrent tool calls against the same lease can't race on the state machine or double-count against a rate limit. Cross-lease operations remain fully concurrent — the mutex key is `lease_id`, not global.

**When to use:** Any system with many independent, per-entity state machines where entity-level consistency matters but global serialization would be an unnecessary bottleneck — exactly a multi-lease runtime where each lease is independent but internally must be linearizable.

**Trade-offs:** An in-process keyed mutex (e.g. a small `Map<leaseId, Promise>` chain, or a library like `p-queue` configured per key) is sufficient for v0.1's single-process runtime; if Stint ever runs multiple runtime processes sharing one LeaseStore, this needs to move to a distributed lock (e.g. Redis-based, matching the `SET NX EX` pattern) — call this out as a scaling note, not a v0.1 requirement.

**Example:**
```typescript
class PerLeaseSerializer {
  private queues = new Map<string, Promise<unknown>>();

  async run<T>(leaseId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(leaseId) ?? Promise.resolve();
    const next = prev.then(fn, fn); // run after prior op settles, regardless of its outcome
    this.queues.set(leaseId, next.catch(() => {})); // don't let a rejection poison future runs
    return next;
  }
}

// usage: every tools/call handler and every rate-limit increment goes through this
await serializer.run(lease.id, () => applyRateLimitAndCall(lease, req));
```

## Data Flow

### Install / Consent Flow

```
Platform/CLI → HostAdapter.requestConsent(manifest, requestedScopes)
    ↓ user approves
Runtime: verify manifest publisher signature + spec_version
    ↓
Runtime: bind manifest content hash to new Lease (state=proposed)
    ↓
State Machine: reduce(proposed, user_consent, actor=user) → granted
    ↓
Runtime: acquire delegated OAuth grants (oauth4webapi) for auth.delegated list
    ↓ each grant → Credential Vault (keyed by lease_id:resource)
Runtime: request publisher license (PASETO v4.public, short TTL)
    ↓
State Machine: reduce(granted, activate, actor=runtime) → active
    ↓
Receipt Log: append "lease_granted" to verified chain, sign checkpoint
    ↓
HostAdapter.notify(lease_active)
```

### Tool Call Flow

```
Agent → MCP tools/call (agent-facing proxy Server)
    ↓
Proxy: per-lease serializer.run(leaseId, ...) [concurrency gate]
    ↓
Proxy: look up Lease from LeaseStore (snapshot read)
    ↓
Proxy: resolve tool → binding via Connector Binding Registry (runtime-owned)
    ↓
PDP: evaluatePolicy(lease, call, binding, now) — pure fn, no I/O
    ↓
  ┌── deny ─────────────→ Receipt Log (verified: "denied") → MCP error response
  ├── require_approval ─→ Approval Dispatcher → HostAdapter.requestApproval()
  │                            ↓ timeout → deny (default)     ↓ approved
  │                       Receipt Log ("denied: timeout")   continue below
  └── allow ────────────────────────────────────────────────────┘
    ↓
Credential Vault: resolve real token for (leaseId, binding.resource)
    ↓
Vault: inject credential, call downstream MCP Client / REST API
    ↓
Downstream resource → response
    ↓
Vault: scrub any credential material from response/error before returning
    ↓
Receipt Log: append (verified chain) — args hash + redacted summary, never raw args/token
    ↓
Proxy → Agent: MCP tool result (no credentials ever included)
```

### Approval Flow

```
Proxy (mid tools/call) → Approval Dispatcher
    ↓ (never via MCP elicitation through agent's own client)
HostAdapter.requestApproval(call summary, binding) — out of band (CLI prompt / platform UI)
    ↓
  ┌── user approves within timeout ──→ resolve(approved) → proceed to Credential Vault
  └── timeout or user denies ────────→ resolve(denied) → Receipt Log ("denied") → MCP error
    ↓
Receipt Log: append approval decision (verified chain, actor=user)
```

### Lease End + Teardown Flow

```
Trigger: any of {user revoke, clock expire, policy error_threshold,
                 provider grant_revoked, publisher entitlement_revoked, runtime failure}
    ↓
State Machine: reduce(active, <trigger_event>, actor=<trigger_actor>) → revoked|expired|failed
    ↓
State Machine: reduce(<terminal>, begin_teardown, actor=runtime) → tearing_down
    ↓
Teardown Orchestrator (ordered, each step retried + recorded):
    1. Revoke OAuth grant(s) via provider revocation endpoint
       → outcome: revoked | discarded_revocation_unsupported | failed
    2. Invalidate publisher license (call publisher revocation endpoint; stop refresh loop)
    3. Run cleanup hook, authenticated with single-use token scoped `cleanup:<lease_id>`
    4. Delete local cache/vault entries for this lease
    ↓ (each step) → Receipt Log: append step outcome (verified chain)
    ↓
State Machine: reduce(tearing_down, teardown_ok|teardown_partial_failure, actor=runtime)
    → cleaned_up | cleanup_incomplete
    ↓
Receipt Log: sign final checkpoint (verified + attested chains, independently)
    ↓ receipts persist past this point — LeaseStore may drop the lease record,
    ↓ but the receipt log is retained
HostAdapter.notify(lease_ended, finalState, receiptSummary)
```

## Scaling Considerations

| Scale | Architecture Adjustments |
|-------|--------------------------|
| Single user, few leases (v0.1 target) | Single Node process, JSON-file LeaseStore, in-process per-lease mutex (`Map`-based), linear hash chain per lease — all of this is sufficient and intentionally simple |
| Many concurrent leases, single host (platform builder embedding runtime) | Swap LeaseStore for a real DB (SQLite/Postgres) behind the same interface; per-lease mutex still in-process since it's still one runtime process; connector Client pool needs connection limits per downstream service |
| Multiple runtime processes / horizontal scale | Per-lease serialization must move from in-process `Map` to a distributed lock (Redis `SET NX EX`, matching the secretless-broker style pattern); receipt log checkpoint signing must be single-writer-per-lease still (route by lease_id to one process, or use a proper append-only store with optimistic concurrency) |

### Scaling Priorities

1. **First bottleneck:** JSON-file LeaseStore under concurrent writes — becomes a hazard once more than a handful of leases are active simultaneously on one host; fix by swapping the LeaseStore implementation (interface already supports this), not by changing the proxy or core.
2. **Second bottleneck:** Connector Client pool exhaustion against downstream MCP servers/APIs if many leases hit the same connector concurrently — mitigate with per-connector connection pooling and the existing per-lease rate-limit counters, not by weakening the credential vault boundary.

## Anti-Patterns

### Anti-Pattern 1: Policy logic embedded in the MCP transport layer

**What people do:** Put `if (scope includes X)` checks directly inside the `tools/call` handler in the proxy server file, mixed with MCP protocol/transport code.
**Why it's wrong:** Makes the policy untestable without a live MCP session/transport, couples enforcement logic to SDK version churn, and makes it easy to accidentally add a code path that bypasses the check (e.g. a second handler that forgets to call it).
**Do this instead:** Keep all decision logic in `@stint/core` as pure functions with zero MCP/transport imports; the proxy is only ever a caller of those functions, never a decider.

### Anti-Pattern 2: Publisher-authored scope-to-access mapping

**What people do:** Trust the agent manifest's own declaration of what each tool does (e.g. manifest says `read_transactions` is `read` access).
**Why it's wrong:** A malicious or careless publisher can mislabel a `send`/`pay`/irreversible action as `read`, bypassing approval requirements entirely — this is explicitly called out in PROJECT.md as a resolved risk.
**Do this instead:** Runtime-owned connector binding registry is the only source of truth for tool→(resource, access, irreversible); publisher manifests only declare which connectors/scopes they want, never how those tools are classified.

### Anti-Pattern 3: Elicitation-based approval through the agent's own MCP client

**What people do:** Use MCP's built-in elicitation capability to ask the "user" for approval, routed through the same client the agent is using.
**Why it's wrong:** A prompt-injected or compromised agent controls what's presented in that channel, so it can't be trusted as an out-of-band approval mechanism — it's the same trust boundary as the thing being checked.
**Do this instead:** Approvals go through the HostAdapter's own independent channel (CLI prompt, platform notification, push) — a channel the agent process cannot see or influence.

### Anti-Pattern 4: Interleaving verified and attested log entries into one chain

**What people do:** Put every receipt — self-observed and publisher-relayed alike — into a single hash chain for simplicity.
**Why it's wrong:** An attested (trust-on-faith) claim then inherits the cryptographic appearance of a verified (runtime-observed) claim once it's in the same chain, misleading anyone auditing the log about what's actually proven vs merely relayed.
**Do this instead:** Two independently-chained, independently-checkpointed logs; merge only at display time, and always label each entry's provenance in the merged view.

### Anti-Pattern 5: Pure event-sourcing replay as the hot-path read model

**What people do:** Make "current lease state" derived by replaying the entire receipt log on every policy check.
**Why it's wrong:** Every tool call needs the lease state (enforcement is per-call, not timer-based per PROJECT.md), so this would put an O(log length) replay on the hottest path in the system.
**Do this instead:** LeaseStore holds the current-state snapshot as the fast read path; the receipt log is the audit trail, cross-checkable against the snapshot but not required for normal operation reads.

## Integration Points

### External Services

| Service | Integration Pattern | Notes |
|---------|---------------------|-------|
| OAuth 2.1 Authorization Server (customer's, e.g. Paystack/Sheets) | `oauth4webapi` delegated grant flow; tokens held only in Credential Vault | Revocation may be unsupported (no RFC 7009) — record `discarded_revocation_unsupported`, don't fail teardown on it |
| Publisher license service | PASETO v4.public (`paseto` by panva) issuance/verification; short TTL (default 5 min), refresh bounded by lease expiry | Refresh is routine/runtime-driven; distinct from lease extension, which needs fresh user consent |
| Downstream MCP servers / mocked APIs | `@modelcontextprotocol/sdk` `Client`, one per connector, credentials injected by vault at call time | Never let a downstream server's raw tool schema pass through unfiltered — always resolve through Connector Binding Registry first |
| Cleanup webhook (publisher-hosted) | Single-use bearer token scoped `cleanup:<lease_id>`, since license is already invalidated by teardown step 2 | Treat webhook failure as `failed`, not silently `ok`; retry with backoff, then record `cleanup_incomplete` |

### Internal Boundaries

| Boundary | Communication | Notes |
|----------|---------------|-------|
| `@stint/proxy` ↔ `@stint/core` | Direct function calls (pure functions in, results out) — no network, no queue | This is the PEP/PDP boundary; keep it synchronous and dependency-free in `core` |
| `@stint/core` state machine ↔ receipt log | Every accepted transition is recorded as a receipt append; log is a consumer of transition events, not a dependency of the reducer | Reducer stays pure; logging happens in the caller (proxy/orchestrator), not inside `reduce()` |
| `@stint/proxy` vault ↔ downstream clients | Vault wraps the outbound call, injecting `Authorization` header/equivalent; never returns raw credential through any response path | Error scrubbing must happen at this boundary specifically, since downstream error bodies can echo request headers |
| `@stint/cli` HostAdapter ↔ `@stint/core`/`@stint/proxy` | Implements `HostAdapter` interface; called by proxy's approval dispatcher and by core's consent flow | Interface-only coupling — a platform builder's own HostAdapter is a drop-in replacement |
| `@stint/cli` LeaseStore (JSON) ↔ `@stint/core`/`@stint/proxy` | Implements `LeaseStore` interface | Swappable for SQLite/Postgres without touching `core` or `proxy` |

## Suggested Build Order

Dependency graph drives sequencing — each package should be buildable and testable before the next depends on it:

1. **`@stint/spec`** first: manifest JSON Schema, generated types, Ajv validator. Nothing else compiles without types.
2. **`@stint/core` state machine**: table-driven transitions + pure reducer, fully tested against the actor/state table in PROJECT.md, before anything else in `core`. This is the riskiest logic to get wrong and has zero external dependencies, so it's cheapest to get right early and hardest to retrofit later.
3. **`@stint/core` policy engine (PDP)**: pure `evaluatePolicy` function, tested with the connector binding registry as a fixture (no proxy needed yet).
4. **`@stint/core` receipts (hash chain + checkpoints)**: build and test in isolation — append, verify chain integrity, sign/verify checkpoints, merge-for-display — before wiring into the proxy or teardown orchestrator.
5. **`@stint/core` license issuance/verification**: PASETO issue/verify, refresh-bound-by-lease-expiry logic, independent of the proxy.
6. **`@stint/core` teardown orchestrator**: depends on state machine + receipts being solid; test partial-failure paths thoroughly here since this is where PROJECT.md's "honestly receipted" value lives or dies.
7. **`@stint/proxy` MCP server skeleton + connector binding registry**: agent-facing `tools/list`/`tools/call` handlers wired to the PDP from step 3, using a stub/mock downstream connector before real OAuth.
8. **`@stint/proxy` credential vault + OAuth delegation**: wire `oauth4webapi`, injection, scrubbing — this is the component with the highest security consequence of a mistake, build and test it with adversarial "does the token leak" tests before connecting real downstream clients.
9. **`@stint/proxy` concurrency layer (per-lease serializer, rate-limit counters)**: wrap the above once the single-request path works correctly; concurrency bugs are much easier to reason about once serial correctness is proven.
10. **`@stint/cli`**: HostAdapter reference implementation + JSON LeaseStore + commands — exercises every plug-in interface `core`/`proxy` expose, which is itself a design validation step.
11. **`examples/payment-reconciler`**: end-to-end test agent wiring everything together (hybrid auth mode, mocked Paystack + Sheets) — this is the acceptance test for the whole build, not a separate feature.

This order front-loads the pure, dependency-free, easiest-to-test logic (`spec`, then `core`'s state machine/policy/receipts) and defers the highest-risk I/O boundary (the credential vault) until the decision logic it depends on is already proven correct — so bugs found while building the vault are vault bugs, not policy-engine bugs in disguise.

## Sources

- [MCP gateway architecture: A complete technical guide — Tyk](https://tyk.io/learning-center/mcp-gateway-architecture-technical-guide/)
- [What Is an MCP Gateway: Architecture and Use Cases — TrueFoundry](https://www.truefoundry.com/blog/what-is-mcp-gateway)
- [MCP gateway: architecture and governance — Speakeasy](https://www.speakeasy.com/resources/mcp-gateway)
- [agent-governance-toolkit MCP-SECURITY-GATEWAY-1.0 spec — Microsoft](https://github.com/microsoft/agent-governance-toolkit/blob/main/docs/specs/MCP-SECURITY-GATEWAY-1.0.md)
- [What Is MCP Policy Enforcement — DEV Community](https://dev.to/policylayer/what-is-mcp-policy-enforcement-and-why-every-agent-needs-it-5dpa)
- [Trillian Verifiable Data Structures docs](https://github.com/google/trillian/blob/master/docs/VerifiableDataStructures-Latest.md)
- [Trillian Transparent Logging Guide](https://google.github.io/trillian/docs/TransparentLogging.html)
- [Verifiable Data Structures — transparency.dev](https://transparency.dev/verifiable-data-structures/)
- [Saga Design Pattern — Azure Architecture Center, Microsoft Learn](https://learn.microsoft.com/en-us/azure/architecture/patterns/saga)
- [Saga Rollback Mechanics: Compensating Transaction Ordering, Failure Atomicity — DEV Community](https://dev.to/neeraj_singhi_golang/saga-rollback-mechanics-compensating-transaction-ordering-failure-atomicity-and-the-partial-4142)
- [Saga patterns — AWS Prescriptive Guidance](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/saga.html)
- [How Secretless Works — CyberArk/Secretless docs](https://docs.secretless.io/Latest/en/Content/Overview/scl_how_it_works.htm)
- [Secretless — Aembit glossary](https://aembit.io/glossary/secretless/)
- [Keep Secrets Out of Your AI Agents: Credential Gateways, Short-Lived Tokens — bex.co](https://bex.co/blog/2026/09/07/keeping-secrets-out-of-ai-agents)
- [Straightforward Event Sourcing with TypeScript and NodeJS — Event-Driven.io](https://event-driven.io/en/type_script_node_js_event_sourcing/)
- [MCP TypeScript SDK — official repo](https://github.com/modelcontextprotocol/typescript-sdk)
- [MCP TypeScript SDK server docs](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/server.md)
- [p-queue — npm](https://www.npmjs.com/package/p-queue)
- [BullMQ rate limiting docs (per-key/group rate limiting pattern)](https://docs.bullmq.io/guide/rate-limiting)
- Project context: `.planning/PROJECT.md` (Stint design decisions, actor list, state list, trust limits)

---
*Architecture research for: agent lease runtime / MCP proxy with OAuth delegation and tamper-evident receipts*
*Researched: 2026-09-27*
