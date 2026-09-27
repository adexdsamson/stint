# Phase 3: Receipts & Licensing - Context

**Gathered:** 2026-09-27
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 3 delivers the pure, fully-tested **audit-trail and licensing core** in `@stint/core`, plus the normative spec fill-ins those formats require. It is still front-loaded, dependency-free decision logic — no live proxy, no OAuth, no teardown I/O.

It delivers:

1. **Dual receipt chains** — an independent **verified** chain (facts the runtime observed) and **attested** chain (publisher-signed claims), each hash-linked through the *existing* `@stint/spec` canonical serializer, never interleaved, plus a **display-only merged timeline** marking each entry `verified` / `attested` (RCPT-02, RCPT-04, RCPT-05).
2. **Ed25519 signed checkpoints** over each chain, and chain **verification that reports the exact break point** (tamper / reorder / truncation) relative to the last valid checkpoint (RCPT-03, RCPT-06).
3. A **golden-hash fixture** pinning exact canonical bytes + head hash, identical on Windows and Linux (RCPT-02).
4. **PASETO v4.public licensing** — reference **issue** + offline **verify**, one shared implicit-assertion derivation, explicit tested clock-skew tolerance, 300s default TTL (LIC-01, LIC-02).
5. **Bounded license refresh** — a pure "should refresh now?" decision under an injectable clock, with issued expiry clamped so no refreshed token outlives the lease, and the license held so it can never reach the agent (LIC-03; LIC-05 tested in Phase 4).
6. **Normative spec resolution** — fills the two `[OPEN: Phase 3]` markers in `spec/ALP.md` (§8 hosted-license claims + implicit assertion; §11 receipt/checkpoint entry format) and adds conformance vectors, exactly as Phase 2 resolved §7.5's `[OPEN: Phase 2]`.
7. **Enabling work:** a **`ReceiptStore`** contract with an in-memory double + reusable contract-test factory in `@stint/core/testing` (Phase 4 proxy and Phase 5 teardown append receipts; Phase 6 ships the JSON-file impl against the same suite).

**Not in this phase:** the live MCP proxy that emits per-call receipts and injects the license on outbound calls (RCPT-01, LIC-05 test — Phase 4); OAuth grant handling; entitlement revocation → `revoked` and teardown (LIC-04, RCPT-07 — Phase 5); the JSON-file `ReceiptStore`/`LeaseStore` with Windows atomicity (Phase 6); CLI receipt-timeline printing and external checkpoint export (Phase 6); the `resource_query` predicate grammar (Phase 5).

Requirements: RCPT-02, RCPT-03, RCPT-04, RCPT-05, RCPT-06, LIC-01, LIC-02, LIC-03.

</domain>

<decisions>
## Implementation Decisions

### Spec resolution (both `[OPEN: Phase 3]` markers)
- **D-01:** Phase 3 resolves **both** spec markers **normatively in `spec/ALP.md`**: §8 gets the hosted-license claim set + implicit-assertion derivation; §11 gets the receipt and checkpoint entry format. ALP.md stays the single normative source; `@stint/core` conforms to it (matches Phase 2 filling §7.5). — **Reversibility:** one-way — these become published protocol text; changing a locked format later changes the ALP.md contract and any external implementer's code.
- **D-02:** Add **two conformance vector sets** under `spec/vectors/`, consumed by Stint's own tests (no private vector set): a **receipt-chain golden vector** (fixed entries → pinned canonical bytes + head hash + checkpoint signing input) and a **license vector** (claims → token + public key + implicit-assertion input, with valid and invalid cases). Guards cross-platform/cross-version hash drift (PITFALL 7) and makes both formats independently reproducible. — **Reversibility:** costly — vectors are a published conformance surface; regenerating them signals a format change.

### Receipt & checkpoint format
- **D-03:** The receipt and checkpoint schemas are **draft-07 JSON Schema in `@stint/spec`** (e.g. `receipt.schema.json`, `checkpoint.schema.json`), with TypeScript types **generated** via `json-schema-to-typescript` under `codegen:check` — the identical manifest/envelope pipeline from Phase 1. `@stint/core` imports the generated types; it never hand-writes them. — **Reversibility:** costly — the schema is the normative type source Phase 4/5/6 import; shape changes ripple through generated types and every writer/reader.
- **D-04:** A `ReceiptEntry` is `{ seq, ts, chain, type, prevHash, payload }` where `payload` is a **discriminated union keyed by `type`** (e.g. `call` | `transition` | `teardown_step` | `attested_claim`). The **entry hash is computed on demand, not stored** (recomputed during verify from the canonical bytes); `prevHash` is the only stored link, and the genesis `prevHash` is a fixed constant. Keeps entries small, tamper-checkable, and forces verification to recompute rather than trust a stored hash. — **Reversibility:** one-way — this is the normative §11 entry shape and the golden-vector input.
- **D-05:** Every receipt/checkpoint hash goes through the **existing `@stint/spec` canonical serializer** (`canonicalize` / `hashCanonical`, `jcs-sha256:` prefix, RFC 8785, `MAX_CANONICAL_DEPTH`). No new serializer and no ad-hoc `JSON.stringify` anywhere in the receipt path (PITFALL 7). Phase 3 must not re-implement hashing.
- **D-06:** The runtime signs an **Ed25519 checkpoint at every lease-ending event** (the spec §11 floor) **plus an on-demand** pure `signCheckpoint(chain, key, now)` the caller may invoke (e.g. future CLI export, or a per-N policy). Checkpoint content is at least `{ chain, count, headHash, ts }` signed. Frequency policy stays with the caller; core imposes no timer. — **Reversibility:** costly — the signed checkpoint content is part of the §11 format and the vector.
- **D-07:** **Attested-chain publisher signatures reuse the `@stint/spec` trust model** — the same `TrustStore` / `Ed25519PublicJwk` / `kid` pattern as envelope verification — so attested entries verify independently against publisher public keys. The runtime's **own checkpoint signing uses `jose`** (per CLAUDE.md) in `@stint/core`, with the checkpoint **keypair passed in (injectable)**, never hard-wired. The two chains keep fully independent integrity (separate hash links + separate checkpoint signatures); a weak attested claim can never borrow a verified checkpoint's strength.

### Receipt persistence (enabling work)
- **D-08:** Phase 3 ships **pure `append` / `verify` / `merge` functions** over in-memory chain values, **plus a `ReceiptStore` interface** (append / load / checkpoint read-write) with an **in-memory double + reusable contract-test factory** exported from `@stint/core/testing` — mirroring the Phase 2 `LeaseStore` pattern (D-13/D-14). Phase 6's JSON-file store runs the identical suite. The receipt log stays **related but distinct** from `LeaseStore` (ARCHITECTURE): append-only audit vs current-state snapshot — it is NOT folded into `LeaseStore`. — **Reversibility:** costly — `ReceiptStore` is the contract Phase 4/5/6 implement/consume.
- **D-09:** `verifyChain(...)` returns a **`Result`** whose failure carries a **precise break locus** `{ brokenAtSeq, reason }` where `reason` is a **stable code** (`hash_mismatch` | `reordered` | `truncated` | `checkpoint_sig_invalid`), anchored to the last valid checkpoint (RCPT-06). Follows the Result-not-throw + stable-code convention (Phase 2 D-03/D-10) so host/CLI can render the exact break. — **Reversibility:** costly — the reason-code set is a public surface CLI/host consume; add freely, renaming breaks consumers.
- **D-10:** The **merge is display-only** (RCPT-05): a read-side function that produces a timeline marking each entry `verified` / `attested`; it never touches either chain's hash linkage or signatures, and its ordering carries **no integrity meaning** (spec §11).

### Licensing (issue / verify / refresh)
- **D-11:** `@stint/core` ships a **real reference `license/issue.ts` (sign)** and **`license/verify.ts` (offline verify)**. The runtime depends on an **injectable `LicenseIssuer` port** (issue / reissue) and **never signs** — the **mock publisher in `@stint/core/testing`** implements the port with a test keypair, and Phase 7's mock publisher reuses it. Refresh calls the port. — **Reversibility:** costly — `LicenseIssuer` is the seam Phase 7's example and Phase 4/5 depend on.
- **D-12:** **Refresh = pure decision + clamped TTL.** A pure `needsRefresh(license, now, skew)` decides *when* (before TTL, evaluated per call, no timer). On refresh, the issued expiry is **clamped: `exp = min(now + defaultTTL, lease.expires_at)`**; at or after `lease.expires_at` refresh is refused, so no refreshed token can outlive the lease (LIC-03). There is **no cached "still valid" boolean** reused across calls (PITFALL 9). — **Reversibility:** costly — this invariant is the LIC-03 guarantee and is directly tested at the boundary.
- **D-13:** **License claims:** use PASETO **registered claims** `exp` / `iat` / `nbf` / `jti`; carry **`lease_id`, `job`, and `limits` as custom claims**; put **`kid` in the footer** (footer is authenticated but public/non-secret — nothing sensitive there, PITFALL 4). The **implicit assertion** is a canonical derivation over **`lease_id` + `spec_version`**, computed by **one shared function used by both issue and verify** (never hand-recomputed in two places). The **300s default TTL is runtime configuration, never in the manifest** (spec §8). — **Reversibility:** one-way — claim mapping + implicit-assertion input are the normative §8 fill-in and the license-vector input; a mismatch silently fails every verification.
- **D-14:** **Explicit, tested clock-skew tolerance** wherever `exp`/`nbf` is checked — never the library default of zero — deliberately small relative to the 5-minute TTL (single-digit seconds) so it doesn't widen the revocation-latency bound (PITFALL 9, spec §14). Boundary tests: 1s before expiry passes, 1s past (beyond skew) fails.
- **D-15:** The held license is an **opaque branded type**; the raw token string is reachable only through a **single narrowly-typed accessor** used by the outbound-injection path (wired in Phase 4). No agent-facing, receipt-facing, or customer-resource-facing function accepts or returns it — LIC-05 / secretless is enforced **by construction**, not by review (PITFALL 3/8). — **Reversibility:** costly — the branded type + single accessor is the compile-time guarantee Phase 4 relies on.

### Secret safety (carried into every receipt path)
- **D-16:** Receipt-writer input types carry **only `argsHash` + `redactedSummary`** (and typed non-secret fields) — never raw args, tokens, or the license — so leaking a secret into a receipt is a **compile error** (PITFALL 8). Any error caught from a PASETO/crypto library call is **sanitized to a fixed, non-interpolated message** before it can reach a receipt or log path.

### Claude's Discretion
- Exact TypeScript names for types/functions (`ReceiptEntry`, `Checkpoint`, `Chain`, `ReceiptStore`, `appendEntry`, `verifyChain`, `mergeTimeline`, `signCheckpoint`, `License`, `LicenseIssuer`, `issueLicense`, `verifyLicense`, `needsRefresh`, `deriveImplicitAssertion`, etc.) as long as they encode the decisions above.
- Exact stable reason-code strings in `verifyChain` failures beyond the examples in D-09.
- Exact JSON Schema field names/ordering in `receipt.schema.json` / `checkpoint.schema.json`, provided the generated types match D-04/D-06 and the vectors pin them.
- Internal representation of a chain value (array vs. head+links) provided the canonical hashing and genesis anchor are as in D-04/D-05.
- Whether `append` is the sole mutation path on `ReceiptStore` or a lower-level `save` is also exposed, provided the contract test proves append-only integrity.
- Module/file breakdown within `@stint/core` (`receipts/`, `license/`) and the `@stint/core/testing` subpath.
- The exact PASETO custom-claim key names and how `job`/`limits` sub-objects are shaped, provided they satisfy LIC-01 and the license vector.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Protocol (normative — code MUST match; this phase also EDITS §8 and §11)
- `spec/ALP.md` §8 — auth modes; **`[OPEN: Phase 3]` to resolve**: hosted-license claims, `license_issuer`/`kid`, 300s TTL not in manifest, implicit-assertion derivation
- `spec/ALP.md` §11 — Receipts: dual verified/attested chains, independent integrity, Ed25519 checkpoints at lease-ending events + final teardown receipt, args-hash/redacted-summary only, exact-break reporting, display-only merge; **`[OPEN: Phase 3]` to resolve**: receipt + checkpoint entry format
- `spec/ALP.md` §5 — canonical serialization (RFC 8785 JCS) that every receipt/checkpoint hash MUST use
- `spec/ALP.md` §7.5 — license refresh distinct from extension; refresh never moves `expires_at`; no refreshed license carries expiry later than the lease's
- `spec/ALP.md` §13 — trust limits: attested proves integrity not completeness; offline licenses can't be revoked instantly (TTL-bounded latency)
- `spec/ALP.md` §14 — security: secrets never in errors/logs/receipts; token passthrough forbidden; explicit tested clock-skew, re-evaluate per call
- `spec/ALP.md` §15 — Conformance (Runtime + Publisher classes); vectors live in `spec/vectors/`
- `spec/vectors/README.md` — vector layout to extend with receipt + license vector sets

### Project scope & requirements
- `.planning/PROJECT.md` — no secrets in logs/receipts; no credentials to the agent; license never forwarded; no hand-rolled crypto
- `.planning/REQUIREMENTS.md` — RCPT-02..06, LIC-01..03 acceptance text (and RCPT-01/07, LIC-04/05 for downstream-phase awareness)
- `.planning/ROADMAP.md` §Phase 3 — success criteria + research flag (paseto@4.0.1 factory-composition API, implicit-assertion + clock-skew)
- `.planning/phases/02-lease-state-machine-policy-engine/02-CONTEXT.md` — `TransitionRecord` (D-02) receipts consume; `LeaseStore`/`@stint/core/testing` contract-test pattern (D-13/D-14) to mirror for `ReceiptStore`; Result + stable-code convention (D-03/D-10)
- `.planning/phases/01-foundation-alp-spec/01-CONTEXT.md` — hash format + `jcs-sha256:` (D-01/D-02), bind content hash only (D-08), Result API + `/testing` subpath (D-30), stable codes (D-31), schema→generated-types pipeline

### Stack & pitfalls
- `.claude/CLAUDE.md` — pinned versions: `paseto@4.0.1` (exact pin, factory-composition API, panva), `jose@6.2.12` (EdDSA checkpoints), `ajv`/`json-schema-to-typescript@16.0.0` (draft-07 only), `node:crypto` for hashing; TS 5.9.3 strict, ESM-only, Node 22.18+
- `.planning/research/PITFALLS.md` — Pitfall 4 (PASETO implicit assertion / footer), Pitfall 7 (non-canonical serialization / unanchored heads), Pitfall 8 (secrets in errors/receipts), Pitfall 9 (clock-skew across offline verifiers)
- `.planning/research/ARCHITECTURE.md` — receipt log design (CT/Trillian scaled to linear chain), verified-vs-attested chains, license issue/verify layout (`core/src/license/`, `core/src/receipts/`), "related but distinct" LeaseStore vs receipt log

### @stint/spec integration surface (already built in Phase 1)
- `packages/spec/src/index.ts` — `canonicalize`, `hashCanonical`, `hashCanonicalText`, `CONTENT_HASH_PREFIX`, `MAX_CANONICAL_DEPTH`, `isContentHash`, `ContentHash`; `verifyEnvelope`, `TrustStore`, `Ed25519PublicJwk`, `VerifiedManifest`; `SPEC_ERROR_CODES`, `Result`
- `packages/spec/src/canonical.ts` — the serializer to reuse for all receipt/checkpoint hashing (do not re-implement)
- `packages/spec/src/envelope.ts` — the `TrustStore`/`Ed25519PublicJwk`/`kid` trust pattern to reuse for attested-publisher verification
- Phase 1 codegen pipeline (`manifest.schema.json` → generated types + `codegen:check`) — the model for `receipt.schema.json` / `checkpoint.schema.json`

### External standards
- RFC 8785 (JCS) — only via `@stint/spec`; RFC 8032/8037 (EdDSA/JOSE) for `jose` checkpoints; PASETO v4.public (panva `paseto@4.0.1`)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `@stint/spec` canonical serializer (`canonicalize`, `hashCanonical`, `jcs-sha256:` prefix) — the single hash function for verified chain, attested chain, and checkpoints (D-05).
- `@stint/spec` envelope trust model (`TrustStore`, `Ed25519PublicJwk`, `kid`) — reused to verify attested-chain publisher signatures independently (D-07).
- `@stint/spec/testing` + Phase 2 `@stint/core/testing` `LeaseStore` double + contract-test factory — the exact pattern to mirror for the new `ReceiptStore` double + suite (D-08).
- Phase 2 `TransitionRecord` (`{ from, event, actor, to, at }`) — the source object a `transition`-type verified receipt is built from (D-04).
- Phase 1 schema→generated-types codegen (`codegen:check`) — reused for `receipt.schema.json` / `checkpoint.schema.json` (D-03).

### Established Patterns
- ESM-only, TS strict, project references (`composite: true`), `workspace:*` linking.
- Result-not-throw for public functions; stable machine-readable code enums for anything host UIs consume (Phase 2 D-03/D-10 → D-09 here).
- Injectable clock, no timers, deterministic tests (Phase 2 D-07 → D-12/D-14 here).
- Schema is canonical; TS types are generated, never hand-written (Phase 1).
- `@stint/core` already sits at `spec → core → proxy/cli`; this phase adds `receipts/` and `license/` modules.

### Integration Points
- `@stint/core` imports `@stint/spec` (serializer + envelope trust store); no new hashing.
- `@stint/core` exports the `ReceiptStore` contract → implemented by Phase 6 JSON-file store, consumed by Phase 4 proxy (RCPT-01 per-call receipts) and Phase 5 teardown (RCPT-07 final signed receipt).
- The pure `appendEntry` / `verifyChain` / `signCheckpoint` / `mergeTimeline` are what the Phase 4 proxy calls per `tools/call` and Phase 5 teardown calls per step.
- The `LicenseIssuer` port + `issueLicense`/`verifyLicense`/`needsRefresh` are what Phase 4 (hold + inject + never-forward) and Phase 7 (mock publisher) build on.

</code_context>

<specifics>
## Specific Ideas

- Both spec `[OPEN: Phase 3]` markers (§8, §11) get resolved *normatively in ALP.md* this phase, matching how Phase 2 filled §7.5 — the spec must not stay incomplete once code depends on the format.
- A golden receipt-chain vector pins exact canonical bytes + head hash so any future serialization drift is caught immediately, not discovered in an audit dispute (PITFALL 7).
- The implicit-assertion derivation is pinned in ONE shared function used by both issue and verify — the single most common PASETO footgun (PITFALL 4).
- The license is unforgeable-to-leak by type: an opaque branded handle with one narrow accessor, so "hand the license to the agent" is a compile error (PITFALL 3/8).
- Refresh is a pure per-call decision with a clamped expiry, never a background loop — same no-timers discipline as per-call expiry.

</specifics>

<deferred>
## Deferred Ideas

- Per-call receipt emission from the live proxy with binding-redacted summaries (RCPT-01) — Phase 4.
- Holding the license in the credential vault, injecting it on outbound calls only, and the LIC-05 "never forwarded / never to agent" adversarial test — Phase 4.
- Entitlement revocation moving the lease to `revoked` (actor `publisher`) and triggering teardown (LIC-04), the final signed teardown receipt, and receipts surviving cleanup (RCPT-07) — Phase 5.
- JSON-file `ReceiptStore` with NTFS-atomic writes + cross-process locking, running the Phase 3 shared contract suite — Phase 6.
- CLI receipt-timeline printing and **external checkpoint export/pinning** so a wholesale store compromise is independently detectable (PITFALL 7 anchoring) — Phase 6.

None of the above were re-scoped into Phase 3; discussion stayed within the phase boundary.

</deferred>

---

*Phase: 03-receipts-licensing*
*Context gathered: 2026-09-27*
