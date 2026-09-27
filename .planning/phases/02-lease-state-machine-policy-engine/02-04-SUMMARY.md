---
phase: 02-lease-state-machine-policy-engine
plan: 04
subsystem: core
tags: [state-machine, hash-binding, typescript, vitest]

# Dependency graph
requires:
  - phase: 02-02
    provides: "Complete TRANSITION_TABLE (24 keys/25 triples), all actor-namespaced event constructor namespaces (runtimeEvents.activate/activationFailed/runtimeFailure), and reduce()'s full legality/actor matrix"
provides:
  - "verifyBoundHash(boundHash, verifiedManifest) — the single shared pure hash guard, recomputing via @stint/spec hashManifest and string-comparing, trusting no caller-supplied .contentHash field"
  - "activateLease(lease, verifiedManifest, now) — granted lease -> active on hash match, -> failed (activation_failed, actor runtime) on mismatch, via reduce"
  - "resumeLease(lease, verifiedManifest, now) — active lease -> failed (runtime_failure, actor runtime) on hash mismatch on resume; unchanged lease with no transition on a matching resume"
affects: [02-05, 02-06, 03-receipts-licensing, 04-proxy, 05-teardown]

actuals:
  tokens: 2787
  tasks: 2
  commits: 2
  plan_head_before: 032195e6b891cd6ba9d24ac5b7db4bf5ef2ce041

tech-stack:
  added: []
  patterns:
    - "Small pure guard, one job, no Result wrapper (mirrors @stint/spec's isContentHash style) — the caller decides what a boolean false means (D-21)."
    - "Two entry points sharing one guard, each dispatching a distinct actor-namespaced event through reduce, so the transition record is produced identically to any other lifecycle transition."

key-files:
  created:
    - packages/core/src/hash-guard.ts
    - packages/core/src/activate.ts
    - packages/core/test/hash-guard.test.ts
    - packages/core/test/activate.test.ts
  modified: []

key-decisions:
  - "resumeLease's return type is Result<{ lease; transition: TransitionRecord | undefined }> rather than reusing reduce()'s exact type: a matching resume is not itself a §7.4 state-changing event, so there is nothing to dispatch through reduce and no transition to record — the function returns the lease unchanged with transition: undefined, matching the plan's must_haves note that a resume match has no state-changing event."
  - "Both hash-guard.test.ts and activate.test.ts mint real VerifiedManifest values via @stint/spec/testing's signManifestForTest + verifyEnvelope (not hand-built fixtures), so the tests exercise the actual verification path a caller would use, not a shortcut."
  - "index.ts barrel export left unwired, matching 02-01/02-02 precedent — not in this plan's files_modified scope."

patterns-established:
  - "Pattern 5: a guarded activate/resume entry point is 'compute the guard boolean once, pick the event constructor by that boolean, dispatch through reduce' — no inline second hash comparison, no duplicated legality logic outside reduce()."

requirements-completed: [LIFE-03]

coverage:
  - id: D1
    description: "verifyBoundHash recomputes the manifest's content hash via @stint/spec hashManifest and returns a plain boolean string-compare against the bound hash, re-implementing no hashing"
    requirement: LIFE-03
    verification:
      - kind: unit
        ref: "packages/core/test/hash-guard.test.ts#verifyBoundHash MATCH: returns true when boundHash is hashManifest(vm.manifest)"
        status: pass
      - kind: unit
        ref: "packages/core/test/hash-guard.test.ts#verifyBoundHash MISMATCH: returns false when boundHash belongs to a DIFFERENT manifest"
        status: pass
    human_judgment: false
  - id: D2
    description: "verifyBoundHash trusts no caller-supplied .contentHash field — a tampered .contentHash matching boundHash does not make a mismatched .manifest pass"
    requirement: LIFE-03
    verification:
      - kind: unit
        ref: "packages/core/test/hash-guard.test.ts#verifyBoundHash NO TRUST OF SUPPLIED FIELD: a tampered .contentHash matching boundHash does not make a mismatched .manifest pass"
        status: pass
    human_judgment: false
  - id: D3
    description: "activateLease dispatches runtimeEvents.activate() through reduce on a hash match (granted -> active) and runtimeEvents.activationFailed() on mismatch (granted -> failed), both actor runtime"
    requirement: LIFE-03
    verification:
      - kind: unit
        ref: "packages/core/test/activate.test.ts#activateLease ACTIVATE MATCH: a granted lease whose boundHash matches -> active, actor runtime, event activate"
        status: pass
      - kind: unit
        ref: "packages/core/test/activate.test.ts#activateLease ACTIVATE MISMATCH: a granted lease bound to a DIFFERENT manifest -> failed, event activation_failed, actor runtime"
        status: pass
    human_judgment: false
  - id: D4
    description: "resumeLease dispatches runtimeEvents.runtimeFailure() on a hash mismatch (active -> failed), the distinct resume-path failure event per ALP.md §7.5, and leaves a matching resume's lease unchanged with no transition"
    requirement: LIFE-03
    verification:
      - kind: unit
        ref: "packages/core/test/activate.test.ts#resumeLease RESUME MISMATCH: an active lease with a mismatching bound hash -> failed, event runtime_failure, actor runtime"
        status: pass
      - kind: unit
        ref: "packages/core/test/activate.test.ts#resumeLease RESUME MATCH: an active lease with a matching bound hash stays active and emits no runtime_failure"
        status: pass
    human_judgment: false
  - id: D5
    description: "activateLease and resumeLease both consume the ONE shared verifyBoundHash guard — no duplicated hash comparison"
    requirement: LIFE-03
    verification:
      - kind: other
        ref: "grep -c \"verifyBoundHash\" packages/core/src/activate.ts >= 2 (one call site per entry point)"
        status: pass
    human_judgment: false

duration: 18min
completed: 2026-09-27
status: complete
---

# Phase 2 Plan 4: Manifest-Hash Binding — verifyBoundHash, activateLease, resumeLease Summary

**One shared `verifyBoundHash` pure guard, recomputing the manifest content hash via `@stint/spec`'s `hashManifest`, consumed by both `activateLease` (granted → active/failed) and `resumeLease` (active → failed on mismatch), each emitting the distinct failure event ALP.md §7.4/§7.5 requires.**

## Performance

- **Duration:** 18 min
- **Started:** 2026-09-27T20:12:00Z
- **Completed:** 2026-09-27T20:30:00Z
- **Tasks:** 2
- **Files modified:** 4 (all created)

## Accomplishments
- `hash-guard.ts`: `verifyBoundHash(boundHash, verifiedManifest)` recomputes the presented manifest's content hash via `@stint/spec`'s `hashManifest` and does a plain string compare — no re-implemented canonicalization/hashing, no trust of a caller-supplied `.contentHash` field.
- `activate.ts`: `activateLease(lease, verifiedManifest, now)` dispatches `runtimeEvents.activate()` on a hash match and `runtimeEvents.activationFailed()` on mismatch, both through `reduce`; `resumeLease(lease, verifiedManifest, now)` dispatches `runtimeEvents.runtimeFailure()` on mismatch and returns the lease unchanged (no transition) on a match. Both call the one shared `verifyBoundHash` guard — no duplicated hash logic.
- `hash-guard.test.ts`: 3 passing tests (MATCH, MISMATCH, tampered-`.contentHash` no-trust case), each minting a real `VerifiedManifest` via `@stint/spec/testing`'s `signManifestForTest` + `verifyEnvelope`.
- `activate.test.ts`: 4 passing tests covering activate match/mismatch and resume match/mismatch, using the same real-`VerifiedManifest` construction.

## Task Commits

Each task was committed atomically:

1. **Task 1: verifyBoundHash — the single shared pure hash guard** - `22a62b9` (feat)
2. **Task 2: activateLease and resumeLease — hash-guarded entry points with distinct failure events** - `de04219` (feat)

**Plan metadata:** pending (docs: complete plan)

## Files Created/Modified
- `packages/core/src/hash-guard.ts` - `verifyBoundHash` — recompute-and-compare pure guard
- `packages/core/src/activate.ts` - `activateLease`, `resumeLease` — hash-guarded entry points dispatching through `reduce`
- `packages/core/test/hash-guard.test.ts` - MATCH/MISMATCH/no-trust-of-supplied-field tests for `verifyBoundHash`
- `packages/core/test/activate.test.ts` - activate match/mismatch and resume match/mismatch tests

## Decisions Made
- `resumeLease` returns `Result<{ lease; transition: TransitionRecord | undefined }>` rather than reusing `reduce()`'s exact return type: a matching resume has no corresponding §7.4 state-changing event to dispatch, so there is no `TransitionRecord` to produce — the plan's own `<behavior>` text anticipated this ("return an ok Result whose transition is absent or a no-op sentinel").
- Both test files mint real `VerifiedManifest` values through `@stint/spec/testing`'s `signManifestForTest` + `@stint/spec`'s `verifyEnvelope`, per the plan's explicit instruction, rather than hand-building a fixture that skips verification.
- `index.ts`'s barrel export remains unwired, consistent with 02-01/02-02 — not in this plan's `files_modified` scope.

## Deviations from Plan

None — plan executed exactly as written. Both tasks followed RED (test written against a not-yet-existing module, confirmed failing on module resolution) → GREEN (implementation added, tests pass) before each single task commit, consistent with this phase's established one-commit-per-task convention (see 02-01, 02-02 SUMMARYs).

## Issues Encountered

None. Full monorepo `pnpm build`, `pnpm typecheck` (`tsc -b`), `pnpm lint` (`eslint .`), and `vitest run packages/core/test/` (9 files, 88 tests) all pass with zero regressions against 02-01/02-02/02-03's existing tests.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- `verifyBoundHash`, `activateLease`, and `resumeLease` are committed as the stable signatures Phase 3 (receipts consuming `TransitionRecord`) and Phase 4 (the proxy, which wraps `activateLease`/`resumeLease` with the delegated-grant and license-issuance guards this plan deliberately left as I/O for later phases) build on.
- `index.ts`'s barrel export remains unwired — a later plan wires the public API surface once more of Phase 2 lands.
- No blockers identified for the remaining Phase 2 plans (02-05, 02-06).

---
*Phase: 02-lease-state-machine-policy-engine*
*Completed: 2026-09-27*

## Self-Check: PASSED

All created files found on disk (`hash-guard.ts`, `activate.ts`, `hash-guard.test.ts`, `activate.test.ts`); both task commits (`22a62b9`, `de04219`) found in `git log --oneline --all`.
