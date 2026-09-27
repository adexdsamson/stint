---
phase: 02-lease-state-machine-policy-engine
plan: 03
subsystem: core
tags: [policy-engine, connector-bindings, deny-by-default, typescript, vitest]

# Dependency graph
requires:
  - phase: 02-lease-state-machine-policy-engine
    provides: "02-01: Lease/LeaseCounters types, reduce()'s Result<T> shape, actor-namespaced event constructors"
provides:
  - "ConnectorBinding/BindingSet runtime-owned tool classification (bindings.ts): createBindingSet, resolveBinding"
  - "POLICY_REASON_CODES/PolicyReason stable deny-reason vocabulary (D-10) in @stint/core"
  - "evaluatePolicy(lease, call, binding, limits, approvals, now) pure decision function (policy.ts)"
  - "checkErrorThreshold(counters, threshold, now) pure sliding-window boundary check (policy.ts)"
affects: [02-04, 02-05, 02-06]

actuals:
  tokens: 4996
  tasks: 3
  commits: 3
  plan_head_before: cdb82acb998c154f80a5badfeb47ec8f30d77aab

tech-stack:
  added: []
  patterns:
    - "Runtime-owned keyed-Record lookup (BindingSet) with Object.hasOwn own-property guards, mirroring @stint/spec's TrustStore/ownEntry pattern (D-11, D-12)"
    - "PolicyDecision discriminated union tagged by a literal `decision` field, modeled directly on @stint/spec's Verifier union (D-10)"
    - "Widen a generated fixed-length-tuple-union field (Approvals.require_for) to a plain readonly array before calling .includes, to avoid TypeScript resolving the parameter to `never` across the tuple union"

key-files:
  created:
    - packages/core/src/bindings.ts
    - packages/core/src/policy.ts
    - packages/core/test/bindings.test.ts
    - packages/core/test/policy.test.ts
    - packages/core/test/error-threshold.test.ts
  modified: []

key-decisions:
  - "triggerForBinding() priority order: pay > send > irreversible — a binding's access class is checked before its irreversible flag, so a send-and-irreversible binding still reports trigger 'send' (both are valid single-trigger classifications per ALP.md; access class is the more specific signal)."
  - "approvals.require_for is widened to `readonly ApprovalTrigger[]` via a local `const requireFor` before calling .includes() — the generated Approvals type is a union of 4 differently-sized tuple literals ([] | [T] | [T,T] | [T,T,T]), and TypeScript resolves .includes()'s parameter type to the intersection of each branch's element type (never | T | T | T = never) when called directly on the union-typed field."
  - "over_actions_per_hour is defined in POLICY_REASON_CODES (D-10's full 5-code vocabulary) but evaluatePolicy does not yet enforce a sliding-window check for it — LeaseCounters (D-01, built in 02-01) has no per-action timestamp field, and full concurrent-safe enforcement is PRXY-04, explicitly scoped to Phase 4 in REQUIREMENTS.md. Recorded in .planning/WINDOWS.md (deviation, phase 02, packages/core/src/policy.ts)."

patterns-established:
  - "Pattern 3: pure decision functions (evaluatePolicy, checkErrorThreshold) that take every time-dependent input as an explicit `now` parameter and never read Date.now/setTimeout — enforced by a negative grep gate in the plan's acceptance criteria."

requirements-completed: [PRXY-02, PRXY-03, LIFE-04, LIFE-07]

coverage:
  - id: D1
    description: "createBindingSet/resolveBinding build a prototype-safe, own-property BindingSet keyed by tool name, throwing on duplicate tool registration"
    requirement: PRXY-02
    verification:
      - kind: unit
        ref: "packages/core/test/bindings.test.ts#createBindingSet / resolveBinding"
        status: pass
    human_judgment: false
  - id: D2
    description: "evaluatePolicy denies with no_binding when binding is undefined, checked before expiry, before any other check"
    requirement: PRXY-02
    verification:
      - kind: unit
        ref: "packages/core/test/policy.test.ts#NO BINDING: denies with no_binding, checked before expiry, even on an also-expired lease"
        status: pass
    human_judgment: false
  - id: D3
    description: "evaluatePolicy classifies a tool only from the resolved ConnectorBinding; a manifest-like object mislabeling the same tool cannot change the decision (evaluatePolicy has no manifest parameter at all)"
    requirement: PRXY-03
    verification:
      - kind: unit
        ref: "packages/core/test/policy.test.ts#CLASSIFICATION SOURCE: a manifest labeling the tool 'read' cannot override the binding's 'send' classification (PRXY-03)"
        status: pass
    human_judgment: false
  - id: D4
    description: "evaluatePolicy denies with expired via a pure now >= lease.expiresAt comparison, exercised at the exact boundary (expiresAt-1 allows, expiresAt and expiresAt+1 deny) with no timer or wall clock read anywhere in policy.ts"
    requirement: LIFE-04
    verification:
      - kind: unit
        ref: "packages/core/test/policy.test.ts#EXPIRY BOUNDARY: now = expiresAt - 1 allows; now = expiresAt denies; now = expiresAt + 1 denies"
        status: pass
    human_judgment: false
  - id: D5
    description: "checkErrorThreshold trips (returns true) at exactly `count` in-window denial/error timestamps and stays false at count-1, with a strict > comparison against now - window_seconds so a timestamp exactly window_seconds old is excluded"
    requirement: LIFE-07
    verification:
      - kind: unit
        ref: "packages/core/test/error-threshold.test.ts (N TRIPS, N-1 DOES NOT, WINDOW BOUNDARY, EMPTY, STALE PRUNING)"
        status: pass
    human_judgment: false
  - id: D6
    description: "evaluatePolicy enforces max_actions and spend caps, and requires approval for send/pay/irreversible bindings with pay always requiring approval even when approvals.require_for omits it"
    verification:
      - kind: unit
        ref: "packages/core/test/policy.test.ts (MAX ACTIONS, SPEND, APPROVAL x2, ALLOW, EMPTY COUNTERS)"
        status: pass
    human_judgment: false

duration: 22min
completed: 2026-09-27
status: complete
---

# Phase 2 Plan 3: Policy Engine & Connector Bindings Summary

**Pure `evaluatePolicy`/`checkErrorThreshold` decision functions plus runtime-owned `ConnectorBinding`/`BindingSet` — the deny-by-default allow/deny/require_approval brain the Phase 4 proxy will route every live `tools/call` through, with binding-only classification and an injectable clock.**

## Performance

- **Duration:** 22 min
- **Started:** 2026-09-27T19:19:00Z (approx., first Read call)
- **Completed:** 2026-09-27T19:41:00Z
- **Tasks:** 3
- **Files modified:** 5 (all created)

## Accomplishments
- `bindings.ts`: `ConnectorBinding` (`tool`, `resource`, `access`, `irreversible`, `provenance`), `BindingProvenance`, `BindingSet`, `createBindingSet` (own-property keyed lookup, throws on duplicate tool), `resolveBinding` (prototype-safe `Object.hasOwn` lookup returning `undefined` for unregistered/prototype-named tools).
- `policy.ts`: `POLICY_REASON_CODES`/`PolicyReason` (5-code D-10 vocabulary), `ApprovalRequirement`, `PolicyDecision` (allow/deny/require_approval discriminated union), `PolicyCall`, `evaluatePolicy` (deny-by-default → expiry → max_actions → spend → approval → allow, classifying only from the resolved binding), and `checkErrorThreshold` (strict sliding-window boundary check).
- `bindings.test.ts` (5 tests), `policy.test.ts` (9 tests), `error-threshold.test.ts` (5 tests) — 19 new passing Vitest tests; full monorepo suite is 109 passing across 17 files.

## Task Commits

Each task was committed atomically:

1. **Task 1: Runtime-owned connector bindings (ConnectorBinding, BindingSet, provenance)** - `78979b2` (feat)
2. **Task 2: evaluatePolicy — deny-by-default, binding-only classification, per-call expiry, limits** - `3735f20` (feat)
3. **Task 3: checkErrorThreshold — the N vs N-1 sliding-window boundary** - `4061bd4` (feat)

**Plan metadata:** pending (docs: complete plan)

## Files Created/Modified
- `packages/core/src/bindings.ts` - `ConnectorBinding`, `BindingSet`, `createBindingSet`, `resolveBinding`
- `packages/core/src/policy.ts` - `POLICY_REASON_CODES`, `PolicyReason`, `ApprovalRequirement`, `PolicyDecision`, `PolicyCall`, `evaluatePolicy`, `checkErrorThreshold`
- `packages/core/test/bindings.test.ts` - binding-set lookup, duplicate-tool rejection, prototype-safety tests
- `packages/core/test/policy.test.ts` - deny-by-default, binding-only classification, expiry boundary, max_actions, spend, approval (send/pay), allow, empty-counters tests
- `packages/core/test/error-threshold.test.ts` - N/N-1 trip boundary, window-boundary, empty, stale-pruning tests

## Decisions Made
- `triggerForBinding()` checks `access === 'pay'` then `access === 'send'` then `irreversible`, in that priority order — this is an implementation detail not specified by the plan (which only says "send maps to send; pay maps to pay; irreversible bindings map to irreversible" without resolving priority when more than one could apply). Chose access-class-first since `access` is the primary classification and `irreversible` is a secondary flag.
- Widened `approvals.require_for` (a generated union of 4 differently-shaped literal tuples, `[] | [T] | [T,T] | [T,T,T]`) to a local `const requireFor: readonly ApprovalTrigger[]` before calling `.includes(trigger)`. Calling `.includes` directly on the union-typed field resolved TypeScript's parameter type to `never` (the intersection of `never` from the empty-tuple branch with `ApprovalTrigger` from the others) — a real TS quirk with unions of fixed-length tuples, not a plan ambiguity. Verified via `tsc -b` failing before the fix and passing after.
- Left `over_actions_per_hour` unenforced in `evaluatePolicy` (see Deviations below) rather than approximating it against `lease.counters.actionCount` (a lifetime total with no window semantics) — an approximation would have produced incorrect denials once the lifetime count exceeded the hourly threshold, regardless of elapsed time. Not implementing an incorrect check is safer than implementing one that lies.
- Task 2 and Task 3 both edit `policy.ts` (Task 3's own instruction: "Extend `packages/core/src/policy.ts` — do not create a new module"). Committed them as two separate atomic commits by temporarily excluding `checkErrorThreshold` and `error-threshold.test.ts` from the working tree, running the full Task-2 verification suite in that state, committing, then restoring and committing Task 3 — so each commit is independently buildable/testable/lintable, matching the one-commit-per-task contract.

## Deviations from Plan

### Documented, Non-Bug Gaps (not auto-fixed — see rationale)

**1. `over_actions_per_hour` reason code exists but is not yet enforced**
- **Found during:** Task 2 (evaluatePolicy's limits enforcement)
- **Issue:** The plan's Task 2 action text asks `evaluatePolicy` to enforce `limits.actions_per_hour` via a sliding 3600s window over "allowed-action timestamps," but also admits in the same paragraph that the current counter aggregate (`LeaseCounters`, built in 02-01: `{ actionCount, spentMinor, denialErrorTimestamps }`) has no such field, suggesting "gate this on `lease.counters.actionCount` within-window via a dedicated field" as a fallback.
- **Why not auto-fixed:** `lease.ts` (where `LeaseCounters` is defined) is outside this plan's `files_modified` scope and is concurrently owned by plan 02-02 (wave 2, same `depends_on: [02-01]`). Adding a per-action timestamp field would be a cross-plan schema change with no test in this plan's required `<behavior>`/`must_haves` list actually exercising `over_actions_per_hour` (unlike `over_max_actions` and `over_spend`, which ARE in the required behavior list and use only existing counter fields). REQUIREMENTS.md additionally scopes **PRXY-04** ("`actions_per_hour`, total action cap and `spend` limits are enforced per lease under concurrent calls") to **Phase 4**, not Phase 2 — confirming full, concurrency-safe `actions_per_hour` enforcement is intentionally deferred.
- **Resolution:** Kept `over_actions_per_hour` in `POLICY_REASON_CODES` (satisfies D-10's full 5-code vocabulary and the plan's grep-based acceptance criteria) but added no enforcement branch, with an explicit module-docblock note pointing to PRXY-04/Phase 4. Recorded as an `open` entry in `.planning/WINDOWS.md` (kind: `deviation`, phase 02, `packages/core/src/policy.ts`) so it stays visible through the ship gate.
- **Files affected:** `packages/core/src/policy.ts` (no functional change — a documented omission, not a bug fix).
- **Verification:** All of this plan's required `<behavior>` assertions pass; the acceptance-criteria grep for `over_actions_per_hour`'s presence in the reason-code vocabulary passes (`POLICY_REASON_CODES` includes it).

### Minor, Cosmetic Acceptance-Criteria Mismatch

**2. The 5-reason-code grep count returns 9, not the plan's literal "5"**
- **Found during:** Task 2 self-check against `<acceptance_criteria>`
- **Issue:** `grep -cE '"no_binding"|"expired"|"over_max_actions"|"over_actions_per_hour"|"over_spend"' packages/core/src/policy.ts` returns 9 lines, not 5 — 5 lines from the `POLICY_REASON_CODES` array declaration plus 4 more from the actual `deny("...")` call sites (`over_actions_per_hour` has no call site, since it's unenforced per deviation #1 above).
- **Why not "fixed":** The underlying behavior the grep checks for — "all 5 codes exist in the file's reason vocabulary" — is fully satisfied and independently proven by the passing test suite (mirrors 02-01-SUMMARY's precedent for a similar quote-style grep mismatch). Distorting the code (e.g., obscuring the literal deny-call strings) purely to hit an exact grep count would reduce readability for no functional gain.
- **Impact:** None — cosmetic, informational only.

---

**Total deviations:** 1 documented gap (not a bug fix; scoped out per PRXY-04/Phase 4 and this plan's own required-behavior list), 1 cosmetic acceptance-criteria note.
**Impact on plan:** No scope creep, no incorrect behavior shipped. All required `<behavior>` assertions and `must_haves.truths` pass.

## Issues Encountered
- TypeScript resolved `approvals.require_for.includes(trigger)`'s parameter type to `never` when called directly on the generated `Approvals.require_for` field (a union of 4 differently-length tuple types). Fixed by widening to a local `readonly ApprovalTrigger[]`-typed variable first (see Decisions Made). Caught by `tsc -b`, not by `vitest` (which uses esbuild transpilation and doesn't type-check).

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- `ConnectorBinding`/`BindingSet`, `PolicyDecision`/`evaluatePolicy`, and `checkErrorThreshold` are committed with stable signatures; the Phase 4 proxy can route every live `tools/call` through `evaluatePolicy` and feed `checkErrorThreshold`'s `true` result to `policyEvents.errorThresholdExceeded()` / `reduce()` without further changes to this plan's public API.
- `index.ts`'s barrel export was left unchanged (not in this plan's `files_modified` list, matching 02-01's precedent) — a later plan should wire `bindings.ts`/`policy.ts`'s exports into `@stint/core`'s public surface.
- **Blocker for Phase 4 (PRXY-04):** full `actions_per_hour` enforcement needs `LeaseCounters` (or an equivalent per-lease structure) extended with a per-action timestamp field, plus the per-lease serialization `LeaseStore.transaction`/`withLease` primitive (D-13, enabling work also scoped to this phase but not this plan) so concurrent calls can't race past the hourly cap. Tracked in `.planning/WINDOWS.md`.
- No blockers for 02-04/02-05/02-06 from this plan's deliverables.

---
*Phase: 02-lease-state-machine-policy-engine*
*Completed: 2026-09-27*

## Self-Check: PASSED

All created files found on disk; all three task commits (`78979b2`, `3735f20`, `4061bd4`) found in `git log --oneline --all`.
