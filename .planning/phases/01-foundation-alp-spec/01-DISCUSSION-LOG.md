# Phase 1: Foundation & ALP Spec - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md. This log preserves the alternatives considered.

**Date:** 2026-09-27
**Phase:** 01-foundation-alp-spec
**Areas discussed:** Manifest signing & hash, Manifest shape details, ALP.md style & depth, Repo layout & codegen, plus follow-ups (validator errors, public API, sample manifests)

---

## Manifest signing & hash

| Question | Options | Selected |
|----------|---------|----------|
| Canonicalization | RFC 8785 JCS / Custom sorted-key JSON / You decide | RFC 8785 JCS |
| Signature format | Detached JWS EdDSA (jose) / PASETO v4.public / You decide | Detached JWS EdDSA |
| Signature placement | Envelope object / Sidecar file / Embedded field | Envelope object |
| Key trust | Runtime trust store / Key embedded in manifest / Well-known URL fetch | Runtime trust store |
| Unsigned manifests | Never / Explicit dev flag | Never |
| Key rotation | Multi-key by kid / Single key per publisher | Multi-key by kid |
| Bound hash | Manifest content only / Whole envelope | Manifest content only |
| Hash format | Prefixed string / Bare hex / You decide | Prefixed string |

**Notes:** User asked for a second round of signing questions after the first four.

---

## Manifest shape details

| Question | Options | Selected |
|----------|---------|----------|
| Scopes | Resource + access list / Flat strings / Map by resource | Resource + access list |
| Durations | Integer seconds / ISO 8601 | Integer seconds |
| Unknown fields | Strict + x- extensions / Fully strict / Permissive | Strict + x- extensions |
| Spend | Minor units + currency / Decimal string + currency / You decide | Minor units + currency |
| spec_version | "alp/0.1" exact match / Semver range | Exact match; clarified literal value is `"alp/0.1"` (not `"0.1"`) |
| Cleanup | Hook URL + retention claim / Hook URL only / You decide | Hook URL + retention claim |
| Delegated grants | Provider id + resources / Include OAuth endpoints | Provider id + resources |
| Verifier | Tagged union / You decide | Tagged union |
| Limits shape | Flat named fields / Per-resource limits | Flat named fields |
| Required limits | Duration + max_actions / Only duration / All | Duration + max_actions |
| Approvals | require_for list (runtime can add, never remove) / Publisher list authoritative | require_for list |
| Hosted auth | Publisher license issuer only / You decide | Publisher license issuer only |

---

## ALP.md style & depth

| Question | Options | Selected |
|----------|---------|----------|
| Normative style | RFC 2119/8174 keywords / Plain prose | RFC 2119/8174 |
| Schema relation | Separate file, linked / Inline | Separate file, linked |
| Later-phase parts | Full normative now with [OPEN] markers / Only settled sections | Full normative with markers |
| Diagrams | Mermaid state + sequence / State only / Tables only | Mermaid state + sequence |
| Conformance | Yes with test vectors / Section only / Neither | Yes with test vectors |
| Transition table | Normative table in ALP.md / Machine-readable JSON too | Normative table in ALP.md |

---

## Repo layout & codegen

| Question | Options | Selected |
|----------|---------|----------|
| Packages | All four as stubs / Only @stint/spec | All four as stubs |
| Codegen | Committed + CI drift check / Build-time | Committed + drift check |
| Serializer location | In @stint/spec / Separate @stint/canonical | In @stint/spec |
| CI matrix | Linux + Windows, Node 22 & 24 / Node 24 only / Add macOS | Linux + Windows, Node 22 & 24 |

---

## Follow-up gray areas

| Question | Options | Selected |
|----------|---------|----------|
| Validator errors | Stint error list over Ajv / Raw Ajv errors | Stint error list |
| Public API | Result-returning functions + branded VerifiedManifest / Throwing functions | Result-returning |
| Sample manifests | Payment-reconciler manifest / Generic toys | Payment-reconciler |

---

## Claude's Discretion

- Hash prefix spelling, `publisher_retains` enum values, full error code list, JCS library choice, ESLint/Prettier details.

## Deferred Ideas

- Well-known JWKS key discovery; key revocation lists; machine-readable transitions.json; spec_version negotiation; macOS CI.
