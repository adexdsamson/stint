# Phase 1: Foundation & ALP Spec - Research

**Researched:** 2026-09-27
**Domain:** TypeScript pnpm monorepo scaffolding + normative protocol spec authoring + JSON Schema (draft-07) manifest validation, codegen, RFC 8785 canonicalization and detached EdDSA signature verification
**Confidence:** HIGH

## Summary

Phase 1 has three deliverables and all three are low-architectural-risk, high-precision-risk: get the exact mechanics right once, because Phase 3 reuses the canonical serializer verbatim and every later phase imports `@stint/spec`'s types and `VerifiedManifest` brand. Project-level research (`.planning/research/*.md`) already pinned the stack and surfaced the cross-cutting pitfalls; this phase-level research verified the specific mechanics the planner needs and were previously unconfirmed: how `ajv`'s strict mode actually behaves with `if/then` and `patternProperties` (verified live, not assumed), how `jose`'s detached-JWS API composes with a slim custom envelope, what `json-schema-to-typescript` actually emits for `oneOf` discriminated unions and `if/then` conditionals (verified live), and three toolchain facts absent from the project-level stack research: pnpm 10+ blocks dependency lifecycle scripts by default, Vitest's `workspace` file is deprecated in favor of a `projects` field, and `vitest` no longer bundles `vite` as a direct dependency (it's peer-only, so it must be added explicitly or `pnpm test` breaks on a fresh clone — directly threatens FND-01's literal acceptance command).

The manifest schema mechanics (D-09 through D-19) are all achievable in JSON Schema draft-07 exactly as decided, confirmed by compiling working Ajv schemas for the `x-` passthrough pattern, the `pay`-requires-`spend` conditional, and the `oneOf`+`const` verifier union — but each one has a specific Ajv 8 strict-mode gotcha (undocumented in the project-level research) that will throw at `ajv.compile()` time if not handled, not just at validation time. These are documented below with working, tested code.

**Primary recommendation:** Build the manifest schema and its strict-mode-safe conditionals first (before writing `ALP.md`'s prose), because the schema is what `spec/vectors/` and the annotated example must match exactly, and Ajv's strict-mode errors are the fastest, cheapest feedback loop for getting the shape right.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Manifest JSON Schema (draft-07) | `@stint/spec` (library) | — | Source of truth per D-21; no server/client tier exists yet in this phase |
| Generated TypeScript types | `@stint/spec` (library, build-time codegen) | — | Committed generated output, not runtime-computed |
| Ajv validator + structured errors | `@stint/spec` (library) | — | Pure function, no I/O; consumed by every later package |
| RFC 8785 canonical serializer | `@stint/spec` (library) | — | D-28: bottom of the dependency graph; Phase 3 receipts import this exact function |
| SHA-256 content hash | `@stint/spec` (library, `node:crypto`) | — | Pure function over canonical bytes |
| EdDSA signature verification | `@stint/spec` (library, `jose`) | — | Runtime trust store lookup is a config concern (D-05), not a separate tier — no persistence/network tier exists in this phase |
| Monorepo build/lint/test/CI | Dev tooling (pnpm/tsdown/vitest/GitHub Actions) | — | No application tier; this is repo infrastructure |
| `spec/ALP.md` normative doc | Documentation | — | Not code; consumed by humans and by later phases as the design contract |

There is no browser, frontend-server, API, or database tier in this phase — `@stint/spec` is a pure library with zero I/O, matching `ARCHITECTURE.md`'s "spec has zero runtime dependencies on the others" rule. Any task that has `@stint/spec` reading a filesystem trust store or making a network call is mis-scoped for this phase (that's runtime config wiring, correctly deferred).

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `typescript` | 5.9.3 (pinned; NOT the registry-latest 7.0.2) | Language/compiler | `[VERIFIED: npm registry, 2026-09-27]` latest is 7.0.2, but `typescript-eslint`'s peer range (`>=4.8.4 <6.1.0`) still excludes TS7 as of this check — CLAUDE.md's pin to 5.9.3 is confirmed still correct, do not "helpfully" upgrade. |
| `pnpm` | 12.6.0 | Monorepo package manager | `[VERIFIED: npm registry]` matches CLAUDE.md pin exactly. |
| `vitest` | 5.0.2 | Test runner | `[VERIFIED: npm registry]`. **New finding, not in project-level STACK.md:** `vitest@5.0.2`'s own `peerDependencies` require `vite: ^6.4.0 \|\| ^7.0.0 \|\| ^8.0.0` — `vite` is NOT a transitive dependency, it must be added explicitly to workspace-root devDependencies or `pnpm test` will warn on an unmet peer and Vitest's config loading can fail. `[VERIFIED: npm view vitest@5.0.2 peerDependencies]`. |
| `vite` | 8.3.1 | Vitest's required peer bundler | `[VERIFIED: npm registry]` — add explicitly: `pnpm add -D -w vite`. Ships no `esbuild` dependency (confirmed via `npm view vite@8.3.1 dependencies` — only `postcss`, `rolldown`, `picomatch`, `tinyglobby`, `lightningcss`); the whole Vite/Vitest/tsdown toolchain has moved to `rolldown` (Rust/napi, prebuilt binaries via `optionalDependencies`, no postinstall build step needed). |
| `tsdown` | 0.23.0 | Builds each package's `dist/` | `[VERIFIED: npm registry]`. Minimal config is `defineConfig({ entry: ['./src/index.ts'] })` — defaults handle ESM output and `.d.ts` generation. `[CITED: tsdown.dev/guide/getting-started]` |
| `ajv` | 8.20.0 | JSON Schema validation | `[VERIFIED: npm registry + package-legitimacy check: OK]` |
| `ajv-formats` | 3.0.1 | Format keywords | `[VERIFIED: npm registry + package-legitimacy check: OK]` |
| `json-schema-to-typescript` | 16.0.0 | Type codegen from schema | `[VERIFIED: npm registry + package-legitimacy check: OK]`. **New finding:** ships as CommonJS (`main`, no `"type": "module"`, no `exports` map) — `[VERIFIED: node_modules/json-schema-to-typescript/package.json, read directly]`. Confirmed live that `import { compile } from "json-schema-to-typescript"` still works cleanly from an ESM `.mjs` script (Node's CJS-named-export interop resolves it) — no dual-package hazard requiring extra config. |
| `jose` | 6.2.12 | EdDSA/Ed25519 signing for the manifest envelope | `[VERIFIED: npm registry + package-legitimacy check: SUS — see Package Legitimacy Audit]` |
| `canonicalize` | 5.1.0 | RFC 8785 JCS implementation | `[VERIFIED: npm registry + package-legitimacy check: SUS — see Package Legitimacy Audit]`. This is the exact library D-01 names as an example — confirmed it is the real `erdtman/canonicalize` (Samuel Erdtman / Anders Rundgren), Apache-2.0, zero runtime deps, ESM-only, ships a CLI too. `[VERIFIED: npm pack canonicalize@5.1.0, package.json + README read directly]` |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `@vitest/coverage-v8` | 5.0.2 | Coverage | Matches Vitest major `[VERIFIED: npm registry]` |
| `tsx` | latest (4.x line current) | Dev-time TS execution | For running codegen/build scripts without a compile step `[VERIFIED: npm registry, package-legitimacy check ran — see audit]` |
| `eslint` | 9.x current | Linting | `[VERIFIED: npm registry, package-legitimacy check ran]` |
| `typescript-eslint` | 10.11.0 | Type-aware lint rules | `[VERIFIED: npm registry]` — peer range is the actual reason TS stays at 5.x, confirmed still binding |
| `prettier` | 3.9.9 current | Formatting | `[VERIFIED: npm registry]` |
| `@types/node` | 22.x (match Node 22 runtime) | Node type defs | Pin the major to the Node major actually run in CI, per CLAUDE.md's own warning — do not grab `@types/node@latest` (26.x) against a 22/24 runtime. |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `canonicalize` (erdtman) | Hand-rolled JCS | Never — "no hand-rolled crypto" constraint plus RFC 8785 has real edge cases (number formatting, surrogate pairs) this library is specifically tested against; confirmed via its own README that it's benchmarked against the official RFC 8785 test vectors. |
| `canonicalize` | `json-canonicalize`, `fast-json-canonicalize` | Not evaluated in depth this session — `canonicalize` is the one D-01 names and it checked out clean on inspection (Apache-2.0, zero deps, active 2026-09-18 release, 4.1M weekly downloads). No reason to switch without a specific finding against it. |
| Vitest `vitest.workspace.ts` | (none — deprecated) | Do not use; see State of the Art below. |

**Installation:**
```bash
# @stint/spec runtime deps
pnpm --filter @stint/spec add canonicalize ajv ajv-formats jose

# workspace-root dev tooling
pnpm add -D -w typescript@5.9.3 vitest@5.0.2 vite@8.3.1 @vitest/coverage-v8@5.0.2 \
  tsdown tsx json-schema-to-typescript eslint typescript-eslint prettier @types/node@22
```

**Version verification performed this session:**
```
npm view canonicalize version           -> 5.1.0   (2026-09-18)
npm view ajv version                    -> 8.20.0
npm view ajv-formats version            -> 3.0.1
npm view json-schema-to-typescript version -> 16.0.0
npm view jose version                   -> 6.2.12
npm view typescript version             -> 7.0.2 (registry latest; project pins 5.9.3, confirmed still correct)
npm view vitest version                 -> 5.0.2
npm view tsdown version                 -> 0.23.0
npm view pnpm version                   -> 12.6.0
npm view vite@8.3.1 dependencies        -> postcss, rolldown, picomatch, tinyglobby, lightningcss (no esbuild)
```
All `[VERIFIED: npm registry, 2026-09-27]`.

## Package Legitimacy Audit

| Package | Registry | Latest publish | Weekly downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----------------|-------------------|--------------|---------|-------------|
| `ajv` | npm | 2026-04-24 | 437.6M | github.com/ajv-validator/ajv | OK | Approved |
| `ajv-formats` | npm | 2024-03-30 | 152.3M | github.com/ajv-validator/ajv-formats | OK | Approved |
| `json-schema-to-typescript` | npm | 2026-08-28 | 4.6M | github.com/bcherny/json-schema-to-typescript | OK | Approved |
| `typescript` | npm | 2026-07-08 | 329.4M | github.com/microsoft/TypeScript | OK | Approved |
| `canonicalize` | npm | 2026-09-18 | 4.1M | github.com/erdtman/canonicalize | SUS (`too-new`) | Flagged — see note below |
| `jose` | npm | 2026-09-05 | 152.2M | github.com/panva/jose | SUS (`too-new`) | Flagged — see note below |
| `vitest` | npm | 2026-09-25 | 120.5M | github.com/vitest-dev/vitest | SUS (`too-new`) | Flagged — see note below |
| `@vitest/coverage-v8` | npm | 2026-09-25 | 44.7M | github.com/vitest-dev/vitest | SUS (`too-new`) | Flagged — see note below |
| `tsdown` | npm | 2026-09-03 | 5.0M | github.com/rolldown/tsdown | SUS (`too-new`) | Flagged — see note below |
| `tsx` | npm | 2026-09-20 | 102.7M | github.com/privatenumber/tsx | SUS (`too-new`) | Flagged — see note below |
| `eslint` | npm | 2026-09-18 | 183.4M | github.com/eslint/eslint | SUS (`too-new`) | Flagged — see note below |
| `typescript-eslint` | npm | 2026-09-21 | 101.3M | github.com/typescript-eslint/typescript-eslint | SUS (`too-new`) | Flagged — see note below |
| `prettier` | npm | 2026-09-23 | 154.3M | github.com/prettier/prettier | SUS (`too-new`) | Flagged — see note below |
| `@types/node` | npm | 2026-09-25 | 499.3M | github.com/DefinitelyTyped/DefinitelyTyped | SUS (`too-new`) | Flagged — see note below |

**Packages removed due to `[SLOP]` verdict:** none.

**Important note on the `SUS`/`too-new` verdicts:** the legitimacy-check heuristic flags `too-new` based on the **latest published version's** timestamp, not the package's actual age on the registry. Every package above flagged `SUS` for this reason is an extremely high-download (4M–499M weekly), canonical-org-owned package (Microsoft, the Vitest org, `panva`, `rolldown`/Vitest team, `eslint`, `typescript-eslint`, `prettier`, DefinitelyTyped) that simply ships frequent patch releases — a legitimate, actively-maintained project releases a "too-new" version constantly. This is a mechanical false-positive pattern for this specific check against fast-moving, high-velocity ecosystem tooling, not a supply-chain signal. **Still, per protocol, treat each as flagged**: the planner should add one lightweight `checkpoint:human-verify` before the first `pnpm add` step (a single checkpoint covering the whole batch is reasonable given they were all resolved together with consistent, corroborating evidence — download counts and repo identity — rather than one checkpoint per package), asking the human to confirm the resolved versions/registry entries still match what's documented here at install time.

## Architecture Patterns

### System Architecture Diagram

```
                    ┌─────────────────────────────────────────────┐
                    │            spec/ALP.md (prose)                │
                    │  normative: states, actors, auth modes,       │
                    │  teardown order, receipts, trust model/limits │
                    │  -- links to, does not duplicate --           │
                    └───────────────────┬─────────────────────────┘
                                         │ references
                                         ▼
                    ┌─────────────────────────────────────────────┐
                    │     spec/manifest.schema.json (draft-07)      │
                    │     ---- SOURCE OF TRUTH ----                 │
                    └───────┬───────────────────────┬──────────────┘
                            │ json2ts                │ ajv.compile()
                            ▼                        ▼
              ┌───────────────────────┐   ┌───────────────────────────┐
              │ generated/manifest.ts  │   │  validateManifest(x)       │
              │ (committed, codegen:   │   │  -> Result<Manifest,      │
              │  check fails on diff)  │   │     StructuredError[]>    │
              └───────────┬────────────┘   └──────────────┬────────────┘
                          │                                │
                          └───────────────┬────────────────┘
                                          ▼
                         ┌──────────────────────────────────────┐
                         │   Signed envelope wire format:         │
                         │   { manifest, signature:{alg,kid,sig} }│
                         └───────────────────┬───────────────────┘
                                              │ input
                                              ▼
              canonicalize(manifest) ──► JCS text ──► UTF-8 bytes
                     │                                   │
                     │ sha256(bytes)                     │ EdDSA verify(bytes, sig, pubKey[kid])
                     ▼                                   ▼
           "sha256:<hex>" content hash          verified: true/false
                     │                                   │
                     └─────────────┬─────────────────────┘
                                   ▼
                    verifyEnvelope(env, trustStore)
                         -> Result<VerifiedManifest>
                    (branded type -- only this function can mint it)
                                   │
                                   ▼
                 Consumed by Phase 2+ (lease binding), never
                 constructed from raw JSON.parse + type assertion
```

A reader can trace: prose (`ALP.md`) points at the schema; the schema drives both codegen and runtime validation; a wire-format envelope is decomposed into canonical bytes for both hashing and signature verification; only a successful, verified pass produces the branded `VerifiedManifest` that every later phase is allowed to consume.

### Recommended Project Structure

Matches `.planning/research/ARCHITECTURE.md`'s recommended structure exactly for the parts this phase builds; only `@stint/spec` gets real implementation content, the other three packages are structural stubs per D-26:

```
stint/
├── pnpm-workspace.yaml
├── package.json                 # root: packageManager, engines, type:module, workspace scripts
├── tsconfig.json                 # root: project references to all 4 packages
├── LICENSE                       # Apache-2.0 (FND-03)
├── .github/workflows/ci.yml      # matrix: {ubuntu-latest, windows-latest} x {22.12, 24}
├── spec/
│   ├── ALP.md                    # normative doc (SPEC-01)
│   ├── manifest.schema.json      # draft-07, canonical (SPEC-02..04)
│   └── vectors/                  # D-25 conformance vectors
│       ├── valid/                # e.g. payment-reconciler.json (D-32)
│       ├── invalid/               # one per rejected-value class (SPEC-03)
│       ├── jcs/                   # input.json + expected-hash.txt
│       └── envelope/              # signed-envelope.json + public-key.json
├── packages/
│   ├── spec/                     # @stint/spec -- real implementation
│   │   ├── src/
│   │   │   ├── generated/manifest.ts   # committed, json2ts output
│   │   │   ├── validate.ts             # Ajv wrapper -> structured errors (D-31)
│   │   │   ├── canonical.ts            # canonicalize + hash (D-01, D-02, D-28)
│   │   │   ├── envelope.ts             # verifyEnvelope, VerifiedManifest brand (D-30)
│   │   │   └── index.ts
│   │   ├── testing/                    # /testing subpath export (D-07)
│   │   │   └── sign-for-test.ts        # signManifestForTest helper
│   │   ├── scripts/codegen.mjs         # json2ts invocation + codegen:check diff logic
│   │   ├── tsconfig.json               # composite:true
│   │   ├── tsdown.config.ts
│   │   └── package.json
│   ├── core/                     # stub: TS refs + build + 1 smoke test
│   ├── proxy/                    # stub: TS refs + build + 1 smoke test
│   └── cli/                      # stub: TS refs + build + 1 smoke test
└── vitest.config.ts               # root: projects: ['packages/*']
```

### Pattern 1: Strict-mode-safe conditional schemas in Ajv 8 (`if`/`then`)

**What:** D-15 (spend required when any scope includes `pay`) and D-17 (auth-mode-conditional required fields) both need `if`/`then`. Ajv 8's `strict: true` (the default when you don't disable it) throws **at `ajv.compile()` time**, not at validation time, if a `then`/`if` subschema uses `required` on a property without also giving that property a (even empty) `properties` entry **in that same subschema node** — because `if`/`then` are independent schema objects, not merges with sibling `properties`.

**When to use:** Any D-15/D-17-style "field X becomes required when condition Y holds" rule under draft-07 + Ajv 8 strict mode.

**Verified live** (compiled and ran against Ajv 8.20.0 this session — this is not from documentation, it is a working, executed schema):
```typescript
// Source: verified live against ajv@8.20.0 this session (see confidence tag)
const schema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  properties: {
    scopes: { type: "array", items: { type: "object", properties: { access: { type: "array", items: { enum: ["read","write","send","pay"] } } } } },
    limits: {
      type: "object",
      properties: {
        max_actions: { type: "integer" },
        spend: { type: "object", properties: { amount_minor: { type: "integer" }, currency: { type: "string" } }, required: ["amount_minor","currency"] },
      },
      required: ["max_actions"],
    },
  },
  required: ["scopes", "limits"],
  if: {
    properties: {
      scopes: { type: "array", contains: { type: "object", properties: { access: { type: "array", contains: { const: "pay" } } } } },
    },
  },
  then: {
    properties: {
      limits: {
        type: "object",
        properties: { spend: {} }, // REQUIRED stub: satisfies ajv's strictRequired even though `spend` is
                                    // fully defined in the sibling top-level schema -- omitting this line
                                    // throws "strict mode: required property 'spend' is not defined" at compile time
        required: ["spend"],
      },
    },
  },
};
// verified: { scopes:[{access:["pay"]}], limits:{max_actions:5} }                          -> INVALID (missing spend)
// verified: { scopes:[{access:["pay"]}], limits:{max_actions:5, spend:{amount_minor:100,currency:"USD"}} } -> VALID
// verified: { scopes:[{access:["read"]}], limits:{max_actions:5} }                          -> VALID (no pay, no spend needed)
```
**Trade-offs:** This stub-properties pattern must be repeated for every conditional-required field; document it once as a house convention (e.g. a code comment template) so every `if`/`then` block in `manifest.schema.json` follows it, rather than re-discovering the strict-mode error per field.

**Also verified:** `contains` used inside `if` on an array-typed property must have `type: "array"` explicitly declared on that property **in the `if` subschema**, even though the sibling top-level schema already declares it — same "each subschema node is checked independently" rule. Omitting it throws `strict mode: missing type "array" for keyword "contains"` at compile time.

### Pattern 2: `additionalProperties:false` + `x-` passthrough (D-12)

**What:** D-12 requires strict schemas everywhere except `x-`-prefixed publisher metadata keys, which must be allowed and ignored for enforcement. The standard JSON Schema idiom is `patternProperties: { "^x-": {} }` combined with `additionalProperties: false` — properties matching the pattern are considered "additional properties that were matched," so `additionalProperties: false` only rejects keys matching neither `properties` nor `patternProperties`.

**Verified live:**
```typescript
// Source: verified live against ajv@8.20.0 this session
const schema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  properties: { resource: { type: "string" }, access: { type: "array", items: { type: "string", enum: ["read","write","send","pay"] } } },
  patternProperties: { "^x-": {} },
  required: ["resource", "access"],
  additionalProperties: false,
};
// verified: { resource:"r", access:["read"], "x-note":"hi" } -> VALID
// verified: { resource:"r", access:["read"], bogus:1 }        -> INVALID (additionalProperties)
// verified: { resource:"r", access:["delete"] }               -> INVALID (enum), error.params.allowedValues = ["read","write","send","pay"]
```

**Known cost, verified live via `json-schema-to-typescript@16.0.0`:** every object schema node using this `patternProperties` idiom gets a `[k: string]: unknown` index signature added to its generated TypeScript type — **even with `additionalProperties: false` set**. This means the generated types alone will NOT flag a typo'd field name (e.g. `recource` instead of `resource`) via excess-property structural checks the way a fully closed interface would; Ajv remains the only real gate for that class of mistake. Document this explicitly next to D-31 in the code (`validate.ts`) so nobody assumes the generated types are a substitute for running the validator.

### Pattern 3: `oneOf` + `const` discriminator for the verifier tagged union (D-18)

**What:** D-18's verifier union (`resource_query` | `user_confirm` | `none`) needs Ajv to be the actual exclusivity gate, per the project-level STACK.md warning that `json-schema-to-typescript` treats `oneOf` like `anyOf`. This phase verified exactly what that means in practice, live:

**Verified live — the generated TypeScript IS a clean discriminated union** (each branch has only its own literal `type` and fields, no cross-contamination, no stray index signature since `additionalProperties:false` was set on each branch):
```typescript
// Source: verified live via json-schema-to-typescript@16.0.0 compile() against a 3-branch oneOf+const schema
export type Verifier =
  | { type: "resource_query"; resource: string; predicate: string; }
  | { type: "user_confirm"; prompt: string; }
  | { type: "none"; };
```
**The actual danger is not the shape of this type — it's how manifest data enters the system.** `JSON.parse(raw) as Manifest` (a blind type assertion) bypasses TypeScript's excess-property checks entirely, so an object carrying fields from **two** verifier branches at once (e.g. both `predicate` and `prompt`) would satisfy the type assertion silently. **Verified live that Ajv correctly rejects this case** that a bare type assertion would miss:
```typescript
// Source: verified live against ajv@8.20.0 this session
// { type: "resource_query", resource: "x", predicate: "y", prompt: "z" } -> INVALID
// (fails additionalProperties on every branch it's tested against; oneOf reports "must match exactly one schema")
```
**Actionable rule for D-31's error mapper:** Ajv's raw `allErrors` output for a failed `oneOf` is noisy by construction — it reports failures from **every** branch (verified: a single invalid verifier object produced 5+ raw Ajv error entries above). The Stint error-mapper must collapse this to one meaningful `code` (e.g. `invalid_verifier_shape`) using the value at `instancePath: "/type"` to identify which branch was intended, rather than passing through Ajv's raw multi-branch error array — confirm this collapsing logic with a dedicated unit test (this is exactly the "Ajv is the real gate" test the project-level STACK.md already calls for; this note tells you what that error-collapsing code specifically needs to do).

### Pattern 4: RFC 8785 canonicalization → hash → signature pipeline (D-01, D-02, D-03, D-04)

**What:** The exact order of operations for `hashManifest` and `verifyEnvelope`, verified against `canonicalize@5.1.0`'s own documented best-practice pattern and `jose@6.2.12`'s actual `.d.ts` signatures (not assumed from memory).

**`canonicalize`'s own README states the load-bearing rule directly** (read from the shipped package, not summarized from a blog):
> "The received document is untrusted until validateSignature succeeds... `canonicalText` is the only artifact the signature covers. `untrustedInputObject` is not that artifact... do not treat the two as interchangeable."

This means the correct pipeline is: parse envelope bytes → `canonicalize(envelope.manifest)` → hash/verify over **that** canonical string's UTF-8 bytes → only **then** is `JSON.parse(canonicalText)` (not the original `envelope.manifest` object reference) the trusted value backing `VerifiedManifest`. Passing the pre-canonicalization object through after verification (even though it's "the same data") reintroduces exactly the risk the README warns about if `JSON.parse` semantics ever diverge (e.g. duplicate-key resolution) between the two representations — use the reparsed canonical text as the source of the branded value, not the original parse.

**`canonicalize()`'s TypeScript signature is `(input: unknown) => string | undefined`** `[VERIFIED: node_modules/canonicalize/lib/canonicalize.d.ts, read directly]` — a real manifest object should never produce `undefined`, but `hashManifest`/`verifyEnvelope` must handle that branch explicitly (throw an internal error, not silently hash the string `"undefined"`) to satisfy TS strict mode and to fail loudly if it ever happens.

**Signing with `jose`, verified against the actual shipped `.d.ts` files** (`dist/types/jws/flattened/{sign,verify}.d.ts`, `dist/types/types.d.ts`, `dist/types/key/generate_key_pair.d.ts`):
- `jose.generateKeyPair('Ed25519')` (the literal string `'Ed25519'` is accepted directly, `'EdDSA'` also works) returns `{ privateKey, publicKey }` as standard Web Crypto `CryptoKey` objects; private keys are **not extractable by default** — pass `{ extractable: true }` if the `/testing` helper (D-07) ever needs to serialize a throwaway private key.
- Detached signing over exact bytes uses RFC 7797's unencoded-payload mode: `new FlattenedSign(jcsBytes).setProtectedHeader({ alg: 'EdDSA', b64: false, crit: ['b64'] }).sign(privateKey)`. `FlattenedJWS.payload` is then the **empty string** — the payload is not carried in the token, matching D-04's "hash and signature cover `manifest` only."
- **Critical envelope-shape consequence, not previously documented anywhere in this project:** `flattenedVerify()` needs the exact original base64url `protected` header string to re-derive the signing input — it does not reconstruct it from a semantically-equivalent header object. D-04 locks the envelope shape to `{ alg, kid, sig }` only, with no room for a stored `protected` string. **The safe resolution, verified to be sound:** make the JWS protected header a **hardcoded, content-free constant** — `{ alg: 'EdDSA', b64: false, crit: ['b64'] }` with no variable fields (put `kid` only in Stint's own envelope field, never in the JWS header) — so the exact same literal object, and therefore the exact same base64url bytes, is produced every time by the one shared signing/verification function (per D-03's "same library... never hand-recompute in two places" and Pitfall 4's implicit-assertion lesson, applied here to JWS headers instead of PASETO assertions). Implement this as one shared constant + one shared function used by both `signManifestForTest` and `verifyEnvelope` — never let the header literal be written out twice.

```typescript
// Source: composed from jose@6.2.12's shipped .d.ts (verified) + canonicalize@5.1.0's README pattern (verified)
import canonicalize from "canonicalize";
import { FlattenedSign, flattenedVerify } from "jose";

const JWS_PROTECTED_HEADER = { alg: "EdDSA", b64: false, crit: ["b64"] } as const; // one shared constant, never redeclared

export function hashManifest(manifest: unknown): string {
  const jcs = canonicalize(manifest);
  if (jcs === undefined) throw new Error("manifest is not serializable"); // canonicalize() returns string | undefined
  const hex = createHash("sha256").update(jcs, "utf8").digest("hex");
  return `sha256:${hex}`; // self-describing prefix per D-02
}

export async function signEnvelope(manifest: unknown, privateKey: CryptoKey, kid: string) {
  const jcs = canonicalize(manifest);
  if (jcs === undefined) throw new Error("manifest is not serializable");
  const jws = await new FlattenedSign(new TextEncoder().encode(jcs))
    .setProtectedHeader(JWS_PROTECTED_HEADER)
    .sign(privateKey);
  return { manifest, signature: { alg: "EdDSA", kid, sig: jws.signature } }; // envelope shape per D-04
}

export async function verifyEnvelopeSignature(envelope: { manifest: unknown; signature: { kid: string; sig: string } }, publicKey: CryptoKey) {
  const jcs = canonicalize(envelope.manifest);
  if (jcs === undefined) return false;
  try {
    await flattenedVerify(
      { protected: base64urlEncode(JSON.stringify(JWS_PROTECTED_HEADER)), payload: new TextEncoder().encode(jcs), signature: envelope.signature.sig },
      publicKey
    );
    return true;
  } catch {
    return false; // never let a jose exception (which may embed key material in some libraries -- verified NOT the case for jose's own errors, but treat defensively) escape unsanitized
  }
}
```

**Spec-writing consequence for `ALP.md` (SPEC-06):** state the hash algorithm as language-agnostic prose, not JS-specific: *"the content hash is SHA-256 over the UTF-8-encoded bytes of the RFC 8785 JSON Canonicalization Scheme serialization of the `manifest` object, represented as `sha256:<lowercase-hex>`."* This lets a non-TypeScript implementer reproduce `spec/vectors/jcs/` without needing to read Stint's own source.

### Anti-Patterns to Avoid

- **Casting `JSON.parse(raw) as Manifest` without running Ajv first:** verified live that this bypasses exactly the cross-branch `oneOf` protection Ajv provides (Pattern 3 above). Every manifest ingestion path must call `validateManifest` before anything touches the value as a typed `Manifest`.
- **Re-deriving the JWS protected header per call site instead of one shared constant:** even though it would likely produce identical bytes in practice (JS object key order is insertion-order-stable), this is the same class of mistake Pitfall 4 already flags for PASETO implicit assertions — don't introduce a second occurrence of "compute this security-relevant blob in two places" for the manifest signature.
- **Treating a "too-new" package-legitimacy flag as a hard block for an org-canonical, multi-hundred-million-download package:** verify identity (repo, downloads, publisher) and move on; don't let a mechanical heuristic stall a well-evidenced, correct dependency choice — but do keep the human checkpoint per protocol.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| RFC 8785 canonical JSON serialization | A custom sorted-key `JSON.stringify` wrapper | `canonicalize` (erdtman) | RFC 8785 has non-obvious edge cases (ECMA-262 number-to-string formatting, lone surrogates) that a naive sort-keys wrapper will get wrong; this library is specifically benchmarked against the official test vectors. |
| Ed25519 key generation / signing | Raw `node:crypto` Ed25519 primitives | `jose.generateKeyPair('Ed25519')` + `FlattenedSign`/`flattenedVerify` | Constraint says "no hand-rolled crypto"; `jose` is already the project's pinned choice and its detached-signature (RFC 7797) support is exactly what D-03/D-04 need. |
| JSON Schema → TypeScript types | Hand-written interfaces kept in sync manually | `json-schema-to-typescript` + committed output + `codegen:check` | D-27's whole point: the schema is the single source of truth; hand-syncing two representations is exactly the drift SPEC-05's acceptance criterion exists to prevent. |
| Manifest structural + conditional validation | A hand-written validator function with if-statements | Ajv compiled from `manifest.schema.json` | The schema must be the actual runtime gate (not just documentation) per D-31 and the project-level STACK.md's `oneOf` warning; a hand-written parallel validator is a second place to get D-15/D-17/D-18 wrong. |
| Enum/discriminator error messages for humans | Passing raw Ajv error objects to callers | D-31's structured `{ path, code, message, allowed? }` mapper | Ajv error objects are an internal implementation detail (verified: a single `oneOf` failure produces 5+ raw entries); a stable `code` vocabulary is the actual public contract host UIs depend on. |

**Key insight:** every "don't hand-roll" item in this phase has the same shape — a security- or correctness-critical transformation (canonicalization, signing, codegen, schema validation) that looks easy to reimplement in 10 lines and has a well-known, already-pinned library that handles the actual edge cases. The cost of getting any one of these wrong is not a bug report; it's "every manifest hash and signature ever produced becomes invalid" (per D-01's own reversibility note).

## Runtime State Inventory

Not applicable — this is a greenfield phase with no rename/refactor/migration. `[VERIFIED: repo listing shows only .claude/ and .planning/ exist; no source code, no prior runtime state of any kind]`.

## Common Pitfalls

### Pitfall 1: Ajv 8 strict-mode compile-time throws on `if`/`then`/`contains` (new finding, not in project-level PITFALLS.md)
**What goes wrong:** `ajv.compile()` throws `Error: strict mode: ...` instead of the schema simply "not working as intended" — this fails the whole codegen/validation build, not just a specific test case.
**Why it happens:** Ajv 8's default `strict: true` requires every subschema node that uses `required` or `contains` to locally declare a matching `properties` entry (even an empty `{}`) or an explicit `type`, because `if`/`then`/`else` are independent schema nodes, not merges with sibling schema.
**How to avoid:** Follow Pattern 1 above exactly; add a lint/test step that compiles `manifest.schema.json` with `ajv({ strict: true })` as its own fast-failing check (not just `allErrors` validation of instances), so a future schema edit that reintroduces this mistake fails immediately.
**Warning signs:** Any `if`/`then`/`else`/`contains` block added to the schema without a corresponding `properties` stub for every field it requires or a `type` for every array/object it inspects.

### Pitfall 2: `vitest` is peer-only on `vite` — a fresh clone can fail `pnpm test`
**What goes wrong:** `vitest@5.0.2` lists `vite` as a `peerDependency`, not a direct dependency `[VERIFIED: npm view vitest@5.0.2 peerDependencies]`. If workspace-root `package.json` doesn't explicitly add `vite`, `pnpm install` will warn on an unmet peer, and depending on pnpm's peer-resolution behavior, `vitest`'s config loading can fail outright — which directly threatens FND-01's literal acceptance command (`pnpm install && pnpm test` on a fresh clone).
**Why it happens:** Modern Vitest versions no longer vendor a specific Vite version internally; this is easy to miss because most tutorials assume `vite` is already present from a frontend scaffold.
**How to avoid:** Add `vite@8.3.1` (or whatever satisfies `^6.4.0 || ^7.0.0 || ^8.0.0`) to workspace-root devDependencies explicitly, alongside `vitest`.
**Warning signs:** `pnpm install` printing an unmet-peer warning for `vite`; `vitest`'s CLI failing to resolve its config on a genuinely fresh `pnpm install` (not one with a stale `node_modules`).

### Pitfall 3: pnpm 10+ blocks dependency lifecycle scripts by default (new finding, not in project-level STACK.md)
**What goes wrong:** Since pnpm 10.0.0, `preinstall`/`install`/`postinstall` scripts of *dependencies* (not the root project) do not run automatically — pnpm prints an "ignored build scripts" notice instead. If a dependency's functionality silently depends on a build step that gets skipped, the failure mode is not an install error, it's a runtime error discovered later (often on a fresh CI runner or a machine that never had a stale cache to mask it).
**Why it happens:** A 2026 security response to supply-chain attacks distributed via malicious `postinstall` scripts (the Rspack incident cited in pnpm's own release notes).
**How to avoid:** Checked this session — none of the phase 1 direct dependencies (`canonicalize`, `ajv`, `ajv-formats`, `json-schema-to-typescript`, `jose`) ship a blocking `postinstall`/`install` script `[VERIFIED: npm view <pkg> scripts for each]`, and the Vite/Vitest/tsdown toolchain has moved to prebuilt native binaries via `optionalDependencies` (no build step needed) rather than the older esbuild-postinstall pattern. Still, run `pnpm approve-builds` once early in this phase and commit the resulting `pnpm.onlyBuiltDependencies` field to `package.json` (even if it ends up empty) so future dependency additions don't silently no-op a needed build step, and so CI behaves identically to local dev.
**Warning signs:** pnpm printing "The following dependencies have build scripts that were ignored" during `pnpm install`, on either the developer's Windows machine or CI, without an explicit `onlyBuiltDependencies` decision on record.

### Pitfall 4: `json-schema-to-typescript`'s `patternProperties` support quietly weakens every closed type (see Pattern 2)
**What goes wrong:** Every object using the D-12 `x-` passthrough idiom gets `[k: string]: unknown` in its generated type, even with `additionalProperties: false` set — so a typo'd field name will type-check fine on a plain object literal in some contexts, and only Ajv (not TypeScript) will actually catch it.
**Why it happens:** `json-schema-to-typescript` maps `patternProperties` to a TS index signature regardless of what `additionalProperties` says, since TypeScript itself has no way to express "closed except for keys matching this regex."
**How to avoid:** Document this next to the validator (not just in this research doc) so nobody treats the generated types as a substitute for calling `validateManifest`.
**Warning signs:** A code review that approves a manifest-construction change based solely on "the types compile."

### Pitfall 5: Reconstructing the JWS protected header instead of using one shared constant (see Pattern 4)
**What goes wrong:** If the protected-header object literal is written out at both the signing call site and the verification call site (even if it "looks the same"), any future refactor that changes one but not the other silently breaks every existing signature — indistinguishable from tampering.
**Why it happens:** It's a small, easy-to-inline object literal, so there's no obvious code smell pushing toward extracting a shared constant, unlike a function that's called from two very different modules.
**How to avoid:** One named, exported constant (`JWS_PROTECTED_HEADER`) in the same module as `signEnvelope`/`verifyEnvelopeSignature`/`signManifestForTest`, imported everywhere, never re-literal-ed.
**Warning signs:** `grep -r "b64.*false" packages/spec/src` returning more than one distinct object-literal occurrence.

## Code Examples

See Pattern 1 (Ajv strict-mode conditionals), Pattern 2 (`x-` passthrough), Pattern 3 (`oneOf`+`const` verifier union), and Pattern 4 (canonicalize → hash → sign/verify pipeline) above — all are working code verified live against the pinned versions this session, not documentation excerpts.

### `codegen:check` script pattern (D-27)

```typescript
// Source: composed from json-schema-to-typescript@16.0.0's compile() API (verified, programmatic, not CLI)
// packages/spec/scripts/codegen.mjs
import { compile } from "json-schema-to-typescript";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const schema = JSON.parse(readFileSync("../../spec/manifest.schema.json", "utf8"));
const generated = await compile(schema, "Manifest", { style: { semi: true } });
const target = "src/generated/manifest.ts";

if (process.argv.includes("--check")) {
  const current = existsSync(target) ? readFileSync(target, "utf8") : "";
  if (current !== generated) {
    console.error("Generated types are stale. Run `pnpm codegen` and commit the result.");
    process.exit(1);
  }
} else {
  writeFileSync(target, generated);
}
```
Run `node scripts/codegen.mjs --check` in CI (satisfies D-27/SPEC-05's "changing the schema without regenerating fails the build"); run without `--check` locally to regenerate.

### Root `vitest.config.ts` for the monorepo

```typescript
// Source: verified via WebFetch of vitest.dev/guide/workspace.html this session
// vitest.workspace.ts is DEPRECATED since Vitest 3.2 -- do not create one; use `projects` instead.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["packages/*"],
  },
});
```

### GitHub Actions CI matrix (FND-02, D-29)

```yaml
# Source: step order verified via WebFetch of actions/setup-node README this session
# .github/workflows/ci.yml
name: CI
on: [push]
jobs:
  test:
    strategy:
      matrix:
        os: [ubuntu-latest, windows-latest]
        node: ['22.12.0', '24']
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v7
      - run: corepack enable pnpm         # MUST precede setup-node's cache:'pnpm' detection
      - uses: actions/setup-node@v7
        with:
          node-version: ${{ matrix.node }}
          cache: 'pnpm'
      - run: pnpm install --frozen-lockfile
      - run: pnpm -r typecheck
      - run: pnpm -r lint
      - run: node packages/spec/scripts/codegen.mjs --check
      - run: pnpm -r test
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| `vitest.workspace.ts` for monorepo test config | `projects: [...]` field inside root `vitest.config.ts` | Deprecated since Vitest 3.2, `[CITED: vitest.dev/guide/workspace.html]`, confirmed still current for 5.0.2 | Use `projects`, not a separate workspace file — a workspace file would still work today but is explicitly deprecated and may be removed. |
| esbuild-postinstall-based native binary fetching (Vite <7-era, older tsup/esbuild toolchains) | napi-rs prebuilt binaries shipped as platform-specific `optionalDependencies` (rolldown, lightningcss) | Confirmed via `npm view vite@8.3.1 dependencies` (no `esbuild` present) | Less exposure to pnpm 10's lifecycle-script blocking (Pitfall 3) for this specific toolchain generation — a genuine, verified improvement over the assumption in older tutorials. |
| pnpm dependency lifecycle scripts run automatically | Blocked by default since pnpm 10.0.0; explicit `pnpm.onlyBuiltDependencies` allowlist required | 2026 (Rspack supply-chain incident response) `[CITED: socket.dev/blog/pnpm-10-0-0-blocks-lifecycle-scripts-by-default]` | Not previously documented anywhere in this project's research; directly affects FND-01's "green build on a fresh clone" if a future dependency needs a build step and nobody runs `pnpm approve-builds`. |

**Deprecated/outdated:**
- `vitest.workspace.ts`: superseded by `projects` in `vitest.config.ts`, still functionally supported in 5.0.2 but flagged deprecated by Vitest's own docs.
- Treating a `postinstall` scan as sufficient for supply-chain safety in this toolchain generation: pnpm 10+'s default-block-then-allowlist model is the current baseline; a project that doesn't set `onlyBuiltDependencies` explicitly is relying on an implicit empty allowlist that could silently skip a future dependency's needed build step.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `canonicalize` (erdtman) is the right choice among JCS libraries versus e.g. `json-canonicalize`/`fast-json-canonicalize` (not comparatively evaluated this session, only the one D-01 names was inspected) | Standard Stack / Alternatives Considered | Low — `canonicalize` checked out clean on every axis inspected (license, deps, maintenance, README correctness); if a stronger alternative exists it would only matter for bundle size or a marginal RFC-8785 edge case, not correctness of the chosen library. |
| A2 | The recommended `sha256:` hash prefix spelling (Claude's Discretion per D-02) is the best choice versus `jcs-sha256:` | Code Examples / Pattern 4 | Low — D-02 explicitly leaves this to discretion as long as it names the scheme; either choice satisfies the requirement, this is a naming preference, not a correctness question. |
| A3 | GitHub Actions action versions (`actions/checkout@v7`, `actions/setup-node@v7`) reflect what a WebFetch of the setup-node README returned this session; these tags move forward over time and were not independently version-pinned against a changelog | Code Examples / CI matrix | Low — using a slightly older but still-supported major (e.g. `@v4`) would work identically for this pattern; verify the current major tag at implementation time rather than trusting this exact string indefinitely. |
| A4 | `jose`'s own thrown errors (e.g. from `flattenedVerify` on a bad signature) never embed key material in their message text — asserted defensively in Pattern 4's example code but not exhaustively tested against every jose error path this session | Code Examples / Pattern 4 | Medium — if wrong, an unhandled jose exception could leak into a log/error path; mitigated by the existing defensive `catch { return false }` wrapping in the example, but Phase 1's test suite should still include the "known secret never appears in an error" test class that PITFALLS.md's Pitfall 8 already calls for, scoped to the manifest-verification path specifically. |

## Open Questions

1. **Exact `spec/vectors/` file layout and naming convention**
   - What we know: D-25 requires valid/invalid manifests, a JCS input + expected hash, and a signed envelope, all consumed by both `spec/ALP.md`'s conformance section and Stint's own tests.
   - What's unclear: whether non-TypeScript implementers verifying against these vectors need a machine-readable index (e.g. a `manifest.json` listing each vector file + its expected outcome) or whether per-directory convention (as sketched in Recommended Project Structure) is sufficient.
   - Recommendation: start with the directory convention sketched above; add an index file only if a concrete non-TS conformance consumer materializes (none exists yet in v0.1's scope).

2. **Whether `@stint/core`/`@stint/proxy`/`@stint/cli` stub packages need `tsdown.config.ts` at all in this phase**
   - What we know: D-26 says "build" is part of the smoke-test bar for all four packages.
   - What's unclear: whether "build" for the three stub packages means `tsc -b` (project-references typecheck only) or an actual `tsdown` bundle producing a `dist/`.
   - Recommendation: give every package a minimal `tsdown.config.ts` from day one (near-zero cost per Pattern in Standard Stack, `defineConfig({ entry: ['./src/index.ts'] })`) so the build pipeline shape is uniform across all four packages before any of them have real logic — cheaper to establish now than to retrofit once `@stint/cli` needs a real `bin` shebang in Phase 6.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | Runtime floor (22.12+) | ✓ | v26.8.2 (local dev machine) | — well above floor; CI matrix still targets 22.12.0 + 24 explicitly, do not assume local Node version reflects CI |
| npm (for `npm view`/`npm pack` research only) | Registry verification | ✓ | 11.19.1 | — |
| git | Version control | ✓ | 2.55.0.windows.5 | — |
| pnpm (ad hoc local) | Package manager | ✓ | 10.34.5 (ad hoc; project pins 12.6.0 via Corepack `packageManager` field) | Corepack will resolve the pinned 12.6.0 on `pnpm install` regardless of what's ad hoc-installed globally — confirm this resolves correctly as an early Wave 0 smoke check. |
| GitHub Actions runners (`ubuntu-latest`, `windows-latest`) | CI (FND-02) | Not locally verifiable | — | None needed — these are hosted runners; verify the workflow by pushing, not locally. |

**Missing dependencies with no fallback:** none identified.
**Missing dependencies with fallback:** none blocking — the only ad hoc/pinned pnpm version mismatch resolves automatically via Corepack.

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest 5.0.2 + `@vitest/coverage-v8` 5.0.2 (peer: `vite` 8.3.1) |
| Config file | none yet — Wave 0 gap: create root `vitest.config.ts` with `projects: ['packages/*']` |
| Quick run command | `pnpm --filter @stint/spec test` |
| Full suite command | `pnpm -r test` (root script delegating to each package via the `projects` config) |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|--------------------|--------------|
| FND-01 | `pnpm install && pnpm test` green on a fresh clone, Node 22.12+ | smoke | `pnpm install && pnpm -r test` | ❌ Wave 0 |
| FND-02 | CI runs typecheck/lint/test on Linux + Windows per push | ci (verified by running the workflow, not a local unit test) | push to a branch / open a PR | ❌ Wave 0 (workflow file itself) |
| FND-03 | Apache-2.0 license present, `@stint/*` package names | unit | `vitest run packages/spec/test/license.test.ts` (assert `LICENSE` exists + each `package.json.license === "Apache-2.0"`, name starts with `@stint/`) | ❌ Wave 0 |
| SPEC-01 | `ALP.md` covers all required normative sections | manual-only, with a lightweight automatable smoke check | `node scripts/check-alp-sections.mjs` (grep for required `##` headers: States, Actors, Auth Modes, Teardown, Receipts, Trust Model, Trust Limits) — full prose correctness stays manual-only, justification: normative completeness/clarity needs human review, only header presence is mechanically checkable | ❌ Wave 0 |
| SPEC-02 | Valid manifest passes draft-07 schema | unit | `vitest run packages/spec/test/validate.test.ts -t "valid manifest"` | ❌ Wave 0 |
| SPEC-03 | Unknown scope/approval/verifier/auth-mode values rejected with structured errors | unit | `vitest run packages/spec/test/validate.test.ts -t "rejects unknown"` | ❌ Wave 0 |
| SPEC-04 | `auth.delegated` list; `auth.mode` defaults to `hybrid` | unit | `vitest run packages/spec/test/validate.test.ts -t "auth mode default"` | ❌ Wave 0 |
| SPEC-05 | Generated types import cleanly; stale codegen fails build | unit + ci | `vitest run packages/spec/test/types.test.ts` + `node packages/spec/scripts/codegen.mjs --check` | ❌ Wave 0 |
| SPEC-06 | Canonical hash stable under key-order/whitespace change; signature verified before consent, rejected if invalid | unit (golden fixture) | `vitest run packages/spec/test/canonical.test.ts -t "golden hash"` + `vitest run packages/spec/test/envelope.test.ts -t "rejects invalid signature"` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `pnpm --filter @stint/spec test`
- **Per wave merge:** `pnpm -r test` (full monorepo suite across all 4 packages)
- **Phase gate:** Full suite green (all 4 packages) + `codegen:check` clean + CI green on both OSes before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] Root `vitest.config.ts` with `projects: ['packages/*']` — no test framework config exists yet (greenfield)
- [ ] `vite@8.3.1` explicitly added to workspace-root devDependencies (peer of vitest, not transitive — see Pitfall 2)
- [ ] `packages/spec/test/` directory + fixtures: `validate.test.ts`, `canonical.test.ts`, `envelope.test.ts`, `types.test.ts`
- [ ] `spec/vectors/{valid,invalid,jcs,envelope}/` fixture files (D-25) — these are both spec conformance artifacts and Stint's own test fixtures
- [ ] `packages/spec/scripts/codegen.mjs` (codegen + `--check` diff mode)
- [ ] `packages/{core,proxy,cli}/` stub packages with one smoke test each (D-26)
- [ ] `.github/workflows/ci.yml` — no CI config exists yet
- [ ] `pnpm.onlyBuiltDependencies` decision recorded in root `package.json` (run `pnpm approve-builds` once — see Pitfall 3)

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-------------------|
| V1 Architecture, Design and Threat Modeling | yes | `spec/ALP.md`'s trust model + trust limits sections are exactly this category's deliverable for a spec-only phase — document the manifest-schema-is-not-authorization boundary explicitly (schema describes requested scope; runtime-owned bindings, built in Phase 2/4, are the actual enforcement — never let this phase's schema work be mistaken for enforcement). |
| V2 Authentication | no (this phase) | Not applicable yet — OAuth/license auth flows are Phase 3/4. Manifest signature verification (below) is closer to V6/V1 than V2 since there's no session/user auth here. |
| V3 Session Management | no (this phase) | No sessions exist yet. |
| V4 Access Control | no (this phase) | Enforcement is Phase 2 (policy engine) / Phase 4 (proxy); this phase only defines the data shape access decisions will later be made from. |
| V5 Input Validation | yes | `ajv` (draft-07, `allErrors: true`, strict mode) — every manifest field, closed enum vocabulary (`read\|write\|send\|pay`; `send\|pay\|irreversible`; `resource_query\|user_confirm\|none`; `delegated\|hosted\|hybrid`), verified live to reject out-of-vocabulary values with structured errors (see Pattern 2/3). |
| V6 Cryptography | yes | `canonicalize` (RFC 8785, no hand-rolled canonicalization) + `jose` (EdDSA/Ed25519, no hand-rolled signing) + `node:crypto` SHA-256 (no hand-rolled hashing) — "no hand-rolled crypto" constraint satisfied by construction; see Don't Hand-Roll table. |

### Known Threat Patterns for this phase's stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|----------------------|
| Manifest content altered after publisher signing (scope creep, cleanup-claim change, etc.) | Tampering | Content hash + detached EdDSA signature over canonical bytes, verified before consent is ever requested (SPEC-06); any post-signing edit changes the canonical bytes and breaks the signature. |
| Forged manifest claiming to be from a legitimate publisher | Spoofing | `kid`-scoped runtime trust store (D-05) resolves the public key independently of anything the envelope itself claims about identity beyond the `kid` lookup key; no key material or discovery URL ever travels inside the manifest/envelope. |
| Publisher denies having issued a manifest that caused harm | Repudiation | Asymmetric EdDSA signature is non-repudiable given key custody discipline (private key never leaves the publisher's signing process) — this phase only builds verification; key-custody operational practice is a publisher-side concern documented in `ALP.md`'s trust limits, not enforceable by the runtime. |
| Oversized or deeply-nested manifest JSON causing pathological `JSON.parse`/Ajv validation cost | Denial of Service | Not yet covered by any locked decision in `01-CONTEXT.md` — recommend the plan add an explicit byte-size cap on the raw envelope (checked before `JSON.parse`, not after) as a cheap, uncontroversial addition; flag as an open item for `/gsd-discuss-phase` follow-up or planner discretion if not already decided. |
| `oneOf` structural ambiguity silently accepted via a blind type assertion instead of runtime validation | Elevation of Privilege (a verifier claiming a weaker, less-scrutinized shape than intended) | Ajv as the actual gate, verified live to reject cross-branch field mixing (Pattern 3); never trust `as Manifest`/`as Verifier` on unvalidated input. |

## Sources

### Primary (HIGH confidence — verified this session via tool execution or direct source inspection)
- `npm view <pkg> version/engines/dependencies/scripts/peerDependencies` for every package named in this document, 2026-09-27
- `gsd_run query package-legitimacy check` — full audit table above
- `npm pack canonicalize@5.1.0` + direct read of `package.json`, `README.md`, `lib/canonicalize.d.ts`
- `npm pack jose@6.2.12` + direct read of `dist/types/jws/flattened/{sign,verify}.d.ts`, `dist/types/types.d.ts`, `dist/types/key/generate_key_pair.d.ts`
- Live-executed Ajv 8.20.0 schemas (patternProperties/additionalProperties passthrough, if/then conditional-required, oneOf+const discriminated union) — full script output captured this session
- Live-executed `json-schema-to-typescript@16.0.0` `compile()` calls against the same schemas — full generated TypeScript captured this session
- `node_modules/json-schema-to-typescript/package.json` read directly (confirms CJS, no `type: module`)

### Secondary (MEDIUM confidence — WebFetch of official docs, not independently re-verified by execution)
- `[CITED: https://tsdown.dev/guide/getting-started]` — minimal `tsdown.config.ts` shape
- `[CITED: https://vitest.dev/guide/workspace.html]` — `projects` field supersedes `vitest.workspace.ts` since 3.2
- `[CITED: https://github.com/actions/setup-node]` — `corepack enable pnpm` must precede `cache: 'pnpm'` in `setup-node`

### Tertiary (LOW confidence — WebSearch summaries, not fetched from a single authoritative page)
- pnpm 10+ lifecycle-script-blocking behavior and `onlyBuiltDependencies` remedy — cross-checked against `[CITED: https://socket.dev/blog/pnpm-10-0-0-blocks-lifecycle-scripts-by-default]` and `[CITED: https://github.com/pnpm/pnpm/security/advisories/GHSA-379q-355j-w6rj]`, corroborated by this session's own `npm view <pkg> scripts` findings showing no phase-1 dependency currently needs the allowlist.

### Project-level research consumed (already HIGH/MEDIUM-HIGH confidence per their own metadata)
- `.planning/research/STACK.md`, `ARCHITECTURE.md`, `PITFALLS.md`, `FEATURES.md`, `SUMMARY.md` — read in full; this document does not repeat their content, only extends it with phase-1-specific mechanics that were previously unverified.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — every version verified live against the npm registry this session; matches CLAUDE.md's pins exactly with no drift.
- Architecture: HIGH — reuses the already-HIGH-confidence project-level architecture research; this phase's additions (canonicalize/jose pipeline, Ajv strict-mode patterns) were verified by live execution, not assumed.
- Pitfalls: HIGH for the four new findings (Ajv strict mode, vitest/vite peer, pnpm 10 lifecycle scripts, patternProperties index signatures) — all verified live or via direct source inspection this session, not carried over from training data.

**Research date:** 2026-09-27
**Valid until:** 30 days (stable JSON Schema/RFC 8785/jose mechanics) — but re-verify package versions if planning is delayed past that window, given several packages in this stack (vitest, tsdown, typescript-eslint) release on a roughly weekly cadence.
