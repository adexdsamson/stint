# Phase 2: Lease State Machine & Policy Engine - Pattern Map

**Mapped:** 2026-09-27
**Files analyzed:** ~13 new/modified files in `packages/core`
**Analogs found:** 13 / 13 (all sourced from the tracked `packages/spec` package built in Phase 1)

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `packages/core/src/errors.ts` | model/utility (error vocabulary) | transform | `packages/spec/src/errors.ts` | exact |
| `packages/core/src/events.ts` | model (actor-namespaced event constructors) | event-driven | `packages/spec/src/envelope.ts` (branding + narrow constructor pattern) | role-match |
| `packages/core/src/lease.ts` (Lease type + `reduce`) | service (pure reducer) | event-driven/transform | `packages/spec/src/envelope.ts` (`verifyEnvelope` — Result-returning, step-numbered pure function over a table of checks) | role-match |
| `packages/core/src/transitions.ts` (§7.4 data table) | config/utility (lookup table) | transform | `packages/spec/src/validate.ts` (`VERIFIER_BRANCH_SCHEMA_KEY` — keyed lookup table pattern) | role-match |
| `packages/core/src/policy.ts` (`evaluatePolicy`, error-threshold check) | service (pure decision function) | transform | `packages/spec/src/envelope.ts` (`verifyEnvelope`) + `packages/spec/src/canonical.ts` (pure guard functions) | role-match |
| `packages/core/src/bindings.ts` (`ConnectorBinding`, `BindingSet`) | model | CRUD (lookup) | `packages/spec/src/envelope.ts` (`TrustStore` — nested `Record` keyed lookup type) | role-match |
| `packages/core/src/hash-guard.ts` (`verifyBoundHash`) | utility (shared pure guard) | transform | `packages/spec/src/canonical.ts` (`hashCanonical`/`hashCanonicalText`/`isContentHash`) | exact |
| `packages/core/src/host-adapter.ts` (`HostAdapter`, `LifecycleEvent`) | provider (contract interface) | event-driven | `packages/spec/src/envelope.ts` (`TrustStore` interface + `VerifiedManifest` branded interface style) | role-match |
| `packages/core/src/lease-store.ts` (`LeaseStore` contract) | store (async CRUD contract) | CRUD | `packages/spec/src/envelope.ts` (interface-first, Result-returning contract style) | partial (new data-flow: async CRUD; no async contract exists yet in spec) |
| `packages/core/src/testing.ts` (in-memory `LeaseStore` double + contract-test factory) | test double / utility | CRUD | `packages/spec/src/testing.ts` | exact |
| `packages/core/src/index.ts` (public API surface) | config (barrel export) | transform | `packages/spec/src/index.ts` | exact |
| `packages/core/package.json` (add `./testing` export) | config | n/a | `packages/spec/package.json` | exact |
| `packages/core/tsdown.config.ts` (add `testing.ts` entry) | config | n/a | `packages/spec/tsdown.config.ts` | exact |
| `packages/core/test/*.test.ts` (reducer, policy, bindings, host-adapter, lease-store contract tests) | test | transform | `packages/spec/test/validate.test.ts`, `packages/spec/test/brand.test.ts` | exact |

## Pattern Assignments

### `packages/core/src/errors.ts` (utility, transform)

**Analog:** `packages/spec/src/errors.ts` (full file, 40 lines — read in one pass)

Copy the exact three-part shape: a `const X_CODES = [...] as const` array, a derived `type XCode = (typeof X_CODES)[number]`, and a discriminated `Result<T>` union. Phase 2 needs its own code enum (reducer rejection codes + policy `deny` reason codes per D-10) — do NOT reuse `SpecErrorCode`, mint a parallel `CoreErrorCode`/`PolicyReasonCode` set, but mirror the exact structure:

```typescript
export const SPEC_ERROR_CODES = [
  "missing_required",
  // ...
] as const;

export type SpecErrorCode = (typeof SPEC_ERROR_CODES)[number];

export interface SpecError {
  readonly path: string;
  readonly code: SpecErrorCode;
  readonly message: string;
  readonly allowed?: readonly string[];
}

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly SpecError[] };
```

D-03/D-10 require this exact `Result<T>` shape reused verbatim (`{ ok: true, value }` / `{ ok: false, errors }`) for `reduce()` and, per D-09/D-10, a **separate discriminated union** (not `Result`) for `PolicyDecision`: `{ decision: 'allow' } | { decision: 'deny', reason } | { decision: 'require_approval', requirement }`. Model the `PolicyDecision` union directly on the `Verifier` discriminated union in `packages/spec/src/generated/manifest.ts` (lines 9, 74-100 — `type Verifier = ResourceQueryVerifier | UserConfirmVerifier | NoneVerifier`, each branch tagged by a literal `type` field): use a literal `decision` tag the same way.

Docblock convention to copy verbatim (top of file, lines 1-7): state which decisions this is a public API for (host UIs / receipts) and that renaming a code is a breaking change — same rationale as spec's D-31 comment.

---

### `packages/core/src/transitions.ts` (config/utility, transform) — the §7.4 table

**Analog:** `packages/spec/src/validate.ts` lines 22-29 (keyed-lookup const pattern):

```typescript
const VERIFIER_TYPES = ["resource_query", "user_confirm", "none"] as const;
type VerifierType = (typeof VERIFIER_TYPES)[number];

const VERIFIER_BRANCH_SCHEMA_KEY: Record<VerifierType, string> = {
  resource_query: "manifest#/definitions/ResourceQueryVerifier",
  user_confirm: "manifest#/definitions/UserConfirmVerifier",
  none: "manifest#/definitions/NoneVerifier",
};
```

Reuse this exact shape for the D-05 transition table: a `Record<StateEventKey, { actor: Actor; to: State }>` (or a `Map` keyed by a composite `${state}:${event}` string) — the point of the analog is that spec already establishes "one literal, exhaustively-typed lookup object, no nested conditionals" as the house style, and a unit test (`codegen.test.ts` — see below) that cross-checks generated/derived data against a second source of truth. Mirror `packages/spec/test/codegen.test.ts`'s cross-check pattern (it diffs generated output against schema) for the required "table matches ALP.md §7.4" test.

---

### `packages/core/src/lease.ts` (`reduce`, `Lease`, `TransitionRecord`) (service, event-driven)

**Analog:** `packages/spec/src/envelope.ts` (full file read, 215 lines)

Copy the numbered-step, early-return, Result-returning control flow of `verifyEnvelope` (lines 131-214) directly for `reduce(lease, event, now) => Result<{ lease, transition }>`:
- Local `err(...)` helper (lines 48-51) building a `SpecError`/rejection object — mirror this for `reduce`'s structured rejection helper.
- Numbered `// Step N` comments matching a normative external procedure (here ALP.md §7.4) — same convention: `// Step 1` through the transition-table lookup, guard checks, actor check, in that exact order, each with an early `return { ok: false, errors: [...] }`.
- `deepFreeze` (lines 59-68) — apply the same immutability discipline to the returned `Lease` object (Phase 2 D-04 requires a monotonic `version`; freeze the new lease the same way `VerifiedManifest` is frozen).
- Brand-by-construction pattern (lines 32-46, `verifiedManifestBrand` unique symbol): do NOT reuse this exact brand for `Lease`, but note the technique is available if `Lease` needs a "only `reduce`/`activateLease` can mint one" guarantee.

**Imports pattern** (lines 9-17) — copy the relative `.js`-suffixed ESM import convention and the `import type` split for types-only imports:
```typescript
import { canonicalize, CanonicalizationError, hashCanonicalText } from "./canonical.js";
import type { ContentHash } from "./canonical.js";
import { validateEnvelopeShape, validateManifest } from "./validate.js";
import type { SignedEnvelope } from "./generated/envelope.js";
import type { Manifest } from "./generated/manifest.js";
import type { SpecError, Result } from "./errors.js";
```
`@stint/core` files should import `@stint/spec`'s public surface the same way: `import { hashManifest } from "@stint/spec";` and `import type { VerifiedManifest, Manifest } from "@stint/spec";` (workspace package import, not relative — `@stint/core`'s `package.json` already depends on `@stint/spec: workspace:*`).

---

### `packages/core/src/hash-guard.ts` (`verifyBoundHash`) (utility, transform)

**Analog:** `packages/spec/src/canonical.ts` (full file, 158 lines)

D-21 requires one shared pure hash guard consumed by two entry points. Copy the small-pure-function-with-one-job style of `hashCanonical`/`hashCanonicalText`/`isContentHash` (lines 135-157):
```typescript
export function hashCanonical(value: unknown): ContentHash {
  return hashCanonicalText(canonicalize(value));
}

export function isContentHash(value: unknown): value is ContentHash {
  return typeof value === "string" && CONTENT_HASH_PATTERN.test(value);
}
```
`verifyBoundHash(boundHash, verifiedManifest)` should call `hashManifest(verifiedManifest.manifest)` (imported from `@stint/spec`) and do a plain string compare — no re-implementation of hashing (explicitly required: "Phase 2 must not re-implement hashing"). Each caller (`activateLease`, resume path) wraps the boolean result into its own event/rejection per D-21 — the guard itself stays a pure `boolean`/comparison function, matching `isContentHash`'s style of "one job, no Result wrapper, caller decides what a false means."

---

### `packages/core/src/testing.ts` (in-memory `LeaseStore` + contract-test factory) (test double / utility)

**Analog:** `packages/spec/src/testing.ts` (full file, 86 lines — read in one pass)

Copy structurally:
1. **Docblock convention** (lines 1-7): state explicitly which functions this subpath uniquely provides and why the public `.` entry never re-exports them — for `@stint/core/testing`, state: "the in-memory `LeaseStore` and the shared contract-test factory are the ONLY place a `LeaseStore` implementation is exercised generically; the public `.` entry never re-exports them so production code cannot accidentally depend on the test double."
2. **Small private helpers with guard clauses that throw plain `Error`** (lines 18-41, `readPublisherIdForDefault`, `requireManifestObject`, `requireEd25519PublicJwk`) — for the in-memory store, mirror this for input-shape assertions inside the double (not for `LeaseStore`'s own async methods, which should return values/Promises per D-13, not throw).
3. **Public async factory function returning a bundle of related test artifacts** (lines 70-85, `signManifestForTest` returning `{ envelope, trustStore, publicJwk, privateKey }`) — mirror this exactly for the D-14 "reusable contract-test factory": export something like `createLeaseStoreContractTests(makeStore: () => LeaseStore)` that returns/registers a Vitest `describe` suite, so Phase 6's JSON-file store can import and run the identical suite (this is the direct analog to `signManifestForTest` being importable and reusable across `envelope.test.ts` and `envelope-vectors.test.ts`).

**`package.json` `exports` map** — copy `packages/spec/package.json` lines 13-22 exactly, substituting package name:
```json
"exports": {
  ".": {
    "types": "./dist/index.d.ts",
    "import": "./dist/index.js"
  },
  "./testing": {
    "types": "./dist/testing.d.ts",
    "import": "./dist/testing.js"
  }
}
```
`packages/core/package.json` currently (as of Phase 1) only has the `.` entry (see full file below) — add the `./testing` block verbatim in the same position.

**`tsdown.config.ts`** — copy `packages/spec/tsdown.config.ts` lines 1-12 exactly, changing only the `entry` array to add the second file:
```typescript
import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["./src/index.ts", "./src/testing.ts"],
  format: "esm",
  platform: "node",
  dts: true,
  // platform: "node" defaults fixedExtension to true (.mjs/.d.mts output),
  // which doesn't match this package's "type": "module" + "./dist/index.js"
  // exports map. Force plain .js/.d.ts output instead (tsdown 0.21.10).
  fixedExtension: false,
});
```
`packages/core/tsdown.config.ts` currently has `entry: ["./src/index.ts"]` only (single-entry array) — change to the two-entry array above.

---

### `packages/core/src/index.ts` (barrel export) (config, transform)

**Analog:** `packages/spec/src/index.ts` (full file, 49 lines)

Copy the pattern of grouped named re-exports with `export { ... } from "./module.js";` and a separate `export type { ... } from "./module.js";` line per module, in dependency order (constants first, then errors, then validation, then domain types). `packages/core/src/index.ts` currently is:
```typescript
export { SPEC_VERSION } from "@stint/spec";

export const PACKAGE_NAME = "@stint/core";
```
Keep the existing two lines and append grouped exports for `reduce`, event constructors (`userEvents`, `clockEvents`, `policyEvents`, `providerEvents`, `publisherEvents`, `verifierEvents`, `runtimeEvents`), `evaluatePolicy`, `checkErrorThreshold`, `ConnectorBinding`/`BindingSet`, `HostAdapter`/`LifecycleEvent`, `LeaseStore`, `activateLease`, `verifyBoundHash`, and their associated types — following spec's `export { values } ... export type { Types }` split (index.ts lines 3-4, 6, 8-20 vs. 22-46).

**`packages/core/tsconfig.json`** already has the correct project-reference wiring needed (`"references": [{ "path": "../spec" }]`, `composite: true`) — no change needed, just confirmed as the analog for any further new package added later.

---

## Shared Patterns

### Result-not-throw (D-03, D-30)
**Source:** `packages/spec/src/errors.ts` (the `Result<T>` type) + `packages/spec/src/envelope.ts` lines 48-51 (the `err()` helper) and lines 131-214 (every public function returns `Result<...>`, never throws for expected failures — `throw` only appears for an unreachable `error` re-throw at line 172).
**Apply to:** `reduce`, `evaluatePolicy`'s internal guards, `verifyBoundHash`'s callers (`activateLease`), `LeaseStore` methods that can fail validation.

### Stable machine-readable codes for host-facing decisions (D-31, D-10)
**Source:** `packages/spec/src/errors.ts` (`SPEC_ERROR_CODES` as const array) — pattern: enumerate every code as a literal in one array, derive the union type from it, document in a comment that renaming/removing is a breaking change.
**Apply to:** `PolicyDecision`'s `reason` codes (`no_binding`, `expired`, `over_max_actions`, `over_actions_per_hour`, `over_spend`, ...) and any reducer rejection code enum.

### Branded/guarded construction (D-07 style, from Phase 1)
**Source:** `packages/spec/src/envelope.ts` lines 32-46 (`VerifiedManifest` brand via unexported unique symbol) and `packages/spec/src/testing.ts` header comment (lines 1-7) explaining why the public entry never re-exports the minting path.
**Apply to:** Consider for `Lease` only if a "only `reduce`/`activateLease` can produce a valid `Lease`" guarantee is wanted; not required by CONTEXT.md decisions, but the technique is established house style if the planner chooses it.

### `x-` passthrough / index-signature awareness
**Source:** `packages/spec/src/generated/manifest.ts` (every generated interface carries `[k: string]: unknown` for the `^x-` pattern; `packages/spec/src/validate.ts` lines 10-18 docblock warns that generated types are not a substitute for validation).
**Apply to:** Any Phase 2 code reading `Manifest.limits`/`Manifest.approvals`/`Manifest.lease` fields for policy — read only the closed, known fields; do not spread or trust unknown keys from the manifest into policy decisions (reinforces D-11: policy never derives classification from manifest content).

### ESM import/export conventions
**Source:** every `packages/spec/src/*.ts` file — relative imports always end in `.js` (NodeNext ESM resolution), `import type` used for type-only imports, no default exports anywhere, `workspace:*` linking for cross-package imports (`packages/core/package.json` already has `"@stint/spec": "workspace:*"`).
**Apply to:** All new `packages/core/src/*.ts` files.

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `packages/core/src/lease-store.ts` (async `LeaseStore` interface + `transaction`/`withLease` serialization primitive) | store contract | CRUD (async, serialized) | No async I/O contract exists yet anywhere in the tracked codebase (`packages/spec` is entirely synchronous except `verifyEnvelope`, which is async but not a stateful store). Use `packages/spec/src/envelope.ts`'s async-function shape (`export async function verifyEnvelope(...): Promise<Result<VerifiedManifest>>`) as the closest structural precedent for "async, Result-returning, single entry point," but design the per-id promise-chain serialization primitive from CONTEXT.md D-13 directly — there is no existing analog for a mutex/queue pattern in this repo. |
| `packages/core/src/host-adapter.ts` (three-method interactive contract with timeout-as-deny) | provider/contract | request-response (out-of-band, async, deadline/AbortSignal-driven) | No adapter-with-timeout-semantics pattern exists in the tracked codebase; `TrustStore` (envelope.ts line 30) is the closest shape precedent for "a small, purely-typed interface consumed by the core" but has none of the async/timeout behavior. Design per D-15..D-18 directly. |

## Metadata

**Analog search scope:** `packages/spec/src` (all 8 source files), `packages/spec/test` (layout only), `packages/spec/package.json`, `packages/spec/tsconfig.json`, `packages/spec/tsdown.config.ts`, `packages/core/*` (current stub state).
**Files scanned:** 13 (spec) + 5 (core stub/config)
**Pattern extraction date:** 2026-09-27
**Tracked-source gate:** All analog paths (`packages/spec/src/*.ts`, `packages/spec/package.json`, `packages/spec/tsconfig.json`, `packages/spec/tsdown.config.ts`) are ordinary tracked source files under the repo root, not `.gsd/capabilities/*` mirrors — verified by direct `Read` from the working tree at their canonical repo paths (no `.gsd/` prefix in any path above).
