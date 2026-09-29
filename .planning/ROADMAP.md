# Roadmap: Stint

## Overview

Stint v0.1 goes from a normative spec to a working lease runtime proven by an end-to-end example. The build front-loads pure, dependency-free decision logic (spec and manifest schema, then the lease state machine and policy engine, then receipts and licensing) so the security-critical invariants are correct before any I/O exists. The MCP proxy and credential vault then enforce those decisions at the trust boundary, the teardown orchestrator ends leases honestly on every termination path, the CLI proves the HostAdapter and LeaseStore plug-in interfaces from outside core, and the payment-reconciler example plus README close the milestone: e2e green and a quickstart that works as written.

## Phases

**Phase Numbering:**

- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: Foundation & ALP Spec** - Cross-platform monorepo with CI, normative `spec/ALP.md`, and the validated, typed, hashed and signed manifest (`@stint/spec`) (completed 2026-09-27)
- [x] **Phase 2: Lease State Machine & Policy Engine** - Pure table-driven lease reducer with actor attribution plus the pure policy decision function, HostAdapter and LeaseStore interfaces in `@stint/core` (completed 2026-09-27)
- [x] **Phase 3: Receipts & Licensing** - Hash-chained receipts with Ed25519 checkpoints and independent verified/attested chains, plus PASETO v4.public license issue, verify and bounded refresh (completed 2026-09-28)
- [x] **Phase 4: MCP Proxy & Credential Vault** - Agent-facing MCP proxy enforcing the lease per call, with limits, out-of-band approvals, secretless OAuth injection and per-call receipts (`@stint/proxy`) (completed 2026-09-28)
- [ ] **Phase 5: Lease Endings & Teardown** - Verified completion and every termination path drive a fixed-order, idempotent, fully receipted teardown with partial-failure recording
- [ ] **Phase 6: CLI & Reference Adapters** - `@stint/cli` commands, terminal reference HostAdapter, and the Windows-safe JSON-file LeaseStore
- [ ] **Phase 7: End-to-End Example & README** - `examples/payment-reconciler` hybrid-mode e2e test and a README whose quickstart works as written

## Phase Details

### Phase 1: Foundation & ALP Spec

**Goal**: Developers have a green, cross-platform monorepo; readers can learn the whole protocol from one normative document; publishers can author manifests that are validated, typed, hashed and signature-checked.
**Depends on**: Nothing (first phase)
**Requirements**: FND-01, FND-02, FND-03, SPEC-01, SPEC-02, SPEC-03, SPEC-04, SPEC-05, SPEC-06
**Success Criteria** (what must be TRUE):

  1. On a fresh clone, `pnpm install && pnpm test` builds and tests every `@stint/*` package green on Windows, macOS or Linux with Node 22.12+, CI runs typecheck, lint and tests on Linux and Windows for every push, and the repo is licensed Apache-2.0.
  2. A reader can learn the full protocol from `spec/ALP.md`: all eleven states and their transitions, the actor list (the agent is never an actor for ending or extending a lease), the three auth modes, teardown order, receipts, the trust model and the documented trust limits.
  3. A valid publisher manifest (agent, publisher, version, spec_version, job with outcome verifier, scopes, lease, limits, approvals, auth, cleanup) passes the draft-07 schema, while unknown scope, approval, verifier or auth-mode values are rejected with structured errors; `auth.delegated` accepts a list of grants and `auth.mode` defaults to `hybrid`.
  4. A developer imports TypeScript types generated from the schema through `@stint/spec`, and changing the schema without regenerating the types fails the build.
  5. The runtime computes the same canonical content hash for a manifest regardless of key order or whitespace, and rejects a manifest whose publisher signature does not verify before consent is ever requested.

**Plans:** 5/5 plans complete

Plans:

- [x] 01-01-PLAN.md - Monorepo foundation: pnpm workspace, four @stint/* packages, Apache-2.0 license test, CI on Linux and Windows (Node 22.12.0 and 24), package-legitimacy gate
- [x] 01-02-PLAN.md - Manifest and envelope schemas (draft-07), generated types with codegen:check, validateManifest with structured errors, valid and invalid manifest vectors
- [x] 01-03-PLAN.md - RFC 8785 canonical serializer and jcs-sha256 content hash, detached EdDSA envelope verification, branded VerifiedManifest, JCS and envelope vectors
- [x] 01-04-PLAN.md - spec/ALP.md lifecycle, actors, transition table, auth modes, enforcement, teardown, receipts, trust model and limits, plus the CI-wired structural checker
- [x] 01-05-PLAN.md - spec/ALP.md manifest walkthrough bound to the vector, envelope and content hash, consent, conformance, vectors README

### Phase 2: Lease State Machine & Policy Engine

**Goal**: Every lifecycle transition and every allow/deny decision is made by pure, fully tested code outside the model, so no agent behavior can end, extend or exceed a lease.
**Depends on**: Phase 1
**Requirements**: LIFE-01, LIFE-02, LIFE-03, LIFE-04, LIFE-05, LIFE-07, HOST-01, PRXY-02, PRXY-03
**Success Criteria** (what must be TRUE):

  1. A lease moves only through the eleven defined states via a table-driven pure reducer, and the test suite exercises every legal transition and rejects every illegal (state, event) pair.
  2. Every transition records its actor (user, verifier, policy, clock, provider, publisher, runtime); any attempt by the agent to end or extend a lease is rejected, and activating or resuming a lease with a manifest whose hash differs from the consented hash is rejected.
  3. The pure policy function returns allow, deny or require_approval for a call given the lease, runtime-owned connector bindings and an injectable clock: calls past lease expiry are denied with no timers involved, calls with no binding are denied, and a manifest that labels a `send` tool as `read` cannot change its classification.
  4. N denied calls or upstream errors within the configured window move the lease to `failed` with actor `policy`, while N-1 do not.
  5. A platform builder can implement the single `HostAdapter` contract (consent, per-call approval, lifecycle notifications) exported by `@stint/core`; a lease extension succeeds only after fresh consent through it, and no license-refresh event can move lease expiry.

**Plans:** 6/6 plans complete

Plans:
**Wave 1**

- [x] 02-01-PLAN.md — Tracer: Lease model + table-driven reduce() end-to-end (one legal + one illegal transition) with Result/rejection, version, TransitionRecord, actor-namespaced events (wave 1)

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 02-02-PLAN.md — Reducer completion: full ALP.md §7.4 table + spec cross-check, all actor constructors, extend/expire, agent-never-actor guarantee (wave 2)
- [x] 02-03-PLAN.md — Policy engine + runtime-owned connector bindings: evaluatePolicy (deny-by-default, binding-only classification, per-call expiry) + checkErrorThreshold (wave 2)

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 02-04-PLAN.md — Manifest-hash binding: verifyBoundHash shared guard + activateLease/resumeLease with distinct activation_failed/runtime_failure events (wave 3)
- [x] 02-05-PLAN.md — HostAdapter contract: three async methods + LifecycleEvent union + core-owned timeout-as-deny/decline wrappers (wave 3)

**Wave 4** *(blocked on Wave 3 completion)*

- [x] 02-06-PLAN.md — LeaseStore contract + in-memory double + reusable contract-test suite (@stint/core/testing) + public API barrel wiring (wave 4)

**Enabling work**: This phase also defines the `LeaseStore` contract in `@stint/core` with an in-memory test double and a shared contract test suite, because the proxy (Phase 4) and teardown (Phase 5) depend on it. HOST-03 (JSON-file store, Windows atomicity) is delivered and mapped in Phase 6.

### Phase 3: Receipts & Licensing

**Goal**: Every lease has a tamper-evident audit trail whose verified and attested chains check independently, and publishers can issue short-lived licenses whose refresh can never outlive the lease.
**Depends on**: Phase 2
**Requirements**: RCPT-02, RCPT-03, RCPT-04, RCPT-05, RCPT-06, LIC-01, LIC-02, LIC-03
**Success Criteria** (what must be TRUE):

  1. Appending entries builds a hash chain through the single canonical serializer, and a golden-hash fixture test pins the exact bytes and hashes identically on Windows and Linux.
  2. The runtime signs chain checkpoints with Ed25519, and verifying a tampered, reordered or truncated chain (relative to its last signed checkpoint) reports the exact entry where it breaks.
  3. Publisher-signed attested entries live in a separate chain that verifies independently of the runtime's verified chain, and both merge into one plain-language timeline that marks every entry as verified or attested (ordering is display-only).
  4. A mock publisher issues a PASETO v4.public license (lease id, job, expiry, limits, 5-minute default TTL) that its server verifies offline with the public key, using one shared implicit-assertion derivation and an explicit, tested clock-skew tolerance; a license bound to a different lease or outside the skew window is rejected.
  5. Under an injectable clock, the runtime refreshes the license before TTL expiry, stops at lease expiry so no refreshed token ever outlives the lease, and holds the license itself with no path that hands it to the agent.

**Plans:** 6/6 plans complete

Plans:
**Wave 1**

- [x] 03-01-PLAN.md - Receipts tracer: receipt/checkpoint draft-07 schemas + codegen + generated types, chain.ts appendEntry/verifyChain over the single canonical serializer, golden-hash vector, and spec/ALP.md section 11 resolution (RCPT-02)

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 03-02-PLAN.md - Ed25519 signed checkpoints (jose, injectable keypair) + verifyChain exact break-locus anchored to the last checkpoint: hash_mismatch, reordered, truncated, checkpoint_sig_invalid (RCPT-03, RCPT-06)
- [x] 03-05-PLAN.md - Licensing tracer: PASETO v4.public issue/verify, one shared implicit-assertion derivation, explicit clock-skew tolerance, spec/ALP.md section 8 resolution + license vector; paseto legitimacy gate (LIC-01, LIC-02)

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 03-03-PLAN.md - Attested chain independent verification via the reused @stint/spec trust model + display-only merged timeline (RCPT-04, RCPT-05)
- [x] 03-06-PLAN.md - Bounded license refresh (clamped, never outlives the lease) + opaque HeldLicense custody + LicenseIssuer port + mock issuer + license barrel (LIC-03)

**Wave 4** *(blocked on Wave 3 completion)*

- [x] 03-04-PLAN.md - ReceiptStore contract + in-memory double + reusable contract-test factory (@stint/core/testing) + receipts public API barrel (RCPT-02, RCPT-03 persistence)

**Research flag**: yes - `paseto@4.0.1` uses panva's new factory-composition API (weeks old at research time). Pin exactly, wrap thinly, and confirm implicit-assertion handling and clock-skew options before planning.

### Phase 4: MCP Proxy & Credential Vault

**Goal**: An agent connected over MCP can only see and call what its lease permits, never holds a real credential, and leaves a receipt for every call it makes.
**Depends on**: Phase 3
**Requirements**: PRXY-01, PRXY-04, PRXY-05, PRXY-06, PRXY-07, PRXY-08, RCPT-01, LIC-05
**Success Criteria** (what must be TRUE):

  1. An agent connecting to the proxy as an MCP server lists only the tools its lease permits, and every `tools/call`, allowed or denied, appends a receipt with an args hash and binding-redacted summary; no raw args or secrets appear in any receipt.
  2. Concurrent calls against one lease never exceed `actions_per_hour`, the total action cap or the `spend` limit (per-lease serialization), and concurrent refreshes of one credential result in exactly one refresh.
  3. A call requiring approval (`send`, `pay`, `irreversible`) is held until the user decides out of band through the HostAdapter; the approval is bound to a hash of the exact args, binding and lease version, so a call whose args changed after approval is denied, and an unanswered approval denies on timeout.
  4. Adversarial tests show OAuth access tokens (with RFC 8707 resource indicators) are injected only on outbound calls and never appear in any agent-facing response or error, and the publisher license is never forwarded to a customer resource.
  5. When the mock authorization server revokes the customer's grant, the next call's `invalid_grant`/401 moves the lease to `revoked` with actor `provider`.

**Plans**: 7/7 plans executed
**Wave 1**

- [x] 04-01-PLAN.md — scaffold `@stint/proxy` + install 3 pinned deps (behind legitimacy checkpoint) + additive `LeaseCounters.actionTimestamps` + engines fix

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 04-02-PLAN.md — tracer: `tools/list` filtering + `tools/call` allow/deny routing + one verified-chain receipt per call (PRXY-01, RCPT-01)

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 04-03-PLAN.md — caps: sliding-window `actions_per_hour` + action/spend cap + pay-amount extraction, concurrency-safe (PRXY-04)

**Wave 4** *(blocked on Wave 3 completion)*

- [x] 04-04-PLAN.md — approvals held out-of-band, commitment-hash bound, drift/timeout deny (PRXY-05)

**Wave 5** *(blocked on Wave 4 completion)*

- [x] 04-05-PLAN.md — credential vault: seed seam + RFC 8707 refresh + per-credential single-flight (PRXY-08)

**Wave 6** *(blocked on Wave 5 completion)*

- [x] 04-06-PLAN.md — vault-backed ExecuteStage: token injection + secretless boundary + license never forwarded (PRXY-06, LIC-05)

**Wave 7** *(blocked on Wave 6 completion)*

- [x] 04-07-PLAN.md — customer-side OAuth revocation detection via `invalid_grant` → `revoked` (actor provider) (PRXY-07)

**Research flag**: yes - Validate `oauth4webapi@3.8.8` token revocation (RFC 7009) and resource indicators (RFC 8707) hands-on against `oauth2-mock-server`; pin the current MCP Authorization spec text; confirm the `@modelcontextprotocol/sdk@1.30.1` dual server/client topology. The RFC 7009 findings also feed Phase 5 teardown.

### Phase 5: Lease Endings & Teardown

**Goal**: However a lease ends (verified completion, expiry, user, publisher, provider or policy), every credential is revoked in a fixed order and the teardown, including every partial failure, is honestly receipted.
**Depends on**: Phase 4
**Requirements**: LIFE-06, LIC-04, TEAR-01, TEAR-02, TEAR-03, TEAR-04, TEAR-05, RCPT-07
**Success Criteria** (what must be TRUE):

  1. A lease completes only through its outcome verifier (a `resource_query` predicate evaluated through the proxy with runtime credentials, or `user_confirm` through the HostAdapter); with `none` it ends only on expiry or user action, and the agent's own "done" claim never completes it.
  2. Ending a lease for any reason runs teardown in fixed order (revoke OAuth, invalidate license, cleanup hook, delete cached data, final signed receipt), and a publisher entitlement revocation moves the lease to `revoked` with actor `publisher` and triggers that same teardown.
  3. Each credential records `revoked`, `discarded_revocation_unsupported` or `failed`, a provider without RFC 7009 support yields `discarded_revocation_unsupported`, and a bare 2xx is never claimed as more than RFC 7009 guarantees; the uninstall hook accepts only a single-use cleanup token scoped to `cleanup:<lease_id>` and rejects its reuse.
  4. Any single step failing lands the lease in `cleanup_incomplete` with every step's result recorded, retrying resumes idempotently, the lease can never return to `active`, and tests cover every teardown path including each single-step failure.
  5. After cleanup, both receipt chains, including the final signed receipt, remain readable and verify.

**Plans:** 3/8 plans executed

Plans:
**Wave 1**

- [x] 05-01-PLAN.md — Teardown shape foundation: widen TeardownStepPayload.outcome enum (+regen) and add optional Lease.teardownProgress + fixtures (TEAR-01, TEAR-04, RCPT-07 groundwork)
- [x] 05-02-PLAN.md — Predicate DSL: closed-AST parser + pure evaluator in @stint/spec, manifest-time invalid_predicate gate, close spec §7.6/§4 markers (LIFE-06) [checkpoint: grammar one-way]

**Wave 2** *(blocked on 05-01)*

- [x] 05-03-PLAN.md — Teardown orchestrator tracer (auto-chain begin_teardown, fixed 5-step saga, cleaned_up + signed final receipt) + one-pass fault handling & idempotent retry_teardown resume (TEAR-01, TEAR-04, TEAR-05)

**Wave 3** *(blocked on 05-03)*

- [x] 05-04-PLAN.md — Step 1 OAuth revoke honesty: structural RFC 7009 revokeCredential, vault revoke+discard, always-discard-our-copy, Pitfall-5 matrix (TEAR-02, TEAR-05)

**Wave 4** *(blocked on 05-03, 05-04)*

- [x] 05-05-PLAN.md — Step 2 publisher entitlement revocation + LicenseIssuer.invalidate port + license custody discard (LIC-04)

**Wave 5** *(blocked on 05-05)*

- [ ] 05-06-PLAN.md — Step 3 cleanup token: jose SignJWT single-use cleanup:<lease_id>, runtime HTTPS hook client, close spec §10 marker (TEAR-03, TEAR-05) [checkpoint: token format one-way]

**Wave 6** *(blocked on 05-02, 05-03, 05-06)*

- [ ] 05-07-PLAN.md — Outcome verification runtime: resource_query synthetic verifier read + rowAdapter, user_confirm HostAdapter method, agent-claim-never-completes (LIFE-06)

**Wave 7** *(blocked on 05-06, 05-07)*

- [ ] 05-08-PLAN.md — Phase gate: step 4 delete/retain split, RCPT-07 receipts-survive + checkpoint bracketing, every-terminal-entry teardown, zero OPEN-Phase-5 markers (RCPT-07, TEAR-05)

### Phase 6: CLI & Reference Adapters

**Goal**: A user can run the whole lease lifecycle from a terminal, and the HostAdapter and LeaseStore plug-in contracts are proven implementable outside core and proxy.
**Depends on**: Phase 5
**Requirements**: HOST-02, HOST-03, CLI-01, CLI-02
**Success Criteria** (what must be TRUE):

  1. A user can create a lease from a manifest via the CLI after a consent prompt rendered from the manifest (scopes, limits, approvals, auth mode, verifier), then inspect it, revoke it and run or retry its cleanup.
  2. During a run, per-call approvals prompt in the terminal through the reference HostAdapter, and a prompt left unanswered denies on timeout.
  3. A user can print a lease's receipts as one merged plain-language timeline marking verified and attested entries, and verify chain integrity from the CLI, with a tampered receipt file reported at the exact break.
  4. The JSON-file LeaseStore passes the same contract suite as the in-memory store plus a concurrent read/write test on Windows CI (atomic writes and locking, no lost updates or torn files).

**Plans**: TBD
**Research flag**: yes - Windows file atomicity: `write-file-atomic@^7` and `proper-lockfile@4.1.2` behavior under EPERM/EBUSY on rename with concurrent readers; the concurrency test must run on Windows CI.

### Phase 7: End-to-End Example & README

**Goal**: The payment-reconciler example proves the whole runtime end to end in hybrid mode, and a newcomer can understand Stint and run the quickstart from the README as written.
**Depends on**: Phase 6
**Requirements**: E2E-01, E2E-02, DOC-01
**Success Criteria** (what must be TRUE):

  1. `examples/payment-reconciler` runs in hybrid mode: licensed by a mock publisher, it reads mocked Paystack transactions through OAuth and writes to a mocked orders sheet, entirely through the proxy.
  2. The e2e test passes on Linux and Windows CI and covers the happy path to `cleaned_up`, a denied out-of-scope call, an approved call, a user revoke mid-run, and a partial teardown failure landing in `cleanup_incomplete`.
  3. A newcomer reading the README understands the problem, the three auth modes and the trust limits of hosted mode, and following the quickstart verbatim on a fresh clone runs the example agent successfully.

**Plans**: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5 → 6 → 7

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Foundation & ALP Spec | 5/5 | Complete    | 2026-09-27 |
| 2. Lease State Machine & Policy Engine | 6/6 | Complete    | 2026-09-27 |
| 3. Receipts & Licensing | 6/6 | Complete    | 2026-09-28 |
| 4. MCP Proxy & Credential Vault | 7/7 | Complete    | 2026-09-28 |
| 5. Lease Endings & Teardown | 3/8 | In Progress|  |
| 6. CLI & Reference Adapters | 0/TBD | Not started | - |
| 7. End-to-End Example & README | 0/TBD | Not started | - |
