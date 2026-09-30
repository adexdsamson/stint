# Phase 5: Lease Endings & Teardown - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-09-28
**Phase:** 05-lease-endings-teardown
**Areas discussed:** Predicate grammar, Cleanup token, Teardown resume, Revocation honesty, Spec [OPEN] resolution, Partial-failure testing, Predicate parser placement, Phase-5 storage boundary, Teardown edge cases

---

## Predicate grammar / outcome verification

| Option | Description | Selected |
|--------|-------------|----------|
| Aggregate + compare DSL | count/sum/exists over rows + optional filter, compared to a literal; closed AST | ✓ |
| Named predicates only | Fixed kind + typed params, no expression string | |
| Path + comparison | JMESPath/JSONPath selector + one comparison | |

| Option | Description | Selected |
|--------|-------------|----------|
| Synthetic read call via binding | Verifier-actor read through existing vault/OutboundConnector/binding path | ✓ |
| Dedicated verifier port | Separate VerifierQuery port | |
| You decide | | |

| Option | Description | Selected |
|--------|-------------|----------|
| Agent-signalled, runtime-run; false = no-op | Agent requests, runtime evaluates; true→completed, false→no-op, error→threshold | ✓ |
| False also denies/counts as error | | |
| Runtime-scheduled re-check | | |

| Option | Description | Selected |
|--------|-------------|----------|
| Validate at manifest time; minimal set | Parse in @stint/spec; count/sum/exists, = != < <= > >=, no AND/OR/nesting | ✓ |
| Validate at manifest time; allow boolean combinators | | |
| Validate lazily at verification time | | |

| Option | Description | Selected |
|--------|-------------|----------|
| Reuse HostAdapter, new confirm method | Dedicated out-of-band async method, core-owned deny-by-default | ✓ |
| Reuse existing requestApproval | | |
| You decide | | |

| Option | Description | Selected |
|--------|-------------|----------|
| Binding declares a row adapter | Runtime-owned projection to {rows:[{field:value}]} | ✓ |
| Require connectors to return canonical rows | | |
| You decide | | |

| Option | Description | Selected |
|--------|-------------|----------|
| Verified-chain entry, redacted | One receipt per attempt: verifier actor, resource id, outcome + reason; no raw data | ✓ |
| Only receipt on completion | | |
| You decide | | |

**User's choice:** As marked above.
**Notes:** Grammar size treated explicitly as attack surface; predicate stays a string validated before consent; agent claim never completes.

---

## Cleanup token

| Option | Description | Selected |
|--------|-------------|----------|
| Signed PASETO/JWT, cleanup:<lease_id> claim | Runtime-minted, offline-verifiable, scope+jti+exp | ✓ |
| Opaque random nonce | | |
| You decide | | |

| Option | Description | Selected |
|--------|-------------|----------|
| Runtime mints fresh per attempt; jti binds one call | Reuse-rejection is the hook's contract; runtime never re-presents a jti | ✓ |
| Runtime tracks consumed tokens too | | |
| You decide | | |

| Option | Description | Selected |
|--------|-------------|----------|
| jose Ed25519 JWT, receipt checkpoint key | One runtime signing identity for checkpoints + cleanup tokens | ✓ |
| PASETO v4.public, dedicated key | | |
| You decide | | |

| Option | Description | Selected |
|--------|-------------|----------|
| Dedicated cleanup client; 2xx = ok (attested) | Runtime HTTPS client; 2xx attested per §13; non-2xx/timeout → failed | ✓ |
| Reuse OutboundConnector port | | |
| You decide | | |

| Option | Description | Selected |
|--------|-------------|----------|
| Skip, record 'not_applicable' | Null hook → distinct not_applicable outcome, no token minted | ✓ |
| Omit the step entirely | | |
| You decide | | |

| Option | Description | Selected |
|--------|-------------|----------|
| Short, per-attempt (~5 min) | Runtime config, never manifest; fresh mint per attempt | ✓ |
| Lease-expiry-bounded | | |
| You decide | | |

**User's choice:** As marked above.
**Notes:** License is already dead by step 3, so the cleanup token is runtime-minted, not the license.

---

## Teardown resume

| Option | Description | Selected |
|--------|-------------|----------|
| Teardown record in LeaseStore | Per-step progress on/beside lease, updated under serializer; retry skips completed | ✓ |
| Derive from receipt log | | |
| You decide | | |

| Option | Description | Selected |
|--------|-------------|----------|
| One pass, then cleanup_incomplete | Attempt each step once, failures don't abort, explicit retry_teardown resumes | ✓ |
| Bounded in-run backoff per step | | |
| You decide | | |

| Option | Description | Selected |
|--------|-------------|----------|
| @stint/proxy, core stays pure | Orchestrator in proxy over pure reduce(); core gains no I/O | ✓ |
| Pure skeleton in core, steps injected | | |
| You decide | | |

| Option | Description | Selected |
|--------|-------------|----------|
| Delete secrets/vault; keep lease + progress + receipts | Secrets go; receipts + lease record + progress survive for RCPT-07 and retry | ✓ |
| Delete all lease data; receipts in separate store | | |
| You decide | | |

| Option | Description | Selected |
|--------|-------------|----------|
| Auto-chain, single runtime driver | Reaching any end state auto-dispatches begin_teardown; one path for all six reasons | ✓ |
| Explicit trigger only | | |
| You decide | | |

| Option | Description | Selected |
|--------|-------------|----------|
| Failed step 5 → cleanup_incomplete | Final-receipt failure is a step failure; cleaned_up requires all five ok | ✓ |
| Best-effort; still cleaned_up | | |
| You decide | | |

**User's choice:** As marked above.
**Notes:** No in-run timers/backoff — fits the no-timers discipline.

---

## Revocation honesty (TEAR-02 + LIC-04)

| Option | Description | Selected |
|--------|-------------|----------|
| Support known from AS metadata/config | revocation_endpoint present → call, 2xx→revoked; none → discarded_unsupported; else failed | ✓ |
| Positively confirm with a probe call | | |
| You decide | | |

| Option | Description | Selected |
|--------|-------------|----------|
| Runtime-facing revoke API + issuer.invalidate port | entitlement_revoked (publisher) → revoked → teardown; additive LicenseIssuer.invalidate + drop HeldLicense | ✓ |
| Poll/detect lazily like provider revocation | | |
| You decide | | |

| Option | Description | Selected |
|--------|-------------|----------|
| Always discard locally; timeline states exactly what's known | Never retain a usable credential post-teardown; timeline never overclaims | ✓ |
| Discard only on success | | |
| You decide | | |

| Option | Description | Selected |
|--------|-------------|----------|
| Attempted = terminal; retry skips step 1 | A failed revoke is a permanent honest record; retry resumes at later steps | ✓ |
| Defer discard so failed revokes are retryable | | |
| You decide | | |

| Option | Description | Selected |
|--------|-------------|----------|
| Verified chain; per-step-typed outcomes | teardown_step on verified chain; OAuth tri-state; others ok/failed/not_applicable/attested-ok | ✓ |
| Uniform ok\|partial\|failed for all steps | | |
| You decide | | |

| Option | Description | Selected |
|--------|-------------|----------|
| notify() with final state each transition | Reuse existing LifecycleEvent notify; no new interface | ✓ |
| Add a richer teardown-summary notify | | |
| You decide | | |

**User's choice:** As marked above.
**Notes:** Pitfall 5 (2xx proves nothing) drove the structural-support classification.

---

## Spec [OPEN] resolution

| Option | Description | Selected |
|--------|-------------|----------|
| Yes — full normative resolution + checker | Close §7.6 + §10 markers with full grammar/token detail; CI checker confirms | ✓ |
| Yes — but keep it prose-level | | |
| Defer spec update | | |

**User's choice:** Full normative resolution.

---

## Partial-failure testing

| Option | Description | Selected |
|--------|-------------|----------|
| Injectable step ports + fault mocks, matrix per step | Force each step to fail; incl. 2xx-without-revoking mock + oauth2-mock-server real revoke | ✓ |
| Real integrations only | | |
| You decide | | |

**User's choice:** Injectable step ports + fault matrix.

---

## Predicate parser placement

| Option | Description | Selected |
|--------|-------------|----------|
| Parser+AST in @stint/spec; evaluator reused by proxy | Post-schema semantic rule; closed AST shared by validation + evaluation | ✓ |
| Parser in @stint/core, spec calls it | | |
| You decide | | |

**User's choice:** Parser+AST in @stint/spec.

---

## Phase-5 storage boundary

| Option | Description | Selected |
|--------|-------------|----------|
| In-memory doubles now; rely on contract guarantee | Test against in-memory doubles + contract suites; JSON/Windows is Phase 6 | ✓ |
| Add a teardown-progress contract test to the suite | | |
| You decide | | |

**User's choice:** In-memory doubles; rely on the LeaseStore contract.

---

## Teardown edge cases

| Option | Description | Selected |
|--------|-------------|----------|
| Drain via serializer; new calls denied | In-flight call completes before teardown RMW; post-active calls denied (lease_not_active) | ✓ |
| Abort in-flight call immediately | | |
| You decide | | |

| Option | Description | Selected |
|--------|-------------|----------|
| Checkpoint at end-transition + final at step 5 | Two checkpoints bracket teardown; chains checkpointed independently | ✓ |
| Only the final teardown checkpoint | | |
| You decide | | |

| Option | Description | Selected |
|--------|-------------|----------|
| Explicit only in v0.1; runtime-actor reserved | No background retry loop; retry_teardown is caller-driven | ✓ |
| Runtime auto-retries on resume | | |
| You decide | | |

| Option | Description | Selected |
|--------|-------------|----------|
| Always all 5, in order, with not_applicable | Fixed order regardless of end reason/auth mode; inapplicable steps → not_applicable | ✓ |
| Skip inapplicable steps entirely | | |
| You decide | | |

**User's choice:** As marked above.

---

## Claude's Discretion

- Module layout in `@stint/proxy` (orchestrator/step modules) and `@stint/spec` (parser/AST/evaluator).
- Exact shapes: teardown-progress record, `LicenseIssuer.invalidate` signature, new `HostAdapter` confirm method, binding row-adapter.
- Cleanup-token claim names + exact TTL value; stable reason strings for verification/teardown-step receipts.
- Predicate grammar surface details within the "minimal, no combinators, no nesting" bound.
- Concrete BNF/wording used to close the spec markers.

## Deferred Ideas

- Automatic/background retry of `cleanup_incomplete` (post-v0.1).
- Positive probe-call confirmation of dead credentials (considered; not adopted for v0.1).
- Boolean combinators / nesting in the predicate grammar (excluded now).
- JSON-file store + Windows-CI atomicity test (Phase 6, HOST-03).
- CLI revoke/cleanup/retry + terminal HostAdapter (Phase 6).
- Interactive OAuth grant acquisition seeding the vault (Phase 6/7).
- Richer teardown-summary host notification (considered; reuse existing notify for v0.1).
