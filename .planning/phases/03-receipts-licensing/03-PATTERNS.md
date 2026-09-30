# Phase 3: Receipts & Licensing - Pattern Map

**Mapped:** 2026-09-27
**Files analyzed:** 16 (new) + 2 spec edits + schema/vector additions
**Analogs found:** 14 / 16 (2 have no close in-repo analog; use RESEARCH.md code examples instead)

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `packages/core/src/receipts/chain.ts` (appendEntry/verifyChain) | service (pure) | transform / event-driven | `packages/spec/src/canonical.ts` | role-match (pure hashing transform) |
| `packages/core/src/receipts/checkpoint.ts` (signCheckpoint/verifyCheckpoint) | service (pure crypto) | transform | `packages/spec/src/jws.ts` | exact (identical detached-EdDSA sign/verify shape) |
| `packages/core/src/receipts/merge.ts` (mergeTimeline) | utility (read-side) | transform | `packages/core/src/lease.ts` (`reduce`, pure transform of typed input to typed output) | role-match |
| `packages/core/src/receipts/receipt-store.ts` (ReceiptStore interface) | store/interface | CRUD | `packages/core/src/lease-store.ts` | exact (interface shape, CRUD + async contract) |
| `packages/core/src/receipts/errors.ts` (or extension of `errors.ts`) | utility (error vocabulary) | n/a | `packages/core/src/errors.ts` | exact |
| `packages/core/src/license/issue.ts` (issueLicense) | service | request-response (sign) | `packages/spec/src/jws.ts` (`signDetached`) for wrapper-around-library-call shape; RESEARCH.md Pattern 3 for paseto specifics | role-match + code-example (no in-repo paseto analog) |
| `packages/core/src/license/verify.ts` (verifyLicense) | service | request-response (verify) | `packages/spec/src/envelope.ts` (`verifyEnvelope` — Result-returning, sanitized-error verify) | exact (error-mapping discipline) |
| `packages/core/src/license/implicit-assertion.ts` (deriveImplicitAssertion) | utility | transform | `packages/spec/src/canonical.ts` (`hashCanonical` — single shared deterministic derivation) | role-match |
| `packages/core/src/license/refresh.ts` (needsRefresh/clampedLicenseExpiry) | service (pure decision) | transform | `packages/core/src/lease.ts` (`reduce`, pure state-decision function under injected clock) — see also `activate.ts` | exact (pure decision + injectable clock pattern) |
| `packages/core/src/license/license-issuer.ts` (LicenseIssuer port) | interface/port | request-response | `packages/core/src/lease-store.ts` (interface pattern: methods returning `Promise<T>`, injected not hard-wired) | role-match |
| `packages/core/src/license/held-license.ts` (opaque branded type) | utility (type-level guard) | n/a | `packages/spec/src/envelope.ts` (`VerifiedManifest` brand: private unique symbol, mint-only-by-one-function) | exact |
| `packages/core/src/testing.ts` (extend: createInMemoryReceiptStore, createReceiptStoreContractTests, createMockLicenseIssuer) | test-double/factory | CRUD (contract test) | `packages/core/src/testing.ts` (existing `createInMemoryLeaseStore` / `createLeaseStoreContractTests`) | exact (this IS the mirrored file) |
| `spec/receipt.schema.json` | config (schema) | n/a | `spec/manifest.schema.json` | exact (draft-07 JSON Schema convention) |
| `spec/checkpoint.schema.json` | config (schema) | n/a | `spec/envelope.schema.json` | exact |
| `packages/spec/scripts/codegen.mjs` (extend `targets` array) | config/build | batch (codegen) | itself (existing file, add 2 entries) | exact |
| `spec/ALP.md` §8, §11 (edit, resolve `[OPEN: Phase 3]`) | config/docs | n/a | `spec/ALP.md` §7.5 (Phase 2's resolution of its own `[OPEN: Phase 2]` marker) | exact |
| `spec/vectors/receipts/` + `spec/vectors/license/` (new fixture dirs) | test fixture | batch | `spec/vectors/jcs/` (existing golden-hash fixture + README section) | exact |

## Pattern Assignments

### `packages/core/src/receipts/chain.ts` (service, transform)

**Analog:** `packages/spec/src/canonical.ts` (full file read; see required_reading)

**Imports pattern:**
```typescript
import { canonicalize, hashCanonicalText } from "@stint/spec";
```
Never import `createHash`/`canonicalize` (the third-party lib) directly in `@stint/core` — only the wrapped `@stint/spec` exports, per D-05 ("No new serializer and no ad-hoc `JSON.stringify` anywhere in the receipt path").

**Core pattern — recompute-not-store, from `canonical.ts` lines 134-147:**
```typescript
export function hashCanonical(value: unknown): ContentHash {
  return hashCanonicalText(canonicalize(value));
}
export function hashCanonicalText(canonicalText: string): ContentHash {
  const hex = createHash("sha256").update(canonicalText, "utf8").digest("hex");
  return `${CONTENT_HASH_PREFIX}${hex}`;
}
```
Mirror this exact "canonicalize then hash, never trust a stored hash" discipline in `verifyChain`: recompute each entry's expected link from `canonicalize(entry)` and compare, never read a stored hash field as ground truth (D-04).

**Error handling pattern** (from `canonical.ts` lines 36-48, `CanonicalizationError`): named `Error` subclass with a fixed, path-only message (RFC 6901 JSON Pointer), never echoing the offending value. Apply the identical shape to any new `ChainError`/reason codes — message text must never interpolate receipt payload content (D-16).

**Docstring convention to copy** (lines 1-18): a top-of-file comment stating (a) what invariant this file is the single source of truth for, (b) which other files depend on that invariant, (c) the specific historical footgun being avoided. Use this exact structure for `chain.ts`'s own header, referencing D-04/D-05.

---

### `packages/core/src/receipts/checkpoint.ts` (service, transform)

**Analog:** `packages/spec/src/jws.ts` (full file read — this is an exact-match analog per the phase's required_reading)

**Imports pattern** (lines 18-19):
```typescript
import { FlattenedSign, flattenedVerify, base64url } from "jose";
import type { CryptoKey } from "jose";
```

**Core pattern — one shared header constant, computed once** (lines 21-25):
```typescript
export const JWS_PROTECTED_HEADER = { alg: "EdDSA" } as const;
export const JWS_PROTECTED_B64: string = base64url.encode(JSON.stringify(JWS_PROTECTED_HEADER));
```
Mirror exactly for `checkpoint.ts`: define `CHECKPOINT_HEADER = { alg: "EdDSA" } as const` once at module scope — never reconstruct the header object at each call site (this is the file's own documented anti-pattern, "RESEARCH Pitfall 5").

**Sign pattern** (lines 27-36):
```typescript
export async function signDetached(payload: Uint8Array, privateKey: CryptoKey): Promise<string> {
  const jws = await new FlattenedSign(payload).setProtectedHeader(JWS_PROTECTED_HEADER).sign(privateKey);
  return jws.signature;
}
```
`signCheckpoint` should follow this exact shape: canonicalize the checkpoint summary object via `@stint/spec`'s `canonicalize`, `TextEncoder().encode()` it, then call `FlattenedSign` identically. Injected `privateKey: CryptoKey` parameter — never read from disk/env inside `@stint/core` (D-07).

**Verify pattern — never forward library exception text** (lines 38-56):
```typescript
export async function verifyDetached(payload: Uint8Array, signature: string, publicKey: CryptoKey): Promise<boolean> {
  try {
    await flattenedVerify(
      { protected: JWS_PROTECTED_B64, payload: base64url.encode(payload), signature },
      publicKey,
      { algorithms: ["EdDSA"] },
    );
    return true;
  } catch {
    return false;
  }
}
```
Copy this try/catch-swallow-to-boolean/Result shape directly for `verifyCheckpoint` — every failure mode (wrong key, tampered payload, malformed signature) collapses to one fixed outcome, never `error.message`.

---

### `packages/core/src/receipts/receipt-store.ts` (store/interface, CRUD)

**Analog:** `packages/core/src/lease-store.ts` (full file read)

**Interface shape to mirror** (lines 40-61):
```typescript
export interface LeaseStore {
  load(id: string): Promise<Lease | undefined>;
  save(lease: Lease): Promise<void>;
  list(): Promise<readonly Lease[]>;
  delete(id: string): Promise<void>;
  transaction(id: string, mutate: LeaseMutator): Promise<Lease>;
}
```
`ReceiptStore` should follow the same "async, returns a value, never throws for an expected outcome" shape (per the file's own header comment, lines 17-24), scoped to append/load/checkpoint-read-write instead of full CRUD+transaction (per D-08: append/load/checkpoint read-write, not a lease-shaped mutator). Do NOT fold this into `LeaseStore` — keep the interface in its own file exactly as `lease-store.ts` is separate from `lease.ts`.

**Docstring convention** (lines 1-24): document the concurrency/serialization guarantee (or explicitly its absence, if append-only makes it moot) directly in the interface's doc comment, as the normative contract Phase 6 implements against — not merely a suggestion.

---

### `packages/core/src/receipts/errors.ts` (or extension of `errors.ts`)

**Analog:** `packages/core/src/errors.ts` (full file read)

**Pattern to copy exactly** (lines 1-29):
```typescript
export const CORE_ERROR_CODES = [
  "illegal_transition",
  "wrong_actor",
  "extension_exceeds_max",
] as const;
export type CoreErrorCode = (typeof CORE_ERROR_CODES)[number];
export interface CoreError {
  readonly path: string;
  readonly code: CoreErrorCode;
  readonly message: string;
  readonly context?: Readonly<Record<string, string>>;
}
export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly CoreError[] };
```
Add a sibling `as const` array (e.g. `RECEIPT_VERIFY_REASONS = ["hash_mismatch", "reordered", "truncated", "checkpoint_sig_invalid"] as const`) — per D-09 and RESEARCH.md Pitfall 4, this vocabulary must stay parallel to and independent of both `SpecErrorCode` and `CoreErrorCode`, never importing/aliasing either. Reuse the same `Result<T>` shape (or extend it with `brokenAtSeq`) rather than inventing a third Result type.

---

### `packages/core/src/license/verify.ts` (service, request-response)

**Analog:** `packages/spec/src/envelope.ts` (`verifyEnvelope`, lines 1-100+ read; full error-mapping/brand pattern)

**Error-mapping pattern** (lines 48-51, and the file's own header at lines 34-46):
```typescript
function err(path: string, code: SpecError["code"], message: string, allowed?: readonly string[]): Result<never> {
  const error: SpecError = allowed === undefined ? { path, code, message } : { path, code, message, allowed };
  return { ok: false, errors: [error] };
}
```
`verifyLicense` should build an identical small `err(...)` helper local to `license/verify.ts`, mapping each caught `PasetoError` subclass (`ClaimValidationError`, `InvalidTokenError`, `InvalidKeyError`) to one of `verify.ts`'s own fixed, non-interpolated codes — never forwarding `error.message` (mirrors `envelope.ts`'s own "never echo the offending value" discipline, D-16, RESEARCH.md Common Pitfall 6).

**Brand pattern for `held-license.ts`** (lines 32-46):
```typescript
declare const verifiedManifestBrand: unique symbol;
export interface VerifiedManifest {
  readonly manifest: Manifest;
  ...
  readonly [verifiedManifestBrand]: true;
}
```
Copy this exact shape for `HeldLicense`: a module-private `unique symbol` brand field, so no code outside `license/` can construct a `HeldLicense` value without a type assertion — enforced by a `brand.test.ts` with `@ts-expect-error`, exactly as this file's own pattern is verified (per D-15).

**Deep-freeze pattern** (lines 59-68) — optional but consistent: consider freezing the held license/claims object after minting, matching `deepFreeze` here, so a `HeldLicense` cannot be mutated post-construction.

---

### `packages/core/src/license/issue.ts` / `refresh.ts`

**No strong in-repo analog for PASETO-specific code** (paseto is a brand-new dependency this phase). Use RESEARCH.md's Pattern 3 and Pattern 4 code examples directly (already vetted against the pinned `paseto@4.0.1` source this session) — do not invent a different shape. Follow the same "injected clock, no timers" discipline already established in `packages/core/src/lease.ts` (`reduce(lease, event, now: number)`) and `activate.ts` — every `now` parameter is epoch-seconds `number`, and the paseto `Date`/RFC-3339 conversion is isolated entirely inside `issue.ts`/`verify.ts` (RESEARCH.md Pitfall 1).

---

### `packages/core/src/testing.ts` (extend)

**Analog:** `packages/core/src/testing.ts` itself (full file read — this IS the file to extend, not a separate analog)

**Pattern to mirror for `createInMemoryReceiptStore`** (lines 28-75):
```typescript
export function createInMemoryLeaseStore(): LeaseStore {
  const leases = new Map<string, Lease>();
  ...
  return { load(id) {...}, save(lease) {...}, list() {...}, delete(id) {...}, transaction(id, mutate) {...} };
}
```
Build `createInMemoryReceiptStore()` with the same closure-over-`Map` shape, scoped to `ReceiptStore`'s smaller surface (append/load/checkpoint read-write, D-08's discretion point).

**Pattern to mirror for `createReceiptStoreContractTests`** (lines 91-166):
```typescript
export function createLeaseStoreContractTests(makeStore: () => LeaseStore): void {
  describe("LeaseStore contract", () => {
    it("CRUD: load(missing) returns undefined; list() on a fresh store returns []", async () => { ... });
    ...
  });
}
```
Copy this exact `describe`/`it` factory-function shape for `createReceiptStoreContractTests(makeStore: () => ReceiptStore)`, with append-only-integrity assertions instead of CRUD+concurrency assertions (per D-08's discretion note: "provided the contract test proves append-only integrity"). Also add `createMockLicenseIssuer()` as a third factory in this same file, returning a `LicenseIssuer` backed by a fixed test Ed25519 keypair (mirrors this file's existing "test double with fixed/deterministic fixture data" convention, e.g. `makeTestLease`, lines 77-89).

---

### `spec/receipt.schema.json` / `spec/checkpoint.schema.json`

**Analog:** `spec/manifest.schema.json` / `spec/envelope.schema.json` (not read in full this pass — file paths confirmed via Glob: `spec/manifest.schema.json`, `spec/envelope.schema.json`). Both are draft-07 JSON Schema files consumed by `packages/spec/scripts/codegen.mjs`.

**Codegen integration pattern** (`packages/spec/scripts/codegen.mjs` lines 30-33, full file read):
```javascript
const targets = [
  { schemaFile: "manifest.schema.json", typeName: "Manifest", outFile: "manifest.ts" },
  { schemaFile: "envelope.schema.json", typeName: "SignedEnvelope", outFile: "envelope.ts" },
];
```
Add two entries: `{ schemaFile: "receipt.schema.json", typeName: "ReceiptEntry", outFile: "receipt.ts" }` and `{ schemaFile: "checkpoint.schema.json", typeName: "Checkpoint", outFile: "checkpoint.ts" }`. Also extend the `schemasContent` template (lines 80-88) to export `receiptSchema`/`checkpointSchema` alongside `manifestSchema`/`envelopeSchema`, following the identical `JSON.stringify(schema, null, 2)` pattern. Note the file's own comment (lines 61-70) about stripping `allOf` for type generation only — apply the same treatment if the new schemas use `allOf`/conditional `if`/`then` for the discriminated union (D-04's `payload` keyed by `type`).

---

## Shared Patterns

### Canonical serialization (every receipt/checkpoint hash)
**Source:** `packages/spec/src/canonical.ts` (`canonicalize`, `hashCanonical`, `hashCanonicalText`, `CONTENT_HASH_PREFIX`, `MAX_CANONICAL_DEPTH`)
**Apply to:** `receipts/chain.ts`, `receipts/checkpoint.ts`, `license/implicit-assertion.ts` — every place a hash or a deterministic byte-derivation is needed. Never a second serializer, never bare `JSON.stringify`.

### Detached EdDSA sign/verify
**Source:** `packages/spec/src/jws.ts` (`FlattenedSign`/`flattenedVerify`, one shared protected-header constant, try/catch-to-boolean verify)
**Apply to:** `receipts/checkpoint.ts` only (licensing uses `paseto`, not `jose`, per D-07's explicit separation).

### Result-not-throw + stable, vocabulary-independent error codes
**Source:** `packages/core/src/errors.ts` (`CORE_ERROR_CODES` as const array, `Result<T>` discriminated union) and `packages/spec/src/envelope.ts` (`err(...)` helper, never echoing offending values)
**Apply to:** `receipts/chain.ts` (`verifyChain` → `Result` with `{brokenAtSeq, reason}`), `license/verify.ts` (`verifyLicense` → `Result`, mapping `PasetoError` subclasses to fixed codes).

### Pure decision under an injectable clock, no timers
**Source:** `packages/core/src/lease.ts` (`reduce(lease, event, now: number)`), `packages/core/src/activate.ts`
**Apply to:** `license/refresh.ts` (`needsRefresh`, `clampedLicenseExpiry`) — every `now` is an injected epoch-seconds `number`, re-evaluated per call, never cached.

### Brand-by-construction (unique symbol, mint-only-by-one-function)
**Source:** `packages/spec/src/envelope.ts` (`VerifiedManifest`, `verifiedManifestBrand` unique symbol, `deepFreeze`)
**Apply to:** `license/held-license.ts` (`HeldLicense` opaque branded type, D-15) — the single narrow accessor pattern Phase 4 will consume.

### In-memory double + reusable contract-test factory
**Source:** `packages/core/src/testing.ts` (`createInMemoryLeaseStore`, `createLeaseStoreContractTests`, `makeTestLease`)
**Apply to:** extend the SAME file with `createInMemoryReceiptStore`, `createReceiptStoreContractTests`, `createMockLicenseIssuer` (D-08, D-11) — do not create a second testing entry point; `./index.ts` never re-exports this subpath.

### Schema-is-canonical, types-are-generated
**Source:** `packages/spec/scripts/codegen.mjs`, `spec/manifest.schema.json`
**Apply to:** `spec/receipt.schema.json`, `spec/checkpoint.schema.json` — add to `codegen.mjs`'s `targets` array; `@stint/core` imports generated types, never hand-writes them (D-03).

## No Analog Found

| File | Role | Data Flow | Reason |
|---|---|---|---|
| `packages/core/src/license/issue.ts` (paseto `SignFactory`/`PublicProtocol` composition) | service | request-response | `paseto` is a brand-new dependency this phase (no prior PASETO usage in the repo); use RESEARCH.md Pattern 3's verified-from-source code example instead of an in-repo analog. |
| `packages/core/src/license/verify.ts` (paseto `VerifyFactory` composition, clock-skew/implicit-assertion wiring) | service | request-response | Same reason — the epoch-seconds↔RFC-3339 conversion boundary and `clockTolerance`/`implicitAssertion` wiring have no prior precedent in this codebase; the closest analog (`envelope.ts`) supplies only the Result/error-mapping shape, not the PASETO-specific mechanics. |

## Metadata

**Analog search scope:** `packages/core/src/` (lease.ts, lease-store.ts, activate.ts, errors.ts, testing.ts, policy.ts, bindings.ts, index.ts), `packages/spec/src/` (canonical.ts, envelope.ts, jws.ts, validate.ts, testing.ts, generated/, index.ts), `packages/spec/scripts/codegen.mjs`, `spec/*.schema.json`, `spec/vectors/` layout referenced via RESEARCH.md
**Files scanned:** 9 read directly this session (canonical.ts, jws.ts, testing.ts, errors.ts, lease-store.ts, envelope.ts, codegen.mjs) plus CONTEXT.md/RESEARCH.md's own direct-read excerpts of lease.ts/activate.ts/policy.ts/bindings.ts (cited, not re-read to avoid duplicate context cost)
**Pattern extraction date:** 2026-09-27
