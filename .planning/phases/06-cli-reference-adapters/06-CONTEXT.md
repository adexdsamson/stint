# Phase 6: CLI & Reference Adapters - Context

**Gathered:** 2026-09-29
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 6 delivers the **`@stint/cli` command surface** and the **two reference plug-in implementations** that prove the runtime is drivable and extensible from outside `@stint/core`/`@stint/proxy`:

1. **CLI commands (CLI-01, CLI-02):** `create`, `run`, `inspect`, `revoke`, `cleanup`, `receipts` (+ `verify`), built on `commander@15`, driving the already-shipped runtime machinery (`createLeaseProxyServer`, `runTeardown`/`retryTeardown`, `mergeTimeline`, `verifyChain`, `reduce()`).
2. **Reference terminal `HostAdapter` (HOST-02):** renders consent from the manifest, prompts per-call approvals and `user_confirm` outcome verification in the terminal, and defaults to deny on timeout — implementing the published three-method `HostAdapter` contract (Phase 2 HOST-01) from outside core.
3. **JSON-file `LeaseStore` (HOST-03):** a Windows-safe, atomic-write, per-lease-locked implementation of the `LeaseStore` contract that passes the **same shared contract-test factory** as the in-memory double (Phase 2), plus a concurrent read/write test that runs on Windows CI.

The point of the phase is proof-by-implementation: the plug-in contracts (`HostAdapter`, `LeaseStore`) are shown implementable outside the packages that defined them, and a human can run the whole lease lifecycle from a terminal.

**Not in this phase:** the `examples/payment-reconciler` end-to-end example and its real agent, hybrid-mode e2e test, and the README (all Phase 7, E2E-01/02, DOC-01); interactive OAuth grant acquisition that seeds the vault from a real authorization server (deferred to Phase 7 — Phase 6 seeds via the existing vault seed seam from a local file/fixture); any automatic/background retry of `cleanup_incomplete` (v0.1 is explicit-retry-only, Phase 5 D-32); additional `LeaseStore` backends (v2).

Requirements: HOST-02, HOST-03, CLI-01, CLI-02.

</domain>

<decisions>
## Implementation Decisions

### CLI command surface & the `run` boundary (CLI-01)
- **D-01:** Phase 6 **ships a live `stint run <leaseId>`** that boots `createLeaseProxyServer` over MCP **stdio** with the reference terminal `HostAdapter` wired in. It is exercised **in-phase** by an in-process / mock MCP agent client that sends `tools/call`, so per-call approval, `user_confirm`, and timeout-deny are genuinely tested here — not only in Phase 7. Phase 7 then plugs in the real payment-reconciler agent. — **Reversibility:** costly — the run wiring (transport choice + adapter integration) is the SC#2 proof surface; other commands and tests depend on it.
- **D-02:** **Credentials for a run come from the existing Phase 4 vault seed seam**, seeded from a local file/fixture. Interactive OAuth grant acquisition against a real AS stays **deferred to Phase 7**. Phase 6 adds no new OAuth acquisition flow.
- **D-03:** **Command set:** `create`, `run`, `inspect`, `revoke`, `cleanup`, `receipts` (+ chain verification, see D-08). Lease-scoped commands take a **positional `<leaseId>`** (`stint inspect <leaseId>`, etc.). `stint create <manifest-path>` takes a **positional manifest path**, reads + verifies the manifest, renders consent, and prints the new lease id. Standard `commander` positional-arg shape.

### Consent & prompt UX (HOST-02)
- **D-04:** `stint create` renders a **human-readable sectioned consent summary** from the manifest: agent/publisher/version, scopes, limits (actions/hr, spend), approvals-required list, auth mode, outcome verifier, cleanup hook. It then prompts **`Grant this lease? [y/N]`** defaulting to **No** (deny-by-default) — Enter or anything but `y`/`yes` declines.
- **D-05:** Per-call **approval** and **`user_confirm`** prompts show the binding-redacted summary (approval) or verbatim verifier prompt (`user_confirm`) plus a **visible remaining-time countdown**. No answer before core's `AbortSignal` fires → **core** resolves deny/reject (timeout). **Non-interactive stdin** (piped/CI, `!isTTY`) never blocks — it returns control immediately so core's deny-by-default rule applies. The adapter **only ever proposes**; core's `awaitApprovalDecision` / `awaitOutcomeConfirmDecision` / `awaitConsentDecision` own the timeout→deny outcome (Phase 2 D-17). An adapter that hangs, errors, or sees no TTY can never become an approve/grant/confirm.

### Receipts timeline & verification (CLI-02)
- **D-06:** `stint receipts <leaseId>` default output is **one plain-language line per entry** from `mergeTimeline`, chronological, each tagged **`[verified]`** or **`[attested]`**, showing the action/transition and binding-redacted summary — never raw args or secrets (RCPT-01 / secretless-by-type).
- **D-07:** A **`--json` flag** emits the structured `TimelineEntry[]` (from `mergeTimeline`) for scripting and tests. `--json` output is always uncolored.
- **D-08:** Chain **verification is explicit**, not run on every print: a distinct verification command/flag (e.g. `stint verify <leaseId>` or `stint receipts <leaseId> --verify`; exact spelling is Claude's discretion) runs `verifyChain` on both the verified and attested chains. Clean → success message + entry count. Break → **non-zero exit** and a human message naming the exact **`brokenAtSeq`** and a plain reason mapped from the `verifyChain` `reason` enum (`hash_mismatch` / `reordered` / `truncated` / `checkpoint_sig_invalid`). — **Reversibility:** reversible — output wording is local; the exact-locus + non-zero-exit contract is fixed by the SC.

### JSON-file LeaseStore location & layout (HOST-03)
- **D-09:** **Store root defaults to `~/.stint`** (`os.homedir()`, cross-platform), **overridable** by a global `--store <dir>` flag and/or a `STINT_HOME` env var. Persists across working directories (leases are long-lived).
- **D-10:** **One JSON file per lease** (e.g. `leases/<id>.json`) and **separate receipt-chain file(s) per lease**; **`write-file-atomic@^7.0.1`** for every write (temp-file + atomic rename, NTFS-safe); **`proper-lockfile@4.1.2`** scoped **per-file** so different leases never contend, honoring the contract's "same id serialized, different ids concurrent" guarantee. — **Reversibility:** costly — the on-disk layout + lock granularity is what the Windows concurrency test and the shared contract suite validate; changing it later reshapes both the store and its tests.
- **D-11:** The JSON `LeaseStore` **must pass the existing shared `LeaseStore` contract-test factory** (Phase 2 `@stint/core/testing`) unmodified, **plus** a **concurrent read/write test that hammers a single lease's `transaction()` on Windows CI** proving no lost updates and no torn files. Same discipline for the receipt store persistence.

### CLI destructive-action semantics
- **D-12:** **`stint cleanup <leaseId>` is one command that auto-detects:** if the lease has not begun teardown it runs `runTeardown`; if it is in `cleanup_incomplete` it **resumes** via `retryTeardown` (idempotent, never re-runs completed steps, never returns to `active` — Phase 5 D-15/D-17/D-23). It prints the resulting state (`cleaned_up` / `cleanup_incomplete`) and points the user to `receipts`/`verify` for the signed per-step trail. Confirms with `[y/N]` before running, skippable with `--yes`.
- **D-13:** **`stint revoke <leaseId>`** prompts `[y/N]` (skippable `--yes`), drives a **user-actor revoke** that **auto-chains teardown** (Phase 5 D-18), then prints the resulting terminal/teardown state and directs the user to `receipts`/`verify`. Actor is `user`.

### CLI exit codes, errors & output styling
- **D-14:** **Exit codes:** `0` on success; **distinct non-zero codes** for the meaningful failure conditions — declined/timed-out consent, broken chain on verify, a `cleanup_incomplete` outcome, an invalid or failed-signature manifest, and lease-not-found. Human error messages go to **stderr**; under `--json`, errors emit a structured `{ error, code }` object. No secrets in error text (§14). — **Reversibility:** reversible — the code map is local, but keep it stable once published as CLI behavior.
- **D-15:** **Terminal styling via `picocolors`** (tiny, zero-dep, ESM) for consent headers, `[verified]`/`[attested]` tags, and pass/fail — **automatically degrading to plain text** when `NO_COLOR` is set or stdout is not a TTY. `--json` output is always uncolored. **NOTE:** `picocolors` is **not yet in CLAUDE.md's stack table** — research MUST confirm the version/pin and add it to the stack, or the planner falls back to plain text only (D-15 alt). — **Reversibility:** reversible — styling is cosmetic; plain-text fallback is the safe default if the dep is rejected.

### Claude's Discretion
- Exact `commander` wiring / file layout in `@stint/cli` (command modules, `bin` shebang via `tsdown`), and the precise `--help` text.
- The exact spelling of the verification command/flag (D-08: `stint verify <id>` vs `receipts --verify`) and the exact human wording of consent, timeline, break-locus, and error messages.
- The concrete claim/field layout of per-lease JSON files and the receipt-chain file(s) on disk (D-10), provided atomic-write + per-lease-lock invariants and the contract suite hold.
- The exact exit-code integer map (D-14), provided each SC failure condition yields a distinct non-zero code.
- Whether a prompt library is used for the interactive prompts (D-04/D-05) or they are hand-rolled over `readline`, provided deny-by-default, the countdown, and non-TTY handling hold and no new heavyweight dep is pulled in without research sign-off.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Protocol (normative — code MUST match)
- `spec/ALP.md` §6 — consent: the lease is granted or declined at consent time (renders the `create` consent screen, D-04)
- `spec/ALP.md` §7.1–7.4 — states/events/actors/transition table: `revoke` (actor `user`), `begin_teardown`, `retry_teardown` (user + runtime), the terminal + teardown states the CLI drives/reports (D-12, D-13)
- `spec/ALP.md` §7.6 — outcome verification (`resource_query`/`user_confirm`/`none`): the `user_confirm` prompt the terminal HostAdapter renders (D-05)
- `spec/ALP.md` §9 — approvals dispatched out of band through the HostAdapter, never via MCP elicitation through the agent's own client; per-lease serialization (governs D-05 and the JSON store's serialization guarantee, D-10/D-11)
- `spec/ALP.md` §10 — teardown: fixed 5-step order, idempotent retry, partial failure → `cleanup_incomplete` (drives `cleanup`/`revoke` reporting, D-12/D-13)
- `spec/ALP.md` §11 — receipts: dual chains, verified vs attested, redacted summaries, exact break-locus (drives `receipts`/`verify`, D-06/D-08)
- `spec/ALP.md` §13 — trust limits: attested vs verified marking in the timeline (D-06)
- `spec/ALP.md` §14 — security: no secrets in output/errors (D-06, D-14)

### Project scope & requirements
- `.planning/PROJECT.md` — ## Context and ## Constraints (deny-by-default, enforcement outside the model, no secrets in logs/receipts, no credentials to the agent, cross-platform / Windows-developer)
- `.planning/REQUIREMENTS.md` — HOST-02, HOST-03, CLI-01, CLI-02 acceptance text
- `.planning/ROADMAP.md` §Phase 6 — goal + four success criteria; the Windows-file-atomicity research flag

### Stack & standards
- `.claude/CLAUDE.md` — pinned `commander@15.0.0` (CLI framework), `write-file-atomic@^7.0.1` (atomic writes, NOT 8.x), `proper-lockfile@4.1.2` (Windows-safe locking), `tsdown` (bin build), `tsx` (dev run), `@modelcontextprotocol/sdk@1.30.1` (stdio server for `run`), TS 5.9.3 strict, ESM-only, Node 22.18+. **`picocolors` is NOT listed — research must add/confirm or the CLI stays plain-text (D-15).**
- RFC 8785 (JCS via `@stint/spec` canonical serializer, used by `verifyChain`)

### Prior phase context
- `.planning/phases/05-lease-endings-teardown/05-CONTEXT.md` — teardown orchestrator (`runTeardown`/`retryTeardown`), auto-chain on end (D-18), explicit-retry-only (D-32), delete/retain split (RCPT-07); Phase 6 explicitly listed as the consumer for CLI `revoke`/`cleanup`/`retry` + terminal HostAdapter + JSON store
- `.planning/phases/04-mcp-proxy-credential-vault/04-CONTEXT.md` — `createLeaseProxyServer`/`ProxyDeps`, the vault seed seam (D-02 credential source), one-Server-per-lease, per-lease serializer
- `.planning/phases/02-lease-state-machine-policy-engine/02-CONTEXT.md` — `HostAdapter`/`await*Decision` contract (HOST-01, the D-04/D-05 target), `LeaseStore` contract + `@stint/core/testing` shared contract-test factory (the D-11 target)

### Existing code (the surfaces Phase 6 consumes/implements)
- `packages/cli/src/index.ts` — current `@stint/cli` skeleton (barrel only; commands to be added)
- `packages/cli/package.json` + `tsdown.config.ts` — where the `bin` + build wiring lands
- `packages/core/src/host-adapter.ts` — `HostAdapter` (3 methods + `requestOutcomeConfirmation`), `ConsentRequest`/`ApprovalRequest`/`OutcomeConfirmRequest`, `LifecycleEvent`, and the `awaitConsentDecision`/`awaitApprovalDecision`/`awaitOutcomeConfirmDecision` timeout-owning wrappers — the reference terminal adapter implements this exactly (D-04/D-05)
- `packages/core/src/lease-store.ts` — `LeaseStore` contract (`load`/`save`/`list`/`delete`/`transaction`) with the per-lease serialization guarantee the JSON store must uphold (D-10/D-11)
- `packages/core/src/receipts/merge.ts` — `mergeTimeline`, `TimelineEntry`, `TimelineOrigin` (`verified`/`attested`) for `receipts` output (D-06/D-07)
- `packages/core/src/receipts/chain.ts` — `verifyChain` returning `Result` with `{ brokenAtSeq, reason }` (`ChainVerifyFailure`) for the `verify` command (D-08)
- `packages/proxy/src/server.ts` — `createLeaseProxyServer` (`new Server(...)`, MCP) + `ProxyDeps` that `stint run` boots over stdio (D-01)
- `packages/proxy/src/teardown/orchestrate.ts` — `runTeardown`, `retryTeardown`, `TeardownDeps` for `cleanup`/`revoke` (D-12/D-13)
- `packages/core/src/testing` (`@stint/core/testing`) — the in-memory `LeaseStore` double + shared contract-test factory the JSON store runs against (D-11)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- **`createLeaseProxyServer` + `ProxyDeps`** (`@stint/proxy`): `stint run` boots this over an MCP stdio transport with the terminal `HostAdapter` and JSON stores injected — no new proxy logic (D-01).
- **`HostAdapter` contract + `await*Decision` wrappers** (`@stint/core`): the reference terminal adapter implements the three methods; core's wrappers already own the timeout→deny/decline/reject rule, so the adapter only renders + proposes (D-05).
- **`mergeTimeline` / `verifyChain`** (`@stint/core`): `receipts` and `verify` are thin renderers over these — the plain-language timeline and exact break-locus already exist as data (D-06/D-08).
- **`runTeardown` / `retryTeardown` + auto-chain** (`@stint/proxy`): `cleanup`/`revoke` sequence these; teardown auto-chains from a revoke, so the CLI just drives the entry transition (D-12/D-13).
- **Shared `LeaseStore` contract-test factory** (`@stint/core/testing`): the JSON store proves conformance against the identical suite as the in-memory double — no bespoke correctness spec (D-11).
- **Vault seed seam** (Phase 4): supplies run credentials from a local fixture without an OAuth flow (D-02).

### Established Patterns
- PEP/PDP + pure/impure split: `@stint/cli` is I/O-only glue; all decisions stay in `@stint/core` (pure) / `@stint/proxy` (runtime). The CLI adds no policy/decision logic.
- Deny-by-default owned by core, never by adapters: the reference terminal adapter mirrors this — it can never turn a hang/error/non-TTY into an allow (D-05, mirrors Phase 2 D-17).
- Result-not-throw + stable machine-readable enums: the CLI maps these to exit codes and `--json` payloads rather than inventing new error semantics (D-14).
- Cross-platform / Windows-first storage: `write-file-atomic` rename + `proper-lockfile` mkdir-locking chosen precisely to avoid POSIX-only primitives (D-10, CLAUDE.md).
- Additive-only to shared contracts: Phase 6 implements existing `HostAdapter`/`LeaseStore` interfaces; it does not change them.

### Integration Points
- `stint run` connects the MCP stdio server (`createLeaseProxyServer`) ⇄ an agent client; in Phase 6 the client is an in-process/mock test client, in Phase 7 the real example agent.
- The terminal `HostAdapter` plugs into the proxy's approval/consent/outcome-confirmation seams and into `create`'s consent render.
- The JSON `LeaseStore` (and receipt store) plug into `ProxyDeps` / `TeardownDeps` in place of the in-memory doubles, at the `~/.stint` root.
- `receipts`/`verify` read the persisted receipt chains via the store; `cleanup`/`revoke` drive teardown through the store's serialized `transaction()`.

</code_context>

<specifics>
## Specific Ideas

- The reference terminal `HostAdapter` and the JSON-file `LeaseStore` are the phase's "proof by implementation": each is an *outside-core* implementation of a contract defined in an earlier phase, demonstrating the plug-in seams are real.
- SC#2's "during a run" is proven **in Phase 6** (not just Phase 7) by exercising `stint run` with an in-process MCP client that triggers a real per-call approval prompt and a timeout-deny (D-01).
- The Windows CI concurrent read/write test on a single lease's `transaction()` is the visible "HOST-03 is done" signal — the whole reason `write-file-atomic`/`proper-lockfile` were chosen in CLAUDE.md (D-10/D-11; ROADMAP research flag).
- `~/.stint` with `--store`/`STINT_HOME` overrides keeps the concurrency test hermetic (point it at a temp dir) while giving real users a stable home for long-lived leases (D-9/D-11).

</specifics>

<deferred>
## Deferred Ideas

- The `examples/payment-reconciler` real agent, hybrid-mode e2e test, and README quickstart — Phase 7 (E2E-01/02, DOC-01). Phase 6's `run` is exercised only by an in-process/mock client.
- Interactive OAuth grant acquisition against a real authorization server to seed the vault — Phase 7 (Phase 6 uses the local-fixture seed seam, D-02).
- Automatic/background retry of `cleanup_incomplete` — post-v0.1; v0.1 is explicit-retry-only (Phase 5 D-32).
- Additional `LeaseStore` backends (SQLite/Postgres/Redis) and distributed per-lease locking — v2 (STORE-V2-01/02).
- An embeddable receipt-timeline UI component — v2 (ECO-V2-03); Phase 6 ships the terminal timeline only.

None of the above were re-scoped into Phase 6; discussion stayed within the phase boundary.

</deferred>

---

*Phase: 06-cli-reference-adapters*
*Context gathered: 2026-09-29*
