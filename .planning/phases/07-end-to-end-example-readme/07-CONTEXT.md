# Phase 7: End-to-End Example & README - Context

**Gathered:** 2026-09-30
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 7 proves the whole runtime end to end and makes it approachable:

1. **`examples/payment-reconciler` (E2E-01):** a **hybrid-mode** example — licensed by a **mock publisher**, reading **mocked Paystack** transactions **through OAuth**, writing to a **mocked orders sheet**, entirely through the proxy. The "agent" is a real MCP **client** (a deterministic stub) that drives a fixed sequence of tool calls; every call is governed by the already-shipped lease runtime.
2. **Cross-platform e2e test (E2E-02):** passes on **Linux and Windows CI**, covering the happy path to `cleaned_up`, a denied out-of-scope call, an approved call, a **user revoke mid-run**, and a **partial teardown failure** landing in `cleanup_incomplete`.
3. **README (DOC-01):** explains the problem, the **three auth modes**, the **trust limits of hosted mode**, and a **quickstart that works verbatim** on a fresh clone.

**This phase also closes two deferrals Phase 6 pushed here** (06-CONTEXT.md):
- **Hybrid/hosted license issuance** into the `create`/`run` path (Phase 6 A8 refused hosted/hybrid at consent "until Phase 7 license issuance").
- **OAuth grant acquisition** to seed the vault (Phase 6 D-02 used only the pre-seed seam).

**And it resolves the Phase 6 UAT deferred follow-up:** on Windows, an MCP host that spawns `stint run` via the SDK's `StdioClientTransport` (`windowsHide: true`) hides the console, so the controlling-terminal (`CONIN$`/`CONOUT$`) approval prompt is invisible and every approval-gated call times out and denies (fails **safe**). Phase 7 makes the example host + quickstart work on Windows and guards the behavior against silent regression.

**Not in this phase:** real payment execution or real Paystack/Sheets (mocked only — `pay` enforced, never executed, per REQUIREMENTS Out of Scope); npm publishing/release pipeline (v0.1 done = e2e green + README); additional example agents, embeddable timeline UI, additional LeaseStore backends (all v2); redesigning the run transport topology — the **controlling-terminal topology is kept** (Phase 6 06-06 D), only the *host-spawn* side is made visible-console on Windows.

Requirements: **E2E-01, E2E-02, DOC-01**.

</domain>

<decisions>
## Implementation Decisions

### Example structure & agent embodiment
- **D-01:** `examples/payment-reconciler` is its own workspace package. The "agent" is a **real MCP `Client`** (`@modelcontextprotocol/sdk`) stub that issues a **deterministic scripted sequence** of `tools/call`s designed to hit each E2E-02 scenario (a scoped read, a scoped write, an out-of-scope call → deny, a `send`/`pay`-class call → approval). It holds **no credentials and never sees the license** — everything flows through the proxy. Base its manifest on `spec/vectors/valid/payment-reconciler.json`.
- **D-02:** **Automated e2e drives the full real stack** — real `createLeaseProxyServer`, JSON `LeaseStore`/receipt store, mock AS, mock publisher, mock customer services — but wires a **scripted test `HostAdapter`** so approve / deny / `user_confirm` / revoke are **deterministic and tty-free** on both OSes. This is what lets E2E-02 pass on Windows + Linux CI without a real terminal. — **Reversibility:** costly — this harness is the E2E-02 proof surface; the test suite and the example's public shape depend on it.

### E2E test topology & CI
- **D-03:** Add an **automated smoke test that spawns the built `stint run` binary** over MCP stdio (a `tools/list` + one call), proving the shipped CLI + transport wiring boots end to end. Approvals there are limited to **deny-by-timeout** (no tty in CI); the approve/deny/revoke *decisions* are proven by D-02's harness. Catches `bin`/build/transport regressions the in-process harness can't.
- **D-04:** The example e2e runs as a **dedicated vitest project / CI step** that **starts and stops the mock servers in its own process**, separate from the unit suites, on **Linux and Windows**. Keeps runs scoped (aligns with the repo's known full-repo OOM behavior) and gives a distinct e2e signal. — **Reversibility:** costly — the CI wiring + project split is what makes the Windows/Linux e2e gate real; changing it reshapes CI and the test entrypoints.

### OAuth & customer-service mocking
- **D-05:** The example performs a **real auth-code + PKCE grant acquisition and vault refresh against `oauth2-mock-server`** (reuse `@stint/proxy/testing`'s `startMockAuthServer`/`MockAuthHarness`), closing Phase 6's deferred acquisition and genuinely exercising PRXY-06/08 and LIFE-05. "reads mocked Paystack **through OAuth**" becomes literally true. — **Reversibility:** costly — introduces the acquisition flow the run path did not previously have.
- **D-06:** Paystack-read and orders-sheet-write are **local `127.0.0.1` HTTP mocks** hit through the real `createRestOutboundConnector` with proxy-injected tokens (hermetic on CI, real socket, verifies no-secret-leak on a real outbound request). — **Reversibility:** reversible.

### Hybrid license issuance & custody
- **D-07:** A **mock publisher HTTP server** issues a **PASETO v4.public** license at activation; the **runtime obtains it and refreshes before TTL, never beyond lease expiry, never forwarding it to the agent or customer resources** (LIC-01/02/03/05). This **wires license issuance + custody into the run path** and closes Phase 6 A8. The runtime keeps using the **injected `LicenseIssuer` port** (`issueLicense`/`createMockLicenseIssuer` are intentionally not re-exported from `@stint/core`). — **Reversibility:** costly — adds per-run license custody and changes the create/run hybrid-mode gating Phase 6 stubbed out.

### Windows prompt channel & regression guard
- **D-08:** `examples/payment-reconciler` ships a **host launcher** that spawns `stint run` with a **visible console (`windowsHide: false`)** — via a custom stdio transport / child spawn, as `packages/cli/manual/mcp-call-visible.mjs` proved — so approval prompts render where the user can see and answer them. The **controlling-terminal topology is kept** (Phase 6 06-06); only the host-spawn side changes. The launcher uses the existing `RunSeams` (`createTransport`/`openTerminal`) where it fits. — **Reversibility:** costly — this launcher is the SC1/DOC-01 Windows-correctness surface the quickstart depends on.
- **D-09:** Regression guard is **automated + manual**: an automated test asserts the launcher spawns with `windowsHide: false` (and a unit test that a *hidden*-console spawn denies by timeout, pinning the guard's direction and the fail-safe property); `packages/cli/manual/` is **retained** as the human real-console check. — **Reversibility:** reversible.

### Teardown-failure injection
- **D-10:** The **partial-teardown-failure** scenario is induced by the **mock publisher's cleanup-hook endpoint returning an error**: the cleanup-hook step fails while revoke-OAuth and invalidate-license succeed → `cleanup_incomplete` with every step's result recorded; the **retry** (hook now succeeds) reaches `cleaned_up` (TEAR-04, idempotent, never returns to active). — **Reversibility:** reversible.

### Quickstart & README (DOC-01)
- **D-11:** The **verbatim quickstart is one wrapped command** (e.g. `pnpm example:payment-reconciler`) that starts the mocks + host + agent and prints the result; the README then **documents the individual `stint create/run/revoke/cleanup/receipts` lifecycle** for understanding. Maximizes "works as written" cross-platform while still teaching the CLI. — **Reversibility:** reversible.
- **D-12:** The demo/quickstart's success signal is the **merged `stint receipts` timeline** (verified/attested, ending in the terminal state) **plus a one-line summary** — surfacing the honest audit trail (the product's whole point) and doubling as the CLI-02 demo. — **Reversibility:** reversible.
- **D-13:** The README covers, in order: the **problem** MCP/OAuth leave open, the **three auth modes** (`delegated | hosted | hybrid`), the **trust limits of hosted mode** (spec §13), and the **quickstart**. — **Reversibility:** reversible.

### Claude's Discretion
- The exact agent call script (concrete tool names/args) provided each E2E-02 scenario is deterministically triggered.
- The mock-server implementation choice (plain `node:http` vs a tiny helper) provided it binds `127.0.0.1` and is hermetic on CI.
- File/module layout under `examples/payment-reconciler`, the exact wrapper-script name, and README section wording/structure.
- **How** the license-issuance and OAuth-acquisition seams are surfaced on `create`/`run` (e.g. a publisher/AS endpoint in the run profile vs a flag) provided the never-to-agent / never-to-customer and LIC-01/02/03/05 bounds hold and hybrid `create` no longer refuses as in Phase 6.
- Exact exit/reporting wording of the e2e assertions.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase-6 deferrals & the Windows finding (READ FIRST — this phase closes them)
- `.planning/phases/06-cli-reference-adapters/06-UAT.md` — "Notes / Deferred Follow-Ups": the Windows hidden-console approval-prompt finding this phase resolves (D-08/D-09)
- `.planning/phases/06-cli-reference-adapters/06-CONTEXT.md` — D-01/D-02 (`stint run` over MCP stdio; vault seed seam), the "Not in this phase" list handing E2E/README/OAuth-acquisition to Phase 7, and A8 (hosted/hybrid refused at create until Phase 7 license issuance → D-07)
- `packages/cli/manual/README.md` + `packages/cli/manual/mcp-call-visible.mjs` + `mcp-call.mjs` — the proven visible-console (`windowsHide:false`) vs hidden-console repro the launcher (D-08) and guard (D-09) are built from

### Protocol (normative — code MUST match)
- `spec/ALP.md` §5 — auth modes (`delegated | hosted | hybrid`, hybrid default): the README's three-modes section (D-13) and the hybrid example (D-01)
- `spec/ALP.md` §8 — license format (PASETO v4.public, TTL, refresh bounded by lease expiry): mock-publisher issuance + custody (D-07)
- `spec/ALP.md` §9 — approvals dispatched out of band via the HostAdapter, per-lease serialization: the scripted adapter (D-02) and visible-console prompt (D-08)
- `spec/ALP.md` §10 — teardown fixed 5-step order, idempotent retry, partial failure → `cleanup_incomplete`: the failure-injection + retry (D-10)
- `spec/ALP.md` §11 — receipts (dual chains, redacted summaries): the success-signal timeline (D-12)
- `spec/ALP.md` §13 — trust limits: the README hosted-mode trust-limits section (D-13)
- `spec/ALP.md` §14 — security: no secrets in output/errors; license never to agent/customer (D-06, D-07)

### The example's manifest
- `spec/vectors/valid/payment-reconciler.json` — the hybrid manifest the example agent is built on (D-01)

### Project scope & requirements
- `.planning/PROJECT.md` — ## Context (design-review decisions: license refresh vs extension, offline-verifiable revocation latency, `auth.delegated` list needs Paystack + Sheets) and ## Constraints
- `.planning/REQUIREMENTS.md` — E2E-01, E2E-02, DOC-01 acceptance text; Out of Scope (mocked payments only)
- `.planning/ROADMAP.md` §Phase 7 — goal + three success criteria

### Existing code (the surfaces Phase 7 consumes / extends)
- `packages/cli/src/commands/run.ts` — `stint run`: controlling-terminal wiring + injectable `deps.run` seams (D-08)
- `packages/cli/src/run/terminal.ts` — `openControllingTerminal` (`CONIN$`/`CONOUT$` on Windows) — the surface the finding is about (D-08/D-09)
- `packages/cli/src/deps.ts` — `RunSeams` (`openTerminal`, `createTransport`), `CliDeps` — the injection points the launcher/tests use (D-02/D-08)
- `packages/cli/src/run/run-lease.ts` — `runLease`/`RunLeaseOptions` (`outboundFetch`, `credentials`, injected `transport`/`adapter`) — where the e2e injects its harness (D-02/D-06)
- `packages/cli/src/commands/create.ts` — hybrid/hosted consent gating to be extended for license issuance (D-07, closes A8)
- `packages/proxy/src/testing.ts` — `startMockAuthServer`/`MockAuthHarness`, echo/throwing connector doubles (D-05)
- `packages/proxy/src/connectors/outbound-connector.ts` (exported `createRestOutboundConnector`) — the real outbound path the service mocks are hit through (D-06)
- `packages/core/src/license/*` + `packages/core/src/index.ts` (exports the `LicenseIssuer` **port**; `issueLicense`/`createMockLicenseIssuer` intentionally not re-exported) — the license custody seam (D-07)
- `packages/proxy/src/teardown/orchestrate.ts` — `runTeardown`/`retryTeardown` for the partial-failure + retry scenario (D-10)
- `packages/core/src/receipts/merge.ts` — `mergeTimeline` for the success-signal output (D-12)

### Stack & standards
- `.claude/CLAUDE.md` — pinned stack: `@modelcontextprotocol/sdk@1.30.1` (agent `Client` + stdio), `oauth4webapi`/`oauth2-mock-server` (OAuth + mock AS), `paseto@4.0.1` (license), Vitest projects, tsx/tsdown, Node 22.18+, ESM-only. Any new dev dep (e.g. a mock-server helper) needs research sign-off.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`runLease` injection seams** (`RunLeaseOptions`: `transport`, `adapter`, `outboundFetch`, `credentials`): the automated e2e harness (D-02) and HTTP-mock wiring (D-06) plug in here without new proxy logic.
- **`RunSeams` on `CliDeps`** (`openTerminal`, `createTransport`): the visible-console launcher (D-08) and the spawn/topology tests reuse these injection points.
- **`startMockAuthServer` / `MockAuthHarness`** (`@stint/proxy/testing`): the OAuth AS for the real acquisition/refresh flow (D-05).
- **`createRestOutboundConnector`** (`@stint/proxy`): the real outbound HTTP path the service mocks are exercised through (D-06).
- **Injected `LicenseIssuer` port** (`@stint/core`): the mock publisher backs this; the runtime never signs directly (D-07).
- **`runTeardown`/`retryTeardown`** + **`mergeTimeline`**: the partial-failure/retry scenario (D-10) and the success-signal timeline (D-12).
- **`packages/cli/manual/mcp-call-visible.mjs`**: the working `windowsHide:false` spawn the launcher (D-08) is modeled on.

### Established Patterns
- Enforcement outside the model, deny-by-default owned by core: the scripted test adapter (D-02) can never turn a hang/error/non-TTY into an allow — it only proposes; core owns the outcome.
- Pure/impure split: `examples/*` and test harness are I/O glue; no new policy/decision logic.
- Cross-platform / Windows-first: hermetic `127.0.0.1` mocks (D-06), `windowsHide:false` launcher (D-08), scoped/dedicated CI project (D-04) — all to keep the Windows e2e green.
- Additive-only to shipped contracts where possible; hybrid-mode license issuance (D-07) extends the create/run path Phase 6 deliberately stubbed.

### Integration Points
- Example agent (MCP `Client`) ⇄ `stint run`/`createLeaseProxyServer` (MCP server) — over a spawned visible-console stdio child in the quickstart (D-08); over an injected transport in the automated harness (D-02).
- Mock AS ⇄ vault (token acquisition/refresh, D-05); mock publisher ⇄ `LicenseIssuer` custody (D-07) and ⇄ teardown cleanup-hook (D-10); mock services ⇄ `createRestOutboundConnector` (D-06).
- README quickstart ⇄ the `pnpm example:*` wrapper (D-11) whose output is the merged receipts timeline (D-12).

</code_context>

<specifics>
## Specific Ideas

- The example is the milestone's capstone "proof by integration": one hybrid lease, licensed → OAuth-acquired → governed calls → approval → mid-run revoke → teardown (with a partial failure and retry) → honest receipts, all through the shipped runtime.
- The Windows fix is deliberately **structural, not prose**: a shipped launcher that spawns visible-console (D-08) plus an automated `windowsHide:false` assertion (D-09), so "the quickstart must not silently deny every approval" is enforced by code, not by a reader following instructions.
- Determinism is the CI contract: a scripted adapter (D-02) + hermetic `127.0.0.1` mocks (D-06) + a dedicated e2e project (D-04) are chosen precisely so all five E2E-02 scenarios pass reproducibly on Windows and Linux.

</specifics>

<deferred>
## Deferred Ideas

- Real Paystack/Sheets integrations and real `pay` execution — out of scope (mocked only, REQUIREMENTS Out of Scope).
- npm publishing / release pipeline — post-v0.1 (ECO-V2-01).
- Additional example agents (send-only, write-only) and an embeddable receipt-timeline UI — v2 (ECO-V2-02/03).
- Reconsidering the `spawn-child` run transport topology as a general Windows default — not needed once the example launcher spawns visible-console; revisit only if a host cannot provide a visible console.
- Driving the automated e2e through a real pty — rejected for CI (node-pty Windows flakiness); the human real-console path is covered by `packages/cli/manual/` (D-09).

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 07-end-to-end-example-readme*
*Context gathered: 2026-09-30*
