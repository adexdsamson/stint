# Phase 4: MCP Proxy & Credential Vault - Pattern Map

**Mapped:** 2026-09-28
**Files analyzed:** 16 (new `@stint/proxy` files + 1 additive `@stint/core` edit)
**Analogs found:** 16 / 16 (all via `@stint/core`/`@stint/spec` — `@stint/proxy` has no prior non-stub code)

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `packages/proxy/src/index.ts` (rewrite) | barrel/public-surface | request-response | `packages/core/src/index.ts` | exact (barrel convention) |
| `packages/proxy/src/server.ts` | controller (MCP `Server` wiring) | request-response | `packages/core/src/host-adapter.ts` (`awaitApprovalDecision`) + RESEARCH.md Pattern 1 code example | role-match (no MCP server exists yet in repo; core's deny-by-default/async dispatch shape is the closest structural analog) |
| `packages/proxy/src/catalog.ts` | config/data (runtime-owned tool catalog) | transform | `packages/core/src/bindings.ts` (`BindingSet`, `createBindingSet`, `resolveBinding`) | exact (identical "own-property keyed Record + builder + guarded lookup" shape) |
| `packages/proxy/src/bindings.ts` (extension of binding pay-amount source, D-07) | model/config | transform | `packages/core/src/bindings.ts` | exact — same file family, additive field pattern |
| `packages/proxy/src/concurrency/lease-serializer.ts` | service (serialization wrapper) | event-driven | `packages/core/src/lease-store.ts` (`transaction`/`LeaseMutator`) + `packages/core/src/testing.ts`'s `createInMemoryLeaseStore`'s `runSerialized` | exact — D-06/RESEARCH explicitly says reuse `LeaseStore.transaction`, don't build a second mutex |
| `packages/proxy/src/vault/credential-vault.ts` | service (credential vault, single-flight refresh) | request-response | `packages/core/src/license/held-license.ts` (opaque handle + `WeakMap` + single accessor) for custody shape; `packages/core/src/testing.ts`'s per-id promise-chain `runSerialized` for single-flight | role-match (custody pattern) + exact (single-flight concurrency pattern) |
| `packages/proxy/src/vault/oauth-client.ts` | service (OAuth HTTP client wrapper) | request-response | `packages/core/src/license/license-issuer.ts` (injected port interface pattern) | role-match (port/adapter shape); transport specifics come from RESEARCH.md Pattern 3/4 (no in-repo OAuth analog exists) |
| `packages/proxy/src/vault/scrub.ts` | utility (credential scrubbing) | transform | `packages/core/src/license/held-license.ts` (`readLicenseToken` — single narrow accessor, "never expose raw secret" convention) | role-match (secretless-boundary convention, not structural twin) |
| `packages/proxy/src/connectors/outbound-connector.ts` | service (port interface + reference impl) | request-response | `packages/core/src/license/license-issuer.ts` (`LicenseIssuer` injected port) | exact (identical "interface + no default impl in core/never-called-directly" port shape) |
| `packages/proxy/src/approvals/approval-dispatcher.ts` | service (approval commitment + dispatch) | event-driven | `packages/core/src/host-adapter.ts` (`awaitApprovalDecision`, `ApprovalRequest`/`ApprovalDecision`) + `packages/spec/src/canonical.ts` (`canonicalize`/`hashCanonical`) | exact — D-11 explicitly wraps `awaitApprovalDecision` and reuses the canonical serializer |
| `packages/proxy/src/receipts/call-receipt.ts` | service (per-call receipt builder) | event-driven | `packages/core/src/receipts/chain.ts` (`appendEntry`, `ReceiptEntryInput`, `CallPayload`) + `packages/core/src/testing.ts`'s `createReceiptStoreContractTests` append-order test for the "finally" shape | exact — RESEARCH.md's own code example is composed directly from `chain.ts`/`receipt-store.ts` |
| `packages/proxy/src/lease.ts` (additive `LeaseCounters.actionTimestamps` field, D-06) | model (core, not proxy) | CRUD | `packages/core/src/lease.ts` (`LeaseCounters`, `denialErrorTimestamps`) | exact — literal sibling field, same shape |
| `packages/proxy/src/policy.ts` (consumer of `evaluatePolicy`/`checkErrorThreshold`, no new logic) | n/a — proxy only calls core, adds no policy file | request-response | `packages/core/src/policy.ts` (`evaluatePolicy`, `PolicyCall`, `checkErrorThreshold`) | exact — proxy imports this unmodified except for the sliding-window helper it composes locally |
| `packages/proxy/test/server.test.ts` | test | request-response | `packages/core/src/testing.ts` (contract-test-factory style, `describe`/`it` structure) + RESEARCH.md's `InMemoryTransport` guidance | role-match |
| `packages/proxy/test/vault.test.ts` | test | event-driven | `packages/core/src/testing.ts` (`createLeaseStoreContractTests`'s concurrency-proof style: fire N concurrent calls, assert exactly-once) | exact (concurrency-proof idiom directly reusable for single-flight refresh proof) |
| `packages/proxy/package.json` (edit: `engines.node` bump, new deps) | config | n/a | `packages/core/package.json` (`engines.node: ">=22.18.0"`) | exact — RESEARCH.md flags this exact staleness to fix |

## Pattern Assignments

### `packages/proxy/src/index.ts` (barrel, rewrite)

**Analog:** `packages/core/src/index.ts`

**Barrel pattern** (whole file, `packages/core/src/index.ts:1-79`):
```typescript
export { SPEC_VERSION } from "@stint/spec";

export const PACKAGE_NAME = "@stint/core";

export { CORE_ERROR_CODES } from "./errors.js";
export type { CoreError, CoreErrorCode, Result } from "./errors.js";
// ... grouped `export { ... }` value exports followed by `export type { ... }`
// per module, in dependency order, with a comment block above each group
// naming which requirement IDs / decisions it satisfies.
```
Apply this exact grouping convention (`export const PACKAGE_NAME`, then per-module `export {...}` + `export type {...}` pairs, comment-annotated with requirement IDs) to `@stint/proxy`'s new barrel: export the `OutboundConnector` port, `CredentialVault`, `createLeaseProxyServer`, catalog/binding builders, and the receipts/approval helpers a consumer (Phase 6 CLI, Phase 7 example) needs. Testing-only helpers (mock connectors, mock OAuth wiring) stay out of the public `.` entry, mirroring core's `./testing` exclusion rule (`index.ts:39-43`, `54-57`).

**Current stub to replace** (`packages/proxy/src/index.ts:1-4`):
```typescript
export { SPEC_VERSION } from "@stint/spec";
export { PACKAGE_NAME as CORE_PACKAGE_NAME } from "@stint/core";

export const PACKAGE_NAME = "@stint/proxy";
```
Keep `PACKAGE_NAME` and the `CORE_PACKAGE_NAME` re-export (existing smoke test depends on both — `packages/proxy/test/smoke.test.ts:3,7,11`); add the new export groups beneath.

---

### `packages/proxy/src/catalog.ts` + `packages/proxy/src/bindings.ts` (D-08, D-12)

**Analog:** `packages/core/src/bindings.ts`

**Own-property-keyed Record + guarded builder + guarded lookup pattern** (`bindings.ts:39-60`):
```typescript
export type BindingSet = Readonly<Record<string, ConnectorBinding>>;

export function createBindingSet(bindings: readonly ConnectorBinding[]): BindingSet {
  const set: Record<string, ConnectorBinding> = {};
  for (const binding of bindings) {
    if (Object.hasOwn(set, binding.tool)) {
      throw new Error(`@stint/core: duplicate connector binding for tool "${binding.tool}".`);
    }
    set[binding.tool] = binding;
  }
  return set;
}

export function resolveBinding(set: BindingSet, tool: string): ConnectorBinding | undefined {
  if (!Object.hasOwn(set, tool)) return undefined;
  return set[tool];
}
```
Mirror this exactly for the new tool catalog (`ToolCatalogEntry[]` → `Record<string, ToolCatalogEntry>` keyed by tool name), including the `Object.hasOwn` guard against prototype-pollution tool names (`__proto__`, `constructor`) — `bindings.ts:53` calls this out explicitly. The catalog is injected at construction per D-12, paired with (not merged into) `BindingSet`, exactly as `ConnectorBinding` stays "classification only" (`bindings.ts:1-14` docstring).

**Binding shape to extend (D-07, pay-amount source)** (`bindings.ts:21-28`):
```typescript
export interface ConnectorBinding {
  readonly tool: string;
  readonly resource: string;
  readonly access: Access;
  readonly irreversible: boolean;
  readonly provenance: BindingProvenance;
}
```
Add an additive, optional field (e.g. `payAmountSource?: { argPath: string; currencyArgPath: string }`) — additive per D-07's discretion note, never mutating the existing five fields' semantics. Since `@stint/core`'s `ConnectorBinding` "stays minimal" per D-08, prefer adding this on the **proxy-owned catalog entry** rather than the core `ConnectorBinding`, unless the planner determines core needs it directly for `PolicyCall.spendMinor` extraction (which happens in the proxy, not core).

---

### `packages/proxy/src/concurrency/lease-serializer.ts` (D-06, PRXY-04)

**Analog:** `packages/core/src/lease-store.ts` (contract) + `packages/core/src/testing.ts`'s in-memory implementation (concrete serialization idiom)

**Contract to consume, not reimplement** (`lease-store.ts:40-61`):
```typescript
export interface LeaseStore {
  load(id: string): Promise<Lease | undefined>;
  save(lease: Lease): Promise<void>;
  list(): Promise<readonly Lease[]>;
  delete(id: string): Promise<void>;
  transaction(id: string, mutate: LeaseMutator): Promise<Lease>;
}
```

**Per-id promise-chain serialization idiom** (`testing.ts:51-61`, illustrative of what any conforming impl — including Phase 6's — does internally; the proxy never reimplements this, it just calls `store.transaction(leaseId, mutate)`):
```typescript
function runSerialized<T>(id: string, work: () => Promise<T>): Promise<T> {
  const previousTail = tails.get(id) ?? Promise.resolve();
  const next = previousTail.catch(() => undefined).then(work);
  tails.set(id, next.catch(() => undefined));
  return next;
}
```
`lease-serializer.ts` should be a **thin wrapper** around `deps.leaseStore.transaction(leaseId, mutate)` — per RESEARCH.md's "Don't Hand-Roll" table, building a second `Map<leaseId, Promise>` queue in `@stint/proxy` is explicitly the anti-pattern to avoid (it would create two sources of truth for the same lease).

**Sliding-window helper to compose alongside it** (RESEARCH.md's own code example, composed from `checkErrorThreshold`, `packages/core/src/policy.ts:153-163`):
```typescript
function isWithinActionsPerHour(
  actionTimestamps: readonly number[],
  limitPerHour: number,
  now: number,
): boolean {
  const windowStart = now - 3600;
  const inWindowCount = actionTimestamps.filter((ts) => ts > windowStart).length;
  return inWindowCount < limitPerHour;
}
```

---

### `packages/core/src/lease.ts` (additive `LeaseCounters` field, D-06)

**Analog:** `packages/core/src/lease.ts` itself (same file, additive edit)

**Current shape to extend** (`lease.ts:17-22`):
```typescript
export interface LeaseCounters {
  readonly actionCount: number;
  readonly spentMinor: number;
  readonly denialErrorTimestamps: readonly number[];
}
```
Add `readonly actionTimestamps: readonly number[];` (RESEARCH.md's Open Questions §1 recommends this exact name for symmetry with `denialErrorTimestamps`) — additive only. This ripples into:
- `packages/core/src/testing.ts:105` (`makeTestLease`'s `counters` literal — add `actionTimestamps: []`)
- Any other fixture constructing a bare `LeaseCounters` object literal (search for `denialErrorTimestamps:` to find every call site needing the sibling field)

---

### `packages/proxy/src/vault/credential-vault.ts` (D-02, D-04, PRXY-06, PRXY-08)

**Analog (custody/opaque-handle convention):** `packages/core/src/license/held-license.ts`

**Opaque handle + WeakMap + single accessor pattern** (`held-license.ts:23-62`):
```typescript
declare const heldLicenseBrand: unique symbol;

export interface HeldLicense {
  readonly [heldLicenseBrand]: true;
}

const tokensByHandle = new WeakMap<HeldLicense, string>();

export function mintHeldLicense(token: string): HeldLicense {
  const held = Object.freeze({}) as HeldLicense;
  tokensByHandle.set(held, token);
  return held;
}

export function readLicenseToken(held: HeldLicense): string {
  const token = tokensByHandle.get(held);
  if (token === undefined) {
    throw new Error("readLicenseToken: value was not minted by mintHeldLicense.");
  }
  return token;
}
```
D-02 doesn't require the vault's token type to be an unforgeable branded handle (unlike `HeldLicense`, which is opaque even to holders) — the vault's own module boundary is the trust boundary since it hands `{ accessToken: string }` directly to the trusted `OutboundConnector` port. But the **module-private storage + single accessor discipline** is the pattern to copy: keep raw tokens in a module-private `Map<string /* leaseId:resource */, CredentialRecord>`, never export the map, and expose only `resolveAccessToken(leaseId, resource): Promise<{ accessToken: string }>` as the single read path — mirroring the "no public property a holder could read directly" discipline even though the vault's consumer (`callWithVault` in RESEARCH.md Pattern 2) is trusted code.

**Single-flight concurrency (PRXY-08):** reuse the exact `runSerialized`/per-id-promise-chain idiom from `packages/core/src/testing.ts:51-61` (shown above), keyed by `leaseId:resource` instead of `leaseId`, so N concurrent `resolveAccessToken` calls for the same credential collapse to one in-flight refresh.

---

### `packages/proxy/src/connectors/outbound-connector.ts` (D-01, D-02)

**Analog:** `packages/core/src/license/license-issuer.ts`

**Injected-port pattern** (`license-issuer.ts:19-45`):
```typescript
export interface LicenseIssuer {
  readonly kid: string;
  issue(claims: LicenseClaims, specVersion: string, now: number, expEpochSeconds: number, jti?: string): Promise<HeldLicense>;
  reissue(claims: LicenseClaims, specVersion: string, now: number, leaseExpiresAt: number, jti?: string): Promise<HeldLicense | null>;
}
```
Same shape for `OutboundConnector` per RESEARCH.md's Pattern 2 example:
```typescript
export interface OutboundConnector {
  execute(
    binding: ConnectorBinding,
    resolvedArgs: Record<string, unknown>,
    credential: { accessToken: string },
  ): Promise<{ status: number; body: unknown }>;
}
```
Note the doc-comment convention from `license-issuer.ts:1-13` — state explicitly that no code in `@stint/proxy`'s own core logic calls a reference/REST implementation directly; it is always injected, and the reference REST impl (Phase 4) plus Phase 7's mocks both implement this same interface. The vault wraps every `port.execute(...)` call in `scrub.ts`'s scrubber (D-02), exactly as callers of `LicenseIssuer` never bypass `readLicenseToken`.

---

### `packages/proxy/src/approvals/approval-dispatcher.ts` (D-11, PRXY-05)

**Analog:** `packages/core/src/host-adapter.ts` (`awaitApprovalDecision`) + `packages/spec/src/canonical.ts` (`canonicalize`)

**Deny-on-timeout wrapper to call, never reimplement** (`host-adapter.ts:99-135`):
```typescript
export function awaitApprovalDecision(
  adapter: HostAdapter,
  request: ApprovalRequest,
  signal: AbortSignal,
): Promise<ApprovalDecision> {
  const deny: ApprovalDecision = { decision: "deny", reason: "timeout" };
  if (signal.aborted) {
    return Promise.resolve(deny);
  }
  return new Promise<ApprovalDecision>((resolve) => {
    // races adapter.requestApproval against signal's abort event;
    // any rejection/throw from the adapter also resolves `deny`
  });
}
```
The proxy's job (per `host-adapter.ts:96-97`'s own docstring: "No real timer is armed here; the caller (the Phase 4 proxy) arms the timeout and aborts `signal`") is only to construct an `AbortController`, set a real `setTimeout(() => controller.abort(), timeoutSeconds * 1000)` sourced from `manifest.approvals.timeout_seconds`, and call `awaitApprovalDecision(adapter, request, controller.signal)` — never re-derive the deny-by-default race logic.

**Canonical serializer for the commitment hash (D-11)** — reuse `packages/spec/src/canonical.ts`'s `canonicalize`/`hashCanonical` (already imported by `packages/core/src/receipts/chain.ts:40`); do not add a second serializer:
```typescript
import { canonicalize } from "@stint/spec";

function computeApprovalHash(
  resolvedArgs: Record<string, unknown>,
  binding: { tool: string; provenance: string },
  leaseVersion: number,
): string {
  return canonicalize({ args: resolvedArgs, bindingTool: binding.tool, bindingProvenance: binding.provenance, leaseVersion });
}
```

---

### `packages/proxy/src/receipts/call-receipt.ts` (D-13, RCPT-01)

**Analog:** `packages/core/src/receipts/chain.ts` (`appendEntry`, `ReceiptEntryInput`) + `packages/core/src/receipts/receipt-store.ts` (`ReceiptStore.append`)

**Secretless-by-type input shape** (`chain.ts:62-73`):
```typescript
export type ReceiptEntryInput =
  | { readonly chain: "verified" | "attested"; readonly type: "call"; readonly payload: CallPayload }
  | { readonly chain: "verified" | "attested"; readonly type: "transition"; readonly payload: TransitionPayload }
  // ...
```
`CallPayload` (imported from `@stint/spec`, re-exported at `packages/core/src/index.ts:71`) is already `argsHash` + `redactedSummary` only — leaking a raw arg into a receipt is a compile error, not a review discipline (`chain.ts:63-66` docstring). Build the outcome payload against this exact type; do not add a new payload shape.

**Append-only contract to call, never bypass** (`receipt-store.ts:37-58`):
```typescript
export interface ReceiptStore {
  append(chain: ReceiptChain, entry: ReceiptEntry): Promise<void>;
  load(chain: ReceiptChain): Promise<readonly ReceiptEntry[]>;
  readCheckpoint(chain: ReceiptChain): Promise<Checkpoint | undefined>;
  writeCheckpoint(checkpoint: Checkpoint): Promise<void>;
}
```

**`finally`-guaranteed single-append idiom** — RESEARCH.md's own code example, composed directly from this file family:
```typescript
async function handleCallWithReceipt(/* ... */): Promise<CallToolResult> {
  let outcome: CallPayload;
  let result: CallToolResult;
  try {
    result = await dispatchCall(leaseId, toolCall);
    outcome = { argsHash: hashArgs(toolCall.args), redactedSummary: summarize(result), decision: "allowed" };
  } catch (err) {
    result = { content: [{ type: "text", text: "call failed" }], isError: true };
    outcome = { argsHash: hashArgs(toolCall.args), redactedSummary: "error", decision: "errored" };
    throw err;
  } finally {
    const entry = appendEntry(deps.loadedChain, { chain: "verified", type: "call", payload: outcome! }, Date.now() / 1000 | 0);
    await deps.store.append("verified", entry);
  }
  return result;
}
```
Per D-13, the append must happen **inside** the per-lease serializer (`lease-serializer.ts`'s `transaction`) so chain order matches call order — wrap this whole `finally` block's append inside the serializer's mutator, not as a separate unsynchronized call.

---

### `packages/proxy/src/server.ts` (D-08, D-10, PRXY-01)

**Analog:** RESEARCH.md's Pattern 1 code example (composed from the shipped SDK `.d.ts`, no in-repo MCP analog exists) + `host-adapter.ts`'s async-dispatch/deny-by-default conventions for the call handler's control flow.

```typescript
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { evaluatePolicy, resolveBinding } from "@stint/core";

export function createLeaseProxyServer(leaseId: string, deps: ProxyDeps): Server {
  const server = new Server({ name: "stint-proxy", version: "0.1.0" }, { capabilities: { tools: {} } });

  const visibleTools = deps.catalog.filter((entry) =>
    deps.leaseScopes.includes(resolveBinding(deps.bindings, entry.name)?.resource ?? ""),
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: visibleTools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    return deps.serializer.run(leaseId, () => deps.handleCall(request.params));
  });

  return server;
}
```
Use the **low-level `Server`**, not `McpServer` — `McpServer.registerTool()`'s `inputSchema` is Zod-typed only (verified against the shipped `.d.ts`; see RESEARCH.md Pitfall 1), which would force either an unsafe cast or duplicating the JSON-Schema catalog in Zod. `tools/list` is computed once at construction (D-10: one `Server` per `leaseId`, never a call parameter).

---

## Shared Patterns

### Async, Result-returning / deny-by-default control flow
**Source:** `packages/core/src/host-adapter.ts` (`awaitApprovalDecision`/`awaitConsentDecision`), `packages/core/src/lease.ts` (`reduce`'s early-return `reject(...)` steps)
**Apply to:** `server.ts`'s `tools/call` handler, `approval-dispatcher.ts`, `credential-vault.ts`'s refresh path — every interactive/async proxy operation must resolve to a safe (deny/error) outcome on abort, adapter error, or thrown exception, never leave the caller hanging or default to allow.

### Own-property-guarded `Record` lookups (prototype-pollution guard)
**Source:** `packages/core/src/bindings.ts:53,57` (`Object.hasOwn(set, tool)`)
**Apply to:** `catalog.ts`'s tool-name lookups, any new `Record<string, T>` keyed by agent- or publisher-influenced strings (tool names, resource identifiers) — never a bare `set[key]` without an `Object.hasOwn` guard first.

### Single serializer for all content hashing
**Source:** `packages/spec/src/canonical.ts` (`canonicalize`/`hashCanonical`), already the sole hasher for `packages/core/src/receipts/chain.ts`
**Apply to:** `approval-dispatcher.ts`'s commitment hash (D-11) and `call-receipt.ts`'s `argsHash` — never introduce a second serializer or use `JSON.stringify` for hashing anywhere in `@stint/proxy`.

### Per-lease serialization via `LeaseStore.transaction`
**Source:** `packages/core/src/lease-store.ts` (contract) + `packages/core/src/testing.ts` (in-memory impl's `runSerialized`)
**Apply to:** `lease-serializer.ts` (counters mutation, D-06), `call-receipt.ts` (append ordering, D-13) — both must route through the SAME per-lease transaction, not two independent locks.

### Injected port, never a default implementation called directly
**Source:** `packages/core/src/license/license-issuer.ts` (`LicenseIssuer`)
**Apply to:** `outbound-connector.ts` (`OutboundConnector`) — ship the interface + one reference impl, but nothing in the enforcement path (`server.ts`, `credential-vault.ts`) may import the reference impl directly; it is always constructor-injected, exactly as core never imports its own mock `LicenseIssuer`.

### Barrel export discipline: testing helpers never in the public entry
**Source:** `packages/core/src/index.ts` (comments at lines 39-43, 54-57) + `packages/core/src/testing.ts` (separate subpath)
**Apply to:** `@stint/proxy`'s new `index.ts` — any mock `OutboundConnector`, mock OAuth server wiring, or contract-test factories for the proxy's own new stores/vaults must live in a `@stint/proxy/testing` subpath (mirroring `@stint/core/testing`), never re-exported from `.`.

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `packages/proxy/src/vault/oauth-client.ts`'s actual `oauth4webapi` call sites (discovery/refresh/revoke wiring, `allowInsecureRequests`, `resource` additionalParameters) | service | request-response | No OAuth client code exists anywhere in the repo yet; RESEARCH.md's `## Architecture Patterns` Pattern 3/4 (hands-on verified this session) is the primary source, not an in-repo analog. Follow those code examples directly. |
| `packages/proxy/src/server.ts`'s actual `@modelcontextprotocol/sdk` `Server` construction/`setRequestHandler` wiring | controller | request-response | No MCP server code exists in the repo (only the Phase 4 stub). RESEARCH.md's Pattern 1 (sourced from the shipped SDK `.d.ts`) is authoritative here. |

## Metadata

**Analog search scope:** `packages/core/src/**`, `packages/spec/src/**`, `packages/proxy/src/**` (existing stub), `packages/proxy/test/**`
**Files scanned:** `index.ts`, `lease.ts`, `host-adapter.ts`, `bindings.ts`, `lease-store.ts`, `policy.ts`, `receipts/chain.ts`, `receipts/receipt-store.ts`, `license/held-license.ts`, `license/license-issuer.ts`, `testing.ts` (core); `canonical.ts` (spec); `index.ts`, `package.json`, `test/smoke.test.ts` (proxy stub) — 14 files read in full or targeted sections
**Pattern extraction date:** 2026-09-28
