---
gsd_state_version: "1.0"
milestone: v0.1
current_phase: 04
current_phase_name: MCP Proxy & Credential Vault
status: executing
stopped_at: Completed 04-04-PLAN.md
last_updated: "2026-09-28T17:39:12.885Z"
last_activity: 2026-09-28
last_activity_desc: Phase 04 execution started
state_head: 87e28be86f40a3164a0136a1e10a91f9fd65df78
progress:
  total_phases: 7
  completed_phases: 0
  total_plans: 24
  completed_plans: 21
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-09-27)

**Core value:** A prompt-injected or misbehaving agent can never act outside the lease the user granted, and when the lease ends, for any reason, every credential is revoked and the teardown is honestly receipted.
**Current focus:** Phase 04 — MCP Proxy & Credential Vault

## Current Position

Phase: 04 (MCP Proxy & Credential Vault) — EXECUTING
Plan: 5 of 7
Status: Ready to execute
Last activity: 2026-09-28 — Phase 04 execution started

Progress: [░░░░░░░░░░] 0%

## Performance Metrics

**Velocity:**

- Total plans completed: 17
- Average duration: -
- Total execution time: 0.0 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 01 | 5 | - | - |
| 02 | 6 | - | - |
| 03 | 6 | - | - |

**Recent Trend:**

- Last 5 plans: -
- Trend: -

*Updated after each plan completion*
**Per-Plan Metrics:**

| Plan | Duration | Tasks | Files |
|------|----------|-------|-------|
| Phase 02 P01 | 25min | 2 tasks | 5 files |
| Phase 02 P03 | 22min | 3 tasks | 5 files |
| Phase 02 P02 | 20min | 2 tasks | 5 files |
| Phase 02 P04 | 18min | 2 tasks | 4 files |
| Phase 02 P05 | 9min | 2 tasks | 2 files |
| Phase 02 P06 | 25min | 3 tasks | 7 files |
| Phase 03 P01 | 25min | 3 tasks | 17 files |
| Phase 03 P02 | 35min | 3 tasks | 10 files |
| Phase 03 P05 | ~50min | 4 tasks | 15 files |
| Phase 03 P03 | 40min | 2 tasks | 14 files |
| Phase 03 P06 | 45min | 3 tasks | 9 files |
| Phase 03 P04 | 20min | 3 tasks | 5 files |
| Phase 04 P01 | 15min | 3 tasks | 10 files |
| Phase 04 P02 | 25min | 3 tasks | 9 files |
| Phase 04 P03 | 17min | 3 tasks | 5 files |
| Phase 04 P04 | ~30min | 3 tasks | 5 files |

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- [Roadmap]: 7 phases in the user-approved build order: spec, then pure core, receipts and licensing, proxy, teardown, CLI, and finally e2e + README. This is one phase above the standard 4-6 band, by user approval.
- [Roadmap]: HostAdapter (HOST-01) and the LeaseStore contract (with an in-memory double and contract suite) are defined in Phase 2 core, because the proxy and teardown depend on them. Reference implementations (HOST-02, HOST-03) land in Phase 6.
- [Roadmap]: Pure logic (policy function PRXY-02/03, error threshold LIFE-07, receipt chains, license refresh bound) is built in Phases 2-3 before any I/O. The proxy (Phase 4) wires it to live calls.
- [Roadmap]: Outcome verification (LIFE-06) and publisher revocation (LIC-04) sit with teardown in Phase 5 ("every way a lease ends").
- [Phase 02]: 02-01: Mirrored @stint/spec's error-vocabulary shape (const array -> derived union -> Result<T>) for a parallel CoreErrorCode enum, never importing SpecErrorCode.
- [Phase 02]: 02-01: TRANSITION_TABLE seeded with only the 3 'proposed' rows in this tracer; plan 02-02 completes all 24 keys/25 triples and adds the ALP.md 7.4 cross-check test.
- [Phase 02]: 02-03: over_actions_per_hour is defined in POLICY_REASON_CODES but not yet enforced in evaluatePolicy — LeaseCounters (D-01) lacks per-action timestamps and full concurrent enforcement is PRXY-04 (Phase 4). Tracked in WINDOWS.md.
- [Phase 02]: 02-03: widened Approvals.require_for (a union of fixed-length tuples) to a plain readonly array before .includes() to avoid TypeScript resolving the parameter type to never.
- [Phase 02]: [Phase 02] 02-02: Checkpoint answered transcribe-as-normative; TRANSITION_TABLE completed to all 24 keys/25 triples byte-transcribed from ALP.md §7.4, cross-checked at test time.
- [Phase 02]: [Phase 02] 02-02: The agent-boundary guarantee (D-19) required no new reduce() code — 'agent' is not in the Actor union or any TRANSITION_TABLE actors array, so the existing Step 2 actor re-check already rejects a hand-forged actor:'agent' event.
- [Phase 02]: [Phase 02] 02-04: resumeLease returns Result<{lease; transition: TransitionRecord | undefined}> since a matching resume has no §7.4 state-changing event to dispatch through reduce.
- [Phase 02]: [Phase 02] 02-04: both hash-guard and activate tests mint real VerifiedManifest values via @stint/spec/testing's signManifestForTest + verifyEnvelope rather than a hand-built fixture.
- [Phase 02]: [Phase 02] 02-05: LifecycleEvent covers exactly the eight lease states named in must_haves.truths (activated/completed/expired/revoked/failed/tearing_down/cleaned_up/cleanup_incomplete), omitting pre-activation states proposed/declined/granted as not independently notifiable in this plan's scope.
- [Phase 02]: [Phase 02] 02-05: awaitApprovalDecision/awaitConsentDecision each abort-race the adapter call and resolve the same deny/decline sentinel on abort or adapter rejection, with no real timer armed inside core (D-17); the Phase 4 proxy arms the actual deadline.
- [Phase 02]: [Phase 02] 02-06: LeaseStore's transaction() serializes per-id via a promise chain that swallows a prior failure before chaining the next call, so one rejected read-modify-write never wedges later transactions on the same id.
- [Phase 02]: [Phase 02] 02-06: vitest declared as an optional peerDependency of @stint/core so tsdown externalizes it from the ./testing bundle instead of inlining ~570KB of vitest internals into dist/testing.js.
- [Phase 02]: [Phase 02] 02-06: index.ts barrel now exports the complete Phase 2 surface (errors, transitions, events, reduce/Lease, bindings, policy, hash-guard, activate/resumeLease, HostAdapter, LeaseStore types); testing.ts is never re-exported from the public entry (D-14).
- [Phase 03]: [Phase 03] 03-01: Task 1 checkpoint confirmed the receipt/checkpoint wire format verbatim (ReceiptEntry field set, Option A prevHash linkage, GENESIS_PREV_HASH constant, Checkpoint field set).
- [Phase 03]: [Phase 03] 03-01: Chose a root-level oneOf of four fully-specified Entry definitions for receipt.schema.json over allOf+if/then, so json-schema-to-typescript generates a clean discriminated union without the allOf-strip codegen path.
- [Phase 03]: [Phase 03]: 03-02: Ed25519 checkpoints (jose, mirrors jws.ts) plus verifyChain anchoring - all four break reasons (hash_mismatch, reordered, truncated, checkpoint_sig_invalid) now report exact brokenAtSeq.
- [Phase 03]: [Phase 03] 03-05: Task 1 checkpoint confirmed paseto@4.0.1 legitimacy (panva, OIDC trusted-publish, zero deps, factory-composition API) before install.
- [Phase 03]: [Phase 03] 03-05: Task 2 checkpoint confirmed section 8 license wire format verbatim (snake_case lease_id/job/limits custom claims, exp/iat/nbf/jti registered, kid in footer, implicit assertion over lease_id + the manifest's own spec_version, 300s TTL as runtime config).
- [Phase 03]: [Phase 03] 03-05: deriveImplicitAssertion is the single shared function issue.ts/verify.ts import; verify.ts is the only paseto Verify call site with LICENSE_CLOCK_SKEW_SECONDS=5s explicit on every call, mapping every PasetoError subclass to a fixed non-interpolated reason code.
- [Phase 03]: [Phase 03] 03-03: Extended AttestedClaimPayload with publisherId+sig (Rule 2) and exported @stint/spec's verifyDetached (Rule 3) so the attested chain reuses the SAME detached-EdDSA verify path verifyEnvelope uses - no second Ed25519 verify path, publisher key resolved by publisherId then kid.
- [Phase 03]: [Phase 03] 03-03: mergeTimeline derives each timeline entry's origin from which argument (verified/attested) it came from, not re-read from entry.chain; stable sort by ts, then origin, then seq, carrying no integrity meaning (D-10).
- [Phase 03]: [Phase 03] 03-06: HeldLicense stores its raw token in a module-private WeakMap<HeldLicense,string> keyed by object identity, not a public interface field -- stricter than VerifiedManifest's brand pattern, since the wrapped value here is the secret itself; readLicenseToken is the only accessor by construction, proven with a type-level @ts-expect-error on direct field access.
- [Phase 03]: [Phase 03] 03-06: LicenseIssuer.reissue owns the LIC-03 clamp internally (calls clampedLicenseExpiry, returns null on refusal) rather than requiring callers to pre-clamp; issueLicense (03-05) keeps returning a raw string, and the mock LicenseIssuer wraps it in mintHeldLicense at the issuer boundary so 03-05's existing tests stayed unchanged.
- [Phase 03]: [Phase 03] 03-04: ReceiptStore's method names/internal Map-of-arrays representation are Claude's Discretion per 03-CONTEXT.md, mirroring LeaseStore's async CRUD shape scoped to append/load/checkpoint.
- [Phase 03]: [Phase 03] 03-04: The receipts public barrel re-exports ReceiptEntry/ReceiptChain/Checkpoint and payload/entry variant types directly from @stint/spec rather than re-declaring them in @stint/core.
- [Phase 04]: [Phase 04] 04-01: Task 1's package-legitimacy checkpoint pre-cleared by orchestrator; installed @modelcontextprotocol/sdk@1.30.1, oauth4webapi@3.8.8, oauth2-mock-server@9.2.0 at exact pins
- [Phase 04]: [Phase 04] 04-01: RED phase for LeaseCounters.actionTimestamps used pnpm typecheck (tsc -b) as the failing-test runner, not vitest, since the additive field is a compile-time-only interface change esbuild's runtime transform doesn't enforce
- [Phase 04]: [Phase 04] 04-01: actionTimestamps is data-only this plan; sliding-window pruning/actions_per_hour enforcement deferred to plan 04-03
- [Phase 04]: [Phase 04] 04-01: PRXY-04 requirement checkbox intentionally NOT marked complete despite the plan frontmatter's requirements:[PRXY-04] tag — this plan only lays the additive LeaseCounters.actionTimestamps groundwork; actual actions_per_hour/spend enforcement under concurrency (PRXY-04's real acceptance criteria) lands in plan 04-03, which should mark it complete
- [Phase 04]: [Phase 04] 04-02: resolveEffectiveBinding (dispatch.ts) is the ONE place tools/list visibility and tools/call authorization both resolve a binding through, collapsing both an unbound tool and a bound-but-out-of-scope tool to the same no_binding denial
- [Phase 04]: [Phase 04] 04-02: an errored execute() is receipted as outcome: denied with a fixed generic redactedSummary (execute_failed), never the underlying error message, since a connector error could carry request/arg material
- [Phase 04]: [Phase 04] 04-02: kept the low-level MCP Server per RESEARCH.md Pattern 1; suppressed the resulting @typescript-eslint/no-deprecated lint error with two narrow, justified eslint-disable-next-line comments
- [Phase 04]: [Phase 04] 04-03: Widened the 04-02 CapEnforcer seam (authorize gains limits; commit takes lease+call, returns the next Lease) as a Rule 3 blocking-issue fix needed for cap-enforcer.ts to typecheck against the seam per the plan's own behavior spec
- [Phase 04]: [Phase 04] 04-03: ProxyDeps.enforceCaps stays required/explicitly-injected (server.ts untouched); createCapEnforcer() is exported as the production default a real deployment passes, per D-12's no-hidden-defaults discipline
- [Phase 04]: [Phase 04] 04-03: over_actions_per_hour/over_max_actions/over_spend denials' interaction with LIFE-07's denialErrorTimestamps, and spend currency cross-checking beyond amount, are flagged for the verifier per the plan's own flagged_assumptions -- not addressed this plan
- [Phase 04]: [Phase 04] 04-04: D-11 commitment tuple confirmed at Task 1 checkpoint (proposed-tuple): hashCanonical({args, tool: binding.tool, provenance: binding.provenance, leaseVersion: lease.version})
- [Phase 04]: [Phase 04] 04-04: Widened the 04-02 ApprovalStage seam (CallContext.leaseVersion, ApprovalDecision.approvalId, ApprovalStage.verifyCommitment) as a Rule 3 blocking fix, mirroring 04-03's CapEnforcer widening precedent
- [Phase 04]: [Phase 04] 04-04: recompute-and-match re-derives binding and lease version fresh at execution time (not the pre-hold closures) so a binding hot-swap or out-of-band leaseStore.save() bypassing the transaction is actually observable and denies approval_drifted

### Pending Todos

None yet.

### Blockers/Concerns

- [Phase 3]: Research spike needed on the paseto@4.0.1 factory-composition API, implicit assertions and clock skew.
- [Phase 4]: Research spike needed on oauth4webapi RFC 7009/8707 against oauth2-mock-server. Pin the MCP Authorization spec text first.
- [Phase 6]: Windows atomicity (EPERM/EBUSY on rename) for the JSON LeaseStore. Must be proven on Windows CI.
- [Phase 1 -> 3]: The canonical serializer introduced for the manifest hash (SPEC-06) must be the same one used by receipt chains (RCPT-02).

## Deferred Items

Items acknowledged and deferred at milestone close, most recent first:

| Category | Item | Status | Deferred At | Milestone |
|----------|------|--------|-------------|-----------|
| *(none)* | | | | |

## Session Continuity

Last session: 2026-09-28T17:39:12.683Z
Stopped at: Completed 04-04-PLAN.md
Resume file: None
