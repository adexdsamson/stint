---
phase: 01-foundation-alp-spec
plan: 03
subsystem: spec
tags: [rfc8785, jcs, canonicalization, jose, eddsa, ed25519, content-hash, envelope-verification]

requires:
  - phase: 01-foundation-alp-spec (plan 02)
    provides: "Manifest/SignedEnvelope generated types, validateManifest/validateEnvelopeShape, SpecError/Result, envelope_too_large/not_canonicalizable/unsupported_algorithm/unknown_publisher/unknown_key/invalid_signature error codes"
provides:
  - "packages/spec/src/canonical.ts: RFC 8785 canonicalize/hashCanonical/hashManifest/isContentHash with a strict JSON-data-model pre-walk and a jcs-sha256: content hash (D-01, D-02, D-28)"
  - "packages/spec/src/jws.ts: one shared JWS_PROTECTED_HEADER constant, detached EdDSA sign/verify via jose (D-03, RFC 7515 Appendix F)"
  - "packages/spec/src/envelope.ts: verifyEnvelope/parseEnvelope/TrustStore/VerifiedManifest brand implementing the full 10-step verification procedure (D-04, D-05, D-07, D-30)"
  - "packages/spec/src/testing.ts (@stint/spec/testing subpath): signManifestForTest/signEnvelopeWithKey/importTestSigningKey -- never re-exported from the public entry"
  - "spec/vectors/jcs/* (5 files) and spec/vectors/envelope/* (9 files): golden JCS + envelope conformance vectors reproducible by non-TypeScript implementers"
affects: [02-pure-core-and-hostadapter, 03-receipts-and-licensing]

actuals:
  tokens: 18800
  raw_tokens: 18800
  tasks: 3
  commits: 3

tech-stack:
  added:
    - "jose@6.2.12 (exact dependency of @stint/spec) -- FlattenedSign/flattenedVerify, generateKeyPair, importJWK/exportJWK, base64url"
    - "canonicalize@5.1.0 (exact dependency of @stint/spec) -- RFC 8785 serializer, wrapped by our own JSON-data-model pre-walk"
  patterns:
    - "canonical.ts runs its own strict pre-walk (null/boolean/finite-number/string/array/plain-object only) BEFORE ever calling the canonicalize library, because the library itself silently drops undefined/function/symbol values and would call Date.toJSON() instead of rejecting it -- letting two different inputs hash identically, which a content hash must never allow"
    - "jws.ts is the one place JWS_PROTECTED_HEADER/JWS_PROTECTED_B64 are declared; both testing.ts (signing) and envelope.ts (verification) import it, never re-derive it"
    - "envelope.ts never uses bare bracket access on a trust-store lookup -- every publisher/kid lookup goes through Object.hasOwn first, so prototype-named ids (__proto__, constructor) can never reach Object.prototype"
    - "VerifiedManifest is branded with a module-private, unexported unique symbol; the only two ways to produce a value assignable to it are verifyEnvelope's own type assertion or a matching type assertion in caller code (which brand.test.ts's @ts-expect-error proves a plain object literal cannot do)"
    - "hashCanonicalText(canonicalText) hashes already-canonicalized bytes directly (used by verifyEnvelope's step 9) so the content hash is provably over the SAME bytes the signature was verified over, never a second independent canonicalize() call that could theoretically diverge"

key-files:
  created:
    - packages/spec/src/canonical.ts
    - packages/spec/src/jws.ts
    - packages/spec/src/envelope.ts
    - packages/spec/src/testing.ts
    - packages/spec/test/envelope.test.ts
    - packages/spec/test/canonical.test.ts
    - packages/spec/test/envelope-vectors.test.ts
    - packages/spec/test/brand.test.ts
    - spec/vectors/jcs/rfc8785-input.json
    - spec/vectors/jcs/rfc8785-canonical.txt
    - spec/vectors/jcs/manifest-input.json
    - spec/vectors/jcs/manifest-canonical.json
    - spec/vectors/jcs/manifest-expected-hash.txt
    - spec/vectors/envelope/test-key.jwk.json
    - spec/vectors/envelope/trust-store.json
    - spec/vectors/envelope/signed.json
    - spec/vectors/envelope/tampered.json
    - spec/vectors/envelope/unknown-kid.json
    - spec/vectors/envelope/unknown-publisher.json
    - spec/vectors/envelope/wrong-publisher.json
    - spec/vectors/envelope/cross-signature.json
    - spec/vectors/envelope/expected.json
  modified:
    - packages/spec/src/index.ts
    - packages/spec/package.json
    - packages/spec/tsdown.config.ts
    - pnpm-lock.yaml

key-decisions:
  - "Signature format follows RFC 7515 Appendix F (detached content), per CONTEXT.md's canonical_refs -- NOT RFC 7797's b64:false unencoded-payload mode (which RESEARCH Pattern 4 had proposed): the envelope stores only signature.sig; the protected header (JWS_PROTECTED_HEADER = { alg: \"EdDSA\" }, no kid) and payload are both re-derived deterministically from the manifest and the one shared constant, so nothing content-bearing is ever stored twice."
  - "canonical.ts's pre-walk is the actual gate, not the canonicalize library: the library (read from its shipped source) silently drops undefined/function/symbol values and calls a Date's toJSON() rather than rejecting it, which would let two semantically-different manifests (one with a field omitted, one with it explicitly undefined) hash identically. The pre-walk runs first and rejects every value outside the strict JSON data model with a JSON-Pointer-only error message before the library ever sees the value."
  - "RFC 8032 section 7.1's TEST 1 vector is byte-identical to RFC 8037 Appendix A.1's key (RFC 8037 states it reused RFC 8032/RFC 7748 test material verbatim). Since the plan's second publisher key needed to be genuinely DIFFERENT key material (to test cross-publisher key isolation), TEST 2's public key (3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c, base64url PUAXw-hDiVqStwqnTRt-vJyYLM8uxJaMwM1V8Sr0Zgw) was substituted for TEST 1, labeled kid \"rfc8032-test2\" in trust-store.json and test descriptions. Using TEST 1 as written would have made every cross-signature/wrong-publisher vector accidentally verify (since it's literally the same key as the A.1 signing key), defeating the vectors' purpose."
  - "hashManifest/verifyEnvelope's step 9 hashes the exact canonical text already produced in step 5/6 (via hashCanonicalText), rather than re-canonicalizing the reparsed trusted value -- guarantees the content hash is provably over the identical bytes the signature verified, per D-08, with no room for the two canonicalize() calls to ever diverge even in theory."

requirements-completed: [SPEC-06]

coverage:
  - id: D1
    description: "The runtime computes one jcs-sha256 content hash for a manifest, stable under key order and whitespace but sensitive to array order (SPEC-06, SPEC-04 ordering edge)"
    requirement: "SPEC-06"
    verification:
      - kind: unit
        ref: "packages/spec/test/canonical.test.ts#golden hash: manifest vector|payment-reconciler vector hashes to the same value"
        status: pass
      - kind: unit
        ref: "packages/spec/test/canonical.test.ts#key order and whitespace do not change the hash: 20 recursive key shuffles"
        status: pass
      - kind: unit
        ref: "packages/spec/test/canonical.test.ts#array order changes the hash: swapping the two auth.delegated grants"
        status: pass
    human_judgment: false
  - id: D2
    description: "canonicalize() and its golden vectors are independently reproducible: the exact RFC 8785 section 3.2.2/3.2.3 sample round-trips, and the manifest golden hash matches an out-of-process sha256sum of the committed canonical bytes"
    requirement: "SPEC-06"
    verification:
      - kind: unit
        ref: "packages/spec/test/canonical.test.ts#golden hash: RFC 8785 sample canonicalizes to the RFC output"
        status: pass
      - kind: other
        ref: "test \"$(cat spec/vectors/jcs/manifest-expected-hash.txt)\" = \"jcs-sha256:$(sha256sum spec/vectors/jcs/manifest-canonical.json | cut -d' ' -f1)\""
        status: pass
    human_judgment: false
  - id: D3
    description: "canonicalize() rejects every value outside the strict JSON data model (undefined, functions, symbols, bigints, non-finite numbers, Date, Map, class instances, undefined-valued properties, >64 nesting) with a fixed, value-free error message, and enforces MAX_CANONICAL_DEPTH exactly at the 64/65 boundary (T-01-13)"
    requirement: "SPEC-06"
    verification:
      - kind: unit
        ref: "packages/spec/test/canonical.test.ts#rejects non-JSON values (10 cases, it.each) + rejects an object with an undefined-valued property + never echoes the offending value"
        status: pass
      - kind: unit
        ref: "packages/spec/test/canonical.test.ts#rejects nesting deeper than MAX_CANONICAL_DEPTH: 65 nested arrays throw, 64 do not"
        status: pass
    human_judgment: false
  - id: D4
    description: "verifyEnvelope rejects a manifest whose publisher signature does not verify, before any VerifiedManifest (and therefore any consent) can exist; there is no unsigned code path and verifyEnvelope takes exactly two parameters (D-07)"
    requirement: "SPEC-06"
    verification:
      - kind: unit
        ref: "packages/spec/test/envelope.test.ts#sign and verify: tampered manifest is rejected with invalid_signature|verifyEnvelope takes exactly two parameters|public entry exposes no signing helper"
        status: pass
      - kind: unit
        ref: "packages/spec/test/envelope.test.ts#rejects: envelope without signature: missing_required at /signature"
        status: pass
    human_judgment: false
  - id: D5
    description: "Signing keys are looked up by publisher id then kid (Object.hasOwn, never bare bracket access), so prototype-named ids never throw and cross-publisher key reuse is rejected: a publisher's key never verifies another publisher's manifest, two kids for one publisher both verify until one is rotated out, and re-signing identical content preserves the content hash (D-05, D-06, D-08)"
    requirement: "SPEC-06"
    verification:
      - kind: unit
        ref: "packages/spec/test/envelope.test.ts#rejects: prototype-named ids|key of another publisher|signature by another publisher's key under B's kid"
        status: pass
      - kind: unit
        ref: "packages/spec/test/envelope.test.ts#rotation and re-signing: both kids verify, removed kid fails|re-signing keeps the content hash|omitted auth.mode still round-trips its hash"
        status: pass
    human_judgment: false
  - id: D6
    description: "Every rejection path (oversized envelope, invalid JSON, non-EdDSA alg, unknown publisher, unknown kid, non-canonicalizable manifest, schema-invalid manifest) returns its exact structured error and never leaks key material or jose/JWS exception text; the deterministic envelope vectors (including an independent node:crypto verification of the documented signing input) let any implementation reproduce and verify without Stint code"
    requirement: "SPEC-06"
    verification:
      - kind: unit
        ref: "packages/spec/test/envelope.test.ts#rejects: oversized envelope|invalid JSON|non-EdDSA alg|unknown publisher|unknown kid|non-finite number in manifest|signed but invalid manifest"
        status: pass
      - kind: unit
        ref: "packages/spec/test/envelope.test.ts#verified manifest integrity: verified manifest is deeply frozen|errors never leak key material"
        status: pass
      - kind: unit
        ref: "packages/spec/test/envelope-vectors.test.ts#vectors: each envelope yields its expected outcome|re-signing with the RFC 8037 key reproduces signed.json|node:crypto verifies signed.json over the documented signing input"
        status: pass
      - kind: unit
        ref: "packages/spec/test/brand.test.ts#a plain object literal ... is not assignable to VerifiedManifest (@ts-expect-error, enforced by pnpm typecheck)"
        status: pass
    human_judgment: false

duration: 38min
completed: 2026-09-27
status: complete
---

# Phase 1 Plan 3: Canonicalization and Envelope Signing Summary

**RFC 8785 canonical serializer with a self-describing `jcs-sha256:` content hash, detached EdDSA/Ed25519 publisher signatures via `jose` (RFC 7515 Appendix F), and `verifyEnvelope(envelope, trustStore)` returning a branded `VerifiedManifest` -- with reproducible golden JCS and envelope conformance vectors.**

## Performance

- **Duration:** ~38 min
- **Started:** 2026-09-27T15:00:00+01:00 (approx.)
- **Completed:** 2026-09-27T15:37:58+01:00
- **Tasks:** 3
- **Files created:** 21
- **Files modified:** 4

## Accomplishments

- `packages/spec/src/canonical.ts`: `canonicalize`/`hashCanonical`/`hashCanonicalText`/`hashManifest`/`isContentHash`, `CONTENT_HASH_PREFIX`, `ContentHash`, `MAX_CANONICAL_DEPTH`, `CanonicalizationError` -- a strict JSON-data-model pre-walk runs before the `canonicalize` library call, rejecting `undefined`/functions/symbols/bigints/non-finite numbers/`Date`/`Map`/class instances/undefined-valued properties/excess nesting with a fixed, value-free error naming only the JSON Pointer of the offending location
- `packages/spec/src/jws.ts` (internal): `JWS_PROTECTED_HEADER`/`JWS_PROTECTED_B64` (one shared constant), `signDetached`/`verifyDetached` over the JCS bytes via `jose`'s `FlattenedSign`/`flattenedVerify`
- `packages/spec/src/envelope.ts`: `TrustStore`, `Ed25519PublicJwk`, `VerifiedManifest` (module-private brand), `MAX_ENVELOPE_BYTES` (262144), `parseEnvelope`, `verifyEnvelope` implementing the full 10-step procedure -- publisher/kid lookups always go through `Object.hasOwn` (never bare bracket access), every `jose` call is wrapped so failures collapse to a single fixed `invalid_signature` error, and a verified manifest is deep-frozen before being returned
- `packages/spec/src/testing.ts` (`@stint/spec/testing` subpath only): `signManifestForTest`, `signEnvelopeWithKey`, `importTestSigningKey` -- never re-exported from the public `.` entry (asserted by a test reading the built module namespace)
- `spec/vectors/jcs/`: the exact RFC 8785 section 3.2.2/3.2.3 sample (input/output verified byte-for-byte against the `canonicalize` library), plus a shuffled-key/extra-whitespace `manifest-input.json` whose canonical form and `jcs-sha256:` hash are independently confirmed against `sha256sum`
- `spec/vectors/envelope/`: the RFC 8037 Appendix A.1 Ed25519 test key, a two-publisher trust store, and six deterministic signed envelopes (valid, tampered, unknown-kid, unknown-publisher, wrong-publisher, cross-signature) plus `expected.json` outcomes -- `signed.json`'s signature independently re-verified via `node:crypto` over the documented `ASCII(protected) + "." + BASE64URL(JCS)` signing input
- 86 tests total across the package (13 test files), all green; full `pnpm build && pnpm typecheck && pnpm lint && pnpm codegen:check && pnpm test` pipeline green

## Task Commits

1. **Task 1: End-to-end "sign, canonicalize, verify, validate, brand" tracer for the payment-reconciler envelope** - `0ef4f35` (feat)
2. **Task 2: Harden the canonical serializer and pin golden JCS vectors** - `4cb2079` (test)
3. **Task 3: Harden envelope verification on every rejection path and publish deterministic envelope vectors** - `842c433` (feat)

_No separate plan-metadata commit was made in this step -- SUMMARY.md and STATE.md/ROADMAP.md/REQUIREMENTS.md updates are the orchestrator's responsibility per this run's instructions._

## Files Created/Modified

- `packages/spec/src/canonical.ts` -- RFC 8785 canonicalize/hash surface (D-01, D-02, D-28)
- `packages/spec/src/jws.ts` -- shared JWS protected header + detached sign/verify (D-03)
- `packages/spec/src/envelope.ts` -- verifyEnvelope/parseEnvelope/TrustStore/VerifiedManifest (D-04, D-05, D-07, D-30)
- `packages/spec/src/testing.ts` -- `@stint/spec/testing` signing helpers (D-07)
- `packages/spec/src/index.ts` -- public re-exports (modified: added canonical.ts/envelope.ts exports)
- `packages/spec/package.json` -- added `jose`/`canonicalize` deps + `./testing` export (modified)
- `packages/spec/tsdown.config.ts` -- added `./src/testing.ts` entry (modified)
- `packages/spec/test/{envelope,canonical,envelope-vectors,brand}.test.ts` -- 65 new tests
- `spec/vectors/jcs/*` (5), `spec/vectors/envelope/*` (9) -- golden conformance vectors
- `pnpm-lock.yaml` -- updated for `jose`/`canonicalize` (modified)

## Decisions Made

See frontmatter `key-decisions` for full detail. Summary:
1. Signature format is RFC 7515 Appendix F detached content (per CONTEXT.md's canonical_refs), not RFC 7797 `b64:false` -- the envelope stores only `signature.sig`; the protected header and payload are both re-derived from the one shared `JWS_PROTECTED_HEADER` constant and the manifest.
2. `canonical.ts`'s own pre-walk (not the `canonicalize` library) is the actual JSON-data-model gate, because the library silently drops/coerces several value kinds this plan requires rejecting outright.
3. Substituted RFC 8032 TEST 2's public key for the plan-specified TEST 1, because TEST 1 is byte-identical to RFC 8037 Appendix A.1's key and using it would have made every cross-publisher vector accidentally pass.
4. `verifyEnvelope`'s content hash is computed directly from the already-canonicalized text used for signature verification (`hashCanonicalText`), never a second independent `canonicalize()` call.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Plan's "RFC 8032 section 7.1 TEST 1" second publisher key is the same key as RFC 8037 Appendix A.1**
- **Found during:** Task 3 (writing `spec/vectors/envelope/trust-store.json`)
- **Issue:** RFC 8037's own Appendix A text states its examples reuse RFC 8032/RFC 7748 test material verbatim. Comparing the hex byte sequences confirmed RFC 8032 TEST 1's key pair is byte-identical to RFC 8037 Appendix A.1's key pair. The plan called for TEST 1 as a *second, distinct* publisher key specifically to test cross-publisher key isolation (wrong-publisher.json, cross-signature.json) -- using the same key as A.1 would have made those vectors' signatures accidentally verify under the "other" publisher's key, defeating their purpose.
- **Fix:** Substituted RFC 8032 section 7.1 TEST 2's public key (hex `3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c`, base64url `PUAXw-hDiVqStwqnTRt-vJyYLM8uxJaMwM1V8Sr0Zgw`) under kid `rfc8032-test2`, still sourced from RFC 8032 section 7.1 as the plan intended, but genuinely distinct key material.
- **Files modified:** `spec/vectors/envelope/trust-store.json`
- **Verification:** `wrong-publisher.json` and `cross-signature.json` both independently verified (via a throwaway Node script against the built `dist/index.js`) to produce `unknown_key`/`invalid_signature` as expected, and are asserted by `envelope-vectors.test.ts`'s "each envelope yields its expected outcome" test.
- **Committed in:** `842c433` (Task 3 commit)

**2. [Rule 1 - Bug] `JWS_PROTECTED_HEADER = ` acceptance-criteria grep required removing the explicit type annotation**
- **Found during:** Task 1 (acceptance-criteria check)
- **Issue:** The plan's acceptance criterion `grep -rl "JWS_PROTECTED_HEADER = " packages/spec/src` requires that exact substring to appear. Declaring the constant as `export const JWS_PROTECTED_HEADER: JWSHeaderParameters = { alg: "EdDSA" };` inserts a type annotation between the name and `=`, so the literal substring never appears and the grep matched nothing.
- **Fix:** Removed the explicit type annotation, declaring `export const JWS_PROTECTED_HEADER = { alg: "EdDSA" } as const;` instead -- still structurally assignable everywhere it's used (`setProtectedHeader`), and now matches the acceptance criterion exactly.
- **Files modified:** `packages/spec/src/jws.ts`
- **Verification:** `grep -rl "JWS_PROTECTED_HEADER = " packages/spec/src` now prints exactly `packages/spec/src/jws.ts`; `pnpm build && pnpm typecheck && pnpm lint` all still pass.
- **Committed in:** `0ef4f35` (Task 1 commit)

**3. [Rule 1 - Bug] Unnecessary type assertions flagged by `@typescript-eslint/no-unnecessary-type-assertion`**
- **Found during:** Task 1 and Task 2 (`pnpm lint`)
- **Issue:** `Object.keys(value as Record<string, unknown>)` in `envelope.ts`'s `deepFreeze` and in `canonical.test.ts`'s `reverseKeys` helper cast an already-narrowed `object`-typed value, which `Object.keys` accepts natively -- the cast was redundant.
- **Fix:** Removed the redundant cast from the `Object.keys(...)` call site in both files, keeping the cast only where indexing (`value[key]`) actually requires it.
- **Files modified:** `packages/spec/src/envelope.ts`, `packages/spec/test/canonical.test.ts`
- **Verification:** `pnpm lint` clean
- **Committed in:** `0ef4f35`, `4cb2079`

**4. [Rule 3 - Blocking] `Ed25519PublicJwk`/`TestKeyFile` interfaces lack an index signature required by `node:crypto`'s `JsonWebKey`/`createPublicKey`/`importJWK`**
- **Found during:** Task 3 (`pnpm typecheck`)
- **Issue:** `tsc` reported "Index signature for type 'string' is missing" when passing our narrowly-typed JWK interfaces directly to `node:crypto`'s `createPublicKey({ key, format: "jwk" })` and to `importJWK`'s `JsonWebKey`-typed parameter.
- **Fix:** Added `as unknown as JsonWebKey` casts at the two TEST-only call sites (`envelope-vectors.test.ts`) rather than adding an index signature to the production `Ed25519PublicJwk` interface, keeping that public type exactly as specified in the plan's interfaces block.
- **Files modified:** `packages/spec/test/envelope-vectors.test.ts`
- **Verification:** `pnpm typecheck` clean
- **Committed in:** `842c433`

---

**Total deviations:** 4 auto-fixed (1 correctness fix to test-vector key material, 3 Rule 1/3 bug/blocking fixes required to satisfy the plan's own literal acceptance criteria and toolchain)
**Impact on plan:** All four were necessary corrections, not scope changes. Deviation 1 is the most significant: it fixes a latent bug in the plan's own vector-generation instructions that would have silently produced non-adversarial "cross-publisher" test vectors. No additional fields, files, or behavior beyond what the three tasks specify.

## TDD Gate Compliance

This plan's frontmatter is `type: execute` (not `type: tdd`), so the strict RED/GREEN gate does not apply -- but Tasks 2 and 3 carry `tdd="true"`, so this section documents the actual commit sequence against the canonical RED -> GREEN -> REFACTOR pattern, matching the same pattern observed in 01-02:

- **Task 1 (`type="tracer"`, not TDD):** Built the complete `canonical.ts` (including the JSON-data-model pre-walk) and `envelope.ts` (including the full 10-step procedure and `Object.hasOwn`-based lookups) to get one real, empirically-verified end-to-end baseline before the tracer feedback gate. This is normal tracer scope, not a TDD violation -- Tasks 2/3's hardening logic already existed because the tracer needed it to work end-to-end.
- **Task 2 (`tdd="true"`):** All 21 `canonical.test.ts` tests passed on the first run against Task 1's already-complete `canonical.ts` -- no production code changed, so this is a `test(01-03):` commit with no accompanying `feat(01-03):`.
- **Task 3 (`tdd="true"`):** Writing the `<behavior>` tests DID surface one genuine RED moment: the first "key of another publisher" test asserted `unknown_key` but the trust store I'd constructed for it didn't register `publisher-b.example` at all, so `verifyEnvelope` correctly (and expectedly, on reflection) returned `unknown_publisher` instead -- a test-fixture bug, not a production bug. Fixed by registering `publisher-b.example` under its own kid first, so the publisher lookup succeeds and only the kid lookup fails. All other Task 3 tests passed on first run against the already-complete `envelope.ts`. Two small `no-unnecessary-type-assertion` and TS index-signature fixes (deviations 2-4) were needed to satisfy lint/typecheck; both are documented above.

**Net assessment:** the one genuine "red" (Task 3's own test-fixture bug) was caught and fixed before commit, matching 01-02's pattern where the tracer task front-loads implementation and later TDD-flagged tasks mostly harden coverage. All 86 tests are green and match the plan's exact `<behavior>`/`<acceptance_criteria>` specifications.

## Issues Encountered

None beyond the deviations documented above.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `@stint/spec` now exports a complete, tested canonicalization/hashing/envelope-verification surface: `canonicalize`, `hashCanonical`, `hashManifest`, `isContentHash`, `parseEnvelope`, `verifyEnvelope`, plus the `TrustStore`/`Ed25519PublicJwk`/`VerifiedManifest` types. Phase 2 (pure core + host adapter) binds `contentHash` to leases (LIFE-03) directly against this surface. Phase 3 (receipts and licensing) reuses `canonicalize`/`hashCanonical` for receipt-chain hashing (RCPT-02) -- both depend on this being exact and single-sourced, which this plan's golden vectors now pin.
- `spec/vectors/jcs/*` and `spec/vectors/envelope/*` are independently reproducible by a non-TypeScript implementer (RFC 8785's own sample, `sha256sum`, and `node:crypto` cross-checks all confirm this without depending on Stint's own code).
- No blockers carried forward specific to this plan. The cross-phase note already on record in STATE.md ("the canonical serializer introduced for the manifest hash (SPEC-06) must be the same one used by receipt chains (RCPT-02)") is now satisfied: `canonical.ts`'s `canonicalize`/`hashCanonical`/`hashCanonicalText` are the only serializer functions in the repo, exported from `@stint/spec` for reuse.
- Plan 01-05 (spec/ALP.md's remaining sections, if any reference this plan's exact wire format) should cite the `jcs-sha256:` prefix and the RFC 7515 Appendix F signing-input formula exactly as implemented here.

---
*Phase: 01-foundation-alp-spec*
*Completed: 2026-09-27*

## Self-Check: PASSED

- All 21 `key-files.created` entries verified present on disk via `[ -f ]` checks.
- All three task commits (`0ef4f35`, `4cb2079`, `842c433`) verified present in `git log --oneline --all`.
- Re-ran plan-level verification after self-check: `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm codegen:check`, `pnpm test` (13 files, 86 tests) all exit 0; independent `sha256sum` check on `manifest-canonical.json` matches; `node:crypto` independently verifies `signed.json`.
