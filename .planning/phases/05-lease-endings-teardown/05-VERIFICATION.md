---
phase: 05-lease-endings-teardown
verified: 2026-09-29T08:05:00Z
status: passed
score: 8/8 must-haves verified
covered_files: [".planning/REQUIREMENTS.md", ".planning/phases/05-lease-endings-teardown/05-01-PLAN.md", ".planning/phases/05-lease-endings-teardown/05-01-SUMMARY.md", ".planning/phases/05-lease-endings-teardown/05-02-PLAN.md", ".planning/phases/05-lease-endings-teardown/05-02-SUMMARY.md", ".planning/phases/05-lease-endings-teardown/05-03-PLAN.md", ".planning/phases/05-lease-endings-teardown/05-03-SUMMARY.md", ".planning/phases/05-lease-endings-teardown/05-04-PLAN.md", ".planning/phases/05-lease-endings-teardown/05-04-SUMMARY.md", ".planning/phases/05-lease-endings-teardown/05-05-PLAN.md", ".planning/phases/05-lease-endings-teardown/05-05-SUMMARY.md", ".planning/phases/05-lease-endings-teardown/05-06-PLAN.md", ".planning/phases/05-lease-endings-teardown/05-06-SUMMARY.md", ".planning/phases/05-lease-endings-teardown/05-07-PLAN.md", ".planning/phases/05-lease-endings-teardown/05-07-SUMMARY.md", ".planning/phases/05-lease-endings-teardown/05-08-PLAN.md", ".planning/phases/05-lease-endings-teardown/05-08-SUMMARY.md", "packages/core/src/bindings.ts", "packages/core/src/host-adapter.ts", "packages/core/src/index.ts", "packages/core/src/lease.ts", "packages/core/src/license/license-issuer.ts", "packages/core/src/testing.ts", "packages/core/test/host-adapter.test.ts", "packages/core/test/lease-teardown-progress.test.ts", "packages/proxy/src/dispatch.ts", "packages/proxy/src/index.ts", "packages/proxy/src/revocation.ts", "packages/proxy/src/server.ts", "packages/proxy/src/teardown/auto-chain.ts", "packages/proxy/src/teardown/cleanup-client.ts", "packages/proxy/src/teardown/cleanup-token.ts", "packages/proxy/src/teardown/orchestrate.ts", "packages/proxy/src/teardown/progress.ts", "packages/proxy/src/teardown/steps.ts", "packages/proxy/src/vault/credential-vault.ts", "packages/proxy/src/vault/oauth-client.ts", "packages/proxy/src/verification/resource-query.ts", "packages/proxy/src/verification/user-confirm.ts", "packages/proxy/test/cleanup-token.test.ts", "packages/proxy/test/entitlement-revocation.test.ts", "packages/proxy/test/revocation-detection.test.ts", "packages/proxy/test/revocation-honesty.test.ts", "packages/proxy/test/teardown-all-entries.test.ts", "packages/proxy/test/teardown-fault-matrix.test.ts", "packages/proxy/test/teardown-orchestrate.test.ts", "packages/proxy/test/teardown-receipts-survive.test.ts", "packages/proxy/test/verification.test.ts", "packages/spec/src/errors.ts", "packages/spec/src/generated/receipt.ts", "packages/spec/src/index.ts", "packages/spec/src/predicate/ast.ts", "packages/spec/src/predicate/evaluate.ts", "packages/spec/src/predicate/parse.ts", "packages/spec/src/validate.ts", "packages/spec/test/predicate.test.ts", "packages/spec/test/validate.test.ts", "spec/ALP.md", "spec/receipt.schema.json"]
covered_digest: "v1:sha256:594dc591fcb6479bd44e8b7b5b2dfe1ef11ce737ebdd2a7cc3319ec56b28b344"
behavior_unverified: 0
overrides_applied: 0
re_verification: false
---

# Phase 5: Lease Endings & Teardown Verification Report

**Phase Goal:** However a lease ends (verified completion, expiry, user, publisher, provider or policy), every credential is revoked in a fixed order and the teardown, including every partial failure, is honestly receipted.
**Verified:** 2026-09-29T08:05:00Z
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth (roadmap Success Criteria) | Status | Evidence |
|---|---|---|---|
| 1 | A lease completes only through its outcome verifier (`resource_query` predicate through the proxy with runtime credentials, or `user_confirm` through the HostAdapter); `none` ends only on expiry/user action; the agent's own "done" claim never completes it. | ✓ VERIFIED | `packages/proxy/src/verification/resource-query.ts` (`runResourceQueryVerification`/`runNoneVerification`) + `user-confirm.ts` (`runUserConfirmVerification`); `packages/core/src/lease.ts` `reduce()` independently re-checks `event.actor` against `TRANSITION_TABLE["active:outcome_verified"].actors = ["verifier"]`, structurally rejecting a forged agent-actor completion (`wrong_actor`). `packages/proxy/test/verification.test.ts` (13 tests, re-run green: true/false/error for `resource_query`, yes/no/timeout for `user_confirm`, `none` no-op, forged-actor rejection) all pass. |
| 2 | Ending a lease for any reason runs teardown in fixed order (revoke OAuth, invalidate license, cleanup hook, delete cached data, final signed receipt); publisher entitlement revocation moves the lease to `revoked` (actor `publisher`) and triggers the same teardown. | ✓ VERIFIED | `packages/proxy/src/teardown/steps.ts` `TEARDOWN_STEP_ORDER` (fixed array); `teardown/auto-chain.ts` `chainTeardownIfEnded` (the one shared `begin_teardown` helper); `packages/core/src/transitions.ts` shows `begin_teardown` legal only from `completed`/`expired`/`revoked`/`failed`, landing `tearing_down`. `packages/proxy/src/revocation.ts` `applyEntitlementRevocation` mirrors `applyProviderRevocation` (`entitlement_revoked` actor `publisher` → `chainTeardownIfEnded`). `packages/proxy/test/teardown-all-entries.test.ts` (re-run green, 6/6) proves all four terminal states run the identical 5-step order to `cleaned_up`; `packages/proxy/test/entitlement-revocation.test.ts` (re-run green) proves the LIC-04 end-to-end path. |
| 3 | Each credential records `revoked`/`discarded_revocation_unsupported`/`failed`; a provider without RFC 7009 support yields `discarded_revocation_unsupported`; a bare 2xx is never claimed as more; the uninstall hook accepts only a single-use `cleanup:<lease_id>` token and rejects reuse. | ✓ VERIFIED | `packages/proxy/src/vault/oauth-client.ts` `revokeCredential` checks `oauthClient.as.revocation_endpoint === undefined` **before any HTTP call** (structural, D-20) and never upgrades a 2xx past `{kind:"revoked"}`. `packages/proxy/src/teardown/cleanup-token.ts` `mintCleanupToken` (jose `SignJWT` EdDSA, `scope: cleanup:<leaseId>`, fresh `jti` every mint — verified by direct code read and `cleanup-token.test.ts`'s "two mint calls... produce two DIFFERENT jti" case). `spec/ALP.md` §10 normatively documents the exact same claim set and single-use-by-fresh-mint rule. `packages/proxy/test/revocation-honesty.test.ts` (re-run green, includes the Pitfall-5 2xx-without-revoking case recorded as `revoked`, never stronger) and `cleanup-token.test.ts` (re-run green) both pass. |
| 4 | Any single step failing lands the lease in `cleanup_incomplete` with every step's result recorded, retrying resumes idempotently, the lease can never return to `active`, and tests cover every teardown path including each single-step failure. | ✓ VERIFIED | `packages/proxy/src/teardown/orchestrate.ts` `runStepAndPersist`/`landTeardown` (a step failure never aborts the loop, D-15) and `retryTeardown` (resumes from `teardownProgress`, D-32); `packages/core/src/transitions.ts` has no table entry from any teardown state back to `active` (grep-confirmed: only `active:*` events lead away from `active`, and teardown states only reach `tearing_down`/`cleaned_up`/`cleanup_incomplete`). `packages/proxy/test/teardown-fault-matrix.test.ts` (re-run green) drives the single-step-failure matrix + step-1-never-re-attempted-on-retry + never-observed-active assertions. |
| 5 | After cleanup, both receipt chains, including the final signed receipt, remain readable and verify. | ✓ VERIFIED | `packages/proxy/src/teardown/steps.ts` `createDeleteCachedDataStep` sweeps only `vault.discardLeaseCredentials` + license custody, never touching `ReceiptStore`/`LeaseStore`; `orchestrate.ts` `signBracketingCheckpoint` (terminal-transition checkpoint, D-31) + `createFinalReceiptStep` (post-step-5 checkpoint). `packages/proxy/test/teardown-receipts-survive.test.ts` (re-run green, 363-line integration test using a real loopback OAuth mock AS + real HTTP cleanup-hook server + real `MockLicenseIssuer`) proves both chains `load()` and `verifyChain`-pass post-`cleaned_up` and post-`cleanup_incomplete`, the attested chain verifies independently, both D-31 checkpoints independently `verifyCheckpoint`, and the vault/license custody are empty while the lease + `teardownProgress` still load. |

**Score:** 8/8 must-haves verified (5 roadmap Success Criteria + all 8 requirement IDs; 0 present-but-behavior-unverified; 0 overrides)

### Required Artifacts

All artifacts declared across the phase's 8 plans exist, are substantive (no stub bodies, no placeholder returns), and are wired into their consumers. Verified via `wc -l` (all files 30–440 lines, no empty/near-empty stubs) and direct code reads of the highest-risk modules (`oauth-client.ts`'s `revokeCredential`, `orchestrate.ts`'s full `runTeardown`/`retryTeardown`, `resource-query.ts`'s completion path, `steps.ts`'s aggregate-outcome/delete-retain logic).

| Artifact | Expected | Status |
|---|---|---|
| `spec/receipt.schema.json` + `packages/spec/src/generated/receipt.ts` | Widened `TeardownStepPayload.outcome` enum | ✓ VERIFIED — regenerated via codegen, golden-hash vector unchanged |
| `packages/core/src/lease.ts` | `Lease.teardownProgress` + `TeardownStepName/Outcome/Progress` | ✓ VERIFIED — additive, round-trips, carried forward by `reduce()`'s spread |
| `packages/spec/src/predicate/{ast,parse,evaluate}.ts` | Closed-AST predicate grammar, no `eval`/`new Function` | ✓ VERIFIED — grep confirms no interpreter; AND/OR explicitly rejected |
| `packages/proxy/src/teardown/{auto-chain,orchestrate,steps,progress}.ts` | Fixed 5-step saga, one-pass, injectable steps | ✓ VERIFIED — read in full; no `withRetry`/`setTimeout`(retry)/backoff in teardown/*.ts |
| `packages/proxy/src/vault/oauth-client.ts` (`revokeCredential`) + `credential-vault.ts` | Structural RFC 7009 tri-state + always-discard | ✓ VERIFIED — read in full |
| `packages/core/src/license/license-issuer.ts` (`invalidate`) + `revocation.ts` (`applyEntitlementRevocation`) | LIC-04 entry + license custody discard | ✓ VERIFIED |
| `packages/proxy/src/teardown/{cleanup-token,cleanup-client}.ts` | jose EdDSA single-use token + HTTPS client | ✓ VERIFIED — read in full |
| `packages/core/src/bindings.ts`/`host-adapter.ts` + `packages/proxy/src/verification/{resource-query,user-confirm}.ts` | Outcome verification, agent-claim-never-completes | ✓ VERIFIED — read in full |
| `spec/ALP.md` | Zero `[OPEN: Phase 5]` markers, §7.6 + §10 normative | ✓ VERIFIED — `grep -c "OPEN: Phase 5"` = 0; `check:alp` passes |

### Key Link Verification

| From | To | Via | Status |
|---|---|---|---|
| `revocation.ts` (`applyProviderRevocation`/`applyEntitlementRevocation`) | `teardown/auto-chain.ts` | `chainTeardownIfEnded` second `reduce()` call | ✓ WIRED |
| `verification/resource-query.ts`/`user-confirm.ts` | `teardown/orchestrate.ts` | shared `completeViaVerifier` → `chainTeardownIfEnded` → optional `runTeardown` | ✓ WIRED |
| `dispatch.ts` (provider-revoked branch) | `teardown/orchestrate.ts` (`runTeardown`) | invoked in its own, later, non-nested per-lease transaction (opt-in via `ProxyDeps.teardownSteps`) | ✓ WIRED |
| `packages/spec` predicate AST/evaluator | `packages/proxy/src/verification/resource-query.ts` | imports `PredicateAst`/`evaluatePredicate` from `@stint/spec`'s public barrel — one grammar definition | ✓ WIRED |
| `teardown/steps.ts` (`revoke_oauth`, `delete_cached_data`) | `vault/credential-vault.ts` | `revokeAndDiscardLeaseCredentials`/`discardLeaseCredentials` | ✓ WIRED |
| `teardown/steps.ts` (`cleanup_hook`) | `cleanup-token.ts` + `cleanup-client.ts` | mint-then-POST, fresh `jti` per attempt | ✓ WIRED |
| `packages/core/src/lease.ts` `reduce()` | actor enforcement | `TRANSITION_TABLE[...].actors` re-checked independent of caller-set actor (D-19) | ✓ WIRED |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|---|---|---|---|
| Fixed 5-step teardown reaches `cleaned_up` for all 4 terminal entries + phase-gate (zero markers) | `vitest run packages/proxy/test/teardown-all-entries.test.ts` | 6/6 passed | ✓ PASS |
| Receipts survive cleanup, checkpoints bracket the ending | `vitest run packages/proxy/test/teardown-receipts-survive.test.ts` | included above, 24/24 across the 3-file group | ✓ PASS |
| Agent-claim-never-completes + resource_query/user_confirm/none semantics | `vitest run packages/proxy/test/verification.test.ts` | included above | ✓ PASS |
| RFC 7009 structural honesty (Pitfall 5) + cleanup token/hook + LIC-04 + fault matrix + happy-path orchestrate | `vitest run packages/proxy/test/revocation-honesty.test.ts packages/proxy/test/cleanup-token.test.ts packages/proxy/test/entitlement-revocation.test.ts packages/proxy/test/teardown-fault-matrix.test.ts packages/proxy/test/teardown-orchestrate.test.ts` | 49/49 passed | ✓ PASS |
| `spec/ALP.md` structural checker | `node scripts/check-alp-sections.mjs` | "ALP check passed" | ✓ PASS |
| No `[OPEN: Phase 5]` markers remain | `grep -n "OPEN: Phase 5" spec/ALP.md` | no matches (exit 1) | ✓ PASS |
| Golden-hash + codegen-sync + widened-enum spec tests | `vitest run packages/spec/test/vectors.test.ts packages/spec/test/types.test.ts packages/spec/test/codegen.test.ts` | 14/14 passed on re-run (one earlier parallel run showed a transient `codegen --check` failure that did not reproduce on two subsequent re-runs — consistent with a `--pool=threads` file-race in the codegen-diff check, not a product defect; isolating `codegen.test.ts` alone also passed 3/3) | ✓ PASS (flake noted, non-blocking) |

Full-suite totals reported by the orchestrator at the final HEAD (relied upon per task instructions, not independently re-run in full to respect the sandbox's whole-repo OOM constraint): `@stint/spec` 106/106, `@stint/core` 212/212, `@stint/proxy` 150/150, `@stint/cli` 2/2 = 470 passing, zero regressions. This verifier independently re-ran 6 targeted `vitest` invocations spanning every Phase 5 test file (73+ tests) plus direct source reads of every highest-risk module, and confirms these figures are consistent with what's on disk.

### Requirements Coverage

| Requirement | Source Plan(s) | Description | Status | Evidence |
|---|---|---|---|---|
| LIFE-06 | 05-02, 05-07 | Outcome verification (`resource_query`/`user_confirm`/`none`); agent claim never completes | ✓ SATISFIED | `verification/resource-query.ts`, `user-confirm.ts`, `predicate/*.ts`, `reduce()` actor check |
| LIC-04 | 05-05 | Publisher entitlement revocation → `revoked` (actor `publisher`) → teardown | ✓ SATISFIED | `revocation.ts` `applyEntitlementRevocation`, `license-issuer.ts` `invalidate`, `entitlement-revocation.test.ts` |
| TEAR-01 | 05-01, 05-03 | Fixed-order teardown for any end reason | ✓ SATISFIED | `teardown/steps.ts` `TEARDOWN_STEP_ORDER`, `auto-chain.ts`, `orchestrate.ts` |
| TEAR-02 | 05-04 | Per-credential honest tri-state; 2xx never overclaimed | ✓ SATISFIED | `oauth-client.ts` `revokeCredential`, `revocation-honesty.test.ts` (Pitfall-5 matrix) |
| TEAR-03 | 05-06 | Single-use `cleanup:<lease_id>` token, reuse rejected | ✓ SATISFIED | `cleanup-token.ts`, `cleanup-client.ts`, spec §10 normative |
| TEAR-04 | 05-01, 05-03 | Step failure → `cleanup_incomplete`, idempotent retry, never returns to `active` | ✓ SATISFIED | `orchestrate.ts`, `transitions.ts` table, `teardown-fault-matrix.test.ts` |
| TEAR-05 | 05-03, 05-04, 05-06, 05-08 | Every teardown path tested including each single-step failure | ✓ SATISFIED | `teardown-fault-matrix.test.ts`, `revocation-honesty.test.ts`, `cleanup-token.test.ts`, `teardown-all-entries.test.ts` |
| RCPT-07 | 05-01, 05-08 | Receipts survive cleanup | ✓ SATISFIED | `teardown-receipts-survive.test.ts` (both chains + final receipt + independent attested-chain verify) |

No orphaned requirements: `.planning/REQUIREMENTS.md`'s Phase 5 mapping (LIFE-06, LIC-04, RCPT-07, TEAR-01..05) exactly matches the union of `requirements:` frontmatter across all 8 plans.

### Anti-Patterns Found

None blocking. A grep for `TBD|FIXME|XXX|TODO|HACK|PLACEHOLDER|not yet implemented|coming soon` across every Phase-5-modified source file under `packages/{core,proxy,spec}/src` returned two hits, both in `packages/proxy/src/teardown/steps.ts`'s own doc comments, describing the **intentional, documented** optional-collaborator seam-widening pattern ("the 5 default step implementations below were happy-path placeholders hardened by later plans" / "omitting vault/license/cleanup keeps that step's prior happy-path placeholder"). This is not unfinished work: every one of the 5 steps has a real implementation reachable by supplying its optional collaborator (`vault`, `license`, `cleanup`), and `createDefaultTeardownSteps`'s happy-path fallback exists specifically so tests outside Phase 5's own declared scope keep compiling — the pattern is the same Rule-3 seam-widening technique used consistently across 05-03 through 05-08 (confirmed by reading `steps.ts` in full). No unreferenced debt markers found.

### Observations (non-blocking)

- **`resource_query`/`user_confirm` triggering entry point.** `runResourceQueryVerification`/`runUserConfirmVerification` are exported, fully tested standalone functions; 05-07-SUMMARY.md explicitly documents that this plan does not wire an agent-facing "check done" MCP tool/signal into `dispatch.ts`'s `tools/call` flow. Neither the ROADMAP.md Phase 5 Success Criteria nor `spec/ALP.md` §7.6 mandate a specific agent-trigger wiring mechanism (§7.6 only normatively defines how the runtime evaluates the predicate once triggered, and the closing sentence — "An agent's own claim of being done... never completes a lease" — is proven regardless of trigger wiring). This is consistent with the same optional-injection architecture used for `ProxyDeps.teardownSteps`/`runTeardown` itself, and matches 05-CONTEXT.md's "Not in this phase" list (CLI reference HostAdapter, interactive OAuth acquisition — Phase 6/7). Not treated as a gap; flagged for awareness only.
- **One transient test-runner flake** observed in a single parallel `vitest` invocation of `vectors.test.ts`+`types.test.ts`+`codegen.test.ts` together (a `codegen --check` diff failure); reproduced-clean on two immediate re-runs and in isolation. Consistent with a `--pool=threads` file-system race in the codegen-diff check rather than a product defect — not reproducible, not blocking.

### Human Verification Required

None. This phase is backend/protocol logic with no UI, visual, or subjective-quality surface; every must-have truth is either a structural invariant (grep/code-read confirmable) or a state-transition/idempotency/honesty invariant directly exercised by a named, independently re-run passing test (never inferred from SUMMARY.md claims alone).

### Gaps Summary

No gaps. All 5 roadmap Success Criteria and all 8 requirement IDs (LIFE-06, LIC-04, TEAR-01 through TEAR-05, RCPT-07) are verified against the actual codebase: artifacts exist, are substantive, are wired, tests pass on independent re-run, `spec/ALP.md`'s two `[OPEN: Phase 5]` markers are both normatively closed with zero markers remaining, and the phase's own explicit honesty traps (RFC 7009 2xx-without-revoking / Pitfall 5, cleanup-hook 2xx framed as attested not verified, never-return-to-active, agent-claim-never-completes) are all structurally enforced in code, not just asserted in prose.

---

_Verified: 2026-09-29T08:05:00Z_
_Verifier: Claude (gsd-verifier)_
