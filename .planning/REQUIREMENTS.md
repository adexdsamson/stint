# Requirements: Stint

**Defined:** 2026-09-27
**Core Value:** A prompt-injected or misbehaving agent can never act outside the lease the user granted, and when the lease ends, for any reason, every credential is revoked and the teardown is honestly receipted.

## v1 Requirements

### Foundation

- [x] **FND-01**: Developer can clone the repo, run `pnpm install && pnpm test` on Windows, macOS or Linux (Node 22.12+) and get a green build of all packages
- [x] **FND-02**: CI runs typecheck, lint and tests on Linux and Windows for every push
- [x] **FND-03**: Repo is licensed Apache-2.0 with packages published under the `@stint/*` scope names (not yet to npm)

### Spec & Manifest

- [x] **SPEC-01**: Reader can learn the full protocol from `spec/ALP.md`: states, transitions, actors, auth modes, teardown order, receipts, trust model and trust limits
- [x] **SPEC-02**: Publisher can author a manifest validated against a draft-07 JSON Schema (agent, publisher, version, spec_version, job + outcome verifier, scopes, lease, limits, approvals, auth, cleanup)
- [x] **SPEC-03**: Manifest scopes accept only `read | write | send | pay`; approvals accept only `send | pay | irreversible`; verifiers accept only `resource_query | user_confirm | none`; unknown values are rejected
- [x] **SPEC-04**: `auth.delegated` accepts a list of provider grants; `auth.mode` accepts `delegated | hosted | hybrid` with `hybrid` as default
- [x] **SPEC-05**: Developer gets TypeScript types generated from the schema and a validator returning structured errors
- [x] **SPEC-06**: Manifest has a canonical content hash and a publisher signature that the runtime verifies before consent

### Lease Lifecycle

- [x] **LIFE-01**: Lease moves only through the defined states (proposed, declined, granted, active, completed, expired, revoked, failed, tearing_down, cleaned_up, cleanup_incomplete) via a table-driven pure reducer; every illegal transition is rejected and tested
- [x] **LIFE-02**: Every transition records its actor (user, verifier, policy, clock, provider, publisher, runtime); the agent can never cause a transition to end or extend a lease
- [x] **LIFE-03**: Lease binds the consented manifest hash; a manifest mismatch at activation or resume is rejected
- [x] **LIFE-04**: Lease expiry is enforced on every call against an injectable clock, not by timers
- [x] **LIFE-05**: Extending a lease requires fresh user consent through the HostAdapter; license token refresh never extends lease expiry
- [ ] **LIFE-06**: Outcome verification with `resource_query` (predicate evaluated through the proxy) or `user_confirm` completes the lease; `none` means the lease ends only on expiry or user action; the agent's own "done" claim never completes it
- [x] **LIFE-07**: Error threshold (N denied calls or upstream errors in a window) moves the lease to `failed` with actor `policy`

### Licensing

- [x] **LIC-01**: Publisher can issue a PASETO v4.public license carrying lease id, job, expiry and limits, with a 5-minute default TTL
- [x] **LIC-02**: Publisher server verifies licenses offline with the publisher public key using one shared implicit-assertion derivation and an explicit clock-skew tolerance
- [x] **LIC-03**: Runtime refreshes licenses before TTL expiry, never beyond lease expiry; the agent never holds the license
- [ ] **LIC-04**: Publisher can revoke entitlement; revocation moves the lease to `revoked` (actor `publisher`) and triggers OAuth revocation
- [ ] **LIC-05**: License is never forwarded to customer resources (tested)

### Receipts

- [x] **RCPT-01**: Every tool call, allowed or denied, appends a receipt with args hash and binding-redacted summary; raw args and secrets never appear
- [x] **RCPT-02**: Receipts are hash-chained using a single canonical serializer with a golden-hash fixture test
- [x] **RCPT-03**: Runtime signs chain checkpoints with Ed25519, including a final signed receipt at teardown
- [x] **RCPT-04**: Publisher-signed attested entries live in a separate chain; each chain verifies independently
- [x] **RCPT-05**: User can view both chains merged into one plain-language timeline, clearly marking verified vs attested
- [x] **RCPT-06**: Verifying a tampered or truncated chain (relative to its last checkpoint) reports the exact break
- [ ] **RCPT-07**: Receipts survive cleanup

### Proxy Enforcement

- [x] **PRXY-01**: Agent connects to the proxy as an MCP server and sees only tools permitted by its lease
- [x] **PRXY-02**: Every `tools/call` is decided by a pure policy function; calls with no runtime-owned connector binding are denied
- [x] **PRXY-03**: Tool-to-(resource, access, irreversible) classification comes only from runtime-owned bindings, never from the manifest (tested)
- [ ] **PRXY-04**: `actions_per_hour`, total action cap and `spend` limits are enforced per lease under concurrent calls (per-lease serialization)
- [ ] **PRXY-05**: Calls requiring approval are held until the user decides via HostAdapter; approval is bound to a hash of exact args, binding and lease version; timeout denies
- [ ] **PRXY-06**: Proxy injects OAuth access tokens (with RFC 8707 resource indicators) only on outbound calls; no token appears in any agent-facing response or error (adversarial tests)
- [ ] **PRXY-07**: Customer-side OAuth revocation detected via invalid_grant/401 moves the lease to `revoked` (actor `provider`)
- [ ] **PRXY-08**: Token refresh is serialized per credential

### Teardown

- [ ] **TEAR-01**: Ending a lease for any reason runs teardown in fixed order: revoke OAuth, invalidate license, cleanup hook, delete cached data, final receipt
- [ ] **TEAR-02**: Each credential records `revoked | discarded_revocation_unsupported | failed`; a bare 2xx is never treated as proof beyond what RFC 7009 guarantees
- [ ] **TEAR-03**: Uninstall hook authenticates with a single-use cleanup token scoped to `cleanup:<lease_id>`
- [ ] **TEAR-04**: Any step failure lands the lease in `cleanup_incomplete` with every step's result recorded; retrying resumes idempotently; the lease can never return to active
- [ ] **TEAR-05**: Every teardown path, including each single-step failure, is covered by tests

### Host Integration & Storage

- [x] **HOST-01**: Platform builder can implement one `HostAdapter` interface covering consent, per-call approval and lifecycle notifications
- [ ] **HOST-02**: CLI reference HostAdapter renders consent from the manifest and prompts approvals in the terminal, defaulting to deny on timeout
- [ ] **HOST-03**: Platform builder can implement a `LeaseStore` interface; JSON-file default uses atomic writes and locking that pass a concurrent read/write test on Windows

### CLI

- [ ] **CLI-01**: User can create a lease from a manifest (with consent), inspect a lease, revoke it and run/retry cleanup
- [ ] **CLI-02**: User can print a lease's receipts as a merged plain-language timeline and verify chain integrity

### Example & Docs

- [ ] **E2E-01**: `examples/payment-reconciler` runs in hybrid mode: licensed by a mock publisher, reads mocked Paystack transactions via OAuth, writes to a mocked orders sheet
- [ ] **E2E-02**: E2E test covers happy path to `cleaned_up`, a denied out-of-scope call, an approval, user revoke mid-run, and a partial teardown failure
- [ ] **DOC-01**: README explains the problem, the three auth modes, hosted-mode trust limits and a quickstart using the example agent that works as written

## v2 Requirements

### Lifecycle

- **LIFE-V2-01**: Mid-lease scope-escalation request with re-consent
- **LIFE-V2-02**: Multi-agent delegation of leases

### Storage & Hosting

- **STORE-V2-01**: Additional LeaseStore backends (SQLite, Postgres, Redis)
- **STORE-V2-02**: Distributed per-lease locking for multi-process runtimes

### Ecosystem

- **ECO-V2-01**: npm publishing and release pipeline
- **ECO-V2-02**: Additional example agents (send-only, write-only)
- **ECO-V2-03**: Embeddable receipt timeline UI component
- **ECO-V2-04**: AuthZEN-compatible external policy engine integration

## Out of Scope

| Feature | Reason |
|---------|--------|
| Marketplace / agent discovery | Protocol and runtime only for v0.1 |
| Prompt-injection detection | Core claim is that injection cannot exceed the lease; detection is a different product |
| General policy DSL (ABAC/ReBAC) | Reopens the attack surface the fixed vocabulary closes |
| Real payment integrations / real Paystack | Mocked only; `pay` enforced but never executed for real |
| Agent process network sandboxing | Proxy governs MCP calls, not the agent process; documented trust assumption |
| Rich consent UI | Platforms build their own via HostAdapter |
| TypeScript 7 | typescript-eslint does not yet support it |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| FND-01 | Phase 1 | Complete |
| FND-02 | Phase 1 | Complete |
| FND-03 | Phase 1 | Complete |
| SPEC-01 | Phase 1 | Complete |
| SPEC-02 | Phase 1 | Complete |
| SPEC-03 | Phase 1 | Complete |
| SPEC-04 | Phase 1 | Complete |
| SPEC-05 | Phase 1 | Complete |
| SPEC-06 | Phase 1 | Complete |
| LIFE-01 | Phase 2 | Complete |
| LIFE-02 | Phase 2 | Complete |
| LIFE-03 | Phase 2 | Complete |
| LIFE-04 | Phase 2 | Complete |
| LIFE-05 | Phase 2 | Complete |
| LIFE-06 | Phase 5 | Pending |
| LIFE-07 | Phase 2 | Complete |
| LIC-01 | Phase 3 | Complete |
| LIC-02 | Phase 3 | Complete |
| LIC-03 | Phase 3 | Complete |
| LIC-04 | Phase 5 | Pending |
| LIC-05 | Phase 4 | Pending |
| RCPT-01 | Phase 4 | Complete |
| RCPT-02 | Phase 3 | Complete |
| RCPT-03 | Phase 3 | Complete |
| RCPT-04 | Phase 3 | Complete |
| RCPT-05 | Phase 3 | Complete |
| RCPT-06 | Phase 3 | Complete |
| RCPT-07 | Phase 5 | Pending |
| PRXY-01 | Phase 4 | Complete |
| PRXY-02 | Phase 2 | Complete |
| PRXY-03 | Phase 2 | Complete |
| PRXY-04 | Phase 4 | Pending |
| PRXY-05 | Phase 4 | Pending |
| PRXY-06 | Phase 4 | Pending |
| PRXY-07 | Phase 4 | Pending |
| PRXY-08 | Phase 4 | Pending |
| TEAR-01 | Phase 5 | Pending |
| TEAR-02 | Phase 5 | Pending |
| TEAR-03 | Phase 5 | Pending |
| TEAR-04 | Phase 5 | Pending |
| TEAR-05 | Phase 5 | Pending |
| HOST-01 | Phase 2 | Complete |
| HOST-02 | Phase 6 | Pending |
| HOST-03 | Phase 6 | Pending |
| CLI-01 | Phase 6 | Pending |
| CLI-02 | Phase 6 | Pending |
| E2E-01 | Phase 7 | Pending |
| E2E-02 | Phase 7 | Pending |
| DOC-01 | Phase 7 | Pending |

**Coverage:**

- v1 requirements: 49 total
- Mapped to phases: 49
- Unmapped: 0

**Notes:**

- The HostAdapter contract (HOST-01) is defined in Phase 2. Its CLI reference implementation (HOST-02) lands in Phase 6.
- The LeaseStore contract is defined in Phase 2 as enabling work (in-memory double and contract suite). HOST-03 (JSON-file store with Windows atomicity) is mapped to Phase 6.
- The pure policy logic (PRXY-02, PRXY-03, LIFE-07) is built in Phase 2. The Phase 4 proxy routes every live call through it.
- The checkpoint signing in RCPT-03 is built in Phase 3. The final signed receipt at teardown is exercised by TEAR-01 in Phase 5.

---
*Requirements defined: 2026-09-27*
*Last updated: 2026-09-27 after roadmap creation (traceability filled)*
