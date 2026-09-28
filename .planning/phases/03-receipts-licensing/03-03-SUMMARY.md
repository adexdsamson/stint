---
phase: 03-receipts-licensing
plan: 03
subsystem: receipts
tags: [ed25519, trust-store, hash-chain, attested-chain, display-only-merge, timeline]

# Dependency graph
requires:
  - phase: 03-receipts-licensing
    plan: 01
    provides: "ReceiptEntry/Checkpoint generated types, GENESIS_PREV_HASH, appendEntry/verifyChain, RECEIPT_VERIFY_REASONS vocabulary"
  - phase: 03-receipts-licensing
    plan: 02
    provides: "signCheckpoint/verifyCheckpoint (jose EdDSA), verifyChain extended with checkpoint anchoring and exact break-locus reporting"
provides:
  - "packages/core/src/receipts/attested.ts: verifyAttestedEntry/verifyAttestedChain - the attested chain's publisher-signature verification, reusing @stint/spec's TrustStore/Ed25519PublicJwk trust model and its exported verifyDetached (the same function verifyEnvelope uses), independent of the verified chain's integrity"
  - "packages/core/src/receipts/merge.ts: mergeTimeline/TimelineEntry - the display-only merged timeline marking each entry verified/attested, ordering carries no integrity meaning"
  - "AttestedClaimPayload gains publisherId + sig fields (schema, generated types) - the fields needed to verify a publisher's claim signature at all"
  - "verifyDetached now exported from @stint/spec's public entry point, for cross-package reuse by the attested chain"
  - "spec/vectors/receipts/attested-input.json + attested-trust-store.json: a 2-entry attested-chain conformance vector"
affects: [03-04, 03-06, phase-04-proxy, phase-06-json-stores]

# Actuals (#2632)
actuals:
  tokens: 9360
  tasks: 2
  commits: 3
  plan_head_before: 14500de92bb6bdcd30f74fd643870ac4bfb5cfc5

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Attested-chain publisher-signature verification reuses @stint/spec's exported verifyDetached directly (not re-implemented via jose in @stint/core), mirroring verifyEnvelope's own two-level TrustStore lookup (publisherId then kid) exactly - a genuinely shared trust model, not a parallel one"
    - "mergeTimeline derives each entry's display origin from WHICH argument it came from (verified vs attested), never re-reading the entry's own chain field - keeps the display tag a property of the merge call, decoupled from a second read of already-verified chain data"
    - "Stable timeline sort key: ts, then origin, then seq - equal-timestamp entries never collide; the sort itself is explicitly documented as carrying no integrity meaning (D-10)"

key-files:
  created:
    - packages/core/src/receipts/attested.ts
    - packages/core/src/receipts/merge.ts
    - packages/core/test/receipts/attested-chain.test.ts
    - packages/core/test/receipts/merge.test.ts
    - spec/vectors/receipts/attested-input.json
    - spec/vectors/receipts/attested-trust-store.json
    - .planning/phases/03-receipts-licensing/deferred-items.md
  modified:
    - spec/receipt.schema.json
    - packages/spec/src/generated/receipt.ts
    - packages/spec/src/generated/schemas.ts
    - packages/spec/src/index.ts
    - packages/spec/src/jws.ts
    - packages/core/src/receipts/errors.ts
    - spec/vectors/README.md

key-decisions:
  - "Added publisherId and sig fields to AttestedClaimPayload (schema + regenerated types), since the 03-01 schema shipped only { kid, claimType, claimHash } - no signature field at all, and no publisher scope to resolve a two-level TrustStore lookup. Safe to extend: 03-01's own SUMMARY states this payload variant was schema-defined but not yet exercised by any committed vector, and CONTEXT.md's Claude's Discretion list explicitly covers exact JSON Schema field names for the payload shapes."
  - "Exported verifyDetached from @stint/spec's index.ts (previously internal-only per jws.ts's own docstring). The plan's acceptance criteria requires attested.ts to literally reuse @stint/spec's detached-verify function (\"no second Ed25519 verify path\"), and @stint/spec's package.json exports map exposes only \".\" and \"./testing\" - a deep subpath import would fail at runtime. Mirrors 03-01's identical precedent (re-exporting generated receipt/checkpoint types for the same reason)."
  - "Added a new claim_sig_invalid reason to RECEIPT_VERIFY_REASONS for a failed publisher signature, kept distinct from the existing hash-link break reasons (hash_mismatch/reordered/truncated/checkpoint_sig_invalid) per D-09's discretion over exact reason-code strings."
  - "origin in TimelineEntry is derived from which argument (verified/attested) an entry came from, not re-read from the entry's own chain field, keeping the display tag a property of the merge call itself."

patterns-established:
  - "Attested-chain trust resolution (publisherId -> kid -> Ed25519PublicJwk) is a structural mirror of verifyEnvelope's own lookup (ownEntry + readEd25519PublicJwk helpers reimplemented locally in attested.ts, since those small defensive helpers are not exported from @stint/spec - only the actual verify function is shared)."

requirements-completed: [RCPT-04, RCPT-05]

coverage:
  - id: D1
    description: "Attested-chain entries verify their publisher signature via @stint/spec's TrustStore/Ed25519PublicJwk and its exported verifyDetached (the same function verifyEnvelope uses); an unknown publisher, unknown kid, wrong key, or tampered claim all reject"
    requirement: RCPT-04
    verification:
      - kind: unit
        ref: "packages/core/test/receipts/attested-chain.test.ts (11 tests: golden verification, per-entry accept, unknown-kid/publisher/wrong-key/tampered-claim rejection, exact break-locus reporting, attested-only checkpoint anchoring)"
        status: pass
    human_judgment: false
  - id: D2
    description: "verifyAttestedChain's outcome is fully independent of the verified chain: corrupting a separate verified chain does not change the attested chain's verification result, and an attested checkpoint verifies only against its own key, never a verified-chain checkpoint's key"
    requirement: RCPT-04
    verification:
      - kind: unit
        ref: "packages/core/test/receipts/attested-chain.test.ts (independence describe block, 2 tests)"
        status: pass
    human_judgment: false
  - id: D3
    description: "mergeTimeline produces a display-only timeline marking every entry verified/attested exactly once, never mutating either input chain (proven over frozen chains), with verifyChain on both originals still ok afterward, deterministic ordering (ts, then origin, then seq) with no integrity meaning, and correct empty/single-chain edges"
    requirement: RCPT-05
    verification:
      - kind: unit
        ref: "packages/core/test/receipts/merge.test.ts (8 tests)"
        status: pass
    human_judgment: false

duration: ~40min
completed: 2026-09-28
status: complete
---

# Phase 3 Plan 3: Attested Chain and Display-Only Merged Timeline Summary

**The attested receipt chain now verifies independently through @stint/spec's own trust model (reusing its exported `verifyDetached`, never a second Ed25519 verify path), and `mergeTimeline` produces a pure, never-mutating, display-only timeline marking every entry verified or attested with an ordering that carries no integrity meaning.**

## Performance

- **Duration:** ~40 min
- **Completed:** 2026-09-28
- **Tasks:** 2 (both `type="auto" tdd="true"`, no checkpoints; plus one small doc-only follow-up commit)
- **Files modified:** 14 (7 created, 7 modified)

## Accomplishments

- Extended `AttestedClaimPayload` (`spec/receipt.schema.json`, regenerated `packages/spec/src/generated/receipt.ts`/`schemas.ts`) with `publisherId` and `sig` — the fields required to verify a publisher's claim signature at all, which the 03-01 schema did not yet carry (that payload variant was schema-defined but unexercised by any vector).
- Exported `verifyDetached` from `@stint/spec`'s public entry point (`packages/spec/src/index.ts`), with `packages/spec/src/jws.ts`'s docstring updated to document the new cross-package reuse — `signDetached` stays internal-only.
- Added `claim_sig_invalid` to `packages/core/src/receipts/errors.ts`'s `RECEIPT_VERIFY_REASONS`.
- Implemented `packages/core/src/receipts/attested.ts`: `verifyAttestedEntry` resolves the publisher's Ed25519 key from a caller-supplied `TrustStore` by `publisherId` then `kid` (mirroring `verifyEnvelope`'s own lookup) and verifies the signature via `@stint/spec`'s `verifyDetached`; `verifyAttestedChain` reuses `verifyChain` unmodified for the hash-link walk, then checks every `attested_claim` entry's signature, reporting the exact `brokenAtSeq`/`claim_sig_invalid` on the first failure.
- Authored `spec/vectors/receipts/attested-input.json` (2-entry attested chain) and `attested-trust-store.json` (the signing publisher's public key), generated via a scratch script using `jose`'s `generateKeyPair`/`FlattenedSign` and verified reproducible before committing; documented both in `spec/vectors/README.md`.
- Wrote `packages/core/test/receipts/attested-chain.test.ts` (11 tests): golden verification, per-entry acceptance, unknown-kid/unknown-publisher/wrong-key/tampered-claim rejection, exact break-locus reporting for both a signature failure and a hash-link break, independence from a corrupted verified chain, and an attested-only checkpoint that verifies against its own key and rejects a verified-chain key.
- Implemented `packages/core/src/receipts/merge.ts`: `mergeTimeline(verified, attested)` tags every entry with its origin (derived from which argument it came from), sorts stably by `ts` then `origin` then `seq`, and never mutates either input.
- Wrote `packages/core/test/receipts/merge.test.ts` (8 tests): empty/single-chain edges, every-entry-once-and-tagged, no-mutation over deep-frozen chains, `verifyChain` still `ok` on both originals after merge, ts-primary sort, and equal-timestamp adjacency (stable secondary/tertiary sort by origin then seq).
- Logged one pre-existing, out-of-scope regression (`packages/spec/test/codegen.test.ts`'s "detects stale types" test, broken since 03-01's `codegen.mjs` change, unrelated to this plan) to `.planning/phases/03-receipts-licensing/deferred-items.md` per the Scope Boundary rule.

## Task Commits

1. **Task 1: Tracer - attested chain independent verification via @stint/spec trust model** - `4206ca4` (test)
2. **Doc follow-up: document attested-\* vectors in spec/vectors/README.md** - `2a0e1f6` (docs)
3. **Task 2: mergeTimeline - display-only merged timeline marking verified/attested** - `51c79e6` (feat)

**Plan metadata:** pending (this commit)

## Files Created/Modified

- `packages/core/src/receipts/attested.ts` - verifyAttestedEntry/verifyAttestedChain
- `packages/core/src/receipts/merge.ts` - mergeTimeline/TimelineEntry
- `packages/core/test/receipts/attested-chain.test.ts` - 11 tests
- `packages/core/test/receipts/merge.test.ts` - 8 tests
- `spec/receipt.schema.json` - AttestedClaimPayload gains publisherId + sig
- `packages/spec/src/generated/receipt.ts`, `schemas.ts` - regenerated
- `packages/spec/src/index.ts` - exports verifyDetached
- `packages/spec/src/jws.ts` - docstring updated for the new export
- `packages/core/src/receipts/errors.ts` - RECEIPT_VERIFY_REASONS gains claim_sig_invalid
- `spec/vectors/receipts/attested-input.json`, `attested-trust-store.json` - new conformance vector
- `spec/vectors/README.md` - documents the new attested-\* vector files
- `.planning/phases/03-receipts-licensing/deferred-items.md` - logs the pre-existing codegen.test.ts regression

## Decisions Made

- Extended `AttestedClaimPayload` with `publisherId` + `sig` rather than working around the missing fields, since without them RCPT-04's core behavior (verify a publisher's signed claim) has no signature to check and no publisher to scope the trust-store lookup by. This was safe: 03-01's own SUMMARY documents this payload variant as schema-defined but unexercised by any committed vector, and CONTEXT.md's Claude's Discretion explicitly covers exact JSON Schema field names for payload shapes.
- Exported `verifyDetached` from `@stint/spec` rather than reimplementing a second `FlattenedSign`/`flattenedVerify` pair in `@stint/core`, per the plan's own acceptance criterion ("no second Ed25519 verify path is defined") and D-07's "reuse the same trust model" instruction — this is the literal same function `verifyEnvelope` calls, not a structural mirror of it.
- `origin` in `TimelineEntry` is derived from which argument (`verified`/`attested`) an entry came from, not re-read from the entry's own `chain` field, so the display tag is a property of the merge call itself rather than a second read of data the chain's own verification already covers.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing critical functionality] Added `publisherId` and `sig` fields to `AttestedClaimPayload`**
- **Found during:** Task 1
- **Issue:** The 03-01 schema's `AttestedClaimPayload` was `{ kid, claimType, claimHash }` — no signature field at all, and no `publisherId` to resolve a two-level `TrustStore` lookup the way `verifyEnvelope` does. Without a `sig` field there is nothing for `verifyAttestedEntry` to check; without `publisherId` there is no way to scope the `kid` lookup to a specific publisher's key set (the exact same two-level shape `TrustStore` already has).
- **Fix:** Added `publisherId` (string) and `sig` (string, the base64url detached EdDSA signature) to `AttestedClaimPayload` in `spec/receipt.schema.json`, regenerated `packages/spec/src/generated/receipt.ts`/`schemas.ts` via `pnpm codegen`. The signature covers the canonical bytes of `{ publisherId, kid, claimType, claimHash }` (payload minus `sig`).
- **Files modified:** spec/receipt.schema.json, packages/spec/src/generated/receipt.ts, packages/spec/src/generated/schemas.ts
- **Verification:** `pnpm --filter @stint/spec codegen:check` (via `node scripts/codegen.mjs --check`) passes; `pnpm typecheck` passes; `attested-chain.test.ts` exercises both fields directly (unknown-kid, unknown-publisher, tampered-claim rejection cases).
- **Committed in:** 4206ca4 (Task 1 commit)

**2. [Rule 3 - Blocking] Exported `verifyDetached` from `@stint/spec`'s index.ts**
- **Found during:** Task 1
- **Issue:** The plan's own acceptance criteria requires `attested.ts` to "reuse `@stint/spec`'s detached-verify function (assert the import; no second Ed25519 verify path is defined)" — but `packages/spec/src/jws.ts`'s own docstring stated `verifyDetached` was "Internal only — never re-exported from `./index.ts`", and `@stint/spec`'s `package.json` `exports` map exposes only `"."` and `"./testing"` (no deep subpath), so `@stint/core` had no way to import it at all.
- **Fix:** Added `export { verifyDetached } from "./jws.js";` to `packages/spec/src/index.ts`, and updated `jws.ts`'s docstring to explain the new cross-package reuse (Phase 3, D-07) while keeping `signDetached` internal-only. Mirrors 03-01's own precedent exactly (re-exporting generated receipt/checkpoint types for the identical reason — a deep-import path the exports map does not expose).
- **Files modified:** packages/spec/src/index.ts, packages/spec/src/jws.ts
- **Verification:** `pnpm typecheck` and `pnpm build` pass; `packages/core/src/receipts/attested.ts` compiles importing `verifyDetached` from `@stint/spec`; `packages/spec`'s own `envelope.test.ts`/`jws`-adjacent tests still pass unchanged (verified via targeted `vitest run --pool=threads` in `packages/spec`).
- **Committed in:** 4206ca4 (Task 1 commit)

**3. [Rule 2 - Missing functionality] Added `claim_sig_invalid` to `RECEIPT_VERIFY_REASONS`**
- **Found during:** Task 1
- **Issue:** The existing `RECEIPT_VERIFY_REASONS` vocabulary (`hash_mismatch | reordered | truncated | checkpoint_sig_invalid`) had no code for "an attested entry's publisher signature failed to verify" — a genuinely distinct failure mode from any hash-link break.
- **Fix:** Added `"claim_sig_invalid"` to the array in `packages/core/src/receipts/errors.ts`, per D-09's explicit discretion over exact reason-code strings beyond the examples it gives.
- **Files modified:** packages/core/src/receipts/errors.ts
- **Verification:** `attested-chain.test.ts`'s break-locus tests assert this exact reason string.
- **Committed in:** 4206ca4 (Task 1 commit)

**4. [Rule 2 - Missing documentation] Documented the new `attested-*` vectors in `spec/vectors/README.md`**
- **Found during:** immediately after Task 1's commit
- **Issue:** Every prior vector subdirectory (`jcs/`, `receipts/chain-*`, `receipts/checkpoint-*`, `envelope/`, `license/`) is documented in `spec/vectors/README.md`; the newly-added `attested-input.json`/`attested-trust-store.json` pair broke that established convention by omission.
- **Fix:** Added a paragraph documenting both files, matching the existing style exactly (what each file is, what a conforming implementation MUST accept/reject).
- **Files modified:** spec/vectors/README.md
- **Committed in:** 2a0e1f6 (separate small commit, since Task 1 had already been committed)

**5. [Rule 1 - Style] Prettier line-wrap reformatting carried onto Task 1's already-committed files**
- **Found during:** Task 2 (running `prettier --write` before committing Task 2's new files)
- **Issue:** `attested.ts`, `attested-chain.test.ts`, `packages/spec/src/index.ts`, and `packages/spec/src/jws.ts` (all touched in Task 1/its follow-up commit) had a few lines exceeding the project's configured line width.
- **Fix:** Accepted `prettier --write`'s reformatting (line-wrapping only, no logic change); re-ran `pnpm typecheck` and the full `packages/core/test/receipts` suite (40 tests) to confirm no behavior changed.
- **Files modified:** packages/core/src/receipts/attested.ts, packages/core/test/receipts/attested-chain.test.ts, packages/spec/src/index.ts, packages/spec/src/jws.ts
- **Committed in:** 51c79e6 (Task 2 commit, alongside Task 2's own changes, documented there)

### Out-of-scope discovery (logged, not fixed)

**`packages/spec/test/codegen.test.ts`'s "detects stale types" test fails with `ENOENT`, pre-existing since 03-01** — see `.planning/phases/03-receipts-licensing/deferred-items.md` for full detail. Root cause: 03-01's `codegen.mjs` change added `receipt.schema.json`/`checkpoint.schema.json` to its `targets` array, but this Phase-1-era test's temp `--schema-dir` fixture only copies `manifest.schema.json`/`envelope.schema.json`, so `codegen.mjs` now throws `ENOENT` before reaching the "stale" assertion. Not caused by this plan's changes (reproduces identically with or without them); out of this plan's `<verify>` scope (`packages/core/test/receipts/*`); logged per the Scope Boundary rule rather than fixed inline.

---

**Total deviations:** 5 auto-fixed (2 missing-functionality, 1 blocking, 1 missing-documentation, 1 style) + 1 out-of-scope discovery logged
**Impact on plan:** All five auto-fixes were necessary for this plan's own acceptance criteria to be satisfiable at all (the schema literally had no signature field to verify, and the reuse requirement was structurally blocked without the export). No scope creep beyond what RCPT-04/RCPT-05 required; the deferred codegen.test.ts item is logged, not fixed, exactly per the Scope Boundary rule.

## Issues Encountered

None beyond the deviations and the one out-of-scope discovery documented above.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `verifyAttestedEntry`/`verifyAttestedChain`/`mergeTimeline`/`TimelineEntry` are ready for 03-04's `ReceiptStore` contract-test work and public-API export (03-04-PLAN.md already names these exact symbols).
- The `AttestedClaimPayload` shape (`publisherId`, `kid`, `claimType`, `claimHash`, `sig`) is now the schema-locked normative shape any future attested-claim writer (Phase 4 proxy, Phase 5 teardown, Phase 7 mock publisher) must produce.
- `.planning/phases/03-receipts-licensing/deferred-items.md`'s `codegen.test.ts` regression remains open for whichever future plan/phase next touches `packages/spec/scripts/codegen.mjs` or its test suite.
- No blockers identified for the remaining Phase 3 plans (03-04, 03-06).

## Self-Check: PASSED

All key files confirmed present on disk (`attested.ts`, `merge.ts`, `attested-chain.test.ts`, `merge.test.ts`, `attested-input.json`, `deferred-items.md`, via direct `[ -f ... ]` checks) and all three task commits (`4206ca4`, `2a0e1f6`, `51c79e6`) confirmed present via `git log --oneline --all | grep`.

---
*Phase: 03-receipts-licensing*
*Completed: 2026-09-28*
