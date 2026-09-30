---
phase: 07-end-to-end-example-readme
plan: 08
subsystem: example
tags: [launcher, windows, windowsHide, stdio, smoke, quickstart, receipts]
requires:
  - phase: 07-end-to-end-example-readme
    provides: "07-05 fixtures (mocks, profile, manifest, acquisition) and 07-06 scenario harness"
provides:
  - "launcher.ts: createVisibleConsoleTransport (custom Transport, windowsHide:false, shell:false, injectable spawn) and resolveCliBin"
  - "launcher.test.ts: D-09 spy-spawn regression guard, runs on every platform with no real spawn"
  - "spawned-lease.ts: real-clock world + ACTIVE lease for a spawned stint run (shared by smoke and quickstart)"
  - "smoke.built-bin.test.ts: D-03 spawned dist/bin.js over MCP stdio"
  - "quickstart.ts: pnpm example:payment-reconciler, one command, merged receipts timeline + terminal-state summary"
affects: [07-09]
estimate:
  tokens: 60000
  raw_tokens: 37500
  tasks: 3
  confidence: low
actuals:
  tokens: 9500
  tasks: 3
  commits: 3
plan_head_before: 6b8fdfe361f744cad2118435e539186de7fe2f21
commits: 3
tech-stack:
  added: []
  patterns:
    - "Hidden-console failure is pinned structurally: hard-coded spawn options plus an injectable spawn so a spy asserts windowsHide:false on every OS"
    - "Real-process flows (smoke, quickstart) share one prepareSpawnedLease helper on the wall clock; the in-process harness keeps its injected clock"
    - "A single stdout sink (emit) that refuses to print a secret-shaped value or a v4.public. string"
key-files:
  created:
    - examples/payment-reconciler/src/launcher.ts
    - examples/payment-reconciler/src/spawned-lease.ts
    - examples/payment-reconciler/src/quickstart.ts
    - examples/payment-reconciler/test/launcher.test.ts
    - examples/payment-reconciler/test/smoke.built-bin.test.ts
  modified:
    - examples/payment-reconciler/tsdown.config.ts
key-decisions:
  - "Smoke uses the SDK StdioClientTransport (research A8 deterministic CI path); the windowsHide:false guarantee is carried by the launcher spy test, not a real hidden/visible child on CI."
  - "Quickstart keeps the agent connected while `stint revoke --yes` runs (connectAgent, not runAgent), so the lease ends mid-run like the e2e revoke scenario."
requirements-completed: [E2E-01, E2E-02, DOC-01]
status: complete
---

# Phase 7 Plan 8: Visible-console launcher, built-bin smoke and quickstart Summary

**A Windows-correct stdio launcher (`windowsHide:false`, `shell:false`) pinned by a spy-spawn guard, a spawned `dist/bin.js` smoke that boots and fails safe, and the verbatim `pnpm example:payment-reconciler` quickstart that prints the merged receipts timeline and a terminal-state line.**

## Accomplishments
- Task 1 (tracer): `createVisibleConsoleTransport(bin, { args, stderr?, spawnImpl? })` is a `Transport` over `child_process.spawn(process.execPath, [bin, ...args], { stdio: ["pipe","pipe","inherit"], windowsHide: false, shell: false })`, framed with the SDK's `ReadBuffer`/`serializeMessage`, handling stdin EPIPE, spawn errors and child close. `resolveCliBin()` resolves `dist/bin.js` next to `import.meta.resolve("@stint/cli")`. The guard test asserts `windowsHide === false`, stdin/stdout `"pipe"`, `shell !== true`, `command === process.execPath`, the bin path and args, plus stdout framing and `onclose`, all through a fake child (no real spawn). Tracer gate (build + scoped test) passed before expanding.
- Task 2: the built bin, spawned over MCP stdio against a real ACTIVE lease (`approvals.timeout_seconds: 1`), lists `list_transactions, mark_order_reconciled, read_orders`, denies the gated `mark_order_reconciled` with `denied: ...` (no terminal answers), produces no transport errors, and no access/refresh token, license, or `v4.public.` substring reaches the client or the child's stderr.
- Task 3: `pnpm example:payment-reconciler` (built `dist/quickstart.js`) stands up the mocks, acquires both grants, signs the manifest, runs `stint create --publisher`, spawns `stint run` through the launcher, drives the agent (two reads ok, the irreversible write denied on the short timeout), runs `stint revoke --yes` with the agent still connected, then prints the `stint receipts` timeline (`[verified]` entries including `teardown cleanup_hook: attested_ok`) and `Lease <id> finished: cleaned_up (publisher cleanup attested).` Exit 0; `v4.public.` count in stdout is 0.

## Verification evidence
- `pnpm build` then scoped `vitest run test/launcher.test.ts test/smoke.built-bin.test.ts`: 2 files, 4 tests pass.
- `pnpm example:payment-reconciler`: exit 0, terminal-state summary present, merged timeline shown, no secret substrings.
- `tsc --noEmit -p examples/payment-reconciler`, `eslint` and `prettier --check` on the new files are clean.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Extracted a shared real-process setup helper (`src/spawned-lease.ts`)**
- **Found during:** Task 2
- **Issue:** The smoke (Task 2) and the quickstart (Task 3) both need the same real-clock world plus an ACTIVE lease and JSON profile/credentials for a spawned `stint run`. `runScenario` cannot be reused (it serves in-process on an injected clock) and `quickstart.ts` cannot be imported (it runs on import).
- **Fix:** One new file, `spawned-lease.ts`, used by both. It is not in the plan's `files_modified`; no existing file changed for it.
- **Files modified:** examples/payment-reconciler/src/spawned-lease.ts
- **Commit:** 0c5d20d

**2. [Rule 1 - Plan inaccuracy] Quickstart does not "write the profile and credentials to the store"**
- **Issue:** The plan says to write them into the store; they live in the per-run temp work dir beside the store (credentials hold secrets and stay outside the store root), passed by path to `--profile`/`--credentials`. Same wiring, safer location.

## Observations (not deviations)
- The receipts timeline shows three `revoke_oauth` teardown steps against two AS `/revoke` hits (two grants). This is pre-existing runtime behavior, identical in the in-process scenario, and untouched here.
- In the spawned quickstart the JSON profile drops the `resource_query` `rowAdapter` (a function is not JSON), so the verifier path is not used; the README/e2e cover it, and the quickstart ends with `revoke`.
- A8 fallback was not needed: the smoke already uses `StdioClientTransport`, so the `windows-latest` hidden-console concern never applies to a real `windowsHide:false` child on CI. The visible-console real-child path was exercised locally by the quickstart itself on Windows (prompt-capable console; the gated write timed out in 2s, fail-safe).

## Known Stubs
None.

## Threat Flags
None. No new network surface beyond loopback mocks already in the threat model.

## Self-Check: PASSED
Created files present (launcher.ts, spawned-lease.ts, quickstart.ts, launcher.test.ts, smoke.built-bin.test.ts); commits 050a87b, 0c5d20d, d2b1cb5 exist.
