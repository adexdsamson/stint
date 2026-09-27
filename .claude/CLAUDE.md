<!-- GSD:project-start source:PROJECT.md -->

## Project

**Stint**

Stint is an open spec, the Agent Lease Protocol (ALP), plus a TypeScript SDK for the human-facing lifecycle of specialist AI agents: install, run a scoped job, and uninstall cleanly. It sits on top of MCP and OAuth 2.1 and fills the gap they leave out of scope: user consent, revocation, and uninstall. It serves two audiences equally: platform builders who host agent communities and embed the runtime with their own UX, and agent publishers who ship specialist agents with manifests, licenses and attested receipts.

The core mechanism is a lease runtime that runs as an MCP proxy between the agent and every system it touches. The agent never holds real credentials. Every tool call is checked against the lease by code outside the model, so a prompt-injected agent still cannot exceed its lease.

**Core Value:** A prompt-injected or misbehaving agent can never act outside the lease the user granted, and when the lease ends, for any reason, every credential is revoked and the teardown is honestly receipted.

### Constraints

- **Tech stack**: pnpm monorepo, TypeScript 5.9 strict, ESM-only, Node 22.12+ (dev/CI on Node 24 LTS; Node 20 is EOL), Vitest, tsdown. Cross-platform (developer is on Windows).
- **Libraries**: `@modelcontextprotocol/sdk` (MCP), `oauth4webapi` (OAuth client), `paseto` by panva (PASETO v4.public), `jose` (EdDSA checkpoint signatures), `ajv` (validation), `json-schema-to-typescript` (types), `oauth2-mock-server` (mock AS). `node:crypto` for hashing. No hand-rolled crypto.
- **Security**: deny by default; enforcement never delegated to the model; no secrets in logs or receipts; no credentials exposed to the agent; license never forwarded to customer resources.
- **Testing**: tests for every state transition, every teardown path including partial failure, and scope denial.
- **Access vocabulary**: fixed `read | write | send | pay`. No free-form scopes.
- **License**: Apache-2.0.

<!-- GSD:project-end -->

<!-- GSD:stack-start source:research/STACK.md -->

## Technology Stack

## Important: the "Node 20+" constraint in PROJECT.md needs to move to Node 22.12+

| Package | Latest major | Engines requirement |
|---|---|---|
| `vitest` | 5.0.2 | `^22.12.0 \|\| ^24.0.0 \|\| >=26.0.0` |
| `commander` | 15.0.0 | `>=22.12.0` |
| `oauth2-mock-server` | 9.2.0 | `^22.12 \|\| ^24 \|\| ^26` |
| `write-file-atomic` | 8.0.0 | `^22.22.2 \|\| ^24.15.0 \|\| >=26.0.0` |

## Recommended Stack

### Core Technologies

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| Node.js | 22.12+ (target 24 LTS) | Runtime | Node 20 is EOL as of April 2026; 22.12+ is the actual floor forced by `vitest`, `commander`, `write-file-atomic`, `oauth2-mock-server`. Node's native Web Crypto `Ed25519` support (needed by `paseto` and useful for `jose`) is solid on 22/24. |
| TypeScript | **5.9.3** (not 7.0) | Language/compiler | TS 7.0 GA'd 2026-07-08 as a Go-native rewrite (8–12x faster builds) but shipped **without a stable programmatic API** until 7.1, and `typescript-eslint`'s peer range is currently `>=4.8.4 <6.1.0` — it does not support TS 7 yet. Type-aware ESLint is non-negotiable for a strict-mode, security-sensitive codebase, so stay on the 5.x line until `typescript-eslint` ships TS7 support (watch for their v11). Re-evaluate at the next milestone. |
| pnpm | 12.6.0 | Monorepo package manager & workspaces | Current stable major; use via Corepack (`"packageManager": "pnpm@12.6.0"`) so CI and Windows dev machines resolve the identical binary. Workspace protocol (`workspace:*`) is the standard way to link `@stint/spec` → `@stint/core` → `@stint/proxy`/`@stint/cli` without publishing during v0.1. |
| Vitest | 5.0.2 | Test runner | Matches Vitest's own new Node floor (22.12+), so this is a non-issue once the engines bump above happens. Runs TS directly (via esbuild) with zero separate build step for tests — a real advantage for a monorepo with many small packages under active development. Pair with `@vitest/coverage-v8` (5.0.2) for coverage. |
| `@modelcontextprotocol/sdk` | 1.30.1 | MCP server + client (the proxy is both) | Official TypeScript SDK. `Server`/`McpServer` and `Client` classes are independent — the proxy instantiates one of each in the same process, wiring the server's tool calls to forward through the client. `registerTool()` accepts either a Zod raw shape **or a raw JSON Schema** (`inputSchema?: ZodRawShapeCompat | AnySchema`), so tool schemas can come straight from the Ajv-validated manifest/connector-binding schemas — no need to duplicate definitions in Zod. `engines.node >= 18` (irrelevant once you're on 22.12+ anyway). |

### Supporting Libraries

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `oauth4webapi` | 3.8.8 | OAuth 2.1 client: authorization code + PKCE, refresh, RFC 7009 revocation, RFC 8707 resource indicators | Use for every customer-facing delegated OAuth grant (`auth.delegated` connectors: Paystack, Sheets, etc. in the example). It is spec-strict (OAuth 2.1/FAPI 2.0 profile), supports `resource` parameters on the authorization and token endpoints (RFC 8707) and `revocationRequest()`/`processRevocationResponse()` (RFC 7009). Note: it does **not** ship as a dependency of the MCP SDK — the SDK has its own lightweight `OAuthClientProvider` interface for attaching bearer tokens to MCP transports. Implement a thin `OAuthClientProvider` adapter backed by `oauth4webapi` so the *same* token/refresh/revoke logic serves both MCP-transport auth and customer-resource auth. |
| `paseto` (panva) | 4.0.1 | PASETO v4.public sign/verify for publisher licenses | **Read carefully before using — see Sources/API note below.** v4.0.0 was published 2026-09-02 (three weeks before this research) as a complete, zero-dependency, Web-Crypto-backed rewrite of the library; the classic `V4.sign()/V4.verify()/V4.generateKey('public')` static-namespace API from the 3.x line is gone. The README's "Supported Versions" table states **only v4.x receives security fixes going forward** — 3.1.4 is unsupported, so upgrading past the old API is not optional if you want patches. |
| `jose` | 6.2.12 | Ed25519 (EdDSA) signatures for receipt-chain checkpoints | Use `jose.generateKeyPair('EdDSA', { crv: 'Ed25519' })` + `CompactSign`/`compactVerify` (or `FlattenedSign` for detached signatures over a checkpoint hash) to sign receipt-chain checkpoints. Keep this separate from `paseto` even though both can do Ed25519 — `jose` is for JOSE/JWS-shaped checkpoint signatures, `paseto` is for the license token format specifically. `type: module`, ESM-only. |
| `ajv` | 8.20.0 | JSON Schema validation | Validates the manifest against `spec/ALP.md`'s JSON Schema and validates connector-binding/tool-call payloads at runtime. Pin the manifest schema to **draft-07** (`$schema: "http://json-schema.org/draft-07/schema#"`), not 2020-12 — see Version Compatibility below for why. |
| `ajv-formats` | 3.0.1 | Format validators (date-time, uri, etc.) for Ajv 8 | Add wherever the manifest schema uses `format` keywords (timestamps, URIs in publisher metadata). |
| `json-schema-to-typescript` | 16.0.0 | Generate TS types from the manifest JSON Schema | Keeps `spec/ALP.md`'s schema as the single source of truth; TS types in `@stint/spec` are generated, never hand-written. CLI is `json2ts`. Confirmed support runs draft-04 through 2020-12 but with real gaps at the newer end (see Version Compatibility) — write the schema conservatively. |
| `oauth2-mock-server` | 9.2.0 | Mock OAuth 2.1 Authorization Server for tests | Dev/test-only. Spins up a real (loopback) AS with configurable issuer, JWKS, token/revocation endpoints — use it to test the full `oauth4webapi` flow (auth code + PKCE, refresh, revoke, `invalid_grant` handling for lazy revocation detection) end-to-end instead of mocking `fetch`. Requires Node `^22.12 \|\| ^24 \|\| ^26`, which is already your floor. |
| `commander` | 15.0.0 | CLI framework for `@stint/cli` | See "CLI framework" alternatives comparison below — commander wins on maturity, docs, and the exact subcommand shape this project needs (`stint create`, `stint inspect`, `stint revoke`, `stint cleanup`, `stint receipts`). Requires Node `>=22.12.0`. |
| `write-file-atomic` | **^7.0.1** (not latest 8.0.0) | Atomic writes for the JSON-file `LeaseStore` | Writes to a temp file then renames over the target — rename is atomic on NTFS as well as POSIX filesystems, which is exactly the cross-platform guarantee this project's Windows-developer constraint needs. **Pin 7.0.1, not the newer 8.0.0**: 8.0.0's engines (`^22.22.2 \|\| ^24.15.0 \|\| >=26.0.0`) are narrower than this project's 22.12+ floor and would force a patch-level Node bump on every dev machine and CI runner. 7.0.1 covers `^20.17.0 \|\| >=22.9.0`, comfortably inside the recommended floor. |
| `proper-lockfile` | 4.1.2 | Cross-process file locking (Windows-safe) | Last published 2021, but this is a narrow, stable primitive (mkdir-based locking + stale-lock detection via `retry`/`graceful-fs`), and mkdir-based locking is genuinely cross-platform (works identically on NTFS). Use it to guard the `LeaseStore`'s read-modify-write cycle when the CLI and a long-running proxy process might touch the same lease file concurrently. If avoiding a stale dependency matters more than convenience, the fallback is a ~15-line hand-rolled lock using `fs.mkdir(lockDir, { recursive: false })` as the atomic exclusive-create primitive (mkdir fails with `EEXIST` if another process holds the lock, on both POSIX and Windows) — `proper-lockfile` already does this correctly plus stale-lock cleanup, so prefer it unless a specific reason to avoid it comes up. |
| `node:crypto` | built-in | Hashing (receipt chain), general crypto | Use for SHA-256 chaining of receipts (`createHash('sha256')`) per the constraint "no hand-rolled crypto" — hashing isn't a place `paseto`/`jose` add value, `node:crypto` is the standard tool. |

### Development Tools

| Tool | Purpose | Notes |
|------|---------|-------|
| TypeScript project references | Cross-package type-checking without a build step | Set `"composite": true` in each package's `tsconfig.json`, reference downstream packages via `references`, run `tsc -b` for fast incremental type-checking. This is what makes editor go-to-definition and cross-package refactors work instantly across `@stint/spec → @stint/core → @stint/proxy/@stint/cli` without waiting on a bundler. |
| `tsdown` (not `tsup`) | Produces the actual runnable `dist/` output (e.g., the `@stint/cli` bin) | `tsup`'s own README now says "This project is not actively maintained anymore. Please consider using `tsdown` instead" (its last commit predates TS6 support). `tsdown` is the Rolldown-based, actively developed successor with an official tsup migration guide and native monorepo/workspace mode. Peer range `typescript: ^5.0.0 \|\| ^6.0.0 \|\| ^7.0.0` — safe with the recommended TS 5.9.3 pin, and forward-compatible once TS7 tooling catches up. |
| `tsx` | Dev-time TS execution (running the CLI/proxy without a build) | Simpler and more portable across the Node 22–26 range than Node's native `--experimental-strip-types` flag (unflagged only on Node 23.6+ and not needed as a Windows-friendly default here). |
| ESLint 9 + `typescript-eslint` 10.11.0 | Linting, type-aware rules | Confirms the TS 5.9.3 pin above (peer range `typescript: '>=4.8.4 <6.1.0'`). Flat config (`eslint.config.ts`) is standard for ESLint 9 in 2026. |
| Prettier | 3.9.9 | Formatting | Standard; `json-schema-to-typescript` already uses Prettier internally for its generated output, so formatting stays consistent. |
| `@vitest/coverage-v8` | 5.0.2 | Coverage | Matches Vitest major; no separate config needed beyond `test.coverage.provider: 'v8'`. |

## Installation

# Core runtime deps (spread across packages as appropriate)

# Dev dependencies (workspace root)

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|--------------------------|
| `ajv` + `json-schema-to-typescript` | TypeBox (0.34.52) | TypeBox is excellent when TypeScript is the source of truth and you derive JSON Schema from code. Wrong direction for this project: `spec/ALP.md`'s manifest schema must be a normative, language-agnostic artifact publishers can implement against without touching TypeScript, so the JSON Schema file has to be canonical and TS types generated from it — exactly `ajv` + `json-schema-to-typescript`'s model. Already the right call per PROJECT.md's constraints; confirmed, not overridden. |
| `commander` (15.0.0) | `citty` (0.2.2, UnJS) | `citty` is fine for small, single-purpose CLIs and is actively maintained, but it's still pre-1.0 after 4 years and has a thinner feature set (auto-generated help, nested subcommands work but are less battle-tested at `@stint/cli`'s scale: `create`/`inspect`/`revoke`/`cleanup`/`receipts` each with their own flags). Reach for `citty` only if the CLI stays extremely minimal. |
| `commander` (15.0.0) | `clipanion` (4.0.0-rc.4) | Avoid for this project: still shipping release candidates after 2+ years (last publish 2024-09, no movement toward stable 4.0.0 since), a real maintenance-risk signal despite being battle-tested inside Yarn. |
| `tsdown` | `tsup` | Don't pick `tsup` for a new project in 2026 — its own maintainers point users to `tsdown`. Only relevant if an existing codebase is already on `tsup` and migration cost isn't justified yet. |
| TypeScript 5.9.3 | TypeScript 7.0.2 | Revisit once `typescript-eslint` publishes a version supporting TS7 (their peer range is currently capped `<6.1.0`) and TS7.1 ships the stable programmatic API. The 8–12x build speedup is real and worth adopting — just not before the lint toolchain supports it. |
| `write-file-atomic@7.0.1` | `write-file-atomic@8.0.0` | Use 8.x once the team standardizes on Node 22.22.2+/24.15+/26+ specifically (not just 22.12+) — 8.0.0 has no functional advantage here, it's purely a Node-floor bump. |
| `proper-lockfile` | hand-rolled `fs.mkdir` lock | If the 2021-vintage dependency is a blocker (e.g., an internal policy against unmaintained deps), a small in-house lock using `mkdir(dir, { recursive: false })` for mutual exclusion plus a PID/timestamp file for staleness detection covers the same ground with no dependency risk, at the cost of writing and testing it yourself. |

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|--------------|
| `paseto@3.x` (the classic `V4.sign/V4.verify` API) | The README's own "Supported Versions" table shows only v4.x gets security fixes; 3.1.4 (last published April 2023) is now unsupported upstream. | `paseto@4.0.1`'s factory-composition API (`PublicProtocol`, `GenerateKeyPairFactory`, `SignFactory`, `VerifyFactory`) — different shape, same PASETO v4.public wire format. |
| JSON Schema draft 2020-12 for the manifest schema | `json-schema-to-typescript` only partially supports 2020-12: `prefixItems`, `$dynamicRef`, `unevaluatedItems`, `dependentSchemas`, `dependentRequired` are unsupported/partial, and `$id`-based `$ref` resolution doesn't work for 2019-09/2020-12 schemas at all. | Draft-07 (`$schema: "http://json-schema.org/draft-07/schema#"`) for the manifest — fully supported by both `ajv` (default export) and `json-schema-to-typescript`. |
| Relying on generated TS types to enforce `oneOf` exclusivity | `json-schema-to-typescript` explicitly treats `oneOf` the same as `anyOf` (no exclusive-or semantics), while `ajv` *does* enforce true `oneOf` exclusivity at runtime. A schema using `oneOf` for e.g. mutually-exclusive verifier types will type-check permissively even for invalid combinations the generated types don't rule out. | Keep `ajv` as the actual gate at runtime; don't trust the generated types alone for `oneOf`-shaped invariants — add a unit test asserting Ajv rejects the invalid combination. |
| `tsup` for new build tooling | Unmaintained per its own README, blocks TypeScript 6+ users, last commit predates this research by months. | `tsdown`. |
| `clipanion` | Stuck on release candidates for 2+ years with no forward motion toward a stable 4.0. | `commander`. |
| Node 20.x anywhere in the stack | EOL 2026-04-30; `vitest@5`, `commander@15`, `oauth2-mock-server@9`, and `write-file-atomic@8` already refuse to install on it. | Node 22.12+ (recommend Node 24 LTS for new dev machines/CI). |
| `@types/node@26` (latest) paired with a Node 22 or 24 runtime | Type/runtime skew — `@types/node` majors track Node majors; using the newest types against an older runtime risks typing APIs that don't exist yet in your actual `process.version`. | Match `@types/node`'s major to the Node major you actually run (`@types/node@22` for Node 22, `@types/node@24` for Node 24). |

## Stack Patterns by Variant

- Skip dual CJS+ESM output entirely — ESM-only (`"type": "module"` everywhere) is sufficient, since every dependency in this stack (`@modelcontextprotocol/sdk`, `oauth4webapi`, `jose`, `paseto`, `commander`, `vitest`) is itself ESM-only (`"type": "module"` confirmed via `npm view`). Fighting for CJS interop would be pure overhead.
- `tsdown` still earns its place even pre-publish: it's what turns `@stint/cli`'s TS source into an actual runnable `bin` script with a shebang, which `tsc -b` alone does not conveniently produce.
- Add `tsdown`'s `dts` output and `publint`/`@arethetypeswrong/core` checks (already in `tsdown`'s peer deps) before the first publish, to catch ESM/exports-map mistakes that break downstream consumers.
- `write-file-atomic`'s rename-based atomicity and `proper-lockfile`'s mkdir-based locking were both chosen specifically because they avoid POSIX-only primitives (`flock`, hard links) that don't translate cleanly to NTFS. Avoid any library that shells out to `flock(1)` or relies on POSIX advisory locks (e.g., raw `fs-ext`) for the `LeaseStore`.
- Vitest, pnpm, and tsx all run natively on Windows without WSL; no reason to require a POSIX shell for this stack.

## Version Compatibility

| Package A | Compatible With | Notes |
|-----------|------------------|-------|
| `typescript@5.9.3` | `typescript-eslint@10.11.0` peer range `>=4.8.4 <6.1.0` | This is the binding constraint that keeps TS at 5.x for now. |
| `typescript@^5.0.0 \|\| ^6.0.0 \|\| ^7.0.0` | `tsdown@0.23.0` peer range | `tsdown` itself is already forward-compatible with TS7; the blocker is `typescript-eslint`, not the build tool. |
| `vitest@5.0.2` | `node engines: ^22.12.0 \|\| ^24.0.0 \|\| >=26.0.0` | Confirms the Node 22.12+ floor recommended above; do not fall back to vitest 4.x purely to support Node 20 — Node 20 is EOL regardless. |
| `write-file-atomic@7.0.1` | `node engines: ^20.17.0 \|\| >=22.9.0` | Chosen over 8.0.0 specifically for the wider floor — see "What NOT to Use." |
| `ajv@8.20.0` manifest schema | draft-07 only (not 2020-12) | Forced by `json-schema-to-typescript@16.0.0`'s partial 2020-12 support — see "What NOT to Use." |
| `@modelcontextprotocol/sdk@1.30.1` | ships its own `zod@^3.25 \|\| ^4.0`, `ajv@^8.17.1`, `jose@^6.1.3` as transitive deps | No conflict with the project's own `ajv`/`jose` pins above (8.20.0 / 6.2.12 both satisfy the SDK's ranges); pnpm will dedupe them in the workspace. |
| `paseto@4.0.1` | zero dependencies, Web Crypto-based | No version-compatibility surface to track (no deps), but the API is 3 weeks old — pin the exact version (`"paseto": "4.0.1"`, not `^4.0.1`) until it has more field exposure, and bump deliberately. |

## Sources

- `npm view <pkg> version / engines / time / dependencies` for every package above (direct registry queries, 2026-09-27) — HIGH confidence.
- `panva/paseto` v4.0.1 tarball inspected directly (`npm pack paseto@4.0.1`) — README, `v4/public.ts` source, and `v4/public.d.ts` read in full to confirm the factory-composition API (`PublicProtocol`, `GenerateKeyPairFactory`, `SignFactory`, `VerifyFactory`) since the classic `V4.sign/verify` API from 3.x is gone in 4.x. HIGH confidence on the API shape (read directly from source); MEDIUM confidence on production-readiness given the 3-week-old release.
- `@modelcontextprotocol/sdk` v1.30.1 tarball inspected directly for `server/mcp.d.ts` (`registerTool` accepting `AnySchema` alongside Zod) and `client/streamableHttp.d.ts` (`OAuthClientProvider` on the transport) — HIGH confidence, read from shipped `.d.ts` files.
- `oauth4webapi` v3.8.8 tarball's README skimmed for feature coverage (PKCE, introspection/revocation, resource discovery) — MEDIUM confidence on RFC 8707/7009 specifics since the README is a feature list, not full API docs; the package is well-known and widely used for exactly this profile (OAuth 2.1/FAPI 2.0).
- WebSearch: "TypeScript 7 native compiler release GA tsgo status" — confirmed TS7.0 GA'd 2026-07-08, ships without stable programmatic API until 7.1.
- WebSearch: "Node.js LTS schedule 2026" — confirmed Node 20 EOL 2026-04-30, Node 22 in Maintenance LTS (EOL 2027-04-30), Node 24 in Active LTS (EOL 2028-04-30).
- WebSearch: "tsup maintenance mode recommend tsdown" — confirmed tsup's README now points to tsdown.
- `json-schema-to-typescript` README fetched directly — confirmed draft-04 through 2020-12 "supported" but with real gaps (`prefixItems`, `$dynamicRef`, `unevaluatedItems`, `dependentSchemas`, `dependentRequired` unsupported/partial; `$id`-based `$ref` resolution unsupported for 2019-09/2020-12; `oneOf` treated as `anyOf`).

<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->

## Conventions

Conventions not yet established. Will populate as patterns emerge during development.
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->

## Architecture

Architecture not yet mapped. Follow existing patterns found in the codebase.
<!-- GSD:architecture-end -->

<!-- GSD:skills-start source:skills/ -->

## Project Skills

No project skills found. Add skills to any of: `.claude/skills/`, `.agents/skills/`, `.cursor/skills/`, `.github/skills/`, or `.codex/skills/` with a `SKILL.md` index file.
<!-- GSD:skills-end -->

<!-- GSD:workflow-start source:GSD defaults -->

## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:

- `/gsd-quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd-debug` for investigation and bug fixing
- `/gsd-execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->

<!-- GSD:profile-start -->

## Developer Profile

> Profile not yet configured. Run `/gsd-profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
