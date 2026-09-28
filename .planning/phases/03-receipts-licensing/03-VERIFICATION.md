---
phase: 03-receipts-licensing
verified: 2026-09-28T00:00:00Z
status: passed
score: 5/5 must-haves verified
covered_files: [".planning/REQUIREMENTS.md", ".planning/phases/03-receipts-licensing/03-01-PLAN.md", ".planning/phases/03-receipts-licensing/03-01-SUMMARY.md", ".planning/phases/03-receipts-licensing/03-02-PLAN.md", ".planning/phases/03-receipts-licensing/03-02-SUMMARY.md", ".planning/phases/03-receipts-licensing/03-03-PLAN.md", ".planning/phases/03-receipts-licensing/03-03-SUMMARY.md", ".planning/phases/03-receipts-licensing/03-04-PLAN.md", ".planning/phases/03-receipts-licensing/03-04-SUMMARY.md", ".planning/phases/03-receipts-licensing/03-05-PLAN.md", ".planning/phases/03-receipts-licensing/03-05-SUMMARY.md", ".planning/phases/03-receipts-licensing/03-06-PLAN.md", ".planning/phases/03-receipts-licensing/03-06-SUMMARY.md", "packages/core/src/index.ts", "packages/core/src/license/errors.ts", "packages/core/src/license/held-license.ts", "packages/core/src/license/implicit-assertion.ts", "packages/core/src/license/issue.ts", "packages/core/src/license/license-issuer.ts", "packages/core/src/license/refresh.ts", "packages/core/src/license/verify.ts", "packages/core/src/receipts/attested.ts", "packages/core/src/receipts/chain.ts", "packages/core/src/receipts/checkpoint.ts", "packages/core/src/receipts/errors.ts", "packages/core/src/receipts/merge.ts", "packages/core/src/receipts/receipt-store.ts", "packages/core/src/testing.ts", "spec/ALP.md", "spec/checkpoint.schema.json", "spec/receipt.schema.json"]
covered_digest: "v1:sha256:df09f3851f84f111c56d44deff47b7af78007b2598673d1b2d2ced5db34b1659"
behavior_unverified: 0
overrides_applied: 0
---

# Phase 03: Receipts & Licensing Verification Report

**Phase Goal:** Every lease has a tamper-evident audit trail whose verified and attested chains check independently, and publishers can issue short-lived licenses whose refresh can never outlive the lease.
**Verified:** 2026-09-28
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth (roadmap Success Criteria) | Status | Evidence |
|---|-------|--------|----------|
| 1 | Appending entries builds a hash chain through the single canonical serializer; a golden-hash fixture pins exact bytes and hashes identically on Windows and Linux. | ✓ VERIFIED | `packages/core/src/receipts/chain.ts` `appendEntry`/`verifyChain` import only `canonicalize`/`hashCanonical` from `@stint/spec` (no `node:crypto`, no bare stringify). `spec/vectors/receipts/{chain-input.json,chain-canonical.txt,chain-expected-hash.txt}` exist; `chain-golden.test.ts` asserts `canonicalizeEntry(last)` equals the committed canonical text and `verifyChain`'s `headHash` equals the committed `jcs-sha256:` hash. Ran locally on Windows: `packages/core` 194/194 pass including this test. CI matrix (`.github/workflows/*.yml`) runs `os: [ubuntu-latest, windows-latest]`, giving the cross-platform claim independent confirmation beyond this session's single-OS run. |
| 2 | Ed25519-signed checkpoints; verifying a tampered/reordered/truncated chain (relative to last signed checkpoint) reports the exact break entry. | ✓ VERIFIED | `packages/core/src/receipts/checkpoint.ts` `signCheckpoint`/`verifyCheckpoint` mirror `packages/spec/src/jws.ts`'s detached-EdDSA shape exactly, injected `CryptoKey`s, collapse every failure to `false` (no jose exception forwarded). `chain.ts`'s `verifyChain` accepts optional `checkpoint`/`checkpointPublicKey`, reports `checkpoint_sig_invalid`, `truncated`, `reordered`, and `hash_mismatch` each with exact `brokenAtSeq`. `verify-chain.test.ts` and `chain-golden.test.ts` assert all four reasons at the correct seq; `checkpoint.test.ts` pins a deterministic signature against `spec/vectors/receipts/checkpoint-expected-sig.txt`. All pass. |
| 3 | Publisher-signed attested entries live in a separate chain verifying independently of the verified chain; both merge into one plain-language timeline marking each entry verified/attested (ordering display-only). | ✓ VERIFIED | `packages/core/src/receipts/attested.ts` reuses `@stint/spec`'s exported `verifyDetached`/`TrustStore`/`Ed25519PublicJwk` trust model (same function `verifyEnvelope` uses) and `chain.ts`'s unmodified `verifyChain` for the hash walk — no second Ed25519 path. `attested-chain.test.ts` explicitly asserts "corrupting the verified chain does not change the attested chain's verification result" and this test passes. `packages/core/src/receipts/merge.ts`'s `mergeTimeline` is a pure function tagging `origin: "verified" | "attested"`, never mutates inputs (asserted against `Object.freeze`d chains in `merge.test.ts`), and its docstring plus `spec/ALP.md` §11 state ordering carries no integrity meaning. |
| 4 | A mock publisher issues a PASETO v4.public license (lease id, job, expiry, limits, 5-min default TTL) verified offline via one shared implicit-assertion derivation and a tested clock-skew tolerance; wrong-lease/out-of-skew tokens rejected. | ✓ VERIFIED | `packages/core/src/license/implicit-assertion.ts`'s `deriveImplicitAssertion` is imported by both `issue.ts` and `verify.ts` (grep-confirmed, single derivation). `verify.ts` exports `LICENSE_CLOCK_SKEW_SECONDS = 5` and is the sole call site of paseto's `Verify`, always passing an explicit `clockTolerance`. `verify.test.ts`'s D-14 suite asserts exp-minus-1s passes, exp+skew-1 passes, exp+skew+1 fails with `license_claim_invalid`, a tampered signature fails with `license_invalid_signature`, and a cross-lease token (`invalid-wrong-lease.txt`) is rejected — all pass, all against real `spec/vectors/license/*` fixtures, not mocks. `DEFAULT_LICENSE_TTL_SECONDS = 300` in `refresh.ts` is a standalone runtime constant, never read from the manifest (confirmed — `refresh.ts` imports no paseto type, no manifest type). |
| 5 | Under an injectable clock, the runtime refreshes before TTL expiry, stops at lease expiry so no refreshed token outlives the lease, and holds the license with no path that hands it to the agent. | ✓ VERIFIED | `refresh.ts`'s `needsRefresh`/`clampedLicenseExpiry` are pure, stateless, epoch-seconds-only functions; `clampedLicenseExpiry` returns `null` once `now >= leaseExpiresAt`. `refresh.test.ts`'s end-to-end suite drives the actual mock `LicenseIssuer` (`createMockLicenseIssuer` in `testing.ts`) through `reissue`, asserting the verified token's `expEpochSeconds` never exceeds `leaseExpiresAt` and that reissue returns `null` at/after lease expiry — passes. `held-license.ts`'s `HeldLicense` is an opaque branded handle with its raw token in a module-private `WeakMap`; `readLicenseToken` is the sole accessor, proven by two `@ts-expect-error` assertions in `held-license.test.ts` (brand construction, and `.token` field access), both compile-time enforced via `pnpm typecheck` (clean). `index.ts`'s barrel never exports `issueLicense`'s raw-signing path in a way core calls directly, and `public-api.test.ts` asserts `createMockLicenseIssuer` is unreachable from the main entry. |

**Score:** 5/5 truths verified (0 present-behavior-unverified)

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `spec/receipt.schema.json` | Normative draft-07 ReceiptEntry schema | ✓ VERIFIED | `$schema: draft-07`, root `oneOf` discriminated union (CallEntry/TransitionEntry/TeardownStepEntry/AttestedClaimEntry). |
| `spec/checkpoint.schema.json` | Normative draft-07 Checkpoint schema | ✓ VERIFIED | `$schema: draft-07`, `{ chain, count, headHash, ts, sig }`. |
| `packages/core/src/receipts/chain.ts` | appendEntry/verifyChain over single serializer | ✓ VERIFIED | 234 lines; imports only `canonicalize`/`hashCanonical` from `@stint/spec`; exports `GENESIS_PREV_HASH`, `appendEntry`, `verifyChain`, `canonicalizeEntry`. |
| `packages/core/src/receipts/checkpoint.ts` | Ed25519 sign/verify checkpoints | ✓ VERIFIED | 94 lines; `CHECKPOINT_HEADER` single module-scope constant; injected `CryptoKey`s; jose exceptions never forwarded. |
| `packages/core/src/receipts/attested.ts` | Independent attested-chain verification | ✓ VERIFIED | 120 lines; reuses `@stint/spec` `verifyDetached`/`TrustStore`; `verifyAttestedChain` reuses `verifyChain` unmodified. |
| `packages/core/src/receipts/merge.ts` | Display-only merged timeline | ✓ VERIFIED | 67 lines; pure `mergeTimeline`, stable sort by ts/origin/seq, no mutation. |
| `packages/core/src/receipts/receipt-store.ts` | ReceiptStore interface, distinct from LeaseStore | ✓ VERIFIED | 58 lines; standalone file; `lease-store.ts` untouched. |
| `packages/core/src/license/implicit-assertion.ts` | Shared implicit-assertion derivation | ✓ VERIFIED | 26 lines; single `deriveImplicitAssertion` over `canonicalize({lease_id, spec_version})`. |
| `packages/core/src/license/issue.ts` | PASETO v4.public issuance | ✓ VERIFIED | 102 lines; `PublicProtocol(SignFactory)`, explicit `exp` claim (never `expiresIn`), `kid` in footer only. |
| `packages/core/src/license/verify.ts` | PASETO v4.public offline verify | ✓ VERIFIED | 141 lines; single `Verify` call site; explicit `LICENSE_CLOCK_SKEW_SECONDS`; fixed error-code mapping, never forwards paseto message text. |
| `packages/core/src/license/refresh.ts` | Bounded refresh / clamp | ✓ VERIFIED | 39 lines; pure, no paseto import, `clampedLicenseExpiry` clamps to lease expiry and refuses at/after. |
| `packages/core/src/license/held-license.ts` | Opaque branded HeldLicense | ✓ VERIFIED | 62 lines; unique-symbol brand, module-private WeakMap, single accessor `readLicenseToken`. |
| `packages/core/src/license/license-issuer.ts` | Injectable LicenseIssuer port | ✓ VERIFIED | 45 lines; `issue`/`reissue` interface, no signing implementation inside core proper. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `chain.ts` | `@stint/spec` canonicalize/hashCanonical | import | ✓ WIRED | Confirmed by grep; no `node:crypto` import present. |
| `checkpoint.ts` | `chain.ts`/`verifyChain` | optional checkpoint param | ✓ WIRED | `verifyChain(chain, checkpoint?, checkpointPublicKey?)` calls `verifyCheckpoint` first, fails closed as `checkpoint_sig_invalid` when key missing. |
| `attested.ts` | `chain.ts` `verifyChain` | reused unmodified | ✓ WIRED | `verifyAttestedChain` calls `verifyChain(chain, checkpoint, checkpointPublicKey)` directly, no re-implementation. |
| `attested.ts` | `@stint/spec` `verifyDetached`/`TrustStore` | import + two-level lookup | ✓ WIRED | Same function `verifyEnvelope` uses; `ownEntry` lookup mirrors `envelope.ts`. |
| `issue.ts` & `verify.ts` | `implicit-assertion.ts` | import | ✓ WIRED | Both files import `deriveImplicitAssertion`; grep confirms no second derivation exists anywhere in `packages/core/src`. |
| `testing.ts` `createMockLicenseIssuer.reissue` | `refresh.ts` `clampedLicenseExpiry` | direct call | ✓ WIRED | `reissue` calls `clampedLicenseExpiry(now, DEFAULT_LICENSE_TTL_SECONDS, leaseExpiresAt)` and returns `null` on refusal before ever calling `issue`. |
| `index.ts` barrel | receipts + license modules | re-export | ✓ WIRED | All must-have symbols present; `./testing` factories (`createInMemoryReceiptStore`, `createReceiptStoreContractTests`, `createMockLicenseIssuer`) confirmed absent from the main entry by `public-api.test.ts`. |

### Behavioral Spot-Checks / Test Runs

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| `packages/core` full suite (receipts + license + rest) | `pnpm --filter packages/core exec vitest run --pool=threads` (run from `packages/core`) | 22 test files, 194/194 passed | ✓ PASS |
| `packages/spec` full suite (codegen, canonicalize, envelope, jws) | `pnpm exec vitest run --pool=threads` (run from `packages/spec`) | 10 test files, 80/80 passed | ✓ PASS |
| Spec codegen currency | `pnpm --filter @stint/spec run codegen:check` | exit 0, `node scripts/codegen.mjs --check` clean | ✓ PASS |
| Repo-wide typecheck | `pnpm typecheck` | `tsc -b` exit 0 | ✓ PASS |
| Repo-wide build | `pnpm build` | `tsdown` builds for all packages, exit 0 | ✓ PASS |
| Lint on phase-touched files | `eslint packages/core/src/receipts packages/core/src/license packages/core/src/testing.ts packages/core/src/index.ts` | no output, exit 0 | ✓ PASS |
| ALP spec structural check | `pnpm run check:alp` | "ALP check passed" | ✓ PASS |
| Section 8/11 open-marker resolution | manual read of `spec/ALP.md` §8, §11 | Neither section contains `[OPEN: Phase 3]`; §8 states the hosted-license claim set + implicit-assertion derivation; §11 states the receipt/checkpoint entry format and the display-only merge rule | ✓ PASS |

### Requirements Coverage

| Requirement | Source Plan(s) | Description | Status | Evidence |
|-------------|-----------------|-------------|--------|----------|
| RCPT-02 | 03-01, 03-04 | Receipts hash-chained via single canonical serializer with golden-hash fixture test | ✓ SATISFIED | `chain.ts` + golden vector + `ReceiptStore` persistence contract, all tested. |
| RCPT-03 | 03-02, 03-04 | Runtime signs chain checkpoints with Ed25519 | ✓ SATISFIED | `checkpoint.ts` signCheckpoint/verifyCheckpoint, injected keypair, tested. (Final signed receipt at teardown itself is Phase 5/TEAR-01, per ROADMAP note — not this phase's scope.) |
| RCPT-04 | 03-03 | Publisher-signed attested entries live in separate chain, each verifies independently | ✓ SATISFIED | `attested.ts`, independence test passes. |
| RCPT-05 | 03-03 | User can view both chains merged into one plain-language timeline, marking verified vs attested | ✓ SATISFIED | `merge.ts` `mergeTimeline`/`TimelineEntry`, tested; ALP §11 documents the display-only merge. |
| RCPT-06 | 03-02 | Verifying a tampered/truncated chain reports the exact break relative to last checkpoint | ✓ SATISFIED | `verifyChain`'s four reasons (`hash_mismatch`, `reordered`, `truncated`, `checkpoint_sig_invalid`), each with exact `brokenAtSeq`, tested. |
| LIC-01 | 03-05 | Publisher can issue PASETO v4.public license (lease id, job, expiry, limits, 5-min default TTL) | ✓ SATISFIED | `issue.ts` `issueLicense`, `DEFAULT_LICENSE_TTL_SECONDS = 300` in `refresh.ts`, tested against fixed vectors. |
| LIC-02 | 03-05 | Publisher server verifies licenses offline using shared implicit-assertion derivation and explicit clock-skew tolerance | ✓ SATISFIED | `verify.ts` `verifyLicense`, `LICENSE_CLOCK_SKEW_SECONDS`, boundary-tested. |
| LIC-03 | 03-06 | Runtime refreshes licenses before TTL expiry, never beyond lease expiry; agent never holds license | ✓ SATISFIED | `refresh.ts` clamp + `held-license.ts` opaque custody, both tested (including compile-time `@ts-expect-error` proofs). |

No orphaned requirements: cross-referencing `.planning/REQUIREMENTS.md`'s Phase-3 rows (RCPT-02..06, LIC-01..03) against every plan's frontmatter `requirements:` field shows a 1:1 match; all eight are claimed by exactly the plans listed above and all eight are marked `[x]` / "Complete" in REQUIREMENTS.md and the ROADMAP traceability table.

### Anti-Patterns Found

None. Scanned all phase-touched files in `packages/core/src/receipts/`, `packages/core/src/license/`, `packages/core/src/testing.ts`, `packages/core/src/index.ts` for `TBD|FIXME|XXX|TODO|HACK|PLACEHOLDER`, placeholder-language strings, and empty-implementation patterns (`return null|{}|[]`, `=> {}`). The only `return null` matches are legitimate guard clauses (`readEd25519PublicJwk` malformed-input rejection in `attested.ts`; `clampedLicenseExpiry`'s at/after-lease-expiry refusal in `refresh.ts`) — not stubs.

### Human Verification Required

None. All five roadmap Success Criteria are directly exercised by automated tests that were re-run in this verification session (not merely trusted from SUMMARY.md claims), the ALP.md spec-marker resolution was read directly, and the compile-time custody guarantees (`HeldLicense`) were confirmed via a clean `pnpm typecheck` alongside the `@ts-expect-error` assertions in `held-license.test.ts`.

### Gaps Summary

None. All 5 roadmap Success Criteria verified, all 8 requirement IDs satisfied with test evidence, all artifacts exist/substantive/wired, `packages/core` (194/194) and `packages/spec` (80/80) pass, `pnpm build`/`pnpm typecheck`/`check:alp`/scoped `eslint` all clean. One pre-existing regression noted in `deferred-items.md` (a `codegen.test.ts` fixture gap introduced by 03-01's `codegen.mjs` target-array extension) was already resolved during the phase's own regression gate, confirmed here by the passing `packages/spec` 80/80 run.

---

_Verified: 2026-09-28_
_Verifier: Claude (gsd-verifier)_
