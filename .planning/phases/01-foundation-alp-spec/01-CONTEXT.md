# Phase 1: Foundation & ALP Spec - Context

**Gathered:** 2026-09-27
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 1 delivers three things:

1. A green, cross-platform pnpm monorepo (`@stint/spec`, `@stint/core`, `@stint/proxy`, `@stint/cli`) with CI on Linux and Windows, licensed Apache-2.0.
2. The normative protocol document `spec/ALP.md` plus its canonical manifest schema `spec/manifest.schema.json` and conformance test vectors.
3. `@stint/spec`: generated TypeScript types, an Ajv validator with structured errors, the single RFC 8785 canonical serializer and hash, and publisher signature verification of signed manifest envelopes.

Requirements: FND-01, FND-02, FND-03, SPEC-01..SPEC-06. Lease state machine logic, receipts, licenses, proxy, teardown and CLI behavior belong to later phases; this phase only specifies them in ALP.md and stubs their packages.

</domain>

<decisions>
## Implementation Decisions

### Manifest signing & hashing
- **D-01:** Canonicalization is RFC 8785 JCS, implemented with a small audited library (e.g. `canonicalize`) wrapped in exactly one Stint function. This same serializer MUST be reused by Phase 3 receipt chains (no second implementation, no raw `JSON.stringify` for hashing). Reversibility: one-way. Changing it later invalidates every bound manifest hash and every receipt chain already written.
- **D-02:** Hash is SHA-256 (`node:crypto`) over the JCS bytes, represented as a self-describing prefixed string (e.g. `sha256:<hex>`; planner may choose `jcs-sha256:` if it reads better, but it must name the scheme). Reversibility: one-way. The string format is part of the published spec and stored in leases.
- **D-03:** Publisher signature is a detached JWS, EdDSA/Ed25519, via `jose`, computed over the JCS bytes of the `manifest` object. Same library as Phase 3 checkpoint signatures.
- **D-04:** Signed manifests are distributed as an envelope: `{ "manifest": { ... }, "signature": { "alg", "kid", "sig" } }`. Hash and signature cover `manifest` only; no field-exclusion rules. Reversibility: costly. Envelope shape is a publisher-facing contract.
- **D-05:** Key trust comes from a runtime trust store (host/runtime config) mapping publisher id to one or more public keys by `kid`. The manifest/envelope names the `kid`; it never carries the key. No key discovery or fetching in v0.1.
- **D-06:** Multiple keys per publisher, selected by `kid`, to support rotation (add new, then remove old). No key revocation lists in v0.1.
- **D-07:** Unsigned manifests are never accepted. There is no `allowUnsigned` flag. Tests and dev use a helper (exported from a `/testing` subpath) that generates a throwaway keypair and signs.
- **D-08:** The lease binds the hash of the manifest content only, not the envelope, so re-signing identical content (e.g. after key rotation) keeps the same bound hash. Signature is verified separately, before consent.

### Manifest shape
- **D-09:** `spec_version` is the literal string `"alp/0.1"`. The runtime accepts only versions it explicitly supports and rejects anything else. No version negotiation in v0.1.
- **D-10:** Scopes are a list of `{ resource, access[] }`, e.g. `[{ "resource": "paystack.transactions", "access": ["read"] }]`. Resource ids are opaque strings resolved by runtime-owned connector bindings. The manifest never names tools. `access` items are only `read | write | send | pay`.
- **D-11:** All durations and windows are integer seconds (e.g. `max_duration_seconds`, `window_seconds`, `timeout_seconds`). No ISO 8601 durations.
- **D-12:** Schema is strict: `additionalProperties: false` everywhere, except keys prefixed `x-`, which are allowed for publisher metadata and MUST be ignored for any enforcement.
- **D-13:** `limits` uses flat named fields: `actions_per_hour` (sliding 3600 s window), `max_actions`, `spend`, `error_threshold: { count, window_seconds }`. All limits are per lease.
- **D-14:** `spend` is `{ amount_minor: <integer>, currency: <ISO 4217> }`. No floats. One currency per lease in v0.1.
- **D-15:** Required: `lease.max_duration_seconds` and `limits.max_actions`. Optional: `actions_per_hour`, `spend`, `error_threshold`. `spend` becomes required when any scope includes `pay` (schema conditional plus a test).
- **D-16:** `approvals` is `{ require_for: [...], timeout_seconds }` with `require_for` items only `send | pay | irreversible`. The spec states that the runtime may add approval requirements but never remove them, and `pay` always requires approval even if omitted. Timeout denies.
- **D-17:** `auth` is `{ mode, delegated?, hosted? }`. `mode` is `delegated | hosted | hybrid`, default `hybrid`. `delegated` is a list of `{ provider, resources[] }` linking grants to scope resources; OAuth endpoints and client config are runtime connector config, never publisher-supplied. `hosted` is `{ license_issuer: <publisher id>, kid? }`; license TTL is not in the manifest. Mode-conditional requirements via `if/then`: `delegated` required for `delegated`/`hybrid`, `hosted` required for `hosted`/`hybrid`.
- **D-18:** `job.verifier` is a tagged union: `{ type: "resource_query", resource, predicate }` | `{ type: "user_confirm", prompt }` | `{ type: "none" }`, using `oneOf` with a `const` discriminator. Because `json-schema-to-typescript` treats `oneOf` as `anyOf`, Ajv is the real gate and a test MUST assert Ajv rejects invalid combinations. The predicate language is a simple declarative placeholder here, refined in Phase 5.
- **D-19:** `cleanup` is either `null` (no hook) or `{ hook: { url }, publisher_retains: <enum, e.g. "none" | "aggregates" | ...> }`. The retention claim is shown at consent and is attested, not verified. Cleanup-token mechanics stay in Phase 5.

### ALP.md style & structure
- **D-20:** Normative style uses RFC 2119/8174 keywords (MUST/SHOULD/MAY in caps) with a conventions section, numbered sections, and short non-normative rationale notes.
- **D-21:** `spec/manifest.schema.json` (draft-07) is canonical. ALP.md links to it and walks through every field in prose with an annotated example; the schema is not duplicated inline.
- **D-22:** Every protocol section is written normatively now (states, transitions, actors, auth modes, teardown order, receipts, trust model, trust limits). Wire-level details not yet designed (receipt entry format, license claims, predicate language, cleanup token) get explicit `[OPEN: Phase N]` markers that later phases replace.
- **D-23:** Diagrams use Mermaid: a `stateDiagram-v2` for the 11 states plus sequence diagrams for consent, a tool call through the proxy, and teardown.
- **D-24:** ALP.md contains the normative (state, event, actor) to next-state transition table. Phase 2's reducer table must match it (a cross-check test can come later).
- **D-25:** ALP.md has a conformance section with classes (Runtime, Publisher) and ships `spec/vectors/`: valid and invalid manifests, a JCS input with its expected hash, and a signed envelope. Stint's own tests consume the same vectors.

### Repo layout & codegen
- **D-26:** Scaffold all four packages now (`packages/spec`, `packages/core`, `packages/proxy`, `packages/cli`) with TS project references, build, and one smoke test each. Only `@stint/spec` gets real implementation.
- **D-27:** Generated types from `json2ts` are committed (e.g. `packages/spec/src/generated/manifest.ts`). A `pnpm codegen:check` script regenerates and fails on diff, run in CI, which satisfies "changing the schema without regenerating fails the build".
- **D-28:** The canonical serializer and hashing live in a `canonical` module exported from `@stint/spec`, the bottom of the dependency graph. Phase 3 imports it.
- **D-29:** CI is GitHub Actions on `ubuntu-latest` and `windows-latest`, Node 22.12 and Node 24, running typecheck, lint, `codegen:check` and test. macOS is covered by local dev only.

### @stint/spec public API
- **D-30:** Functions return Results rather than throwing: `validateManifest(x)`, `hashManifest(m)` returning the prefixed hash string, `verifyEnvelope(env, trustStore)` returning `Result<VerifiedManifest>`, `canonicalize(x)`. `VerifiedManifest` is a branded type so later phases can only accept manifests that passed validation and signature verification. Test helpers such as `signManifestForTest` live on a separate `@stint/spec/testing` subpath export.
- **D-31:** Validation errors are a Stint-owned structure over Ajv (`allErrors: true`): `{ ok: false, errors: [{ path, code, message, allowed? }] }` with a stable `code` set mapped from Ajv keywords (e.g. `invalid_enum`, `missing_required`, `unknown_field`). Ajv error objects never leak through the public API. Reversibility: costly. Error codes become a public API that host UIs depend on.

### Sample manifests
- **D-32:** The payment-reconciler manifest (hybrid mode, Paystack transactions read, orders sheet write, `resource_query` verifier) ships now as ALP.md's annotated example and as a valid test vector, so Phase 7 starts from a validated manifest. Minimal delegated-only and hosted-only examples ship alongside.

### Claude's Discretion
- Exact hash prefix spelling (`sha256:` vs `jcs-sha256:`), as long as it names the scheme.
- Exact `publisher_retains` enum values.
- Exact list of Stint error `code` values beyond the examples above.
- Choice of JCS library (must be small, maintained, and pass the RFC 8785 test vectors).
- ESLint/Prettier configuration details within the stack in CLAUDE.md.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project scope & requirements
- `.planning/PROJECT.md`: design review decisions (states, actors, auth modes, teardown, trust limits) that ALP.md must encode normatively
- `.planning/REQUIREMENTS.md`: FND-01..03, SPEC-01..06 acceptance text
- `.planning/ROADMAP.md` §Phase 1: success criteria; later phase sections define what the `[OPEN: Phase N]` markers point to
- `.planning/STATE.md`: blocker note that the Phase 1 canonical serializer must be reused by Phase 3 receipts

### Stack & pitfalls
- `.claude/CLAUDE.md`: pinned versions (TS 5.9.3, pnpm 12.6.0, Vitest 5, tsdown, Ajv 8.20, json-schema-to-typescript 16, jose 6.2.12), draft-07 requirement, `oneOf` caveat
- `.planning/research/STACK.md`: library rationale and version compatibility
- `.planning/research/PITFALLS.md` §Pitfall 7: canonical serialization and golden-hash fixture test; manifest hash re-validation
- `.planning/research/ARCHITECTURE.md`: package boundaries, manifest verification flow, verified vs attested chains (for ALP.md receipts section)
- `.planning/research/FEATURES.md`: signed manifest hash binding and `spec_version` rationale
- `.planning/research/SUMMARY.md`: consolidated research summary

### External standards
- RFC 8785 (JSON Canonicalization Scheme): canonical serializer behavior and test vectors
- RFC 7515 (JWS) Appendix F detached content, RFC 8037 (EdDSA in JOSE): manifest signature format
- RFC 2119 / RFC 8174: normative keywords in ALP.md
- JSON Schema draft-07: manifest schema dialect

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- None. Greenfield repo: only planning docs and `.claude/CLAUDE.md` exist.

### Established Patterns
- None yet in code. CLAUDE.md fixes the conventions: ESM-only (`"type": "module"`), TS strict, project references with `composite: true`, `workspace:*` linking, pnpm via Corepack `packageManager` field.

### Integration Points
- `@stint/spec` is the root of the dependency graph: `spec -> core -> proxy / cli`. Its `canonical` module and `VerifiedManifest` type are the integration points for Phases 2 (manifest hash binding, LIFE-03) and 3 (receipt chains, RCPT-02).

</code_context>

<specifics>
## Specific Ideas

- The ALP.md annotated example is the real payment-reconciler manifest, not a toy.
- Spec reads like an IETF draft, but in GitHub-rendered Markdown with Mermaid.
- Test vectors in `spec/vectors/` are shared between the spec and Stint's own test suite so non-TypeScript implementers can verify hashes and signatures.

</specifics>

<deferred>
## Deferred Ideas

- Publisher key discovery via a well-known JWKS URL: future milestone.
- Key revocation lists for publisher keys: future milestone.
- Machine-readable `spec/transitions.json` as a single source for ALP.md and the Phase 2 reducer: considered, the normative table stays in ALP.md for now.
- `spec_version` negotiation / semver ranges: revisit after 1.0.
- macOS in CI: not required by FND-02.

</deferred>

---

*Phase: 01-foundation-alp-spec*
*Context gathered: 2026-09-27*
