# Phase 7: End-to-End Example & README - Pattern Map

**Mapped:** 2026-09-30
**Files analyzed:** 22 (new/modified)
**Analogs found:** 21 / 22

All analog paths verified present and git-tracked (`git ls-files` on core/license, proxy/testing.ts, cli/manual, cli/test/helpers). No gitignored mirror paths are cited.

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match |
|---|---|---|---|---|
| `examples/payment-reconciler/package.json` | config | n/a | `packages/cli/package.json` | exact |
| `examples/payment-reconciler/tsconfig.json` | config | n/a | `packages/cli/tsconfig.json` | exact |
| `examples/payment-reconciler/tsdown.config.ts` (optional; tsx-run may suffice) | config | n/a | `packages/cli/tsdown.config.ts` | exact |
| `examples/payment-reconciler/vitest.config.ts` | config | n/a | `packages/cli/vitest.config.ts` | exact |
| `pnpm-workspace.yaml` (add `examples/*`) | config | n/a | itself | modify |
| root `vitest.config.ts` (projects) | config | n/a | itself | modify |
| root `tsconfig.json` (reference) | config | n/a | itself | modify |
| root `eslint.config.js` (allowDefaultProject) | config | n/a | itself | modify |
| `.github/workflows/ci.yml` (+ e2e step) | config | CI | itself | modify |
| `examples/.../src/agent.ts` (MCP Client stub) | service | request-response | `packages/cli/manual/mcp-call-visible.mjs` + `packages/cli/test/run-approvals.test.ts` | role-match |
| `examples/.../src/scripted-adapter.ts` | provider | event-driven | `packages/cli/src/adapter/terminal-host-adapter.ts` + contract `packages/core/src/host-adapter.ts` | role-match |
| `examples/.../src/host-launcher.ts` (visible-console Transport) | utility | streaming | `packages/cli/manual/mcp-call-visible.mjs` (`ChildStdioTransport`) | exact |
| `examples/.../src/mocks/*.ts` (paystack, sheets, publisher servers) | service | request-response | `packages/proxy/src/testing.ts` (`startMockAuthServer`) | role-match |
| `examples/.../src/oauth-acquire.ts` | service | request-response | `packages/cli/src/run/profile.ts` (`as` construction) + `packages/proxy/src/testing.ts` (discovery) | role-match |
| `examples/.../test/e2e.test.ts` | test | request-response | `packages/cli/test/run-approvals.test.ts`, `packages/cli/test/helpers/run-fixture.ts` | role-match |
| `examples/.../test/stdio-smoke.test.ts` | test | streaming | `packages/cli/test/run-stdio-smoke.test.ts` | exact |
| `examples/.../test/launcher.test.ts` (windowsHide guard) | test | n/a | `packages/cli/manual/mcp-call-visible.mjs` | partial |
| `packages/core/src/license/license-issuer-client.ts` + new subpath (e.g. `@stint/core/license-issuer`) | service | request-response | `packages/core/src/testing.ts` `createMockLicenseIssuer` (l.378-) + `license/license-issuer.ts` | role-match |
| `packages/core/package.json` + `tsdown.config.ts` (new export/entry) | config | n/a | `./testing` export entry in same files | exact |
| `packages/cli/src/commands/run.ts` (hybrid predicate) | controller | request-response | itself l.66-78 | modify |
| `packages/cli/src/commands/teardown-support.ts` (hybrid, license collaborator, loopback) | service | CRUD | itself l.86-125 | modify |
| `packages/cli/src/commands/create.ts` (`--publisher`, lift l.94-101) + `program.ts` | controller | request-response | itself | modify |
| `packages/cli/src/run/run-lease.ts` (loopback vault, endpoints fetch wrapper, teardownSteps, `verifyOutcome`) | service | request-response | itself l.31-130 | modify |
| `packages/cli/src/run/profile.ts` (optional `endpoints` map) | utility | transform | itself l.107-140 | modify |
| `README.md` | docs | n/a | none | no analog |

## Pattern Assignments

### Workspace package config (package.json / tsconfig / tsdown / vitest)

**Analog:** `packages/cli/package.json`, `tsconfig.json`, `tsdown.config.ts`, `vitest.config.ts`

package.json shape (keep `private`, `type: module`, `engines`, `workspace:*` deps, exact-pinned third-party versions):
```json
{ "name": "@stint/cli", "version": "0.0.0", "private": true, "license": "Apache-2.0", "type": "module",
  "engines": { "node": ">=22.18.0" },
  "scripts": { "build": "tsdown", "test": "vitest run" },
  "dependencies": { "@modelcontextprotocol/sdk": "1.30.1", "@stint/core": "workspace:*", "@stint/proxy": "workspace:*", "@stint/spec": "workspace:*" } }
```
For the example: name `@stint/example-payment-reconciler`, add `@stint/cli` as workspace dep only if importing `main`; `oauth2-mock-server` is already pinned `9.2.0` in `packages/proxy` devDependencies (reuse the same exact pin, or go via `@stint/proxy/testing`). Use `"build": "tsc -b"` or omit the build script if tsx runs it (note `pnpm build` is `pnpm -r build` and root `pnpm test` runs it first, so a build that needs `@stint/cli/dist` must be order-safe via workspace dep). Add a root script `"example:payment-reconciler"` (D-11) next to `check:alp` in root `package.json` scripts (l.11-21); prefer `tsx` invocation (CLAUDE.md stack).

tsconfig (`packages/cli/tsconfig.json`):
```json
{ "extends": "../../tsconfig.base.json",
  "compilerOptions": { "composite": true, "rootDir": ".", "outDir": ".tsc", "emitDeclarationOnly": true },
  "include": ["src", "test"],
  "references": [{ "path": "../core" }, { "path": "../proxy" }, { "path": "../spec" }] }
```
For `examples/payment-reconciler` the extends is `../../tsconfig.base.json` (same depth) but references become `../../packages/core|proxy|spec|cli`. Add `{ "path": "examples/payment-reconciler" }` to root `tsconfig.json` references (currently lists packages/spec, core, proxy, cli).

tsdown (`packages/cli/tsdown.config.ts`): must keep `fixedExtension: false`, `format: "esm"`, `platform: "node"`.

vitest (`packages/cli/vitest.config.ts`): copy `testTimeout: 60_000` with the Windows-IO comment. Root `vitest.config.ts` currently `projects: ["packages/*"]`; change to `["packages/*", "examples/*"]` OR (D-04, dedicated project) keep the e2e out of the default run and give it its own CI step `pnpm --filter @stint/example-payment-reconciler test`. Decide in plan; MEMORY note: whole-repo vitest OOMs, so scope runs (`--pool=threads`).

eslint (`eslint.config.js`): `allowDefaultProject` lists `"packages/*/tsdown.config.ts", "packages/*/vitest.config.ts"`; add `examples/*/...` equivalents if the example has these config files, and confirm `.mjs` files are covered by the `disableTypeChecked` block.

CI (`.github/workflows/ci.yml`): matrix already `ubuntu-latest`/`windows-latest` x Node `22.18.0`/`24`; steps end `pnpm test`. Add after `pnpm test`:
```yaml
      - run: pnpm --filter @stint/example-payment-reconciler test
```
(`pnpm build` precedes, so `packages/cli/dist/bin.js` exists for D-03.)

---

### `examples/.../src/agent.ts` (MCP Client stub, request-response)

**Analog:** `packages/cli/manual/mcp-call-visible.mjs` l.13-14, 64-76; in-process variant `packages/cli/test/run-approvals.test.ts` l.12, 59.

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
const client = new Client({ name: "manual-uat-visible", version: "0.0.0" });
await client.connect(transport);            // injected Transport (InMemory half, or ChildStdioTransport)
const { tools } = await client.listTools();
const result = await client.callTool({ name: "send_notice", arguments: { to: "alice" } });
result.isError === true
await client.close();
```
In-process: `const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();` (import `@modelcontextprotocol/sdk/inMemory.js`); pass `serverTransport` as `runLease({ transport })`. The agent takes a `Transport` parameter so the same script serves both harness and launcher. It must never import license/vault code. Assert no secret substring in `JSON.stringify(result)` (as mcp-call-visible l.78).

---

### `examples/.../src/scripted-adapter.ts` (HostAdapter, event-driven)

**Analog:** contract `packages/core/src/host-adapter.ts` (three async methods `requestConsent`, `requestApproval`, `notify`, plus the outcome-confirm method for `user_confirm`; check l.90+ of that file for the exact `HostAdapter` interface before writing). Reference implementation `packages/cli/src/adapter/terminal-host-adapter.ts` (imports l.1-17).

Types to return:
```ts
type ApprovalDecision = { decision: "approve" } | { decision: "deny"; reason: "user_denied" | "timeout" };
type ConsentDecision = { decision: "grant" } | { decision: "decline"; reason: "user_declined" | "timeout" };
type OutcomeConfirmDecision = { decision: "confirm" } | { decision: "reject"; reason: "user_rejected" | "timeout" };
```
Import types from `@stint/core` (`ApprovalRequest`, `ConsentRequest`, `HostAdapter`, `LifecycleEvent`, `OutcomeConfirmRequest`, ...). Rules from the file header: the adapter only PROPOSES, core owns timeout/deny-by-default (D-17); an adapter throw must become deny (`NoTerminalError`/`NoAnswerError` pattern at l.23-38). Script shape: per-call queue keyed by `ApprovalRequest.binding.tool` or ordinal, plus a `revokeAfter` hook the test triggers; record every `notify(LifecycleEvent)` for assertions. `ApprovalRequest` has only `approvalId`, `summary`, `binding` (no raw args, D-18).

---

### `examples/.../src/host-launcher.ts` (visible-console Transport, streaming)

**Analog:** `packages/cli/manual/mcp-call-visible.mjs` l.9-14, 24-62 (copy nearly verbatim, typed as `Transport` from `@modelcontextprotocol/sdk/shared/transport.js`).

```js
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
class ChildStdioTransport { /* start(): stdout "data" -> ReadBuffer.readMessage -> onmessage; "close" -> onclose
   send(): child.stdin.write(serializeMessage(message)); close(): stdin.end(); child.kill() */ }
const child = spawn(process.execPath,
  [BIN, "--store", store, "run", lease, "--profile", profilePath, "--credentials", credsPath],
  { stdio: ["pipe", "pipe", "inherit"], windowsHide: false });
```
BIN resolution: `path.resolve(dirname(fileURLToPath(import.meta.url)), "../dist/bin.js")` in the analog; for the example resolve `@stint/cli` bin via `createRequire`/workspace path (`packages/cli/dist/bin.js`). D-09 guard: make the spawn function injectable (`spawnFn = spawn`) so a test asserts `opts.windowsHide === false`; the hidden-console counterpart is `packages/cli/manual/mcp-call.mjs` (SDK `StdioClientTransport`, which forces `windowsHide: true`). The `RunSeams` (`packages/cli/src/deps.ts` l.38-41: `openTerminal?`, `createTransport?`) are for the SERVER side (in-process `main`), not for host spawning; the launcher is host-side, so `RunSeams` fit only the in-process harness.

---

### Mock servers (paystack / sheets / publisher, request-response)

**Analog:** `packages/proxy/src/testing.ts` l.103-195 (`MockAuthHarness`: start, observable counters, one-shot fault hook, `stop()`).

Pattern to copy: a `startX(): Promise<XHarness>` returning `{ url, <observation getters>, forceNextError(...), stop() }`; always `stop()` in `afterEach`/`finally`. Use plain `node:http` bound to `127.0.0.1` with port 0 (D-06; no new dev dep). Publisher harness exposes: `POST /license` (sign via a `createMockLicenseIssuer`-style PASETO issuer, i.e. `@stint/core` issuance primitives, idempotent re-sign per D-18), `POST /cleanup` (toggle `failNextCleanup` for D-10, mirroring `forceNextTokenError`), and counters. Services harnesses record received `Authorization` headers (prove proxy-injected token, and assert the license is never seen by customer services).

Mock AS: reuse `startMockAuthServer()` directly (`@stint/proxy/testing`, `MockAuthHarness.oauthClient` is `{ as, client: { client_id: "stint-test-client" }, clientAuth: oauth.None() }`). Note it binds `localhost`, issuer URL is `http://localhost:<port>`; hence D-16's loopback rule must include `localhost`.

---

### `examples/.../src/oauth-acquire.ts` (auth-code + PKCE, request-response)

**Analog:** `packages/cli/src/run/profile.ts` l.107-125 builds `as: { issuer, token_endpoint, revocation_endpoint? }` and `clientAuth: (_as, client, body) => ...`; discovery in `packages/proxy/src/testing.ts` l.160-170:
```ts
const discoveryResponse = await oauth.discoveryRequest(new URL(issuerUrl), {
  algorithm: "oidc",
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  [oauth.allowInsecureRequests]: true,
});
const as = await oauth.processDiscoveryResponse(new URL(issuerUrl), discoveryResponse);
```
Acquisition API (`oauth4webapi@3.8.8`): `oauth.generateRandomCodeVerifier`, `calculatePKCECodeChallenge`, `validateAuthResponse`, `authorizationCodeGrantRequest`, `processAuthorizationCodeResponse`. Output is written to the credentials file consumed by `packages/cli/src/run/credentials.ts` (`loadCredentials`/`seedVaultFromCredentials`; read that file's `SeededCredential` shape before planning). Keep the eslint-disable comment for the deprecated insecure flag, and only enable it for loopback (D-16).

---

### `@stint/core` license-issuer subpath + `createLicenseIssuerClient`

**Analog (export mechanics):** `packages/core/package.json` `exports["./testing"]` = `{ "types": "./dist/testing.d.ts", "import": "./dist/testing.js" }` and `packages/core/tsdown.config.ts` `entry: ["./src/index.ts", "./src/testing.ts"]`. Add `"./license-issuer"` export and a third entry; vitest stays an OPTIONAL peer only for `./testing`, so the new subpath must not import vitest.
**Analog (issuer logic):** `packages/core/src/testing.ts` l.378-(`MOCK_LICENSE_ISSUER_KID`, `MockLicenseIssuer extends LicenseIssuer`, `createMockLicenseIssuer`) and port `packages/core/src/license/license-issuer.ts` l.19-55 (`kid`, `issue`, `reissue`, `invalidate`).

Client must: call publisher over HTTP, run `verifyLicense` (exported from `packages/core/src/index.ts` l.54) on the returned token before wrapping as `HeldLicense`, and clamp via `clampedLicenseExpiry(now, DEFAULT_LICENSE_TTL_SECONDS, leaseExpiresAt)` returning `null` when lapsed (LIC-03); `invalidate(leaseId)` idempotent. Helpers already exported from root: `needsRefresh`, `clampedLicenseExpiry`, `DEFAULT_LICENSE_TTL_SECONDS`, `verifyLicense`, `readLicenseToken`, types `HeldLicense`, `LicenseIssuer`, `LicenseClaims`. `mintHeldLicense`/`issueLicense`/`createMockLicenseIssuer` stay unexported from root (`public-api` tests in `packages/cli/test/public-api.test.ts` and any core public-api test must be updated to pin the new subpath).

---

### CLI edits (modify in place)

**`packages/cli/src/commands/run.ts` l.66-78** (hybrid predicate):
```ts
const delegated = resolveAuthMode(verified.manifest) === "delegated";
if (delegated && (opts.credentials === undefined || opts.credentials === "")) { throw new CliError(EXIT_CODES.usage, "--credentials <file> is required for a lease with delegated auth."); }
```
Change predicate to `mode === "delegated" || mode === "hybrid"`. Also thread a license-issuer client and `deps.run` seams into `runLease` (l.99-108).

**`packages/cli/src/commands/teardown-support.ts` l.90-125**: same `delegated` predicate (l.90, 94, 102) to hybrid-aware; the vault already takes `deps.teardown?.allowInsecureRequests === true ? { allowInsecureRequests: true } : {}` (l.108), replace/augment with the loopback-derived rule (shared helper, e.g. `isLoopbackHttp(url)` used by both run-lease and teardown-support; unit tests incl. the mandatory non-loopback negative test, D-16). `createDefaultTeardownSteps(receiptStore, privateKey, vault, undefined, cleanup)` has `undefined` in the license-collaborator slot: pass the real collaborator (D-14).

**`packages/cli/src/run/run-lease.ts`**:
- l.96 `createCredentialVault(profile.oauth, clock)` gains third arg `{ allowInsecureRequests }` (as in teardown-support l.105-109 shape).
- l.113 `createRestOutboundConnector(options.outboundFetch)`: wrap `outboundFetch` with the profile `endpoints` resource->URL map (resource identifier to loopback URL).
- l.115-117 comment says `teardownSteps` deliberately omitted; supply real `teardownSteps` (built like `createDefaultTeardownSteps` in teardown-support).
- `RunningLease` (l.48-53: `closed`, `close`) gains `verifyOutcome()` (D-15), host-side only, never exposed as an MCP tool.
- `RunLeaseOptions` (l.31-46): add optional `licenseIssuer`; keep `deps: Pick<CliDeps, ...>`.

**`packages/cli/src/commands/create.ts` l.94-101**: replace the hosted refusal (`"Hosted license issuance is not available in this phase..."`) with: require `--publisher <file>` for non-delegated, issue once via the client as the activation guard (D-18), persist the publisher file beside the lease, then proceed to step 4. Register the option in `packages/cli/src/program.ts` like the existing `--profile`/`--credentials` options (check how `run` declares them; `RunOpts`/`TeardownCommandOpts` interfaces). The existing test asserting the refusal in `packages/cli/test/create.test.ts` must be rewritten.

**`packages/cli/src/run/profile.ts`**: optional `endpoints` map parsed with the same `isRecord`/`str`/`optUrl` helpers used for `as` (l.107-125); all parse errors go through `bad()` (l.40, generic message, never echo content).

---

### Tests (`examples/.../test/*.test.ts`)

**In-process e2e analog:** `packages/cli/test/run-approvals.test.ts` (InMemoryTransport pair, fake terminal) and `packages/cli/test/helpers/run-fixture.ts` (creates a real ACTIVE lease through `main()` `stint create` on a temp store; exports `createRunFixture`, `ACCESS_TOKEN`, `PROFILE_JSON` with `catalog`/`bindings`/`oauth`). Also `packages/cli/test/helpers/cli-harness.ts` (`createHarness`, `delegatedManifest`, `writeSignedManifest`, `NOW`) and `teardown-rig.ts` for the partial-failure/retry scenario. The example e2e cannot import cli `test/helpers` (not exported); replicate the pattern or drive `main(argv, deps)` from `@stint/cli` (check `packages/cli/src/index.ts` exports and `real-deps.ts`). Manifest base: `spec/vectors/valid/payment-reconciler.json` (signed via `@stint/spec/testing`-style helpers; see `writeSignedManifest`).

**Spawned smoke analog:** `packages/cli/test/run-stdio-smoke.test.ts` l.12-60 (BIN path `../dist/bin.js`, `existsSync` guard with "run `pnpm build`" message, 1s approval window so the child self-denies, `StdioClientTransport({ command: process.execPath, args: [BIN, "--store", root, "run", leaseId, "--profile", ..., "--credentials", ...], stderr: "pipe" })`, `{ timeout: 60_000 }`, `afterEach` closes client and harness).

Every e2e scenario needs: happy path to `cleaned_up`, denied out-of-scope, approved call, revoke mid-run, partial teardown (publisher `/cleanup` fails -> `cleanup_incomplete`, retry -> `cleaned_up`). Assert with `mergeTimeline` from `@stint/core` (`packages/core/src/receipts/merge.ts`) and mock-server counters.

## Shared Patterns

### Injected seams, no direct `process.*`
**Source:** `packages/cli/src/deps.ts` l.55-84 (`CliDeps`), `RunSeams` l.38-41, `TeardownSeams` l.49-53. **Apply to:** all CLI edits and the launcher. New seams are optional members; production leaves unset.

### Error safety
**Source:** `packages/cli/src/commands/run.ts` l.117-128: `CliError` -> `stint: ${error.safeMessage}` on stderr, else `"stint: Internal error."`; stdout is the MCP channel and must never be written by `run`. **Apply to:** publisher/AS failures in `create`/`run` (never echo upstream text, tokens, or license).

### Deny-by-default in adapters
**Source:** `packages/core/src/host-adapter.ts` header l.17-24. **Apply to:** scripted adapter; throws/aborts never become approvals.

### Loopback-only mock harness lifecycle
**Source:** `packages/proxy/src/testing.ts` `startMockAuthServer` (l.128). **Apply to:** all mocks; `stop()` in `afterEach`.

### Windows IO timeouts
**Source:** `packages/cli/vitest.config.ts` `testTimeout: 60_000`. **Apply to:** example vitest config.

### Tracked-source gate
Only cite tracked paths; do not use `.gsd/capabilities/**` mirrors (none were touched here).

## No Analog Found

| File | Role | Data Flow | Reason |
|---|---|---|---|
| `README.md` (DOC-01) | docs | n/a | No README exists to copy; use `packages/cli/manual/README.md` only for tone and `spec/ALP.md` sections 5, 8, 10, 11, 13 for content |
| `oauth-acquire.ts` auth-code+PKCE flow | service | request-response | No acquisition code exists in repo (Phase 6 used pre-seed only); use RESEARCH.md pattern + `oauth4webapi` API, only the `as` construction and discovery have analogs |

## Metadata

**Analog search scope:** `packages/cli/{src,test,manual}`, `packages/core/src`, `packages/proxy/src`, root config, `.github/workflows`
**Files scanned/read:** ~20 (targeted excerpts)
**Pattern extraction date:** 2026-09-30
