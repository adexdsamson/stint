# Phase 6: CLI & Reference Adapters - Pattern Map

**Mapped:** 2026-09-29
**Files analyzed:** 22 new/modified
**Analogs found:** 19 / 22 (all analog paths verified git-tracked; no `.gsd/capabilities` mirrors used)

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `packages/cli/src/store/json-lease-store.ts` | store | CRUD + per-id serialized txn | `packages/core/src/testing.ts` `createInMemoryLeaseStore` (L47-94) + contract `packages/core/src/lease-store.ts` | exact (role+flow) |
| `packages/cli/src/store/json-receipt-store.ts` | store | append-only file I/O | `packages/core/src/testing.ts` `createInMemoryReceiptStore` + `packages/core/src/receipts/receipt-store.ts` | exact |
| `packages/cli/src/store/atomic-file.ts` | utility | file-I/O (atomic write, lock, retry) | none in repo (RESEARCH Pattern 1); queue idiom from `testing.ts` L51-61 | partial |
| `packages/cli/test/json-lease-store.contract.test.ts` | test | contract suite | `packages/core/test/lease-store-contract.test.ts` | exact |
| `packages/cli/test/json-receipt-store.contract.test.ts` | test | contract suite | `packages/core/test/receipts/receipt-store-contract.test.ts` | exact |
| `packages/cli/test/json-store-concurrency.test.ts` (+ `fixtures/hammer-worker.mjs`) | test | concurrent file I/O | in-contract `50 concurrent transaction()` test (`testing.ts` contract); no multi-process analog | partial |
| `packages/cli/src/adapter/terminal-host-adapter.ts` | adapter | request-response (prompt) | `packages/core/src/host-adapter.ts` interface L103-118; fake adapters in `packages/proxy/test/approvals.test.ts` | role-match |
| `packages/cli/src/adapter/{prompt,consent-view,sanitize}.ts` | utility | transform / terminal I/O | none (RESEARCH Pattern 3, Pitfall 7) | no analog |
| `packages/cli/test/terminal-host-adapter.test.ts` | test | request-response | `packages/core/test/host-adapter.test.ts`, `packages/proxy/test/approvals.test.ts` | role-match |
| `packages/cli/src/program.ts`, `bin.ts`, `exit.ts`, `paths.ts` | config/entry | request-response | `packages/cli/src/index.ts` (3-line skeleton only) | no analog (RESEARCH Pattern 2) |
| `packages/cli/src/commands/{create,inspect,revoke,cleanup}.ts` | controller | CRUD/txn | `packages/proxy/src/teardown/orchestrate.ts` (`runTeardown`/`retryTeardown`) | role-match |
| `packages/cli/src/commands/receipts.ts`, `verify.ts`, `render/{timeline,verify}.ts` | controller/renderer | transform | `packages/core/src/receipts/merge.ts`, `chain.ts` `verifyChain` | exact (data) |
| `packages/cli/src/commands/run.ts`, `run/run-lease.ts` | controller | streaming (MCP) | `packages/proxy/src/server.ts` + `packages/proxy/test/server-tracer.test.ts` | exact |
| `packages/cli/test/run.test.ts` | test | event-driven | `packages/proxy/test/server-tracer.test.ts` `connectedClient` | exact |
| `packages/cli/src/render/style.ts` | utility | transform | none | no analog |
| `packages/cli/package.json`, `tsdown.config.ts`, `vitest.config.ts` | config | build | existing `packages/cli/package.json`, `tsdown.config.ts`; `packages/proxy/package.json` | exact |
| `packages/cli/src/index.ts` | barrel | - | itself (L1-3) | exact |

## Pattern Assignments

### `json-lease-store.ts` (store, CRUD + serialized txn)

**Analog:** `packages/core/src/testing.ts` L47-94 (in-memory double). Copy its per-id promise-tail idiom, then put the file lock inside the queued task.

Per-id queue (L51-61):
```typescript
function runSerialized<T>(id: string, work: () => Promise<T>): Promise<T> {
  const previousTail = tails.get(id) ?? Promise.resolve();
  // Swallow a prior failure so one rejected transaction never wedges the chain
  const next = previousTail.catch(() => undefined).then(work);
  tails.set(id, next.catch(() => undefined));
  return next;
}
```
Transaction semantics to keep (L82-92): reject when id absent (message style `@stint/...: transaction("id") called before any lease was saved`), `const next = await mutate(current); write; return next`.
Contract shape (`lease-store.ts` L40-61): `load(id) => Lease|undefined`, `save`, `list`, `delete`, `transaction(id, mutate: LeaseMutator)`. `load`/`list` MUST be lock-free (dispatch.ts:306 calls `load` inside a txn; a locking load deadlocks). Locking/atomic/retry code: RESEARCH Pattern 1 (`withTransientRetry`, `atomicWriteJson`, `withFileLock` with `onCompromised`; check `compromised` between `mutate` and write).

### `json-receipt-store.ts`
**Analog:** `createInMemoryReceiptStore` in `testing.ts` and contract `receipt-store.ts` L37-58 (`append/load/readCheckpoint/writeCheckpoint`; no lease id, so construct per lease: `createJsonReceiptStore({ root, leaseId })`). Never compute/trust hashes in the store; append-only; chains `verified`/`attested` isolated.

### Contract tests (both stores)
**Analog:** `packages/core/test/lease-store-contract.test.ts` (entire file, 3 lines):
```typescript
import { createInMemoryLeaseStore, createLeaseStoreContractTests } from "../src/testing.js";
createLeaseStoreContractTests(() => createInMemoryLeaseStore());
```
CLI version imports from `@stint/core/testing`; `makeStore` is sync and called once per `it`, so `mkdtempSync` per call and clean up in `afterAll`. Receipt equivalent: `packages/core/test/receipts/receipt-store-contract.test.ts` with `createReceiptStoreContractTests`. `makeTestLease(id, overrides)` (testing.ts L102-114) is the lease fixture for the concurrency test.

### `terminal-host-adapter.ts` (adapter)
**Analog:** `packages/core/src/host-adapter.ts` L103-118. It has FOUR methods (`requestConsent`, `requestApproval`, `requestOutcomeConfirmation`, `notify`), not three. Decisions: `grant|decline(user_declined|timeout)`, `approve|deny(user_denied|timeout)`, `confirm|reject(user_rejected|timeout)`.
Rules to mirror (core owns outcome, host-adapter.ts L120-256): on abort/no-TTY/error the adapter rejects or returns nothing-proposed; core's `awaitApprovalDecision` folds rejection to `{decision:"deny",reason:"timeout"}` (L151-164). The adapter never implements its own deny timer. Prompt/countdown code: RESEARCH Pattern 3 (`askLine` with `readline/promises`, EOF guard, `signal`). Countdown needs `approvalTimeoutSeconds` passed to the constructor because `ApprovalRequest` has only `approvalId, summary, binding`.
Adapter-shaped fakes to copy for tests: `packages/proxy/test/approvals.test.ts` (`neverResolvingAdapter`, `throwingAdapter`, capturing adapter L177-190 with `requestConsent() { return Promise.reject(new Error("n/a")); }` for unused methods). Manifest fixture for consent render: `packages/core/test/host-adapter.test.ts` L1-60 (`signManifestForTest` + `verifyEnvelope` -> `VerifiedManifest`).

### `run/run-lease.ts` and `run.test.ts` (streaming MCP)
**Analog:** `packages/proxy/src/server.ts` L46-61 (`ProxyDeps`) and L100-119 (`createLeaseProxyServer(deps): Server`, returns unconnected server). `runLease({transport, adapter,...})` builds `ProxyDeps` then `await server.connect(transport)`. Production seams: `createApprovalDispatcher(adapter, manifest.approvals.timeout_seconds, clock)` (`packages/proxy/src/approvals/approval-dispatcher.ts`), `createVaultExecuteStage`, `createCapEnforcer`.
Test harness to copy verbatim (`server-tracer.test.ts` L94-100):
```typescript
export async function connectedClient(deps: ProxyDeps): Promise<Client> {
  const server = createLeaseProxyServer(deps);
  const client = new Client({ name: "test-agent", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}
```
Imports (L12-24): `Client` from `@modelcontextprotocol/sdk/client/index.js`, `InMemoryTransport` from `.../inMemory.js`, `createToolCatalog`, `createBindingSet`. `buildDeps` (L50-92) shows a complete `ProxyDeps` literal; swap `approve: DEFAULT_APPROVAL_STAGE` for the real dispatcher over the terminal adapter (faked TTY streams). Do not print to stdout on the run path.

### `commands/cleanup.ts`, `revoke.ts` (controller, txn)
**Analog:** `packages/proxy/src/teardown/orchestrate.ts` L225-283. `TeardownDeps = { leaseStore, receiptStore, leaseId, steps, notify?, signingKey? }`.
```typescript
export async function runTeardown(deps: TeardownDeps, now: number): Promise<Lease>   // auto-chains begin_teardown from terminal end states
export async function retryTeardown(deps, actor: "user" | "runtime", now): Promise<Lease>
```
State switch table in RESEARCH Pattern 5. Revoke: `transaction(id, l => reduce(l, userEvents.revoke(), now))` then `appendTransitionReceipt` (exported from proxy index) then `runTeardown`. Always pass a real vault to `createDefaultTeardownSteps`.

### `render/timeline.ts`, `render/verify.ts`
**Analog:** `packages/core/src/receipts/merge.ts` L26-32, 57-67:
```typescript
export interface TimelineEntry { readonly origin: "verified" | "attested"; readonly entry: ReceiptEntry }
export function mergeTimeline(verified: readonly ReceiptEntry[], attested: readonly ReceiptEntry[]): readonly TimelineEntry[]
```
`--json` emits this array unchanged. `verifyChain(chain, checkpoint?, checkpointPublicKey?)` (chain.ts L196-262) returns `{ ok:true, value:{headHash,count} }` or `{ ok:false, errors:[{brokenAtSeq, reason}] }`. Pass checkpoint plus public key whenever a checkpoint exists (else tail tampering is invisible). Reason enum is 5 values in `packages/core/src/receipts/errors.ts` L21-27; type the message table `Record<ReceiptVerifyReason, string>`. Attested chain: `verifyAttestedChain(chain, trustStore, checkpoint?, key?)`.

### `package.json`, `tsdown.config.ts`, `vitest.config.ts`
**Analog:** `packages/cli/package.json` (current: engines `>=22.12.0` to bump to `>=22.18.0`, deps only core+proxy) and `packages/proxy/package.json` for dependency pin style (exact `"@modelcontextprotocol/sdk": "1.30.1"`, `"jose": "6.2.12"`, `@stint/spec: workspace:*`, `exports["./testing"]` shape). `tsdown.config.ts` currently `entry: ["./src/index.ts"]`, keep `fixedExtension: false`, add `./src/bin.ts` and `"bin": {"stint": "./dist/bin.js"}`. No vitest config exists in cli or proxy; add cli one for `testTimeout` only.

### `test/smoke.test.ts` (existing, modify)
Currently asserts `PACKAGE_NAME` and `PROXY_PACKAGE_NAME` from `../src/index.js`; keep exports when extending the barrel.

## Shared Patterns

- **Deny-by-default owned by core:** adapters only propose; never add adapter-side timers producing deny/approve (`host-adapter.ts` L120-256).
- **Result-not-throw enums to exit codes:** map `verifyChain` reasons and lease states to exit codes (A6 in RESEARCH); commander errors via `exitOverride` (RESEARCH Pattern 2); no `process.exit` in actions.
- **Injected clock/IO:** every core/proxy API takes `now: number`/`clock: () => number` in epoch seconds; CLI passes an injected clock for testability.
- **Test imports:** `@stint/core/testing`, `@stint/spec/testing` (`signManifestForTest`), `@stint/proxy/testing` (`createEchoExecuteStage`); build is required first (`pnpm test` = build + vitest).
- **Style:** ESM, `.js` extensions on relative imports, `import type` split (verbatimModuleSyntax), readonly fields, TSDoc module header on each file citing decision IDs.
- **Secrets:** no secrets in output/receipts; sanitize manifest/receipt-derived strings before printing (RESEARCH Pitfall 7).

## No Analog Found

| File | Role | Data Flow | Reason |
|---|---|---|---|
| `store/atomic-file.ts` | utility | file I/O | No file persistence exists in repo; use RESEARCH Pattern 1 (empirically verified on Windows) |
| `adapter/prompt.ts`, `sanitize.ts`, `consent-view.ts` | utility | terminal I/O | No terminal code exists; RESEARCH Pattern 3, Pitfall 7 |
| `program.ts`, `bin.ts`, `exit.ts`, `paths.ts` | entry | request-response | CLI is a 3-line barrel; RESEARCH Pattern 2 |
| `render/style.ts` | utility | transform | Use `picocolors.createColors(explicit)` (Pitfall 6) |
| `keys/runtime-key.ts`, `trust/trust-store.ts` | utility | file I/O | New gaps (RESEARCH Open Q 3/4) |

## Metadata

**Analog search scope:** `packages/cli`, `packages/core/src`, `packages/core/test`, `packages/proxy/src`, `packages/proxy/test`
**Files scanned:** ~75 tracked files listed, 12 read
**Pattern extraction date:** 2026-09-29
