# Project Research Summary

**Project:** Stint — Agent Lease Protocol (ALP) runtime
**Domain:** Agent authorization / MCP proxy / OAuth delegation / tamper-evident audit
**Researched:** 2026-09-27
**Confidence:** MEDIUM-HIGH (patterns established; novel integration unverified)

## Executive Summary

Stint is building an open protocol and TypeScript runtime for safe, auditable AI agent execution. The core value, "a prompt-injected agent can never exceed its lease, and when the lease ends, every credential is revoked and teardown is honestly receipted", is achievable and correctly designed, but it requires integrating security-sensitive layers (OAuth delegation, PASETO licensing, tamper-evident receipt chains, ordered teardown) as a cohesive system.

Research confirms the stack (Node 22.12+, TypeScript 5.9.3, ESM-only, pnpm) is standard and low-risk. The architecture leverages established patterns (MCP gateways, secretless credential brokers, Certificate Transparency-style audit logs), but the novel combination is what delivers the differentiator: dual-layer licensing (entitlement + resource access), runtime-owned tool bindings (never publisher-supplied), and two-chain receipt logs (verified vs. attested) that surface honest limits on what the runtime can prove.

**Critical risk:** seven of ten pitfalls center on how trust boundaries are drawn: the wrong binding source, token exposure, TOCTOU races, and secrets leaking through errors. These are architectural invariants, not code-review catches. The PEP/PDP split must separate security-critical logic into pure, testable functions outside the MCP/I/O layer from day one.

## Key Findings

### Recommended Stack

- **Node 22.12+ (target 24 LTS)**: Node 20 is EOL as of April 2026; vitest 5, commander 15, oauth2-mock-server 9 already require 22.12+
- **TypeScript 5.9.3**: defer TS7 until typescript-eslint supports it (currently capped <6.1.0)
- **Build**: tsdown (tsup is unmaintained) + TS project references
- **Critical libraries:** paseto@4.0.1 (panva's new factory-composition API, 3 weeks old, pin exactly, wrap thinly), oauth4webapi@3.8.8, jose@6.2.12 (Ed25519 checkpoints), ajv@8.20.0 with **draft-07** schemas (json-schema-to-typescript has 2020-12 gaps), write-file-atomic@^7.0.1, proper-lockfile@4.1.2, commander (CLI), @modelcontextprotocol/sdk@1.30.1 (registerTool accepts raw JSON Schema)
- **ESM-only**

### Expected Features

**Must have (table stakes):** deny-by-default proxy enforcement, credentials never reach agent, short-TTL tokens, per-call audit logging, out-of-band human approval for irreversible actions.

**Differentiators:** closed runtime-owned access vocabulary; verified vs attested receipt chains kept independent; licensing as a layer distinct from OAuth; teardown recording per-credential partial-failure outcomes; normative open spec.

**Anti-features:** prompt-injection detection, general policy DSL, marketplace/connector catalog breadth, real payment execution.

**Defer (v0.1.x / v2):** scope-escalation re-consent flow, extra LeaseStore backends, extra example agents, rich timeline UI, multi-agent delegation, AuthZEN integration.

### Architecture Approach

- **PEP (thin proxy):** intercepts `tools/list` and `tools/call`, owns all I/O, enforces verdicts
- **PDP (pure):** `evaluatePolicy(lease, call, binding, now) → allow | deny | require_approval`, zero I/O
- **Dual-server MCP:** agent-facing Server (tool list filtered per lease), resource-facing Client per connector (injects credentials on outbound calls only)
- **Credential vault:** secretless-broker pattern; scrub downstream error bodies
- **State machine:** table-driven pure reducer; LeaseStore holds current snapshot (no event-replay on hot path)
- **Receipts:** linear hash chain per lease + Ed25519 signed checkpoints; two independent chains merged only at display
- **Teardown:** single orchestrator, fixed order, idempotent retryable steps, per-step tri-state outcome (not a compensating saga)
- **Concurrency:** keyed async mutex per lease (in-process for v0.1)

### Critical Pitfalls

1. **Tool binding from wrong source**: runtime-owned registry is the sole source of classification
2. **Confused deputy / token passthrough**: no agent-facing method returns bearer tokens; license never forwarded to resources
3. **TOCTOU approval-to-execution**: approval bound to hash of exact args + binding + lease version; re-verify at execution
4. **PASETO implicit assertions**: one shared derivation function for issuance and verification; explicit tested clock-skew constant
5. **Revocation silent no-op**: RFC 7009 returns success regardless; record `discarded_revocation_unsupported`, detect lazily
6. **Refresh race**: serialize refresh per credential
7. **Non-canonical hashing**: one canonical serializer + golden-hash fixture from first commit
8. **Secrets in logs/errors**: sanitize at vault boundary; receipts take hashes + redacted summaries only
9. **Windows file atomicity**: EPERM/EBUSY on rename; retry + lock + Windows CI
10. **Time/expiry**: per-call expiry checks, injectable clock

## Implications for Roadmap

Suggested 7-phase structure:

1. **Specification & Schema**: ALP.md, draft-07 manifest schema, generated types, Ajv validator
2. **Lease State Machine & Policy Engine (pure)**: transition table, reducer, PDP
3. **Receipts & Licensing (pure)**: hash chains + checkpoints, PASETO wrapper, refresh bounded by lease expiry. *Research spike: paseto@4 API, clock skew*
4. **MCP Proxy & Credential Vault**: dual-server topology, OAuth delegation, per-lease serialization, error scrubbing, approval TOCTOU binding. *Research spike: oauth4webapi RFC 7009/8707 against oauth2-mock-server*
5. **Teardown Orchestrator**: ordered steps, cleanup token, partial-failure matrix
6. **CLI, HostAdapter reference, JSON LeaseStore**: *Windows CI concurrency test*
7. **Example agent + docs**: payment-reconciler e2e, README with trust limits

### Phase Ordering Rationale

Spec first (source of truth); core pure logic before I/O; proxy after the policy it enforces; teardown after all its dependencies; integration last.

### Research Flags

Needs research during planning: Phase 3 (paseto v4 API), Phase 4 (oauth4webapi, MCP authorization spec current text), Phase 6 (Windows atomicity). Standard patterns: Phases 1, 2, 5, 7.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Versions verified live against npm; paseto@4.0.1 is new |
| Features | MEDIUM-HIGH | MCP Authorization and AP2 specs evolving |
| Architecture | MEDIUM-HIGH | Established patterns; novel combination unverified |
| Pitfalls | MEDIUM-HIGH | Grounded in known attack classes and library issues |

**Overall confidence:** MEDIUM-HIGH

### Gaps to Address

1. PASETO v4.0.1 production readiness (Phase 3 spike)
2. MCP Authorization spec version pinning (before Phase 4)
3. oauth4webapi RFC 7009/8707 hands-on validation (Phase 4)
4. Windows file atomicity under concurrency (Phase 6)
5. Teardown partial-failure adversarial tests (Phase 5)
6. Approval TOCTOU tests (Phase 4)
7. Manifest-hash mismatch detection on lease resume (Phases 1-4)

## Sources

See STACK.md, FEATURES.md, ARCHITECTURE.md, PITFALLS.md for per-dimension sources (npm registry, package tarballs, MCP spec and SDK .d.ts, RFC 7009/8707, OWASP MCP guidance, paseto-standard docs, Trillian/CT design, vendor docs for MCP gateways and agent-auth platforms, nodejs/node and write-file-atomic issue trackers).

---
*Research completed: 2026-09-27*
*Ready for roadmap: yes*
