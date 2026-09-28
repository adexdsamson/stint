# Phase 5: Lease Endings & Teardown - Context

**Gathered:** 2026-09-28
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 5 delivers **outcome verification** and the **teardown orchestrator** — the code that ends a lease however it ends (verified completion, expiry, user, publisher, provider or policy) and runs the fixed-order, idempotent, fully-receipted teardown, recording every partial failure honestly. This is where PROJECT.md's core value ("when the lease ends, for any reason, every credential is revoked and the teardown is honestly receipted") lives or dies.

The lease state machine already contains every transition and event this phase needs (`begin_teardown`, `teardown_succeeded`, `teardown_incomplete`, `retry_teardown`, `outcome_verified`, `entitlement_revoked`, `grant_revoked`; actors `verifier`, `publisher`, `runtime`), and provider-side revocation **detection** (`invalid_grant` → `revoked` actor `provider`) shipped in Phase 4. Phase 5 adds the runtime that *drives* those transitions with real I/O.

It delivers:

1. **Outcome verification (LIFE-06):** the `resource_query` predicate grammar (closing spec §7.6 `[OPEN: Phase 5]`), evaluated as a verifier-actor synthetic read through the existing binding/vault/OutboundConnector path; the `user_confirm` verifier via a new out-of-band HostAdapter method; and `none` (only expiry/user ends the lease). The agent's own "done" claim never completes a lease.
2. **Teardown orchestrator (TEAR-01, TEAR-04, TEAR-05):** a single sequential coordinator in `@stint/proxy` that always walks the fixed 5 steps (revoke OAuth → invalidate license → cleanup hook → delete cached data → final signed receipt), records every step's outcome, lands in `cleaned_up` or `cleanup_incomplete`, and resumes idempotently on `retry_teardown` from a persisted progress record — never returning to `active`.
3. **Cleanup token (TEAR-03):** a runtime-minted single-use signed token scoped `cleanup:<lease_id>` (closing spec §10 step-3 `[OPEN: Phase 5]`).
4. **Revocation honesty (TEAR-02):** per-credential `revoked | discarded_revocation_unsupported | failed`, with RFC-7009 support determined structurally (never inferred from a 2xx), and the runtime always discarding its own credential copies.
5. **Publisher entitlement revocation (LIC-04):** a runtime-facing revoke path producing `entitlement_revoked` (actor `publisher`) → `revoked` → the same teardown, plus an additive `LicenseIssuer.invalidate` port + license custody discard.
6. **Receipts survive cleanup (RCPT-07):** the receipt log (and lease record + progress) outlive credential deletion; checkpoints bracket the ending.

**Not in this phase:** the JSON-file `LeaseStore`/`ReceiptStore` with Windows atomicity and its concurrency test (Phase 6, HOST-03); the CLI reference HostAdapter and CLI `revoke`/`cleanup`/`retry` commands (Phase 6, HOST-02, CLI-01); the interactive OAuth grant acquisition that seeds the vault (Phase 6/7); the end-to-end example (Phase 7); any automatic/background retry of `cleanup_incomplete`.

Requirements: LIFE-06, LIC-04, TEAR-01, TEAR-02, TEAR-03, TEAR-04, TEAR-05, RCPT-07.

</domain>

<decisions>
## Implementation Decisions

### Outcome verification — predicate grammar (LIFE-06, spec §7.6)
- **D-01:** The `resource_query` predicate is an **aggregate + compare DSL**: an aggregate (`count`/`sum`/`exists`) over a resource's rows with an optional filter (`field OP literal`), compared to a literal via `= != < <= > >=`. Parsed to a **closed AST**, never arbitrary code. Covers the spec's example (`count(rows where status = 'reconciled') >= 1`) verbatim. Minimal set only — **no `AND`/`OR`, no nesting** — matching the fixed-vocabulary "grammar size = attack surface" ethos. — **Reversibility:** one-way — this becomes normative spec §7.6 text and a manifest-validation gate publishers author against; widening later is additive but narrowing breaks published manifests.
- **D-02:** The verifier query runs as a **runtime-originated, verifier-actor synthetic read** against the resource's runtime-owned binding, reusing the **same vault / OutboundConnector / credential path** as a normal call. It is never in the agent's `tools/list` and never counts against limits. Uses runtime-held credentials, never publisher-supplied code. — **Reversibility:** costly — reuses the Phase 4 outbound seam; a separate path would duplicate credential/transport wiring.
- **D-03:** **Trigger + false/error semantics:** the agent may *signal* "check done", which only causes the runtime to run the predicate itself. `true` → `outcome_verified` (actor `verifier`) → `completed`; `false` → **no-op** (lease stays `active`, negative receipt, no state change); a **query error counts toward the LIFE-07 error threshold** (never completes). The agent's claim alone never completes.
- **D-04:** The predicate is **parsed/validated at manifest time** in `@stint/spec` (a manifest with an unparseable or out-of-grammar predicate is rejected before consent, same gate as unknown scopes). — **Reversibility:** costly — couples manifest acceptance to the parser.
- **D-05:** The **`user_confirm` verifier** uses a **new dedicated out-of-band method on `HostAdapter`** (mirroring `requestConsent`/`requestApproval`: async, `AbortSignal`, core-owned deny-by-default). Agent-signalled "done" triggers it; user `yes` → `outcome_verified` (actor `verifier`); `no`/timeout → stays `active`. — **Reversibility:** costly — additive change to the published HOST-01 contract.
- **D-06:** The **binding declares a row adapter/projection** so an arbitrary connector's read result normalizes to `{ rows: [{ field: value }] }` for the DSL. Normalization stays **runtime-owned**, never publisher-supplied. — **Reversibility:** costly — extends the runtime-owned binding shape.
- **D-07:** Each **verification attempt appends one verified-chain receipt** (verifier actor, resource id, outcome `true`/`false`/`error` + stable reason) — **never** raw rows, field values, or the query result. The `outcome_verified` transition also receipts. Secretless by type (RCPT-01).

### Cleanup token (TEAR-03, spec §10 step 3)
- **D-08:** The cleanup token is a **runtime-minted signed token** carrying a `cleanup:<lease_id>` scope claim, a `jti`, and a short `exp` — offline-verifiable by the hook. — **Reversibility:** one-way — becomes normative spec §10 text and the hook's verification contract.
- **D-09:** Signed via the **`jose` EdDSA JWT path using the runtime's existing Ed25519 receipt-checkpoint key** — one runtime signing identity for checkpoints and cleanup tokens; hooks verify against the runtime's published public key.
- **D-10:** **Single-use is enforced by minting fresh per attempt:** the runtime mints a new token (new `jti`, short `exp`) for each cleanup-hook attempt and records the `jti`; it never re-presents one. The "reject reuse" rule is the **hook's attested contract**. A retried *failed* cleanup step mints a fresh token; a *completed* step is never re-run (idempotent resume).
- **D-11:** **Short per-attempt TTL** (order of minutes; a runtime config value like the license's 300s default, **never manifest-carried**), bounding the replay window tightly; fresh mint per attempt means retries never fight an expired token.
- **D-12:** The hook is called by a **small runtime-owned HTTPS cleanup client** (not the OutboundConnector, which is credential/binding-shaped for customer resources) POSTing the token to `cleanup.hook.url`. A **2xx marks the step `ok` but the receipt frames it as an attested publisher claim** (per spec §13); non-2xx/timeout/network → `failed`. 2xx is never over-trusted (Pitfall 5). — **Reversibility:** costly — the honest 2xx-is-attested framing is what TEAR-02's honesty test asserts.
- **D-13:** When the manifest's `cleanup` is `null` (no hook), the step **runs but records a distinct `not_applicable`/`skipped` outcome** (never `ok`, never `failed`); no token is minted; the fixed 5-step order stays intact.

### Teardown orchestrator & resume (TEAR-01, TEAR-04)
- **D-14:** Per-step teardown progress is persisted as a **structured teardown-progress record (step → outcome) on/beside the lease in the `LeaseStore`**, updated under the per-lease serializer after each step. Retry reads it and skips completed steps. Single source of truth, survives restart, no receipt-log-replay logic. — **Reversibility:** costly — the resume contract depends on this record's shape.
- **D-15:** **One pass, then `cleanup_incomplete`:** each step is attempted once per run; a failing step is recorded, remaining steps still run (a failure never aborts the saga), and the lease lands in `cleanup_incomplete`. Recovery is an **explicit `retry_teardown`** resuming from persisted progress. **No in-run timers/backoff** — clean fit with the no-timers, injectable-clock discipline.
- **D-16:** The orchestrator **lives in `@stint/proxy`** (which already owns the vault, OutboundConnector, and receipts wiring), driving transitions through core's pure `reduce()`. `@stint/core` gains **no I/O**. Consistent with the Phase 4 PEP/PDP split. — **Reversibility:** costly — moving orchestration later would cross the pure/impure package boundary.
- **D-17:** **Step 4 ("delete cached data") deletes sensitive cached material** (vault credential entries, held license) for the lease, but **retains the receipt log AND the lease record + teardown-progress record** — receipts outlive the lease (RCPT-07) and the progress record must survive so a `cleanup_incomplete` retry can resume. A full lease-record drop, if ever, happens only after `cleaned_up`. — **Reversibility:** costly — the delete/retain split is the RCPT-07 + retry contract.
- **D-18:** **`begin_teardown` auto-chains:** on reaching any end state the runtime immediately dispatches `begin_teardown` (actor `runtime`) and runs the orchestrator — one code path for all six end reasons. The end-transition and `begin_teardown` are distinct `reduce()` calls chained by the runtime, so no lease is left terminal-but-not-torn-down.
- **D-19:** **A failed final-receipt write (step 5) → `cleanup_incomplete`** (just another step failure): `retry_teardown` re-attempts only the final receipt (steps 1–4 already marked done). `teardown_succeeded` → `cleaned_up` requires all five steps `ok`, **including** the signed final receipt.

### Revocation honesty (TEAR-02) & publisher entitlement revocation (LIC-04)
- **D-20:** **RFC-7009 support is determined structurally, not from the response:** if the AS metadata (`oauth4webapi` discovery) exposes a `revocation_endpoint` (or the runtime connector config declares one), the runtime calls it and a 2xx → `revoked`; if there is **no revocation endpoint at all** → `discarded_revocation_unsupported`; network/non-2xx → `failed`. A 2xx alone is never treated as proof (Pitfall 5). — **Reversibility:** costly — this tri-state mapping is the TEAR-02 test contract and normative spec §10.
- **D-21:** **LIC-04:** publisher entitlement revocation enters through a **runtime-facing revoke call** (a platform/publisher webhook the runtime exposes) that dispatches `entitlement_revoked` (actor `publisher`) → `revoked` → auto teardown. **Step 2** = an **additive `LicenseIssuer.invalidate(leaseId)` port method** (mock impl now) + **dropping the `HeldLicense`** so no future per-call refresh reissues it. There is **no background refresh loop** — "stop refresh" means discard custody + refuse reissue. A 2xx from the publisher revoke endpoint is attested, like the cleanup hook. — **Reversibility:** costly — additive port method + a new runtime-facing entry point later phases wire to.
- **D-22:** The runtime **always discards its own cached copy of every credential** during teardown — even when the revoke call `failed` or was `unsupported` — so it never retains a usable credential post-teardown. The plain-language timeline **says exactly what is known** per credential ("revoked at provider" / "discarded our copy; provider revocation unsupported — could not confirm" / "discarded our copy; provider revocation failed"); it never overclaims.
- **D-23:** **Attempted = terminal for step 1:** once revocation has been attempted for a credential its outcome is terminal and the discarded token is gone; `retry_teardown` **never re-attempts revocation**, it resumes at the later steps that failed. The honest `failed` record stands; the security goal (runtime holds nothing) is already met. "Idempotent retry" means never repeat step 1, not re-revoke.
- **D-24:** **All `teardown_step` receipts go on the verified chain** (runtime-observed facts). OAuth revoke uses `revoked | discarded_revocation_unsupported | failed`; other steps use their own honest small vocabulary (`ok | failed`, plus `not_applicable` for a null cleanup hook, attested-`ok` for the hook's 2xx).
- **D-25:** Lease-end notification **reuses the existing `HostAdapter.notify(LifecycleEvent)`** (which already has `tearing_down`/`cleaned_up`/`cleanup_incomplete` members), firing on each teardown transition with the terminal notify carrying the final state. Fire-and-forget; no new interface surface — the host reads the receipt timeline for per-step detail.

### Spec, testing, layering, storage
- **D-26:** Phase 5 **normatively updates `spec/ALP.md`** to close both `[OPEN: Phase 5]` markers at full precision: §7.6 gets the complete predicate grammar (aggregate set, operators, filter form, evaluation semantics, row model) and §10 gets the cleanup-token format (`cleanup:<lease_id>` scope, `jti`, `exp`, `alg`, single-use rule). Both markers are removed and the **CI structural checker** confirms they are gone (same discipline as Phases 1–3). — **Reversibility:** one-way — normative spec change against a published version.
- **D-27:** **TEAR-05 testing:** each teardown step is an **injectable port**; tests drive a **matrix forcing each single step to fail/timeout** while others succeed, asserting `cleanup_incomplete` + exact per-step recorded outcomes + idempotent retry resume. Includes a **mock provider returning 2xx-without-revoking** (the Pitfall 5 test) and `oauth2-mock-server` for a real RFC 7009 revoke happy path, plus a mock cleanup hook returning failure/timeout.
- **D-28:** The **predicate parser/AST lives in `@stint/spec`** (validated as a post-schema semantic rule, like the existing "delegated resource must be scoped" rules), producing a closed AST; `@stint/proxy`'s verifier imports that AST + a **pure evaluator** to run it over the normalized rows. One grammar definition, shared by validation and evaluation, respecting `spec → core → proxy` layering. — **Reversibility:** costly — package placement the verifier depends on.
- **D-29:** **Storage boundary:** Phase 5 builds/tests the orchestrator + progress record against the **existing in-memory `LeaseStore`/`ReceiptStore` doubles + contract-test suites**, relying on the `LeaseStore` contract's atomicity/serialization guarantee (not any concrete impl). The JSON store + Windows-CI concurrency test lands in Phase 6 (HOST-03) and must pass the same contracts, including teardown's read-modify-write (Pitfall 9).

### Concurrency (edge case)
- **D-30:** **Teardown vs in-flight/new calls:** `begin_teardown` and every step run through the **same per-lease serializer**, so an in-flight `tools/call` completes (and receipts) before teardown's read-modify-write begins — no torn state. Any call arriving after the lease left `active` is denied by the existing `lease_not_active` policy check (Phase 4 04-07). One mutex, no new concurrency primitive.

### Receipts / checkpoints (edge case)
- **D-31:** **Checkpoints bracket the ending (RCPT-03):** sign a verified-chain checkpoint at the terminal transition (`revoked`/`expired`/`failed`/`completed`), then a **final signed checkpoint after step 5**. The attested chain gets its own checkpoint if it has entries, verified independently. Both "lease ended" and "teardown done" are non-repudiable even if teardown never completes.

### Retry ownership (edge case)
- **D-32:** **`cleanup_incomplete` retry is explicit-only in v0.1:** surfaced via `notify` + receipts and retried only by an explicit action (user via CLI in Phase 6, or a host/runtime caller invoking `retry_teardown`). No automatic background retry loop (no-timers). The `runtime` retry actor stays valid in the transition table for a caller-driven retry, but nothing self-schedules.

### Fixed order (edge case)
- **D-33:** The **5-step order is fixed and unconditional** for every end reason and auth mode. A delegated-only lease records step 2 `not_applicable`; a hosted-only lease records step 1 `not_applicable`; a null cleanup hook records step 3 `not_applicable`. License-invalidate (step 2) always precedes the cleanup hook (step 3) — fine, because the cleanup token is runtime-minted, not the license. Fixed order = uniform, auditable.

### Claude's Discretion
- Exact TypeScript module layout in `@stint/proxy` for the orchestrator (e.g. `teardown/orchestrate.ts`, step modules) and in `@stint/spec` for the predicate parser/AST/evaluator.
- The precise shape/field names of the teardown-progress record (D-14), the additive `LicenseIssuer.invalidate` signature (D-21), the new `HostAdapter` confirm method signature (D-05), and the binding row-adapter shape (D-06) — provided the invariants above hold.
- Exact cleanup-token claim names and TTL value (D-08/D-11), and the stable reason strings for verification and teardown-step receipts (D-07/D-24), provided nothing secret/raw can appear by type.
- The exact predicate grammar surface details (aggregate list beyond count/sum/exists, literal types) within D-01's "minimal, no boolean combinators, no nesting" bound.
- The concrete BNF/wording used to close the spec markers (D-26), provided it matches the implemented behavior and the CI checker passes.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Protocol (normative — code MUST match; this phase also EDITS it)
- `spec/ALP.md` §7.6 — outcome verification (`resource_query`/`user_confirm`/`none`); **this phase closes the `[OPEN: Phase 5]` predicate-grammar marker here** (D-01, D-26)
- `spec/ALP.md` §10 — teardown: fixed 5-step order, tri-state revocation outcomes, 2xx-is-not-proof, partial failure → `cleanup_incomplete`, idempotent retry, receipts survive; **this phase closes the `[OPEN: Phase 5]` cleanup-token-format marker here** (D-08, D-26)
- `spec/ALP.md` §7.1–7.4 — states/events/actors/transition table (already complete): `begin_teardown`, `teardown_succeeded`/`teardown_incomplete`, `retry_teardown` (user+runtime), `outcome_verified` (verifier), `entitlement_revoked` (publisher), `grant_revoked` (provider)
- `spec/ALP.md` §4 — manifest `job.verifier` (tagged union) and `cleanup` (`null` | `{ hook: { url }, publisher_retains }`) fields the verifier + cleanup step read
- `spec/ALP.md` §8 — auth modes (delegated/hosted/hybrid) — governs which teardown steps are `not_applicable` (D-33)
- `spec/ALP.md` §11 — receipts: dual chains, verified vs attested, per-call/transition/teardown_step entries, redacted summaries (D-07, D-24, D-31, RCPT-07)
- `spec/ALP.md` §13 — trust limits: cleanup-hook success and `publisher_retains` are attested, not verified (D-12)
- `spec/ALP.md` §14 — security: secrets never in receipts/logs/errors; explicit clock skew; re-check per call

### Project scope & requirements
- `.planning/PROJECT.md` — ## Context and ## Constraints (deny-by-default, enforcement outside the model, no secrets in receipts, no credentials to the agent, no hand-rolled crypto)
- `.planning/REQUIREMENTS.md` — LIFE-06, LIC-04, TEAR-01..05, RCPT-07 acceptance text
- `.planning/ROADMAP.md` §Phase 5 — goal + five success criteria

### Research (read before planning)
- `.planning/research/ARCHITECTURE.md` — "Lease End + Teardown Flow" (lines ~421-446); Pattern 5 (teardown as retryable saga with partial-failure recording, idempotent one-directional steps); Pattern 6 (hash-chain + checkpoints); suggested `teardown/orchestrate.ts` structure; build order step 6
- `.planning/research/PITFALLS.md` — Pitfall 5 (RFC 7009 2xx silent no-op — the core honesty trap; test: mock AS returns 200 without invalidating → `discarded_revocation_unsupported`, not `revoked`); Pitfall 9 (Windows JSON-store atomicity during teardown — Phase 6, but note the constraint); "Looks Done But Isn't" teardown-orchestrator checklist
- `.planning/research/FEATURES.md`, `.planning/research/STACK.md`, `.planning/research/SUMMARY.md`

### Prior phase context
- `.planning/phases/04-mcp-proxy-credential-vault/04-CONTEXT.md` — the vault (`OutboundConnector` port D-01/D-02, seed seam D-04), per-lease serializer, provider-revocation detection (D-09), per-call receipts (D-13), one-Server-per-lease (D-10); Phase 5 explicitly listed as consumer of the D-09 detection path
- `.planning/phases/03-receipts-licensing/03-CONTEXT.md` — `appendEntry`/`verifyChain`/`signCheckpoint`, `ReceiptStore` double, `HeldLicense`/`readLicenseToken`, `LicenseIssuer` port (extension target for D-21), attested chain + merged timeline
- `.planning/phases/02-lease-state-machine-policy-engine/02-CONTEXT.md` — `reduce()`, transition table, actors, `HostAdapter`/`awaitApprovalDecision`/`awaitConsentDecision` (pattern for D-05), `LeaseStore` contract + `@stint/core/testing` doubles

### Existing code (the surfaces Phase 5 consumes/extends)
- `packages/core/src/transitions.ts` — full transition table (all teardown transitions already present)
- `packages/core/src/lease.ts` + `reduce()` — the only sanctioned transition path; `LeaseCounters`
- `packages/core/src/host-adapter.ts` — `HostAdapter`, `LifecycleEvent` union, `awaitApprovalDecision`/`awaitConsentDecision` (extend for D-05)
- `packages/core/src/license/license-issuer.ts` — `LicenseIssuer` port (add `invalidate` for D-21); `held-license.ts` (`HeldLicense`/`readLicenseToken` custody discard, D-21/D-22)
- `packages/core/src/receipts/chain.ts` + `checkpoint.ts` — `appendEntry`/`verifyChain`/`signCheckpoint` (teardown_step receipts D-24, checkpoints D-31)
- `packages/core/src/bindings.ts` — `ConnectorBinding`/`BindingSet` (add row adapter, D-06)
- `packages/proxy/src/revocation.ts` — `applyProviderRevocation`/`isProviderRevocation` (provider path; entitlement path mirrors it, D-21)
- `packages/proxy/src/vault/credential-vault.ts` + `oauth-client.ts` — `CredentialVault` (add revoke + discard, D-22/D-23); `refreshAccessToken`, `RefreshResult`, `classifyTokenError`; RFC 7009 revoke via `oauth4webapi` (D-20)
- `packages/proxy/src/vault/execute-stage.ts` + `connectors/outbound-connector.ts` — the outbound path the verifier read reuses (D-02)
- `packages/proxy/src/concurrency/lease-serializer.ts` — the per-lease mutex teardown runs under (D-30)
- `packages/{core,spec}` public barrels (`src/index.ts`) — the surfaces the orchestrator imports; `@stint/spec` canonical serializer + manifest validation (D-04, D-28)

### Stack & standards
- `.claude/CLAUDE.md` — pinned `jose@6.2.12` (cleanup-token JWT, D-09), `oauth4webapi@3.8.8` (RFC 7009 revoke, D-20), `oauth2-mock-server@9.2.0` (tests, D-27), `paseto@4.0.1`, `node:crypto`; TS 5.9.3 strict, ESM-only, Node 22.18+
- RFC 7009 (token revocation), RFC 8707 (resource indicators), RFC 8785 (JCS via `@stint/spec`)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `@stint/core` `reduce()` + `transitions.ts` — the complete teardown/verification transition surface already exists; the orchestrator only sequences `reduce()` calls, it adds no new states/events.
- `@stint/core` `signCheckpoint`/`appendEntry`/`verifyChain` + `ReceiptStore` double — teardown_step receipts (D-24) and bracketing checkpoints (D-31).
- `@stint/core` `HostAdapter`/`awaitConsentDecision` pattern — the template for the new out-of-band `user_confirm` method (D-05).
- `@stint/core` `LicenseIssuer`/`HeldLicense`/`readLicenseToken` — extended with `invalidate` + custody discard for step 2 (D-21).
- `@stint/proxy` credential vault, `OutboundConnector`, `refreshAccessToken`/`classifyTokenError`, per-lease serializer, `applyProviderRevocation` — the exact I/O plumbing teardown + verifier reuse (D-02, D-16, D-20, D-22, D-30).
- `@stint/core/testing` + `@stint/proxy` testing doubles — in-memory `LeaseStore`/`ReceiptStore` + `oauth2-mock-server` harness for the TEAR-05 fault matrix (D-27, D-29).
- `@stint/spec` canonical serializer + manifest validation with post-schema semantic rules — the home for the predicate parser (D-28) and manifest-time predicate validation (D-04).

### Established Patterns
- PEP/PDP split: pure decisions in `@stint/core`, all I/O in `@stint/proxy` (the orchestrator lives in proxy, D-16).
- Per-lease serialization; injectable clock, no timers, no background loops (D-15, D-30, D-32).
- Result-not-throw + stable machine-readable code enums for host/CLI consumption (verification + teardown-step outcomes, D-07/D-24).
- Runtime-owned enforcement inputs; nothing publisher/manifest/agent-supplied drives authorization, classification, or the verifier read (D-01, D-02, D-06).
- Custody discipline: secrets in module-private storage, single accessor, never returned to the agent (D-22, mirrors `held-license.ts`/`credential-vault.ts`).
- Additive-only changes to shared `@stint/core` types (LicenseIssuer, HostAdapter, ConnectorBinding).

### Integration Points
- The orchestrator (proxy) imports `@stint/core` (`reduce`, receipts, license, host-adapter) and `@stint/spec` (predicate evaluator, serializer); it drives transitions but contains no policy/decision logic.
- The verifier read reuses the vault + `OutboundConnector` + binding path; its result is normalized via the binding row adapter and fed to the pure evaluator.
- Provider-revocation detection (Phase 4 `revocation.ts`) and the new entitlement-revocation path (D-21) both funnel into the same auto-chained teardown (D-18).
- Teardown-progress record persists via the `LeaseStore` contract (in-memory now; JSON impl in Phase 6 must pass the same contract, D-29).

</code_context>

<specifics>
## Specific Ideas

- The spec deliberately left exactly two `[OPEN: Phase 5]` markers (§7.6 predicate grammar, §10 cleanup-token format); closing both normatively with the CI marker-checker is the visible "this phase is done" signal (D-26).
- The Pitfall 5 test is the centerpiece of teardown honesty: a mock AS that returns 200 without actually invalidating must produce `discarded_revocation_unsupported`/structural-support classification, never `revoked` (D-20, D-27).
- "Always discard our copy, even on failed revoke" + "attempted = terminal" together give a coherent story: the runtime never holds a usable credential after teardown, and a failed revoke is an honest permanent record, not a retryable one (D-22, D-23).
- Fixed 5-step order with `not_applicable` outcomes (rather than skipped steps) keeps every teardown's audit trail the same length and shape regardless of end reason or auth mode (D-13, D-33).
- The predicate example from the shipped `payment-reconciler` manifest (`count(rows where status = 'reconciled') >= 1`) is the concrete target the aggregate+compare DSL must express verbatim (D-01).

</specifics>

<deferred>
## Deferred Ideas

- Automatic/background retry of `cleanup_incomplete` (runtime self-heals on resume/startup) — post-v0.1; v0.1 is explicit-retry-only (D-32).
- Positive confirmation of dead credentials via a follow-up authenticated probe call expecting 401 — considered and not adopted for v0.1 (structural support detection chosen instead, D-20); a possible later honesty upgrade.
- Boolean combinators (`AND`/`OR`) and nesting in the predicate grammar — intentionally excluded now (D-01); additive later if a real need appears.
- JSON-file `LeaseStore`/`ReceiptStore` with NTFS-atomic writes + the Windows-CI concurrency test for teardown's read-modify-write — Phase 6 (HOST-03, Pitfall 9).
- CLI `revoke`/`cleanup`/`retry` commands and the terminal reference HostAdapter that renders `user_confirm` prompts and lease-end summaries — Phase 6 (HOST-02, CLI-01/02).
- Interactive OAuth grant acquisition that seeds the vault before a lease runs — Phase 6/7.
- A richer teardown-summary host notification carrying per-step outcomes — considered; v0.1 reuses the existing `LifecycleEvent` notify and lets hosts read the receipt timeline (D-25).

None of the above were re-scoped into Phase 5; discussion stayed within the phase boundary.

</deferred>

---

*Phase: 05-lease-endings-teardown*
*Context gathered: 2026-09-28*
