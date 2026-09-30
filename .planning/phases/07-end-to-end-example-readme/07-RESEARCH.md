# Phase 7: End-to-End Example & README - Research

**Researched:** 2026-09-30
**Domain:** Integration proof of the Stint lease runtime (hybrid auth: OAuth auth-code+PKCE, PASETO license custody, MCP stdio, Windows console topology), cross-platform e2e CI, and onboarding docs
**Confidence:** MEDIUM-HIGH (HTTP/OAuth/SDK mechanics VERIFIED by experiment this session; four in-repo wiring gaps found by reading source are design recommendations, tagged where assumed)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
(Copied verbatim from 07-CONTEXT.md `## Implementation Decisions`)

- **D-01:** `examples/payment-reconciler` is its own workspace package. The "agent" is a **real MCP `Client`** (`@modelcontextprotocol/sdk`) stub that issues a **deterministic scripted sequence** of `tools/call`s designed to hit each E2E-02 scenario (a scoped read, a scoped write, an out-of-scope call → deny, a `send`/`pay`-class call → approval). It holds **no credentials and never sees the license** — everything flows through the proxy. Base its manifest on `spec/vectors/valid/payment-reconciler.json`.
- **D-02:** **Automated e2e drives the full real stack** — real `createLeaseProxyServer`, JSON `LeaseStore`/receipt store, mock AS, mock publisher, mock customer services — but wires a **scripted test `HostAdapter`** so approve / deny / `user_confirm` / revoke are **deterministic and tty-free** on both OSes. This is what lets E2E-02 pass on Windows + Linux CI without a real terminal. — **Reversibility:** costly — this harness is the E2E-02 proof surface; the test suite and the example's public shape depend on it.
- **D-03:** Add an **automated smoke test that spawns the built `stint run` binary** over MCP stdio (a `tools/list` + one call), proving the shipped CLI + transport wiring boots end to end. Approvals there are limited to **deny-by-timeout** (no tty in CI); the approve/deny/revoke *decisions* are proven by D-02's harness. Catches `bin`/build/transport regressions the in-process harness can't.
- **D-04:** The example e2e runs as a **dedicated vitest project / CI step** that **starts and stops the mock servers in its own process**, separate from the unit suites, on **Linux and Windows**. Keeps runs scoped (aligns with the repo's known full-repo OOM behavior) and gives a distinct e2e signal. — **Reversibility:** costly — the CI wiring + project split is what makes the Windows/Linux e2e gate real; changing it reshapes CI and the test entrypoints.
- **D-05:** The example performs a **real auth-code + PKCE grant acquisition and vault refresh against `oauth2-mock-server`** (reuse `@stint/proxy/testing`'s `startMockAuthServer`/`MockAuthHarness`), closing Phase 6's deferred acquisition and genuinely exercising PRXY-06/08 and LIFE-05. "reads mocked Paystack **through OAuth**" becomes literally true. — **Reversibility:** costly — introduces the acquisition flow the run path did not previously have.
- **D-06:** Paystack-read and orders-sheet-write are **local `127.0.0.1` HTTP mocks** hit through the real `createRestOutboundConnector` with proxy-injected tokens (hermetic on CI, real socket, verifies no-secret-leak on a real outbound request). — **Reversibility:** reversible.
- **D-07:** A **mock publisher HTTP server** issues a **PASETO v4.public** license at activation; the **runtime obtains it and refreshes before TTL, never beyond lease expiry, never forwarding it to the agent or customer resources** (LIC-01/02/03/05). This **wires license issuance + custody into the run path** and closes Phase 6 A8. The runtime keeps using the **injected `LicenseIssuer` port** (`issueLicense`/`createMockLicenseIssuer` are intentionally not re-exported from `@stint/core`). — **Reversibility:** costly — adds per-run license custody and changes the create/run hybrid-mode gating Phase 6 stubbed out.
- **D-08:** `examples/payment-reconciler` ships a **host launcher** that spawns `stint run` with a **visible console (`windowsHide: false`)** — via a custom stdio transport / child spawn, as `packages/cli/manual/mcp-call-visible.mjs` proved — so approval prompts render where the user can see and answer them. The **controlling-terminal topology is kept** (Phase 6 06-06); only the host-spawn side changes. The launcher uses the existing `RunSeams` (`createTransport`/`openTerminal`) where it fits. — **Reversibility:** costly — this launcher is the SC1/DOC-01 Windows-correctness surface the quickstart depends on.
- **D-09:** Regression guard is **automated + manual**: an automated test asserts the launcher spawns with `windowsHide: false` (and a unit test that a *hidden*-console spawn denies by timeout, pinning the guard's direction and the fail-safe property); `packages/cli/manual/` is **retained** as the human real-console check. — **Reversibility:** reversible.
- **D-10:** The **partial-teardown-failure** scenario is induced by the **mock publisher's cleanup-hook endpoint returning an error**: the cleanup-hook step fails while revoke-OAuth and invalidate-license succeed → `cleanup_incomplete` with every step's result recorded; the **retry** (hook now succeeds) reaches `cleaned_up` (TEAR-04, idempotent, never returns to active). — **Reversibility:** reversible.
- **D-11:** The **verbatim quickstart is one wrapped command** (e.g. `pnpm example:payment-reconciler`) that starts the mocks + host + agent and prints the result; the README then **documents the individual `stint create/run/revoke/cleanup/receipts` lifecycle** for understanding. Maximizes "works as written" cross-platform while still teaching the CLI. — **Reversibility:** reversible.
- **D-12:** The demo/quickstart's success signal is the **merged `stint receipts` timeline** (verified/attested, ending in the terminal state) **plus a one-line summary** — surfacing the honest audit trail (the product's whole point) and doubling as the CLI-02 demo. — **Reversibility:** reversible.
- **D-13:** The README covers, in order: the **problem** MCP/OAuth leave open, the **three auth modes** (`delegated | hosted | hybrid`), the **trust limits of hosted mode** (spec §13), and the **quickstart**. — **Reversibility:** reversible.

### Claude's Discretion
- The exact agent call script (concrete tool names/args) provided each E2E-02 scenario is deterministically triggered.
- The mock-server implementation choice (plain `node:http` vs a tiny helper) provided it binds `127.0.0.1` and is hermetic on CI.
- File/module layout under `examples/payment-reconciler`, the exact wrapper-script name, and README section wording/structure.
- **How** the license-issuance and OAuth-acquisition seams are surfaced on `create`/`run` (e.g. a publisher/AS endpoint in the run profile vs a flag) provided the never-to-agent / never-to-customer and LIC-01/02/03/05 bounds hold and hybrid `create` no longer refuses as in Phase 6.
- Exact exit/reporting wording of the e2e assertions.

### Deferred Ideas (OUT OF SCOPE)
- Real Paystack/Sheets integrations and real `pay` execution — out of scope (mocked only, REQUIREMENTS Out of Scope).
- npm publishing / release pipeline — post-v0.1 (ECO-V2-01).
- Additional example agents (send-only, write-only) and an embeddable receipt-timeline UI — v2 (ECO-V2-02/03).
- Reconsidering the `spawn-child` run transport topology as a general Windows default — not needed once the example launcher spawns visible-console; revisit only if a host cannot provide a visible console.
- Driving the automated e2e through a real pty — rejected for CI (node-pty Windows flakiness); the human real-console path is covered by `packages/cli/manual/` (D-09).
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| E2E-01 | `examples/payment-reconciler` runs in hybrid mode: licensed by a mock publisher, reads mocked Paystack transactions via OAuth, writes to a mocked orders sheet | Headless auth-code+PKCE against the pinned mock AS is proven (Code Examples 1); identifier-to-URL fetch mapping is the only way the real REST connector reaches 127.0.0.1 mocks (Pitfall 3); PASETO mock publisher via a vitest-free reference issuer (Pattern 3, Pitfall 5); four run/create/teardown wiring gaps enumerated (Summary, Pitfalls 1-4) |
| E2E-02 | E2E covers happy path to `cleaned_up`, a denied out-of-scope call, an approval, user revoke mid-run, partial teardown failure | Scenario-to-signal map and determinism rules in Validation Architecture; dedicated vitest package + CI step (Pattern 5); cleanup-hook failure injection and idempotent retry (Pattern 6) |
| DOC-01 | README explains the problem, the three auth modes, hosted-mode trust limits and a quickstart using the example agent that works as written | Quickstart topology and non-interactive handling (Pattern 7, Pitfall 9); `pnpm install` + `pnpm build` + one wrapped command; README-drift test; spec sections to cite (§8 auth modes, §13 trust limits) |
</phase_requirements>

## Summary

Phase 7 is almost entirely integration glue over shipped contracts, but reading the source shows the shipped run/create/teardown path is further from "hybrid works end to end" than CONTEXT assumes. The OAuth half is fully feasible with pinned deps: `oauth2-mock-server@9.2.0`'s `/authorize` has no login UI and answers with an immediate 302 carrying `code` and `state`, so a headless acquisition is `fetch(authorizeUrl, {redirect:"manual"})` then `oauth.validateAuthResponse` then `authorizationCodeGrantRequest` with a PKCE verifier. I ran this end to end this session, including a refresh and an RFC 7009 revoke against a hand-built AS object identical to what the run profile builds [VERIFIED: scratch experiment on Node 26.8.2]. The resulting `{accessToken, refreshToken, expiry, tokenEndpoint, resourceIndicator, clientId, revocationEndpoint}` is exactly the existing `--credentials` file shape, so acquisition can live in the example (the host's consent UX) and needs no new CLI verb.

The license half needs real code. There is no production per-lease license custody, no per-call license refresh, and no way for the runtime to wrap a token received from a remote publisher into a `HeldLicense` (`mintHeldLicense` is not exported from `@stint/core`). `@stint/core/testing` has the mock issuer but imports `vitest` at module top, so a quickstart runtime must not import it. Teardown step 2 (`invalidate_license`) is currently a happy-path placeholder for every CLI teardown (`createDefaultTeardownSteps(..., vault, undefined, cleanup)`), which would receipt a false `ok` for a hybrid lease. Four latent Phase-6 gaps must also be fixed or hybrid silently mis-behaves: `run`/`revoke`/`cleanup` treat only `delegated` as "has OAuth grants" (hybrid is skipped), `runLease` never sets `allowInsecureRequests` on its vault (refresh against an `http://localhost` mock AS throws), `runLease` passes no `teardownSteps`, and the REST connector uses `binding.resource` **as the request URL** while manifest scopes use identifiers like `paystack.transactions`.

For Windows, the SDK's `StdioClientTransport` hard-codes `windowsHide: process.platform === 'win32'` with no override option, so the launcher must be a small custom `Transport` over `child_process.spawn` with `windowsHide:false`, exactly as `manual/mcp-call-visible.mjs` does, but with an injectable `spawn` so a unit test can assert the option. The e2e lives in a separate workspace package (`examples/payment-reconciler`) that root `vitest.config.ts` (`projects: ["packages/*"]`) does not pick up, which gives D-04's separation for free; CI gets one added `pnpm test:e2e` step on the existing ubuntu/windows x Node 22.18/24 matrix.

**Primary recommendation:** Build a single composition point (extend `runLease`) that owns license custody + per-call refresh, loopback-gated insecure OAuth, real teardown steps, and identifier-to-endpoint mapping; export it (plus `createRealDeps`) additively from `@stint/cli`; have the in-process e2e harness and the spawned `stint run` share it; keep acquisition, mock servers, launcher and the scripted agent inside `examples/payment-reconciler`; add a vitest-free reference license issuer subpath to `@stint/core`; and surface the four wiring gaps to the user before planning (Open Questions 1-3).

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Tool-call enforcement (deny/approve/allow) | Proxy (`@stint/proxy`, outside model) | Core policy | Already shipped; the example only drives it. Never re-implemented in example |
| OAuth grant acquisition (auth-code+PKCE) | Example / host UX (`examples/`) | `@stint/proxy/testing` mock AS | Consent UX belongs to the platform that embeds the runtime; output is the existing credentials file |
| OAuth refresh + revoke | Proxy vault (`createCredentialVault`) | CLI run/teardown wiring | Existing vault owns token custody; CLI only must pass `allowInsecureRequests` for loopback AS |
| License issue/reissue/invalidate | Publisher (mock HTTP server in example) | Runtime-side issuer client (core reference + CLI HTTP port) | Publisher signs; runtime verifies offline (LIC-02) then holds; agent/customer never see it |
| License custody + per-call refresh | CLI/runtime composition (`runLease`) | Core `needsRefresh`/`clampedLicenseExpiry` | Pure decision functions exist in core; custody object is new runtime glue |
| Customer-resource calls (Paystack/Sheets mocks) | Example mock servers (127.0.0.1) | Real `createRestOutboundConnector` | Real socket, real header injection; identifier-to-URL mapping lives in injected `fetch` |
| Approval prompts on Windows | Host launcher (visible console spawn) | `openControllingTerminal` (unchanged) | Only host-spawn side changes (locked) |
| Teardown incl. cleanup hook + failure injection | Proxy teardown orchestrator | Mock publisher hook endpoint | Orchestrator already idempotent; failure is induced at the mock publisher |
| Receipts timeline (success signal) | CLI `stint receipts` (core `mergeTimeline`) | Example wrapper prints it | No new integrity logic; wrapper only invokes and summarizes |
| E2E orchestration + CI gate | Example package vitest project | `.github/workflows/ci.yml` | Dedicated project outside root `projects` glob |

## Standard Stack

### Core (all already pinned in the repo; no new packages required)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@modelcontextprotocol/sdk` | 1.30.1 | Agent stub `Client`, `InMemoryTransport`, `ReadBuffer`/`serializeMessage` for the launcher transport | Pinned stack; existing tests and `manual/mcp-call-visible.mjs` use exactly these imports [VERIFIED: packages/cli/manual/mcp-call-visible.mjs:16-17] |
| `oauth4webapi` | 3.8.8 | Headless auth-code+PKCE acquisition in the example | Already the vault's OAuth library; exported functions confirmed in `build/index.d.ts` [VERIFIED: npm tarball oauth4webapi@3.8.8] |
| `oauth2-mock-server` | 9.2.0 | Mock AS (reached via `@stint/proxy/testing` `startMockAuthServer`) | Pinned; `/authorize` auto-302s with code/state, PKCE S256 supported, `/revoke` returns 200 [VERIFIED: oauth2-mock-server@9.2.0 dist/oauth2-server-BKcc5jqv.mjs:1052-1090, 1107-1116] |
| `paseto` | 4.0.1 | PASERK export/import of the publisher's license public key (`ExportPublicKeyFactory`/`ImportPublicKeyFactory`) | Already core's license dependency; PASERK factories confirmed [VERIFIED: npm tarball paseto@4.0.1 v4/public.d.ts:120-126] |
| `jose` | 6.2.12 | Cleanup-token verification in the mock publisher hook (via `verifyCleanupToken`), manifest signing (`@stint/spec/testing`) | Pinned |
| Vitest | 5.0.2 | Dedicated e2e project | Pinned |
| tsdown | 0.21.10 | Builds the quickstart runner into `dist/` so `pnpm build` (recursive) covers it | Pinned; no `tsx` exists in the repo [VERIFIED: grep of pnpm-lock.yaml for tsx found none] |

### Supporting (workspace)
| Module | Purpose | When to Use |
|--------|---------|-------------|
| `@stint/spec/testing` (`signManifestForTest`) | Sign the example manifest with a generated publisher key | Example/e2e setup; imports only `jose` [VERIFIED: packages/spec/src/testing.ts:11] |
| `@stint/proxy/testing` (`startMockAuthServer`) | Mock AS | Example/e2e; imports `oauth4webapi`/`oauth2-mock-server`, no vitest [VERIFIED: packages/proxy/src/testing.ts:48-50] |
| `@stint/cli` (`main`, `createRealDeps` after additive export, `runLease` after additive export) | Drive create/revoke/cleanup/receipts and the serve path | Wrapper + harness |
| `@stint/core/testing` | DO NOT import at quickstart runtime | It imports `vitest` at module top [VERIFIED: packages/core/src/testing.ts:20 `import { describe, expect, it } from "vitest";`]; fine inside vitest tests only |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Custom `Transport` over `child_process.spawn` (launcher) | SDK `StdioClientTransport` | Rejected: it hard-codes `windowsHide: process.platform === 'win32'` and exposes no option for it [VERIFIED: sdk@1.30.1 dist/esm/client/stdio.js:73 and stdio.d.ts `StdioServerParameters` fields: command, args, env, stderr, cwd, maxBufferSize] |
| `redirect:"manual"` fetch to follow the mock's authorize redirect | Puppeteer / local redirect listener | Rejected: the mock has no login page, the 302 already carries the code; a listener adds a port and flakiness |
| Plain `node:http` mocks | Express/Fastify/msw | Plain `node:http` (as `teardown-rig.ts` already does, [VERIFIED: packages/cli/test/helpers/teardown-rig.ts:9,135 (`import { createServer } from "node:http";`)]); no new dependency |
| New CLI verb `stint authorize` | Acquisition in the example writing the existing credentials file | Recommended: no new verb; program.ts stays stable; platforms own consent UX |
| Export `mintHeldLicense` from core | Core `createLicenseIssuerClient` that verifies then mints | Recommended second: verifies (LIC-02) before minting so the brand still means "verified"; see Pattern 3 |

**Installation:** no new external packages. Example `package.json` lists the same exact pins already in `pnpm-lock.yaml` (`@modelcontextprotocol/sdk` 1.30.1, `oauth4webapi` 3.8.8, `paseto` 4.0.1, `jose` 6.2.12) plus `workspace:*` for `@stint/core|proxy|spec|cli`. Because `pnpm-workspace.yaml` gains a new importer, `pnpm-lock.yaml` MUST be regenerated (`npx --yes pnpm@12.6.0 install`) and committed or CI's `pnpm install --frozen-lockfile` fails (Pitfall 10). If `oauth2-mock-server` does not resolve from the example at runtime (depends on whether tsdown inlines proxy's devDependency into `dist/testing.js`), add `"oauth2-mock-server": "9.2.0"` to the example's devDependencies (same pin).

**Version verification:** pins were read from the repo (`packages/*/package.json`) and the SDK/oauth2-mock-server/paseto/oauth4webapi tarballs were downloaded at the pinned versions and read this session.

## Package Legitimacy Audit

No NEW packages are introduced. The legitimacy seam was still run against the packages the example reuses:

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| @modelcontextprotocol/sdk | npm | long-established (latest published 2026-09-28) | ~66.8M/wk | github.com/modelcontextprotocol/typescript-sdk | SUS (reason `too-new`: latest release <30d) | Approved: pre-existing pin in lockfile since Phase 1/4; no install action |
| oauth4webapi | npm | established (latest 2026-09-05) | ~16.7M/wk | github.com/panva/oauth4webapi | SUS (`too-new`) | Approved: pre-existing pin |
| oauth2-mock-server | npm | established (latest 2026-09-04) | ~240K/wk | github.com/axa-group/oauth2-mock-server | SUS (`too-new`) | Approved: pre-existing pin (dev/test only) |
| paseto | npm | established (v4 rewrite 2026-09-04) | ~50K/wk | github.com/panva/paseto | SUS (`too-new`) | Approved: pre-existing pin; STACK.md already flags the 4.x API as new |
| jose | npm | established (latest 2026-09-05) | ~160M/wk | github.com/panva/jose | SUS (`too-new`) | Approved: pre-existing pin |

The SUS verdicts come solely from the `too-new` heuristic (a recent latest-version publish date on actively maintained packages with millions of weekly downloads and `postinstall: null`); none is newly added by this phase, so no `checkpoint:human-verify` install gate is needed. The planner should not add any package beyond these pins without a stack sign-off (CLAUDE.md constraint).

**Packages removed due to SLOP:** none
**Packages flagged SUS:** none newly introduced (the four above are pre-existing locked pins; heuristic false positives)

## Architecture Patterns

### System Architecture Diagram

```
                     QUICKSTART / e2e process (examples/payment-reconciler)
 ┌───────────────────────────────────────────────────────────────────────────────────┐
 │ setup: start mock AS (@stint/proxy/testing)  mock publisher (HTTP)  mock services  │
 │        sign manifest w/ generated publisher key (@stint/spec/testing) -> trust.json│
 │                                                                                   │
 │ 1 ACQUIRE  headless "user agent":                                                  │
 │   fetch(AS /authorize?PKCE+state+resource, redirect:manual) --302 code--> validate │
 │   --> authorizationCodeGrantRequest(+code_verifier) --> tokens                     │
 │   --> write credentials.json (per resource, existing file shape)                   │
 │                                                                                   │
 │ 2 stint create <manifest> --publisher <file>   (consent via scripted|terminal      │
 │      adapter) -> publisher /license/issue (activation guard) -> active             │
 │                                                                                   │
 │ 3 SERVE  (same composition in both modes)                                          │
 │   ┌─────────────────────────────────────────────────────────────────────────┐     │
 │   │ Agent stub (MCP Client) ──tools/call──▶ createLeaseProxyServer            │     │
 │   │    in-process: InMemoryTransport        │ evaluatePolicy(deny-by-default) │     │
 │   │    quickstart: launcher child spawn     │  ├ deny ─────────▶ denied receipt│     │
 │   │    (windowsHide:false, stdio pipes)     │  ├ require_approval ▶ HostAdapter│     │
 │   │                                         │  │   scripted (e2e) | CONIN$/tty │     │
 │   │                                         │  └ allow ─▶ execute stage        │     │
 │   │                                         │      [license refresh?]─▶publisher│    │
 │   │                                         │      vault.resolveAccessToken ──▶ AS /token (refresh)│
 │   │                                         │      REST connector(fetch map)   │     │
 │   │                                         ▼                                 │     │
 │   │                          127.0.0.1 Paystack mock / Orders-sheet mock      │     │
 │   └─────────────────────────────────────────────────────────────────────────┘     │
 │                                                                                   │
 │ 4 END  verify outcome (completed) | stint revoke --yes | expiry+cleanup            │
 │      teardown: revoke_oauth(AS /revoke) -> invalidate_license(publisher) ->        │
 │                cleanup_hook(publisher POST, Bearer EdDSA JWT) -> delete -> final   │
 │      hook 500 => cleanup_incomplete;  flip ok + stint cleanup => cleaned_up        │
 │ 5 stint receipts <id>  (merged verified/attested timeline) + one-line summary      │
 └───────────────────────────────────────────────────────────────────────────────────┘
```

### Recommended Project Structure
```
examples/payment-reconciler/
├── package.json            # @stint/example-payment-reconciler, private, type:module, scripts: build/start/test/test:e2e
├── tsconfig.json           # composite, references ../../packages/{spec,core,proxy,cli}
├── tsdown.config.ts        # entry: src/quickstart.ts (and src/index.ts for test imports)
├── vitest.config.ts        # testTimeout 120_000; include test/**/*.test.ts
├── README.md               # short pointer; main README is repo root
├── src/
│   ├── manifest.ts         # builds the hybrid manifest from spec/vectors/valid/payment-reconciler.json (loopback cleanup URL, short approvals timeout)
│   ├── agent.ts            # deterministic scripted MCP Client (no credentials, never sees license)
│   ├── mocks/
│   │   ├── services.ts     # 127.0.0.1 Paystack + orders-sheet mocks (node:http), request recorder
│   │   └── publisher.ts    # mock publisher: /license/issue|reissue|invalidate, /alp/cleanup (mode toggle, jti single-use)
│   ├── oauth/acquire.ts    # headless auth-code+PKCE -> credentials.json
│   ├── profile.ts          # catalog + bindings + oauth block for the run profile; identifier->URL fetch map
│   ├── launcher.ts         # visible-console child spawn Transport (injectable spawn)
│   ├── scenario.ts         # shared orchestration used by quickstart AND e2e
│   └── quickstart.ts       # bin: `pnpm example:payment-reconciler`
└── test/
    ├── e2e.happy.test.ts            # E2E-02 happy -> cleaned_up
    ├── e2e.scope-approval.test.ts   # denied out-of-scope + approved + denied-by-user
    ├── e2e.revoke-midrun.test.ts    # user revoke mid-run
    ├── e2e.partial-teardown.test.ts # cleanup_incomplete then retry -> cleaned_up
    ├── launcher.test.ts             # windowsHide:false assertion (spy spawn) + hidden-console denies by timeout
    ├── smoke.built-bin.test.ts      # D-03: spawn built dist/bin.js over stdio
    └── readme.test.ts               # quickstart commands in README == package scripts
```

### Pattern 1: Headless auth-code + PKCE against the pinned mock AS (D-05)
**What:** the "user agent" is a `fetch` with `redirect:"manual"`; the mock AS has no login/consent page and 302s straight to `redirect_uri?code=...&state=...`.
**When to use:** acquisition in the example (quickstart + e2e), once per resource (`paystack.transactions`, `sheets.orders`), each with its own RFC 8707 `resource` parameter.
**Key facts (VERIFIED by experiment, Node 26.8.2; CI runs Node 22.18 and 24, same undici manual-redirect semantics expected, see A3):**
- `GET /authorize` needs `redirect_uri` (must parse as a URL; never contacted), `response_type=code`; `code_challenge`+`code_challenge_method=S256` are stored and enforced at `/token`; unknown params such as `resource` are ignored.
- The token response for `authorization_code` and `refresh_token` also carries an `id_token` (RS256); the existing harness's discovery works with `processAuthorizationCodeResponse` without `nonce`.
- `expires_in` defaults to 3600; mutate it per response via the `Events.BeforeResponse` hook (`response.body.expires_in = 1`) to force a real vault refresh without advancing the injected clock. The refresh grant issues a NEW refresh token each time (mock does not invalidate the old one).
- A hand-built AS object `{ issuer, token_endpoint, revocation_endpoint }` (what `parseOAuth` in `packages/cli/src/run/profile.ts` builds) is sufficient for code grant, refresh and revoke; `issuer` must equal the mock's `issuerUrl` exactly (`http://localhost:<port>`).
- Without `[oauth.allowInsecureRequests]: true`, refresh over the loopback http AS throws `OAUTH_HTTP_REQUEST_FORBIDDEN` ("only requests to HTTPS are allowed"); the run path currently never sets it (Pitfall 2).
**Example:** see Code Examples 1.

### Pattern 2: Identifier-to-endpoint mapping via the injected `fetch` (D-06)
`createRestOutboundConnector` calls `fetchImpl(binding.resource, { method: "POST", headers: {authorization: "Bearer ..."}, body: JSON.stringify(resolvedArgs) })` for EVERY tool (read and write alike) [VERIFIED: packages/proxy/src/connectors/outbound-connector.ts:67-74 region, `const response = await fetchImpl(binding.resource, {` at line 67]. Scopes and bindings must use the same identifier string (`grantedResources.includes(binding.resource)`), so the URL is never the resource. Provide `outboundFetch` (already a `RunLeaseOptions` field) that rewrites `"paystack.transactions"` and `"sheets.orders"` to `http://127.0.0.1:<port>/...` and then calls real `fetch`. Consequences for mock design: (a) accept POST everywhere, (b) two tools on the same resource (read vs write on `sheets.orders`) are distinguished only by body shape (e.g. `{order_id,status}` = update, `{}` = list), (c) the `resource_query` verifier's synthetic read POSTs `{}` to the same URL. This keeps the real connector, real socket and real `Authorization` injection under test with zero proxy changes.

### Pattern 3: License issuance, custody and refresh over HTTP (D-07)
**Publisher (mock, example):** HTTP server wrapping a reference `LicenseIssuer` that signs with a fresh Ed25519/PASETO keypair: `POST /license/issue`, `POST /license/reissue`, `POST /license/invalidate`, `POST /alp/cleanup` (the manifest's `cleanup.hook.url`), plus counters. Responses carry the raw token string (the publisher is allowed to emit it; it is the runtime-side client's job to wrap it immediately). Use ONE shared clock function with the runtime in e2e (token `nbf`/`exp` come from the signer's `now`; verification uses the runtime's `now`, so a faked runtime clock and a real-time publisher would fail `nbf`/`exp` checks).
**Reference issuer:** `createMockLicenseIssuer()` lives in `@stint/core/testing`, which imports `vitest` (line 20), so the quickstart cannot import it. Recommended: add an additive, vitest-free core subpath (e.g. `@stint/core/publisher`: `createReferenceLicenseIssuer`, exposing `publicKey`) and have `testing.ts` re-export/compose it so existing tests are unchanged. `@stint/core` root must stay free of `issueLicense`/mock issuer (locked by D-07 and the comment at `packages/core/src/index.ts:48-52`).
**Runtime-side client (new):** the runtime cannot construct a `HeldLicense` from a received string because `mintHeldLicense` is not exported from the core root (only `readLicenseToken` and the `HeldLicense` type are: `index.ts:57-58`). Recommended additive core export: `createLicenseIssuerClient({ publicKey, transport })` where `transport` is an injected port `{ issue(req): Promise<string>; reissue(req): Promise<string|null>; invalidate(leaseId): Promise<void> }` (the CLI supplies an HTTP implementation, core stays I/O-free). The client MUST `verifyLicense(publicKey, token, leaseId, specVersion, now)` (LIC-02, LICENSE_CLOCK_SKEW_SECONDS=5) and only then `mintHeldLicense`, and MUST enforce `clampedLicenseExpiry(now, DEFAULT_LICENSE_TTL_SECONDS, leaseExpiresAt)` itself (refuse/`null` once `now >= leaseExpiresAt`) rather than trusting the publisher's clamp.
**Custody + per-call refresh (new runtime glue in `runLease`):** hold `{ held: HeldLicense, exp }` per lease; wrap the `ExecuteStage` so that before delegating it evaluates `needsRefresh(exp, now, refreshBeforeSeconds)` and, if true, `reissue(...)` (never a timer, never a background loop: D-21 of Phase 5). The wrapper never passes the license toward `OutboundConnector.execute` (its `credential` stays `{ accessToken }`, LIC-05). A refused/failed reissue must not move `expires_at` and must not add new deny policy in this phase (Open Question 4).
**Teardown step 2:** pass `{ issuer, custody }` into `createDefaultTeardownSteps`. For a cross-process `stint revoke`/`cleanup` (no in-memory license), the custody's `hasLicense` must mean "this lease is hosted/hybrid" (the publisher holds the truth and must be told to invalidate), otherwise the step returns `not_applicable` and the receipt is dishonest. `discard` can be a no-op in that case.
**Where does the publisher endpoint/public key come from?** Runtime configuration, never the manifest (`auth.hosted.license_issuer` is only an Identifier; spec §8: endpoints are runtime connector configuration). Recommended: `stint create <manifest> --publisher <file>` validates and PERSISTS the non-secret publisher binding beside the lease (`leases/<id>/publisher.json`, atomic write, like `envelope.json`) so `run`/`revoke`/`cleanup` find it without new flags. File shape: `{ issue_url, reissue_url, invalidate_url, license_public_key: "k4.public...." }` (PASERK). URLs must be `https://` or loopback `http://` (mirrors the manifest schema's own `CleanupHook.url` rule, [VERIFIED: spec/manifest.schema.json:236]).
**Closing A8 in `create`:** replace the refusal at `create.ts:96` with: require a publisher binding for non-delegated modes (fixed-text `CliError` if absent, before any consent); after consent grant and before `activateLease`, call `issue`; on publisher failure dispatch `activation_failed` (already in core: `activate` guard "a license MUST be issued", ALP §7.4) and exit with a fixed message. `create` exits after activation so the license is not held across processes; `run` re-issues at start for in-memory custody (Open Question 5 confirms this two-issue model).

### Pattern 4: Shared composition point, two callers (D-02, D-03, D-08)
`runLease` (packages/cli/src/run/run-lease.ts) already accepts injected `transport`, `adapter`, `outboundFetch`, `credentials`. Extend it additively with: `license?` (issuer client + publisher binding), `allowInsecureRequests?` (derived), and build real `teardownSteps` (vault + license custody + `cleanup.hook.url` + runtime signing key) instead of omitting them (the omission comment at `run-lease.ts:116-117` states the reason: "the honest step set needs the cleanup hook and license custody this command does not hold": Phase 7 supplies both). Export `runLease` and `createRealDeps` from `@stint/cli`'s barrel (currently neither is exported; `packages/cli/test/public-api.test.ts` asserts only the current barrel, so additive exports are safe). The in-process harness calls `runLease` with an `InMemoryTransport` half and the scripted adapter; `stint run` calls the same function with `StdioServerTransport` and the terminal adapter.

### Pattern 5: Dedicated vitest project + CI step (D-04)
- Add `examples/*` to `pnpm-workspace.yaml` `packages:`. Root `vitest.config.ts` uses `projects: ["packages/*"]` [VERIFIED: vitest.config.ts], so the example is NOT run by `pnpm test`; that IS the separation. Run it with its own `vitest.config.ts` via a package script.
- Root scripts to add: `"test:e2e": "pnpm --filter @stint/example-payment-reconciler run test:e2e"` and `"example:payment-reconciler": "pnpm --filter @stint/example-payment-reconciler run start"`.
- `pnpm build` is `pnpm -r build`, so giving the example a `build` (tsdown) script makes a fresh-clone `pnpm install && pnpm build` produce `dist/quickstart.js` AFTER its workspace dependencies (topological). `tsc -b` needs `{ "path": "examples/payment-reconciler" }` appended to root `tsconfig.json` references; `eslint .` already covers it (its `projectService` needs the example tsconfig to include `src` and `test`).
- CI: add one step after `pnpm test`: `- run: pnpm test:e2e` (same matrix: ubuntu-latest/windows-latest x Node 22.18.0/24). The built `packages/cli/dist/bin.js` already exists at that point because the job runs `pnpm build` earlier [VERIFIED: .github/workflows/ci.yml steps].
- Sandbox discipline (memory): whole-repo vitest/eslint OOM; run the e2e only via `npx --yes pnpm@12.6.0 --filter @stint/example-payment-reconciler exec vitest run` (scoped), and per-file eslint.
- Servers start in `beforeAll`/per-scenario fixtures inside the test process (port `0`, `127.0.0.1`), stopped in `afterAll`; give every scenario its own temp store root (`mkdtemp`), as `createHarness` does.

### Pattern 6: Partial-teardown injection (D-10)
Flow (all shipped): `stint revoke --yes --credentials <file>` -> `buildTeardownDeps` -> `createDefaultTeardownSteps(receiptStore, privateKey, vault, license, cleanup)` -> `runTeardown`. `cleanup_hook` mints a FRESH EdDSA JWT per attempt (`jti = randomUUID()`), POSTs it as `Authorization: Bearer`, maps any non-2xx to `"failed"` and a 2xx to `"attested_ok"` [VERIFIED: packages/proxy/src/teardown/steps.ts createCleanupHookStep + cleanup-client.ts]. A failed step does not stop the rest; the lease lands `cleanup_incomplete` with `teardownProgress` recording every step, `reportTeardown` returns exit code 7 (`cleanupIncomplete`) [VERIFIED: packages/cli/test/public-api.test.ts:28 `EXIT_CODES.cleanupIncomplete).toBe(7)`]. Flip the mock hook to 200 and run `stint cleanup <id> --yes [--credentials]` -> route `cleanup_incomplete` -> `retryTeardown(teardown, "user", now)`; steps already recorded as succeeded are not re-run, so assert: AS `/revoke` hit count stays 1, publisher `/license/invalidate` count stays 1, hook count 2 with two distinct `jti`s, final state `cleaned_up`. The mock hook should verify the bearer with `verifyCleanupToken(token, runtimePublicKey, now)` (exported from `@stint/proxy`) and reject a repeated `jti` (spec §10 MUST). Get the runtime public key with `deps.keys.loadPublic(root)` after `create` has created the key.

### Pattern 7: Quickstart wrapper and non-interactive handling (D-11/D-12)
The wrapper (`quickstart.ts`) = the same `scenario.ts` the e2e uses, but with real process boundaries for the serve step: setup mocks -> acquire -> `create` (terminal consent when `process.stdin.isTTY`, auto-grant with a printed notice otherwise, via an injected `adapterFactory`) -> launcher spawns `stint run` with a visible console -> agent stub drives the script -> `stint revoke --yes` (or verifier completion if wired) -> print `stint receipts` timeline and a one-line summary. Approvals inside the spawned `stint run` use the terminal adapter on `CONIN$`/`/dev/tty`: a human answers `y`; with no terminal the call denies after `approvals.timeout_seconds`. Because the wrapper signs its own manifest, it can choose a short `timeout_seconds` when non-interactive so a CI run of the verbatim command finishes quickly and deterministically (the approved-call evidence then comes from the e2e harness, D-02). Locate the bin without the package `exports` map: `new URL("./bin.js", import.meta.resolve("@stint/cli"))` (resolves to `.../packages/cli/dist/index.js`'s sibling); do NOT rely on `node_modules/.bin/stint` (pnpm links workspace bins at install, before `pnpm build` produced `dist/bin.js`; ASSUMED behavior, A6) and `@stint/cli/package.json` is not exported.

### Pattern 8: Visible-console launcher (D-08/D-09)
**What:** a `Transport` (the SDK's interface: `start/send/close`, `onmessage/onerror/onclose`) over `child_process.spawn(process.execPath, [binPath, "--store", root, "run", leaseId, "--profile", p, "--credentials", c], { stdio: ["pipe","pipe", stderrMode], windowsHide: false })`. Hard-code `windowsHide:false` (Node ignores it off Windows). Use `ReadBuffer` + `serializeMessage` from `@modelcontextprotocol/sdk/shared/stdio.js`. Differences from the manual script worth keeping: handle `child.stdin.on("error")` (EPIPE after child exit), call `onclose` on `close`, and accept an injected `spawn` (default `node:child_process.spawn`) and `stderr` mode (`"inherit"` for humans, `"pipe"` for tests).
**Assertion (D-09):** inject a spy `spawn` that records `(command, args, options)` then delegates to the real `spawn`; assert `options.windowsHide === false` on every platform, `options.stdio` has `"pipe"` for stdin/stdout, and `options.shell !== true`. Hidden-console direction test: the existing `run-stdio-smoke.test.ts` already proves a hidden (`windowsHide:true`) `StdioClientTransport` spawn denies an approval-gated call; add the hybrid variant or an `openTerminal: () => undefined` in-process run asserting `denied: ...` with zero downstream fetches (fail-safe direction). The real-console check stays in `packages/cli/manual/` (human).

### Anti-Patterns to Avoid
- **Importing `@stint/core/testing` in quickstart runtime code:** pulls `vitest` into a normal process (Pitfall 5).
- **Treating only `delegated` as "has OAuth grants":** hybrid leases lose revoke/refresh (Pitfall 1).
- **Hard-coding or env-flagging `allowInsecureRequests` in the production bin:** derive from a loopback-only rule with a test that non-loopback http stays refused (Pitfall 2).
- **Putting approval/deny logic in the scripted adapter:** it only proposes; core owns the outcome (deny on rejection/abort/timeout). Script data, not policy.
- **Sharing the injected clock with real timers:** approval timers are real `setTimeout(timeout_seconds*1000)` (`approval-dispatcher.ts:120-122`); keep manifest `timeout_seconds` at 1-2s in tests where a timeout is asserted.
- **Waiting with `sleep`:** wait on observable signals (prompt text, hit counters, lease state).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| PKCE verifier/challenge/state | Manual base64url SHA-256 | `oauth.generateRandomCodeVerifier/calculatePKCECodeChallenge/generateRandomState` | No hand-rolled crypto; exports confirmed in oauth4webapi@3.8.8 |
| Auth-code redirect parsing | URL/regex parsing of `code`/`state` | `oauth.validateAuthResponse(as, client, url, state)` | Checks state/iss/error per RFC 9207 |
| PASETO sign/verify, implicit assertion | Re-implementing `issueLicense` / `deriveImplicitAssertion` in the example | Core `issueLicense` (via a vitest-free reference issuer subpath) + `verifyLicense` | The implicit assertion is JCS of `{lease_id, spec_version}`; a mismatch silently fails verification |
| PASERK key transport | Custom base64 key files | `PublicProtocol(ExportPublicKeyFactory, ImportPublicKeyFactory)` | Standard `k4.public.` strings |
| Refresh single-flight / revoke | Custom token cache | `createCredentialVault` | Already owns single-flight, scrubbing, honest revoke outcomes |
| Cleanup token mint/verify | Custom JWT | `mintCleanupToken` (runtime) / `verifyCleanupToken` (mock hook) | Same key as checkpoints, fresh `jti` per attempt |
| Timeline merge/render | New renderer | `stint receipts` (`mergeTimeline` + `renderTimeline`) | Sanitizes terminal-injection; no integrity logic to duplicate |
| Atomic JSON persistence for `publisher.json` | `fs.writeFile` | `atomicWriteJson` (`packages/cli/src/store/atomic-file.ts`) | Windows EPERM/EBUSY handling already proven |
| Stdio JSON-RPC framing | Line splitting | SDK `ReadBuffer`/`serializeMessage` | Matches the server transport byte-for-byte |
| Mock HTTP servers | New framework | `node:http` on `127.0.0.1:0` | Same pattern as `teardown-rig.ts`; zero new deps |

**Key insight:** every hard part (policy, vault, teardown, receipts, PASETO, PKCE) already exists; the risk in this phase is wiring that silently no-ops (placeholders that report success, identifier strings used as URLs, hybrid treated as non-OAuth), so each wiring point needs an assertion that proves it is live, not just green.

## Runtime State Inventory

Not a rename/refactor/migration phase. Omitted except for the one custody caveat that affects this phase's design: the vault and the held license are in-memory per process (never persisted by design), while `stint revoke`/`cleanup` run as separate processes seeded from `credentials.json`. The mock AS rotates the refresh token on every refresh, so after a mid-run refresh the on-disk credentials file holds a stale refresh token; `revoke_oauth` will send that stale token to `/revoke` (mock returns 200 regardless). Document this in the README as a known limit of the separate-process demo (see Pitfall 8), or have `runLease` build the real teardown steps (recommended) so the live vault with the freshest token is used when the serving process performs teardown.

## Common Pitfalls

### Pitfall 1: Hybrid is treated as "no OAuth grants" in run/revoke/cleanup
**What goes wrong:** `run` does not require `--credentials` for hybrid, `revoke`/`cleanup` never load the credentials file, so the vault is empty: calls fail with "no credential seeded" and `revoke_oauth` returns `not_applicable` (a silently skipped revocation).
**Why it happens:** Phase 6 only ever activated `delegated` leases. [VERIFIED: packages/cli/src/commands/run.ts:67 `const delegated = resolveAuthMode(verified.manifest) === "delegated";` and packages/cli/src/commands/teardown-support.ts:90 `const delegated = resolveAuthMode(verified.manifest) === "delegated";`]
**How to avoid:** change both predicates to "mode !== hosted" (hybrid has `auth.delegated` grants too; ALP §8). Add tests: hybrid run without `--credentials` errors; hybrid revoke hits the AS `/revoke` endpoint.
**Warning signs:** `revoke_oauth: not_applicable` on a hybrid lease; "call failed" on the first Paystack read.

### Pitfall 2: Refresh/revoke against the `http://localhost` mock AS is refused
**What goes wrong:** `oauth4webapi` throws `OAUTH_HTTP_REQUEST_FORBIDDEN`; the vault classifies it as `transient_error`; every call after token expiry is denied.
**Why it happens:** `runLease` builds the vault without refresh options. [VERIFIED: packages/cli/src/run/run-lease.ts:96 `const vault = createCredentialVault(profile.oauth, clock);`]; teardown has a seam (`TeardownSeams.allowInsecureRequests`), run has none. The spawned `stint run` (quickstart, D-03 smoke) cannot be given a test-only dep.
**How to avoid:** derive `allowInsecureRequests` from a pure loopback-only rule on the profile's `token_endpoint` (http + `localhost|127.0.0.1|[::1]`), applied identically in run, revoke and cleanup, with a test that `http://as.example.test` stays refused. This mirrors the spec's own loopback-http allowance for `cleanup.hook.url`. It is a security-relevant relaxation, so flag for user confirmation (A2).
**Warning signs:** `transient_error` denials exactly when the 1-second mock token expires.

### Pitfall 3: Identifier strings are used as URLs by the REST connector
**What goes wrong:** `fetch("paystack.transactions")` throws "Failed to parse URL" and every outbound call becomes `call failed` (this is the UAT-noted "reference profile binds identifier resources like sheets.orders with no real endpoint").
**How to avoid:** inject `outboundFetch` mapping identifiers to loopback URLs (Pattern 2). The `stint run` binary has no such seam; options: a profile field `endpoints: { "<resource>": "<url>" }` applied by a fetch wrapper inside `runLease` (non-secret config, loopback/https only) or an example-only in-process composition. Recommend the profile field since the quickstart's spawned `stint run` needs it (Open Question 2).
**Warning signs:** `call failed` with no mock-server hits.

### Pitfall 4: `invalidate_license` is a placeholder that reports `ok`
**What goes wrong:** for a hybrid lease the CLI teardown records `invalidate_license: ok` without telling the publisher; the receipt is dishonest and the publisher keeps reissuing.
**Why it happens:** [VERIFIED: packages/cli/src/commands/teardown-support.ts:117 `const defaults = createDefaultTeardownSteps(receiptStore, privateKey, vault, undefined, cleanup);`] passes `undefined` for `license`; with no license collaborator `steps.ts` uses `happyPathStep("invalidate_license", "ok")`.
**How to avoid:** wire `{ issuer, custody }` (Pattern 3) and assert the publisher's `/license/invalidate` counter increments exactly once, and is NOT incremented again on retry.

### Pitfall 5: `@stint/core/testing` cannot be used at quickstart runtime
**What goes wrong:** importing the mock license issuer drags `vitest` (`packages/core/src/testing.ts:20`) into a normal Node process; vitest is only a root devDependency and an optional peer of core, and outside a runner its globals are invalid (ASSUMED behavior, A4).
**How to avoid:** vitest-free reference issuer subpath (Pattern 3); keep `@stint/core/testing` for tests only.

### Pitfall 6: The SDK stdio transport forces a hidden console on Windows
**What goes wrong:** approval prompts render on an invisible console; every approval-gated call times out and denies (fails safe; UAT finding).
**Root cause:** [VERIFIED: sdk@1.30.1 dist/esm/client/stdio.js:73 `windowsHide: process.platform === 'win32',`] with no `StdioServerParameters` option to change it.
**How to avoid:** the launcher (Pattern 8) plus the spy-spawn assertion. Keep the manual scripts.

### Pitfall 7: Fake clock vs real things
**What goes wrong:** license verification fails (`nbf`/`exp` are signed with the publisher's `now`), or approvals never time out, or OAuth refresh never triggers.
**How to avoid:** one injectable `clock` shared between runtime deps and the in-process mock publisher; OAuth expiry forced via `expires_in` mutation rather than clock jumps; approvals use real timers with `timeout_seconds` of 1-2s where asserted. To test license refresh: advance the shared clock past `exp - refreshBefore` and assert a `/license/reissue` hit and that no refreshed `exp` exceeds `lease.expiresAt`.

### Pitfall 8: Cross-process custody limits are real
**What goes wrong:** stale refresh token on disk after a rotation (above); a separate `stint revoke` cannot discard the running process's in-memory license; two JSON-store writers (the serving `stint run` and the test's `revoke`) contend on the same lease file on Windows.
**How to avoid:** document the limit; build real teardown steps inside `runLease` so a provider-revoked/verified ending runs teardown with the live vault; rely on the store's existing lock + `withTransientRetry`, keep `testTimeout` at 60-120s [VERIFIED: packages/cli/vitest.config.ts comment "Windows CI file IO (atomic rename + proper-lockfile) exceeds Vitest's 5s default"]. STATE.md records "Windows atomicity (EPERM/EBUSY on rename) ... Must be proven on Windows CI": the e2e on windows-latest IS that proof; watch it.

### Pitfall 9: "Quickstart works verbatim" vs interactivity and CI
**What goes wrong:** with no TTY, consent declines and approvals deny; README says it works but a clean run produces only denials.
**How to avoid:** wrapper detects `process.stdin.isTTY`; non-TTY -> auto-grant consent with a printed line and a short approvals timeout; README states both modes. Add a CI job step that runs the verbatim command on a fresh checkout (already post-install/build) and asserts exit 0 plus terminal-state text; add `readme.test.ts` asserting the README's fenced quickstart commands match the package scripts.

### Pitfall 10: New workspace importer vs `--frozen-lockfile`
**What goes wrong:** CI `pnpm install --frozen-lockfile` fails because `pnpm-lock.yaml` lacks the `examples/payment-reconciler` importer; `engineStrict: true` also applies to the new package's `engines`.
**How to avoid:** regenerate and commit the lockfile in the same plan that adds the package; set `engines.node >=22.18.0`; keep `strictDepBuilds` happy (no deps with install scripts are added).

### Pitfall 11: `localhost` vs `127.0.0.1`
The mock AS binds `localhost` (the harness calls `server.start(0, "localhost")`); service/publisher mocks should bind `127.0.0.1` per D-06. The two never need to be the same host, but the AS `issuer` string in the profile must equal `server.issuer.url` byte-for-byte (id_token `iss` check).

### Pitfall 12: Out-of-scope denial design
`flattenScopes` builds a cross-product of granted access x resources (Open Q8 inherited), so a tool like "write to paystack.transactions" would be ALLOWED (write is granted for the sheet). Drive the denied call with an access class or resource that is not granted at all: a `pay`-class tool (e.g. `issue_refund`, binding access `pay`) is hidden from `tools/list` and denies `no_binding` when named directly (`resolveEffectiveBinding` is shared by list and call). A `pay` scope in a manifest would additionally require `limits.spend` (schema `if/then`), which the example manifest deliberately lacks.

## Code Examples

### 1. Headless auth-code + PKCE + refresh + revoke (verified run, Node 26.8.2)
```typescript
// Source: experiment run this session against oauth4webapi@3.8.8 + oauth2-mock-server@9.2.0
import * as oauth from "oauth4webapi";
const insecure = { [oauth.allowInsecureRequests]: true }; // loopback mock AS only
const as = { issuer: issuerUrl, token_endpoint: `${issuerUrl}/token`,
             revocation_endpoint: `${issuerUrl}/revoke` };     // what profile.ts parseOAuth builds
const client = { client_id: "stint-example-client" };
const clientAuth = (_as: unknown, c: { client_id: string }, body: URLSearchParams) => { body.set("client_id", c.client_id); };
const verifier = oauth.generateRandomCodeVerifier();
const state = oauth.generateRandomState();
const authUrl = new URL(`${issuerUrl}/authorize`);            // or discovery's authorization_endpoint
for (const [k, v] of Object.entries({
  client_id: client.client_id, redirect_uri: "http://127.0.0.1:9/callback", response_type: "code",
  code_challenge: await oauth.calculatePKCECodeChallenge(verifier), code_challenge_method: "S256",
  state, resource: "paystack.transactions" })) authUrl.searchParams.set(k, v);
const hop = await fetch(authUrl, { redirect: "manual" });     // 302, Location carries code+state
const params = oauth.validateAuthResponse(as, client, new URL(hop.headers.get("location")!), state);
const tokens = await oauth.processAuthorizationCodeResponse(as, client,
  await oauth.authorizationCodeGrantRequest(as, client, clientAuth, params,
    "http://127.0.0.1:9/callback", verifier,
    { additionalParameters: { resource: "paystack.transactions" }, ...insecure }));
// -> credentials.json entry (existing shape consumed by loadCredentials):
// { accessToken: tokens.access_token, refreshToken: tokens.refresh_token,
//   expiry: Math.floor(Date.now()/1000) + (tokens.expires_in ?? 3600),
//   tokenEndpoint: as.token_endpoint, resourceIndicator: "paystack.transactions",
//   clientId: client.client_id, revocationEndpoint: as.revocation_endpoint }
```
Observed output: authorize status 302; token keys `access_token, token_type, expires_in, scope, refresh_token, id_token`; mock saw `grant_type=authorization_code` with `resource` and `code_verifier`; with `expires_in` mutated to 1 the refresh grant succeeded and returned a different refresh token (`expires_in` 3600); `/revoke` returned 200. Without the insecure flag the refresh threw `OAUTH_HTTP_REQUEST_FORBIDDEN`.

### 2. Force a short access-token lifetime on the mock AS (additive harness change)
```typescript
// Source: experiment; mirrors MockAuthHarness.forceNextTokenError's BeforeResponse pattern
// (packages/proxy/src/testing.ts:142 `server.service.on(Events.BeforeResponse, (response, req) => {`)
server.service.on(Events.BeforeResponse, (res, req) => {
  if (nextExpiresIn !== undefined && typeof res.body === "object" && res.body !== null && "expires_in" in res.body) {
    (res.body as { expires_in: number }).expires_in = nextExpiresIn; nextExpiresIn = undefined;
  }
});
// Expose as MockAuthHarness.forceNextExpiresIn(seconds) and (optionally) revokeHits via Events.BeforeRevoke.
```

### 3. Visible-console launcher Transport
```typescript
// Source: modeled on packages/cli/manual/mcp-call-visible.mjs (verified working, Phase 6 UAT) + SDK Transport interface
import { spawn as nodeSpawn } from "node:child_process";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

export interface LauncherOptions { args: string[]; stderr?: "inherit" | "pipe"; spawnImpl?: typeof nodeSpawn; }
export function createVisibleConsoleTransport(bin: string, o: LauncherOptions): Transport {
  const spawnImpl = o.spawnImpl ?? nodeSpawn;
  const buf = new ReadBuffer();
  let child: ReturnType<typeof nodeSpawn> | undefined;
  const t: Transport = {
    async start() {
      child = spawnImpl(process.execPath, [bin, ...o.args],
        { stdio: ["pipe", "pipe", o.stderr ?? "inherit"], windowsHide: false, shell: false });
      child.stdout!.on("data", (c: Buffer) => { buf.append(c); for (;;) { let m; try { m = buf.readMessage(); } catch (e) { t.onerror?.(e as Error); return; } if (m === null) break; t.onmessage?.(m); } });
      child.stdin!.on("error", (e) => t.onerror?.(e));
      child.on("close", () => t.onclose?.());
    },
    send(message) { return new Promise((r) => { child!.stdin!.write(serializeMessage(message), () => r()); }); },
    async close() { try { child?.stdin?.end(); } catch {} child?.kill(); },
  };
  return t;
}
// Test: spy spawn -> expect(options.windowsHide).toBe(false) on every platform.
```

### 4. Agent stub and deterministic script
```typescript
// Source: pattern from packages/cli/test/run-stdio-smoke.test.ts and run-approvals.test.ts
const client = new Client({ name: "payment-reconciler-agent", version: "0.1.0" });
await client.connect(transport);
const { tools } = await client.listTools();      // expect: list_transactions, read_orders, mark_order_reconciled (issue_refund hidden)
await client.callTool({ name: "list_transactions", arguments: {} });                       // read paystack.transactions -> allowed
await client.callTool({ name: "read_orders", arguments: {} });                              // read sheets.orders -> allowed
await client.callTool({ name: "mark_order_reconciled", arguments: { order_id: "ord_1001", status: "reconciled" } }); // write, irreversible -> approval
await client.callTool({ name: "issue_refund", arguments: { txn: "t_1", amount_minor: 100 } });  // pay, not granted -> "denied: no_binding"
```
Results are `CallToolResult` with `isError` and a `content[0].text` of `denied: <reason>` on denial [VERIFIED: packages/proxy/src/dispatch.ts `denyResult` -> `denied: ${reason}`]. `require_approval` fires because the binding is `irreversible: true` and `approvals.require_for` contains `"irreversible"` (vector value) [VERIFIED: packages/core/src/policy.ts:80 `if (binding.irreversible) return "irreversible";` and spec/vectors/valid/payment-reconciler.json `"require_for": ["irreversible"]`].

### 5. Scripted HostAdapter (no policy, only proposals)
```typescript
// HostAdapter shape verified at packages/core/src/host-adapter.ts (ConsentDecision | ApprovalDecision | OutcomeConfirmDecision unions)
const scripted = (answers: { approvals: Array<"approve" | "deny"> }): HostAdapter => ({
  requestConsent: async () => ({ decision: "grant" }),
  requestApproval: async () => answers.approvals.shift() === "approve"
    ? { decision: "approve" } : { decision: "deny", reason: "user_denied" },
  requestOutcomeConfirmation: async () => ({ decision: "confirm" }),
  notify: async () => undefined,
});
```
Anything that throws/hangs is folded to deny/decline/reject by `await*Decision` in core, so the script cannot turn a fault into an allow.

### 6. Mock publisher cleanup hook (failure toggle + single-use jti)
```typescript
// verifyCleanupToken is exported from @stint/proxy [VERIFIED: packages/proxy/src/index.ts:134]
const seen = new Set<string>(); let mode: "ok" | "fail" = "fail";
// POST /alp/cleanup: bearer -> verifyCleanupToken(token, runtimePublicKey, now)
//   null => 401; claims.scope !== `cleanup:${leaseId}` => 403; seen.has(jti) => 409; mode==="fail" => 500; else 200
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `paseto@3` static `V4.sign` | `paseto@4` factory composition (`PublicProtocol`) | 2026-09 (4.0.0) | Use `ExportPublicKeyFactory`/`ImportPublicKeyFactory` for PASERK key files |
| SDK `StdioClientTransport` for any host | Custom Transport when console visibility matters | n/a | Windows approval-prompt correctness |
| Pre-seeded credentials only (Phase 6) | Real acquisition -> same credentials file | Phase 7 | Closes Phase 6 deferral without a new CLI verb |

**Deprecated/outdated:** `oauth.allowInsecureRequests` is marked deprecated in oauth4webapi (existing code already suppresses with `// eslint-disable-next-line @typescript-eslint/no-deprecated`); keep that pattern in the example.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Adding an additive `@stint/core` subpath with a vitest-free reference issuer and a `createLicenseIssuerClient` export is acceptable (vs exporting `mintHeldLicense`) | Pattern 3 | Planner picks a different mint path; needs user OK because D-07 says `issueLicense`/mock issuer are intentionally not re-exported from the root |
| A2 | A loopback-only derived rule for `allowInsecureRequests` (http + localhost/127.0.0.1/[::1]) is acceptable in production run/revoke/cleanup | Pitfall 2 | Security-relevant relaxation; user may prefer an explicit flag |
| A3 | `fetch(..., {redirect:"manual"})` returns the raw 302 with a readable `Location` identically on Node 22.18.0 and 24 (verified only on Node 26.8.2) | Pattern 1 | Acquisition fails on the Node 22.18 CI leg; fallback: a tiny `node:http` client or `undici` raw request |
| A4 | Importing `vitest` outside a runner (via `@stint/core/testing`) breaks or is unsafe in a normal process | Pitfall 5 | If it actually works, the vitest-free subpath is optional (still cleaner) |
| A5 | Persisting the publisher binding at `create` (`leases/<id>/publisher.json`) is preferred over per-command flags; `program.ts` (declared frozen in 06-04) may be edited | Pattern 3 | If `program.ts` must stay frozen, use a profile/env approach instead |
| A6 | pnpm will not (reliably) create the `stint` bin shim for a workspace dependency whose `dist/bin.js` does not exist at install time, so the launcher should resolve the bin via `import.meta.resolve("@stint/cli")` | Pattern 7 | If pnpm handles it, both work; resolve approach is safe regardless |
| A7 | tsdown leaves/inlines `oauth2-mock-server` (proxy devDependency) in `dist/testing.js` such that it resolves from the example; if not, the example needs it as a devDependency | Standard Stack | Runtime "Cannot find module" on quickstart; mitigation documented |
| A8 | The `windows-latest` runner lets a `windowsHide:false` child spawn without an interactive desktop and the child denies by timeout | D-03 smoke | If it hangs on CI, fall back to `StdioClientTransport` for the smoke and keep the spy assertion for `windowsHide:false` |
| A9 | The happy path may end via a host-side `verifyOutcome()` added to `RunningLease` (in-process only) while the spawned `stint run` ends via `stint revoke`/expiry | Open Question 1 | If user wants verifier-driven completion in the shipped binary, a declarative `rowAdapter` in the profile JSON is additional scope |
| A10 | Two publisher issue calls (at `create` as the activation guard, at `run` for in-memory custody) are acceptable | Pattern 3 | Publisher may need per-lease idempotency; the mock can simply re-sign |

## Open Questions

1. **How does the happy path reach `cleaned_up`? (CONTEXT is silent; needs a decision before planning.)**
   - What we know: `job.verifier` is `resource_query` on `sheets.orders`. The shipped run path has NO completion trigger: there is no done tool (asserted by Phase 6 tests), `runLease` never calls `runResourceQueryVerification`, and profile JSON cannot carry a `rowAdapter` function. `runLease` also creates the vault internally, so the harness cannot reach it.
   - What's unclear: whether "happy path" means verifier completion (`completed`) or just a clean end (expiry/revoke).
   - Recommendation: add an additive host-side `RunningLease.verifyOutcome()` (runtime-run, agent cannot invoke it; preserves Phase 5 D-03) built inside `runLease` from the profile binding that has a `rowAdapter`; the in-process harness (in-code profile) calls it after the script -> predicate true -> `completed` -> auto-chained teardown (with real `teardownSteps`) -> `cleaned_up`. The spawned quickstart ends with `stint revoke --yes` and the README explains the verifier path. Cheaper fallback needing no product change: happy path = injected-clock expiry + `stint cleanup` (settle -> `expired` -> teardown -> `cleaned_up`), but it leaves the manifest verifier unexercised.

2. **How does the spawned `stint run` learn identifier-to-endpoint mapping and the publisher binding?**
   - What we know: connector URL = `binding.resource`; run profile has catalog/bindings/oauth only; `program.ts` is declared frozen but the phase description allows surfacing seams (CONTEXT Discretion).
   - Recommendation: extend the run profile with optional `endpoints` (resource -> https/loopback URL, applied by a fetch wrapper in `runLease`) and add `--publisher <file>` to `create` with store persistence (A5). Keep both additive and optional.

3. **Phase-6 bugs that Phase 7 must fix to make hybrid real** (not optional): Pitfalls 1, 2, 4 (hybrid predicate; loopback insecure refresh; license collaborator in teardown) plus real `teardownSteps` in `runLease`. Confirm the user accepts these CLI edits inside "Phase 7 closes Phase-6 deferrals."

4. **License refresh failure policy.** What we know: core has `needsRefresh`/`clampedLicenseExpiry`; no policy exists for "license lapsed and cannot refresh." Recommendation: no new deny policy in Phase 7; refresh is best-effort per call and only ever clamps to `lease.expiresAt`; document as a v0.1 limit. `applyEntitlementRevocation` exists but its webhook transport is explicitly "a later phase's" concern.

5. **Is the two-issue model (create guard + run custody) right?** `create` cannot hold the license (in-memory, process exits). Confirm that `create` issuing once as an activation guard and `run` issuing again is acceptable.

6. **Attested chain in the timeline.** D-12 says "verified/attested," but nothing in the CLI appends `attested_claim` entries (`receipts` comment: "v0.1 normally has no attested chain"). Recommendation: the demo timeline is `[verified]` entries; the `cleanup_hook: attested_ok` teardown line is where the attested claim appears. Adding a signed attested claim from the mock publisher is optional scope creep.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | everything | yes (dev) | v26.8.2 locally; CI matrix 22.18.0 and 24 | none needed |
| pnpm | install/build/scripts | via `npx --yes pnpm@12.6.0` only (corepack broken in sandbox, memory) | 12.6.0 | README uses plain `pnpm` + `corepack enable` |
| node_modules in this worktree | running anything repo-local | no (worktree has none; nothing built) | — | `npx --yes pnpm@12.6.0 install` before executing plans; research used scratch installs of the pinned tarballs |
| Real console / tty | `manual/` human check | dev machine yes; CI no | — | automated checks use spy spawn + deny-by-timeout |
| Network | registry only | yes | — | mocks are loopback-only |

**Missing dependencies with no fallback:** none for planning.
**Missing with fallback:** repo dependencies are not installed in this worktree (execution must install first).

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest 5.0.2 |
| Config file | `examples/payment-reconciler/vitest.config.ts` (new; Wave 0); root `vitest.config.ts` (`projects: ["packages/*"]`) stays unchanged so units and e2e remain separate |
| Quick run command | `npx --yes pnpm@12.6.0 --filter @stint/example-payment-reconciler exec vitest run <file>` |
| Full suite command | `npx --yes pnpm@12.6.0 test:e2e` (root script -> example package `vitest run`); units: existing scoped package runs |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| E2E-01 | Hybrid lease: PKCE acquisition -> license issued -> Paystack read via injected token -> orders write; token never in agent output, license never at any mock service | e2e (in-process) | `vitest run test/e2e.happy.test.ts` | ❌ Wave 0 |
| E2E-02 happy | verify outcome -> `completed` -> teardown -> `cleaned_up`; all 5 teardown steps recorded; `stint verify` passes | e2e | `vitest run test/e2e.happy.test.ts` | ❌ Wave 0 |
| E2E-02 denied | `issue_refund` (ungranted `pay`) -> `denied: no_binding`; tool absent from `tools/list`; zero mock hits; denied receipt | e2e | `vitest run test/e2e.scope-approval.test.ts` | ❌ Wave 0 |
| E2E-02 approval | `mark_order_reconciled` -> scripted approve -> sheet mock updated; second call scripted deny -> `denied: user_denied`, no hit | e2e | `vitest run test/e2e.scope-approval.test.ts` | ❌ Wave 0 |
| E2E-02 revoke mid-run | `main([... "revoke", id, "--yes", "--credentials", f])` while serving -> `cleaned_up`, next call `denied: lease_not_active`, AS `/revoke` hit once | e2e | `vitest run test/e2e.revoke-midrun.test.ts` | ❌ Wave 0 |
| E2E-02 partial teardown | hook 500 -> exit 7, `cleanup_incomplete`, `teardownProgress` = revoke_oauth revoked / invalidate_license ok / cleanup_hook failed / delete_cached_data ok / final_receipt ok; flip -> `cleanup` -> `cleaned_up`; revoke & invalidate counters unchanged; two distinct jtis | e2e | `vitest run test/e2e.partial-teardown.test.ts` | ❌ Wave 0 |
| D-03 | built `dist/bin.js` boots over stdio, `tools/list` + one call, approval denies by timeout, stdout protocol-clean | smoke | `vitest run test/smoke.built-bin.test.ts` | ❌ Wave 0 |
| D-09 | launcher spawns with `windowsHide:false`; hidden-console spawn denies | unit | `vitest run test/launcher.test.ts` | ❌ Wave 0 |
| LIC-01/02/03/05 | token verifies offline; refresh clamped <= lease expiry; refused after lease end / after invalidate; no mock service request contains a `v4.public.` string | e2e + unit | covered in happy + a license-refresh case | ❌ Wave 0 |
| DOC-01 | README contains the four sections in order; quickstart commands equal package scripts; verbatim command exits 0 in CI | docs test + CI step | `vitest run test/readme.test.ts` + CI `pnpm example:payment-reconciler` | ❌ Wave 0 |
| CLI fixes | hybrid run requires credentials; hybrid revoke hits AS; `http://as.example.test` still refused; `invalidate_license` calls publisher | unit | scoped `packages/cli` tests | ❌ Wave 0 |

### Sampling Rate (what to observe to prove each scenario deterministically)
Observable signals per scenario, never sleeps: (1) lease `state` and `teardownProgress` from the JSON store; (2) verified-chain contents via `receiptStoreFactory(...).load("verified")` and `verifyChain`; (3) mock service recorders (method, path, `authorization` presence/shape, body, and absence of any `v4.public.` substring or access-token value in agent-visible results and receipts); (4) mock AS counters (`tokenEndpointHits`, `lastTokenRequestBody` with `grant_type`, `resource`, `code_verifier`; revoke hits); (5) mock publisher counters (issue/reissue/invalidate/cleanup with `jti` list); (6) exit codes from `main()` (revoke 0; cleanup-incomplete 7; retry 0). Determinism rules: port `0` on `127.0.0.1`; per-scenario `mkdtemp` store; one shared injected clock; approvals timeout 1-2s only where a timeout is the assertion; OAuth expiry forced by `expires_in` mutation.
- **Per task commit:** scoped vitest for the touched test file (per memory: never whole-repo).
- **Per wave merge:** `--filter @stint/example-payment-reconciler exec vitest run` plus scoped `packages/cli`, `packages/core`, `packages/proxy` runs for edited packages.
- **Phase gate:** `pnpm test:e2e` green on ubuntu + windows legs; manual `packages/cli/manual/` visible-console check recorded in UAT.

### Wave 0 Gaps
- [ ] `examples/payment-reconciler/` package skeleton (package.json, tsconfig, tsdown, vitest config) + `pnpm-workspace.yaml`/root `tsconfig.json`/root scripts/CI step; regenerate `pnpm-lock.yaml`
- [ ] Mock services, mock publisher, acquisition module, launcher, scenario orchestration (test fixtures shared by all e2e files)
- [ ] Additive core subpath (vitest-free reference issuer) + `createLicenseIssuerClient`; additive `@stint/proxy/testing` `forceNextExpiresIn` (and optional revoke counter)
- [ ] CLI edits: hybrid predicate, loopback-insecure derivation, `runLease` extensions (license custody + wrapper, teardown steps, endpoints map, optional `verifyOutcome`), `create --publisher` + persistence, `createRealDeps`/`runLease` barrel exports, publisher-aware teardown-support

## Security Domain

`security_enforcement` is true in `.planning/config.json` (ASVS level 1, block on high).

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | yes (OAuth acquisition) | `oauth4webapi` auth-code + PKCE S256 + `state`; public client (`None`) |
| V3 Session Management | no (no user sessions) | — |
| V4 Access Control | yes | deny-by-default policy in core; scripted adapter cannot allow; ungranted tools hidden and denied |
| V5 Input Validation | yes | profile/credentials/publisher-binding parsers with fixed-text errors (existing pattern); mock servers validate bearer/JSON and reject malformed bodies |
| V6 Cryptography | yes | `paseto`, `jose`, `node:crypto` only; no hand-rolled signing; fresh `jti` per cleanup attempt |
| V7 Error/Logging | yes | no tokens/license/secrets in logs, receipts, errors, stdout (stdout is the MCP channel); assert in tests |
| V9 Communications | yes | `https` or loopback-`http` only for AS, publisher and hook URLs; insecure flag derived, never global |
| V14 Configuration | yes | publisher key is non-secret PASERK public key; secret key stays in the mock publisher process |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Access token leaks to agent via tool result/error | Information disclosure | vault `scrubCredential/scrubError`; e2e asserts token absent from every agent-visible payload and the receipts |
| License forwarded to a customer resource | Information disclosure | connector `credential` is `{ accessToken }` only; mock services record all headers/bodies and the test asserts no `v4.public.` token ever arrives (LIC-05) |
| Prompt-injected agent calls an ungranted tool | Elevation of privilege | `no_binding` deny; hidden from `tools/list`; denied receipt |
| Approval satisfied through the agent's channel | Spoofing | approvals only via HostAdapter/controlling terminal, never MCP elicitation |
| Cleanup token replay | Replay | fresh `jti` per attempt; mock hook rejects a seen `jti` |
| Authorization-code injection / CSRF | Tampering | PKCE verifier + `state` checked by `validateAuthResponse` |
| Terminal-escape injection from receipts/manifest text | Tampering | existing `sanitizeForTerminal` in timeline and consent rendering |
| Insecure-transport relaxation reaching production endpoints | Information disclosure | loopback-only derivation with a negative test (non-loopback http stays refused) |
| Hidden-console spawn silently auto-approving | Elevation of privilege | fail-safe direction pinned by test: no console/answer => deny |
| Stale/forged publisher license | Spoofing | `verifyLicense` with pinned publisher public key before minting `HeldLicense` |

## Project Constraints (from CLAUDE.md)

- pnpm monorepo, TypeScript 5.9 strict, ESM-only, Node >=22.18 (CI on 22.18.0 and 24), Vitest, tsdown; cross-platform (Windows developer). Invoke pnpm as `npx --yes pnpm@12.6.0` in this environment (memory).
- Libraries fixed: `@modelcontextprotocol/sdk`, `oauth4webapi`, `paseto` (panva), `jose`, `ajv`, `json-schema-to-typescript`, `oauth2-mock-server`; `node:crypto` for hashing; **no hand-rolled crypto**. Any new dependency needs a stack sign-off (none proposed).
- Security: deny by default; enforcement never delegated to the model; no secrets in logs or receipts; no credentials exposed to the agent; license never forwarded to customer resources.
- Testing: tests for every state transition, every teardown path including partial failure, and scope denial.
- Access vocabulary fixed `read | write | send | pay`; License Apache-2.0.
- GSD workflow enforcement: file changes go through a GSD command; whole-repo vitest/eslint OOM in the sandbox so scope runs per package/file (memory); worktrees disabled (phases run sequentially).
- Project skills: none found in `.claude/skills/`.

## Sources

### Primary (HIGH confidence)
- Repo source read this session: `packages/cli/src/{commands/run.ts, commands/create.ts, commands/teardown-support.ts, commands/revoke.ts, commands/cleanup.ts, commands/receipts.ts, run/run-lease.ts, run/terminal.ts, run/profile.ts, run/credentials.ts, deps.ts, program.ts, real-deps.ts, index.ts, trust/trust-store.ts, store/envelope.ts, keys/runtime-key.ts}`; `packages/proxy/src/{server.ts, dispatch.ts, testing.ts, index.ts, revocation.ts, connectors/outbound-connector.ts, vault/*.ts, teardown/steps.ts, teardown/cleanup-client.ts, teardown/cleanup-token.ts, teardown/orchestrate.ts, verification/*.ts}`; `packages/core/src/{license/*.ts, testing.ts, host-adapter.ts, bindings.ts, activate.ts, policy.ts, index.ts}`; `spec/ALP.md` §7.4, 7.5, 8, 9, 10, 11, 13; `spec/manifest.schema.json` (CleanupHook pattern line 236); `spec/vectors/valid/payment-reconciler.json`; `.github/workflows/ci.yml`; `vitest.config.ts`; `pnpm-workspace.yaml`; `tsconfig.json`; `.planning/{REQUIREMENTS,WINDOWS}.md`, `06-UAT.md`, `packages/cli/manual/*`, `packages/cli/test/helpers/*`.
- `@modelcontextprotocol/sdk@1.30.1` tarball (`dist/esm/client/stdio.js`, `stdio.d.ts`): `windowsHide: process.platform === 'win32'` at line 73; `StdioServerParameters` has no windowsHide option.
- `oauth2-mock-server@9.2.0` tarball (`dist/oauth2-server-BKcc5jqv.mjs`): authorize handler, token handler, PKCE, revoke handler.
- `oauth4webapi@3.8.8` tarball `build/index.d.ts`: signatures of `validateAuthResponse`, `authorizationCodeGrantRequest`, `processAuthorizationCodeResponse`, PKCE/state helpers.
- `paseto@4.0.1` tarball (`README.md`, `v4/public.d.ts`): PASERK import/export factories.
- Experiment scripts (scratch dir) executed on Node 26.8.2: full PKCE acquisition, forced short `expires_in`, refresh with rotation, RFC 7009 revoke, insecure-request refusal.

### Secondary (MEDIUM confidence)
- `gsd-tools query package-legitimacy check` output (SUS verdicts all `too-new`, recognized as heuristic on actively maintained pinned packages).

### Tertiary (LOW confidence)
- pnpm workspace bin-shim timing behavior (A6); Node 22.18/24 manual-redirect behavior (A3); vitest import-outside-runner behavior (A4): not verified in this session.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - all pins already in repo; APIs verified from tarballs and a live experiment.
- Architecture: MEDIUM - the recommended composition (shared `runLease`, publisher persistence, `verifyOutcome`) is my design over verified gaps; several items need user confirmation (Open Questions 1-5, A1, A2, A5, A9).
- Pitfalls: HIGH for Pitfalls 1-6 (each backed by a quoted source line); MEDIUM for 7-12 (reasoned from code).

**Research date:** 2026-09-30
**Valid until:** 2026-10-30 (pinned stack; the paseto 4.x API is 4 weeks old, re-check if the pin moves)
