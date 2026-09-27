# Phase 3: Receipts & Licensing - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-09-27
**Phase:** 03-receipts-licensing
**Areas discussed:** Spec OPEN-markers, Receipt & checkpoint shape, Receipt persistence, License issue/verify/refresh

---

## Spec OPEN-markers

| Option | Description | Selected |
|--------|-------------|----------|
| Resolve both in spec | Update ALP.md §8 and §11 with normative formats, matching Phase 2's §7.5 fill-in | ✓ |
| Code-only for now | Formats only as TS/schema in @stint/core; leave ALP.md markers [OPEN] | |
| Split them | Resolve one marker, defer the other | |

**User's choice:** Resolve both in spec

| Option | Description | Selected |
|--------|-------------|----------|
| Both vector sets | Receipt-chain golden vector + license vector (valid/invalid) | ✓ |
| Receipts vector only | Receipt golden vector; license via unit tests only | |
| No new vectors | Internal unit tests only; vectors later | |

**User's choice:** Both vector sets
**Notes:** Keeps ALP.md the single normative source; both new formats become externally reproducible conformance surfaces.

---

## Receipt & checkpoint shape

| Option | Description | Selected |
|--------|-------------|----------|
| JSON Schema in @stint/spec | draft-07 schema + generated types via codegen:check (manifest/envelope pipeline) | ✓ |
| TS types in @stint/core | Hand-written types, no JSON Schema | |
| You decide | Fit existing codegen + normative goal | |

**User's choice:** JSON Schema in @stint/spec

| Option | Description | Selected |
|--------|-------------|----------|
| prevHash + typed union payload | {seq, ts, chain, type, prevHash, payload}, discriminated union, entryHash computed not stored | ✓ |
| prevHash + entryHash both stored | Persist entryHash too (redundant on verify) | |
| Opaque payload blob | Unstructured payload, loses type-level guarantees | |

**User's choice:** prevHash + typed union payload

| Option | Description | Selected |
|--------|-------------|----------|
| Lease-ending + on-demand | Sign at lease-ending events (spec floor) + pure signCheckpoint on demand | ✓ |
| Every N entries | Auto-checkpoint every N appends + lease-ending | |
| Lease-ending only | Strictly lease-ending + teardown, no on-demand | |

**User's choice:** Lease-ending + on-demand

| Option | Description | Selected |
|--------|-------------|----------|
| Reuse spec patterns, jose in core | Attested verify via spec TrustStore/kid; jose for runtime checkpoint signing, keypair injectable | ✓ |
| Fully independent impl | Build attested verify + checkpoint signing from scratch | |
| You decide | Best reuse of trust-store code, chains independent | |

**User's choice:** Reuse spec patterns, jose in core

---

## Receipt persistence

| Option | Description | Selected |
|--------|-------------|----------|
| Pure funcs + ReceiptStore contract | Pure append/verify/merge + ReceiptStore interface, in-memory double + contract-test factory in /testing (Phase 2 LeaseStore pattern) | ✓ |
| Pure funcs only, defer contract | Only pure chain functions; contract later | |
| Extend LeaseStore | Add receipt methods to existing LeaseStore | |

**User's choice:** Pure funcs + ReceiptStore contract

| Option | Description | Selected |
|--------|-------------|----------|
| Result with break locus | verifyChain → Result failure {brokenAtSeq, reason} with stable codes | ✓ |
| Boolean + throw on detail | valid/invalid boolean, throw for detail | |
| You decide | Richest verify result within Result convention | |

**User's choice:** Result with break locus

---

## License issue/verify/refresh

| Option | Description | Selected |
|--------|-------------|----------|
| Real issue/verify + injectable issuer port | Reference issue.ts + verify.ts in core; runtime uses injectable LicenseIssuer; mock impl in /testing | ✓ |
| Issuance only in /testing | Issuance as test helper; core ships verify + refresh only | |
| You decide | Runtime signature-free, reusable issuer, offline verify | |

**User's choice:** Real issue/verify + injectable issuer port

| Option | Description | Selected |
|--------|-------------|----------|
| Pure decision + clamped TTL | needsRefresh(license, now, skew) + exp = min(now+TTL, lease.expires_at) | ✓ |
| Refresh loop owns timing | Scheduled reissue routine checking lease expiry | |
| You decide | Purest refresh boundary, no token beyond lease expiry | |

**User's choice:** Pure decision + clamped TTL

| Option | Description | Selected |
|--------|-------------|----------|
| Registered + custom, IA = lease_id+spec_version | exp/iat/nbf/jti registered; lease_id/job/limits custom; kid in footer; implicit assertion over lease_id+spec_version via one shared fn; TTL runtime config | ✓ |
| All custom claims | Everything custom incl. expiry | |
| You decide | Idiomatic PASETO mapping + pinned IA derivation | |

**User's choice:** Registered + custom, IA = lease_id+spec_version

| Option | Description | Selected |
|--------|-------------|----------|
| Opaque branded handle | Branded license type, single narrow accessor for outbound injection only | ✓ |
| Plain string, guard by convention | Token as string, tests+review only | |
| You decide | Type making leakage impossible by construction | |

**User's choice:** Opaque branded handle

---

## Claude's Discretion

- Exact TypeScript names for all new types/functions (receipts + license).
- Stable reason-code strings for `verifyChain` failures beyond the named examples.
- JSON Schema field names/ordering for `receipt.schema.json` / `checkpoint.schema.json` (pinned by vectors).
- Internal chain value representation (array vs. head+links).
- Whether `append` is the sole `ReceiptStore` mutation path or a lower-level `save` is also exposed.
- Module/file breakdown within `@stint/core` `receipts/` and `license/`.
- Exact PASETO custom-claim key names and `job`/`limits` sub-object shapes.

## Deferred Ideas

- Per-call receipt emission from the live proxy (RCPT-01) — Phase 4.
- License held in credential vault, injected outbound only, LIC-05 adversarial test — Phase 4.
- Entitlement revocation → `revoked`/teardown (LIC-04), final signed teardown receipt, receipts survive cleanup (RCPT-07) — Phase 5.
- JSON-file `ReceiptStore` with NTFS-atomic writes + locking, running Phase 3 contract suite — Phase 6.
- CLI receipt-timeline printing + external checkpoint export/pinning (anchoring against wholesale store compromise) — Phase 6.
