# Phase 5: Lease Endings & Teardown - Research

**Researched:** 2026-09-28
**Domain:** Runtime-driven lease-ending orchestration (outcome verification, teardown saga, cleanup-token minting, OAuth/entitlement revocation honesty) inside a TypeScript pure-core/impure-proxy monorepo
**Confidence:** HIGH

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Outcome verification — predicate grammar (LIFE-06, spec §7.6)**
- **D-01:** The `resource_query` predicate is an **aggregate + compare DSL**: an aggregate (`count`/`sum`/`exists`) over a resource's rows with an optional filter (`field OP literal`), compared to a literal via `= != < <= > >=`. Parsed to a **closed AST**, never arbitrary code. Covers the spec's example (`count(rows where status = 'reconciled') >= 1`) verbatim. Minimal set only — **no `AND`/`OR`, no nesting** — matching the fixed-vocabulary "grammar size = attack surface" ethos. — **Reversibility:** one-way — this becomes normative spec §7.6 text and a manifest-validation gate publishers author against; widening later is additive but narrowing breaks published manifests.
- **D-02:** The verifier query runs as a **runtime-originated, verifier-actor synthetic read** against the resource's runtime-owned binding, reusing the **same vault / OutboundConnector / credential path** as a normal call. It is never in the agent's `tools/list` and never counts against limits. Uses runtime-held credentials, never publisher-supplied code. — **Reversibility:** costly — reuses the Phase 4 outbound seam; a separate path would duplicate credential/transport wiring.
- **D-03:** **Trigger + false/error semantics:** the agent may *signal* "check done", which only causes the runtime to run the predicate itself. `true` → `outcome_verified` (actor `verifier`) → `completed`; `false` → **no-op** (lease stays `active`, negative receipt, no state change); a **query error counts toward the LIFE-07 error threshold** (never completes). The agent's claim alone never completes.
- **D-04:** The predicate is **parsed/validated at manifest time** in `@stint/spec` (a manifest with an unparseable or out-of-grammar predicate is rejected before consent, same gate as unknown scopes). — **Reversibility:** costly — couples manifest acceptance to the parser.
- **D-05:** The **`user_confirm` verifier** uses a **new dedicated out-of-band method on `HostAdapter`** (mirroring `requestConsent`/`requestApproval`: async, `AbortSignal`, core-owned deny-by-default). Agent-signalled "done" triggers it; user `yes` → `outcome_verified` (actor `verifier`); `no`/timeout → stays `active`. — **Reversibility:** costly — additive change to the published HOST-01 contract.
- **D-06:** The **binding declares a row adapter/projection** so an arbitrary connector's read result normalizes to `{ rows: [{ field: value }] }` for the DSL. Normalization stays **runtime-owned**, never publisher-supplied. — **Reversibility:** costly — extends the runtime-owned binding shape.
- **D-07:** Each **verification attempt appends one verified-chain receipt** (verifier actor, resource id, outcome `true`/`false`/`error` + stable reason) — **never** raw rows, field values, or the query result. The `outcome_verified` transition also receipts. Secretless by type (RCPT-01).

**Cleanup token (TEAR-03, spec §10 step 3)**
- **D-08:** The cleanup token is a **runtime-minted signed token** carrying a `cleanup:<lease_id>` scope claim, a `jti`, and a short `exp` — offline-verifiable by the hook. — **Reversibility:** one-way — becomes normative spec §10 text and the hook's verification contract.
- **D-09:** Signed via the **`jose` EdDSA JWT path using the runtime's existing Ed25519 receipt-checkpoint key** — one runtime signing identity for checkpoints and cleanup tokens; hooks verify against the runtime's published public key.
- **D-10:** **Single-use is enforced by minting fresh per attempt:** the runtime mints a new token (new `jti`, short `exp`) for each cleanup-hook attempt and records the `jti`; it never re-presents one. The "reject reuse" rule is the **hook's attested contract**. A retried *failed* cleanup step mints a fresh token; a *completed* step is never re-run (idempotent resume).
- **D-11:** **Short per-attempt TTL** (order of minutes; a runtime config value like the license's 300s default, **never manifest-carried**), bounding the replay window tightly; fresh mint per attempt means retries never fight an expired token.
- **D-12:** The hook is called by a **small runtime-owned HTTPS cleanup client** (not the OutboundConnector, which is credential/binding-shaped for customer resources) POSTing the token to `cleanup.hook.url`. A **2xx marks the step `ok` but the receipt frames it as an attested publisher claim** (per spec §13); non-2xx/timeout/network → `failed`. 2xx is never over-trusted (Pitfall 5). — **Reversibility:** costly — the honest 2xx-is-attested framing is what TEAR-02's honesty test asserts.
- **D-13:** When the manifest's `cleanup` is `null` (no hook), the step **runs but records a distinct `not_applicable`/`skipped` outcome** (never `ok`, never `failed`); no token is minted; the fixed 5-step order stays intact.

**Teardown orchestrator & resume (TEAR-01, TEAR-04)**
- **D-14:** Per-step teardown progress is persisted as a **structured teardown-progress record (step → outcome) on/beside the lease in the `LeaseStore`**, updated under the per-lease serializer after each step. Retry reads it and skips completed steps. Single source of truth, survives restart, no receipt-log-replay logic. — **Reversibility:** costly — the resume contract depends on this record's shape.
- **D-15:** **One pass, then `cleanup_incomplete`:** each step is attempted once per run; a failing step is recorded, remaining steps still run (a failure never aborts the saga), and the lease lands in `cleanup_incomplete`. Recovery is an **explicit `retry_teardown`** resuming from persisted progress. **No in-run timers/backoff** — clean fit with the no-timers, injectable-clock discipline.
- **D-16:** The orchestrator **lives in `@stint/proxy`** (which already owns the vault, OutboundConnector, and receipts wiring), driving transitions through core's pure `reduce()`. `@stint/core` gains **no I/O**. Consistent with the Phase 4 PEP/PDP split. — **Reversibility:** costly — moving orchestration later would cross the pure/impure package boundary.
- **D-17:** **Step 4 ("delete cached data") deletes sensitive cached material** (vault credential entries, held license) for the lease, but **retains the receipt log AND the lease record + teardown-progress record** — receipts outlive the lease (RCPT-07) and the progress record must survive so a `cleanup_incomplete` retry can resume. A full lease-record drop, if ever, happens only after `cleaned_up`. — **Reversibility:** costly — the delete/retain split is the RCPT-07 + retry contract.
- **D-18:** **`begin_teardown` auto-chains:** on reaching any end state the runtime immediately dispatches `begin_teardown` (actor `runtime`) and runs the orchestrator — one code path for all six end reasons. The end-transition and `begin_teardown` are distinct `reduce()` calls chained by the runtime, so no lease is left terminal-but-not-torn-down.
- **D-19:** **A failed final-receipt write (step 5) → `cleanup_incomplete`** (just another step failure): `retry_teardown` re-attempts only the final receipt (steps 1–4 already marked done). `teardown_succeeded` → `cleaned_up` requires all five steps `ok`, **including** the signed final receipt.

**Revocation honesty (TEAR-02) & publisher entitlement revocation (LIC-04)**
- **D-20:** **RFC-7009 support is determined structurally, not from the response:** if the AS metadata (`oauth4webapi` discovery) exposes a `revocation_endpoint` (or the runtime connector config declares one), the runtime calls it and a 2xx → `revoked`; if there is **no revocation endpoint at all** → `discarded_revocation_unsupported`; network/non-2xx → `failed`. A 2xx alone is never treated as proof (Pitfall 5). — **Reversibility:** costly — this tri-state mapping is the TEAR-02 test contract and normative spec §10.
- **D-21:** **LIC-04:** publisher entitlement revocation enters through a **runtime-facing revoke call** (a platform/publisher webhook the runtime exposes) that dispatches `entitlement_revoked` (actor `publisher`) → `revoked` → auto teardown. **Step 2** = an **additive `LicenseIssuer.invalidate(leaseId)` port method** (mock impl now) + **dropping the `HeldLicense`** so no future per-call refresh reissues it. There is **no background refresh loop** — "stop refresh" means discard custody + refuse reissue. A 2xx from the publisher revoke endpoint is attested, like the cleanup hook. — **Reversibility:** costly — additive port method + a new runtime-facing entry point later phases wire to.
- **D-22:** The runtime **always discards its own cached copy of every credential** during teardown — even when the revoke call `failed` or was `unsupported` — so it never retains a usable credential post-teardown. The plain-language timeline **says exactly what is known** per credential ("revoked at provider" / "discarded our copy; provider revocation unsupported — could not confirm" / "discarded our copy; provider revocation failed"); it never overclaims.
- **D-23:** **Attempted = terminal for step 1:** once revocation has been attempted for a credential its outcome is terminal and the discarded token is gone; `retry_teardown` **never re-attempts revocation**, it resumes at the later steps that failed. The honest `failed` record stands; the security goal (runtime holds nothing) is already met. "Idempotent retry" means never repeat step 1, not re-revoke.
- **D-24:** **All `teardown_step` receipts go on the verified chain** (runtime-observed facts). OAuth revoke uses `revoked | discarded_revocation_unsupported | failed`; other steps use their own honest small vocabulary (`ok | failed`, plus `not_applicable` for a null cleanup hook, attested-`ok` for the hook's 2xx).
- **D-25:** Lease-end notification **reuses the existing `HostAdapter.notify(LifecycleEvent)`** (which already has `tearing_down`/`cleaned_up`/`cleanup_incomplete` members), firing on each teardown transition with the terminal notify carrying the final state. Fire-and-forget; no new interface surface — the host reads the receipt timeline for per-step detail.

**Spec, testing, layering, storage**
- **D-26:** Phase 5 **normatively updates `spec/ALP.md`** to close both `[OPEN: Phase 5]` markers at full precision: §7.6 gets the complete predicate grammar (aggregate set, operators, filter form, evaluation semantics, row model) and §10 gets the cleanup-token format (`cleanup:<lease_id>` scope, `jti`, `exp`, `alg`, single-use rule). Both markers are removed and the **CI structural checker** confirms they are gone (same discipline as Phases 1–3). — **Reversibility:** one-way — normative spec change against a published version.
- **D-27:** **TEAR-05 testing:** each teardown step is an **injectable port**; tests drive a **matrix forcing each single step to fail/timeout** while others succeed, asserting `cleanup_incomplete` + exact per-step recorded outcomes + idempotent retry resume. Includes a **mock provider returning 2xx-without-revoking** (the Pitfall 5 test) and `oauth2-mock-server` for a real RFC 7009 revoke happy path, plus a mock cleanup hook returning failure/timeout.
- **D-28:** The **predicate parser/AST lives in `@stint/spec`** (validated as a post-schema semantic rule, like the existing "delegated resource must be scoped" rules), producing a closed AST; `@stint/proxy`'s verifier imports that AST + a **pure evaluator** to run it over the normalized rows. One grammar definition, shared by validation and evaluation, respecting `spec → core → proxy` layering. — **Reversibility:** costly — package placement the verifier depends on.
- **D-29:** **Storage boundary:** Phase 5 builds/tests the orchestrator + progress record against the **existing in-memory `LeaseStore`/`ReceiptStore` doubles + contract-test suites**, relying on the `LeaseStore` contract's atomicity/serialization guarantee (not any concrete impl). The JSON store + Windows-CI concurrency test lands in Phase 6 (HOST-03) and must pass the same contracts, including teardown's read-modify-write (Pitfall 9).

**Concurrency (edge case)**
- **D-30:** **Teardown vs in-flight/new calls:** `begin_teardown` and every step run through the **same per-lease serializer**, so an in-flight `tools/call` completes (and receipts) before teardown's read-modify-write begins — no torn state. Any call arriving after the lease left `active` is denied by the existing `lease_not_active` policy check (Phase 4 04-07). One mutex, no new concurrency primitive.

**Receipts / checkpoints (edge case)**
- **D-31:** **Checkpoints bracket the ending (RCPT-03):** sign a verified-chain checkpoint at the terminal transition (`revoked`/`expired`/`failed`/`completed`), then a **final signed checkpoint after step 5**. The attested chain gets its own checkpoint if it has entries, verified independently. Both "lease ended" and "teardown done" are non-repudiable even if teardown never completes.

**Retry ownership (edge case)**
- **D-32:** **`cleanup_incomplete` retry is explicit-only in v0.1:** surfaced via `notify` + receipts and retried only by an explicit action (user via CLI in Phase 6, or a host/runtime caller invoking `retry_teardown`). No automatic background retry loop (no-timers). The `runtime` retry actor stays valid in the transition table for a caller-driven retry, but nothing self-schedules.

**Fixed order (edge case)**
- **D-33:** The **5-step order is fixed and unconditional** for every end reason and auth mode. A delegated-only lease records step 2 `not_applicable`; a hosted-only lease records step 1 `not_applicable`; a null cleanup hook records step 3 `not_applicable`. License-invalidate (step 2) always precedes the cleanup hook (step 3) — fine, because the cleanup token is runtime-minted, not the license. Fixed order = uniform, auditable.

### Claude's Discretion

- Exact TypeScript module layout in `@stint/proxy` for the orchestrator (e.g. `teardown/orchestrate.ts`, step modules) and in `@stint/spec` for the predicate parser/AST/evaluator.
- The precise shape/field names of the teardown-progress record (D-14), the additive `LicenseIssuer.invalidate` signature (D-21), the new `HostAdapter` confirm method signature (D-05), and the binding row-adapter shape (D-06) — provided the invariants above hold.
- Exact cleanup-token claim names and TTL value (D-08/D-11), and the stable reason strings for verification and teardown-step receipts (D-07/D-24), provided nothing secret/raw can appear by type.
- The exact predicate grammar surface details (aggregate list beyond count/sum/exists, literal types) within D-01's "minimal, no boolean combinators, no nesting" bound.
- The concrete BNF/wording used to close the spec markers (D-26), provided it matches the implemented behavior and the CI checker passes.

### Deferred Ideas (OUT OF SCOPE)

- Automatic/background retry of `cleanup_incomplete` (runtime self-heals on resume/startup) — post-v0.1; v0.1 is explicit-retry-only (D-32).
- Positive confirmation of dead credentials via a follow-up authenticated probe call expecting 401 — considered and not adopted for v0.1 (structural support detection chosen instead, D-20); a possible later honesty upgrade.
- Boolean combinators (`AND`/`OR`) and nesting in the predicate grammar — intentionally excluded now (D-01); additive later if a real need appears.
- JSON-file `LeaseStore`/`ReceiptStore` with NTFS-atomic writes + the Windows-CI concurrency test for teardown's read-modify-write — Phase 6 (HOST-03, Pitfall 9).
- CLI `revoke`/`cleanup`/`retry` commands and the terminal reference HostAdapter that renders `user_confirm` prompts and lease-end summaries — Phase 6 (HOST-02, CLI-01/02).
- Interactive OAuth grant acquisition that seeds the vault before a lease runs — Phase 6/7.
- A richer teardown-summary host notification carrying per-step outcomes — considered; v0.1 reuses the existing `LifecycleEvent` notify and lets hosts read the receipt timeline (D-25).

None of the above were re-scoped into Phase 5; discussion stayed within the phase boundary.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| LIFE-06 | Outcome verification (`resource_query`/`user_confirm`/`none`) completes the lease; agent's own claim never completes it | Predicate DSL/AST placement in `@stint/spec` (`validate.ts`'s `collectSemanticErrors`), evaluator reuse of `execute-stage.ts`/`OutboundConnector` path, new `HostAdapter` method mirroring `awaitConsentDecision`, `verifierEvents.outcomeVerified()` (already exists in `events.ts`) |
| LIC-04 | Publisher can revoke entitlement; moves lease to `revoked` (actor `publisher`), triggers OAuth revocation | `publisherEvents.entitlementRevoked()` (already exists), `LicenseIssuer.invalidate` additive port method, `HeldLicense` custody-discard pattern (`held-license.ts`), auto-chain into teardown (D-18) |
| TEAR-01 | Ending a lease for any reason runs teardown in fixed 5-step order | `runtimeEvents.beginTeardown/teardownSucceeded/teardownIncomplete/retryTeardown()` (all already exist in `events.ts`), `runInLeaseTransaction`/per-lease serializer reuse, orchestrator module in `@stint/proxy` |
| TEAR-02 | Each credential records `revoked \| discarded_revocation_unsupported \| failed`; bare 2xx never treated as proof | `oauth4webapi` AS-metadata `revocation_endpoint` presence check + `oauth.revocationRequest`/`processRevocationResponse`, extending `oauth-client.ts`'s existing revoke-classification pattern (`classifyTokenError`) |
| TEAR-03 | Cleanup hook authenticates with single-use `cleanup:<lease_id>` token | `jose`'s `SignJWT`/`jwtVerify` compact-JWT path (new usage pattern in this codebase — see Code Examples), reusing the runtime's existing Ed25519 checkpoint key from `checkpoint.ts` |
| TEAR-04 | Any step failure lands lease in `cleanup_incomplete` with every step recorded; retry resumes idempotently; lease never returns to `active` | Teardown-progress record additive to `Lease` (mirrors `LeaseCounters.actionTimestamps`'s Phase 4 precedent), `TRANSITION_TABLE`'s already-closed `cleanup_incomplete → tearing_down` (no path to `active`, enforced by `checkTransitionTable`'s own CI assertion) |
| TEAR-05 | Every teardown path, including each single-step failure, is covered by tests | Injectable per-step ports, fault-matrix test pattern, `oauth2-mock-server` (already a proxy devDependency, used in `revocation-detection.test.ts`) |
| RCPT-07 | Receipts survive cleanup | `TeardownStepPayload`/`AttestedClaimPayload` already schema-defined; D-17's delete/retain split; `signCheckpoint` reuse for the final checkpoint |
</phase_requirements>

## Project Constraints (from CLAUDE.md)

- **Stack:** pnpm monorepo, TypeScript 5.9.3 strict, ESM-only, Node 22.18+ (dev/CI on Node 24 LTS). Vitest 5.0.2, `tsdown`. Cross-platform (Windows developer) — no POSIX-only primitives.
- **Pinned libraries this phase touches:** `jose@6.2.12` (cleanup-token JWT + existing checkpoint signing), `oauth4webapi@3.8.8` (RFC 7009 revoke), `oauth2-mock-server@9.2.0` (test-only), `ajv@8.20.0`/`ajv-formats@3.0.1`/`json-schema-to-typescript@16.0.0` (schema + codegen). No other new packages permitted without a Package Legitimacy Gate pass.
- **No hand-rolled crypto:** the cleanup token MUST reuse `jose`'s EdDSA path and the runtime's existing Ed25519 checkpoint key; never construct a JWT/signature by hand.
- **Security:** deny by default; enforcement never delegated to the model; no secrets in logs or receipts; no credentials exposed to the agent; license never forwarded to customer resources. Directly binds D-22 (always discard credential copies), D-07/D-24 (receipts never carry raw predicate results or rows), and the cleanup-token/entitlement-revoke error-sanitization requirement (Pitfall 8 precedent).
- **Testing:** tests required for every state transition, every teardown path including partial failure, and scope denial — directly maps to TEAR-05's fault-matrix requirement.
- **Access vocabulary:** fixed `read | write | send | pay` — no free-form scopes; the predicate DSL and row-adapter binding (D-06) must not introduce a new access class.
- **License:** Apache-2.0 — no new dependency should carry an incompatible license (all Phase 5 dependencies are already-vetted, unchanged).
- **Environment note (this sandbox):** run pnpm as `npx --yes pnpm@12.6.0`; whole-repo `vitest run`/`eslint` OOMs — scope test runs per package/file (`--filter @stint/<pkg> test`, or a direct `vitest run <path>`), per-file lint.
- **GSD workflow enforcement:** file-changing work for this phase must go through `/gsd-execute-phase`, not direct edits.

## Summary

Phase 5 is almost entirely an **integration and extension** phase, not a greenfield one: every lifecycle transition this phase needs (`begin_teardown`, `teardown_succeeded`, `teardown_incomplete`, `retry_teardown`, `outcome_verified`, `entitlement_revoked`) already exists in `packages/core/src/transitions.ts` and already has a namespaced event constructor in `packages/core/src/events.ts` (`runtimeEvents`, `verifierEvents`, `publisherEvents`). Nothing in `@stint/core`'s transition table or event vocabulary needs to change. The work is: (1) build a `@stint/proxy`-resident teardown orchestrator that sequences five injectable steps and drives `reduce()` for each of them; (2) build the `resource_query` predicate grammar as a closed-AST parser in `@stint/spec` plus a pure evaluator, reusing the Phase 4 vault/`OutboundConnector`/binding execution path for the actual read; (3) add a runtime-minted, JWT-shaped (not the codebase's existing detached-JWS style) single-use cleanup token using `jose`'s `SignJWT`/`jwtVerify`; (4) extend the OAuth revoke path with RFC 7009's *structural* support check (AS metadata `revocation_endpoint` presence, never inferred from a 2xx); and (5) add an additive `LicenseIssuer.invalidate` port method plus a runtime-facing entitlement-revocation entry point.

Two concrete, already-shipped artifacts constrain this phase's shape in ways the CONTEXT.md decisions describe abstractly but don't cite: `spec/receipt.schema.json`'s `TeardownStepPayload.outcome` enum is currently `["revoked", "discarded_revocation_unsupported", "failed", "cleanup_incomplete"]` — it has **no `ok`, `not_applicable`, or `attested_ok`-style value** for the license-invalidate/cleanup-hook/delete-cache/final-receipt steps D-24 requires, so this phase must widen that JSON Schema enum (additive, safe against the existing golden-hash vector) and regenerate `@stint/spec`'s types via `json2ts` before the orchestrator can honestly receipt a non-OAuth step. Separately, the `Lease` interface (`packages/core/src/lease.ts`) has no field to hold D-14's persisted teardown-progress record — the natural, precedented path (Phase 4 added `LeaseCounters.actionTimestamps` the same way) is an **additive field on `Lease` itself**, not a new store or a second document, since `LeaseStore` only knows how to load/save/transact whole `Lease` values.

**Primary recommendation:** Treat this phase as "wire five new/extended pure-core seams into one proxy-side orchestrator," reusing every existing pattern (per-lease transaction, `reduce()`, `appendEntry`/`signCheckpoint`, `HostAdapter` await-helpers, `CredentialVault`/`OutboundConnector`) rather than inventing new infrastructure; the two schema/type gaps above (receipt enum, `Lease` progress field) are the only places genuinely new shape is required, and both should be additive changes with dedicated widening tasks early in the plan so every later task (orchestrator, tests) can compile against the final shape.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Predicate AST parsing + manifest-time validation (D-01, D-04, D-28) | `@stint/spec` (pure validation layer) | — | Mirrors the existing post-schema semantic-rule pattern (`collectSemanticErrors` in `validate.ts`); must be shared by validation and evaluation, so it cannot live only in the proxy |
| Predicate evaluation over normalized rows (D-01, D-28) | `@stint/spec` (pure evaluator) or `@stint/core` | `@stint/proxy` (caller) | Pure function over `{rows}` + AST, no I/O; proxy only supplies the rows via the vault/connector read |
| Verifier synthetic read (D-02, D-06) | `@stint/proxy` (I/O tier) | — | Reuses `vault/execute-stage.ts` + `CredentialVault` + `OutboundConnector` — the only place raw tokens legitimately appear |
| `user_confirm` out-of-band ask (D-05) | `@stint/core` (interface) / Host tier (implementation) | `@stint/proxy` (await-helper caller) | Mirrors `HostAdapter.requestConsent`/`awaitConsentDecision` exactly; core defines the contract and the deny-by-default timeout race, the host renders UI |
| Teardown orchestration (D-14–D-19, D-30, D-33) | `@stint/proxy` (I/O tier) | `@stint/core` (`reduce()` calls) | Proxy already owns vault/serializer/receipts wiring (D-16); core supplies pure transition decisions only, never sequences steps itself |
| OAuth revoke + structural RFC 7009 detection (D-20, TEAR-02) | `@stint/proxy` (`vault/oauth-client.ts`) | — | Extends the existing `refreshAccessToken`/`classifyTokenError` module, which already owns every `oauth4webapi` call site |
| Cleanup token mint/verify (D-08–D-12, TEAR-03) | `@stint/proxy` (mint) / Publisher's hook (verify, out of runtime's control) | `@stint/core` (signing key custody, reused from `checkpoint.ts`) | The runtime signs; the publisher's cleanup hook is the verifier, entirely outside this codebase's control — only the mint side and its receipt-honesty framing are this phase's concern |
| Entitlement revocation entry point (D-21, LIC-04) | `@stint/proxy` (new runtime-facing webhook/port) | `@stint/core` (`LicenseIssuer.invalidate`, `HeldLicense` discard) | Mirrors `revocation.ts`'s `applyProviderRevocation` shape: a thin proxy-side bridge into one sanctioned `reduce()` call, plus a new core port method |
| Receipt schema widening for step outcomes (RCPT-07, D-24) | `@stint/spec` (schema + generated types) | `@stint/core` (`receipts/chain.ts` consumers) | The schema is the canonical source per this project's `ajv` + `json-schema-to-typescript` convention; `@stint/core`'s `TeardownStepPayload` type is generated, never hand-widened |
| Teardown-progress persistence (D-14) | `@stint/core` (`Lease` shape) | `@stint/proxy` (writer via `runInLeaseTransaction`) | `LeaseStore` only persists whole `Lease` values; an additive field on `Lease` (mirroring `LeaseCounters.actionTimestamps`) is the only shape `transaction()` can carry |
| Checkpoint bracketing (D-31, RCPT-03) | `@stint/core` (`signCheckpoint`) | `@stint/proxy` (calls it at the right two moments) | Reuses `checkpoint.ts` unchanged; proxy decides *when* to call it (terminal transition, then post-step-5) |

## Standard Stack

No new external packages are required for this phase. Every dependency Phase 5 needs is already pinned and installed from Phases 1–4:

### Core (already installed, reused)
| Library | Version (installed) | Purpose in Phase 5 | Why Standard |
|---------|---------|---------|--------------|
| `jose` | 6.2.12 [VERIFIED: `node_modules/.pnpm/jose@6.2.12/node_modules/jose/dist/types/jwt/sign.d.ts`, `jwt/verify.d.ts`] | Cleanup-token mint/verify via `SignJWT`/`jwtVerify` (new usage in this codebase — see Code Examples), reusing the runtime's Ed25519 checkpoint keypair | Already the project's sole EdDSA library (`checkpoint.ts`, `envelope.ts`, `attested.ts` all use it, via the detached `FlattenedSign`/`flattenedVerify` shape); `SignJWT`/`jwtVerify` is the same package's compact-JWT API, confirmed present in the installed 6.2.12 tarball's type declarations |
| `oauth4webapi` | 3.8.8 [VERIFIED: `packages/proxy/src/vault/oauth-client.ts`] | RFC 7009 structural revocation-support detection + revoke call, extending the existing `refreshAccessToken`/`classifyTokenError` module | Already the project's sole OAuth client library; `oauth4webapi`'s `AuthorizationServer.revocation_endpoint` (from `oauth.discoveryRequest`/`processDiscoveryResponse`, or a manually-constructed `AuthorizationServer` object) is the structural signal D-20 requires — its *absence* (not an error response) is what drives `discarded_revocation_unsupported` |
| `oauth2-mock-server` | 9.2.0 [VERIFIED: `packages/proxy/package.json`, `packages/proxy/test/revocation-detection.test.ts`] | TEAR-05's RFC 7009 happy-path test + the Pitfall-5 "2xx without revoking" adversarial test | Already a `packages/proxy` devDependency and already used for the Phase 4 provider-revocation tests; the same mock AS instance style (`OAuth2Server` with a real loopback revocation endpoint) is directly reusable |
| `ajv` + `ajv-formats` | 8.20.0 / 3.0.1 [VERIFIED: `packages/spec/src/validate.ts`] | Manifest-time predicate validation gate (D-04) runs inside `validateManifest`'s existing schema+semantic pipeline; no new validator needed since the predicate grammar check is a semantic (post-schema) rule, not a JSON Schema keyword | Already `@stint/spec`'s sole validator; `job.verifier.predicate` is already schema-typed as `{ type: "string", minLength: 1, maxLength: 1000 }` [VERIFIED: `spec/manifest.schema.json:59`] with no format constraint, so grammar checking must happen in `collectSemanticErrors`, not the schema |
| `json-schema-to-typescript` | 16.0.0 [VERIFIED: `spec/receipt.schema.json`, `packages/spec/src/generated/receipt.ts`] | Regenerates `TeardownStepPayload` after the `outcome` enum is widened (D-24) | Already the project's sole schema→type generator; `packages/spec/src/generated/receipt.ts` is marked "DO NOT MODIFY BY HAND" — the enum change must go through the schema + `json2ts`, never a hand-edit |
| `node:crypto` | built-in | Not directly needed by Phase 5's own code paths (hashing is already handled by `@stint/spec`'s canonical serializer) | No new hashing surface this phase introduces |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `jose`'s `SignJWT`/`jwtVerify` (registered-claims compact JWT) for the cleanup token | `jose`'s `FlattenedSign`/`flattenedVerify` (the codebase's existing detached-signature style, used by `checkpoint.ts`/`envelope.ts`/`attested.ts`) | The cleanup token needs `exp`/`jti` semantics a hook implementer can verify with a standard JWT library (`jwtVerify` handles expiry/algorithm checks natively); a detached signature would require the hook to re-derive and check `exp`/`jti` itself, pushing more work onto every publisher's hook implementation. D-08/D-09 explicitly calls for "the `jose` EdDSA JWT path," which is the compact-JWT (`SignJWT`) shape, not the detached style — this is a genuinely new pattern for this codebase, not a drop-in reuse of `checkpoint.ts`'s helper. |
| Structural RFC 7009 detection (AS metadata presence) | A follow-up authenticated probe expecting 401 to positively confirm revocation | Explicitly deferred (CONTEXT.md Deferred Ideas); structural detection is what D-20 locks in for v0.1 |

### Package Legitimacy Audit

**Not applicable this phase** — no new external packages are installed. All libraries used (`jose`, `oauth4webapi`, `oauth2-mock-server`, `ajv`, `json-schema-to-typescript`) were already vetted and installed in Phases 1, 3, and 4. Confirm no new `dependencies`/`devDependencies` are added to any `package.json` during Phase 5 planning; if a plan does introduce one, run the Package Legitimacy Gate protocol against it before approval.

## Architecture Patterns

### System Architecture Diagram

```
                     ┌─────────────────────────────────────────────┐
                     │              @stint/proxy                    │
                     │                                               │
  agent tools/call ─▶│  dispatch.ts (existing, Phase 4)             │
  "check done" signal│    │                                          │
                     │    ▼                                          │
                     │  verifier trigger (new, LIFE-06) ─────┐       │
                     │                                        │       │
  provider 401/      │  applyProviderRevocation (existing,   │       │
  invalid_grant   ──▶│  Phase 4, retrofit: now auto-chains)  │       │
                     │                                        │       │
  publisher webhook ▶│  applyEntitlementRevocation (new,     │       │
  (LIC-04)           │  D-21, mirrors provider path)          │       │
                     │                                        ▼       │
                     │         ┌──────────────────────────────────┐  │
                     │         │  end-transition + auto-chain      │  │
                     │         │  begin_teardown (D-18)            │  │
                     │         │  [reduce() x2, same transaction]  │  │
                     │         └───────────────┬──────────────────┘  │
                     │                          ▼                     │
                     │         ┌──────────────────────────────────┐  │
                     │         │   Teardown Orchestrator (new)     │  │
                     │         │   runs under per-lease serializer │  │
                     │         │   (D-30, reuses lease-serializer) │  │
                     │         │                                    │  │
                     │         │  1. revoke OAuth (oauth-client.ts │  │
                     │         │     extended, D-20)                │  │
                     │         │  2. invalidate license             │  │
                     │         │     (LicenseIssuer.invalidate,     │  │
                     │         │      HeldLicense discard, D-21)    │  │
                     │         │  3. cleanup hook (new HTTPS        │  │
                     │         │     client + minted JWT, D-08-13)  │  │
                     │         │  4. delete cached data (vault      │  │
                     │         │     credential entries, license)   │  │
                     │         │  5. final signed receipt           │  │
                     │         │     (checkpoint.ts reused, D-31)   │  │
                     │         │                                    │  │
                     │         │  each step: reduce()-free; only    │  │
                     │         │  teardown_step receipt append +    │  │
                     │         │  progress-record write (D-14)      │  │
                     │         └───────────────┬──────────────────┘  │
                     │                          ▼                     │
                     │         reduce(tearing_down, teardown_        │
                     │         succeeded|incomplete, actor=runtime)  │
                     │                          │                     │
                     │                          ▼                     │
                     │         HostAdapter.notify(cleaned_up |       │
                     │         cleanup_incomplete)  (D-25, existing) │
                     └─────────────────────────────────────────────┘
                                       │
                                       ▼
                     ┌─────────────────────────────────────────────┐
                     │              @stint/core (pure)              │
                     │  reduce() / TRANSITION_TABLE (unchanged)     │
                     │  events.ts (unchanged — all ctors exist)     │
                     │  appendEntry / signCheckpoint (unchanged)    │
                     │  Lease += teardownProgress field (new, D-14) │
                     │  LicenseIssuer += invalidate() (new, D-21)   │
                     │  HostAdapter += confirmOutcome() (new, D-05) │
                     └─────────────────────────────────────────────┘
                                       │
                                       ▼
                     ┌─────────────────────────────────────────────┐
                     │              @stint/spec (pure)              │
                     │  predicate AST parser (new, D-01/D-04/D-28)  │
                     │  predicate evaluator (new, pure fn over rows)│
                     │  receipt.schema.json outcome enum widened    │
                     │  (D-24) + regenerated types                  │
                     └─────────────────────────────────────────────┘
```

A reader tracing the primary "lease ends → teardown" path: any of the six trigger sources (agent-signalled verification, provider 401, publisher webhook, plus the pre-existing user/clock/policy paths) causes an end-state `reduce()` call; the runtime immediately chains `begin_teardown`; the orchestrator runs its fixed five steps under the per-lease serializer, each step writing a `teardown_step` receipt and updating the persisted progress record; the final `reduce()` call lands `cleaned_up` or `cleanup_incomplete`; `HostAdapter.notify` fires; the receipt log and lease record survive.

### Recommended Project Structure

Extends the existing `packages/{core,proxy,spec}/src` layout — no new packages:

```
packages/spec/src/
├── predicate/                    # NEW (D-01, D-04, D-28)
│   ├── parse.ts                  # string -> closed AST | parse error
│   ├── ast.ts                    # AST node types (aggregate, filter, compare)
│   └── evaluate.ts                # pure (ast, rows) -> boolean, shared by validate + proxy
├── validate.ts                   # EXTENDED: collectSemanticErrors gains predicate-parse check
├── generated/receipt.ts          # REGENERATED after schema widening (D-24)
└── ...(unchanged)

packages/core/src/
├── lease.ts                      # EXTENDED: Lease gains teardownProgress? field (D-14)
├── host-adapter.ts                # EXTENDED: new confirmOutcome/requestOutcomeConfirmation method (D-05)
├── license/
│   ├── license-issuer.ts          # EXTENDED: invalidate(leaseId) port method (D-21)
│   └── held-license.ts            # unchanged (discard = drop the reference, no new API needed)
├── bindings.ts                    # EXTENDED: ConnectorBinding gains rowAdapter? (D-06)
└── ...(events.ts, transitions.ts, receipts/* all UNCHANGED)

packages/proxy/src/
├── teardown/                      # NEW (D-14-D-19, D-30, D-33)
│   ├── orchestrate.ts              # the 5-step sequential coordinator
│   ├── steps.ts                    # injectable TeardownStep port + 5 implementations
│   ├── progress.ts                 # progress-record read/update helpers
│   └── cleanup-token.ts            # jose SignJWT mint (D-08-D-11)
├── verification/                   # NEW (LIFE-06)
│   ├── resource-query.ts           # runs the @stint/spec evaluator over a vault-backed read
│   └── user-confirm.ts             # HostAdapter.confirmOutcome await-helper wiring
├── revocation.ts                   # EXTENDED: applyEntitlementRevocation mirrors applyProviderRevocation (D-21)
├── vault/oauth-client.ts           # EXTENDED: revokeToken + structural support detection (D-20)
└── dispatch.ts                     # EXTENDED: provider_revoked branch now also chains begin_teardown (D-18 retrofit)
```

### Pattern 1: Additive `Lease` field for teardown progress (mirrors Phase 4's `LeaseCounters.actionTimestamps` precedent)

**What:** `Lease` (`packages/core/src/lease.ts`) currently has no field for D-14's persisted teardown-progress record. `LeaseStore.transaction(id, mutate)` only ever loads/saves whole `Lease` values [VERIFIED: `packages/core/src/lease-store.ts:33,60`, quoted: `export type LeaseMutator = (lease: Lease) => Lease | Promise<Lease>;` / `transaction(id: string, mutate: LeaseMutator): Promise<Lease>;`], so there is no second document or side-channel to persist it in without breaking the "single source of truth, no receipt-log-replay logic" invariant D-14 states. The precedented path (exactly how Phase 4's 04-01 plan added `LeaseCounters.actionTimestamps`) is an additive, optional-safe field on `Lease` itself.

**When to use:** Any time new per-lease runtime state needs the same durability/serialization guarantee as the lease's own fields.

**Example:**
```typescript
// packages/core/src/lease.ts — additive extension (Claude's Discretion for exact field names)
export type TeardownStepName =
  | "revoke_oauth"
  | "invalidate_license"
  | "cleanup_hook"
  | "delete_cached_data"
  | "final_receipt";

export type TeardownStepOutcome =
  | "revoked" | "discarded_revocation_unsupported" | "failed"  // step 1 only
  | "ok" | "not_applicable" | "attested_ok";                    // steps 2-5

export interface TeardownProgress {
  readonly [step in TeardownStepName]?: TeardownStepOutcome;
}

export interface Lease {
  readonly id: string;
  readonly state: State;
  // ...existing fields unchanged...
  readonly teardownProgress?: TeardownProgress; // NEW, optional (absent until teardown starts)
}
```
`makeTestLease` in `packages/core/src/testing.ts` [VERIFIED: `packages/core/src/testing.ts:96-108`] will need the new field added to its override-friendly fixture (optional field means existing call sites without it keep compiling).

### Pattern 2: Teardown as one-pass ordered steps, NOT the retry-with-backoff saga ARCHITECTURE.md's own example shows

**What:** `.planning/research/ARCHITECTURE.md`'s Pattern 5 example code wraps each step in `withRetry(step.run, { maxAttempts: 3, backoffMs: 500 })` [read: `.planning/research/ARCHITECTURE.md:277`]. **CONTEXT.md's D-15 explicitly overrides this**: "One pass, then `cleanup_incomplete`... **No in-run timers/backoff**." The locked decision supersedes the earlier architecture research's illustrative code.

**When to use:** Always, for this phase — do not port the `withRetry`/backoff loop from the research doc's example into the orchestrator implementation. A failing step is recorded once and the saga moves on; recovery is the separate, explicit `retry_teardown` transition (D-15, D-32), not an in-process retry loop.

**Why this matters for planning:** A plan-checker or reviewer skimming ARCHITECTURE.md's Pattern 5 code sample could reasonably propose implementing `withRetry`; the plan must instead implement each step as a single attempt with a `try { ... } catch { return "failed" }` shape, no backoff, no timer.

### Pattern 3: Teardown-step outcome vocabulary requires a receipt-schema widening BEFORE orchestrator work starts

**What:** `spec/receipt.schema.json`'s `TeardownStepPayload.outcome` enum is currently exactly `["revoked", "discarded_revocation_unsupported", "failed", "cleanup_incomplete"]` [VERIFIED: `spec/receipt.schema.json:44-47`, quoted: `"outcome": { "type": "string", "enum": ["revoked", "discarded_revocation_unsupported", "failed", "cleanup_incomplete"] }`], and the generated TypeScript type mirrors it exactly [VERIFIED: `packages/spec/src/generated/receipt.ts:48-51`, quoted: `outcome: "revoked" | "discarded_revocation_unsupported" | "failed" | "cleanup_incomplete";`]. D-24 requires steps 2-5 to use `ok | failed`, plus `not_applicable` for a null cleanup hook and an attested-`ok` variant for the hook's 2xx. None of `ok`, `not_applicable`, or an attested-ok marker exist in the current enum. (`cleanup_incomplete` itself is a curious pre-existing enum member that reads like a *lease state* leaking into a *step outcome* vocabulary — it does not correspond to any step-level outcome D-24 describes; treat it as inert/unused rather than assigning new meaning to it, since removing it isn't required and the JSON Schema convention here is additive-only.)

**When to use:** This must be an early task in the plan, before the orchestrator or its tests are written, since every step implementation's return type depends on the final `TeardownStepPayload.outcome` union.

**How:** Widen the schema enum (additive — safe against the existing golden-hash fixture, which only ever instantiates the single value `"outcome": "revoked"` [VERIFIED: `spec/vectors/receipts/chain-input.json:34-37`, quoted: `"payload": { "step": "revoke_delegated_grant", "outcome": "revoked" }`]), then regenerate via the project's own `codegen`/`json2ts` pipeline (`pnpm codegen` per root `package.json`'s script), never hand-edit `packages/spec/src/generated/receipt.ts` (its own header says "DO NOT MODIFY IT BY HAND" [VERIFIED: `packages/spec/src/generated/receipt.ts:3-5`]).

**Note on `step` field:** `TeardownStepPayload.step` is a free-form `string` with no enum constraint [VERIFIED: `spec/receipt.schema.json:43`, quoted: `"step": { "type": "string", "minLength": 1, "maxLength": 128 }`] — no schema change is needed to introduce the five fixed step names; only the `outcome` enum needs widening.

### Pattern 4: D-18's auto-chain must retrofit the ONE existing `reduce()` call site in `@stint/proxy`, plus wire the two new ones this phase adds

**What:** As of Phase 4, `applyProviderRevocation` (`packages/proxy/src/revocation.ts`) is the **only** place in `@stint/proxy` that calls `@stint/core`'s `reduce()` [VERIFIED: grep of `packages/proxy/src` for `reduce(` returned exactly one call site, in `revocation.ts:49`]. It moves a lease to `revoked` but does **not** currently chain `begin_teardown` — confirmed by reading `revocation.ts` in full: the function returns immediately after `reduce(lease, providerEvents.grantRevoked(), now)` with no follow-up transition. D-18 requires every end-state transition to auto-chain `begin_teardown`; this existing call site is therefore in scope for a retrofit, not just the two new call sites (LIFE-06's `outcome_verified`, LIC-04's `entitlement_revoked`) this phase adds.

**When to use:** Design the auto-chain as one small shared helper (e.g. `chainTeardownIfEnded(lease, transitionResult, now)`) that any of the three call sites (existing provider-revocation, new entitlement-revocation, new outcome-verification) invokes after their own `reduce()` succeeds, rather than duplicating the "if the new state is an ending state, immediately dispatch `begin_teardown`" logic three times.

**Example:**
```typescript
// packages/proxy/src/teardown/auto-chain.ts (new)
import { reduce, runtimeEvents } from "@stint/core";
import type { Lease, Result, TransitionRecord } from "@stint/core";

const ENDING_STATES = ["completed", "expired", "revoked", "failed"] as const;

/**
 * D-18: after any transition lands a lease in an ending state, immediately
 * dispatch begin_teardown (actor runtime) as a second, distinct reduce()
 * call — never left as a bare ending-state lease. Call sites: the existing
 * provider-revocation path (retrofit), the new entitlement-revocation path
 * (LIC-04), and the new outcome-verification path (LIFE-06).
 */
export function chainTeardownIfEnded(
  lease: Lease,
  now: number,
): Result<{ lease: Lease; transition: TransitionRecord }> {
  if (!ENDING_STATES.includes(lease.state as (typeof ENDING_STATES)[number])) {
    // Not an ending state (e.g. reduce() itself failed, or state is non-terminal) — no-op shape TBD by plan.
    throw new Error("chainTeardownIfEnded: lease is not in an ending state.");
  }
  return reduce(lease, runtimeEvents.beginTeardown(), now);
}
```

**Open scope question this raises (see Open Questions):** `error_threshold_exceeded` (policy actor), `expire` (clock actor), and `revoke` (user actor) do not yet have ANY `reduce()` call site in `@stint/proxy` as of Phase 4 — `checkErrorThreshold` (policy.ts) is a pure predicate with no caller that dispatches the event, and user-initiated revoke is explicitly deferred to Phase 6's CLI. Phase 5's own requirement list (LIFE-06, LIC-04, TEAR-01..05, RCPT-07) does not include LIFE-07 or a general "wire expire/revoke" requirement. Confirm with the planner/user whether wiring those three dispatch call sites is in Phase 5's scope (the phase description says "however a lease ends... expiry, user... or policy" which reads as if it should be) or is a pre-existing gap being carried forward silently.

### Pattern 5: Predicate DSL — closed AST, shared parse+evaluate module in `@stint/spec`

**What:** D-28 places the parser in `@stint/spec`, validated in `validate.ts`'s existing `collectSemanticErrors` function [VERIFIED: `packages/spec/src/validate.ts:214-247`, confirmed function signature `function collectSemanticErrors(manifest: Manifest): SpecError[]` and its two existing checks: duplicate scope resources, and `unknown_resource_reference` for delegated resources not in scopes]. A third check for `job.verifier.type === "resource_query"` must parse `job.verifier.predicate` and push a new `SpecError` (a new code, e.g. `invalid_predicate`, added to `SPEC_ERROR_CODES` [VERIFIED: `packages/spec/src/errors.ts:11-29`, confirmed additive array pattern: `export const SPEC_ERROR_CODES = [...] as const;`]) on parse failure.

**When to use:** The parser must be exported from `@stint/spec` so `@stint/proxy`'s verifier module can import the SAME AST type and a pure `evaluate(ast, rows)` function — never re-parsing or duplicating grammar logic in the proxy.

**Example (grammar shape target, not a full implementation):**
```typescript
// packages/spec/src/predicate/ast.ts (new)
export type Aggregate = "count" | "sum" | "exists";
export type CompareOp = "=" | "!=" | "<" | "<=" | ">" | ">=";

export interface PredicateAst {
  readonly aggregate: Aggregate;
  readonly aggregateField?: string;        // required for "sum", absent for "count"/"exists"
  readonly filter?: { readonly field: string; readonly op: CompareOp; readonly literal: string | number };
  readonly compareOp: CompareOp;
  readonly compareLiteral: number;
}

// Must parse the spec's own conformance string verbatim:
// "count(rows where status = 'reconciled') >= 1"
// [VERIFIED: spec/ALP.md:121, quoted: "predicate": "count(rows where status = 'reconciled') >= 1"]
```

### Pattern 6: Cleanup token minting — `jose`'s compact-JWT API, a genuinely new pattern for this codebase

**What:** Every existing EdDSA usage in this codebase (`checkpoint.ts`, `packages/spec/src/jws.ts`, `envelope.ts`, `attested.ts`) uses `jose`'s **detached** signature primitives (`FlattenedSign`/`flattenedVerify`), never the compact-JWT `SignJWT`/`jwtVerify` pair. D-09 explicitly calls for "the `jose` EdDSA JWT path" for the cleanup token, which is the compact-JWT shape (registered claims `exp`/`jti`, verified natively by `jwtVerify`). This is a legitimately new code pattern, not a copy of `checkpoint.ts`'s helper.

**Example (confirmed against the installed `jose@6.2.12` type declarations):**
```typescript
// packages/proxy/src/teardown/cleanup-token.ts (new)
import { SignJWT, jwtVerify } from "jose";
import type { CryptoKey } from "jose";

const CLEANUP_TOKEN_TTL_SECONDS = 120; // order-of-minutes per D-11, runtime config, never manifest-carried

export async function mintCleanupToken(
  leaseId: string,
  jti: string,
  now: number,
  privateKey: CryptoKey, // the SAME Ed25519 key checkpoint.ts signs checkpoints with (D-09)
): Promise<string> {
  return new SignJWT({ scope: `cleanup:${leaseId}` })
    .setProtectedHeader({ alg: "EdDSA" })
    .setIssuedAt(now)
    .setExpirationTime(now + CLEANUP_TOKEN_TTL_SECONDS)
    .setJti(jti)
    .sign(privateKey);
}

// The hook implementer's verification side (documentation/reference only —
// this runs on the PUBLISHER's server, outside this codebase):
export async function verifyCleanupToken(token: string, publicKey: CryptoKey) {
  const { payload } = await jwtVerify(token, publicKey, { algorithms: ["EdDSA"] });
  return payload; // { scope: "cleanup:<lease_id>", jti, exp, iat }
}
```
`SignJWT`/`ProduceJWT`'s `setIssuedAt`/`setExpirationTime`/`setJti` methods are confirmed present on the installed package [VERIFIED: `node_modules/.pnpm/jose@6.2.12/node_modules/jose/dist/types/jwt/sign.d.ts:1-21` for `SignJWT`/`setProtectedHeader`/`sign`; `node_modules/.pnpm/jose@6.2.12/node_modules/jose/dist/types/types.d.ts:682-722` for `ProduceJWT`'s `setJti`/`setNotBefore`/`setExpirationTime`]; `jwtVerify`'s three-argument overload `(jwt, key, options)` returning `Promise<JWTVerifyResult>` is confirmed at [VERIFIED: `node_modules/.pnpm/jose@6.2.12/node_modules/jose/dist/types/jwt/verify.d.ts:18`].

### Pattern 7: RFC 7009 structural detection extends `vault/oauth-client.ts`, mirroring its existing classification style

**What:** `packages/proxy/src/vault/oauth-client.ts` already owns every `oauth4webapi` call site and already has a narrow, well-tested classification function (`classifyTokenError`) [VERIFIED: `packages/proxy/src/vault/oauth-client.ts:76-81`]. D-20's structural check extends this same module rather than creating a parallel one.

**Example:**
```typescript
// packages/proxy/src/vault/oauth-client.ts — extension (D-20)
import * as oauth from "oauth4webapi";

export type RevokeResult =
  | { readonly kind: "revoked" }
  | { readonly kind: "discarded_revocation_unsupported" }
  | { readonly kind: "failed"; readonly cause: unknown };

export async function revokeCredential(
  oauthClient: OAuthClient,
  refreshToken: string,
  opts: RefreshOptions = {},
): Promise<RevokeResult> {
  // Structural check FIRST — never infer from the response (D-20, Pitfall 5).
  if (oauthClient.as.revocation_endpoint === undefined) {
    return { kind: "discarded_revocation_unsupported" };
  }
  try {
    const requestOptions: oauth.TokenEndpointRequestOptions = {};
    if (opts.allowInsecureRequests === true) {
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      requestOptions[oauth.allowInsecureRequests] = true;
    }
    const response = await oauth.revocationRequest(oauthClient.as, oauthClient.client, oauthClient.clientAuth, refreshToken, requestOptions);
    await oauth.processRevocationResponse(response);
    // A 2xx here is NEVER upgraded beyond "revoked" per RFC 7009's own
    // "success even if not recognized" guarantee (D-20) — this IS the
    // honest ceiling, not a shortcut.
    return { kind: "revoked" };
  } catch (err) {
    return { kind: "failed", cause: err };
  }
}
```
`oauth.AuthorizationServer.revocation_endpoint` is an optional field per the OAuth 2.0 Authorization Server Metadata (RFC 8414) shape `oauth4webapi` types against; its absence (`undefined`), not a response code, is the D-20 signal. `oauth.revocationRequest`/`processRevocationResponse` are `oauth4webapi`'s documented RFC 7009 functions [CITED: oauth4webapi README, feature list — already used as a MEDIUM-confidence source in the project's own CLAUDE.md Sources section, since the README is a feature list rather than full API docs]. **Verify the exact function names/signatures (`revocationRequest` vs. an alternate name, parameter order) against the installed `oauth4webapi@3.8.8` package's type declarations during planning/implementation** — this pattern is derived from the library's documented RFC 7009 feature support, not from a direct read of its shipped `.d.ts` in this research pass.

### Pattern 8: `user_confirm` HostAdapter method mirrors `awaitConsentDecision` exactly

**What:** D-05 explicitly says "mirroring `requestConsent`/`requestApproval`." The existing `awaitConsentDecision` helper [VERIFIED: `packages/core/src/host-adapter.ts:143-179`] is the complete template: races the adapter call against an `AbortSignal`, resolves a fixed deny-by-default sentinel on abort/rejection, core alone decides the timeout outcome.

**Example:**
```typescript
// packages/core/src/host-adapter.ts — additive (D-05)
export interface OutcomeConfirmRequest {
  readonly leaseId: string;
  readonly prompt: string; // from job.verifier.prompt
}
export type OutcomeConfirmDecision =
  | { readonly decision: "confirm" }
  | { readonly decision: "reject"; readonly reason: "user_rejected" | "timeout" };

export interface HostAdapter {
  requestConsent(request: ConsentRequest, signal: AbortSignal): Promise<ConsentDecision>;
  requestApproval(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision>;
  requestOutcomeConfirmation(request: OutcomeConfirmRequest, signal: AbortSignal): Promise<OutcomeConfirmDecision>; // NEW
  notify(event: LifecycleEvent): Promise<void>;
}

export function awaitOutcomeConfirmDecision(
  adapter: HostAdapter,
  request: OutcomeConfirmRequest,
  signal: AbortSignal,
): Promise<OutcomeConfirmDecision> {
  // Identical shape to awaitConsentDecision/awaitApprovalDecision above —
  // copy the race/sentinel/never-throw structure verbatim.
  const reject: OutcomeConfirmDecision = { decision: "reject", reason: "timeout" };
  if (signal.aborted) return Promise.resolve(reject);
  return new Promise((resolve) => {
    let settled = false;
    const onAbort = () => { if (settled) return; settled = true; resolve(reject); };
    signal.addEventListener("abort", onAbort, { once: true });
    adapter.requestOutcomeConfirmation(request, signal).then(
      (decision) => { if (settled) return; settled = true; signal.removeEventListener("abort", onAbort); resolve(decision); },
      () => { if (settled) return; settled = true; signal.removeEventListener("abort", onAbort); resolve(reject); },
    );
  });
}
```

### Anti-Patterns to Avoid

- **Retry-with-backoff inside a teardown step:** the ARCHITECTURE.md research doc's own Pattern 5 example code does this; D-15 explicitly forbids it for this phase (one pass, no in-run timers/backoff).
- **Trusting a bare 2xx as proof of OAuth revocation:** Pitfall 5's exact trap; the structural check (D-20) must run before any HTTP call, and a 2xx after that check still only yields `revoked`, never a stronger claim.
- **Hand-editing `packages/spec/src/generated/receipt.ts`:** the file's own header forbids it; go through `spec/receipt.schema.json` + the `codegen` script.
- **A second `reduce()`-sequencing mechanism outside `@stint/core`:** the orchestrator must call `@stint/core`'s existing `reduce()`/event-constructor functions for every state change; it must never hand-roll a parallel state transition check.
- **Persisting teardown progress anywhere other than the `Lease` value itself (a second Map, a side file, a receipt-log replay):** D-14 explicitly rules this out ("single source of truth... no receipt-log-replay logic").
- **Re-attempting OAuth revocation on `retry_teardown`:** D-23 makes step 1 terminal once attempted; only steps that recorded `failed` (steps 2-5) are eligible for resume.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Per-lease mutual exclusion during teardown | A second `Map<leaseId, Promise>` queue inside the teardown module | `runInLeaseTransaction`/`LeaseStore.transaction` (already exists, D-30) | Already the project's own "Don't Hand-Roll" rule from Phase 4 RESEARCH.md — a second queue creates two sources of truth for the same guarantee |
| State transition legality checks in the orchestrator | Bespoke `if (lease.state === "tearing_down" && ...)` conditionals | `reduce()` + the namespaced event constructors in `events.ts` (all already exist) | `TRANSITION_TABLE` is the single source of truth, CI-cross-checked against `spec/ALP.md` §7.4; a parallel check can drift |
| Receipt hashing for `teardown_step` entries | A second canonicalization/hash function | `appendEntry`/`hashCanonical` from `@stint/spec` via `receipts/chain.ts` (already exists) | This project's own Pitfall 7 — non-canonical serialization breaks cross-version hash verification |
| Cleanup-token signature verification logic (on the publisher/hook side) | N/A — this runs outside the runtime's own codebase | Document the token format precisely enough (D-08/D-26) that a hook implementer can use any standard JWT/EdDSA library | The runtime only mints; verification is the publisher's own responsibility per spec §10 |
| RFC 7009 request/response handling | Raw `fetch` to the revocation endpoint | `oauth4webapi`'s `revocationRequest`/`processRevocationResponse` (verify exact names against the installed package during implementation) | Already the project's sole OAuth client library; hand-rolling risks missing RFC 7009's exact request shape (client auth, `token_type_hint`) |

**Key insight:** Almost nothing in this phase requires new library usage or new algorithms — the risk is entirely in *wiring discipline* (auto-chaining teardown from every end-state transition, keeping the orchestrator's `reduce()` calls the only sanctioned state-change path, and widening the two schema/type surfaces additively before writing code that depends on the widened shape).

## Common Pitfalls

### Pitfall 1: The `[OPEN: Phase 5]` markers can be "closed" in prose while the CI checker still passes with them present

**What goes wrong:** `scripts/check-alp-sections.mjs`'s `checkOpenMarkers` function only validates that any remaining `[OPEN: Phase N]` marker is **well-formed** (`/^\[OPEN: Phase [2-7]\]$/`) — it does **not** assert that a marker naming a *specific, already-completed* phase has been removed [VERIFIED: `scripts/check-alp-sections.mjs:120-121,195-201`, quoted: `const WELLFORMED_OPEN_RE = /^\[OPEN: Phase [2-7]\]$/;` and `function checkOpenMarkers(text, failures) { for (const match of text.matchAll(OPEN_MARKER_RE)) { if (!WELLFORMED_OPEN_RE.test(match[0])) { failures.push(...) } } }`]. This is not a hypothetical risk: reading `spec/ALP.md` directly shows **two markers from already-completed phases still present** — `` `[OPEN: Phase 2]` `` at line 392 (extension-request shape) and `` `[OPEN: Phase 4]` `` at line 431 (approval binding-hash format) [VERIFIED: `spec/ALP.md:392,431`, quoted: "The shape and bounds of an extension request are `[OPEN: Phase 2]`." / "the binding hash format is `[OPEN: Phase 4]`."] — both phases are marked "Complete" in `.planning/REQUIREMENTS.md`'s traceability table. This proves the checker's gap is real, not theoretical.

**Why it happens:** The checker was written to validate document *structure* (well-formedness), not to track which markers each phase promised to resolve.

**How to avoid:** Add an explicit task/test in the plan that greps `spec/ALP.md` for the literal strings `` `[OPEN: Phase 5]` `` (both the §7.6 and §10 instances) and asserts zero matches remain, independent of and in addition to running the existing `pnpm check:alp` script. Do not rely on `check:alp` passing as proof the markers are gone.

**Warning signs:** A plan or verification step that treats `pnpm check:alp` exiting 0 as sufficient evidence the two Phase 5 markers were resolved.

### Pitfall 2: Widening `TeardownStepPayload.outcome` after the orchestrator is already coded

**What goes wrong:** If step implementations are written against the current, too-narrow enum (`revoked | discarded_revocation_unsupported | failed | cleanup_incomplete`), every non-OAuth step's "success" case has no valid outcome value to write, forcing an ad hoc misuse (e.g. writing `"failed"` for a step that actually succeeded, or writing `"revoked"` for an unrelated step) that a later schema fix would have to retrofit across already-written code and tests.

**Why it happens:** The schema widening is easy to treat as "just a type detail" and defer, but every teardown-step receipt call site depends on the final union.

**How to avoid:** Sequence the schema-widening task first in the plan (Pattern 3 above), before any orchestrator or step-implementation task.

### Pitfall 3: `Lease.teardownProgress` omitted from `makeTestLease` and other lease-fixture builders

**What goes wrong:** `packages/core/src/testing.ts`'s `makeTestLease` [VERIFIED: `packages/core/src/testing.ts:96-108`] currently returns a fixed shape with no `teardownProgress` field. If the field is added to `Lease` without updating this fixture (even as `undefined`/absent, which is fine for an optional field), existing tests still pass — but a **new** teardown-specific test helper is needed to construct leases already `in tearing_down` with partial progress, and that helper does not yet exist anywhere.

**How to avoid:** Plan a small addition (either a fixture parameter or a dedicated `makeTearingDownTestLease` helper) alongside the `Lease` widening task.

### Pitfall 4: Treating `error_threshold_exceeded`/`expire`/user `revoke` dispatch wiring as "already handled" because LIFE-07 shows Complete

**What goes wrong:** `.planning/REQUIREMENTS.md` marks LIFE-07 "Complete" (Phase 2) and PRXY-04 "Complete" (Phase 4), which could be read as "the error-threshold transition is already wired end-to-end." In fact, `checkErrorThreshold` (`packages/core/src/policy.ts`) is a pure predicate with **no caller anywhere in `@stint/proxy` that feeds its `true` result into `reduce()`** [VERIFIED: grep of `packages/proxy/src` for `errorThresholdExceeded`/`clockEvents` returned zero matches outside doc comments]. Similarly, no `reduce()` call site exists yet for `clockEvents.expire()` or `userEvents.revoke()` in the proxy (user-revoke dispatch is explicitly deferred to Phase 6's CLI per CONTEXT.md's phase boundary). If Phase 5's auto-chain (D-18) is built only around the three call sites this phase's own requirement list mentions (provider revocation retrofit, entitlement revocation, outcome verification), three of the six "any way a lease ends" triggers named in the phase description (expiry, user, policy) will still have no dispatch path attached to the new teardown machinery at all — not because teardown is broken, but because nothing yet calls `reduce()` for those events.

**How to avoid:** Flag this explicitly for the planner (see Open Questions) rather than silently assuming it is out of scope or silently building it without confirmation — CONTEXT.md's own phase-boundary "Not in this phase" list does not mention this gap either way.

### Pitfall 5: RFC 7009 2xx-is-not-proof (Pitfall 5 from PITFALLS.md, TEAR-02's core honesty trap)

**What goes wrong:** A revoke call that returns 2xx is mistaken for confirmed revocation; RFC 7009 mandates success even for a token the provider doesn't recognize or can't revoke.

**How to avoid:** D-20's structural-first check (AS metadata `revocation_endpoint` presence) must run and short-circuit to `discarded_revocation_unsupported` BEFORE any HTTP call is attempted; a 2xx after a supported endpoint IS called still only yields `revoked` — never a stronger claim, and never additionally "confirmed" via any positive probe (that's the deferred idea).

**Test to write:** A mock AS/connector that HAS a `revocation_endpoint` and returns 2xx without actually invalidating the token must still be recorded `revoked` by this runtime's own honest ceiling (the runtime cannot know better structurally) — the distinguishing test is specifically the **absent-endpoint** case yielding `discarded_revocation_unsupported`, which `oauth2-mock-server`'s configuration (with/without a revocation endpoint registered) can directly produce.

### Pitfall 6: Windows JSON-store atomicity (Pitfall 9, deferred to Phase 6, but constrains Phase 5's persistence contract)

**What goes wrong:** Not this phase's direct concern (JSON `LeaseStore` lands in Phase 6, HOST-03) — but Phase 5's teardown-progress record shape and the "must survive restart, retry resumes idempotently" contract (D-14) is exactly what Phase 6's JSON store must uphold under Windows `EPERM`/`EBUSY` retry semantics.

**How to avoid this phase:** Build and test the progress record purely against the in-memory `LeaseStore` double + its existing contract-test factory (D-29); do not add any assumption into the progress-record design that depends on a specific storage backend's atomicity characteristics beyond what `LeaseStore`'s contract already guarantees (single `save`/`transaction` call per update, one `Lease` value).

## Code Examples

### Auto-chaining teardown after an end-state transition (D-18 retrofit of the existing provider-revocation path)

```typescript
// packages/proxy/src/revocation.ts — retrofit (existing function, D-18)
export function applyProviderRevocation(
  lease: Lease,
  now: number,
): Result<{ lease: Lease; transition: TransitionRecord }> {
  const revoked = reduce(lease, providerEvents.grantRevoked(), now);
  if (!revoked.ok) return revoked;
  // D-18: immediately chain begin_teardown — a second, distinct reduce() call.
  return reduce(revoked.value.lease, runtimeEvents.beginTeardown(), now);
}
```
Note this changes `applyProviderRevocation`'s returned `transition` to describe the `begin_teardown` event rather than `grant_revoked` — callers (`dispatch.ts`'s catch block) that currently receipt the `revoked` transition directly will need to receipt BOTH transitions (or the orchestrator's own bootstrapping needs to record the intermediate one); this is a concrete integration detail for the plan to resolve, not resolved by this research.

### Entitlement revocation entry point (LIC-04, D-21), mirroring the provider path exactly

```typescript
// packages/proxy/src/revocation.ts — new function (D-21)
export function applyEntitlementRevocation(
  lease: Lease,
  now: number,
): Result<{ lease: Lease; transition: TransitionRecord }> {
  const revoked = reduce(lease, publisherEvents.entitlementRevoked(), now);
  if (!revoked.ok) return revoked;
  return reduce(revoked.value.lease, runtimeEvents.beginTeardown(), now);
}
```
`publisherEvents.entitlementRevoked()` already exists [VERIFIED: `packages/core/src/events.ts:70-74`, quoted: `export const publisherEvents = { entitlementRevoked(): LeaseEvent { return freezeEvent({ type: "entitlement_revoked", actor: "publisher" }); }, };`] — no `@stint/core` event-constructor change needed.

### One-pass teardown step shape (D-15 — no retry/backoff, contrast with ARCHITECTURE.md's example)

```typescript
// packages/proxy/src/teardown/steps.ts (new)
export interface TeardownStep {
  readonly name: TeardownStepName;
  run(lease: Lease, now: number): Promise<TeardownStepOutcome>;
}

export async function runStepOnce(step: TeardownStep, lease: Lease, now: number): Promise<TeardownStepOutcome> {
  try {
    return await step.run(lease, now);
  } catch {
    // Single attempt, no retry loop, no backoff (D-15) — unlike
    // ARCHITECTURE.md Pattern 5's illustrative withRetry() wrapper.
    return "failed";
  }
}
```

## State of the Art

| Old Approach (research doc's illustrative example) | Current Approach (this phase's locked decisions) | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Teardown step retried with bounded exponential backoff in-process (`ARCHITECTURE.md` Pattern 5) | One pass per step, explicit `retry_teardown` for recovery, no in-run timers | Locked at `/gsd-discuss-phase` (D-15) | Simpler step implementations; recovery is a distinct, receipted, auditable transition rather than a silent internal retry |
| Positive confirmation of revocation via a follow-up 401 probe (`PITFALLS.md` Pitfall 5's "where possible" suggestion) | Structural detection only (AS metadata presence) for v0.1 | Locked at `/gsd-discuss-phase` (D-20, deferred idea) | Simpler v0.1 scope; the honesty ceiling is "discarded our copy," not "confirmed dead," for unsupported/ambiguous providers |

No externally-facing library API changes affect this phase (`jose`, `oauth4webapi` versions are unchanged from Phase 3/4's pins).

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `oauth4webapi@3.8.8`'s RFC 7009 functions are named `revocationRequest`/`processRevocationResponse` and `AuthorizationServer.revocation_endpoint` is the correct optional-field signal for structural support detection | Pattern 7 (Code Examples) | If names/shape differ, the revoke-extension code in `oauth-client.ts` needs adjustment; this was derived from the library's documented feature list (CLAUDE.md's own MEDIUM-confidence source), not a direct read of the installed package's `.d.ts` in this research pass — verify against `node_modules/.pnpm/oauth4webapi@3.8.8/node_modules/oauth4webapi/dist/**/*.d.ts` before implementation |
| A2 | The five fixed step names (`revoke_oauth`, `invalidate_license`, `cleanup_hook`, `delete_cached_data`, `final_receipt`) are a reasonable naming choice for `TeardownStepPayload.step` | Pattern 1, Pattern 3 | Low risk — `step` is a free-form string with no schema enum, so any naming choice is valid; this is Claude's Discretion per CONTEXT.md, not a hard requirement |
| A3 | Adding a new `SpecErrorCode` (e.g. `invalid_predicate`) for predicate-parse failures follows the existing additive-array convention safely | Pattern 5 | Low risk — confirmed the array is a plain `as const` list with no closed downstream consumer that would break on a new member |
| A4 | The teardown-progress record's exact field shape (`Record<TeardownStepName, TeardownStepOutcome>` vs. an array of `{step, outcome, at}` entries) | Pattern 1 | Medium — CONTEXT.md leaves this to Claude's Discretion; an array-of-entries shape may better support "which attempt number" bookkeeping if that ever matters, but a keyed record is simpler for "skip completed steps on resume" lookups. Either satisfies D-14's stated invariants. |

## Open Questions

1. **Is wiring the `error_threshold_exceeded`/`expire`/user-`revoke` `reduce()` dispatch call sites in scope for Phase 5?**
   - What we know: none of these three events has a `reduce()` call site anywhere in `@stint/proxy` as of Phase 4 (confirmed by grep); Phase 5's own requirement list (LIFE-06, LIC-04, TEAR-01..05, RCPT-07) does not name LIFE-07, LIFE-04, or a general "wire remaining triggers" requirement; CONTEXT.md's phase boundary explicitly defers only the CLI `revoke` *command* (Phase 6), not the underlying dispatch wiring for expiry/error-threshold.
   - What's unclear: whether "this phase adds the runtime that drives them with real I/O" (CONTEXT.md's own framing) is meant to cover all six end reasons or only the three genuinely new to this phase (verified-completion, publisher, and the provider-path retrofit).
   - Recommendation: confirm with the user/planner before writing tasks; if out of scope, the plan should still build the auto-chain helper (Pattern 4) generically enough that a later phase can call it from wherever expire/revoke/error-threshold dispatch eventually lands, without needing to touch the orchestrator itself.

2. **Does `applyProviderRevocation`'s changed return shape (now two chained transitions) require `dispatch.ts`'s catch block to append two transition receipts instead of one?**
   - What we know: `dispatch.ts`'s existing `provider_revoked` branch receipts a single `denied` call outcome in its `finally` block and saves whatever lease `applyProviderRevocation` returns; it does not itself append a `transition` receipt (that appears to happen elsewhere, or the transition receipt responsibility needs clarifying).
   - What's unclear: where `TransitionPayload` receipts currently get appended for `grant_revoked` in the existing Phase 4 code, and whether that call site needs to become two receipt appends after the D-18 retrofit.
   - Recommendation: trace the existing transition-receipt-append call site (not located in this research pass) before finalizing the orchestrator's receipt-append responsibilities.

3. **Exact `oauth4webapi@3.8.8` RFC 7009 API surface (see Assumption A1)** — verify against the installed package's shipped type declarations during implementation, not just the README feature list this research relied on.

## Environment Availability

No new external dependencies. All tools/services this phase needs were already verified available in Phases 1-4:

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | runtime | ✓ (project floor 22.18+, memory notes `npx --yes pnpm@12.6.0` invocation needed in this sandbox) | 22.18+/24 LTS | — |
| `jose` | TEAR-03 cleanup token | ✓ (installed, confirmed via `node_modules`) | 6.2.12 | — |
| `oauth4webapi` | TEAR-02 revocation | ✓ (installed, used in `packages/proxy/src/vault/oauth-client.ts`) | 3.8.8 | — |
| `oauth2-mock-server` | TEAR-05 tests | ✓ (installed, used in `packages/proxy/test/revocation-detection.test.ts`) | 9.2.0 | — |
| `ajv`/`ajv-formats`/`json-schema-to-typescript` | LIFE-06 predicate validation, receipt schema regen | ✓ (installed, used throughout `@stint/spec`) | 8.20.0/3.0.1/16.0.0 | — |

**Missing dependencies with no fallback:** none.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest 5.0.2 (existing, per-package `vitest run`) |
| Config file | none dedicated per-package beyond `package.json`'s `"test": "vitest run"` script (confirmed in `packages/core/package.json`, `packages/proxy/package.json`) |
| Quick run command | `npx --yes pnpm@12.6.0 --filter @stint/proxy test -- <test-file-path>` (scope to one file/package per this sandbox's documented OOM constraint) |
| Full suite command | `npx --yes pnpm@12.6.0 test` (root `pnpm build && vitest run` — expect OOM in this sandbox per project memory; scope per-package instead: `npx --yes pnpm@12.6.0 --filter @stint/core test`, `--filter @stint/proxy test`, `--filter @stint/spec test`) |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| LIFE-06 | `resource_query` predicate parses/evaluates the spec's own example correctly; unparseable predicate rejected at manifest validation | unit | `vitest run packages/spec/test/predicate.test.ts` | ❌ Wave 0 |
| LIFE-06 | Agent-signalled "done" with `false` predicate result is a no-op (lease stays active, negative receipt) | unit | `vitest run packages/proxy/test/verification.test.ts` | ❌ Wave 0 |
| LIFE-06 | `user_confirm`: `no`/timeout leaves lease active; `yes` completes it | unit | `vitest run packages/core/test/host-adapter.test.ts` (extend existing) | ✅ (extend) |
| LIC-04 | `entitlement_revoked` → `revoked` → auto teardown; `LicenseIssuer.invalidate` called; `HeldLicense` discarded | unit | `vitest run packages/proxy/test/entitlement-revocation.test.ts` | ❌ Wave 0 |
| TEAR-01 | Fixed 5-step order runs for every one of the four terminal-state entry points (completed/expired/revoked/failed) | integration | `vitest run packages/proxy/test/teardown-orchestrate.test.ts` | ❌ Wave 0 |
| TEAR-02 | Structural RFC 7009 detection: AS with no `revocation_endpoint` → `discarded_revocation_unsupported`; AS with endpoint + 2xx → `revoked` (never over-claimed); non-2xx/timeout → `failed` | integration (real `oauth2-mock-server`) | `vitest run packages/proxy/test/revocation-honesty.test.ts` | ❌ Wave 0 |
| TEAR-03 | Cleanup token: valid `cleanup:<lease_id>` scope, `jti`, short `exp`; a fresh token is minted per attempt (never reused) | unit | `vitest run packages/proxy/test/cleanup-token.test.ts` | ❌ Wave 0 |
| TEAR-04 | Single-step failure (each of the 5, in turn) → `cleanup_incomplete`, all steps' outcomes recorded exactly; `retry_teardown` resumes and skips completed steps; lease never reaches `active` again | integration (fault matrix) | `vitest run packages/proxy/test/teardown-fault-matrix.test.ts` | ❌ Wave 0 |
| TEAR-05 | Same fault matrix as TEAR-04 plus the Pitfall-5 mock-provider-2xx-without-revoking case and a mock cleanup hook returning failure/timeout | integration | (same file as TEAR-04, or a dedicated `teardown-pitfall5.test.ts`) | ❌ Wave 0 |
| RCPT-07 | After `cleaned_up`/`cleanup_incomplete`, receipt log and lease/progress record still `load()`-able; vault credentials and `HeldLicense` are gone | integration | `vitest run packages/proxy/test/teardown-receipts-survive.test.ts` | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** the single new/changed test file for that task (`vitest run <path>`, per the sandbox's per-file scoping constraint)
- **Per wave merge:** `--filter @stint/spec test`, `--filter @stint/core test`, `--filter @stint/proxy test` run separately (never the bare root `vitest run`, which OOMs per project memory)
- **Phase gate:** all three packages' scoped suites green, plus `pnpm check:alp` AND the explicit Phase-5-marker-absence grep (Pitfall 1) before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `packages/spec/test/predicate.test.ts` — covers LIFE-06's grammar/parse/evaluate surface
- [ ] `packages/proxy/test/verification.test.ts` — covers LIFE-06's runtime-side trigger/no-op/error-threshold semantics
- [ ] `packages/proxy/test/entitlement-revocation.test.ts` — covers LIC-04
- [ ] `packages/proxy/test/teardown-orchestrate.test.ts`, `teardown-fault-matrix.test.ts`, `teardown-receipts-survive.test.ts` — cover TEAR-01/04/05, RCPT-07
- [ ] `packages/proxy/test/revocation-honesty.test.ts` — covers TEAR-02 (extends the existing `oauth2-mock-server` harness pattern from `revocation-detection.test.ts`)
- [ ] `packages/proxy/test/cleanup-token.test.ts` — covers TEAR-03
- [ ] No new framework/config install needed — Vitest is already wired per-package

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | This phase adds no new end-user authentication surface |
| V3 Session Management | no | No session concept introduced |
| V4 Access Control | yes | Cleanup token's `cleanup:<lease_id>` scope claim is the access-control boundary the hook must enforce; single-use via fresh-mint-per-attempt (D-10) is this runtime's half of the contract |
| V5 Input Validation | yes | Predicate grammar is a closed AST with no `AND`/`OR`/nesting (D-01) — deliberately minimizes parser attack surface; manifest-time rejection (D-04) of any out-of-grammar predicate before consent |
| V6 Cryptography | yes | Cleanup token signed EdDSA via `jose`, reusing the existing runtime Ed25519 checkpoint key (D-09) — no hand-rolled crypto, no new key material generated |
| V7 Error Handling and Logging | yes | Teardown-step outcomes and revocation results must never leak raw tokens/credentials into receipts (mirrors the existing `scrub.ts` discipline from Phase 4); OAuth/HTTP library errors from the revoke/cleanup-hook calls must be sanitized before reaching any receipt (Pitfall 8 precedent) |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| RFC 7009 2xx-as-false-proof (revocation silent no-op) | Repudiation | Structural detection before any HTTP call (D-20); never upgrade a 2xx beyond "revoked" |
| Cleanup-token replay | Elevation of Privilege / Spoofing | Single-use via fresh mint per attempt + short TTL (D-10/D-11); the hook's own reject-reuse contract is attested, not verified by the runtime |
| Credential retained after a failed/unsupported revoke | Information Disclosure | D-22: runtime always discards its own cached copy regardless of revoke outcome |
| Predicate injection / arbitrary code execution via `job.verifier.predicate` | Elevation of Privilege | Closed-AST parser, never `eval`/`new Function`/arbitrary interpreter; grammar has no boolean combinators or nesting (D-01) |
| Secrets leaking through cleanup-hook/entitlement-revoke error paths | Information Disclosure | Sanitize every caught HTTP/OAuth error into a fixed, non-interpolated message before it can reach a receipt (mirrors existing `vault/scrub.ts` pattern) |

## Sources

### Primary (HIGH confidence — read directly this session)
- `packages/core/src/transitions.ts`, `events.ts`, `lease.ts`, `host-adapter.ts`, `lease-store.ts`, `testing.ts`, `policy.ts`, `errors.ts`, `bindings.ts` — full reads, confirming all six teardown/verification/revocation event constructors already exist and no `TRANSITION_TABLE` change is needed
- `packages/core/src/license/license-issuer.ts`, `held-license.ts` — confirmed `LicenseIssuer` port shape and `HeldLicense` custody discipline for the D-21 `invalidate` extension
- `packages/core/src/receipts/chain.ts`, `checkpoint.ts` — confirmed `appendEntry`/`signCheckpoint`/`verifyChain` shapes, `TeardownStepPayload` import site
- `packages/proxy/src/revocation.ts`, `dispatch.ts`, `vault/credential-vault.ts`, `vault/oauth-client.ts`, `vault/execute-stage.ts`, `connectors/outbound-connector.ts`, `concurrency/lease-serializer.ts` — full reads, confirming the exact I/O seams Phase 5 reuses/extends and that `applyProviderRevocation` is the sole existing `reduce()` call site in `@stint/proxy`
- `packages/spec/src/validate.ts`, `errors.ts` — full reads, confirming `collectSemanticErrors`'s exact signature and the additive `SpecErrorCode` array as the predicate-validation extension point
- `packages/spec/src/generated/receipt.ts`, `spec/receipt.schema.json` — confirmed the exact current `TeardownStepPayload.outcome` enum gap
- `spec/vectors/receipts/chain-input.json` — confirmed the golden-hash fixture only uses `"outcome": "revoked"`, so widening the enum is safe
- `spec/manifest.schema.json` (grep) — confirmed `predicate` is an unconstrained string (`minLength`/`maxLength` only)
- `spec/ALP.md` §§4, 5, 7-16 — full reads, confirming the exact `[OPEN: Phase 5]` marker locations (§7.6 line 402, §10 line 465) and the still-present `[OPEN: Phase 2]`/`[OPEN: Phase 4]` markers proving the checker gap
- `scripts/check-alp-sections.mjs` — full read, confirming `checkOpenMarkers`'s well-formedness-only behavior
- `node_modules/.pnpm/jose@6.2.12/node_modules/jose/dist/types/jwt/sign.d.ts`, `jwt/verify.d.ts`, `types.d.ts` — confirmed `SignJWT`/`ProduceJWT`/`jwtVerify` API shapes directly from the installed package
- `.planning/phases/05-lease-endings-teardown/05-CONTEXT.md`, `.planning/REQUIREMENTS.md`, `.planning/STATE.md`, `.planning/config.json` — full reads

### Secondary (MEDIUM confidence)
- `.planning/research/ARCHITECTURE.md` Pattern 5, Pattern 6, "Lease End + Teardown Flow", "Suggested Build Order" — read in full; Pattern 5's retry/backoff example explicitly superseded by D-15 (flagged in Pitfalls/Patterns above)
- `.planning/research/PITFALLS.md` Pitfalls 5, 7, 9, "Looks Done But Isn't" checklist — read in full
- `oauth4webapi` README feature-list claims about RFC 7009 function names (`revocationRequest`/`processRevocationResponse`) — carried over from this project's own CLAUDE.md Sources section, itself marked MEDIUM confidence there; not independently re-verified against the installed package's `.d.ts` in this research pass (see Assumption A1, Open Question 3)

### Tertiary (LOW confidence)
- None used as authoritative in this document; all `[ASSUMED]`-worthy claims are captured in the Assumptions Log instead.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new packages; every library's exact installed version and existing call sites were read directly
- Architecture: HIGH — every integration seam (vault, connector, serializer, receipts, transitions) was read directly; the two genuine gaps (receipt-schema enum, `Lease` progress field) were confirmed by direct inspection, not inferred
- Pitfalls: HIGH for the schema/marker/dispatch-wiring gaps (all confirmed via direct file reads and grep); MEDIUM for the exact `oauth4webapi` RFC 7009 function names (README-level, not `.d.ts`-verified)

**Research date:** 2026-09-28
**Valid until:** 30 days (stable, internal-codebase-dependent research; re-verify if Phases 1-4's code changes before planning begins)
