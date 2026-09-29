# Phase 6: CLI & Reference Adapters - Research

**Researched:** 2026-09-29
**Domain:** Node/TypeScript CLI (commander) + Windows-safe JSON file persistence (write-file-atomic + proper-lockfile) + terminal HostAdapter + MCP stdio run wiring
**Confidence:** HIGH on the Windows file-atomicity findings (empirically reproduced on Windows 11 in this session), HIGH on existing repo surfaces (files read this session), MEDIUM on the `stint run` terminal topology (Windows console access not exercisable from this sandbox), MEDIUM-LOW on the several design gaps CONTEXT.md does not address (see Open Questions).

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**CLI command surface & the `run` boundary (CLI-01)**
- **D-01:** Phase 6 **ships a live `stint run <leaseId>`** that boots `createLeaseProxyServer` over MCP **stdio** with the reference terminal `HostAdapter` wired in. It is exercised **in-phase** by an in-process / mock MCP agent client that sends `tools/call`, so per-call approval, `user_confirm`, and timeout-deny are genuinely tested here — not only in Phase 7. Phase 7 then plugs in the real payment-reconciler agent. — **Reversibility:** costly — the run wiring (transport choice + adapter integration) is the SC#2 proof surface; other commands and tests depend on it.
- **D-02:** **Credentials for a run come from the existing Phase 4 vault seed seam**, seeded from a local file/fixture. Interactive OAuth grant acquisition against a real AS stays **deferred to Phase 7**. Phase 6 adds no new OAuth acquisition flow.
- **D-03:** **Command set:** `create`, `run`, `inspect`, `revoke`, `cleanup`, `receipts` (+ chain verification, see D-08). Lease-scoped commands take a **positional `<leaseId>`** (`stint inspect <leaseId>`, etc.). `stint create <manifest-path>` takes a **positional manifest path**, reads + verifies the manifest, renders consent, and prints the new lease id. Standard `commander` positional-arg shape.

**Consent & prompt UX (HOST-02)**
- **D-04:** `stint create` renders a **human-readable sectioned consent summary** from the manifest: agent/publisher/version, scopes, limits (actions/hr, spend), approvals-required list, auth mode, outcome verifier, cleanup hook. It then prompts **`Grant this lease? [y/N]`** defaulting to **No** (deny-by-default) — Enter or anything but `y`/`yes` declines.
- **D-05:** Per-call **approval** and **`user_confirm`** prompts show the binding-redacted summary (approval) or verbatim verifier prompt (`user_confirm`) plus a **visible remaining-time countdown**. No answer before core's `AbortSignal` fires → **core** resolves deny/reject (timeout). **Non-interactive stdin** (piped/CI, `!isTTY`) never blocks — it returns control immediately so core's deny-by-default rule applies. The adapter **only ever proposes**; core's `awaitApprovalDecision` / `awaitOutcomeConfirmDecision` / `awaitConsentDecision` own the timeout→deny outcome (Phase 2 D-17). An adapter that hangs, errors, or sees no TTY can never become an approve/grant/confirm.

**Receipts timeline & verification (CLI-02)**
- **D-06:** `stint receipts <leaseId>` default output is **one plain-language line per entry** from `mergeTimeline`, chronological, each tagged **`[verified]`** or **`[attested]`**, showing the action/transition and binding-redacted summary — never raw args or secrets (RCPT-01 / secretless-by-type).
- **D-07:** A **`--json` flag** emits the structured `TimelineEntry[]` (from `mergeTimeline`) for scripting and tests. `--json` output is always uncolored.
- **D-08:** Chain **verification is explicit**, not run on every print: a distinct verification command/flag (e.g. `stint verify <leaseId>` or `stint receipts <leaseId> --verify`; exact spelling is Claude's discretion) runs `verifyChain` on both the verified and attested chains. Clean → success message + entry count. Break → **non-zero exit** and a human message naming the exact **`brokenAtSeq`** and a plain reason mapped from the `verifyChain` `reason` enum (`hash_mismatch` / `reordered` / `truncated` / `checkpoint_sig_invalid`). — **Reversibility:** reversible — output wording is local; the exact-locus + non-zero-exit contract is fixed by the SC.

**JSON-file LeaseStore location & layout (HOST-03)**
- **D-09:** **Store root defaults to `~/.stint`** (`os.homedir()`, cross-platform), **overridable** by a global `--store <dir>` flag and/or a `STINT_HOME` env var. Persists across working directories (leases are long-lived).
- **D-10:** **One JSON file per lease** (e.g. `leases/<id>.json`) and **separate receipt-chain file(s) per lease**; **`write-file-atomic@^7.0.1`** for every write (temp-file + atomic rename, NTFS-safe); **`proper-lockfile@4.1.2`** scoped **per-file** so different leases never contend, honoring the contract's "same id serialized, different ids concurrent" guarantee. — **Reversibility:** costly — the on-disk layout + lock granularity is what the Windows concurrency test and the shared contract suite validate; changing it later reshapes both the store and its tests.
- **D-11:** The JSON `LeaseStore` **must pass the existing shared `LeaseStore` contract-test factory** (Phase 2 `@stint/core/testing`) unmodified, **plus** a **concurrent read/write test that hammers a single lease's `transaction()` on Windows CI** proving no lost updates and no torn files. Same discipline for the receipt store persistence.

**CLI destructive-action semantics**
- **D-12:** **`stint cleanup <leaseId>` is one command that auto-detects:** if the lease has not begun teardown it runs `runTeardown`; if it is in `cleanup_incomplete` it **resumes** via `retryTeardown` (idempotent, never re-runs completed steps, never returns to `active` — Phase 5 D-15/D-17/D-23). It prints the resulting state (`cleaned_up` / `cleanup_incomplete`) and points the user to `receipts`/`verify` for the signed per-step trail. Confirms with `[y/N]` before running, skippable with `--yes`.
- **D-13:** **`stint revoke <leaseId>`** prompts `[y/N]` (skippable `--yes`), drives a **user-actor revoke** that **auto-chains teardown** (Phase 5 D-18), then prints the resulting terminal/teardown state and directs the user to `receipts`/`verify`. Actor is `user`.

**CLI exit codes, errors & output styling**
- **D-14:** **Exit codes:** `0` on success; **distinct non-zero codes** for the meaningful failure conditions — declined/timed-out consent, broken chain on verify, a `cleanup_incomplete` outcome, an invalid or failed-signature manifest, and lease-not-found. Human error messages go to **stderr**; under `--json`, errors emit a structured `{ error, code }` object. No secrets in error text (§14). — **Reversibility:** reversible — the code map is local, but keep it stable once published as CLI behavior.
- **D-15:** **Terminal styling via `picocolors`** (tiny, zero-dep, ESM) for consent headers, `[verified]`/`[attested]` tags, and pass/fail — **automatically degrading to plain text** when `NO_COLOR` is set or stdout is not a TTY. `--json` output is always uncolored. **NOTE:** `picocolors` is **not yet in CLAUDE.md's stack table** — research MUST confirm the version/pin and add it to the stack, or the planner falls back to plain text only (D-15 alt). — **Reversibility:** reversible — styling is cosmetic; plain-text fallback is the safe default if the dep is rejected.

### Claude's Discretion
- Exact `commander` wiring / file layout in `@stint/cli` (command modules, `bin` shebang via `tsdown`), and the precise `--help` text.
- The exact spelling of the verification command/flag (D-08: `stint verify <id>` vs `receipts --verify`) and the exact human wording of consent, timeline, break-locus, and error messages.
- The concrete claim/field layout of per-lease JSON files and the receipt-chain file(s) on disk (D-10), provided atomic-write + per-lease-lock invariants and the contract suite hold.
- The exact exit-code integer map (D-14), provided each SC failure condition yields a distinct non-zero code.
- Whether a prompt library is used for the interactive prompts (D-04/D-05) or they are hand-rolled over `readline`, provided deny-by-default, the countdown, and non-TTY handling hold and no new heavyweight dep is pulled in without research sign-off.

### Deferred Ideas (OUT OF SCOPE)
- The `examples/payment-reconciler` real agent, hybrid-mode e2e test, and README quickstart — Phase 7 (E2E-01/02, DOC-01). Phase 6's `run` is exercised only by an in-process/mock client.
- Interactive OAuth grant acquisition against a real authorization server to seed the vault — Phase 7 (Phase 6 uses the local-fixture seed seam, D-02).
- Automatic/background retry of `cleanup_incomplete` — post-v0.1; v0.1 is explicit-retry-only (Phase 5 D-32).
- Additional `LeaseStore` backends (SQLite/Postgres/Redis) and distributed per-lease locking — v2 (STORE-V2-01/02).
- An embeddable receipt-timeline UI component — v2 (ECO-V2-03); Phase 6 ships the terminal timeline only.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| HOST-02 | CLI reference HostAdapter renders consent from the manifest and prompts approvals in the terminal, defaulting to deny on timeout | Terminal adapter pattern over `node:readline/promises` + AbortSignal (verified by experiment); adapter is constructed with `approvalTimeoutSeconds` because `ApprovalRequest` carries no deadline; no-TTY rejects so core folds to deny; consent-render field list from ALP §6; terminal-injection sanitizer; `stint run` stdout/stdin-are-the-protocol constraint (Pitfall 4) |
| HOST-03 | Platform builder can implement a `LeaseStore`; JSON-file default uses atomic writes and locking that pass a concurrent read/write test on Windows | Empirically reproduced: plain `write-file-atomic@7.0.1` rename fails with EPERM on Windows under concurrent readers (26-37 of 50 writes per writer lost); bounded EPERM/EBUSY/EACCES retry fixes it (200/200, 0 torn reads); per-id in-process queue + `proper-lockfile` for cross-process; `onCompromised` handler mandatory; test structure in Validation Architecture |
| CLI-01 | User can create a lease from a manifest (with consent), inspect a lease, revoke it and run/retry cleanup | commander@15 command-surface pattern verified by experiment; create/run/inspect/revoke/cleanup flows mapped onto existing `reduce`/`activateLease`/`resumeLease`/`runTeardown`/`retryTeardown`; state-to-action table for `cleanup`; gaps (run profile, trust store, checkpoint key, credentials on revoke/cleanup) documented |
| CLI-02 | User can print a lease's receipts as a merged plain-language timeline and verify chain integrity | `mergeTimeline` / `verifyChain` / `verifyAttestedChain` signatures read; 5-value reason enum (CONTEXT lists 4); checkpoint-anchored verify needed to catch tail tampering; break-locus semantics documented |
</phase_requirements>

## Summary

Phase 6 is I/O glue plus two outside-core plug-in implementations, and almost every piece of *logic* it needs already exists and was read in this session: `reduce`, `activateLease`/`resumeLease`, `mergeTimeline`, `verifyChain`/`verifyAttestedChain`, `runTeardown`/`retryTeardown`, `createLeaseProxyServer`, `createApprovalDispatcher`, `createVaultExecuteStage`, `createDefaultTeardownSteps`, and the shared contract-test factories in `@stint/core/testing`. The genuinely new engineering risk is concentrated in one place, the Windows file store, and this research reproduced that risk directly: on Windows 11, `write-file-atomic@7.0.1` (which uses plain `fs`, not `graceful-fs`, and does a single un-retried `fs.rename`) fails with `EPERM` for roughly 40-70% of writes while another process is reading the same file, and readers themselves can occasionally see `EPERM` during a rename. `proper-lockfile` alone does not help because readers do not take the lock (and cannot, see Pitfall 2). The fix, verified 200/200 with zero torn reads across two hammer configurations, is a bounded retry on `EPERM`/`EBUSY`/`EACCES` around the atomic write and around reads, plus a per-id in-process promise queue in front of `proper-lockfile` (a second in-process `lock()` on the same file returns `ELOCKED`, verified).

Five design gaps that CONTEXT.md does not address will block a planner who does not see them, and they are the most important non-library findings: (1) `stint run` over stdio makes the process's own stdin/stdout the MCP protocol channel, so the terminal adapter cannot read answers from `process.stdin` or print to `process.stdout`; it needs a separate controlling-terminal handle or the agent must be spawned as a child; (2) `createLeaseProxyServer` needs a runtime-owned tool catalog + binding set + OAuth client config that nothing in the repo supplies to a CLI (a "run profile"); (3) `revoke`/`cleanup` run in a different process from `run`, but the credential vault is in-memory, so without re-seeding credentials `revoke_oauth` would either receipt a false `revoked` (the placeholder step) or `not_applicable`; (4) checkpoint signing needs a persistent runtime Ed25519 key and `verify` needs its public half plus a publisher trust store; (5) `dispatch.ts` holds the per-lease transaction (and therefore the file lock) across the whole approval wait, so a second terminal's `stint revoke` will contend for the lock for up to `approvals.timeout_seconds`.

**Primary recommendation:** Build `@stint/cli` as a testable `buildProgram(deps)` factory over commander@15 with injected IO/clock/store, implement `createJsonLeaseStore`/`createJsonReceiptStore` on a dir-per-lease layout using a shared `atomic-file` helper (per-id queue + `proper-lockfile` with `onCompromised` + EPERM/EBUSY/EACCES retry on write and read), hand-roll the terminal adapter on `node:readline/promises`, pin `picocolors@1.1.1` but construct it with `createColors(explicitDecision)` (its default does NOT degrade on non-TTY under `win32` or `CI`), and resolve the five gaps above in the plan's first wave.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Consent render + y/N prompt | CLI (terminal HostAdapter) | Core (`awaitConsentDecision` owns timeout→decline) | Adapter renders and proposes only; deny-by-default is core's (host-adapter.ts:168-210) |
| Per-call approval / user_confirm prompt + countdown | CLI (terminal HostAdapter) | Proxy (`createApprovalDispatcher` arms the real timer) | Proxy arms the AbortController; adapter only displays remaining time |
| Lease persistence + per-lease serialization | CLI package (JSON LeaseStore) | Core (contract + contract-test factory) | Outside-core implementation of a core-defined contract (HOST-03) |
| Receipt persistence (append-only) | CLI package (JSON ReceiptStore) | Core (`verifyChain` recomputes on load) | Store never computes/trusts hashes (receipt-store.ts:13-27) |
| Lease state transitions | Core (`reduce`) | CLI (drives events only) | CLI adds no decision logic |
| Teardown execution | Proxy (`runTeardown`/`retryTeardown`) | CLI (chooses which, prints result) | Orchestrator owns ordering, idempotency, receipts |
| Timeline render / chain verify | Core (`mergeTimeline`/`verifyChain`) | CLI (renders text, maps to exit code) | Thin renderer over data that already exists |
| MCP agent-facing server | Proxy (`createLeaseProxyServer`) | CLI (chooses transport, boots) | No new proxy logic (D-01) |
| Exit codes, stderr/JSON errors | CLI | — | CLI-only concern (D-14) |
| Runtime signing key + trust store custody | CLI (disk) | Core (injected, "never read from disk inside core") | checkpoint.ts:47-49 requires the key be injected |

## Standard Stack

### Core (additions to `packages/cli/package.json`)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `commander` | `15.0.0` (exact, per CLAUDE.md) | CLI framework | Pinned in CLAUDE.md; ESM-only, engines `>=22.12.0`; verified `exitOverride`, `configureOutput`, `optsWithGlobals()`, positional args behave as needed (experiment below) |
| `write-file-atomic` | `^7.0.1` (per CLAUDE.md; NOT 8.x) | Atomic temp-file + rename writes | Resolved 7.0.1, engines `^20.17.0 \|\| >=22.9.0`, deps `signal-exit@^4`. **Uses plain `fs` and one un-retried `rename`** (read from tarball) so it MUST be wrapped in a retry on Windows |
| `proper-lockfile` | `4.1.2` (exact) | Cross-process per-file mutex (mkdir-based) | Pinned in CLAUDE.md; deps `graceful-fs`, `retry`, `signal-exit@^3`; no engines field, no postinstall |
| `picocolors` | `1.1.1` (exact) | Terminal colors | Already in `pnpm-lock.yaml` transitively (line 1389 `picocolors@1.1.1`); zero deps; **but** default color detection does not degrade on non-TTY under win32/CI, see Pitfall 6 |
| `@modelcontextprotocol/sdk` | `1.30.1` (exact, same as proxy) | `StdioServerTransport` for `stint run`; `Server` type | Currently only a dependency of `@stint/proxy`; CLI must declare its own |
| `jose` | `6.2.12` (exact, same as core/proxy) | Generate/import/export the runtime Ed25519 checkpoint key and import the public key for `verify` | Already repo-standard; no hand-rolled crypto |
| `@stint/spec` | `workspace:*` | `verifyEnvelope`, `parseEnvelope`, `resolveAuthMode`, `TrustStore`, `Manifest` types | CLI currently declares only core + proxy |

### Supporting (devDependencies of `packages/cli`)
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `@types/write-file-atomic` | `4.0.3` | Types (export = writeFile) | Required; write-file-atomic ships no types. Verified: `import writeFileAtomic from "write-file-atomic"` typechecks under repo's TS 5.9.3 / NodeNext / verbatimModuleSyntax |
| `@types/proper-lockfile` | `4.1.4` | Types (`LockOptions` incl. `onCompromised`, `lockfilePath`) | Required. Verified default import typechecks |
| `@stint/spec/testing`, `@stint/core/testing`, `@stint/proxy/testing` | workspace | `signManifestForTest`, in-memory stores, `createEchoExecuteStage`, contract-test factories | Tests only |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| `picocolors@1.1.1` | `node:util` `styleText` (added v22.12.0 per Node 22 docs; on Node 26.8.2 piped stdout it degrades to plain text, verified locally) | Zero new dependency and no CLAUDE.md change. Not chosen because D-15 locks picocolors; behavior on the 22.18.0 floor was not verified [ASSUMED]. Cheap swap if the user prefers no new dep |
| Hand-rolled readline prompts | `@inquirer/prompts`, `prompts`, `enquirer` | All are heavier, own the TTY/raw-mode (interferes with a core-owned `AbortSignal` countdown), and are unnecessary for two line-based `[y/N]` prompts. Rejected per "no new heavyweight dep without sign-off" |
| `proper-lockfile` | hand-rolled `fs.mkdir` lock | CLAUDE.md prefers `proper-lockfile`; it provides staleness + heartbeat. Keep |
| Whole-file atomic rewrite for receipts | JSONL `appendFile` | JSONL append can tear on crash/concurrent append and a torn tail is indistinguishable from tampering. Whole-file atomic rewrite under lock is O(n) but chains are small in v0.1 and it reuses one proven write path |

**Installation** (run as `npx --yes pnpm@12.6.0 --filter @stint/cli add ...` per project memory; corepack is broken in the sandbox):
```bash
npx --yes pnpm@12.6.0 --filter @stint/cli add commander@15.0.0 "write-file-atomic@^7.0.1" proper-lockfile@4.1.2 picocolors@1.1.1 @modelcontextprotocol/sdk@1.30.1 jose@6.2.12 "@stint/spec@workspace:*"
npx --yes pnpm@12.6.0 --filter @stint/cli add -D @types/write-file-atomic@4.0.3 @types/proper-lockfile@4.1.4
```
Also align `packages/cli/package.json` `engines.node` from `>=22.12.0` to `>=22.18.0` (every other package uses 22.18; `engineStrict: true`).

**Line to add to CLAUDE.md "Supporting Libraries" table:**
`| picocolors | 1.1.1 (exact) | Terminal color for @stint/cli output (consent headers, [verified]/[attested] tags, pass/fail) | Zero-dependency single file, already in the lockfile transitively. Construct with createColors(enabled) using an explicit decision (NO_COLOR, stdout.isTTY, --json); its built-in detection forces color on under win32 and CI even when stdout is piped. |`

**Version verification (npm registry, this session):** `write-file-atomic@7.0.1` (latest is 8.0.0, deliberately not used), `proper-lockfile@4.1.2`, `picocolors@1.1.1` (dist-tag latest), `commander@15.0.0`, `@types/write-file-atomic@4.0.3`, `@types/proper-lockfile@4.1.4`. Tags below are `[VERIFIED: gsd-tools package-legitimacy check + npm view]`.

## Package Legitimacy Audit

| Package | Registry | Age | Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----|-----------|-------------|---------|-------------|
| write-file-atomic | npm | years (npm org) | ~117.8M/wk | github.com/npm/write-file-atomic | OK | Approved (in CLAUDE.md stack) |
| proper-lockfile | npm | 2021 last publish | ~33.1M/wk | github.com/moxystudio/node-proper-lockfile | OK | Approved (in CLAUDE.md stack) |
| picocolors | npm | 2021 created | ~276.1M/wk | github.com/alexeyraspopov/picocolors | OK | Approved (needs CLAUDE.md line, above) |
| commander | npm | years | ~594.9M/wk | github.com/tj/commander.js | OK | Approved (in CLAUDE.md stack) |
| @types/write-file-atomic | npm (DefinitelyTyped) | years | ~348K/wk | DefinitelyTyped | OK | Approved |
| @types/proper-lockfile | npm (DefinitelyTyped) | years | ~1.38M/wk | DefinitelyTyped | OK | Approved |

`gsd-tools query package-legitimacy check --ecosystem npm ...` returned `OK` for all six, `postinstall: null` for the four runtime packages. `@modelcontextprotocol/sdk`, `jose`, `@stint/*` are already repo dependencies.

**Packages removed due to [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none

## Architecture Patterns

### System Architecture Diagram

```
                        +---------------------- ~/.stint (or --store / STINT_HOME) ----------------------+
                        |  leases/<id>/lease.json      (LeaseStore)     keys/runtime-ed25519(.pub).json    |
                        |  leases/<id>/envelope.json   (signed manifest)  trust.json                       |
                        |  leases/<id>/receipts/{verified,attested}.json + checkpoint-*.json               |
                        +----------------------^--------------------------^-------------------------------+
                                               | atomic write + per-file lock      | lock-free reads (retry EPERM)
 argv --> commander program --> command module -+----------------------------------+
   |        (exitOverride,        create : parse+verifyEnvelope -> ConsentRequest -> awaitConsentDecision(adapter)
   |         optsWithGlobals)                   -> reduce(consent_granted) -> activateLease -> save + receipts
   |                              run    : load+resumeLease(re-verify hash) -> build ProxyDeps -> createLeaseProxyServer
   |                                        -> server.connect(Transport)   [StdioServerTransport | InMemoryTransport(test)]
   |                              inspect: load -> render (no lock)
   |                              revoke : confirm -> transaction(reduce(userEvents.revoke)) -> runTeardown
   |                              cleanup: state switch -> runTeardown | retryTeardown(user)
   |                              receipts/verify: receiptStore.load x2 -> mergeTimeline | verifyChain(+checkpoint,+pubkey)
   v
 CliError{code,exit} / CommanderError --> top-level maps to exit code; stderr text (or {error,code} under --json)

 Agent (MCP client) --tools/call--> Server (proxy) --evaluatePolicy--> require_approval
      --> createApprovalDispatcher --arms AbortController(timeout_seconds)--> awaitApprovalDecision
      --> TerminalHostAdapter.requestApproval(request, signal)   [prompt + countdown on controlling terminal]
          y -> approve | n/blank -> deny | signal abort -> core resolves deny/timeout | no TTY -> reject -> core denies
```

### Recommended Project Structure
```
packages/cli/
├── package.json            # add bin: { "stint": "./dist/bin.js" }, deps above, engines >=22.18.0
├── tsdown.config.ts        # entry: ["./src/index.ts", "./src/bin.ts"]
├── vitest.config.ts        # NEW: test.testTimeout 60_000 (Windows CI file IO)
├── src/
│   ├── bin.ts              # first line "#!/usr/bin/env node"; main(process.argv.slice(2)) -> process.exitCode
│   ├── index.ts            # barrel: createJsonLeaseStore, createJsonReceiptStore, createTerminalHostAdapter, buildProgram
│   ├── program.ts          # buildProgram(deps: CliDeps): Command  (all wiring, injected IO/clock/store)
│   ├── exit.ts             # EXIT_CODES map + CliError(code, safeMessage)
│   ├── paths.ts            # store root resolution, assertSafeLeaseId
│   ├── store/
│   │   ├── atomic-file.ts  # withFileLock, atomicWrite (retry), readJsonRetry, per-key queue
│   │   ├── json-lease-store.ts
│   │   └── json-receipt-store.ts   # per-lease instance (contract has no leaseId)
│   ├── keys/runtime-key.ts # load-or-create Ed25519 (jose), public JWK export
│   ├── trust/trust-store.ts
│   ├── adapter/{terminal-host-adapter,prompt,consent-view,sanitize}.ts
│   ├── render/{style,timeline,verify}.ts
│   ├── run/{run-lease,profile}.ts   # runLease({transport,...}) — transport injected
│   └── commands/{create,run,inspect,revoke,cleanup,receipts,verify}.ts
└── test/  (+ fixtures/hammer-worker.mjs)
```

### Pattern 1: Windows-safe JSON file store (the HOST-03 core)
**What:** dir-per-lease layout; every mutation is `[in-process per-key queue] -> proper-lockfile lock on lease.json -> read -> mutate -> atomicWrite(retry) -> unlock`. `load`/`list` are **lock-free** reads with retry.
**Why lock-free reads (not optional):** `dispatch.ts` calls `deps.leaseStore.load(deps.leaseId)` *inside* the per-lease `transaction()` (dispatch.ts:306). If `load` took the same lock it would deadlock.
**Example (experiment-verified core; adapt to TS + eslint strictTypeChecked):**
```typescript
// Source: experiment worker2.mjs run on Windows 11 (200/200, 0 torn reads) + write-file-atomic/lib/index.js + proper-lockfile/lib/lockfile.js read this session
import lockfile from "proper-lockfile";
import writeFileAtomic from "write-file-atomic";

const TRANSIENT = new Set(["EPERM", "EBUSY", "EACCES"]); // same set graceful-fs retries on win32 (graceful-fs/polyfills.js:96-105)
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function withTransientRetry<T>(op: () => Promise<T>, maxAttempts = 50): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await op();
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === undefined || !TRANSIENT.has(code) || attempt + 1 >= maxAttempts) throw e;
      await sleep(Math.min(5 * 2 ** Math.min(attempt, 5), 100) * (0.5 + Math.random())); // jittered, <= ~4s worst case
    }
  }
}

export const atomicWriteJson = (file: string, value: unknown) =>
  withTransientRetry(() => writeFileAtomic(file, JSON.stringify(value), { fsync: true }));
  // write-file-atomic unlinks its temp file in `finally`, so retrying the whole call is safe.

export async function withFileLock<T>(file: string, work: () => Promise<T>): Promise<T> {
  let compromised: Error | undefined;
  const release = await lockfile.lock(file, {
    realpath: false,                 // lock target may not exist yet (first save)
    stale: 10_000,                   // heartbeat (utimes) every stale/2 keeps a live holder fresh through long approval waits
    retries: { retries: 300, factor: 1.2, minTimeout: 10, maxTimeout: 100, randomize: true },
    onCompromised: (e) => { compromised = e; }, // DEFAULT THROWS from a timer callback => process crash
  });
  try {
    const result = await work();
    if (compromised !== undefined) throw compromised; // never commit after losing the lock
    return result;
  } finally {
    await release().catch(() => undefined);
  }
}
```
In `transaction(id, mutate)`: chain onto a `Map<id, Promise>` tail (same idiom as `createInMemoryLeaseStore.runSerialized`, testing.ts:51-61) and take the file lock inside the queued task. **Check `compromised` after `mutate` resolves and BEFORE the write** (move the check inside `work` between mutate and `atomicWriteJson`), so a lost lock never produces a stale overwrite.

### Pattern 2: commander@15 program factory with injected IO
**What:** `buildProgram(deps)` returns a `Command`; actions never call `process.exit`; a top-level `main(argv, deps)` returns an integer exit code.
```typescript
// Source: experiment cmd.mjs run against commander@15.0.0 (all six outcomes below observed)
const program = new Command().name("stint")
  .option("--store <dir>", "store root (default ~/.stint or $STINT_HOME)")
  .option("--json", "machine-readable output")
  .exitOverride()                                   // CommanderError instead of process.exit; inherited by .command()
  .configureOutput({ writeOut: deps.io.out, writeErr: deps.io.err });
program.command("inspect").argument("<leaseId>").action(async (leaseId, _opts, cmd) => {
  const { store, json } = cmd.optsWithGlobals(); /* ... */
});
try { await program.parseAsync(argv, { from: "user" }); return 0; }
catch (e) { return e instanceof CommanderError ? mapCommander(e) : mapCliError(e); }
```
Observed (commander 15.0.0): missing arg → `code: commander.missingArgument, exitCode 1`; extra arg → `commander.excessArguments` (excess args are an error by default); unknown command → `commander.unknownCommand`; unknown option → `commander.unknownOption`; `--help` → `commander.helpDisplayed, exitCode 0` (map to 0!); errors thrown from async actions propagate through `parseAsync`; global options work both before and after the subcommand. Map every commander usage error to one dedicated "usage" exit code (2), and `helpDisplayed`/`version` to 0.

### Pattern 3: readline-based prompt honoring a core-owned AbortSignal
```typescript
// Source: experiment rl.mjs (Node 26.8.2): answered->"y"; abort mid-wait->AbortError; pre-aborted->AbortError; input EOF->question NEVER settles
import { createInterface } from "node:readline/promises";
async function askLine(input, output, prompt, signal): Promise<string | undefined> {
  const rl = createInterface({ input, output, terminal: output.isTTY === true });
  const closed = new Promise<undefined>((res) => rl.once("close", () => res(undefined))); // EOF guard: question() hangs forever on EOF
  try { return await Promise.race([rl.question(prompt, { signal }), closed]); }
  catch { return undefined; }          // AbortError => no answer => caller proposes deny; CORE decides the outcome
  finally { rl.close(); }
}
```
Countdown: only when `output.isTTY`; a 1s `setInterval` that does `readline.cursorTo(out,0); readline.clearLine(out,0); rl.setPrompt(newPrompt); rl.prompt(true)` (`preserveCursor: true` keeps typed characters); cleared in `finally` and on `signal` abort. The adapter cannot read a deadline from `AbortSignal` or `ApprovalRequest` (host-adapter.ts:45-49 has only `approvalId`, `summary`, `binding`), so **construct the adapter with `approvalTimeoutSeconds` (from `manifest.approvals.timeout_seconds`) and start the countdown when `requestApproval` is entered** (a few ms behind the proxy's timer; the abort ends the UI regardless). This needs no change to the published `HostAdapter` contract (additive-only rule).
**Non-TTY:** if `input.isTTY !== true` (or no controlling terminal can be opened) make `requestApproval` / `requestOutcomeConfirmation` / `requestConsent` **reject** with a `NoTerminalError` and print one stderr line. `awaitApprovalDecision` folds a rejection into `{decision:"deny", reason:"timeout"}` (host-adapter.ts:151-164), keeping the non-answer outcome single-sourced in core, and an adapter error can never become an approve. Tests fake a TTY with `Object.assign(new PassThrough(), { isTTY: true })` and `terminal:false`.

### Pattern 4: `stint run` = injectable Transport
`runLease({ leaseId, transport, adapter, ... })` builds `ProxyDeps`, calls `createLeaseProxyServer(deps)` and `await server.connect(transport)`. The CLI passes `new StdioServerTransport()` (constructor is `(stdin?: Readable, stdout?: Writable, options?)`, verified in `dist/esm/server/stdio.d.ts`); tests pass one half of `InMemoryTransport.createLinkedPair()` and connect a real `Client` to the other half exactly as `packages/proxy/test/server-tracer.test.ts` does (Client + `InMemoryTransport` from `@modelcontextprotocol/sdk/inMemory.js`). One additional smoke test spawns the built `dist/bin.js run ...` through `StdioClientTransport` to prove stdout is protocol-clean and stdio wiring works (there the terminal adapter has no TTY and per-call approval must deny).

### Pattern 5: `cleanup` state switch (D-12), grounded in the transition table
| Lease state on entry | Action |
|----------------------|--------|
| `completed`, `expired`, `revoked`, `failed` | `runTeardown` (auto-chains `begin_teardown`, orchestrate.ts:246-262) |
| `tearing_down` (crash mid-teardown) | `runTeardown` (resume; it assumes `tearing_down` when not terminal-end) |
| `cleanup_incomplete` | `retryTeardown(deps, "user", now)` (orchestrate.ts:272-282) |
| `cleaned_up` | no-op success message |
| `proposed`, `declined`, `granted`, `active` | refuse with a "lease has not ended; use revoke" error and its own exit code. (`granted`/`active` can be ended only via `revoke` etc.; `runTeardown` on them would throw an illegal-transition) |
`revoke`: `transaction(id, l => reduce(l, userEvents.revoke(), now))` (legal from `granted` and `active` only: transitions.ts:93 `"active:revoke": { actors: ["user"], to: "revoked" }`), append the transition receipt via `appendTransitionReceipt`, then `runTeardown`. Use the exported helper pattern from `orchestrate.ts` (`appendTransitionReceipt`, index.ts:116) so receipts match.

### Anti-Patterns to Avoid
- **Locking inside `load()`/`list()`** — deadlocks against `dispatch.ts:306`; also unnecessary because writes are atomic renames.
- **Using `createDefaultTeardownSteps(receiptStore, key)` with no `vault`** in production CLI paths — the omitted-`vault` `revoke_oauth` is a happy-path placeholder returning `"revoked"` (steps.ts `happyPathStep("revoke_oauth", "revoked")`), i.e. a false receipt. Always pass a real vault (and `cleanup` config; the placeholder `cleanup_hook` returns `"attested_ok"`).
- **`console.log` anywhere on the `run` path** — stdout is the MCP channel; a stray byte corrupts the protocol. Route all human output to stderr / the controlling terminal for `run`.
- **`process.exit()` in actions** — bypasses stdout/stderr flush and `proper-lockfile`/`signal-exit` cleanup; set `process.exitCode`.
- **Printing manifest-derived strings raw** — see Pitfall 7.
- **Trusting picocolors' default detection** — see Pitfall 6.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Atomic file replace | temp+rename by hand | `write-file-atomic` wrapped in a transient-error retry | It also serializes same-file writers in-process, fsyncs, cleans temp files on exit/error |
| Cross-process mutual exclusion | custom lock files | `proper-lockfile` with `onCompromised` | Staleness detection + mtime heartbeat + exit cleanup already handled |
| Arg parsing / help / usage errors | manual `process.argv` | `commander@15` | Verified error codes and inheritance |
| Timeout→deny semantics | any adapter-side deny timer | `awaitApprovalDecision` / `awaitConsentDecision` / `awaitOutcomeConfirmDecision` (core) | The adapter must never own the outcome (host-adapter.ts:1-24) |
| Chain integrity / break locus | own hashing or JSON compare | `verifyChain` / `verifyAttestedChain` | Recomputes via the single JCS serializer; distinguishes reordered/hash_mismatch/truncated |
| Timeline ordering/tagging | own sort | `mergeTimeline` | Stable ts→origin→seq ordering, display-only |
| Crypto (keys, signatures) | anything custom | `jose` (`generateKeyPair`, `exportJWK`, `importJWK`) | Project constraint: no hand-rolled crypto |
| Terminal ANSI stripping | regex of your own for VT sequences | `util.stripVTControlCharacters` + a control-char filter | Built in; see Pitfall 7 |
| Color | manual escape codes | `picocolors.createColors(enabled)` | D-15 |

**Key insight:** this phase's correctness is almost entirely "call the existing function with real I/O behind it and do not add a decision." The only place a naive implementation silently loses data is the Windows rename, which no library in the pinned stack handles for you.

## Common Pitfalls

### Pitfall 1: `write-file-atomic` rename fails with EPERM on Windows under concurrent readers
**What goes wrong:** Reproduced. 4 writer processes x 50 lock-guarded read-modify-write cycles plus 2 reader processes on Windows 11 (Node 26.8.2): writers succeeded 19/15/13/24 of 50 (final `version: 71` of an expected 200); every failure was `write:EPERM`. With 1 writer + 1 reader: 58/100 succeeded. With **no** readers: 200/200 (~4.7s). Adding the bounded retry above: 200/200 with 0 torn reads in both a 4-writer/2-reader and an 8-writer/4-reader configuration (max 14 attempts on any one write). In the 8/4 run one **reader** also hit `EPERM` once, so reads need the retry too.
**Why it happens:** `write-file-atomic@7.0.1` `lib/index.js` uses `require('fs')` (not `graceful-fs`) and calls `fs.rename(tmpfile, truename)` once with no retry. NTFS refuses a replace-rename while another handle to the destination is open without delete-sharing. The mechanism is empirical here (the exact handle share mode was not root-caused) [ASSUMED mechanism, VERIFIED symptom].
**How to avoid:** `withTransientRetry` on the write and on `readFile`; the same error set (`EACCES`/`EPERM`/`EBUSY`) `graceful-fs` retries on win32 for up to 60s (graceful-fs@4.2.11 `polyfills.js:96-105`).
**Warning signs:** intermittent `EPERM: operation not permitted, rename '...lease.json.<n>' -> '...lease.json'`; lost updates only on the Windows CI leg.

### Pitfall 2: `proper-lockfile` is not re-entrant and cannot protect lock-free readers
**What goes wrong:** Two in-process `lock()` calls on the same file: the second returns `ELOCKED` immediately (verified). 50 simultaneous `transaction()` calls in one process would burn the whole retry budget contending with themselves.
**How to avoid:** per-id in-process promise queue (in front of the file lock) so at most one in-process holder ever calls `lock()` per id; the file lock then only arbitrates across processes. Measured: 50 queued transactions with fsync on = ~630 ms on this machine.

### Pitfall 3: default `onCompromised` throws from a timer
**What goes wrong:** proper-lockfile's default is `(err) => { throw err; }` invoked from the heartbeat timer callback, crashing the process, possibly mid-write.
**How to avoid:** always pass a handler that records the error; check it after `mutate` and before the write (Pattern 1). `stale` has a hard floor of 2000 ms and the heartbeat is `min(update, stale/2)` with a 1000 ms floor (lockfile.js `lock()` normalization).

### Pitfall 4: `stint run` owns the terminal's stdin/stdout as the MCP channel
**What goes wrong:** With `StdioServerTransport` the process's stdin is the JSON-RPC stream and stdout carries responses. A terminal adapter reading `process.stdin` for `y/N` would consume protocol bytes; `!isTTY` on stdin is also exactly the case when an agent host spawns `stint run`, so D-05's "non-TTY returns immediately" would deny **every** approval in the real topology.
**How to avoid (needs a decision, see Open Question 1):** either (A) open a controlling-terminal handle separately (`/dev/tty` on POSIX; on Windows `fs.openSync("\\\\.\\CONIN$", "r+")` passed to `new tty.ReadStream(fd)`, with `r+` required per the Node TTY docs [CITED: nodejs.org/api/tty.html, `readStream.setRawMode` note]) and fall back to no-terminal=deny; or (B) make `stint run <leaseId> -- <agent command...>` the parent that spawns the agent and gives the child's stdio to `new StdioServerTransport(child.stdout, child.stdin)`, which leaves the real terminal free. Windows console opening was NOT exercised here (no console attached to this sandbox) [ASSUMED]; include a human-verify checkpoint.

### Pitfall 5: an approval wait holds the lease's transaction, therefore its file lock
**What goes wrong:** `handleCall` awaits `deps.approve.requestApproval(...)` inside `runInLeaseTransaction` (dispatch.ts:253-284). With the JSON store the lock is held for up to `approvals.timeout_seconds`, so `stint revoke <id>` from a second terminal waits on the lock, and after its retry budget fails.
**How to avoid:** heartbeat already prevents staleness (holder is alive); give lock acquisition a configurable total budget (`lock.timeoutMs`, default ~30s) and surface exhaustion as a typed `LeaseBusyError` -> its own exit code with a clear message ("a call is awaiting approval; answer or wait for the timeout, then retry"). Do not change dispatch.ts (Phase 4 contract). Record in the plan as a known UX limit.

### Pitfall 6: picocolors does not degrade on non-TTY under win32 or CI
**What goes wrong:** `picocolors.js` computes `isColorSupported = !(NO_COLOR || --no-color) && (FORCE_COLOR || --color || platform==='win32' || (stdout.isTTY && TERM!=='dumb') || CI)`. Verified locally on Windows with piped stdout: `pc.red("x")` returned `"\u001b[31mx\u001b[39m"` and `isColorSupported === true`; `NO_COLOR=1` does disable it. So D-15's "degrades when stdout is not a TTY" is false on Windows and in CI (the exact environments this phase's tests run in) and would make golden-text assertions and `--json` consumers flaky.
**How to avoid:** `const pc = createColors(!json && !("NO_COLOR" in env) && stdout.isTTY === true)` centrally in `render/style.ts`; never import the default export elsewhere. `--json` always plain.

### Pitfall 7: terminal injection through manifest text
**What goes wrong:** `agent.name`, `agent.description`, `job.description`, verifier `prompt` and receipt summaries are free text (only identifiers have the safe charset, ALP §4/§14). An ESC sequence or `\r` in them can overwrite the consent screen. ALP §14 only requires restricting identifier charsets, so this is a CLI responsibility.
**How to avoid:** one `sanitizeForTerminal()` applied to every manifest- or receipt-derived string before printing: `stripVTControlCharacters`, then replace remaining C0/C1 controls (incl. `\r`, `\b`, `\u001b`, `\u009b`) and bidi override characters; collapse newlines to spaces in single-line contexts. Test with a manifest containing `\u001b[2J` and `\r`.

### Pitfall 8: tail tampering is invisible without the checkpoint; break locus is the link, not the edited entry
**What goes wrong:** `verifyChain(chain)` with no checkpoint cannot detect mutation of the LAST entry (nothing after it holds its hash), and reports a mid-chain edit at the **next** entry's `seq` (`hash_mismatch`). `verifyChain` also only reports `truncated`/boundary `hash_mismatch` when given the checkpoint and public key (chain.ts:239-259).
**How to avoid:** `verify` must load the stored checkpoint for each chain and pass `(chain, checkpoint, publicKey)` whenever a checkpoint exists. Write SC#3's tamper test from `verifyChain`'s semantics: mutate entry N's payload -> expect `brokenAtSeq === N+1`, `reason: "hash_mismatch"`; mutate the final entry -> only detected with checkpoint, at `checkpoint.count - 1`.

### Pitfall 9: `RECEIPT_VERIFY_REASONS` has five values, CONTEXT lists four
**Quote (packages/core/src/receipts/errors.ts:21-27):** `"hash_mismatch", "reordered", "truncated", "checkpoint_sig_invalid", "claim_sig_invalid"`. The fifth (`claim_sig_invalid`) comes from `verifyAttestedChain`. Type the CLI's message table as `Record<ReceiptVerifyReason, string>` so a future enum change fails at compile time.

### Pitfall 10: `ReceiptStore` contract has no lease id
`ReceiptStore` is `append/load/readCheckpoint/writeCheckpoint` keyed only by chain (receipt-store.ts:37-58). The JSON implementation must be constructed **per lease** (`createJsonReceiptStore({ root, leaseId })`), one instance per lease in `ProxyDeps`/`TeardownDeps`. Lock order is always lease-lock then receipt-lock (receipts are appended inside the lease transaction in `dispatch.ts` `finally`), never the reverse.

## Code Examples

### Existing signatures the CLI consumes (read this session; quoted verbatim where they are discrete values)

`HostAdapter` (packages/core/src/host-adapter.ts:103-118):
```typescript
export interface HostAdapter {
  requestConsent(request: ConsentRequest, signal: AbortSignal): Promise<ConsentDecision>;
  requestApproval(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision>;
  requestOutcomeConfirmation(request: OutcomeConfirmRequest, signal: AbortSignal): Promise<OutcomeConfirmDecision>;
  notify(event: LifecycleEvent): Promise<void>;
}
```
NOTE: this is **four** methods (the "three-method" wording in CONTEXT/ROADMAP predates `requestOutcomeConfirmation`). Decisions (host-adapter.ts:36-38, 52-54, 72-74):
`{ decision: "grant" } | { decision: "decline"; reason: "user_declined" | "timeout" }`, `{ decision: "approve" } | { decision: "deny"; reason: "user_denied" | "timeout" }`, `{ decision: "confirm" } | { decision: "reject"; reason: "user_rejected" | "timeout" }`. `ConsentRequest = { consentId: string; manifest: VerifiedManifest }`; `ApprovalRequest = { approvalId: string; summary: string; binding: ConnectorBinding }`; `OutcomeConfirmRequest = { leaseId: string; prompt: string }`. `LifecycleEvent` members (host-adapter.ts:83-91): `activated`, `completed`, `expired`, `revoked`, `failed`, `tearing_down`, `cleaned_up`, `cleanup_incomplete`, each `{ type, leaseId, at }`.

`LeaseStore` (lease-store.ts:40-61): `load(id): Promise<Lease | undefined>; save(lease): Promise<void>; list(): Promise<readonly Lease[]>; delete(id): Promise<void>; transaction(id, mutate: LeaseMutator): Promise<Lease>` where `LeaseMutator = (lease: Lease) => Lease | Promise<Lease>` and `transaction` "Rejects if `id` does not exist".

`ReceiptStore` (receipt-store.ts:37-58): `append(chain, entry)`, `load(chain): Promise<readonly ReceiptEntry[]>`, `readCheckpoint(chain): Promise<Checkpoint | undefined>`, `writeCheckpoint(checkpoint)`; `ReceiptChain = "verified" | "attested"` (spec generated receipt.ts).

Contract-test factories (packages/core/src/testing.ts:135 and :257): `createLeaseStoreContractTests(makeStore: () => LeaseStore): void` and `createReceiptStoreContractTests(makeStore: () => ReceiptStore): void`. `makeStore` is a **synchronous** factory called once per `it`, so create a fresh `mkdtempSync` dir per call and remove them in `afterAll`. The suite includes `50 concurrent transaction() calls on one id produce no lost updates` and an absent-id rejection. Import path `@stint/core/testing` (core `exports["./testing"]`). Built output is required (`pnpm test` = `pnpm build && vitest run`, root package.json).

`mergeTimeline(verified: readonly ReceiptEntry[], attested: readonly ReceiptEntry[]): readonly TimelineEntry[]` with `TimelineEntry = { origin: "verified" | "attested"; entry: ReceiptEntry }` (merge.ts:26-32, 57-67).

`verifyChain(chain, checkpoint?, checkpointPublicKey?): Promise<Result<{ headHash: string; count: number }>>` failing with `{ ok:false, errors:[{ brokenAtSeq, reason }] }` (chain.ts:196-200); `verifyAttestedChain(chain, trustStore, checkpoint?, checkpointPublicKey?)` (attested.ts, same result shape, adds `claim_sig_invalid`).

Teardown (orchestrate.ts:76-91, 246, 272): `TeardownDeps = { leaseStore, receiptStore, leaseId, steps, notify?, signingKey? }`; `runTeardown(deps, now): Promise<Lease>`; `retryTeardown(deps, actor: "user" | "runtime", now): Promise<Lease>`. Steps: `createDefaultTeardownSteps(receiptStore, signingKey, vault?, license?, cleanup?)` (steps.ts). Pass `signingKey` in `TeardownDeps` too so the D-31 bracketing checkpoint is written.

Proxy (server.ts:46-61): `ProxyDeps = { leaseId, leaseStore, receiptStore, catalog, bindings, grantedScopes, grantedResources, limits, approvals, clock, execute, approve, enforceCaps, teardownSteps? }`. Production seams: `createVaultExecuteStage(vault, createRestOutboundConnector())`, `createApprovalDispatcher(adapter, manifest.approvals.timeout_seconds, clock)`, `createCapEnforcer()`, `createCredentialVault(oauthClient, clock)`.

Vault seed seam (oauth-client.ts:30-39): `SeededCredential = { accessToken, refreshToken, expiry (absolute epoch seconds), tokenEndpoint, resourceIndicator }`, seeded with `vault.seedCredential(leaseId, resource, seeded)`. `OAuthClient = { as: oauth.AuthorizationServer; client: oauth.Client; clientAuth: oauth.ClientAuth }`.

Lease states (packages/core/src/transitions.ts:18-30, quoted): `"proposed","declined","granted","active","completed","expired","revoked","failed","tearing_down","cleaned_up","cleanup_incomplete"`. `Lease` (lease.ts:66-76): `{ id, state, version, boundHash, grantedAt, expiresAt, maxDurationSeconds, counters, teardownProgress? }`, timestamps are epoch **seconds**. A new lease starts at `state: "proposed"`, `grantedAt: 0`, `expiresAt: 0`, `boundHash` = `VerifiedManifest.contentHash`; `reduce(lease, userEvents.consentGranted(), now)` sets `expiresAt = now + maxDurationSeconds`; `activateLease(lease, verifiedManifest, now)` does `granted -> active`; `resumeLease(lease, verifiedManifest, now)` re-checks the bound hash on a run of an already-active lease.

### `bin` + tsdown wiring
`tsdown@0.21.10` preserves a source shebang and grants execute permission to shebang entry chunks (`ShebangPlugin`, `writeBundle`, `chmod(filepath, 493)` = 0o755; read from `tsdown/dist/watch-*.mjs`). So: `src/bin.ts` begins with `#!/usr/bin/env node`; `tsdown.config.ts` `entry: ["./src/index.ts", "./src/bin.ts"]` (keep the existing `fixedExtension: false`); `package.json` `"bin": { "stint": "./dist/bin.js" }`. tsdown also has an `exports.bin` option to auto-generate this. ESM `bin` needs no extra flags on Node >=22.18.

### Consent render (ALP §6 minimum, spec/ALP.md:229-237)
Must show: agent + publisher; every scope with resource and full access list; limits incl. spend + currency; `approvals.require_for` and `timeout_seconds`; **resolved** `auth.mode` via `resolveAuthMode(manifest)` (`manifest.auth.mode ?? "hybrid"`, validate.ts:316-318); `job.verifier` type; `cleanup.hook` + `cleanup.publisher_retains` labelled as an **attested publisher claim, not runtime-verified** (§6/§13), when `cleanup !== null`. Every manifest-derived string goes through `sanitizeForTerminal`.

### Timeline line format (suggested)
`2026-09-29T10:00:03Z [verified] call  allowed  read_message on inbox: call to "read_message" ...` / `[verified] state active -> revoked (revoke by user)` / `[verified] teardown revoke_oauth: revoked` / `[attested] publisher acme claimed usage`. Use `new Date(ts * 1000).toISOString()` (ts is epoch seconds). Under `--json` emit the `TimelineEntry[]` unchanged. An empty attested chain is the normal v0.1 case (no production path appends to it yet; verified by grep) so render verified-only without error.

## Runtime State Inventory
Not a rename/refactor/migration phase. Omitted intentionally.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `commander` exit via `process.exit` in actions | `exitOverride()` + return exit code from `main()` | commander 15 (verified) | Testable in-process; flushes streams |
| `tsup` shebang bin | `tsdown` shebang plugin (auto `chmod 755`) | tsdown 0.21.x | No custom post-build chmod script |
| `paseto@3`-style APIs | n/a here | — | Not used in this phase |

**Deprecated/outdated:** the phrase "three-method HostAdapter" in CONTEXT/ROADMAP; the current interface has four methods (see Code Examples). The proxy `dispatch.ts`-held transaction across approval waits is a Phase 4 design the CLI must live with.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Opening `\\.\CONIN$` / `/dev/tty` gives a usable controlling terminal for `stint run` prompts when stdin/stdout are the MCP pipes; not exercised in this sandbox | Pitfall 4, Pattern 3 | SC#2 prompts unusable in the real spawned-by-agent topology; fall back to topology B (spawn agent as child) |
| A2 | EPERM on rename is caused by a concurrently open read handle lacking delete-sharing (symptom verified, mechanism not root-caused); GitHub `windows-latest` behaves like local Windows 11 | Pitfall 1 | CI leg could show a different EPERM rate; the retry covers the class regardless, and the test asserts final state, not timing |
| A3 | Consent request timeout default (suggest 120 s) — ALP §6 says consent times out but the manifest has no field | Open Q, create | Arbitrary UX constant; harmless but user-visible |
| A4 | Runtime checkpoint key persisted at `<root>/keys/runtime-ed25519.json` (private JWK, 0600 on POSIX) and `<root>/keys/runtime-ed25519.pub.json`; trust store at `<root>/trust.json` (overridable `--trust`) | Open Q 3/4 | Gap in CONTEXT; user may prefer OS keychain or a flag-only model |
| A5 | "Run profile" JSON (catalog entries, bindings without `rowAdapter`, OAuth client/AS metadata) + a separate secret credentials seed file | Open Q 2/5 | Gap in CONTEXT; Phase 7 will inherit whatever shape is chosen |
| A6 | Exit-code map: 0 ok, 1 internal, 2 usage, 3 consent/confirm declined or timed out, 4 lease not found, 5 manifest invalid/signature failed, 6 chain break, 7 cleanup_incomplete, 8 lease busy, 9 wrong state for action, 10 store corrupt | D-14 | Discretion item; must stay stable once published |
| A7 | `util.styleText` behaves like on Node 26 (plain when not a TTY) on the 22.18.0 floor | Alternatives | Only matters if the user swaps picocolors out |
| A8 | Hosted/hybrid `create` defers real license issuance to Phase 7's mock publisher; Phase 6 fully supports delegated-only leases | Open Q 6 | If Phase 6 must activate hosted/hybrid leases, a `LicenseIssuer` source is needed (core's `createMockLicenseIssuer` is testing-only) |
| A9 | The CLI lazily settles expiry (`clockEvents.expire()`) for an `active` lease past `expiresAt` before `cleanup`/`inspect`/`run`; nothing in the repo applies `clockEvents.expire()` today (grep) | Pattern 5 | Without it an expired-but-unsettled lease cannot be torn down via `cleanup` |

## Open Questions

1. **How does the terminal HostAdapter get a real terminal during `stint run` (topology A vs B)?**
   - Known: stdio server uses process stdin/stdout for MCP; agent hosts spawn servers with piped stdio; Node can open `/dev/tty` / `CONIN$` (`r+`).
   - Unclear: which topology the user wants: `stint run <id>` as a server the agent host launches, or `stint run <id> -- <agent cmd>` as parent.
   - Recommendation: implement `runLease({ transport, adapter })` generically (tests unaffected), default CLI = topology A with a `openControllingTerminal()` helper (POSIX `/dev/tty`, Windows `CONIN$`/`CONOUT$`), no terminal => reject => deny; add the `--` spawn form only if the user asks. Add a human-verify checkpoint.
2. **What supplies the runtime-owned tool catalog, binding set and OAuth client for `run`?** Nothing in the repo (Phase 4 D-08/D-12 say these are runtime-owned and injected). Recommendation: a `--profile <file>` JSON (non-secret): `catalog: ToolCatalogEntry[]`, `bindings: ConnectorBinding[]` (no `rowAdapter`; a function is not JSON), `oauth: { as metadata, client_id, auth method }`. Secrets live only in `--credentials <file>` (`SeededCredential` per resource). Phase 7's example reuses the same shape.
3. **Where does the runtime Ed25519 checkpoint key live?** Needed by `createDefaultTeardownSteps`/`TeardownDeps.signingKey` and, as the public half, by `verify`. Recommendation A4 above; create on first `create`.
4. **Where does the publisher `TrustStore` come from for `create`, `run` (re-verify on resume) and attested-chain verify?** Recommendation: `<root>/trust.json` or `--trust <file>`; `create` fails with the manifest-invalid exit code when the publisher/kid is not trusted.
5. **`revoke`/`cleanup` run in a different process from `run`, so the in-memory vault is empty.** Without re-seeding, `revoke_oauth` returns `not_applicable` although a grant exists, which is a dishonest receipt. Recommendation: for manifests with `auth.delegated`, require `--credentials <file>` on `revoke`/`cleanup` (fail with a clear error if absent unless `--yes --no-revoke-credentials` style opt-out is explicitly added), seed the vault, then run teardown. Never persist secrets into the store or receipts.
6. **Hosted/hybrid `create`:** `activateLease` only does the hash guard; issuing a license is I/O (Phase 3 `LicenseIssuer`). Recommendation A8. Needs user confirmation.
7. **`user_confirm` trigger in Phase 6:** no production code calls `runUserConfirmVerification` (grep) and no agent "check done" tool exists in `tools/list`. Recommendation: fully implement and test `requestOutcomeConfirmation` on the terminal adapter through `runUserConfirmVerification` with faked TTY streams; do NOT add a new agent-facing tool (it would change the audited `tools/list`); wire the trigger in Phase 7 with the real agent.
8. **Scope cross-product (security-relevant, pre-existing):** `resolveEffectiveBinding` (dispatch.ts:197-208) checks `grantedScopes.includes(binding.access)` and `grantedResources.includes(binding.resource)` independently, so manifest scopes `[{r1:[read]},{r2:[write]}]` also permit a `write` tool bound to `r1`. The CLI must flatten `manifest.scopes` into those two arrays, inheriting this. Recommendation: flag as a Phase 4 follow-up (pair-wise check) and add a documenting test; do not silently "fix" in Phase 6.
9. **Lock contention UX (Pitfall 5)** — accept the documented behavior with a typed `LeaseBusyError`, or ask Phase 4 owners to release the transaction around approval waits (out of scope here).

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | all | yes | 26.8.2 locally (CI matrix: 22.18.0 and 24) | — |
| pnpm | install/build | via `npx --yes pnpm@12.6.0` (corepack broken in sandbox, per project memory) | 12.6.0 | — |
| Windows runner for HOST-03 test | ROADMAP research flag | yes: `.github/workflows/ci.yml` already matrixes `os: [ubuntu-latest, windows-latest]` x `node: ["22.18.0", "24"]` and runs `pnpm test` | — | none needed; no CI change required |
| npm registry access | version verification | yes | — | — |
| Windows console / TTY | verifying controlling-terminal prompts | no (sandbox has no attached console) | — | human-verify checkpoint |

**Missing dependencies with no fallback:** none blocking.
**Missing dependencies with fallback:** interactive Windows TTY check -> manual UAT.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | Vitest 5.0.2 (root `vitest.config.ts` uses `test.projects: ["packages/*"]`) |
| Config file | none for `packages/cli` today; add `packages/cli/vitest.config.ts` with `test: { testTimeout: 60_000 }` (Windows CI file IO; Vitest default is 5 s) |
| Quick run command | `npx --yes pnpm@12.6.0 --filter @stint/cli test` (scoped; whole-repo vitest/eslint OOMs in this sandbox per project memory; add `--pool=threads` if needed) |
| Full suite command | `npx --yes pnpm@12.6.0 test` (builds first; CI runs it on ubuntu+windows x Node 22.18.0/24) |
| Lint | per-file: `npx --yes pnpm@12.6.0 exec eslint packages/cli/src/<file>.ts` (strictTypeChecked; use `String(n)` in templates) |

### Phase Requirements to Test Map
| Req ID | Behavior (Success Criterion) | Test Type | Automated Command | File Exists? |
|--------|------------------------------|-----------|-------------------|-------------|
| CLI-01 / SC1 | `create` renders sectioned consent from a signed manifest, `n`/blank/timeout declines (exit 3, lease `declined`), `y` grants -> `active`, prints id | integration (in-process `main(argv, deps)` with fake TTY + temp store + `signManifestForTest`) | `vitest run packages/cli/test/create.test.ts` | no, Wave 0 |
| CLI-01 / SC1 | `inspect` prints state/limits/counters; unknown id -> exit 4 | integration | `.../inspect.test.ts` | no, Wave 0 |
| CLI-01 / SC1 | `revoke` (y / `--yes` / `n`) -> `revoked` -> auto-chained teardown -> `cleaned_up` or `cleanup_incomplete`, receipts appended, exit 0/7 | integration with fault-injected `TeardownStep` (proxy exports `TeardownStep`) | `.../revoke.test.ts` | no, Wave 0 |
| CLI-01 / SC1 | `cleanup` state switch table: terminal-end -> `runTeardown`; `cleanup_incomplete` -> `retryTeardown` resumes without re-running succeeded steps; `active` -> exit 9; `cleaned_up` -> no-op | integration | `.../cleanup.test.ts` | no, Wave 0 |
| HOST-02 / SC2 | Approval prompt shows redacted summary + countdown; `y` approves, `n` denies, `timeout_seconds:1` unanswered -> `denied: timeout` from a real MCP `tools/call`; no-TTY -> deny without blocking | integration: `InMemoryTransport.createLinkedPair()` + real `Client` + `runLease` + fake-TTY adapter (pattern: `packages/proxy/test/server-tracer.test.ts`) | `.../run-approvals.test.ts` | no, Wave 0 |
| HOST-02 / SC2 | `requestOutcomeConfirmation` prompt (verbatim verifier prompt), confirm completes, reject/timeout never completes | integration via `runUserConfirmVerification` with the terminal adapter | `.../adapter-outcome-confirm.test.ts` | no, Wave 0 |
| HOST-02 | Adapter unit: adapter can never approve on EOF/abort/no-TTY; prompt hang guarded by `rl` close; countdown cleared | unit | `.../terminal-host-adapter.test.ts` | no, Wave 0 |
| HOST-02 | `stint run` stdio smoke: spawn `dist/bin.js run` via `StdioClientTransport`; stdout stays protocol-clean; per-call approval denied w/o terminal | e2e smoke (needs build) | `.../run-stdio-smoke.test.ts` | no, Wave 0 |
| CLI-02 / SC3 | `receipts` prints one line per entry tagged `[verified]`/`[attested]`, chronological, no raw args; `--json` == `mergeTimeline` output uncolored | integration | `.../receipts.test.ts` | no, Wave 0 |
| CLI-02 / SC3 | `verify` clean -> exit 0 + count; tamper mid-chain -> exit 6, message names `brokenAtSeq = N+1` + `hash_mismatch`; tamper last entry detected via checkpoint; swap/reorder -> `reordered`; delete tail -> `truncated`; all five reasons have messages | integration on a real JSON receipt file edited on disk | `.../verify.test.ts` | no, Wave 0 |
| HOST-03 / SC4 | JSON LeaseStore passes the shared `createLeaseStoreContractTests` unmodified | contract | `.../json-lease-store-contract.test.ts` (calls `createLeaseStoreContractTests(() => createJsonLeaseStore({ root: mkdtempSync(...) }))`) | no, Wave 0 |
| HOST-03 / SC4 | JSON ReceiptStore passes `createReceiptStoreContractTests` | contract | `.../json-receipt-store-contract.test.ts` | no, Wave 0 |
| HOST-03 / SC4 | **Concurrent read/write hammer** (see below) | integration, runs on ubuntu + windows CI | `.../json-store-concurrency.test.ts` | no, Wave 0 |
| HOST-03 | `withTransientRetry` deterministic unit test with an injected op that throws EPERM x2 then succeeds; non-transient error (ENOSPC) thrown immediately; gives up after max attempts | unit (OS-independent) | `.../atomic-file.test.ts` | no, Wave 0 |
| HOST-03 | Path safety: `../x`, `a/b`, `CON`, empty, >128 chars rejected as lease ids; stale `.lock` recovered after `stale` | unit | `.../paths.test.ts` | no, Wave 0 |
| D-14 | Exit-code map: each SC failure yields a distinct code; `{error, code}` under `--json`; no secret material in any error string | unit/integration | `.../exit-codes.test.ts` | no, Wave 0 |
| D-15 | `createColors(false)` under `--json`/non-TTY/`NO_COLOR` even on win32/CI; no ANSI in `--json` | unit | `.../style.test.ts` | no, Wave 0 |
| Security | `sanitizeForTerminal` neutralizes ESC/CR/BS/bidi in manifest text | unit | `.../sanitize.test.ts` | no, Wave 0 |

**Windows-CI concurrency test structure (SC4):**
1. *In-process hammer* (fast, all OSes): one lease; 50 concurrent `transaction()` bumping `version`, plus 4 concurrent reader loops doing `load()` and `list()` in a tight loop for the duration; assert `version === 50`, every read parsed as a valid `Lease` (no torn JSON), no `*.<number>` temp files or `.lock` dirs left in the lease dir.
2. *Cross-process hammer* (the real `proper-lockfile` proof): `child_process.spawn(process.execPath, ["test/fixtures/hammer-worker.mjs", root, id, mode, n])` x 3 writers x 20 transactions + 1 reader process; the worker imports the **built** `../../dist/index.js` (root `pnpm test` builds first; Node's default type stripping cannot resolve the repo's `.js`-suffixed TS specifiers, so do not import `src/`). Assert final `version === 60`, reader reported 0 parse errors, zero non-transient errors. Assertions are on final state, never on timing, so the test is deterministic; the retry budget (not the test) absorbs the EPERM jitter. Measured on Windows 11: ~8-9 s for 8 processes x 25, hence the 60 s timeout.
3. Because the reproduction rate on Linux is nil, the OS-independent `withTransientRetry` unit test is what guards the retry logic on every OS; the hammer proves it on Windows.

### Sampling Rate
- **Per task commit:** the scoped file(s): `npx --yes pnpm@12.6.0 --filter @stint/cli exec vitest run test/<file>.test.ts`
- **Per wave merge:** `npx --yes pnpm@12.6.0 --filter @stint/cli test` (+ `--filter @stint/core --filter @stint/proxy` if their files were touched)
- **Phase gate:** full suite green on ubuntu and windows CI legs before `/gsd-verify-work`; manual UAT for the Windows controlling-terminal prompt and real-terminal countdown look.

### Wave 0 Gaps
- [ ] `packages/cli/vitest.config.ts` (testTimeout) and all test files listed above
- [ ] `packages/cli/test/fixtures/hammer-worker.mjs`, `test/helpers/{fake-tty,temp-store,signed-manifest}.ts`
- [ ] Dependencies installed (commands above) and `bin`/tsdown entry wired
- [ ] CLAUDE.md stack row for `picocolors` (text above)

## Security Domain

### Applicable ASVS Categories (security_enforcement enabled, ASVS level 1)

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no (local single-user CLI; no login) | — |
| V3 Session Management | no | — |
| V4 Access Control | yes | Deny-by-default: consent/approval/confirm default No; adapter errors/no-TTY/EOF never approve; policy stays in core |
| V5 Input Validation | yes | `assertSafeLeaseId` (path traversal, Windows reserved names) on every `<leaseId>`; `parseEnvelope` size cap + `verifyEnvelope` before any consent; shape-validate lease/receipt JSON on load (typed `StoreCorruptError`, never crash); `sanitizeForTerminal` on all manifest/receipt text |
| V6 Cryptography | yes | `jose` for the Ed25519 key and checkpoint sig; `node:crypto` only; no hand-rolled crypto; private key file 0600 on POSIX, never logged |
| V7 Error handling/logging | yes | `CliError` with fixed non-interpolated messages; unknown errors -> generic message + exit 1; never print `err.message` from oauth/http/jose (ALP §14) |
| V8 Data protection | yes | Credentials only from an explicit `--credentials` file, held in the in-memory vault, never persisted by Stint, never in receipts/errors; store dir created with restrictive mode where the OS honors it |
| V12 Files/resources | yes | Atomic writes; lock heartbeat; temp-file cleanup; bounded retry (no infinite loops) |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Path traversal via `<leaseId>` / `--store` join | Tampering / Info disclosure | Strict id regex (e.g. `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`), reject reserved device names, `path.resolve` then assert prefix under root |
| Terminal escape injection via manifest strings | Spoofing (consent screen) | `sanitizeForTerminal` (Pitfall 7) |
| Approval granted by a hung/erroring/no-TTY adapter | Elevation of privilege | Adapter rejects; core's `await*Decision` folds to deny (verified in host-adapter.ts) |
| Tampered receipt/lease file on disk | Tampering / Repudiation | `verifyChain` + signed checkpoint; lease JSON shape validation on load; atomic writes prevent torn state |
| Secrets in errors/receipts/`--json` | Info disclosure | Fixed messages; receipts secretless by type; no stack traces by default |
| Lost update / torn read under concurrency | Tampering (integrity) | Per-id queue + file lock + atomic rename + transient retry; hammer tests |
| Stale/compromised lock crashing the process | DoS | `onCompromised` handler; abort commit when lock lost |
| Credential seed file readable by other users | Info disclosure | Document; warn if POSIX mode is broader than 0600 |

## Sources

### Primary (HIGH confidence)
- Repo files read this session (paths in the Code Examples section): `packages/core/src/{host-adapter,lease-store,testing,lease,events,transitions,activate,hash-guard,index}.ts`, `packages/core/src/receipts/{merge,chain,attested,checkpoint,errors,receipt-store}.ts`, `packages/proxy/src/{server,dispatch,index,testing}.ts`, `packages/proxy/src/teardown/{orchestrate,steps}.ts`, `packages/proxy/src/approvals/approval-dispatcher.ts`, `packages/proxy/src/vault/{credential-vault,oauth-client,execute-stage}.ts`, `packages/proxy/src/concurrency/lease-serializer.ts`, `packages/proxy/src/verification/user-confirm.ts`, `packages/proxy/test/server-tracer.test.ts`, `packages/spec/src/{envelope,testing}.ts`, `packages/spec/src/generated/{manifest,receipt}.ts`, `spec/ALP.md` §6, §9, §14, `.github/workflows/ci.yml`, `packages/cli/*`, root configs.
- Tarballs read directly (`npm pack`): `write-file-atomic@7.0.1` `lib/index.js`, `proper-lockfile@4.1.2` `lib/lockfile.js`, `picocolors@1.1.1` `picocolors.js`, `commander@15.0.0`, `@types/write-file-atomic@4.0.3`, `@types/proper-lockfile@4.1.4`; `graceful-fs@4.2.11` `polyfills.js`; `@modelcontextprotocol/sdk@1.30.1` `dist/esm/server/stdio.d.ts`, `inMemory.d.ts`, `client/stdio.d.ts`; `tsdown@0.21.10` shebang plugin.
- Local experiments on Windows 11 / Node 26.8.2 (scratchpad `exp/`): two-configuration write-file-atomic + proper-lockfile hammer with and without retry; in-process double-lock `ELOCKED`; 50-tx timing; readline `question` + AbortSignal + EOF behavior; commander@15 error/exit/global-option behavior; picocolors vs `styleText` piped-stdout behavior; `tsc` typecheck of default imports.
- `gsd-tools query package-legitimacy check` (six packages, all OK).
- [nodejs.org/api/tty.html](https://nodejs.org/api/tty.html) — `CONIN$` needs `'r+'` when opened via `fs.open` for `tty.ReadStream`.

### Secondary (MEDIUM confidence)
- Web search results on reading a terminal when stdin is piped ([nodejs/node#21319](https://github.com/nodejs/node/issues/21319), [nodejs/node#47303](https://github.com/nodejs/node/issues/47303)): `/dev/tty` read-stream pattern.
- Node 22 docs page for `util.styleText` (added v22.12.0; option details truncated in the fetch).

### Tertiary (LOW confidence)
- None used as authority.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — versions, engines, deps, types verified against the registry and tarballs; legitimacy OK.
- Windows atomicity: HIGH for symptom and fix (reproduced and re-verified); MEDIUM for GitHub-runner parity (A2).
- Architecture: HIGH for reuse of existing surfaces (files read); MEDIUM for run/terminal topology (A1) and the five CONTEXT gaps (Assumptions A3-A5, A8).
- Pitfalls: HIGH (most reproduced or read from source).

**Research date:** 2026-09-29
**Valid until:** 2026-10-29 for library facts (write-file-atomic 8.x may change the recommendation only if the Node floor moves); design-gap items are valid until the user answers the Open Questions.
