---
phase: 07-end-to-end-example-readme
plan: 09
subsystem: docs
tags: [readme, documentation, drift-test, quickstart, trust-limits]
requires:
  - phase: 07-end-to-end-example-readme
    provides: "07-08 quickstart bin (pnpm example:payment-reconciler) and 07-01 CI verbatim step"
provides:
  - "README.md: problem, three auth modes, hosted-mode trust limits, verbatim quickstart + lifecycle"
  - "readme.test.ts: drift test pinning section order and documented commands to real scripts"
affects: []
estimate:
  tokens: 40000
  raw_tokens: 25000
  tasks: 2
  confidence: low
actuals:
  tokens: 9000
  tasks: 2
  commits: 2
plan_head_before: 3c9a44c933738330e4a40351fadc5f261fdabfa1
commits: 2
tech-stack:
  added: []
  patterns:
    - "Docs are build-enforced: a vitest drift test reads README.md and asserts heading order and command equality with package.json scripts and the CLI's real subcommands"
key-files:
  created:
    - README.md
    - examples/payment-reconciler/test/readme.test.ts
  modified: []
key-decisions:
  - "README cites the actual spec sections (auth modes are section 8, not 5 as the plan text said; receipts 11; trust limits 13)."
  - "Drift test also checks the documented stint subcommands against .command(...) names in packages/cli/src/program.ts, not only the pnpm scripts."
  - "No scripts/check-readme-sections.mjs was added; the vitest drift test is the sole gate (task 1's verify reference to it was optional)."
requirements-completed: [DOC-01]
status: complete
---

# Phase 7 Plan 9: README and drift test Summary

**An original README with the four ordered sections (problem, delegated/hosted/hybrid auth modes, hosted-mode trust limits, verbatim `pnpm example:payment-reconciler` quickstart plus the `stint` lifecycle), pinned by a drift test so its commands cannot diverge from real scripts.**

## Accomplishments
- Task 1 (tracer): `README.md` at the repo root. Section 1 frames what MCP and OAuth 2.1 leave out (consent, revocation, uninstall), the lease proxy with enforcement outside the model, and the honest teardown. Section 2 covers `delegated`, `hosted`, `hybrid` (hybrid default) and that the license is never given to the agent or forwarded. Section 3 states the four spec section 13 limits plainly plus the further limits (agent process not network-sandboxed, offline license revocation latency, `discarded_revocation_unsupported`, publisher key custody) and explains verified vs attested as v0.1 actually produces it: `[verified]` entries plus the `cleanup_hook: attested_ok` marker, no separate attested chain. Section 4 gives the three fenced commands `pnpm install`, `pnpm build`, `pnpm example:payment-reconciler`, describes the real output, then the `stint create/run/revoke/cleanup/receipts/verify` lifecycle. The Node 22.18+ and `corepack enable` note is included; the sandbox `npx --yes pnpm` workaround is not.
- Task 2: `examples/payment-reconciler/test/readme.test.ts` (4 tests): `##` headings in order; fenced `pnpm` commands equal exactly the three quickstart commands with the root `build` and `example:payment-reconciler` scripts (and the example `start` script) present; fenced `stint` commands are exactly create/run/revoke/cleanup/receipts/verify and each is a real CLI subcommand; the three mode names, hybrid default, `verified`/`attested`, `[verified]` and `cleanup_hook: attested_ok` are present.

## Verification evidence
- `pnpm build` then scoped `vitest run test/readme.test.ts`: 1 file, 4 tests pass (re-run after prettier).
- `pnpm example:payment-reconciler` executed verbatim on Windows: exit 0, merged timeline of `[verified]` entries including `teardown cleanup_hook: attested_ok`, final line `finished: cleaned_up (publisher cleanup attested).` This matches what the README describes.
- `prettier --check` and `eslint` clean on the new test file; `prettier --check README.md` clean.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Plan inaccuracy] Spec section numbers**
- **Found during:** Task 1
- **Issue:** The plan and CONTEXT cite spec section 5 for the auth modes; in `spec/ALP.md` section 5 is the signed manifest envelope and the auth modes are section 8.
- **Fix:** The README grounds the auth-modes section in section 8 (and 11 and 13 for receipts and trust limits).
- **Files modified:** README.md
- **Commit:** a4e641b

**2. [Plan option] No `scripts/check-readme-sections.mjs`**
- The plan's task 1 verify referenced an optional checker script guarded by `|| true`; it was not created. The vitest drift test is the authoritative gate, as the plan states.

## Known Stubs
None.

## Threat Flags
None. Docs and a test only; no new surface.

## Self-Check: PASSED
README.md and examples/payment-reconciler/test/readme.test.ts present; commits a4e641b and 12dc9e7 exist.
