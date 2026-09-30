---
phase: 02-lease-state-machine-policy-engine
verified: 2026-09-27T19:58:20Z
status: passed
score: 24/24 must-haves verified
covered_files: [".planning/REQUIREMENTS.md", ".planning/phases/02-lease-state-machine-policy-engine/02-01-PLAN.md", ".planning/phases/02-lease-state-machine-policy-engine/02-01-SUMMARY.md", ".planning/phases/02-lease-state-machine-policy-engine/02-02-PLAN.md", ".planning/phases/02-lease-state-machine-policy-engine/02-02-SUMMARY.md", ".planning/phases/02-lease-state-machine-policy-engine/02-03-PLAN.md", ".planning/phases/02-lease-state-machine-policy-engine/02-03-SUMMARY.md", ".planning/phases/02-lease-state-machine-policy-engine/02-04-PLAN.md", ".planning/phases/02-lease-state-machine-policy-engine/02-04-SUMMARY.md", ".planning/phases/02-lease-state-machine-policy-engine/02-05-PLAN.md", ".planning/phases/02-lease-state-machine-policy-engine/02-05-SUMMARY.md", ".planning/phases/02-lease-state-machine-policy-engine/02-06-PLAN.md", ".planning/phases/02-lease-state-machine-policy-engine/02-06-SUMMARY.md", "packages/core/package.json", "packages/core/src/activate.ts", "packages/core/src/bindings.ts", "packages/core/src/errors.ts", "packages/core/src/events.ts", "packages/core/src/hash-guard.ts", "packages/core/src/host-adapter.ts", "packages/core/src/index.ts", "packages/core/src/lease-store.ts", "packages/core/src/lease.ts", "packages/core/src/policy.ts", "packages/core/src/testing.ts", "packages/core/src/transitions.ts", "packages/core/test/activate.test.ts", "packages/core/test/bindings.test.ts", "packages/core/test/error-threshold.test.ts", "packages/core/test/hash-guard.test.ts", "packages/core/test/host-adapter.test.ts", "packages/core/test/lease-reduce.test.ts", "packages/core/test/lease-store-contract.test.ts", "packages/core/test/policy.test.ts", "packages/core/test/public-api.test.ts", "packages/core/test/reduce-attribution.test.ts", "packages/core/test/smoke.test.ts", "packages/core/test/transition-table.test.ts", "packages/core/tsdown.config.ts"]
covered_digest: "v1:sha256:99a3c514743e9cb7a350a5883935c10375dcd4beb2e6f2001b629eeaf71f9778"
behavior_unverified: 0
overrides_applied: 0
---

# Phase 2: Lease State Machine & Policy Engine Verification Report

**Phase Goal:** Every lifecycle transition and every allow/deny decision is made by pure, fully tested code outside the model, so no agent behavior can end, extend or exceed a lease.
**Verified:** 2026-09-27T19:58:20Z
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths (Roadmap Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | A lease moves only through the eleven defined states via a table-driven pure reducer; test suite exercises every legal transition and rejects every illegal (state,event) pair | ✓ VERIFIED | `packages/core/src/transitions.ts` `TRANSITION_TABLE` (24 keys/25 triples), byte-identical to `spec/ALP.md` §7.4 (independently diffed by hand — lines 356-380 vs table literal — and additionally cross-checked at test time by `transition-table.test.ts`, which parses §7.4 out of `spec/ALP.md` at runtime). `reduce-attribution.test.ts` exercises all 25 legal triples via `it.each`, plus illegal-pair rejection and terminal-state re-entry (`declined`, `cleaned_up`). `pnpm exec vitest run packages/core` → 109/109 passing (independently re-run). |
| 2 | Every transition records its actor; any agent attempt to end/extend a lease is rejected; activating/resuming against a mismatched manifest hash is rejected | ✓ VERIFIED | `reduce()` (`lease.ts`) independently re-checks `event.actor` against the table (Step 2) and is never satisfied by a caller claim; `agent` is not a member of the `Actor` union (`transitions.ts`) so a hand-forged `{actor:'agent'}` event is structurally rejected `wrong_actor` — proven by `reduce-attribution.test.ts`'s "agent-boundary guarantee" tests for both `revoke` and `extend`. `verifyBoundHash` (`hash-guard.ts`) recomputes the manifest hash via `@stint/spec`'s `hashManifest` and never trusts a caller-supplied `.contentHash`; `activateLease`/`resumeLease` (`activate.ts`) dispatch `activation_failed`/`runtime_failure` respectively on mismatch, proven by `activate.test.ts` (4 tests, real `VerifiedManifest` minted via `@stint/spec/testing`). |
| 3 | The pure policy function returns allow/deny/require_approval given lease, bindings, and an injectable clock; past-expiry denies with no timers; no-binding denies; a mislabeling manifest cannot change classification | ✓ VERIFIED | `evaluatePolicy` (`policy.ts`) denies `no_binding` on `binding === undefined` before any other check; denies `expired` via pure `now >= lease.expiresAt` comparison (boundary-tested: `expiresAt-1` allows, `expiresAt`/`expiresAt+1` deny); classifies a call only from the resolved `ConnectorBinding`, never a manifest — proven by `policy.test.ts`'s "CLASSIFICATION SOURCE" test using a manifest-like object that mislabels a `send` tool as `read`. Grep gate confirms no `Date.now`/`setTimeout`/`setInterval` anywhere in `policy.ts` (independently re-run, exit 1/no matches). |
| 4 | N denied calls/upstream errors within the configured window move the lease to `failed` with actor `policy`; N-1 do not | ✓ VERIFIED | `checkErrorThreshold` (`policy.ts`) is a strict sliding-window boundary check (`timestamp > now - window_seconds`); `error-threshold.test.ts` proves N trips true, N-1 stays false, and the exact-boundary timestamp (`now - window_seconds`) is excluded (independently re-run, 5/5 passing). `TRANSITION_TABLE['active:error_threshold_exceeded']` → `{actors:['policy'], to:'failed'}`; the caller feeds `policyEvents.errorThresholdExceeded()` to `reduce()` on a `true` result (documented separation, D-09). |
| 5 | A platform builder can implement the single `HostAdapter` contract; a lease extension succeeds only after fresh consent through it; no license-refresh event can move lease expiry | ✓ VERIFIED | `HostAdapter` (`host-adapter.ts`) is a 3-method, all-`Promise` interface (`requestConsent`, `requestApproval`, `notify`) exported from `@stint/core`'s public barrel. `extend` remains actor-`user`-only in `TRANSITION_TABLE`/`reduce()` (tested); `awaitConsentDecision` gives the fresh-consent mechanism, core-owned deny/decline-on-timeout (D-17, tested for abort, adapter-rejection, already-aborted cases). `EVENTS` (`transitions.ts`) contains no `refresh`/`license_refresh`/`token_refresh` member (asserted by regex test); `expiresAt` is written from exactly one ternary covering only `consent_granted` and `extend` (directly read in `lease.ts` lines 128-133; `expire`'s test explicitly asserts `expiresAt` unchanged). |

**Score:** 5/5 roadmap success criteria verified (0 present, behavior-unverified)

### Plan-Level Must-Have Truths (all 6 plans)

| # | Truth (abbreviated) | Plan | Status | Evidence |
|---|---|---|---|---|
| 1 | `reduce` returns `@stint/spec`-shaped `Result` verbatim | 02-01 | ✓ VERIFIED | `errors.ts` `Result<T>` union matches; `lease-reduce.test.ts` |
| 2 | Unknown (state,event) → `illegal_transition`, lease unchanged/frozen | 02-01 | ✓ VERIFIED | `lease.ts` Step 1; test "ILLEGAL path" |
| 3 | `reduce` deterministic, table maps 1:1 | 02-01 | ✓ VERIFIED | "DETERMINISM" test; table is a plain keyed Record |
| 4 | Accepted transition increments version by 1, TransitionRecord has 5 fields | 02-01 | ✓ VERIFIED | `lease.ts` Step 4-5; "LEGAL path" test |
| 5 | Events only from actor-namespaced constructors; reducer independently re-checks actor | 02-01/02-02 | ✓ VERIFIED | `events.ts` all 7 namespaces hard-code actor; `lease.ts` Step 2 |
| 6 (backstop) | `expiresAt` untouched except grant/extend; no refresh event exists | 02-01 | ✓ VERIFIED | Direct code read (`lease.ts` single ternary, two branches only) + `reduce-attribution.test.ts` "expire...expiresAt unchanged" (214) + "no refresh path" test (219-222) |
| 7 | `TRANSITION_TABLE` = 24 keys/25 triples, cross-checked against spec at test time | 02-02 | ✓ VERIFIED | `transition-table.test.ts` parses `spec/ALP.md` §7.4 at runtime; independently diffed by hand against `transitions.ts` — identical |
| 8 | All 25 legal triples accepted; all illegal/wrong-actor pairs rejected | 02-02 | ✓ VERIFIED | `reduce-attribution.test.ts` `it.each` over `LEGAL_CASES` (25) |
| 9 | Terminal-state re-entry (`declined`, `cleaned_up`) rejected, state unchanged | 02-02 | ✓ VERIFIED | dedicated tests, lines 97-117 |
| 10 | `retry_teardown` dual-actor (user+runtime) from `cleanup_incomplete`, no other actor | 02-02 | ✓ VERIFIED | dedicated test, lines 225-237; table has single dual-actor key |
| 11 | Actor not in table's actor list → `wrong_actor` | 02-02 | ✓ VERIFIED | "wrong-actor rejection" test, lines 120-130 |
| 12 | `extend` bounded by `maxDurationSeconds`, only expiry-moving event besides grant | 02-02 | ✓ VERIFIED | `lease.ts` Step 3 guard; 5 bound tests (in-bound/over-max/zero/negative/non-integer) |
| 13 | `expire` (actor clock) moves to `expired` with no timer, `at` = injected now | 02-02 | ✓ VERIFIED | dedicated test, lines 204-216 |
| 14 (backstop) | No agent-reachable path constructs/dispatches a lifecycle-ending/extending event | 02-02 | ✓ VERIFIED | agent-boundary tests, lines 132-153 (directly observed rejection) |
| 15 | `evaluatePolicy` returns tagged union `allow\|deny\|require_approval` | 02-03 | ✓ VERIFIED | `policy.ts` `PolicyDecision`; `policy.test.ts` |
| 16 | `binding===undefined` → `deny(no_binding)` before any other check | 02-03 | ✓ VERIFIED | "NO BINDING" test — checked even on an also-expired lease |
| 17 | Unregistered tool → `undefined`; registered tool → its binding | 02-03 | ✓ VERIFIED | `bindings.test.ts` |
| 18 | Classification derived only from binding, never manifest | 02-03 | ✓ VERIFIED | "CLASSIFICATION SOURCE" test — manifest mislabels tool, binding wins |
| 19 | Expiry denies at `now>=expiresAt`; allows at `expiresAt-1` | 02-03 | ✓ VERIFIED | "EXPIRY BOUNDARY" test, 3 boundary values |
| 20 | Expiry is pure comparison, no wall clock/timer read in `policy.ts` | 02-03 | ✓ VERIFIED | grep gate independently re-run: 0 matches for `Date.now\|setTimeout\|setInterval` |
| 21 | `checkErrorThreshold` trips at exactly N, not N-1 | 02-03 | ✓ VERIFIED | `error-threshold.test.ts` N/N-1/boundary/empty/stale tests |
| 22 (backstop) | Empty counters + no-spend call → allow, no error | 02-03 | ✓ VERIFIED | "EMPTY COUNTERS" test, lines 206-221 |
| 23 (backstop) | Error-window uses integer epoch-seconds; exactly-window_seconds-old excluded | 02-03 | ✓ VERIFIED | "WINDOW BOUNDARY" test, strict `>` |
| 24 | `verifyBoundHash` recomputes via `@stint/spec` `hashManifest`, re-implements no hashing | 02-04 | ✓ VERIFIED | `hash-guard.ts`; grep gate (`createHash\|canonicalize`) independently re-run: 0 matches |
| 25 | `activateLease` dispatches `activate`/`activationFailed` on match/mismatch | 02-04 | ✓ VERIFIED | `activate.test.ts` ACTIVATE MATCH/MISMATCH |
| 26 | `resumeLease` dispatches `runtimeFailure` on mismatch (distinct from activation) | 02-04 | ✓ VERIFIED | `activate.test.ts` RESUME MISMATCH/MATCH |
| 27 | Single shared `verifyBoundHash` guard consumed by both entry points | 02-04 | ✓ VERIFIED | `activate.ts` — one guard, two call sites, no duplicated compare |
| 28 (backstop) | Lease persists only prefixed bound-hash string, never the manifest | 02-04 | ✓ VERIFIED | `Lease.boundHash: string` (`lease.ts`); no manifest field anywhere on `Lease` |
| 29 | `HostAdapter` is 3 async methods (requestConsent/requestApproval/notify) | 02-05 | ✓ VERIFIED | `host-adapter.ts`; compiles under strict `tsc -b` |
| 30 | `LifecycleEvent` tagged union, 8 notifiable states | 02-05 | ✓ VERIFIED | `host-adapter.ts` union, 8 members |
| 31 | `requestApproval` carries binding-redacted summary + binding + opaque id, no raw args | 02-05 | ✓ VERIFIED | `ApprovalRequest` interface — exactly 3 fields |
| 32 | Core owns timeout/non-response → deny/decline, never delegated to adapter | 02-05 | ✓ VERIFIED | `awaitApprovalDecision`/`awaitConsentDecision`; abort/already-aborted/adapter-error tests all resolve deny/decline |
| 33 (backstop) | Adapter throw/reject → deny/decline, never allow/grant | 02-05 | ✓ VERIFIED | "APPROVAL ADAPTER ERROR"/"CONSENT ADAPTER ERROR" tests, `Promise.reject` |
| 34 (backstop) | Extend requires fresh consent through HostAdapter before dispatch | 02-05 | ✓ VERIFIED (structural precondition; full proxy wiring correctly deferred to Phase 4 per plan objective) | reducer already restricts `extend` to actor `user` (tested); `awaitConsentDecision` mechanism exists and is tested |
| 35 | `LeaseStore` async interface: load/save/list/delete/transaction | 02-06 | ✓ VERIFIED | `lease-store.ts` |
| 36 | In-memory double + `createLeaseStoreContractTests` exported only from `@stint/core/testing` | 02-06 | ✓ VERIFIED | `testing.ts`; `public-api.test.ts` asserts `createInMemoryLeaseStore`/`createLeaseStoreContractTests` are `undefined` on the `.` barrel |
| 37 | Per-lease serialization: N concurrent transactions, no lost updates | 02-06 | ✓ VERIFIED | `lease-store-contract.test.ts` — 50 concurrent transactions → exactly version 50 (independently re-run, passing) |
| 38 | CRUD empty/round-trip edges hold | 02-06 | ✓ VERIFIED | contract suite CRUD tests |
| 39 | Public barrel exports full Phase 2 surface, preserves `SPEC_VERSION`/`PACKAGE_NAME` | 02-06 | ✓ VERIFIED | `index.ts`; `public-api.test.ts` |
| 40 (backstop) | `@stint/core/testing` resolves after build (dist/testing.js + .d.ts exist) | 02-06 | ✓ VERIFIED | independently ran `pnpm build` — both files produced (5.46kB, matches SUMMARY's claimed size) |

**Score:** 24/24 must-haves verified across all 6 plans (0 present, behavior-unverified; 0 overrides)

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `packages/core/src/errors.ts` | `CoreErrorCode`/`Result<T>` vocabulary | ✓ VERIFIED | 3 error codes, discriminated `Result` union |
| `packages/core/src/transitions.ts` | Full §7.4 table, 24 keys/25 triples | ✓ VERIFIED | byte-matches `spec/ALP.md` §7.4 |
| `packages/core/src/events.ts` | 7 actor-namespaced constructor namespaces | ✓ VERIFIED | all namespaces present, actor hard-coded |
| `packages/core/src/lease.ts` | `Lease`, `LeaseCounters`, `TransitionRecord`, `reduce()` | ✓ VERIFIED | 5-step early-return reducer, deep-freeze |
| `packages/core/src/bindings.ts` | `ConnectorBinding`/`BindingSet`, `createBindingSet`/`resolveBinding` | ✓ VERIFIED | own-property lookup, throws on duplicate |
| `packages/core/src/policy.ts` | `evaluatePolicy`, `checkErrorThreshold` | ✓ VERIFIED | deny-by-default order, no timers |
| `packages/core/src/hash-guard.ts` | `verifyBoundHash` | ✓ VERIFIED | recomputes via `@stint/spec` `hashManifest` |
| `packages/core/src/activate.ts` | `activateLease`, `resumeLease` | ✓ VERIFIED | shared guard, distinct failure events |
| `packages/core/src/host-adapter.ts` | `HostAdapter`, `LifecycleEvent`, timeout wrappers | ✓ VERIFIED | 3-method interface, deny/decline-on-timeout |
| `packages/core/src/lease-store.ts` | `LeaseStore` async CRUD + `transaction` | ✓ VERIFIED | 5-method interface, serialization documented |
| `packages/core/src/testing.ts` | in-memory double + contract-test factory | ✓ VERIFIED | never re-exported from `.` barrel |
| `packages/core/src/index.ts` | complete public barrel | ✓ VERIFIED | every Phase 2 symbol, testing.ts excluded |
| `packages/core/package.json` / `tsdown.config.ts` | `./testing` export + second tsdown entry | ✓ VERIFIED | independently rebuilt — `dist/testing.js`/`.d.ts` present |
| All 12 test files | one per module + public-api + contract | ✓ VERIFIED | 109/109 tests in `packages/core` (independently re-run) |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `spec/ALP.md` §7.4 | `TRANSITION_TABLE` | runtime-parsed cross-check test | ✓ WIRED | `transition-table.test.ts` parses the markdown region and asserts bidirectional equality; independently hand-diffed and confirmed identical |
| `events.ts` constructors | `reduce()`'s actor re-check | Step 2 lookup | ✓ WIRED | actor never trusted from caller; independently rejected for `agent` |
| `bindings.ts` `BindingSet` | `evaluatePolicy`'s `binding` param | resolved-or-undefined | ✓ WIRED | `undefined` → deny by default, tested |
| `@stint/spec` `hashManifest` | `verifyBoundHash` → `activateLease`/`resumeLease` → `reduce` | shared guard, dispatched event | ✓ WIRED | one guard, two call sites, `reduce` dispatch confirmed |
| `HostAdapter` interface | `awaitApprovalDecision`/`awaitConsentDecision` | sanctioned wrapper functions | ✓ WIRED | direct adapter calls never bypass the wrapper in tests |
| `LeaseStore.transaction` (contract) | in-memory double + `createLeaseStoreContractTests` | reusable suite | ✓ WIRED | invoked from `lease-store-contract.test.ts`, 7/7 passing |
| `index.ts` barrel | every Phase 2 module | grouped named+type exports | ✓ WIRED | `public-api.test.ts` imports and asserts each; test-double absence also asserted |

### Data-Flow Trace (Level 4)

Not applicable — Phase 2 is pure library code (no rendered UI, no persisted runtime data beyond the in-memory test double). All "data flow" here is function-call composition, already covered under Key Link Verification above.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| `packages/core` test suite passes | `pnpm --filter @stint/core exec vitest run` | 12 files / 109 tests passing | ✓ PASS |
| Whole monorepo test suite passes | `pnpm -w test` | 24 files / 193 tests passing | ✓ PASS |
| Whole monorepo typechecks | `pnpm -w typecheck` (`tsc -b`) | exit 0, no output | ✓ PASS |
| Whole monorepo lints | `pnpm -w lint` (`eslint .`) | exit 0, no output | ✓ PASS |
| `@stint/core` builds, `./testing` subpath resolves | `pnpm --filter @stint/core build` | `dist/testing.js` (5.46kB) + `dist/testing.d.ts` produced | ✓ PASS |
| No wall-clock/timer usage in `policy.ts`/`host-adapter.ts` | `grep -nE 'Date\.now\|setTimeout\|setInterval'` | no matches | ✓ PASS |
| No re-implemented hashing in `hash-guard.ts` | `grep -nE 'createHash\|canonicalize'` | no matches | ✓ PASS |

### Requirements Coverage

| Requirement | Source Plan(s) | Description | Status | Evidence |
|-------------|-----------------|--------------|--------|----------|
| LIFE-01 | 02-01, 02-02 | Lease moves only through defined states via table-driven pure reducer; illegal transitions rejected and tested | ✓ SATISFIED | full §7.4 matrix tested, cross-checked against spec |
| LIFE-02 | 02-01, 02-02 | Every transition records its actor; agent can never end/extend a lease | ✓ SATISFIED | agent-boundary tests, actor re-check |
| LIFE-03 | 02-04 | Lease binds consented manifest hash; mismatch at activation/resume rejected | ✓ SATISFIED | `verifyBoundHash` + `activateLease`/`resumeLease` tests |
| LIFE-04 | 02-02, 02-03 | Lease expiry enforced on every call against injectable clock, not timers | ✓ SATISFIED | `evaluatePolicy` expiry boundary tests + no-timer grep gate |
| LIFE-05 | 02-02, 02-05 | Extending a lease requires fresh consent through HostAdapter; refresh never extends expiry | ✓ SATISFIED | `extend` bounded/actor-user-only; no refresh event exists; `awaitConsentDecision` mechanism present |
| LIFE-07 | 02-03 | N denied/errors in window moves lease to `failed` w/ actor `policy` | ✓ SATISFIED | `checkErrorThreshold` N/N-1/boundary tests |
| PRXY-02 | 02-03 | Every `tools/call` decided by pure policy function; no-binding calls denied | ✓ SATISFIED | `evaluatePolicy` deny-by-default first check |
| PRXY-03 | 02-03 | Tool classification only from runtime-owned bindings, never manifest | ✓ SATISFIED | "CLASSIFICATION SOURCE" test |
| HOST-01 | 02-05, 02-06 | Platform builder can implement single `HostAdapter`; contracts exported by `@stint/core` | ✓ SATISFIED | `HostAdapter` interface + public barrel wiring |

No orphaned requirements: all 9 requirement IDs mapped to "Phase 2" in `.planning/REQUIREMENTS.md` (lines 131-163) match exactly the 9 IDs claimed across the 6 plans' `requirements:` frontmatter fields.

**Explicitly and correctly deferred (not a gap):** `PRXY-04` (`actions_per_hour`/action-cap/spend enforcement under concurrent calls) is mapped to Phase 4 in `.planning/REQUIREMENTS.md` (line 153: "PRXY-04 | Phase 4 | Pending"), not Phase 2. The `over_actions_per_hour` reason code exists in `POLICY_REASON_CODES` (satisfying the stable-vocabulary requirement) but has no enforcement branch yet; this is documented in `.planning/WINDOWS.md` (open item #1, phase 02) and explicitly scoped out of this phase's `must_haves`/`<behavior>` lists in 02-03-PLAN.md. Confirmed this is a deliberate, tracked, cross-phase scoping decision — not a silently dropped requirement.

### Anti-Patterns Found

None. Grep scan across all `packages/core/src/*.ts` files modified in this phase for `TBD|FIXME|XXX|TODO|HACK|PLACEHOLDER` and placeholder-language patterns returned zero matches. No empty implementations, no hardcoded-empty stub returns, no console.log-only functions.

### Gaps Summary

No gaps. Every roadmap Success Criterion (5/5) and every plan-level must-have truth (24/24 across all 6 plans) is verified against the actual codebase, not merely claimed in SUMMARY.md. Independently re-ran (not just re-read SUMMARY claims):

- `packages/core` test suite: 12 files / 109 tests passing.
- Whole monorepo test suite: 24 files / 193 tests passing (matches SUMMARY's claimed count exactly).
- Whole monorepo `typecheck` and `lint`: both exit 0 clean.
- `@stint/core` build: `dist/testing.js` (5.46kB) and `dist/testing.d.ts` both produced, matching the `./testing` subpath claim.
- Both no-wall-clock and no-rehash grep gates: independently re-run, zero matches.
- Hand-diffed `TRANSITION_TABLE` (`transitions.ts`) against `spec/ALP.md` §7.4 (lines 356-380): byte-identical, 24 keys / 25 triples, including the sole dual-actor `cleanup_incomplete:retry_teardown` entry.
- Read every one of the 12 `src/*.ts` files created/modified in this phase in full and cross-referenced each against its plan's `must_haves` and `<behavior>` blocks — no stub, no placeholder, no orphaned export.

The one explicitly deferred item (`over_actions_per_hour` enforcement, PRXY-04) is correctly scoped to Phase 4 in `.planning/REQUIREMENTS.md`, tracked in `.planning/WINDOWS.md`, and outside this phase's claimed requirement set — not a gap in Phase 2's own goal.

The phase goal — "every lifecycle transition and every allow/deny decision is made by pure, fully tested code outside the model, so no agent behavior can end, extend or exceed a lease" — is achieved: `reduce()` is the sole state-transition function, table-driven and actor-re-checking; `evaluatePolicy`/`checkErrorThreshold` are the sole allow/deny functions, deny-by-default and binding-classified; `agent` is not a member of the `Actor` union anywhere in the codebase, so no code path — forged or otherwise — can attribute a lifecycle-ending or -extending event to the model.

---

*Verified: 2026-09-27T19:58:20Z*
*Verifier: Claude (gsd-verifier)*
