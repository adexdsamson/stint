---
phase: 04-mcp-proxy-credential-vault
plan: 01
subsystem: proxy
tags: [mcp-sdk, oauth4webapi, oauth2-mock-server, tsdown, lease-counters, typescript]

# Dependency graph
requires:
  - phase: 02-lease-state-machine-policy-engine
    provides: "LeaseCounters (actionCount, spentMinor, denialErrorTimestamps), evaluatePolicy, checkErrorThreshold"
  - phase: 03-receipts-licensing
    provides: "@stint/core/testing subpath convention mirrored for @stint/proxy/testing"
provides:
  - "@stint/proxy package scaffolded with pinned @modelcontextprotocol/sdk@1.30.1, oauth4webapi@3.8.8 (deps) and oauth2-mock-server@9.2.0 (devDep)"
  - "@stint/proxy engines.node >=22.18.0, matching the rest of the monorepo"
  - "@stint/proxy/testing subpath scaffold (placeholder barrel, wired into tsdown + package.json exports)"
  - "LeaseCounters.actionTimestamps: readonly number[] — the sliding-window field PRXY-04 (plan 04-03) mutates"
affects: [04-02, 04-03, 04-04, 04-05, 04-06, 04-07]

# Actuals (#2632)
actuals:
  tokens: 2200
  tasks: 3
  commits: 3

# Tech tracking
tech-stack:
  added: ["@modelcontextprotocol/sdk@1.30.1", "oauth4webapi@3.8.8", "oauth2-mock-server@9.2.0 (devDependency)"]
  patterns:
    - "@stint/proxy/testing subpath mirrors @stint/core/testing (public `.` barrel never re-exports testing helpers)"
    - "Type-level additive field TDD: RED evidenced via `tsc -b` failing on an intentional excess-property/unknown-property error, not a vitest runtime assertion, since the feature is a compile-time-only interface addition"

key-files:
  created:
    - packages/proxy/src/testing.ts
    - packages/core/test/lease-counters-action-timestamps.test.ts
  modified:
    - packages/proxy/package.json
    - packages/proxy/tsdown.config.ts
    - packages/core/src/lease.ts
    - packages/core/src/testing.ts
    - packages/core/test/activate.test.ts
    - packages/core/test/lease-reduce.test.ts
    - packages/core/test/policy.test.ts
    - packages/core/test/reduce-attribution.test.ts

key-decisions:
  - "Task 1's package-legitimacy checkpoint was pre-cleared by the orchestrator (human already approved all three [SUS] too-new packages at their exact CLAUDE.md-pinned versions); installed only those exact pins, no ^/~, no postinstall scripts observed."
  - "RED phase for the LeaseCounters.actionTimestamps TDD task used `pnpm typecheck` as the failing-test runner (TS2353/TS2339 excess/unknown-property errors), not vitest — vitest's esbuild transform strips types and does not fail on an extra object-literal property, so a compile-time-only additive field's genuine RED signal is tsc, not the test runner."
  - "actionTimestamps is data-only this plan; no sliding-window pruning/enforcement logic was added (explicitly deferred to plan 04-03 per the plan's own scope note)."

patterns-established:
  - "@stint/proxy/testing subpath: placeholder barrel today, later Wave-2/3 plans populate it with proxy test doubles (mock OutboundConnector, mock OAuth wiring) — never re-exported from the public `.` entry."

requirements-completed: [PRXY-04]

coverage:
  - id: D1
    description: "@stint/proxy package.json declares the three pinned deps/devDep at exact versions with engines.node >=22.18.0"
    requirement: PRXY-04
    verification:
      - kind: unit
        ref: "packages/proxy/test/smoke.test.ts"
        status: pass
      - kind: other
        ref: "packages/proxy/package.json (manual inspection of dependencies/devDependencies/engines)"
        status: pass
    human_judgment: false
  - id: D2
    description: "@stint/proxy/testing subpath builds and is exported alongside the existing `.` entry"
    verification:
      - kind: unit
        ref: "npx --yes pnpm@12.6.0 --filter @stint/proxy build (produces dist/testing.js + dist/testing.d.ts)"
        status: pass
    human_judgment: false
  - id: D3
    description: "LeaseCounters carries actionTimestamps: readonly number[] additively; every existing literal updated; workspace typechecks"
    requirement: PRXY-04
    verification:
      - kind: unit
        ref: "npx --yes pnpm@12.6.0 typecheck (whole workspace, tsc -b)"
        status: pass
      - kind: unit
        ref: "packages/core/test/lease-counters-action-timestamps.test.ts#is carried alongside actionCount, spentMinor, and denialErrorTimestamps"
        status: pass
      - kind: unit
        ref: "packages/core/test/policy.test.ts, packages/core/test/lease-store-contract.test.ts, packages/core/test/public-api.test.ts"
        status: pass
    human_judgment: false

duration: ~15min
completed: 2026-09-28
status: complete
---

# Phase 4 Plan 1: MCP Proxy Scaffold & LeaseCounters Sliding-Window Field Summary

**Scaffolded `@stint/proxy` with pinned `@modelcontextprotocol/sdk`/`oauth4webapi`/`oauth2-mock-server` and its `./testing` subpath, then added `LeaseCounters.actionTimestamps` to `@stint/core` via a compile-time TDD cycle.**

## Performance

- **Duration:** ~15 min
- **Started:** 2026-09-28T14:33 (approx, first build)
- **Completed:** 2026-09-28T14:40
- **Tasks:** 3 (1 pre-cleared checkpoint + 2 auto/tdd tasks)
- **Files modified:** 10

## Accomplishments
- `@stint/proxy` now installs `@modelcontextprotocol/sdk@1.30.1`, `oauth4webapi@3.8.8` (dependencies) and `oauth2-mock-server@9.2.0` (devDependency) at exact pinned versions, with `engines.node` bumped to `>=22.18.0` to match `@stint/core`.
- `@stint/proxy` gained a `./testing` subpath (`src/testing.ts` placeholder barrel + `tsdown`/`package.json exports` wiring), mirroring `@stint/core/testing`'s convention ahead of Wave-2/3 plans populating it with real test doubles.
- `@stint/core`'s `LeaseCounters` gained `readonly actionTimestamps: readonly number[]`, additive and data-only, closing the gap `policy.ts` flagged since Phase 2 (`over_actions_per_hour`'s counter "isn't part of the `LeaseCounters` aggregate this phase built"). Every existing literal (`makeTestLease` + 4 test files, 8 call sites) was updated.

## Task Commits

Each task was committed atomically:

1. **Task 1: Package-legitimacy gate** — pre-cleared by the orchestrator; no commit (human approval already recorded upstream).
2. **Task 2: Scaffold @stint/proxy** — `3312c73` (feat)
3. **Task 3: Additive LeaseCounters.actionTimestamps (TDD)** — `47fa2e0` (test, RED) → `83bfa90` (feat, GREEN). No REFACTOR commit — the additive interface field and its literal updates needed no cleanup pass.

**Plan metadata:** committed separately after this SUMMARY (see final metadata commit).

## Files Created/Modified
- `packages/proxy/package.json` - added 3 pinned deps/devDep, bumped `engines.node`, added `./testing` export entry
- `packages/proxy/tsdown.config.ts` - added `./src/testing.ts` as a second build entry
- `packages/proxy/src/testing.ts` - new placeholder barrel for the `@stint/proxy/testing` subpath
- `packages/core/src/lease.ts` - `LeaseCounters` gained `actionTimestamps: readonly number[]`
- `packages/core/src/testing.ts` - `makeTestLease`'s counters literal gained `actionTimestamps: []`
- `packages/core/test/lease-counters-action-timestamps.test.ts` - new RED/GREEN test proving the field exists and round-trips
- `packages/core/test/activate.test.ts`, `lease-reduce.test.ts`, `policy.test.ts` (4 literals), `reduce-attribution.test.ts` - each `LeaseCounters` literal updated with the sibling `actionTimestamps: []`

## Decisions Made
- Task 1's blocking-human package-legitimacy checkpoint was already satisfied by the orchestrator before this executor ran — treated as approved per the explicit hand-off instruction, no re-pause.
- Used `pnpm typecheck` (not vitest) as the RED-phase failing-test runner for the `LeaseCounters.actionTimestamps` TDD task, since the change is compile-time-only (vitest's esbuild transform doesn't enforce TypeScript's excess-property check at runtime). The RED test file (`lease-counters-action-timestamps.test.ts`) failed intentionally with `TS2353`/`TS2339` on exactly the planned `actionTimestamps` usage before the interface change, and passed both `tsc -b` and `vitest run` after.
- Kept `actionTimestamps` strictly data-only — no sliding-window pruning or `over_actions_per_hour` enforcement logic was added; that is explicitly plan 04-03's scope.

## Deviations from Plan

None - plan executed exactly as written. Task 1's checkpoint was pre-cleared by the orchestrator per this session's explicit instructions, which is expected checkpoint-continuation behavior, not a deviation from the plan's content.

## Issues Encountered
None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness
- `@stint/proxy` is buildable, has its pinned MCP/OAuth substrate installed, and exposes a `./testing` subpath ready for Wave-2/3 plans (server, catalog, vault, connectors) to populate.
- `LeaseCounters.actionTimestamps` is in place and typechecked everywhere; plan 04-03 can now implement the sliding-window `actions_per_hour` enforcement (pruning + window check) against this field without any further core interface changes.
- No blockers identified for 04-02 onward.

---
*Phase: 04-mcp-proxy-credential-vault*
*Completed: 2026-09-28*

## Self-Check: PASSED

All claimed created/modified files exist on disk and all claimed commit hashes (`3312c73`, `47fa2e0`, `83bfa90`) are present in git history.
