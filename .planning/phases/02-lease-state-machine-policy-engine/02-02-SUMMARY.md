---
phase: 02-lease-state-machine-policy-engine
plan: 02
subsystem: core
tags: [state-machine, reducer, typescript, vitest, spec-cross-check]

# Dependency graph
requires:
  - phase: 02-01
    provides: "CoreErrorCode/Result vocabulary, partial TRANSITION_TABLE (3 proposed rows), userEvents scaffold, reduce() tracer signature"
provides:
  - "Complete TRANSITION_TABLE (24 keys / 25 triples) transcribing ALP.md §7.4 exactly, with a runtime spec cross-check test"
  - "All seven actor-namespaced event constructor namespaces (userEvents, clockEvents, policyEvents, providerEvents, publisherEvents, verifierEvents, runtimeEvents)"
  - "reduce() enforcing full §7.4 legality/actor matrix, bounded extend (D-06), clock-only expire (D-07), and the structural agent-boundary guarantee (D-19)"
affects: [02-04, 02-05, 02-06, 04-proxy, 05-teardown, 06-cli]

actuals:
  tokens: 6686
  tasks: 2
  commits: 2
  plan_head_before: 3e43295dfe14814afc7a4ab399b6ac5b30390596

tech-stack:
  added: []
  patterns:
    - "Spec-parsing cross-check test (mirrors packages/spec/test/codegen.test.ts's diff-against-second-source-of-truth pattern): transition-table.test.ts parses the '### 7.4 Transition Table' markdown region out of spec/ALP.md at test time and asserts bidirectional set-equality against TRANSITION_TABLE."
    - "Event-specific guard step inserted between the actor check and lease computation in reduce() (Step 3), so a bounded event like extend can reject before any state/version change, keeping the numbered-step early-return structure intact."

key-files:
  created:
    - packages/core/test/transition-table.test.ts
    - packages/core/test/reduce-attribution.test.ts
  modified:
    - packages/core/src/transitions.ts
    - packages/core/src/events.ts
    - packages/core/src/lease.ts

key-decisions:
  - "Checkpoint (Task 0, gate=blocking-human) answered by the user as 'transcribe-as-normative': TRANSITION_TABLE reproduces ALP.md §7.4 exactly with no transition added, removed, or altered."
  - "The agent-boundary guarantee (D-19) required no new code in reduce() beyond the existing Step 2 actor re-check: 'agent' is not a member of the Actor union or of any TRANSITION_TABLE entry's actors array, so a hand-forged {actor:'agent'} event is already structurally rejected as wrong_actor. Verified with two dedicated hand-forged-event tests (revoke, extend) rather than adding special-case code."
  - "extend's bound check runs as its own guard step (Step 3) before the lease is computed, so a rejected extend (missing/non-positive/non-integer/over-max delta) never advances state or version — kept the reducer's numbered early-return control flow from 02-01 intact rather than folding the check into the generic transition path."
  - "expiresAt is written from a single ternary expression covering exactly two cases (consent_granted -> now + maxDurationSeconds; extend -> old expiresAt + delta) with a final else preserving the input value — satisfies 'at most two branches move expiresAt' (D-06, D-08) as one assignment site, not two separate write statements."

patterns-established:
  - "Pattern 3: normative-table cross-check via runtime markdown parsing of the spec file, asserted in both directions (spec ⊆ code and code ⊆ spec) so drift in either direction fails CI (D-05)."
  - "Pattern 4: event-specific bounded guards live in their own numbered Step, before lease computation, preserving reduce()'s Result-returning, no-mutation, early-return discipline as the table grows richer than a flat lookup."

requirements-completed: [LIFE-01, LIFE-02, LIFE-04, LIFE-05]

coverage:
  - id: D1
    description: "TRANSITION_TABLE contains exactly the 24 distinct (state,event) keys / 25 (state,event,actor) triples of ALP.md §7.4, cross-checked at test time against the spec file itself"
    requirement: LIFE-01
    verification:
      - kind: unit
        ref: "packages/core/test/transition-table.test.ts#TRANSITION_TABLE matches ALP.md Section 7.4 exactly (D-05)"
        status: pass
    human_judgment: false
  - id: D2
    description: "reduce() accepts every one of the 25 legal triples (correct `to` state, version+1) and rejects every illegal (state,event) pair with illegal_transition"
    requirement: LIFE-01
    verification:
      - kind: unit
        ref: "packages/core/test/reduce-attribution.test.ts#reduce(): full §7.4 legality matrix"
        status: pass
      - kind: unit
        ref: "packages/core/test/reduce-attribution.test.ts#reduce(): illegal pairs and terminal-state re-entry"
        status: pass
    human_judgment: false
  - id: D3
    description: "Re-dispatching any event to a terminal state (declined, cleaned_up) is rejected with illegal_transition and never changes state"
    requirement: LIFE-01
    verification:
      - kind: unit
        ref: "packages/core/test/reduce-attribution.test.ts#reduce(): illegal pairs and terminal-state re-entry"
        status: pass
    human_judgment: false
  - id: D4
    description: "retry_teardown is accepted from both user and runtime actors from cleanup_incomplete (the only dual-actor key)"
    requirement: LIFE-02
    verification:
      - kind: unit
        ref: "packages/core/test/reduce-attribution.test.ts#reduce(): retry_teardown is the only dual-actor key"
        status: pass
    human_judgment: false
  - id: D5
    description: "An event whose actor is not one the §7.4 table assigns to that (state,event) is rejected wrong_actor; a hand-forged actor:'agent' event is rejected, proving the agent can never end or extend a lease (D-19)"
    requirement: LIFE-02
    verification:
      - kind: unit
        ref: "packages/core/test/reduce-attribution.test.ts#reduce(): wrong-actor rejection"
        status: pass
      - kind: unit
        ref: "packages/core/test/reduce-attribution.test.ts#reduce(): agent-boundary guarantee (D-19)"
        status: pass
    human_judgment: false
  - id: D6
    description: "extend (actor user) sets expiresAt = old expiresAt + deltaSeconds, bounded by lease.maxDurationSeconds; extend is the only event besides grant that moves expiresAt"
    requirement: LIFE-05
    verification:
      - kind: unit
        ref: "packages/core/test/reduce-attribution.test.ts#reduce(): extend is bounded by lease.maxDurationSeconds (D-06)"
        status: pass
    human_judgment: false
  - id: D7
    description: "expire (actor clock) moves granted/active to expired without reading any timer; transition.at is the injected now"
    requirement: LIFE-04
    verification:
      - kind: unit
        ref: "packages/core/test/reduce-attribution.test.ts#reduce(): expire uses only the injected clock (D-07)"
        status: pass
    human_judgment: false
  - id: D8
    description: "No LeaseEvent constructor exists for license refresh, and EVENTS contains no refresh/license_refresh/token_refresh member"
    requirement: LIFE-05
    verification:
      - kind: unit
        ref: "packages/core/test/reduce-attribution.test.ts#reduce(): no license-refresh path can move expiry (D-08)"
        status: pass
    human_judgment: false

duration: 20min
completed: 2026-09-27
status: complete
---

# Phase 2 Plan 2: Full Reducer — §7.4 Transition Table, Event Constructors, and Legality/Actor Matrix Summary

**Completed `TRANSITION_TABLE` (24 keys / 25 triples, byte-transcribed from ALP.md §7.4 with a runtime spec cross-check test), all seven actor-namespaced event constructor namespaces, and `reduce()`'s full legality/actor/extend/expire behavior.**

## Performance

- **Duration:** 20 min (continuation after the transcribe-as-normative checkpoint decision)
- **Started:** 2026-09-27T19:57:00Z
- **Completed:** 2026-09-27T20:04:00Z
- **Tasks:** 2 (Task 0 was a `checkpoint:decision` answered by the user before this continuation began)
- **Files modified:** 5 (3 modified, 2 created)

## Accomplishments
- `transitions.ts`: `TRANSITION_TABLE` now holds every ALP.md §7.4 row — all 24 `(state,event)` keys / 25 `(state,event,actor)` triples, with `cleanup_incomplete:retry_teardown` the sole dual-actor entry (`['user', 'runtime']`). No transition added, removed, or altered beyond §7.4.
- `events.ts`: added `clockEvents`, `policyEvents`, `providerEvents`, `publisherEvents`, `verifierEvents`, `runtimeEvents` namespaces, plus `userEvents.extend(deltaSeconds)` and `userEvents.retryTeardown()`. Every constructed event is frozen and hard-codes its actor (D-19).
- `transition-table.test.ts`: parses the `### 7.4 Transition Table` markdown region straight out of `spec/ALP.md` at test time, asserts the parsed set has exactly 25 triples / 24 keys, and asserts bidirectional equality with `TRANSITION_TABLE` — so a future edit to either side fails CI. 16 tests, all passing.
- `lease.ts`: `reduce()` now bounds `extend` by `lease.maxDurationSeconds` (rejecting missing/non-positive/non-integer/over-max deltas with `extension_exceeds_max`), and computes `expiresAt` from a single expression covering exactly the two legal write paths (grant, extend) — `expire` and every other transition leave `expiresAt` untouched, and `expire`'s `at` field uses only the injected `now`.
- `reduce-attribution.test.ts`: 20 tests covering all 25 legal triples (`it.each`), illegal-pair rejection, terminal-state re-entry (`declined`, `cleaned_up`), wrong-actor rejection, the agent-boundary guarantee (hand-forged `actor:'agent'` events for both `revoke` and `extend`), extend's full bound matrix (in-bound, over-max, zero, negative, non-integer), expire's clock-only behavior, the no-refresh-path assertion, and the dual-actor `retry_teardown` case.

## Task Commits

Each task was committed atomically:

1. **Task 1: Complete the §7.4 transition table and all actor-namespaced event constructors** - `6c8a98e` (feat)
2. **Task 2: Complete reduce() — full legality, actor re-check, extend/expire, and the agent-boundary guarantee** - `56ee684` (feat)

**Plan metadata:** pending (docs: complete plan)

## Files Created/Modified
- `packages/core/src/transitions.ts` - Full `TRANSITION_TABLE` (24 keys / 25 triples), byte-transcribed from ALP.md §7.4
- `packages/core/src/events.ts` - All seven actor-namespaced constructor namespaces + `userEvents.extend`/`retryTeardown`
- `packages/core/src/lease.ts` - `reduce()`'s extend bound-check guard step and the two-branch `expiresAt` computation
- `packages/core/test/transition-table.test.ts` - Spec cross-check (parses `spec/ALP.md` §7.4 at runtime) + constructor spot checks
- `packages/core/test/reduce-attribution.test.ts` - Full legality/actor/extend/expire/agent-boundary test matrix

## Decisions Made
- Checkpoint (Task 0) answered `transcribe-as-normative` by the user before this continuation: the table is a byte-for-byte transcription of §7.4, no amendment.
- No new code was needed to enforce "the agent is never an actor" (D-19) beyond 02-01's existing Step 2 actor re-check, since `agent` is not in the `Actor` union or in any `TRANSITION_TABLE` entry's `actors` array — a hand-forged `{actor:'agent'}` event is already structurally rejected. This was proven with two dedicated tests rather than adding special-case logic, keeping the reducer's single actor-check surface authoritative.
- `extend`'s bound check was placed as its own numbered guard step (Step 3, before lease computation) rather than folded into the generic accepted-transition path, so a rejected extend never advances state or version.

## Deviations from Plan

None — plan executed exactly as written. The one addition beyond the plan's literal `<action>` text is the "terminal state re-entry" and "cleaned_up has no outgoing transitions" spot-check tests, which were already implied by the plan's `must_haves.truths` and `<behavior>` list and are covered without any reducer code change.

## Issues Encountered
None. Full monorepo `pnpm build`, `pnpm typecheck` (`tsc -b`), `pnpm lint` (`eslint .`), and `vitest run packages/core/test/` (81 tests across 7 files) all pass with zero regressions against 02-01's and 02-03's existing tests.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- The full `TRANSITION_TABLE`, all seven event-constructor namespaces, and `reduce()`'s complete legality/actor/extend/expire behavior are committed as the stable surface later plans (02-04 activation/resume, 02-05/06 LeaseStore/HostAdapter, and Phase 4/5/6) build on directly, without changing these signatures.
- `packages/core/src/index.ts`'s barrel export remains unwired (not in this plan's `files_modified` scope, matching 02-01's precedent) — a later plan wires the public API surface once more of Phase 2 lands.
- No blockers identified for the remaining Phase 2 plans.

---
*Phase: 02-lease-state-machine-policy-engine*
*Completed: 2026-09-27*

## Self-Check: PASSED

All created/modified files found on disk (`transitions.ts`, `events.ts`, `lease.ts`, `transition-table.test.ts`, `reduce-attribution.test.ts`); both task commits (`6c8a98e`, `56ee684`) found in `git log --oneline --all`.
