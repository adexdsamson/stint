---
phase: 06-cli-reference-adapters
plan: 04
subsystem: cli
tags: [commander, jose, ed25519, trust-store, consent, create, inspect, bin]

requires:
  - phase: 06-cli-reference-adapters
    provides: "JSON LeaseStore/ReceiptStore, EXIT_CODES/CliError/paths (06-01, 06-02), terminal HostAdapter and sanitize/style (06-03)"
  - phase: 02-lease-core
    provides: "reduce, userEvents/clockEvents, activateLease, awaitConsentDecision"
  - phase: 01-spec
    provides: "parseEnvelope, verifyEnvelope, TrustStore, resolveAuthMode"
provides:
  - "buildProgram(deps)/main(argv, deps): commander@15 program with all seven commands registered and frozen; main returns the exit code, never calls process.exit"
  - "bin.ts shebang entry built by tsdown as dist/bin.js and registered as package.json bin.stint"
  - "stint create: verify against the trust store before consent, core-owned consent timeout, active/declined persisted"
  - "stint inspect: read-only state/limits/counters/teardown view, --json emits the Lease"
  - "loadOrCreateRuntimeKey / loadCheckpointPublicKey (jose Ed25519, JWK on disk), loadTrustStore (fails closed), loadCredentials + seedVaultFromCredentials"
  - "CliDeps injection surface (io, clock, style, stores, adapter, keys, trust, credentials) and an in-process test harness"
affects: [06-05, 06-06, 06-07, 07-example]

actuals:
  tokens: 17200
  tasks: 3
  commits: 3
plan_head_before: ca1dceb0d51e2a52d3fd5608a351e0a052a17ba2
commits: 3

tech-stack:
  added: []
  patterns:
    - "buildProgram(deps, sink): actions write their exit code to an injected ExitSink; only bin.ts touches process.exitCode"
    - "CliError thrown by commands; main() is the single place that formats it (plain on stderr, {error,code} on stdout under --json)"
    - "command stubs are typed consts (deps, id, opts) => Promise<number>, so later plans replace only their own body"

key-files:
  created:
    - packages/cli/src/program.ts
    - packages/cli/src/bin.ts
    - packages/cli/src/deps.ts
    - packages/cli/src/real-deps.ts
    - packages/cli/src/commands/create.ts
    - packages/cli/src/commands/inspect.ts
    - packages/cli/src/commands/run.ts
    - packages/cli/src/commands/revoke.ts
    - packages/cli/src/commands/cleanup.ts
    - packages/cli/src/commands/receipts.ts
    - packages/cli/src/commands/verify.ts
    - packages/cli/src/keys/runtime-key.ts
    - packages/cli/src/trust/trust-store.ts
    - packages/cli/src/run/credentials.ts
    - packages/cli/test/keys-trust.test.ts
    - packages/cli/test/program.test.ts
    - packages/cli/test/create.test.ts
    - packages/cli/test/inspect.test.ts
    - packages/cli/test/helpers/cli-harness.ts
  modified:
    - packages/cli/src/index.ts
    - packages/cli/tsdown.config.ts
    - packages/cli/package.json

key-decisions:
  - "Exit code travels through an injected ExitSink instead of process.exitCode inside actions: an in-process test that sets process.exitCode = 3 would make the whole vitest run exit non-zero."
  - "Failures are thrown CliErrors formatted once in main(); under --json the {error,code} payload goes to stdout (single parseable stream), otherwise stderr."
  - "Verification failures print only a member of the fixed SPEC_ERROR_CODES vocabulary (e.g. unknown_publisher, invalid_signature), never jose or ajv text."
  - "Hosted and hybrid (mode omitted defaults to hybrid) manifests are refused BEFORE consent with a fixed message (A8: live license issuance is Phase 7)."
  - "The runtime key is created after verification succeeds, so a rejected manifest leaves no artifacts in the store."
  - "Timeout outcome uses clockEvents.consentTimedOut (actor clock) and an explicit decline uses userEvents.consentDeclined (actor user), keeping actor attribution honest."

patterns-established:
  - "adapterFactory(io, { json, approvalTimeoutSeconds }): the human prompt goes to stderr under --json so stdout stays machine-readable"
  - "Test harness: temp store + captured io + scripted HostAdapter + signManifestForTest; no child processes"

requirements-completed: [HOST-02]
requirements-partial: [CLI-01]  # create/inspect half; revoke/cleanup (06-06) and receipts (06-07) remain

coverage:
  - id: D1
    description: "buildProgram registers exactly seven commands; --help/--version resolve to exit 0; unknown command, missing arg, unknown option exit 2; global --store/--json reach subcommands"
    requirement: CLI-01
    verification:
      - kind: unit
        ref: "packages/cli/test/program.test.ts"
        status: pass
    human_judgment: false
  - id: D2
    description: "create: y grants and saves an ACTIVE lease bound to the manifest hash (exit 0, id on stdout); decline, timeout and a throwing adapter all leave it declined (exit 3)"
    requirement: HOST-02
    verification:
      - kind: unit
        ref: "packages/cli/test/create.test.ts#stint create"
        status: pass
    human_judgment: false
  - id: D3
    description: "Tampered, unparseable, unsigned, oversized, invalid-UTF-8, untrusted-publisher and unknown-kid manifests exit 5 before consent with fixed messages and no key created; hosted/hybrid refused"
    requirement: CLI-01
    verification:
      - kind: unit
        ref: "packages/cli/test/create.test.ts#stint create"
        status: pass
    human_judgment: false
  - id: D4
    description: "inspect prints state/limits/counters (exit 0), unknown id exits 4, unsafe id exits 2, --json emits the Lease, never mutates"
    requirement: CLI-01
    verification:
      - kind: unit
        ref: "packages/cli/test/inspect.test.ts"
        status: pass
    human_judgment: false
  - id: D5
    description: "Runtime Ed25519 key is created once and reloaded stably; trust store fails closed and strips private members; credentials parser rejects malformed files and feeds the vault"
    requirement: CLI-01
    verification:
      - kind: unit
        ref: "packages/cli/test/keys-trust.test.ts"
        status: pass
    human_judgment: false
  - id: D6
    description: "Built dist/bin.js carries the shebang and runs (--help exit 0, missing manifest exit 2, unknown lease --json exit 4)"
    requirement: CLI-01
    verification:
      - kind: manual
        ref: "node packages/cli/dist/bin.js smoke run during execution"
        status: pass
    human_judgment: false

duration: 45min
completed: 2026-09-30
status: complete
---

# Phase 6 Plan 04: CLI command surface, create and inspect Summary

**commander@15 program factory with all seven commands frozen in place, a shebang `bin`, and working `stint create` (verify before consent, deny-by-default, core-owned timeout) and `stint inspect`, backed by a jose Ed25519 runtime key, a fail-closed trust store and a shared credentials parser.**

## Accomplishments

- Task 1: `loadOrCreateRuntimeKey` (jose `generateKeyPair("EdDSA", Ed25519)`, private JWK at `keys/runtime-ed25519.json` chmod 0600 best-effort, public JWK beside it, RFC 7638 thumbprint as `kid`), `loadCheckpointPublicKey`, `loadTrustStore` (absent or empty file gives an empty store, malformed entries and stray `d` members are dropped) and `loadCredentials`/`seedVaultFromCredentials` (fixed `CliError(usage)` messages, secrets only reach the in-memory vault).
- Task 2: `buildProgram`/`main` with `.exitOverride()` and injected `configureOutput`, `CliDeps`, `createRealDeps` for `bin.ts`, five typed command stubs, tsdown entry `["./src/index.ts", "./src/bin.ts"]` and `bin.stint`. `dist/bin.js` starts with `#!/usr/bin/env node` and runs.
- Task 3: `createCommand` and `inspectCommand`, with 16 create tests and 6 inspect tests over an in-process harness.
- Scoped verification: the whole `packages/cli` suite passes (13 files, 156 tests) under `--pool=threads`; `tsc -p . --noEmit`, eslint (strictTypeChecked) over all of `packages/cli/src` plus the new tests, and prettier are clean; `tsdown` builds.

## Task Commits

1. **Task 1: runtime key, trust store, credentials parser** - `0269927` (feat)
2. **Task 2: program factory, bin, seven-command registration** - `f572c37` (feat)
3. **Task 3: stint create and stint inspect** - `e6a406e` (feat)

## Deviations from Plan

### Auto-fixed / design adjustments

**1. [Rule 1 - Bug prevention] Exit code via injected `ExitSink`, not `process.exitCode` in actions**
- **Found during:** Task 2 design
- **Issue:** the plan has each action do `process.exitCode = await ...` and `main` return `process.exitCode ?? 0`. In an in-process test run that leaks a non-zero `process.exitCode` into the vitest process and fails the whole run.
- **Fix:** `buildProgram(deps, sink = { code: 0 })`; actions write `sink.code`, `main` returns it, and only `bin.ts` sets `process.exitCode`. `buildProgram(deps)` is still callable with one argument.
- **Commit:** f572c37

**2. [Rule 3 - Blocking] `create.ts` and `inspect.ts` shipped as stubs in the Task 2 commit**
- **Issue:** `program.ts` imports both, so the Task 2 commit could not build without them. They were typed stubs in Task 2 and replaced in Task 3.

**3. [Rule 2 - Missing critical] Added `--trust <file>` on `create`, `style` on `CliDeps`, `test/helpers/cli-harness.ts`**
- `--trust` is required by the plan's own `loadTrustStore(root, opts)` contract but was missing from the registration list. `deps.style(json)` lets inspect (and later commands) colour output without reaching for `process.*`. The harness is shared by every later command test.

### Notes within plan intent

- `receipts` does not re-declare `--json`; the global `--json` already applies (a local duplicate would shadow the global).
- Stubs are `export const xCommand: (deps, leaseId, opts) => Promise<number> = () => Promise.reject(...)` rather than functions, to satisfy `no-unused-vars` without disabling lint; later plans may switch them to `export function`.
- `--json` errors print `{error,code}` on stdout (one parseable stream); plain errors go to stderr.
- `CLI_VERSION` in `program.ts` is a constant kept in step with `package.json` (`0.0.0`).

## Known Limitations

- `inspect` shows the duration limit and counters only. Per-action limits (`max_actions`, spend, rate) live in the signed manifest the lease is bound to by hash, not in the lease record, so they are not shown. Surfacing them needs the manifest at inspect time (candidate for a later plan or the run profile).
- `create` does not append transition receipts for `proposed -> granted -> active`; the receipt timeline (06-07) will start at the first call/teardown entry unless a later plan adds them.
- First-`create` key generation is not cross-process locked: two simultaneous first-ever `create` runs could each generate a key and the last write wins.
- `loadCredentials` only checks shape and that `tokenEndpoint` parses as a URL; it does not require https (loopback mock AS is needed for tests).
- Real-terminal consent prompting is covered by 06-03's manual UAT, not re-tested here (tests script the adapter).

## Known Stubs

Intentional interface stubs, each replaced by a later plan without touching `program.ts`:

| File | Function | Resolved by |
|------|----------|-------------|
| `packages/cli/src/commands/run.ts` | `runCommand` | 06-05 |
| `packages/cli/src/commands/revoke.ts` | `revokeCommand` | 06-06 |
| `packages/cli/src/commands/cleanup.ts` | `cleanupCommand` | 06-06 |
| `packages/cli/src/commands/receipts.ts` | `receiptsCommand` | 06-07 |
| `packages/cli/src/commands/verify.ts` | `verifyCommand` | 06-07 |

## Threat Flags

None beyond the plan's register. T-06-12 (manifest verified against the trust store before consent), T-06-13 (0600 key file, key bytes never printed, tested), T-06-14 (core-owned timeout, every non-grant declines) and T-06-15 (fixed messages, no jose/verify text or stack, tested) are mitigated.

## Self-Check: PASSED

All created files exist; commits `0269927`, `f572c37` and `e6a406e` are present in `git log`.
