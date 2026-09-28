---
phase: 03-receipts-licensing
reviewed: 2026-09-28T08:04:59Z
depth: standard
files_reviewed: 29
files_reviewed_list:
  - packages/core/src/receipts/chain.ts
  - packages/core/src/receipts/checkpoint.ts
  - packages/core/src/receipts/attested.ts
  - packages/core/src/receipts/merge.ts
  - packages/core/src/receipts/errors.ts
  - packages/core/src/receipts/receipt-store.ts
  - packages/core/src/license/implicit-assertion.ts
  - packages/core/src/license/issue.ts
  - packages/core/src/license/verify.ts
  - packages/core/src/license/errors.ts
  - packages/core/src/license/refresh.ts
  - packages/core/src/license/held-license.ts
  - packages/core/src/license/license-issuer.ts
  - packages/core/src/testing.ts
  - packages/core/src/index.ts
  - packages/core/package.json
  - packages/spec/src/jws.ts
  - packages/spec/src/index.ts
  - packages/spec/scripts/codegen.mjs
  - packages/core/test/receipts/chain-golden.test.ts
  - packages/core/test/receipts/checkpoint.test.ts
  - packages/core/test/receipts/verify-chain.test.ts
  - packages/core/test/receipts/attested-chain.test.ts
  - packages/core/test/receipts/merge.test.ts
  - packages/core/test/receipts/receipt-store-contract.test.ts
  - packages/core/test/license/issue.test.ts
  - packages/core/test/license/verify.test.ts
  - packages/core/test/license/refresh.test.ts
  - packages/core/test/license/held-license.test.ts
  - packages/core/test/public-api.test.ts
findings:
  critical: 1
  warning: 2
  info: 1
  total: 4
status: issues_found
---

# Phase 03: Code Review Report

**Reviewed:** 2026-09-28T08:04:59Z
**Depth:** standard
**Files Reviewed:** 29
**Status:** issues_found

## Summary

Reviewed the receipt-chain (hash chain + Ed25519 checkpoints + independent attested-chain verification) and PASETO v4.public license issue/verify/refresh/custody code for Phase 3. Most of the security-critical discipline the docstrings advertise is genuinely implemented: `verifyChain` always recomputes hashes rather than trusting stored ones, `verifyCheckpoint`/`verifyDetached`/`verifyLicense` all collapse every failure mode to fixed, non-interpolated reason codes without forwarding library exception text, the attested chain never reads or is affected by the verified chain's state, `clampedLicenseExpiry` correctly bounds refreshed expiry to `min(now + ttl, leaseExpiresAt)`, and `HeldLicense` has no public accessor other than `readLicenseToken`. `issueLicense`/`./testing` are correctly withheld from the public barrel.

However, `verifyChain`'s checkpoint-anchoring path has a real, provable gap: it verifies the checkpoint's own signature and enforces a minimum chain length, but never verifies that the chain's actual computed hash at the checkpoint's boundary equals `checkpoint.headHash`. This means the checkpoint currently provides no protection against wholesale substitution of pre-checkpoint chain content — only against outright truncation to a shorter length. Given this phase's stated purpose ("tamper-evident receipt chains... RCPT-06"), this is a Critical finding. Two secondary Warnings and one Info item are also listed below.

## Critical Issues

### CR-01: `verifyChain` never checks the chain's content against `checkpoint.headHash` — checkpoint anchoring does not detect content substitution, only length shortfall

**File:** `packages/core/src/receipts/chain.ts:186-234`

**Issue:**
`verifyChain`'s checkpoint path does two things: (1) verifies `checkpoint.sig` via `verifyCheckpoint` (a self-referential check over the checkpoint's own `{chain, count, headHash, ts}` fields — it never touches the `chain` array argument), and (2) after the internal hash-link walk succeeds, rejects with `"truncated"` only when `count < checkpoint.count`. At no point does the function compare any hash computed from the actual `chain` array — e.g. `entryHashes[checkpoint.count - 1]`, the hash at the checkpoint's own boundary — against `checkpoint.headHash`.

Concretely: given a genuine, validly-signed checkpoint `{count: 3, headHash: H(E2), sig}` over real entries `E0,E1,E2`, an attacker who can substitute the persisted chain (e.g. compromises the `ReceiptStore`'s backing file, or intercepts the `chain` argument) can replace `E0,E1,E2` with entirely fabricated `F0,F1,F2` — any content, as long as `F0.prevHash === GENESIS_PREV_HASH`, `F1.prevHash === hashCanonical(F0)`, `F2.prevHash === hashCanonical(F1)` (i.e. internally self-consistent, which the attacker fully controls since they also control the fabricated content). Calling `verifyChain(fabricatedChain, checkpoint, publicKey)`:
1. `checkpoint.sig` still verifies (untouched, still a valid signature over its own unchanged fields).
2. The internal walk succeeds (self-consistent fabricated chain).
3. `count(3) < checkpoint.count(3)` is false, so no `"truncated"`.
4. Returns `{ ok: true, value: { headHash: hashCanonical(F2), count: 3 } }` — despite `hashCanonical(F2) !== checkpoint.headHash`.

The caller has no way to detect the substitution from `verifyChain`'s result alone (nothing in this file or its callers — `verifyAttestedChain` inherits the same gap — ever reads `result.value.headHash` back against `checkpoint.headHash`). This defeats the stated purpose of checkpointing: per the file's own docstring, the checkpoint is meant to anchor/detect "a wholesale removal of entries after the last checkpoint... otherwise invisible to a pure internal-consistency walk" — but a wholesale *replacement* of entries (same or greater count, self-consistent content) is equally invisible, and is arguably the more realistic tamper scenario for a compromised JSON-file receipt log.

No existing test (`verify-chain.test.ts`, `attested-chain.test.ts`) exercises a chain whose content differs from what a valid checkpoint actually committed to while keeping `count >= checkpoint.count` — the one positive-path checkpoint test (`"ok when the chain's head hash and count match"`) only proves the happy path where content and checkpoint already agree; it does not prove the function rejects disagreement.

**Fix:**
Compare the walk-computed hash at the checkpoint's own boundary (not just the final `headHash` of the whole supplied chain) against `checkpoint.headHash`, after the truncation check and before returning `ok: true`:

```ts
const headHash = expectedPrevHash;
const count = chain.length;

if (checkpoint !== undefined) {
  if (count < checkpoint.count) {
    return reject(count, "truncated");
  }
  const boundaryHash =
    checkpoint.count === 0 ? GENESIS_PREV_HASH : entryHashes[checkpoint.count - 1];
  if (boundaryHash !== checkpoint.headHash) {
    // reuse "hash_mismatch", or add a dedicated reason (e.g.
    // "checkpoint_head_mismatch") to RECEIPT_VERIFY_REASONS if the
    // distinction from an ordinary hash_mismatch matters to callers.
    return reject(checkpoint.count - 1 < 0 ? 0 : checkpoint.count - 1, "hash_mismatch");
  }
}

return { ok: true, value: { headHash, count } };
```

Add a negative test asserting that a chain with the same `count` as a valid checkpoint, but different (still internally self-consistent) content, is rejected — this is the exact case the current suite is missing.

## Warnings

### WR-01: `verifyLicense` never cross-checks `claims.lease_id` against the `leaseId` parameter it derived the implicit assertion from

**File:** `packages/core/src/license/verify.ts:73-141`

**Issue:** `verifyLicense` derives its implicit assertion solely from the caller-supplied `leaseId`/`specVersion` and relies on PASETO's implicit-assertion mismatch to fail signature verification if the token wasn't issued for that same lease. This only holds because the reference `issueLicense` always derives its own implicit assertion from `claims.lease_id` (the same field it signs into the payload) — i.e. the binding between the returned `value.claims.lease_id` and the `leaseId` parameter is enforced entirely by convention in one specific issuer implementation, not by `verifyLicense` itself. `LicenseIssuer` is an explicitly injectable port (`license-issuer.ts`) meant for third-party/publisher implementations (Phase 7's mock publisher, real publishers per the ALP spec); a non-conforming issuer that derives its implicit assertion from anything other than `claims.lease_id` could produce a token that verifies successfully for `leaseId = X` while `value.claims.lease_id` (and thus the license a caller believes it's holding) is actually for a different lease `Y`.

**Fix:** Add a direct equality check as defense-in-depth, independent of the implicit-assertion side channel:
```ts
if (leaseIdClaim !== leaseId) {
  return err("license_claim_invalid");
}
```
placed alongside the existing claim-shape checks (after line ~110).

### WR-02: `packages/core/package.json`'s `engines.node` floor (`>=22.12.0`) contradicts the repo root's documented/enforced floor (`>=22.18.0`)

**File:** `packages/core/package.json:8`

**Issue:** The repo root `package.json` already declares `"node": ">=22.18.0"` (per CLAUDE.md: the floor was moved from 22.12 to 22.18 after the resolved dependency tree — `@babel/*@8.0.6`, `ast-kit@3.0.0` — required it, caught as a hard `engineStrict` install failure in Phase 1 CI). `packages/core/package.json`, touched in this phase to add the `jose`/`paseto` dependencies, still declares `"node": ">=22.12.0"`. A consumer installing `@stint/core` standalone (or tooling that reads the package-level `engines` field rather than the workspace root) would be told a floor that CI has already proven is insufficient for this workspace.

**Fix:** Bump `packages/core/package.json`'s `engines.node` to `">=22.18.0"` to match the root and avoid a stale, misleading floor (same issue likely applies to `packages/cli`, `packages/proxy`, `packages/spec`, though those are outside this phase's file list).

## Info

### IN-01: `checkpoint.ts` / `chain.ts` checkpoint boundary semantics are undocumented for `checkpoint.count === 0`

**File:** `packages/core/src/receipts/chain.ts:160-234`

**Issue:** Once CR-01 is fixed, the boundary case `checkpoint.count === 0` (a checkpoint asserting "the chain was empty at this point") needs `checkpoint.headHash` compared against `GENESIS_PREV_HASH` rather than indexing `entryHashes[-1]`. This edge isn't currently exercised by any test (`checkpoint.count` is always 3 in the fixtures) and is easy to get wrong when implementing the CR-01 fix.

**Fix:** Add an explicit test for `checkpoint.count === 0` with both a matching and a mismatched `headHash`, once CR-01's fix lands.

---

_Reviewed: 2026-09-28T08:04:59Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
