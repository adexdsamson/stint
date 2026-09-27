# Phase 3: Receipts & Licensing - Research

**Researched:** 2026-09-27
**Domain:** Tamper-evident hash-chained audit log (dual verified/attested chains, Ed25519 checkpoints) + PASETO v4.public offline license issuance/verification/refresh
**Confidence:** HIGH (paseto@4.0.1's actual factory-composition API was read directly from the shipped `.d.ts`/`.ts` source this session, not inferred from docs; canonical serializer, envelope trust model, and `LeaseStore` contract patterns were read directly from the Phase 1/2 code this phase builds on)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Spec resolution (both `[OPEN: Phase 3]` markers)**
- **D-01:** Phase 3 resolves **both** spec markers **normatively in `spec/ALP.md`**: §8 gets the hosted-license claim set + implicit-assertion derivation; §11 gets the receipt and checkpoint entry format. ALP.md stays the single normative source; `@stint/core` conforms to it (matches Phase 2 filling §7.5). — **Reversibility:** one-way.
- **D-02:** Add **two conformance vector sets** under `spec/vectors/`, consumed by Stint's own tests (no private vector set): a **receipt-chain golden vector** (fixed entries → pinned canonical bytes + head hash + checkpoint signing input) and a **license vector** (claims → token + public key + implicit-assertion input, with valid and invalid cases). — **Reversibility:** costly.

**Receipt & checkpoint format**
- **D-03:** The receipt and checkpoint schemas are **draft-07 JSON Schema in `@stint/spec`** (e.g. `receipt.schema.json`, `checkpoint.schema.json`), with TypeScript types **generated** via `json-schema-to-typescript` under `codegen:check` — the identical manifest/envelope pipeline from Phase 1. `@stint/core` imports the generated types; it never hand-writes them. — **Reversibility:** costly.
- **D-04:** A `ReceiptEntry` is `{ seq, ts, chain, type, prevHash, payload }` where `payload` is a **discriminated union keyed by `type`** (e.g. `call` | `transition` | `teardown_step` | `attested_claim`). The **entry hash is computed on demand, not stored** (recomputed during verify from the canonical bytes); `prevHash` is the only stored link, and the genesis `prevHash` is a fixed constant. — **Reversibility:** one-way.
- **D-05:** Every receipt/checkpoint hash goes through the **existing `@stint/spec` canonical serializer** (`canonicalize` / `hashCanonical`, `jcs-sha256:` prefix, RFC 8785, `MAX_CANONICAL_DEPTH`). No new serializer and no ad-hoc `JSON.stringify` anywhere in the receipt path.
- **D-06:** The runtime signs an **Ed25519 checkpoint at every lease-ending event** (the spec §11 floor) **plus an on-demand** pure `signCheckpoint(chain, key, now)` the caller may invoke. Checkpoint content is at least `{ chain, count, headHash, ts }` signed. — **Reversibility:** costly.
- **D-07:** **Attested-chain publisher signatures reuse the `@stint/spec` trust model** — the same `TrustStore` / `Ed25519PublicJwk` / `kid` pattern as envelope verification. The runtime's **own checkpoint signing uses `jose`** in `@stint/core`, with the checkpoint **keypair passed in (injectable)**, never hard-wired. The two chains keep fully independent integrity.

**Receipt persistence (enabling work)**
- **D-08:** Phase 3 ships **pure `append` / `verify` / `merge` functions** over in-memory chain values, **plus a `ReceiptStore` interface** (append / load / checkpoint read-write) with an **in-memory double + reusable contract-test factory** exported from `@stint/core/testing` — mirroring the Phase 2 `LeaseStore` pattern. The receipt log stays **related but distinct** from `LeaseStore` — it is NOT folded into `LeaseStore`. — **Reversibility:** costly.
- **D-09:** `verifyChain(...)` returns a **`Result`** whose failure carries a **precise break locus** `{ brokenAtSeq, reason }` where `reason` is a **stable code** (`hash_mismatch` | `reordered` | `truncated` | `checkpoint_sig_invalid`), anchored to the last valid checkpoint. — **Reversibility:** costly.
- **D-10:** The **merge is display-only**: a read-side function that produces a timeline marking each entry `verified` / `attested`; it never touches either chain's hash linkage or signatures, and its ordering carries **no integrity meaning**.

**Licensing (issue / verify / refresh)**
- **D-11:** `@stint/core` ships a **real reference `license/issue.ts` (sign)** and **`license/verify.ts` (offline verify)**. The runtime depends on an **injectable `LicenseIssuer` port** (issue / reissue) and **never signs** — the **mock publisher in `@stint/core/testing`** implements the port with a test keypair, and Phase 7's mock publisher reuses it. — **Reversibility:** costly.
- **D-12:** **Refresh = pure decision + clamped TTL.** A pure `needsRefresh(license, now, skew)` decides *when* (before TTL, evaluated per call, no timer). On refresh, the issued expiry is **clamped: `exp = min(now + defaultTTL, lease.expires_at)`**; at or after `lease.expires_at` refresh is refused. There is **no cached "still valid" boolean** reused across calls. — **Reversibility:** costly.
- **D-13:** **License claims:** use PASETO **registered claims** `exp` / `iat` / `nbf` / `jti`; carry **`lease_id`, `job`, and `limits` as custom claims**; put **`kid` in the footer** (footer is authenticated but public/non-secret). The **implicit assertion** is a canonical derivation over **`lease_id` + `spec_version`**, computed by **one shared function used by both issue and verify**. The **300s default TTL is runtime configuration, never in the manifest**. — **Reversibility:** one-way.
- **D-14:** **Explicit, tested clock-skew tolerance** wherever `exp`/`nbf` is checked — never the library default of zero — deliberately small relative to the 5-minute TTL (single-digit seconds). Boundary tests: 1s before expiry passes, 1s past (beyond skew) fails.
- **D-15:** The held license is an **opaque branded type**; the raw token string is reachable only through a **single narrowly-typed accessor** used by the outbound-injection path (wired in Phase 4). No agent-facing, receipt-facing, or customer-resource-facing function accepts or returns it — LIC-05 / secretless is enforced **by construction**, not by review. — **Reversibility:** costly.

**Secret safety (carried into every receipt path)**
- **D-16:** Receipt-writer input types carry **only `argsHash` + `redactedSummary`** (and typed non-secret fields) — never raw args, tokens, or the license — so leaking a secret into a receipt is a **compile error**. Any error caught from a PASETO/crypto library call is **sanitized to a fixed, non-interpolated message** before it can reach a receipt or log path.

### Claude's Discretion
- Exact TypeScript names for types/functions (`ReceiptEntry`, `Checkpoint`, `Chain`, `ReceiptStore`, `appendEntry`, `verifyChain`, `mergeTimeline`, `signCheckpoint`, `License`, `LicenseIssuer`, `issueLicense`, `verifyLicense`, `needsRefresh`, `deriveImplicitAssertion`, etc.) as long as they encode the decisions above.
- Exact stable reason-code strings in `verifyChain` failures beyond the examples in D-09.
- Exact JSON Schema field names/ordering in `receipt.schema.json` / `checkpoint.schema.json`, provided the generated types match D-04/D-06 and the vectors pin them.
- Internal representation of a chain value (array vs. head+links) provided the canonical hashing and genesis anchor are as in D-04/D-05.
- Whether `append` is the sole mutation path on `ReceiptStore` or a lower-level `save` is also exposed, provided the contract test proves append-only integrity.
- Module/file breakdown within `@stint/core` (`receipts/`, `license/`) and the `@stint/core/testing` subpath.
- The exact PASETO custom-claim key names and how `job`/`limits` sub-objects are shaped, provided they satisfy LIC-01 and the license vector.

### Deferred Ideas (OUT OF SCOPE)
- Per-call receipt emission from the live proxy with binding-redacted summaries (RCPT-01) — Phase 4.
- Holding the license in the credential vault, injecting it on outbound calls only, and the LIC-05 "never forwarded / never to agent" adversarial test — Phase 4.
- Entitlement revocation moving the lease to `revoked` (actor `publisher`) and triggering teardown (LIC-04), the final signed teardown receipt, and receipts surviving cleanup (RCPT-07) — Phase 5.
- JSON-file `ReceiptStore` with NTFS-atomic writes + cross-process locking, running the Phase 3 shared contract suite — Phase 6.
- CLI receipt-timeline printing and **external checkpoint export/pinning** so a wholesale store compromise is independently detectable — Phase 6.

None of the above were re-scoped into Phase 3; discussion stayed within the phase boundary.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| RCPT-02 | Receipts are hash-chained using a single canonical serializer with a golden-hash fixture test | Architecture Pattern 1 (hash-chain append/verify through `@stint/spec`'s `canonicalize`/`hashCanonical`); Common Pitfall 3 (cross-platform golden-hash vector drift); Validation Architecture Wave 0 gap for `chain-golden.test.ts` |
| RCPT-03 | Runtime signs chain checkpoints with Ed25519, including a final signed receipt at teardown | Architecture Pattern 2 (checkpoint signing mirroring `packages/spec/src/jws.ts`'s detached-EdDSA pattern exactly); Security Domain V6 Cryptography row |
| RCPT-04 | Publisher-signed attested entries live in a separate chain; each chain verifies independently | Architecture Pattern 1 + "Existing `TrustStore`/`Ed25519PublicJwk` shape to reuse" (Code Examples); Anti-Patterns ("Interleaving verified and attested entries") |
| RCPT-05 | User can view both chains merged into one plain-language timeline, clearly marking verified vs attested | Recommended Project Structure (`receipts/merge.ts`); Anti-Patterns; Validation Architecture `merge.test.ts` |
| RCPT-06 | Verifying a tampered or truncated chain (relative to its last checkpoint) reports the exact break | Architecture Pattern 1 (`verifyChain` returning `Result` with `{brokenAtSeq, reason}`); Common Pitfall 4 (stable reason-code vocabulary, independent of `SpecErrorCode`) |
| LIC-01 | Publisher can issue a PASETO v4.public license carrying lease id, job, expiry and limits, with a 5-minute default TTL | Architecture Pattern 3 (paseto factory-composition API, `issueLicense` example); Standard Stack (`paseto@4.0.1` verified API); Package Legitimacy Audit |
| LIC-02 | Publisher server verifies licenses offline with the publisher public key using one shared implicit-assertion derivation and an explicit clock-skew tolerance | Architecture Pattern 3 (Critical detail 2 & 3 — `clockTolerance` default-zero confirmed from source, shared `deriveImplicitAssertion`); Common Pitfall 2 |
| LIC-03 | Runtime refreshes licenses before TTL expiry, never beyond lease expiry; the agent never holds the license | Architecture Pattern 4 (`needsRefresh`/`clampedLicenseExpiry`); Common Pitfall 1 (epoch-seconds vs RFC 3339 boundary); Architectural Responsibility Map row on held-license custody |

</phase_requirements>

## Summary

Phase 3 is pure logic with zero I/O: two hash-chained receipt logs (verified, attested), Ed25519-signed checkpoints over each, and PASETO v4.public license issue/verify/refresh — all built on primitives Phase 1 and Phase 2 already shipped and proved. Nothing here needs a new hashing library, a new signing library, or a new async storage abstraction; it needs careful **composition** of `@stint/spec`'s existing `canonicalize`/`hashCanonical` (RFC 8785 JCS) for every receipt/checkpoint hash, `jose`'s existing EdDSA detached-signature pattern (already live in `packages/spec/src/jws.ts`) for checkpoint signing, and `paseto@4.0.1`'s new (three-week-old) factory-composition API for the license.

The single highest-risk item is `paseto@4.0.1`: this session inspected the shipped `v4/public.ts`/`.d.ts` and root `index.d.ts` directly (via `npm pack paseto@4.0.1`). The API is exactly as CLAUDE.md describes — `GenerateKeyPairFactory`/`SignFactory`/`VerifyFactory` composed into a `PublicProtocol` instance — but two details were not previously verified and matter a great deal for D-13/D-14: (1) `exp`/`iat`/`nbf` claims are **RFC 3339 date-time strings**, not epoch numbers, while every other convention in this codebase (`Lease.expiresAt`, `reduce(lease, event, now: number)`, `evaluatePolicy(..., now)`) uses **epoch seconds**; (2) `clockTolerance` defaults to **zero** exactly as PITFALLS.md predicted, and it is a `ConsumeOptions` field, not a global setting — every call site must set it explicitly. The `license/issue.ts`/`verify.ts` wrapper is therefore also the epoch-seconds ↔ RFC 3339 conversion boundary, and that boundary must be exercised by the boundary tests D-14 requires, not assumed away.

The second highest-risk item is the receipt/checkpoint entry format, since D-01 requires resolving `spec/ALP.md` §8 and §11 normatively this phase — matching exactly how Phase 2 resolved §7.5. This is spec authorship work as much as code, gated by `scripts/check-alp-sections.mjs`'s structural checks (heading order, no `[OPEN: Phase 3]` markers left, no em-dash) and by `spec/vectors/README.md`'s existing convention of dependency-free, reproducible-by-any-implementation vectors.

**Primary recommendation:** Build `receipts/chain.ts` (append/verify, pure, over `@stint/spec`'s canonicalizer), `receipts/checkpoint.ts` (jose EdDSA sign/verify, injectable keypair), `receipts/merge.ts` (display-only), and `license/issue.ts`/`license/verify.ts`/`license/refresh.ts` (paseto v4.public, one shared `deriveImplicitAssertion`, explicit clock-skew tolerance, epoch-seconds↔RFC3339 conversion isolated to the license boundary) as pure `@stint/core` modules with zero MCP/network/filesystem imports, mirroring the `errors.ts` → `lease.ts` → `testing.ts` structure Phase 2 already established for `LeaseStore`.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Hash-chain append/verify (verified + attested) | API/Backend logic (`@stint/core`, pure) | Database/Storage (`ReceiptStore` persists the chain value) | Pure decision logic lives in `core`, exactly like the Phase 2 policy engine; a store only persists opaque chain state, never computes hashes itself |
| Ed25519 checkpoint signing/verification | API/Backend logic (`@stint/core`, pure, `jose`) | — | Signing is a pure function of `(chain summary, keypair, now)` — no I/O; the keypair is injected, never read from disk inside `core` |
| Attested-chain publisher signature verification | API/Backend logic (`@stint/core`, reusing `@stint/spec`'s `TrustStore`/`verifyDetached`) | — | Same trust model as manifest envelope verification (Phase 1); no new crypto code, only reuse |
| Display-only merged timeline | API/Backend logic (`@stint/core`, pure read-side function) | CLI/Host rendering (Phase 6) | Merge itself is pure and lives in `core`; how it is printed is a Phase 6 concern |
| `ReceiptStore` persistence contract + in-memory double | Database/Storage (interface) | API/Backend (`@stint/core/testing`) | Mirrors `LeaseStore`: the interface and its contract-test factory are `core`'s enabling work; a real JSON-file/DB-backed implementation is Phase 6 |
| PASETO license issuance (mock publisher) | API/Backend logic (`@stint/core/testing` mock + `@stint/core/license/issue.ts` reference) | — | The publisher is logically a separate trust domain, but for v0.1 the reference issuer and the mock both live in `core` as pure/injectable code — no live publisher server exists yet (that's Phase 7's example) |
| PASETO license verification + refresh decision | API/Backend logic (`@stint/core`, pure `needsRefresh` + `verifyLicense`) | — | Runtime-side verification and the refresh decision are pure functions of `(license, now, skew)` — no timer, no I/O |
| Held-license custody (opaque branded type, never to agent) | API/Backend logic (type-level guarantee in `@stint/core`) | Proxy (Phase 4 wires the single accessor into outbound injection) | The branded type is defined and enforced in `core` this phase; the proxy that actually calls the accessor is Phase 4 — this phase only builds the compile-time guarantee |

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `paseto` (panva) | **4.0.1** (exact pin, per CLAUDE.md) | PASETO v4.public sign/verify for hosted licenses | `[VERIFIED: npm registry — npm view paseto version → 4.0.1 this session]` `[VERIFIED: package source read this session — v4/public.ts, v4/public.d.ts, root index.d.ts inspected directly via npm pack]`. Zero runtime dependencies (Web Crypto-backed); the classic `V4.sign/verify` static API from 3.x does not exist in this version — only the factory-composition shape below. |
| `jose` | 6.2.12 (already a `@stint/spec` dependency; must become a direct `@stint/core` dependency too) | Ed25519 (EdDSA) checkpoint signing/verification | `[VERIFIED: packages/spec/package.json:16]` — already resolved and in use in this repo for manifest-envelope signatures (`packages/spec/src/jws.ts`). Reuse the identical detached-EdDSA pattern for checkpoints; do not introduce a second JOSE dependency version. |
| `node:crypto` | built-in | SHA-256 hashing — but ONLY indirectly, via `@stint/spec`'s `canonicalize`/`hashCanonical` | `[VERIFIED: packages/spec/src/canonical.ts:20]` — `@stint/core` MUST NOT call `createHash` directly for receipts; D-05 requires routing every receipt/checkpoint hash through the one existing `@stint/spec` serializer. |
| `ajv` + `ajv-formats` + `json-schema-to-typescript` | 8.20.0 / 3.0.1 / 16.0.0 (already `@stint/spec` dependencies) | draft-07 schema + generated types for `receipt.schema.json`/`checkpoint.schema.json` | `[VERIFIED: packages/spec/package.json]` — reuse the identical Phase 1 codegen pipeline (`packages/spec/scripts/codegen.mjs`); no new validation library. |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `vitest` | 5.0.2 (already root/peer dependency) | Test runner for chain/checkpoint/license unit + boundary tests | Already the project standard; no phase-specific addition needed. |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `paseto` (panva) factory-composition API | Hand-rolled PASETO v4.public over raw Ed25519 (`node:crypto`) | Explicitly forbidden by PROJECT.md ("no hand-rolled crypto") and by CLAUDE.md's pinned-library list; would also have to reimplement PAE (pre-authentication encoding) correctly, a well-known PASETO footgun. |
| One shared linear hash chain per lease (verified + attested, independently chained) | A single Merkle tree (Certificate Transparency/Trillian style) across all leases | `.planning/research/ARCHITECTURE.md` already recommends the simpler linear chain for v0.1 scale (single-writer, single-lease, no cross-tenant inclusion proofs needed); revisit only if receipts are ever aggregated cross-lease into one public log. |
| `jose` EdDSA for checkpoints | `paseto` v4.public for checkpoints too (reuse the same library for both signing needs) | Checkpoints are not licenses — they don't need PASETO's claims/implicit-assertion machinery, just a plain detached signature over a small summary object. D-07 explicitly separates the two: checkpoint signing stays on `jose`, matching the existing envelope-signing precedent; licensing stays on `paseto`. Mixing them would blur the "two independently-chained trust models" design. |

**Installation** (add to `packages/core/package.json` `dependencies`; both already resolve in the workspace via `@stint/spec`'s existing deps, but `@stint/core` must declare them directly since it imports them directly, not merely transitively):
```bash
pnpm --filter @stint/core add paseto@4.0.1 jose@6.2.12
```

**Version verification performed this session:**
- `npm view paseto version` → `4.0.1` `[VERIFIED: npm registry, queried this session]`
- `paseto@4.0.1`'s `package.json` declares **no `engines` field at all** `[VERIFIED: package.json read directly from the pulled tarball this session]` — no Node-floor conflict with the project's 22.18+ target; the library is Web-Crypto-backed (Ed25519 via `SubtleCrypto`), which Node 22/24 supports natively.
- `jose@6.2.12` is already the exact version pinned and installed for `@stint/spec` `[VERIFIED: packages/spec/package.json:16]` — no version drift risk from adding it to `@stint/core` too, since pnpm dedupes identical versions across the workspace.

## Package Legitimacy Audit

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| `paseto` | npm | published 2026-09-04 (~3 weeks old at research time) | 48,056/week | `github.com/panva/paseto` | `SUS` (`too-new`) | **Flagged** — planner MUST add a `checkpoint:human-verify` task before this dependency is added, confirming the pinned version (`4.0.1` exact, not `^4.0.1`) and reviewing the factory-composition API shape against this document before first use. This verdict is expected and already anticipated by CLAUDE.md and the phase's own "Research flag: yes" note — it reflects genuine newness of the 4.x rewrite, not a legitimacy concern about the maintainer (panva is also the maintainer of `jose` and `oauth4webapi`, both already trusted dependencies of this project). |
| `jose` | npm | published 2026-09-05 (latest patch), package itself long-established | 152,241,970/week | `github.com/panva/jose` | `SUS` (`too-new`) | **Not flagged for gating** — the `too-new` signal here is an artifact of checking only the latest patch release's publish date; the package has ~152M weekly downloads and is already an approved, in-use dependency of `@stint/spec` since Phase 1 (envelope signing). No new checkpoint needed; this is a false-positive relative to the actual risk (a brand-new package), not a genuine newness concern. |

**Packages removed due to `[SLOP]` verdict:** none.
**Packages flagged as suspicious `[SUS]`:** `paseto` — planner must insert `checkpoint:human-verify` before the `pnpm add paseto@4.0.1` task, confirming the exact pin and reviewing this document's "PASETO API" code examples against the actual installed package (`node_modules/paseto/v4/public.d.ts`) before wiring `license/issue.ts`/`verify.ts`.

## Architecture Patterns

### System Architecture Diagram

```
                         @stint/core (pure, no I/O)
 ┌───────────────────────────────────────────────────────────────────────┐
 │                                                                       │
 │  TransitionRecord ──┐                                                │
 │  (from Phase 2       │                                                │
 │   reduce())          ▼                                                │
 │              ┌───────────────┐        ┌──────────────────┐           │
 │  Tool call ─▶│ appendEntry() │───────▶│ verified chain    │           │
 │  outcome     │ (canonicalize │        │ (hash-linked,     │           │
 │  / teardown  │  + hashCanon- │        │  ReceiptEntry[])  │           │
 │  step        │  ical from    │        └─────────┬─────────┘           │
 │              │  @stint/spec) │                  │                     │
 │              └───────────────┘                  │ signCheckpoint()    │
 │                                                  │ (jose EdDSA,        │
 │  Publisher-signed  ┌───────────────┐             │  injected keypair)  │
 │  attested claim ──▶│ appendEntry() │──▶ attested  ▼                     │
 │  (verified via      │ (separate     │   chain   Checkpoint            │
 │  @stint/spec's       │  chain, own   │  (own     { chain, count,       │
 │  TrustStore/kid)      │  prevHash)    │  checkpt) headHash, ts, sig }  │
 │                      └───────────────┘                                │
 │                              │                                        │
 │                              ▼                                        │
 │                    mergeTimeline(verified, attested)                  │
 │                    (display-only; never touches hash links/sigs)      │
 │                              │                                        │
 │                              ▼                                        │
 │                    TimelineEntry[] { ..., chain: "verified"|"attested" }│
 │                                                                       │
 │  ─────────────────────────────────────────────────────────────────── │
 │                                                                       │
 │  Mock publisher (testing.ts) ──issueLicense()──▶ PASETO v4.public token│
 │     (LicenseIssuer port)         (paseto SignFactory,                 │
 │                                    deriveImplicitAssertion(leaseId,    │
 │                                    specVersion), 300s TTL default)     │
 │                                          │                             │
 │                                          ▼                             │
 │  needsRefresh(license, now, skew) ──▶ true/false (pure, per-call)      │
 │                                          │ if true                     │
 │                                          ▼                             │
 │                              issuer.reissue(..., exp: min(now+ttl,     │
 │                                            lease.expiresAt))           │
 │                                          │                             │
 │                                          ▼                             │
 │                    HeldLicense (opaque branded type)                  │
 │                    — one narrow accessor, wired by Phase 4 proxy —    │
 │                    never returned to agent/receipt/log path           │
 └───────────────────────────────────────────────────────────────────────┘
                    ▲                                    ▲
                    │ implements                          │ implements
         ┌──────────┴──────────┐                ┌────────┴─────────┐
         │ In-memory            │                │ (Phase 6:         │
         │ ReceiptStore double  │                │  JSON-file        │
         │ (@stint/core/testing)│                │  ReceiptStore)    │
         └───────────────────────┘                └───────────────────┘
```

### Recommended Project Structure

Matches `.planning/research/ARCHITECTURE.md`'s already-planned layout — this phase fills in the two directories that were placeholders:

```
packages/core/src/
├── receipts/
│   ├── chain.ts          # appendEntry, verifyChain — pure, canonicalize-based
│   ├── checkpoint.ts     # signCheckpoint, verifyCheckpoint — jose EdDSA, injectable keypair
│   ├── merge.ts          # mergeTimeline — display-only, read-side
│   └── receipt-store.ts  # ReceiptStore interface (mirrors lease-store.ts's shape)
├── license/
│   ├── issue.ts          # issueLicense — paseto SignFactory wrapper, reference issuer
│   ├── verify.ts         # verifyLicense — paseto VerifyFactory wrapper
│   ├── refresh.ts        # needsRefresh — pure decision; refresh clamp logic
│   ├── implicit-assertion.ts  # deriveImplicitAssertion(leaseId, specVersion) — ONE shared fn
│   └── license-issuer.ts # LicenseIssuer port (issue/reissue) — injected, never signs in core proper
└── testing.ts             # extended: createInMemoryReceiptStore, createReceiptStoreContractTests,
                            # createMockLicenseIssuer (implements LicenseIssuer with a test keypair)

spec/
├── receipt.schema.json    # NEW — draft-07, alongside manifest.schema.json / envelope.schema.json
└── checkpoint.schema.json # NEW — draft-07

spec/vectors/
├── receipts/              # NEW — golden-hash fixture: entries → canonical bytes → head hash → checkpoint signing input
└── license/                # NEW — claims → token + public key + implicit-assertion input, valid + invalid cases
```

### Pattern 1: Hash-chain append/verify through the single canonical serializer

**What:** Every `ReceiptEntry`'s `prevHash` is computed as `hashCanonical({ prevHash, type, payload, ...})` (exact field set is an ALP.md §11 normative decision this phase makes) using `@stint/spec`'s existing `canonicalize`/`hashCanonical` — never a second serializer, never raw `JSON.stringify`. The entry hash is **recomputed on demand during verify**, never stored (D-04) — `verifyChain` walks the chain from `GENESIS_HASH`, recomputing each entry's expected `prevHash` from the previous entry's stored `prevHash` plus the current entry's canonical bytes, and compares.

**When to use:** Every receipt append and every checkpoint, both chains.

**Example (illustrative shape only — exact field names are Claude's Discretion per CONTEXT.md):**
```typescript
// packages/core/src/receipts/chain.ts
import { canonicalize, hashCanonicalText } from "@stint/spec"; // reuse, never reimplement

export const GENESIS_HASH = "jcs-sha256:" + "0".repeat(64); // fixed constant (D-04)

export function appendEntry(
  chain: readonly ReceiptEntry[],
  input: ReceiptEntryInput,
  now: number,
): ReceiptEntry {
  const prevHash = chain.at(-1)?.prevHash ?? GENESIS_HASH;
  const withoutHash = { seq: chain.length, ts: now, chain: input.chain, type: input.type, payload: input.payload, prevHash };
  const canonicalText = canonicalize(withoutHash);
  // the NEXT entry's prevHash covers THIS entry's full canonical bytes —
  // exact linkage direction is an ALP.md §11 normative decision (D-04).
  return { ...withoutHash, /* linkage field pinned by the golden vector */ };
}

export function verifyChain(chain: readonly ReceiptEntry[]): Result<{ headHash: string }> {
  let expectedPrev = GENESIS_HASH;
  for (const entry of chain) {
    if (entry.prevHash !== expectedPrev) {
      return { ok: false, errors: [{ code: "hash_mismatch", brokenAtSeq: entry.seq, path: "" , message: "..." }] };
    }
    expectedPrev = hashCanonicalText(canonicalize({ ...entry })); // recompute, never trust a stored hash
  }
  return { ok: true, value: { headHash: expectedPrev } };
}
```

### Pattern 2: Ed25519 checkpoint signing, mirroring `packages/spec/src/jws.ts` exactly

**What:** `signCheckpoint(chain, privateKey, now)` builds `{ chain: "verified"|"attested", count, headHash, ts }`, canonicalizes it with the SAME `@stint/spec` serializer, and signs the canonical bytes with `jose`'s detached EdDSA pattern — the identical `FlattenedSign(...).setProtectedHeader({ alg: "EdDSA" })` shape already proven in `packages/spec/src/jws.ts:29-34`. Verification mirrors `flattenedVerify` at `jws.ts:44-52`, never forwarding jose's exception text (same T-01-15 discipline).

**Why reuse the exact pattern:** `packages/spec/src/jws.ts` already solved "one shared protected-header constant, never recomputed per call site" for manifest signatures (RESEARCH Pitfall 5 in that file's own comment). Checkpoints have the identical shape of problem — reinventing it in `@stint/core` risks the exact two-different-header-construction-paths bug the spec package's own docstring warns about.

**Example:**
```typescript
// packages/core/src/receipts/checkpoint.ts
import { FlattenedSign, flattenedVerify, base64url } from "jose";
import type { CryptoKey } from "jose";
import { canonicalize } from "@stint/spec";

const CHECKPOINT_HEADER = { alg: "EdDSA" } as const;
const CHECKPOINT_HEADER_B64 = base64url.encode(JSON.stringify(CHECKPOINT_HEADER));

export interface Checkpoint {
  readonly chain: "verified" | "attested";
  readonly count: number;
  readonly headHash: string;
  readonly ts: number;
  readonly sig: string;
}

export async function signCheckpoint(
  chainKind: "verified" | "attested",
  count: number,
  headHash: string,
  now: number,
  privateKey: CryptoKey, // injected — never hard-wired (D-07)
): Promise<Checkpoint> {
  const summary = { chain: chainKind, count, headHash, ts: now };
  const bytes = new TextEncoder().encode(canonicalize(summary));
  const jws = await new FlattenedSign(bytes).setProtectedHeader(CHECKPOINT_HEADER).sign(privateKey);
  return { ...summary, sig: jws.signature };
}
```

### Pattern 3: PASETO v4.public factory composition for licensing

**What:** `paseto@4.0.1`'s API is composed, not a static class — `PublicProtocol` combines `GenerateKeyPairFactory`, `SignFactory`, `VerifyFactory` from `paseto/v4/public` into one instance exposing `.GenerateKeyPair()`, `.Sign(key, claims, options)`, `.Verify(key, token, options)`. This is confirmed directly from the shipped source this session (`v4/public.ts`, `v4/public.d.ts`, root `index.d.ts`), not inferred.

**Critical detail 1 — claims are RFC 3339 strings, not epoch numbers:** `Claims.exp`/`.iat`/`.nbf` are typed as RFC 3339 date-time strings `[VERIFIED: paseto index.d.ts:65-86, read this session]`. Every other place in this codebase (`Lease.expiresAt`, `reduce(lease, event, now: number)`) uses epoch seconds `[VERIFIED: packages/core/src/lease.ts:36-38, packages/core/src/activate.ts:33-51]`. `license/issue.ts` and `license/verify.ts` are therefore the **conversion boundary**: convert `now: number` (epoch seconds) to `new Date(now * 1000)` for paseto's `now`/`ProduceOptions`/`ConsumeOptions`, and convert the clamped `exp` epoch-seconds value to an RFC 3339 string (`new Date(exp * 1000).toISOString()`) set directly as the `exp` claim — do **not** rely on paseto's own `expiresIn` option (which computes `exp` from paseto's own internal `now`, not the injected clock), since that would silently reintroduce a real-wall-clock read exactly where D-12/D-14's injectable-clock discipline forbids it.

**Critical detail 2 — `clockTolerance` defaults to zero and is per-call, not global:** `ConsumeOptions.clockTolerance?: number` `[VERIFIED: paseto index.d.ts:159, read this session]` — "Permitted temporal skew in seconds. Defaults to zero." Every `verifyLicense` call MUST pass this explicitly (PITFALLS.md Pitfall 4/10 predicted exactly this default-zero footgun; this session's source read confirms the prediction as fact, not speculation).

**Critical detail 3 — implicit assertion is a raw `Uint8Array`, not a claim:** `ProduceOptions.implicitAssertion?: Uint8Array` / `ConsumeOptions.implicitAssertion?: Uint8Array`, v3/v4 only `[VERIFIED: paseto index.d.ts:135-141, 174-180]`. It authenticates data that is never stored in the token — `deriveImplicitAssertion(leaseId, specVersion)` must be the ONE function both `issue.ts` and `verify.ts` import, returning identical bytes for identical inputs (e.g. `new TextEncoder().encode(canonicalize({ lease_id: leaseId, spec_version: specVersion }))`, reusing `@stint/spec`'s canonicalizer again rather than a bespoke string-concat, so the derivation itself is provably deterministic across Node versions).

**Critical detail 4 — errors are typed and stable:** `PasetoError` subclasses carry a stable `code` field: `InvalidTokenError` (`ERR_PASETO_INVALID_TOKEN` — malformed/failed authentication, i.e. bad signature), `ClaimValidationError` (`ERR_PASETO_CLAIM_VALIDATION`, carries a `.claim` field — e.g. expired `exp`, wrong `implicitAssertion` mismatch manifests as a claim/auth failure), `InvalidKeyError` (`ERR_PASETO_INVALID_KEY`) `[VERIFIED: paseto index.d.ts:1311-1394, read this session]`. `verify.ts` should catch these and map them to `@stint/core`'s own stable `CoreErrorCode` vocabulary (per the existing `errors.ts` pattern) rather than forwarding paseto's own exception text, per PITFALLS.md Pitfall 8 and ALP.md §14's "sanitized, non-interpolated message" rule — do not pass the underlying library's `.message` through unmodified.

**Example (issue side):**
```typescript
// packages/core/src/license/issue.ts
import { PublicProtocol } from "paseto";
import { GenerateKeyPairFactory, SignFactory } from "paseto/v4/public";
import type { SecretKey } from "paseto/v4/public";
import { deriveImplicitAssertion } from "./implicit-assertion.js";

const v4 = new PublicProtocol(SignFactory); // tree-shaken: only Sign needed at issue time

export interface LicenseClaims {
  readonly lease_id: string;
  readonly job: Readonly<Record<string, unknown>>;
  readonly limits: Readonly<Record<string, unknown>>;
}

export async function issueLicense(
  secretKey: SecretKey,
  claims: LicenseClaims,
  kid: string,
  specVersion: string,
  now: number,        // epoch seconds — the ONE injected clock value
  expEpochSeconds: number, // already clamped by the caller: min(now + defaultTtl, lease.expiresAt)
): Promise<string> {
  return v4.Sign(
    secretKey,
    { ...claims, jti: crypto.randomUUID(), exp: new Date(expEpochSeconds * 1000).toISOString() },
    {
      now: new Date(now * 1000),
      addIssuedAt: true,
      footer: new TextEncoder().encode(JSON.stringify({ kid })), // kid in footer — public, non-secret (D-13, Pitfall 4)
      implicitAssertion: deriveImplicitAssertion(claims.lease_id, specVersion),
    },
  );
}
```

**Example (verify side, with explicit skew):**
```typescript
// packages/core/src/license/verify.ts
import { PublicProtocol } from "paseto";
import { VerifyFactory } from "paseto/v4/public";
import type { PublicKey } from "paseto/v4/public";
import { ClaimValidationError, InvalidTokenError } from "paseto";
import { deriveImplicitAssertion } from "./implicit-assertion.js";

const v4 = new PublicProtocol(VerifyFactory);

export const LICENSE_CLOCK_SKEW_SECONDS = 5; // explicit, tested, single-digit — never the library default of zero (D-14)

export async function verifyLicense(
  publicKey: PublicKey,
  token: string,
  leaseId: string,
  specVersion: string,
  now: number,
): Promise<Result<{ claims: LicenseClaims; kid: string }>> {
  try {
    const { claims, footer } = await v4.Verify(publicKey, token, {
      now: new Date(now * 1000),
      clockTolerance: LICENSE_CLOCK_SKEW_SECONDS, // explicit — Pitfall 4/10
      implicitAssertion: deriveImplicitAssertion(leaseId, specVersion),
    });
    const { kid } = JSON.parse(new TextDecoder().decode(footer)) as { kid: string };
    return { ok: true, value: { claims: claims as unknown as LicenseClaims, kid } };
  } catch (error) {
    // Never forward paseto's own exception text (PITFALLS.md Pitfall 8, ALP.md §14).
    if (error instanceof ClaimValidationError) return reject("license_claim_invalid", error.claim);
    if (error instanceof InvalidTokenError) return reject("license_invalid_signature");
    return reject("license_verification_failed");
  }
}
```

### Pattern 4: Pure refresh decision with clamped expiry (LIC-03)

**What:** `needsRefresh(license, now, skew)` is a pure boolean decision — no I/O, no timer, re-evaluated per call exactly like `evaluatePolicy` (D-12, mirrors Phase 2's per-call expiry discipline). Refresh itself calls the injected `LicenseIssuer` port; the caller (not `needsRefresh`) computes `exp = Math.min(now + defaultTtlSeconds, lease.expiresAt)` and refuses refresh once `now >= lease.expiresAt`.

**Example:**
```typescript
// packages/core/src/license/refresh.ts
export function needsRefresh(exp: number, now: number, refreshBeforeSeconds: number): boolean {
  return now >= exp - refreshBeforeSeconds;
}

export function clampedLicenseExpiry(now: number, defaultTtlSeconds: number, leaseExpiresAt: number): number | null {
  if (now >= leaseExpiresAt) return null; // refresh refused: lease is already over (LIC-03)
  return Math.min(now + defaultTtlSeconds, leaseExpiresAt);
}
```

### Anti-Patterns to Avoid

- **Computing `exp` via paseto's `expiresIn` option instead of an explicit RFC 3339 string derived from the injected clock:** `expiresIn` measures from paseto's own `now` default (real wall clock) unless `now` is also passed — even when `now` IS passed, `expiresIn` still computes `exp` as `now + expiresIn`, which does not by itself enforce the `min(now + ttl, lease.expiresAt)` clamp LIC-03 requires. Always compute the clamped epoch value yourself and set `exp` as a literal claim.
- **Deriving the implicit assertion differently in `issue.ts` vs `verify.ts`:** even a different key order or an extra whitespace character in a hand-built string changes the assertion bytes and breaks verification silently (PITFALLS.md Pitfall 4). One function, imported by both.
- **Interleaving verified and attested entries into one chain "for simplicity":** explicitly an anti-pattern already documented in ARCHITECTURE.md (Anti-Pattern 4) — a weak attested claim must never borrow a verified checkpoint's cryptographic strength.
- **Storing the computed hash on the `ReceiptEntry` itself:** D-04 requires recomputing on verify, not trusting a stored value — storing it invites a broken/stale hash to look valid if the recompute step is ever skipped.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| RFC 8785 canonical JSON serialization for receipt/checkpoint hashing | A second canonicalizer, or ad hoc key-sorted `JSON.stringify` | `@stint/spec`'s existing `canonicalize`/`hashCanonical`/`hashCanonicalText` | Already proven byte-identical cross-platform for the manifest golden-hash vector; a second implementation risks silent divergence exactly per PITFALLS.md Pitfall 7 |
| Ed25519 signing/verification | Raw `node:crypto` Ed25519 calls, or a second JOSE-shaped wrapper | `jose`'s `FlattenedSign`/`flattenedVerify`, mirroring `packages/spec/src/jws.ts` exactly | The "one shared protected-header constant" lesson from Phase 1 applies identically here; PROJECT.md forbids hand-rolled crypto outright |
| PASETO v4.public token construction (PAE, footer encoding, versioned header) | Hand-built PASETO-shaped strings over raw Ed25519 | `paseto@4.0.1`'s `SignFactory`/`VerifyFactory` via `PublicProtocol` | PAE (pre-authentication encoding) is a well-documented PASETO footgun to get byte-exact; the pinned library already implements it correctly and is the CLAUDE.md-mandated dependency |
| Tamper detection with exact break-point reporting | A single boolean "chain valid: true/false" | `verifyChain` returning `Result` with `{ brokenAtSeq, reason }` per D-09, walking the chain and stopping at the first mismatch | RCPT-06 explicitly requires the exact point of break, anchored to the last valid checkpoint — a boolean loses this information entirely |
| `ReceiptStore` contract-test coverage | A bespoke, one-off test file per implementation (in-memory now, JSON-file in Phase 6) | The shared `createReceiptStoreContractTests(makeStore)` factory pattern, exactly mirroring `packages/core/src/testing.ts`'s `createLeaseStoreContractTests` | Guarantees the Phase 6 JSON-file store cannot silently drift from the in-memory double's guarantees — same reasoning D-14 already established for `LeaseStore` |

**Key insight:** every non-trivial primitive this phase needs (canonical serialization, Ed25519 signing, contract-test factories) was already built correctly in Phase 1/2 for a structurally identical problem (manifest hashing/signing, `LeaseStore` persistence). The work here is disciplined reuse and composition, not new cryptographic engineering — the risk surface is almost entirely in the PASETO epoch/RFC-3339 boundary and the implicit-assertion/clock-skew wiring, both of which are now verified from source rather than assumed.

## Common Pitfalls

### Pitfall 1: Epoch-seconds vs RFC 3339 mismatch at the license boundary silently breaking `needsRefresh`/`clampedLicenseExpiry`

**What goes wrong:** `Lease.expiresAt` and every `now` parameter elsewhere in `@stint/core` are epoch seconds (`number`); paseto's own `Claims.exp`/`.iat`/`.nbf` are RFC 3339 strings and its `ProduceOptions.now`/`ConsumeOptions.now` are `Date` objects. If `needsRefresh`/`clampedLicenseExpiry` are ever fed a paseto-shaped value (a `Date`, or a decoded RFC 3339 string) instead of converting at the boundary, comparisons silently misbehave (string comparison of dates does not sort numerically the way `Date.parse` does for all locales/formats, and mixing a `Date` with an epoch-seconds number produces `NaN` comparisons that fail closed in some paths and open in others depending on comparison direction).

**Why it happens:** This is a genuinely new integration in this phase — Phase 1/2 never had to reconcile two different time representations, since `@stint/spec`'s envelope verification has no temporal claims at all.

**How to avoid:** Isolate ALL epoch↔RFC-3339/Date conversion inside `license/issue.ts` and `license/verify.ts`; `needsRefresh`/`clampedLicenseExpiry` must accept and return only epoch-seconds numbers, never touching paseto's `Claims`/`Date` types directly. Add a unit test asserting `clampedLicenseExpiry` and `issueLicense`'s resulting token's decoded `exp` (verified via `verifyLicense`) agree to the second.

**Warning signs:** Any function outside `license/issue.ts`/`verify.ts` importing a type from `paseto`; any comparison of a `Date` object against a `number`.

**Phase to address:** this phase (core license module boundary).

---

### Pitfall 2: Forgetting `clockTolerance` is per-call, not a library-wide default

**What goes wrong:** `ConsumeOptions.clockTolerance` defaults to `0` and must be passed on every single `v4.Verify(...)` call `[VERIFIED: paseto index.d.ts:159]` — there is no way to configure it once for a shared `PublicProtocol` instance. If `verifyLicense` is refactored later (e.g. a second call site added for a CLI inspect command) and the new call site forgets the option, that call site silently gets zero-tolerance verification while the original stays tolerant, causing intermittent, hard-to-reproduce boundary failures.

**How to avoid:** Never call `v4.Verify` directly from more than one place; route every verification through the single `verifyLicense` wrapper, which hard-codes `LICENSE_CLOCK_SKEW_SECONDS` as a named exported constant (not a magic number re-typed at each call site).

**Phase to address:** this phase.

---

### Pitfall 3: Golden-hash vector drift between platforms (Windows/Linux)

**What goes wrong:** Per D-02/success criterion 1, the golden receipt-chain vector must hash identically on Windows and Linux. `canonicalize`'s own module docstring (`packages/spec/src/canonical.ts:10-17`) already documents that the underlying `canonicalize@5.1.0` library silently drops `undefined` values and coerces `Date` via `toJSON()` — since `@stint/spec`'s wrapper pre-walks and rejects these, receipts must construct their canonicalization input using ONLY the strict JSON data model (no `Date` objects passed directly — always convert to an epoch-seconds `number` or ISO string explicitly before calling `canonicalize`), or `CanonicalizationError` will throw where a naive implementation might have silently succeeded with divergent results.

**How to avoid:** The golden-hash fixture test (D-02) must be written before other receipt code, exactly as Phase 1's `spec/vectors/jcs/manifest-expected-hash.txt` was computed independently via `sha256sum`, never solely by round-tripping through Stint's own code (`spec/vectors/README.md`'s own convention: "The golden hash was computed independently of Stint's own code").

**Phase to address:** this phase (receipt chain golden vector, `spec/vectors/receipts/`).

---

### Pitfall 4: `verifyChain`'s reason codes conflated with `@stint/spec`'s `SpecErrorCode` or `@stint/core`'s existing `CoreErrorCode`

**What goes wrong:** D-09 requires `verifyChain` to return stable codes (`hash_mismatch | reordered | truncated | checkpoint_sig_invalid`). `packages/core/src/errors.ts`'s own docstring states the `CoreErrorCode` vocabulary "is deliberately independent of `@stint/spec`'s `SpecErrorCode` — the core reducer and policy engine never import spec's error codes." The same discipline must extend to receipts: do not import or alias any `SpecErrorCode` value for a receipt-verification failure, even where the underlying cause (e.g. `CanonicalizationError`) originates in `@stint/spec`.

**How to avoid:** Add the new reason codes as their own array, following the exact `CORE_ERROR_CODES`/`POLICY_REASON_CODES` pattern (`as const` array → derived union type), whether as an extension of `CORE_ERROR_CODES` or a sibling `RECEIPT_VERIFY_REASONS` array — this is Claude's Discretion per CONTEXT.md, but the parallel-vocabulary discipline itself is not discretionary.

**Phase to address:** this phase.

---

### Pitfall 5: `spec/ALP.md` §8/§11 edits missing the structural checker's requirements

**What goes wrong:** `scripts/check-alp-sections.mjs` enforces a fixed heading outline, no em-dash, well-formed `[OPEN: Phase N]` markers, and specific phrase/structure checks (states list, actors list, Mermaid diagram shape, transition-table safety properties) — per its own header comment, it "never validates prose quality." Editing §8/§11 to remove the `[OPEN: Phase 3]` markers without running `pnpm run check:alp` (root `package.json` script) risks a structurally broken spec doc that still reads plausibly to a human reviewer.

**How to avoid:** Run `node scripts/check-alp-sections.mjs` (or `pnpm run check:alp`) after every ALP.md edit in this phase, exactly as Phase 2 must have done for its own §7.5 resolution.

**Phase to address:** this phase.

---

### Pitfall 6: Secrets/tokens leaking through the license verification error path

**What goes wrong:** `paseto`'s own error classes (`ClaimValidationError`, `InvalidTokenError`) may include the offending token or claim value in their `.message` in some failure modes (not verified in this session — the `.d.ts` only declares `.claim?: string` and a `message` constructor parameter, not what the library itself puts into it at each throw site). Passing `error.message` through to a receipt or log unmodified would risk reproducing PITFALLS.md Pitfall 8 in a brand-new place.

**How to avoid:** `verify.ts`'s catch block (Pattern 3 above) already maps every paseto error class to one of `verify.ts`'s own fixed, non-interpolated messages (`"license_claim_invalid"`, `"license_invalid_signature"`, `"license_verification_failed"`) — never `error.message` itself. This mirrors `@stint/spec`'s own `verifyEnvelope` discipline exactly (`packages/spec/src/envelope.ts:176-187`, "never forward jose's exception text").

**Phase to address:** this phase (D-16 — carried into every receipt path).

## Runtime State Inventory

Not applicable — Phase 3 is a greenfield addition of new pure modules (`receipts/`, `license/`) to `@stint/core`; it is not a rename, refactor, or migration of existing code or data. **None found** — verified by reading the phase's `CONTEXT.md` boundary section (no rename/refactor language) and confirming via `packages/core/src` listing that no existing `receipts.ts`/`license.ts` file exists to migrate away from.

## Code Examples

See Architecture Patterns 1-4 above for the primary code shapes (`appendEntry`/`verifyChain`, `signCheckpoint`, `issueLicense`/`verifyLicense`, `needsRefresh`/`clampedLicenseExpiry`) — all sourced from this session's direct reads of `packages/spec/src/canonical.ts`, `packages/spec/src/jws.ts`, `packages/spec/src/envelope.ts`, `packages/core/src/lease.ts`, `packages/core/src/activate.ts`, and the `paseto@4.0.1` package inspected via `npm pack`.

### Existing `TransitionRecord` shape a `transition`-type verified receipt is built from

```typescript
// packages/core/src/lease.ts:43-49 — VERIFIED, read this session
export interface TransitionRecord {
  readonly from: State;
  readonly event: Event;
  readonly actor: Actor;
  readonly to: State;
  readonly at: number;
}
```
A `transition`-type `ReceiptEntry`'s `payload` (D-04's discriminated union) should carry this exact shape (or a structural superset), since it is already the canonical record every `reduce()` call produces (`packages/core/src/lease.ts:143-149`).

### Existing `TrustStore`/`Ed25519PublicJwk` shape to reuse for attested-chain publisher verification

```typescript
// packages/spec/src/envelope.ts:23-30 — VERIFIED, read this session
export interface Ed25519PublicJwk {
  readonly kty: "OKP";
  readonly crv: "Ed25519";
  readonly x: string;
}
export type TrustStore = Readonly<Record<string, Readonly<Record<string, Ed25519PublicJwk>>>>;
```
The attested chain's publisher-signature verification (D-07) should import these types directly from `@stint/spec` and reuse `verifyDetached` from `packages/spec/src/jws.ts` — do not redefine an equivalent shape in `@stint/core`.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| `paseto@3.x`'s static `V4.sign()`/`V4.verify()`/`V4.generateKey('public')` namespace API | `paseto@4.0.1`'s factory-composition API (`GenerateKeyPairFactory`/`SignFactory`/`VerifyFactory` composed via `PublicProtocol`) | 2026-09-04 (v4.0.0 publish) | Any training-data or web-search-derived example using `V4.sign`/`V4.verify` is stale and will not run against the pinned version; this document's Pattern 3 examples are the only verified-current shape |
| `paseto@3.1.4` (last published April 2023) | `paseto@4.0.1` | README's "Supported Versions" table states only v4.x receives security fixes going forward | 3.1.4 is unsupported upstream — this project's CLAUDE.md pin to 4.0.1 is already the correct, current choice; no further action needed beyond what's already decided |

**Deprecated/outdated:** `paseto@3.x`'s entire API surface — do not consult any `paseto` documentation, blog post, or Stack Overflow answer dated before September 2026 without independently re-verifying it applies to the 4.x factory-composition shape.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Exact field names/ordering for `ReceiptEntry` (`{seq, ts, chain, type, prevHash, payload}` per D-04) and `Checkpoint` (`{chain, count, headHash, ts, sig}`) as shown in the code examples above are illustrative, not the final normative §11 shape — CONTEXT.md leaves exact field naming as Claude's Discretion. | Architecture Patterns 1-2, Code Examples | Low — CONTEXT.md explicitly delegates this; the planner should treat the shown shapes as a strong starting point, not a locked contract, and the golden vector (D-02) is what actually pins the final bytes. |
| A2 | `paseto`'s error classes (`ClaimValidationError`, `InvalidTokenError`) do not embed the raw token or secret material in their `.message` string by default. | Common Pitfalls #6 | Medium — if wrong, a test asserting "no secret substring appears in any sanitized error" could still pass today but a future paseto patch release could change what's embedded; the mitigation (never forward `.message` unmodified) already defends against this regardless, so the practical risk is low, but this specific claim about the library's current behavior was not verified by reading every throw site in `_internal/`, only the public `.d.ts` surface. |
| A3 | `paseto@4.0.1` has zero runtime dependencies and is Web-Crypto-backed for Ed25519 operations, making it compatible with Node 22.18+/24 without polyfills. | Standard Stack | Low — the package's `package.json` was read directly this session and declares no `dependencies` field beyond dev/peer tooling; Node 22/24's native `SubtleCrypto` Ed25519 support is well-established and already relied on by `jose`/`oauth4webapi` per CLAUDE.md. |

**If this table is empty:** N/A — see entries above.

## Open Questions

1. **Exact linkage direction for `prevHash` (does entry N's `prevHash` field store the hash of entry N-1, or does entry N-1 store a forward-pointing hash of entry N)?**
   - What we know: D-04 says "the entry hash is computed on demand, not stored; `prevHash` is the only stored link, and the genesis `prevHash` is a fixed constant." ARCHITECTURE.md's Pattern 6 example computes `entry.prevHash = sha256(prevHash + canonicalize({type, payload}))` — i.e., each entry's own `prevHash` field actually stores the hash covering *this* entry's own content chained onto the *previous* entry's stored value (a slightly unusual naming — it reads as "this entry's link forward," not "a pointer to the previous entry's hash"). This is internally consistent but easy to misread.
   - What's unclear: whether the planner should follow ARCHITECTURE.md's naming exactly (entry.prevHash = rolling hash including this entry) or rename for clarity (e.g., separate `entryHash`/`chainedHash` fields) while preserving the same recompute-on-verify property.
   - Recommendation: Whatever field name is chosen, write the golden-hash vector test FIRST, exactly matching the field's documented semantics, then implement `appendEntry`/`verifyChain` against that fixed vector — this makes the ambiguity self-resolving and testable rather than a design debate.

2. **Does `receipt.schema.json`/`checkpoint.schema.json` need a runtime Ajv validator (like `validateManifest`), or is TypeScript's compile-time discriminated-union checking sufficient for these phase-3 types?**
   - What we know: `receipt.schema.json`/`checkpoint.schema.json` exist per D-03 primarily to generate types via the Phase 1 codegen pipeline (`json-schema-to-typescript`) and to give the license/receipt conformance vectors (D-02) a schema-backed shape. Manifests need Ajv validation because they are untrusted, externally-supplied JSON from a publisher; receipts are internally constructed by `@stint/core`'s own pure functions, never parsed from untrusted external input at this phase (Phase 6's JSON-file `ReceiptStore` reading persisted receipts back from disk is the first point untrusted-shape JSON re-enters, and that's out of this phase's scope).
   - What's unclear: whether Phase 3 should add an Ajv validator now (defensive, matches the `validateManifest`/`validateEnvelopeShape` precedent) or defer it to Phase 6 when the JSON-file store first needs to validate what it reads back.
   - Recommendation: Defer full Ajv validation to Phase 6 (when persisted receipts are first read back from untrusted-shape disk JSON); Phase 3 only needs the generated TypeScript types for compile-time safety within `@stint/core`'s own pure functions, plus the golden-vector test as the actual conformance gate. Note this explicitly in the plan so Phase 6 doesn't silently skip it.

3. **Where does `deriveImplicitAssertion`'s `spec_version` input come from at the call site — `SPEC_VERSION` (the constant `@stint/spec` exports, currently `"alp/0.1"`) or the specific manifest's own `spec_version` field?**
   - What we know: `@stint/spec` exports a top-level `SPEC_VERSION = "alp/0.1"` constant (`packages/spec/src/index.ts:1`); every `Manifest` also carries its own `spec_version: "alp/0.1"` literal field (currently the only supported value, per `SUPPORTED_SPEC_VERSIONS`).
   - What's unclear: since only one spec version is currently supported, these two values are identical today — but D-13 doesn't specify which one is normatively the input, and a future multi-version world would need this pinned unambiguously in ALP.md §8's implicit-assertion definition.
   - Recommendation: Use the manifest's own `manifest.spec_version` (not the runtime's `SPEC_VERSION` constant) as the implicit-assertion input, and state this explicitly in the ALP.md §8 resolution this phase writes — it is the more future-proof choice (a license verified against a manifest's own declared version, not the verifying runtime's current build), and costs nothing today since the two values are identical.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | Runtime for all of `@stint/core`, Web Crypto Ed25519 for `paseto`/`jose` | ✓ (assumed per project floor; not re-probed this session — Phase 1 CI already gates this) | 22.18+ target | — |
| `paseto` npm package | License issue/verify | not yet installed in `@stint/core` — must be added this phase | 4.0.1 (exact pin) | none — this is the phase's own deliverable dependency; no fallback library is acceptable per CLAUDE.md's explicit pin |
| `jose` npm package | Checkpoint signing | ✓ already installed for `@stint/spec`; needs adding as a direct `@stint/core` dependency | 6.2.12 | — |

**Missing dependencies with no fallback:** none — `paseto` is simply not yet added to `@stint/core`'s `package.json`, which is expected first-phase-of-use state, not a blocker; the planner's first task should add it (gated by the `checkpoint:human-verify` from the Package Legitimacy Audit above).

**Missing dependencies with fallback:** none.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest 5.0.2 `[VERIFIED: package.json:20, root]` |
| Config file | `vitest.config.ts` (root) — `test.projects: ["packages/*"]`; each package additionally runs its own `"test": "vitest run"` script `[VERIFIED: vitest.config.ts, packages/core/package.json:20]` |
| Quick run command | `pnpm --filter @stint/core test` |
| Full suite command | `pnpm test` (root — runs `pnpm build && vitest run` across all workspace packages) |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| RCPT-02 | Hash-chained receipts through the canonical serializer; golden-hash fixture pins exact bytes/hash cross-platform | unit | `pnpm --filter @stint/core exec vitest run receipts/chain-golden.test.ts` | ❌ Wave 0 |
| RCPT-03 | Ed25519-signed checkpoints; tampered/reordered/truncated chain reports exact break relative to last checkpoint | unit | `pnpm --filter @stint/core exec vitest run receipts/checkpoint.test.ts receipts/verify-chain.test.ts` | ❌ Wave 0 |
| RCPT-04 | Attested chain verifies independently of verified chain | unit | `pnpm --filter @stint/core exec vitest run receipts/attested-chain.test.ts` | ❌ Wave 0 |
| RCPT-05 | Display-only merged timeline marks verified/attested; never touches hash linkage | unit | `pnpm --filter @stint/core exec vitest run receipts/merge.test.ts` | ❌ Wave 0 |
| RCPT-06 | `verifyChain` reports exact break locus (`{brokenAtSeq, reason}`) for tamper/reorder/truncation | unit | `pnpm --filter @stint/core exec vitest run receipts/verify-chain.test.ts` | ❌ Wave 0 |
| LIC-01 | Mock publisher issues PASETO v4.public license (lease id, job, expiry, limits, 300s default TTL) | unit | `pnpm --filter @stint/core exec vitest run license/issue.test.ts` | ❌ Wave 0 |
| LIC-02 | Offline verify with shared implicit-assertion derivation + explicit clock-skew tolerance; wrong lease/outside skew rejected | unit + boundary | `pnpm --filter @stint/core exec vitest run license/verify.test.ts` | ❌ Wave 0 |
| LIC-03 | Refresh before TTL expiry under injectable clock; never outlives lease expiry; license held, never exposed | unit + boundary | `pnpm --filter @stint/core exec vitest run license/refresh.test.ts` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `pnpm --filter @stint/core test` (package-scoped quick run)
- **Per wave merge:** `pnpm test` (root, full workspace build + test)
- **Phase gate:** Full suite green before `/gsd-verify-work`, plus `pnpm run check:alp` for the ALP.md §8/§11 edits

### Wave 0 Gaps
- [ ] `packages/core/test/receipts/chain-golden.test.ts` — golden-hash fixture (RCPT-02), paired with `spec/vectors/receipts/` fixture files
- [ ] `packages/core/test/receipts/verify-chain.test.ts` — tamper/reorder/truncation break-locus tests (RCPT-03, RCPT-06)
- [ ] `packages/core/test/receipts/attested-chain.test.ts` — independent attested-chain verification (RCPT-04)
- [ ] `packages/core/test/receipts/merge.test.ts` — display-only merge, ordering-has-no-integrity-meaning assertion (RCPT-05)
- [ ] `packages/core/test/license/issue.test.ts`, `license/verify.test.ts`, `license/refresh.test.ts` — LIC-01/02/03, including the 1s-before/1s-after clock-skew boundary tests D-14 requires
- [ ] `spec/vectors/receipts/` and `spec/vectors/license/` fixture directories (D-02) — no framework install needed, only new fixture files plus a `spec/vectors/README.md` section update describing them (mirroring the existing `jcs/`/`envelope/` sections)
- [ ] `packages/spec/src/generated/receipt.ts` / `checkpoint.ts` — generated by extending `packages/spec/scripts/codegen.mjs`'s `targets` array with the two new schema files (D-03)

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | This phase issues/verifies a license token, not a user authentication credential; the license authenticates entitlement, not a human identity |
| V3 Session Management | no | No session concept in this phase; lease lifecycle/expiry is Phase 2's concern, already built |
| V4 Access Control | no | Enforcement (proxy PDP/PEP) is Phase 4; this phase produces audit trail + license data, not access decisions |
| V5 Input Validation | yes | Discriminated-union `ReceiptEntry.payload` typed at compile time; PASETO claims validated by `paseto`'s own `VerifyFactory` (`requiredClaims`, `clockTolerance`, `implicitAssertion`) rather than hand-rolled parsing |
| V6 Cryptography (Stored Cryptography) | yes | `jose` (EdDSA/Ed25519, already-approved dependency) for checkpoints; `paseto@4.0.1` (v4.public, Ed25519-backed) for licenses — never hand-rolled per PROJECT.md; keys are injected, never generated/hard-wired inside `@stint/core` itself |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Hash-chain truncation/rollback (an attacker with store write-access replays a shorter, internally-consistent prefix) | Tampering | Ed25519-signed checkpoints anchored at every lease-ending event (D-06); `verifyChain` reports the exact break locus relative to the last valid checkpoint (D-09) — full external checkpoint export/pinning is deferred to Phase 6 per PITFALLS.md Pitfall 7, but this phase's checkpoint signing is the prerequisite |
| PASETO implicit-assertion/footer misuse (footguns already catalogued in PITFALLS.md Pitfall 4, now confirmed from source) | Tampering / Information Disclosure | One shared `deriveImplicitAssertion` function (D-13); footer holds only `kid` (public, non-secret) — never anything sensitive, since PASETO footers are authenticated but NOT encrypted even in `local` mode, and this project uses `public` mode where the whole payload is signed-not-encrypted anyway |
| Secrets/license leaking through a sanitization gap in the license verification error path | Information Disclosure | `verify.ts` maps every `PasetoError` subclass to a fixed, non-interpolated internal message (Pattern 3, Common Pitfall 6) — never forwards `error.message` |
| Attested chain forging a stronger trust claim by riding on the verified chain's checkpoint | Spoofing / Elevation of Privilege | Two independently-chained, independently-checkpointed logs (D-07); merge is display-only and never touches either chain's signatures (D-10) |
| Clock-skew abuse (offline-verifiable license accepted far outside its real validity window due to an unbounded/absent tolerance) | Tampering | Explicit, tested, single-digit-second `clockTolerance` (D-14) — confirmed the library default is exactly zero, so omitting this is a real, not theoretical, vulnerability |

## Sources

### Primary (HIGH confidence — read directly from source this session)
- `paseto@4.0.1` package tarball, pulled via `npm pack paseto@4.0.1` and extracted this session: `v4/public.ts`, `v4/public.d.ts`, `index.d.ts` (full), `package.json`, `README.md` — factory-composition API shape, `ProduceOptions`/`ConsumeOptions`/`Claims` field types, error class hierarchy, quick-start usage pattern
- `packages/spec/src/canonical.ts` (full) — the one canonical serializer every receipt/checkpoint hash must reuse
- `packages/spec/src/envelope.ts` (full) — `TrustStore`/`Ed25519PublicJwk`/`verifyEnvelope` trust model to reuse for attested-chain verification
- `packages/spec/src/jws.ts` (full) — the exact detached-EdDSA sign/verify pattern to mirror for checkpoint signing
- `packages/spec/src/testing.ts`, `packages/spec/src/validate.ts` — established Result/error-mapping/testing conventions
- `packages/core/src/lease.ts`, `activate.ts`, `errors.ts`, `lease-store.ts`, `testing.ts`, `policy.ts`, `bindings.ts`, `index.ts` (full or substantial excerpts) — established `@stint/core` conventions (epoch-seconds clock, `Result`-not-throw, discriminated unions, contract-test factory pattern) this phase must follow
- `spec/ALP.md` (full) — normative sections 4-15, especially the two `[OPEN: Phase 3]` markers (§8, §11) this phase resolves, and §5/§7.5/§13/§14/§15
- `scripts/check-alp-sections.mjs`, `packages/spec/scripts/codegen.mjs`, `spec/vectors/README.md` — structural gates and codegen pipeline this phase's spec edits and new schemas must satisfy
- `.planning/phases/03-receipts-licensing/03-CONTEXT.md`, `.planning/REQUIREMENTS.md`, `.planning/STATE.md` — phase scope, locked decisions, requirement text
- `gsd_run query package-legitimacy check --ecosystem npm paseto jose` (this session) — legitimacy signals for both packages
- `npm view paseto version` (this session) — registry version confirmation

### Secondary (MEDIUM confidence)
- `.planning/research/PITFALLS.md`, `.planning/research/ARCHITECTURE.md` — project-level pre-existing research (WebSearch-sourced, cross-checked against official RFC/spec text per that document's own confidence note); used here as design-pattern precedent, not re-verified independently this session beyond what this session's direct source reads confirmed or refined

### Tertiary (LOW confidence)
- None used for load-bearing claims in this document; the one training-knowledge-only claim (Assumption A2, about `paseto`'s internal error-message content beyond the public `.d.ts` surface) is flagged in the Assumptions Log rather than stated as fact.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — `paseto@4.0.1`'s exact API was read from its own shipped source this session, not inferred
- Architecture: HIGH — directly extends the already-built-and-tested Phase 1/2 patterns (`canonicalize`, `jws.ts`, `LeaseStore`/`testing.ts` contract-factory shape), all read this session
- Pitfalls: HIGH — the two previously-flagged PASETO footguns (implicit assertion, clock skew) are now confirmed as literal facts about the pinned version's type surface, not predictions

**Research date:** 2026-09-27
**Valid until:** 30 days for the stable pieces (canonical serializer, jose EdDSA — both long-stable APIs); reverify `paseto`'s API surface before use if more than ~2 weeks pass without starting this phase, since it is a 3-week-old rewrite and any patch release (4.0.2, etc.) should be diffed against this document's Pattern 3 before assuming it still applies unchanged.
