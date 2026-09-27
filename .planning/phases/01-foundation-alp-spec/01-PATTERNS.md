# Phase 1: Foundation & ALP Spec - Pattern Map

**Mapped:** 2026-09-27
**Files analyzed:** 20 (new files, greenfield)
**Analogs found:** 0 / 20 (no in-repo analogs exist — see note)

## Greenfield Note

`git ls-files` confirms the only tracked paths in this repo are under `.planning/` and `.claude/`. There is no application source code, no prior package, no prior schema — nothing to copy an analog pattern *from* inside this repo. Every file below has **no in-repo analog**. Do not invent one. Instead, each row points directly at the concrete, live-verified code in `01-RESEARCH.md` that the planner and executor should copy from — those snippets were compiled/executed against the pinned library versions this session (not assumed from memory), so they are the closest thing to "tested analog code" available for this phase.

## File Classification

| New File | Role | Data Flow | Analog | Source of Pattern |
|----------|------|-----------|--------|--------------------|
| `pnpm-workspace.yaml`, root `package.json`, `tsconfig.json` | config | batch (build graph) | none | RESEARCH.md "Recommended Project Structure" (lines ~166-203) |
| `.github/workflows/ci.yml` | config | event-driven (CI trigger) | none | RESEARCH.md "GitHub Actions CI matrix" code block |
| `LICENSE` | config | — | none | Apache-2.0 boilerplate (external, not in RESEARCH.md) |
| `spec/ALP.md` | doc (normative spec) | — | none | CONTEXT.md D-20..D-25; structure only, prose is original |
| `spec/manifest.schema.json` | config (JSON Schema) | transform/validation | none | RESEARCH.md Pattern 1, 2, 3 (Ajv strict-mode conditionals, `x-` passthrough, `oneOf`+`const` union) |
| `spec/vectors/valid/*.json`, `spec/vectors/invalid/*.json` | test fixture | transform | none | CONTEXT.md D-25, D-32; shape mirrors schema |
| `spec/vectors/jcs/input.json` + `expected-hash.txt` | test fixture | transform | none | RESEARCH.md Pattern 4 (canonicalize→hash pipeline) |
| `spec/vectors/envelope/signed-envelope.json` + `public-key.json` | test fixture | transform | none | RESEARCH.md Pattern 4 (sign/verify pipeline) |
| `packages/spec/src/generated/manifest.ts` | model (generated) | transform | none | RESEARCH.md "`codegen:check` script pattern" |
| `packages/spec/src/validate.ts` | service (validator) | transform/request-response | none | RESEARCH.md Pattern 1, 2, 3 + D-31 error-mapper contract |
| `packages/spec/src/canonical.ts` | utility | transform | none | RESEARCH.md Pattern 4, `hashManifest` code block |
| `packages/spec/src/envelope.ts` | service | transform/request-response | none | RESEARCH.md Pattern 4, `signEnvelope`/`verifyEnvelopeSignature` code block |
| `packages/spec/src/index.ts` | barrel/entry | — | none | Standard ESM barrel re-export; no library-specific pattern needed |
| `packages/spec/testing/sign-for-test.ts` | test utility | transform | none | RESEARCH.md Pattern 4 (`FlattenedSign` w/ `extractable: true` keypair); CONTEXT.md D-07 |
| `packages/spec/scripts/codegen.mjs` | utility (build script) | file-I/O | none | RESEARCH.md "`codegen:check` script pattern" (full code block) |
| `packages/spec/tsconfig.json`, `tsdown.config.ts`, `package.json` | config | — | none | RESEARCH.md project structure + `tsdown` minimal config note |
| `packages/{core,proxy,cli}/*` (stub packages) | service/controller/route stubs | — | none | CONTEXT.md D-26: TS refs + build + one smoke test each; no logic yet |
| `packages/spec/test/{validate,canonical,envelope,types}.test.ts` | test | request-response/transform | none | RESEARCH.md "Validation Architecture" Req→Test map (exact `-t` filter names given per requirement) |
| `vitest.config.ts` (root) | config | — | none | RESEARCH.md "Root `vitest.config.ts` for the monorepo" code block |
| `scripts/check-alp-sections.mjs` | utility | file-I/O | none | RESEARCH.md SPEC-01 test-map row (header-presence grep) |

## Pattern Assignments

### `spec/manifest.schema.json`

**No analog — copy directly from RESEARCH.md Patterns 1–3** (all three are live-executed against `ajv@8.20.0` / `json-schema-to-typescript@16.0.0`, not documentation guesses):

- **Conditional-required stub pattern** (D-15 spend-requires-pay, D-17 auth-mode conditionals): RESEARCH.md Pattern 1 code block — note the mandatory `properties: { spend: {} }` stub inside every `then` block, and explicit `type: "array"` inside every `if` block that uses `contains`. Omitting either throws at `ajv.compile()` time, not validation time.
- **`x-` passthrough** (D-12): RESEARCH.md Pattern 2 — `patternProperties: { "^x-": {} }` + `additionalProperties: false`. Note the generated TS will carry `[k: string]: unknown` on every such node regardless — document this next to `validate.ts` per Pitfall 4.
- **Verifier tagged union** (D-18): RESEARCH.md Pattern 3 — `oneOf` + `const` discriminator; each branch needs its own `additionalProperties: false` to prevent cross-branch field mixing.

### `packages/spec/src/canonical.ts` / `envelope.ts`

**No analog — copy directly from RESEARCH.md Pattern 4's executable code block** (`hashManifest`, `signEnvelope`, `verifyEnvelopeSignature`), including:
- The `canonicalize()` `string | undefined` guard (throw, never silently hash `"undefined"`).
- The single shared `JWS_PROTECTED_HEADER` constant — RESEARCH.md Pitfall 5 explicitly warns against re-literal-ing this object at more than one call site; grep for `b64.*false` before merging to confirm only one occurrence exists.
- `kid` lives only in Stint's envelope field, never inside the JWS header itself (D-04 shape lock).

### `packages/spec/src/validate.ts`

**No analog — pattern from D-31 + RESEARCH.md Pattern 3's error-mapper rule:** collapse Ajv's raw multi-branch `oneOf` errors (verified: 5+ raw entries for one bad verifier) into one `{ path, code, message, allowed? }` using `instancePath: "/type"` to identify the intended branch. Ajv error objects must never leak through the public API.

### `packages/spec/scripts/codegen.mjs`

**No analog — copy directly from RESEARCH.md's "`codegen:check` script pattern"** code block verbatim (uses `json-schema-to-typescript`'s programmatic `compile()`, not the CLI).

### Root config files (`vitest.config.ts`, `.github/workflows/ci.yml`)

**No analog — copy directly from RESEARCH.md's corresponding code blocks.** Key gotchas baked into those blocks: use `projects: ['packages/*']` (not the deprecated `vitest.workspace.ts`), and add `vite@8.3.1` explicitly to root devDependencies (Pitfall 2 — vitest 5 only peer-depends on vite).

## Shared Patterns

### Canonicalization is the single source of truth for hashing AND signing
**Source:** RESEARCH.md Pattern 4
**Apply to:** `canonical.ts`, `envelope.ts`, `packages/spec/testing/sign-for-test.ts`, and (per D-28) every future Phase 3 receipt-chain module.
One function (`hashManifest`) and one shared header constant (`JWS_PROTECTED_HEADER`) — never reimplemented per call site.

### Ajv is the real gate; generated types are not
**Source:** RESEARCH.md Pattern 2/3, Pitfall 4
**Apply to:** `validate.ts`, and every later phase that ingests a manifest — `JSON.parse(raw) as Manifest` without calling `validateManifest` first is the anti-pattern explicitly called out in RESEARCH.md.

### Strict-mode-safe `if`/`then` conditionals
**Source:** RESEARCH.md Pattern 1, Pitfall 1
**Apply to:** `spec/manifest.schema.json` — any conditional-required rule (D-15, D-17) needs the stub-properties idiom or `ajv.compile()` throws at build time, failing CI's `codegen:check`/lint step, not just a test.

## No Analog Found

All 20 files above have no in-repo analog (greenfield repo, confirmed via `git ls-files`). The planner should treat RESEARCH.md's Patterns 1–4 and its verbatim code blocks (codegen script, CI workflow, vitest config) as the canonical "copy from" source for this phase, in place of codebase analogs.

## Metadata

**Analog search scope:** entire repo (`git ls-files`) — 0 source files found outside `.planning/` and `.claude/`.
**Files scanned:** repo-wide `git ls-files` (confirms greenfield state).
**Pattern extraction date:** 2026-09-27
