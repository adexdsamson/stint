---
phase: 06-cli-reference-adapters
plan: 06
subsystem: cli
tags: [mcp, stdio, run, terminal-adapter, approvals, controlling-terminal, run-profile]

requires:
  - phase: 06-cli-reference-adapters
    provides: "JSON stores (06-01, 06-02), terminal HostAdapter (06-03), CliDeps/program/create/inspect/credentials (06-04)"
  - phase: 04-proxy-enforcement
    provides: "createLeaseProxyServer, createApprovalDispatcher, createVaultExecuteStage, createCredentialVault, createCapEnforcer"
  - phase: 05-lease-endings-teardown
    provides: "runUserConfirmVerification, appendTransitionReceipt"
provides:
  - "runLease({transport, adapter, ...}): resumeLease hash re-check, real ProxyDeps from existing seams, server.connect(injected Transport)"
  - "stint run <leaseId> --profile --credentials: StdioServerTransport + controlling-terminal adapter; stderr-only human output"
  - "loadRunProfile/parseRunProfile: non-secret catalog + bindings + public-client OAuth identity"
  - "openControllingTerminal: /dev/tty or CONIN$/CONOUT$; undefined when none, so the adapter denies"
  - "saveEnvelope/loadStoredManifest: signed envelope persisted at leases/<id>/envelope.json and re-verified against the trust store"
  - "CliDeps.run seams (openTerminal, createTransport) for in-process tests"
affects: [06-07, 07-example]

actuals:
  tokens: 21000
  tasks: 3
  commits: 2
plan_head_before: dd722164ef072a6b56754cc57718d860a4b3de05
commits: 2

tech-stack:
  added: []
  patterns:
    - "runLease takes the Transport as a parameter; the CLI passes StdioServerTransport, tests pass an InMemoryTransport half"
    - "Run path never writes process.stdout; even --json failures are reported on stderr by runCommand itself"
    - "No terminal => non-TTY input => adapter rejects => core denies (deny-by-default)"

key-files:
  created:
    - packages/cli/src/run/run-lease.ts
    - packages/cli/src/run/profile.ts
    - packages/cli/src/run/terminal.ts
    - packages/cli/src/store/envelope.ts
    - packages/cli/test/helpers/run-fixture.ts
    - packages/cli/test/run-approvals.test.ts
    - packages/cli/test/run-profile-terminal.test.ts
    - packages/cli/test/run-stdio-smoke.test.ts
  modified:
    - packages/cli/src/commands/run.ts
    - packages/cli/src/commands/create.ts
    - packages/cli/src/deps.ts
    - packages/cli/test/program.test.ts

key-decisions:
  - "Topology (user checkpoint): controlling-terminal. stint run stays a plain MCP server; approvals prompt on /dev/tty or CONIN$/CONOUT$; no terminal denies. No `-- <cmd>` spawn form."
  - "create now persists the parsed signed envelope beside the lease, and run/revoke/cleanup re-verify it against the trust store. A Lease holds only the bound hash, so run had no other source for scopes, limits and approvals."
  - "teardownSteps is deliberately not wired in run: an honest step set needs the cleanup-hook config and license custody, and createDefaultTeardownSteps without them would receipt happy-path placeholders. A mid-run revocation leaves the lease tearing_down and `stint cleanup` finishes it."
  - "The run profile supports only auth_method none (public client): a confidential-client secret cannot live in a non-secret profile."

patterns-established:
  - "run-fixture: real lease via stint create on a temp store, profile + credentials files, fake downstream fetch, faked-TTY terminal adapter"

requirements-completed: [HOST-02]
requirements-partial: [CLI-01]  # create/inspect/run done; revoke/cleanup (06-07) remain

coverage:
  - id: R1
    description: "During a live run, a per-call approval prompts on the terminal adapter: y approves (call executes, allowed receipt), n denies (denied: user_denied, no downstream call, denied receipt), unanswered denies as denied: timeout after approvals.timeout_seconds"
    requirement: HOST-02
    verification:
      - kind: integration
        ref: "packages/cli/test/run-approvals.test.ts#stint run: per-call approval through the terminal adapter (SC#2)"
        status: pass
    human_judgment: false
  - id: R2
    description: "No TTY: every approval denies immediately without blocking (60s window, 10s test cap)"
    requirement: HOST-02
    verification:
      - kind: integration
        ref: "packages/cli/test/run-approvals.test.ts#with no TTY every approval denies immediately"
        status: pass
    human_judgment: false
  - id: R3
    description: "user_confirm through runUserConfirmVerification with the terminal adapter over faked TTY: y completes the lease; n and timeout never do; tools/list gains no agent-facing tool"
    requirement: HOST-02
    verification:
      - kind: integration
        ref: "packages/cli/test/run-approvals.test.ts#stint run: user_confirm outcome verification through the terminal adapter"
        status: pass
    human_judgment: false
  - id: R4
    description: "Built dist/bin.js served over StdioClientTransport: clean handshake and tools/list (no protocol errors), approval-gated call denied, no token in the agent response or child stderr"
    requirement: CLI-01
    verification:
      - kind: integration
        ref: "packages/cli/test/run-stdio-smoke.test.ts"
        status: pass
    human_judgment: false
  - id: R5
    description: "run command: in-process over an injected transport it serves, denies with no terminal, exits 0 on disconnect and writes nothing to stdout; --profile required (2, stderr even under --json), unknown lease 4, delegated without --credentials 2, tampered envelope 5, hash mismatch fails the lease with a transition receipt (9), inactive lease 9"
    requirement: CLI-01
    verification:
      - kind: integration
        ref: "packages/cli/test/run-approvals.test.ts#stint run command (in-process, injected transport)"
        status: pass
    human_judgment: false
  - id: R6
    description: "Run profile parsing rejects malformed shapes with a fixed message; openControllingTerminal returns undefined when the console cannot be opened and targets CONIN$/CONOUT$ r+ on Windows"
    requirement: CLI-01
    verification:
      - kind: unit
        ref: "packages/cli/test/run-profile-terminal.test.ts"
        status: pass
    human_judgment: false
  - id: R7
    description: "Real Windows terminal: per-call approval prompt with visible countdown, deny by default on no answer (A1)"
    requirement: HOST-02
    verification:
      - kind: manual
        ref: "end-of-phase UAT (batched, not run here)"
        status: pending
    human_judgment: true
  - id: R8
    description: "A lease-scoped command contending for a lease whose lock is held across an approval wait surfaces LeaseBusyError (exit 8)"
    requirement: CLI-01
    verification:
      - kind: backstop
        ref: "LeaseBusyError/EXIT_CODES.leaseBusy covered by atomic-file.test.ts and json-lease-store.test.ts (06-01); not re-driven across a held approval here"
        status: pass
    human_judgment: false

duration: 50min
completed: 2026-09-30
status: complete
---

# Phase 6 Plan 06: stint run and the SC#2 proof Summary

**`stint run <leaseId>` serves a lease as an MCP proxy over stdio by composing existing proxy seams behind an injectable Transport, with per-call approval, timeout-deny, no-TTY deny and user_confirm proven under a real MCP client, and stdout kept protocol-clean.**

## Accomplishments

- Checkpoint resolved by the user: `controlling-terminal` (not `spawn-child`).
- `runLease`: loads the lease (must be `active`), re-verifies the bound hash via `resumeLease` (a mismatch saves the failed lease, appends a transition receipt, exits 9), seeds an in-memory vault from `--credentials`, builds `ProxyDeps` from `createVaultExecuteStage(vault, createRestOutboundConnector())`, `createApprovalDispatcher(adapter, manifest.approvals.timeout_seconds, clock)` and `createCapEnforcer()`, flattens `manifest.scopes` into the granted arrays (Phase-4 cross-product inherited, not fixed, Open Q8), then `createLeaseProxyServer(deps)` and `server.connect(transport)`. It contains no policy or enforcement logic.
- `runCommand`: validates the id, requires `--profile` (and `--credentials` for delegated leases), opens the controlling terminal (or none), builds the terminal adapter and serves until the transport closes (also on stdin end for stdio). All human output goes to stderr; `runCommand` catches its own errors so `main`'s `--json` handler never prints to stdout.
- `openControllingTerminal`: `/dev/tty` (separate r and w fds) on POSIX, `\\.\CONIN$`/`\\.\CONOUT$` with `r+` on Windows, `undefined` when either cannot be opened or is not a TTY.
- `loadRunProfile`: hand-validated non-secret JSON into `ToolCatalog`, `BindingSet` and a public-client `OAuthClient` (no new dependency).
- Tests: 30 new tests across 3 files. Scoped `packages/cli` suite: 18 files, 205 tests pass with `--pool=threads`; `tsc -p . --noEmit`, eslint over `packages/cli/src` and the new tests, and prettier are clean; `tsdown` builds.

## Task Commits

1. **Task 1: transport topology checkpoint** - decision `controlling-terminal`, no commit
2. **Task 2: runLease, profile, terminal, run command** - `8819dc0` (feat)
3. **Task 3: run tests and stdio smoke** - `b7aab3c` (test)

## Deviations from Plan

**1. [Rule 2 - Missing critical] `create` persists the signed envelope; `store/envelope.ts` added**
- **Found during:** Task 2 design
- **Issue:** the plan has `run` "load the lease, resumeLease re-verifies the bound manifest hash", but a `Lease` holds only `boundHash`. Nothing stored the manifest, so `run` had no source for scopes, limits, approvals or auth mode (RESEARCH's architecture diagram shows `leases/<id>/envelope.json`, but 06-04 did not write it).
- **Fix:** `create` writes the parsed envelope to `leases/<id>/envelope.json` after activation; `loadStoredManifest` re-parses and re-verifies it against the trust store on every run (never trusted on its own).
- **Files modified:** `packages/cli/src/commands/create.ts`, `packages/cli/src/store/envelope.ts`
- **Commit:** 8819dc0
- **Impact on 06-07:** `revoke`/`cleanup` need the same manifest (auth mode, cleanup hook) and can call `loadStoredManifest`. Leases created before this change have no envelope and `run` reports "The lease has no stored manifest." (exit 5).

**2. [Rule 3 - Blocking] `CliDeps.run` seams (`openTerminal`, `createTransport`)**
- `runCommand` could otherwise only be exercised by spawning the binary. The optional seams let the command run in-process over `InMemoryTransport` with no real stdin/stdout. Production leaves them unset. `program.ts` is untouched.

**3. [Rule 3 - Blocking] Extra files: `test/helpers/run-fixture.ts`, `test/run-profile-terminal.test.ts`**
- Shared rig for both run test files, and unit coverage for the profile parser and terminal opener (not in the plan's file list).

**4. [Rule 1 - Test brittleness] `program.test.ts` no longer uses the `run` stub**
- Two tests used `stint run` as the "Not implemented" example and failed as soon as `run` was real. They now assert `main`'s CliError formatting through `inspect` (unknown lease, exit 4), so `revoke`/`cleanup` landing in 06-07 will not break them.

### Notes within plan intent

- The plan signature `runLease({ ..., deps, profile, credentials, clock })` became `{ leaseId, root, transport, adapter, deps, verified, profile, credentials, outboundFetch }`; the clock comes from `deps.clock`, and the trust-verified manifest is passed in.
- The plan's `oauth` profile field is required; `auth_method` accepts only `none`.

## Known Limitations

- **REST connector treats `binding.resource` as a URL.** Manifest resources are identifiers (`sheets.orders`, schema `Identifier`), and `createRestOutboundConnector` does `fetch(binding.resource)`. With a real fetch a live downstream call would fail on an invalid URL. Tests inject a fake fetch. Mapping identifier to endpoint is a Phase 7 example concern (run profile or connector) and is outside "no new proxy logic".
- **Mid-run revocation does not auto-run teardown** (`teardownSteps` not wired, see key-decisions); the lease stays `tearing_down` until `stint cleanup`.
- **Windows console opening is unverified here (A1).** Covered only by unit tests with injected `openSync`; the real countdown and deny-on-no-answer check is batched to end-of-phase UAT.
- **Smoke test reason is not asserted.** The spawned child may have no terminal (deny with no TTY) or a hidden console that nobody answers (deny by `timeout` after 1s); the test asserts `denied:` either way. On a POSIX dev machine with a controlling tty, a prompt could briefly appear before the 1s timeout.
- Confidential OAuth clients are not expressible in the profile (no secret allowed in it); this only matters once vault refresh against a real AS is exercised.
- No profile flag for `--trust`: `run` uses `<store>/trust.json` (program.ts is frozen).
- Lock contention across a held approval (Pitfall 5) is the accepted, documented behavior (T-06-22); not re-driven in a test here.

## Known Stubs

None in this plan. `revokeCommand` and `cleanupCommand` remain intentional stubs for 06-07.

## Threat Flags

None beyond the plan's register. T-06-19 (no-TTY and timeout deny, tested), T-06-20 (no stdout writes on the run path, smoke handshake clean), T-06-21 (existing vault execute stage; the access token is asserted absent from the agent response and child stderr) are mitigated. T-06-22 accepted.

## Self-Check: PASSED

All created files exist; commits `8819dc0` and `b7aab3c` are present in `git log`.
