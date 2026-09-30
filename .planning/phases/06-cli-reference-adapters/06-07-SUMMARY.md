---
phase: 06-cli-reference-adapters
plan: 07
subsystem: cli
tags: [revoke, cleanup, teardown, vault, oauth-revocation, idempotent-retry, public-barrel]

requires:
  - phase: 06-cli-reference-adapters
    provides: "CliDeps/program (06-04), envelope persistence + run (06-06), stores (06-01, 06-02), runtime key + credentials (06-04)"
  - phase: 05-lease-endings-teardown
    provides: "runTeardown/retryTeardown, appendTransitionReceipt, createDefaultTeardownSteps, auto-chain, idempotent progress"
provides:
  - "stint revoke <leaseId>: [y/N] (--yes), user-actor revoke transaction, transition receipt, auto-chained runTeardown, exit 0 or 7"
  - "stint cleanup <leaseId>: state switch (runTeardown | retryTeardown | no-op | refuse), lazy expiry settle (A9), exit 0 or 7"
  - "commands/teardown-support.ts: real in-memory vault + runtime signing key + manifest cleanup hook -> TeardownDeps; confirm gate; result reporting"
  - "credentials file may carry non-secret clientId + revocationEndpoint so RFC 7009 revocation can be attempted from revoke/cleanup"
  - "CliDeps seams: confirm, teardown.decorateSteps, teardown.allowInsecureRequests (tests only)"
  - "Consolidated @stint/cli public barrel"
affects: [07-example]

actuals:
  tokens: 12600
  tasks: 3
  commits: 3
plan_head_before: 4ab3941ca0c2f5cc35177764586c833e388db8c4
commits: 3

tech-stack:
  added: []
  patterns:
    - "Commands are thin drivers: they assemble TeardownDeps and report; every state change and step is the Phase-5 orchestrator's"
    - "Destructive confirmation is an injectable CliDeps.confirm seam (stderr prompt), absent means no terminal, and no terminal without --yes refuses"

key-files:
  created:
    - packages/cli/src/commands/teardown-support.ts
    - packages/cli/test/helpers/teardown-rig.ts
    - packages/cli/test/revoke.test.ts
    - packages/cli/test/cleanup.test.ts
    - packages/cli/test/public-api.test.ts
  modified:
    - packages/cli/src/commands/revoke.ts
    - packages/cli/src/commands/cleanup.ts
    - packages/cli/src/deps.ts
    - packages/cli/src/real-deps.ts
    - packages/cli/src/run/credentials.ts
    - packages/cli/src/index.ts

key-decisions:
  - "program.ts stayed frozen. Since revoke/cleanup have no --profile flag, the OAuth revocation client (AS token/revocation endpoint, client_id) comes from optional non-secret fields in the --credentials file; without a revocationEndpoint revocation is honestly receipted as discarded_revocation_unsupported."
  - "A declined [y/N] exits 3 (consentDeclined) with nothing changed; no terminal and no --yes exits 2 (usage). Consent is never assumed."
  - "--credentials is required for a delegated lease only while revoke_oauth has not been recorded. A cleanup_incomplete retry after revoke_oauth was attempted needs none (it is attempted-is-terminal, D-23)."
  - "A credentials file that mixes authorization servers is refused up front: the vault holds one OAuth client, and revoking against the wrong AS would be dishonest."

patterns-established:
  - "teardown-rig: real active lease via stint create, rewriteable state, scripted confirm, step recorder/fault injector, loopback RFC 7009 revocation server"

requirements-completed: [CLI-01]

coverage:
  - id: R1
    description: "revoke --yes / 'y': an active lease is revoked by the user actor, teardown auto-chains to cleaned_up, transitions revoke/begin_teardown/teardown_succeeded are receipted, exit 0; the AS receives the RFC 7009 request and revoke_oauth is receipted 'revoked'"
    requirement: CLI-01
    verification:
      - kind: integration
        ref: "packages/cli/test/revoke.test.ts#stint revoke"
        status: pass
    human_judgment: false
  - id: R2
    description: "revoke_oauth is honestly receipted: no revocation endpoint -> discarded_revocation_unsupported (never 'revoked'), unreachable endpoint -> failed; both land cleanup_incomplete, exit 7"
    requirement: CLI-01
    verification:
      - kind: integration
        ref: "packages/cli/test/revoke.test.ts#without a revocation endpoint / an unreachable revocation endpoint"
        status: pass
    human_judgment: false
  - id: R3
    description: "revoke: 'n' changes nothing (3); no terminal without --yes refuses (2); delegated without --credentials refuses before any state change (2); proposed/completed/cleaned_up refused with wrongState (9); unknown lease 4; missing stored manifest 5"
    requirement: CLI-01
    verification:
      - kind: integration
        ref: "packages/cli/test/revoke.test.ts"
        status: pass
    human_judgment: false
  - id: R4
    description: "A fault-injected step lands cleanup_incomplete, exit 7; every step still runs in the fixed order"
    requirement: CLI-01
    verification:
      - kind: integration
        ref: "packages/cli/test/revoke.test.ts#a fault-injected teardown step"
        status: pass
    human_judgment: false
  - id: R5
    description: "cleanup: completed/expired/revoked/failed run teardown and auto-chain begin_teardown; tearing_down resumes; cleaned_up is a no-op that writes nothing; active non-expired and proposed/declined are refused (9)"
    requirement: CLI-01
    verification:
      - kind: integration
        ref: "packages/cli/test/cleanup.test.ts"
        status: pass
    human_judgment: false
  - id: R6
    description: "cleanup_incomplete resumes via retryTeardown (actor user): succeeded steps are not re-run, earlier outcomes are unchanged, the lease never becomes active; a second forced failure stays cleanup_incomplete (7)"
    requirement: CLI-01
    verification:
      - kind: integration
        ref: "packages/cli/test/cleanup.test.ts#cleanup_incomplete resumes via retryTeardown / a second forced failure"
        status: pass
    human_judgment: false
  - id: R7
    description: "An active lease past expiresAt is settled with clockEvents.expire() (receipted, actor clock) and then torn down"
    requirement: CLI-01
    verification:
      - kind: integration
        ref: "packages/cli/test/cleanup.test.ts#an active lease past expiresAt (A9)"
        status: pass
    human_judgment: false
  - id: R8
    description: "No credential material is persisted (lease, receipts) or printed by revoke"
    requirement: CLI-01
    verification:
      - kind: integration
        ref: "packages/cli/test/revoke.test.ts#never persists or prints credential material"
        status: pass
    human_judgment: false
  - id: R9
    description: "Public barrel exports the four factories, buildProgram and main; PACKAGE_NAME/PROXY_PACKAGE_NAME unchanged"
    requirement: CLI-01
    verification:
      - kind: unit
        ref: "packages/cli/test/public-api.test.ts, packages/cli/test/smoke.test.ts"
        status: pass
    human_judgment: false
  - id: R10
    description: "Interactive [y/N] on a real Windows/POSIX terminal via askLine(process.stdin, process.stderr)"
    requirement: CLI-01
    verification:
      - kind: manual
        ref: "end-of-phase UAT (batched, not run here); tests drive the confirm seam"
        status: pending
    human_judgment: true

duration: 30min
completed: 2026-09-30
status: complete
---

# Phase 6 Plan 07: stint revoke and stint cleanup Summary

**`stint revoke` and `stint cleanup` are thin drivers over the Phase-5 teardown orchestrator: the CLI adds the entry transition, a `[y/N]` gate, a real in-memory vault seeded from `--credentials`, and result reporting, with idempotent resume and honest `revoke_oauth` receipts, closing CLI-01.**

## Accomplishments

- `revokeCommand`: refuses unless the lease is `granted`/`active` (wrongState 9), builds real-vault `TeardownDeps` before touching state, confirms, runs `transaction(reduce(userEvents.revoke()))` (actor `user`), receipts the transition with `appendTransitionReceipt`, then `runTeardown` auto-chains `begin_teardown`. Exit 0 on `cleaned_up`, 7 on `cleanup_incomplete`.
- `cleanupCommand`: state switch per Pattern 5. `completed/expired/revoked/failed/tearing_down` run `runTeardown`; `cleanup_incomplete` runs `retryTeardown(deps, "user", now)`; `cleaned_up` is a no-op success that writes nothing; `granted/active` (not expired) is refused with "The lease has not ended; use revoke."; `proposed/declined` are refused. An `active` (or `granted`) lease past `expiresAt` is settled with `clockEvents.expire()` and receipted first (A9).
- `teardown-support.ts` is the only shared code: real `createCredentialVault` seeded from `--credentials`, the runtime Ed25519 key as `signingKey`, the manifest's cleanup-hook URL, `createDefaultTeardownSteps(receiptStore, key, vault, undefined, cleanup)`. Grep confirms it is always called WITH a vault.
- Barrel: added `RunSeams`, `TeardownSeams`, `LoadedCredential` types; the four factories, `buildProgram`, `main`, `PACKAGE_NAME`, `PROXY_PACKAGE_NAME` were already present from earlier plans and are now pinned by `public-api.test.ts`.
- Scoped `packages/cli` suite: 21 files, 241 tests pass with `--pool=threads`; `tsc -p packages/cli --noEmit`, `eslint packages/cli/src packages/cli/test`, prettier, and `tsdown` build are clean. `program.test.ts` still passes (06-06 had already moved it off the stubs).

## Task Commits

1. **Task 1: stint revoke + shared teardown wiring** - `0b0dd01` (feat)
2. **Task 2: stint cleanup** - `3ce0ee4` (feat)
3. **Task 3: public barrel + public-api test** - `87e6e5e` (feat)

## Deviations from Plan

**1. [Rule 2 - Missing critical] Credentials file carries non-secret AS details for revocation**
- **Found during:** Task 1
- **Issue:** the plan wires a "REAL vault" but `createCredentialVault` needs an `OAuthClient` (AS revocation endpoint + client_id), which `run` gets from `--profile`. `revoke`/`cleanup` have no `--profile` flag and `program.ts` is frozen, so the vault could never have attempted RFC 7009 revocation.
- **Fix:** `loadCredentials` accepts optional `clientId` and `revocationEndpoint` per entry (`revocationEndpoint` requires `clientId`); `teardown-support` derives the vault's `OAuthClient` from them. `seedVaultFromCredentials` strips them so the vault only receives its own shape. Without them revocation is honestly `discarded_revocation_unsupported`.
- **Files modified:** `packages/cli/src/run/credentials.ts`, `packages/cli/src/commands/teardown-support.ts`
- **Commit:** 0b0dd01

**2. [Rule 3 - Blocking] `CliDeps` seams: `confirm`, `teardown`**
- The `[y/N]` prompt needed an injectable seam (commands must not read `process.stdin`), and the fault-injection and loopback-AS tests needed `teardown.decorateSteps` and `teardown.allowInsecureRequests`. All optional; `createRealDeps` sets only `confirm` (stderr prompt via the existing `askLine`).
- **Files modified:** `packages/cli/src/deps.ts`, `packages/cli/src/real-deps.ts`
- **Commit:** 0b0dd01

**3. [Rule 1 - Test expectation vs. Phase-5 behavior] "no revocation endpoint" does not reach `cleaned_up`**
- Phase 5 (`progress.ts`) does not count `discarded_revocation_unsupported` as a success outcome and treats `revoke_oauth` as attempted-is-terminal (D-19/D-23). The happy-path tests therefore run against a loopback RFC 7009 endpoint (plain http, enabled only through the test seam); the no-endpoint case is asserted as `cleanup_incomplete`/exit 7 with the honest outcome. See Known Limitations.

**4. [Rule 3 - Blocking] Extra files:** `test/helpers/teardown-rig.ts`, and `commands/teardown-support.ts` (the plan suggested factoring shared wiring "if factored").

### Notes within plan intent

- The barrel already exported `createJsonReceiptStore`, `createTerminalHostAdapter` and `buildProgram` (added by 06-02/03/04), so Task 3 reduced to types plus the pinning test.
- Exit code for a declined prompt is 3 (`consentDeclined`); the plan only said "non-destructive exit".

## Known Limitations

- **A delegated lease whose AS has no revocation endpoint can never reach `cleaned_up`.** `revoke_oauth` records `discarded_revocation_unsupported`, which the Phase-5 gate does not treat as success, and it is never re-attempted, so `cleanup` retries end at `cleanup_incomplete` (7) again. This is Phase-5 semantics, not a CLI bug, but it affects Phase 7's example (its mock AS must expose a revocation endpoint) and is worth a decision if `cleaned_up` should be reachable for AS's that cannot revoke.
- **`revoke`/`cleanup` need the credentials file to revoke upstream.** The vault is per-process, so a lease's tokens are only revocable if the user re-supplies them (Open Q5). One authorization server per credentials file.
- **Lock contention across a held approval** (Pitfall 5) surfaces as `LeaseBusyError` (exit 8); not re-driven here (T-06-22 accepted).
- **Real-terminal `[y/N]`** is not exercised in tests (seam only); batched to end-of-phase UAT.
- Leases created before 06-06 have no stored manifest; `revoke` and `cleanup` exit 5 for them (a `cleaned_up` lease needs no manifest and no-ops with 0).

## Known Stubs

None. The 06-04 `revokeCommand`/`cleanupCommand` stubs are replaced.

## Threat Flags

None beyond the plan's register. T-06-23 (real vault, honest receipts, tested for `revoked`/`discarded_revocation_unsupported`/`failed`), T-06-24 (succeeded steps not re-run, lease never `active`, tested), T-06-25 (revoke actor `user`, illegal states refused, tested) and T-06-26 (no secrets in lease/receipts/output, tested) are mitigated.

## Self-Check: PASSED

All created files exist; commits `0b0dd01`, `3ce0ee4` and `87e6e5e` are present in `git log`.
