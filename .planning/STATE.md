---
gsd_state_version: "1.0"
milestone: v0.1
current_phase: 03
current_phase_name: Receipts & Licensing
status: executing
stopped_at: Completed 03-03-PLAN.md (attested chain + display-only merge)
last_updated: "2026-09-28T00:40:11.234Z"
last_activity: 2026-09-28
last_activity_desc: Phase 03 execution started
state_head: 51c79e6be97ffca49c7eb48646abad25e664f211
progress:
  total_phases: 7
  completed_phases: 0
  total_plans: 17
  completed_plans: 15
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-09-27)

**Core value:** A prompt-injected or misbehaving agent can never act outside the lease the user granted, and when the lease ends, for any reason, every credential is revoked and the teardown is honestly receipted.
**Current focus:** Phase 03 — Receipts & Licensing

## Current Position

Phase: 03 (Receipts & Licensing) — EXECUTING
Plan: 4 of 6 complete (wave-based execution: 03-05 depended only on 03-01 and ran ahead of 03-03/03-04; 03-03 has now also completed)
Status: 03-01, 03-02, 03-03, 03-05 have SUMMARY.md; 03-04, 03-06 still pending
Last activity: 2026-09-28 — Completed 03-03-PLAN.md (attested chain + display-only merge)

Progress: [░░░░░░░░░░] 0%

## Performance Metrics

**Velocity:**

- Total plans completed: 11
- Average duration: -
- Total execution time: 0.0 hours

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 01 | 5 | - | - |
| 02 | 6 | - | - |

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

Last session: 2026-09-28T00:40:11.030Z
Stopped at: Completed 03-03-PLAN.md (attested chain + display-only merge)
Resume file: None
