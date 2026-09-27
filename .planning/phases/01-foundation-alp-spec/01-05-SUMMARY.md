---
phase: 01-foundation-alp-spec
plan: 05
subsystem: spec
tags: [alp-spec, manifest, envelope, jws, jcs, consent, conformance, ci]

requires:
  - phase: 01-foundation-alp-spec (plan 02)
    provides: "spec/manifest.schema.json (draft-07), spec/vectors/valid/payment-reconciler.json"
  - phase: 01-foundation-alp-spec (plan 03)
    provides: "packages/spec/src/{canonical,jws,envelope}.ts (jcs-sha256: content hash, JWS_PROTECTED_HEADER/B64, verifyEnvelope's 10-step procedure), spec/vectors/{jcs,envelope}/*"
  - phase: 01-foundation-alp-spec (plan 04)
    provides: "spec/ALP.md sections 1-3, 7.1-7.6, 8-14, 16 and scripts/check-alp-sections.mjs, with sections 4, 5, 6 and 15 left as ALP-PENDING markers"
provides:
  - "spec/ALP.md complete: section 4 (Manifest) prose walkthrough with a checker-bound annotated example, section 5 (Signed Manifest Envelope and Content Hash) with the exact JWS signing input and 10-step verification procedure, section 6 (Consent) with required display content and a sequenceDiagram, section 15 (Conformance) with Runtime/Publisher classes"
  - "spec/vectors/README.md documenting valid/, invalid/, jcs/ and envelope/ for non-TypeScript implementers"
  - "scripts/check-alp-sections.mjs: annotated-example deep-equality against the payment-reconciler vector, schema-not-pasted rule, global ALP-PENDING rejection, three-sequenceDiagram minimum, section 5/6/15 required-phrase checks"
affects: []

actuals:
  tokens: 8450
  raw_tokens: 8450
  tasks: 2
  commits: 2

tech-stack:
  added: []
  patterns:
    - "The section 4 annotated example is not hand-copied prose; it is checker-enforced to deep-equal spec/vectors/valid/payment-reconciler.json's manifest member, so the spec document and the shipped conformance vector can never silently drift apart"
    - "ALP.md never cites this project's own internal decision labels (D-01, D-32, etc.); those stay in .planning/ as traceability notes, while the shipped spec reads as a self-contained normative document with only RFC/section cross-references"
    - "Conformance (Section 15) explicitly separates the normative accept/reject outcome (what a conforming implementation MUST match) from Stint's own structured error-code vocabulary (an implementation detail), so a non-TypeScript implementation is never obligated to reproduce Stint's exact error shape"

key-files:
  created:
    - spec/vectors/README.md
  modified:
    - spec/ALP.md
    - scripts/check-alp-sections.mjs

key-decisions:
  - "The 'Annotated example' label in section 4 uses bold inline text (`**Annotated example.**`) rather than a markdown sub-heading, because the checker's own `getSection` helper treats any `##`/`###` line as a section boundary; a `### Annotated example` sub-heading would have silently truncated the section-4 body the checker itself reads, cutting off the very json block the drift check needs to see."
  - "spec/vectors/README.md documents the envelope trust store's second publisher key as RFC 8032 Section 7.1 TEST 2 (kid `rfc8032-test2`), not TEST 1 as the original 01-03 plan text specified, matching what 01-03 actually shipped after that plan's own Rule 1 deviation (TEST 1 is byte-identical to the RFC 8037 A.1 key already used for the first publisher, so TEST 1 would have made every cross-publisher rejection vector accidentally verify)."
  - "The commit for this plan was split into two atomic per-task commits (Task 1: section 4 plus its checker rules; Task 2: sections 5/6/15, the vectors README, and the remaining checker rules) even though both tasks' content was drafted together, by temporarily reverting the Task 2 portions, committing Task 1's slice, then restoring and committing Task 2's slice — preserving the plan's declared task boundaries in git history without re-deriving either task's prose from scratch."

requirements-completed: [SPEC-01, SPEC-02, SPEC-06]

coverage:
  - id: D1
    description: "ALP.md section 4 walks through every manifest field in prose, links to spec/manifest.schema.json without duplicating it, and its annotated example is byte-for-byte the manifest in spec/vectors/valid/payment-reconciler.json, checker-enforced"
    requirement: "SPEC-02"
    verification:
      - kind: other
        ref: "node scripts/check-alp-sections.mjs (manifest.schema.json link check, annotated-example deep-equality against the vector, no quoted \"additionalProperties\" anywhere in the document)"
        status: pass
      - kind: other
        ref: "negative test: mutating the annotated example's max_duration_seconds from 3600 to 7200 makes the checker reject with \"annotated example drifted from vector\""
        status: pass
    human_judgment: false
  - id: D2
    description: "ALP.md section 5 lets a non-TypeScript implementer reproduce the content hash and verify a publisher signature from prose alone: jcs-sha256 over RFC 8785 UTF-8 bytes, and an Ed25519 signature over ASCII(eyJhbGciOiJFZERTQSJ9) + \".\" + BASE64URL(JCS(manifest))"
    requirement: "SPEC-06"
    verification:
      - kind: other
        ref: "node scripts/check-alp-sections.mjs (section 5 contains \"jcs-sha256:\", \"eyJhbGciOiJFZERTQSJ9\" and \"RFC 8785\", and quotes the golden hash from spec/vectors/jcs/manifest-expected-hash.txt)"
        status: pass
      - kind: other
        ref: "negative test: replacing eyJhbGciOiJFZERTQSJ9 with a different base64url header everywhere in the document makes the checker reject with a missing-phrase failure in section 5"
        status: pass
    human_judgment: false
  - id: D3
    description: "ALP.md section 5 states the verification order normatively: envelope shape, publisher-scoped key lookup by kid, signature over canonical bytes, then manifest validation, all before consent; unsigned manifests are never accepted and the lease binds the manifest content hash, not the envelope"
    requirement: "SPEC-06"
    verification:
      - kind: other
        ref: "manual cross-check of the section 5 ten-step procedure against packages/spec/src/envelope.ts's verifyEnvelope implementation and 01-03-PLAN.md's \"verifyEnvelope procedure\" section: exact step order confirmed (shape, publisher lookup, kid lookup, canonicalize, verify, re-parse, validate, hash, mint)"
        status: pass
    human_judgment: true
    rationale: "The checker proves the required phrases and the golden hash are present, but whether the ten-step prose is a faithful, unambiguous restatement of the implemented procedure (readable and reproducible by someone who has never seen the TypeScript) is a reading-comprehension judgment, deferred to the phase's end-of-phase human review alongside D6 below."
  - id: D4
    description: "ALP.md section 6 requires that consent is requested only for a verified manifest with a supported spec_version, lists what the consent display must show, and marks cleanup retention claims as attested"
    requirement: "SPEC-01"
    verification:
      - kind: other
        ref: "node scripts/check-alp-sections.mjs (section 6 contains \"attested\"); manual check that section 6's bulleted display requirements name agent, publisher, scopes, limits, approvals, resolved auth mode, verifier type and cleanup, with publisher_retains explicitly labelled attested, not a runtime-verified guarantee"
        status: pass
    human_judgment: false
  - id: D5
    description: "ALP.md section 15 defines Runtime and Publisher conformance classes and points to spec/vectors/, whose README explains every vector directory and its expected outcomes"
    requirement: "SPEC-01"
    verification:
      - kind: other
        ref: "node scripts/check-alp-sections.mjs (section 15 contains \"Runtime\", \"Publisher\" and \"spec/vectors/\"); spec/vectors/README.md verified present on disk, documenting valid/, invalid/ (including \"expected_errors\"), jcs/ and envelope/, plus the test-key warning"
        status: pass
    human_judgment: false
  - id: D6
    description: "ALP.md has no remaining interim section markers and holds at least three sequence diagrams (consent, tool call, teardown) plus the state diagram"
    requirement: "SPEC-01"
    verification:
      - kind: other
        ref: "node scripts/check-alp-sections.mjs (global ALP-PENDING rejection; at least three mermaid sequenceDiagram blocks found: consent in section 6, tool call in section 9, teardown in section 10; the section 7.1 stateDiagram-v2 from plan 01-04 is unchanged)"
        status: pass
      - kind: other
        ref: "negative test: appending a bare \"ALP-PENDING: 01-05\" line (no HTML comment) makes the checker reject with \"document still contains an \\\"ALP-PENDING\\\" marker\""
        status: pass
    human_judgment: false
  - id: D7
    description: "A newcomer can learn the full protocol from spec/ALP.md alone: the eleven states and transitions, the seven actors (agent never one), the three auth modes, the teardown order, receipts, the trust model and its four limits, and can reproduce the content hash and signature check from section 5 alone"
    requirement: "SPEC-01"
    verification:
      - kind: manual_procedural
        ref: "full end-to-end read-through of the committed spec/ALP.md performed during this plan's execution"
        status: pass
    human_judgment: true
    rationale: "This is the plan's own must_haves truth for SPEC-01's human-only acceptance row (VALIDATION.md manual-only row). The checker only proves structural and phrase-level facts; whether the completed document actually reads as coherent and learnable end to end is a judgment call this plan performed once but that the phase's own end-of-phase human review is the authoritative gate for, per the plan's Edge-Probe Fallback Coverage note."

duration: 48min
completed: 2026-09-27
status: complete
---

# Phase 1 Plan 5: ALP.md Completion (Manifest, Envelope, Consent, Conformance) Summary

**Completed spec/ALP.md's four remaining sections (Manifest, Signed Manifest Envelope and Content Hash, Consent, Conformance) as IETF-draft-style normative prose bound to the shipped schema, canonicalizer and envelope verifier, plus a spec/vectors/README.md and a checker tightened to reject any remaining interim marker.**

## Performance

- **Duration:** ~48 min
- **Started:** 2026-09-27 (immediately following 01-04's wave-3 tracking commit)
- **Completed:** 2026-09-27T15:05:13Z
- **Tasks:** 2 (1 tracer, 1 auto)
- **Files created:** 1
- **Files modified:** 2

## Accomplishments

- `spec/ALP.md` section 4 (Manifest): a prose walkthrough of every one of the eleven top-level fields plus `x-` keys, in schema order, linking to `spec/manifest.schema.json` instead of duplicating it; both cross-field conditionals (pay requires spend; delegated/hybrid requires `auth.delegated`; hosted/hybrid requires `auth.hosted`) and both semantic rules (delegated resources must be scope resources; scope resources unique) stated in prose; an "Annotated example" holding the `payment-reconciler` manifest verbatim plus seven numbered annotations
- `spec/ALP.md` section 5 (Signed Manifest Envelope and Content Hash): the envelope shape and the "nothing outside `manifest` is signed" rule; the `jcs-sha256:` content hash definition with a Rationale note on the prefix; the exact signing input (`ASCII(eyJhbGciOiJFZERTQSJ9) + "." + BASE64URL(JCS(manifest))`), its RFC 7515 Appendix F / RFC 8037 / RFC 8032 framing, and the numbered ten-step `verifyEnvelope` procedure (shape, publisher lookup by id then `kid`, canonicalize, verify, re-parse, validate, hash, mint); pointers to `spec/vectors/jcs/` and `spec/vectors/envelope/` quoting the golden content hash
- `spec/ALP.md` section 6 (Consent): the "verify before consent, supported `spec_version` only" gate; the full required consent-display content list, with `cleanup.publisher_retains` explicitly labelled an attested publisher claim; the content-hash binding on `consent_granted`; a Mermaid `sequenceDiagram` (Host, Runtime, HostAdapter, User)
- `spec/ALP.md` section 15 (Conformance): **Runtime** and **Publisher** conformance classes defined by cross-reference to every relevant section; the `spec/vectors/` directory layout; the rule that Stint's own structured error codes are an implementation interface, not a normative part of the protocol
- `spec/vectors/README.md`: documents `valid/`, `invalid/` (including the `expected_errors` contract), `jcs/` (with the independent `sha256sum` reproduction recipe) and `envelope/` (including the corrected RFC 8032 TEST 2 second-publisher key and a warning that every key in the directory is a published, untrusted test vector)
- `scripts/check-alp-sections.mjs` extended: a section-4-to-`manifest.schema.json` relative-link check; a deep-equality check between section 4's first json block and `spec/vectors/valid/payment-reconciler.json`'s manifest, reporting "annotated example drifted from vector" on any mismatch; a global "no quoted `additionalProperties`" check (the schema must be linked, never pasted); a global rejection of any remaining `ALP-PENDING` text, with or without its HTML comment; the sequence-diagram minimum raised from two to three; and required-phrase checks for sections 5, 6 and 15
- Three new negative tests proving the checker's failing direction: a drifted annotated example, a bare `ALP-PENDING` marker appended without its comment wrapper, and a section 5 with every `eyJhbGciOiJFZERTQSJ9` occurrence replaced

## Task Commits

Each task was committed atomically:

1. **Task 1: End-to-end "spec prose to vector to validator": section 4 manifest walkthrough whose annotated example is checker-bound to the payment-reconciler vector** - `7732236` (feat, tracer)
2. **Task 2: Sections 5, 6 and 15 (envelope and content hash, consent, conformance), the vectors README, and final completeness rules** - `484bb34` (feat)

_No separate plan-metadata commit was made in this step; SUMMARY.md and STATE.md/ROADMAP.md/REQUIREMENTS.md updates are the orchestrator's responsibility per this run's instructions._

## Files Created/Modified

- `spec/ALP.md` - sections 4, 5, 6 and 15 completed; sections 1-3, 7-14, 16 unchanged from plan 01-04
- `spec/vectors/README.md` - conformance vector guide for non-TypeScript implementers
- `scripts/check-alp-sections.mjs` - annotated-example drift check, schema-not-pasted check, global ALP-PENDING rejection, three-sequenceDiagram minimum, section 5/6/15 phrase checks

## Decisions Made

See frontmatter `key-decisions` for full detail. Summary:
1. Used bold inline text (`**Annotated example.**`) instead of a `###` sub-heading inside section 4, since the checker's `getSection` helper stops at any `##`/`###` line and a sub-heading would have silently truncated the section body the drift check reads.
2. Documented the envelope vectors' second publisher key as RFC 8032 TEST 2 (not TEST 1), matching what plan 01-03 actually shipped after its own key-collision correction, rather than the original (superseded) plan text.
3. Split this plan's own commit history into two atomic per-task commits by temporarily reverting Task 2's additions, committing Task 1, then restoring and committing Task 2, so git history preserves the plan's declared task boundaries even though the prose was drafted in one pass.

## Deviations from Plan

None - plan executed exactly as written. The one editorial adjustment (bold text instead of a sub-heading for "Annotated example") was necessary to satisfy the plan's own acceptance criterion that the checker's annotated-example check operate correctly, and is documented above as a decision rather than a deviation, since it does not change any content, scope, or acceptance criterion.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `spec/ALP.md` is now complete end to end: sections 1-16 all hold normative prose, guarded in CI by `pnpm check:alp`, with no remaining `ALP-PENDING` markers anywhere in the document.
- This closes out Phase 1 (Foundation: ALP Spec). SPEC-01 (the whole protocol learnable from one document), SPEC-02 (manifest schema in prose, checker-bound to the shipped vector) and SPEC-06 (canonicalization, content hash and signature verification reproducible from prose alone) are all satisfied by this plan's additions, on top of the schema/codegen/validator (01-02) and canonicalization/envelope (01-03) work those sections describe.
- **Outstanding, by design:** the full end-to-end human read-through of ALP.md (SPEC-01's manual-only acceptance row) was performed once during this plan's own execution (see coverage D7) but remains the phase's own end-of-phase human review item per `01-04-SUMMARY.md`'s and this plan's Edge-Probe Fallback Coverage notes.
- Downstream phases (`02-pure-core-and-hostadapter` onward) can now build directly against `spec/ALP.md` as the single normative source: the section 7.4 transition table (01-04), the manifest schema and validator (01-02), and the envelope/canonicalization surface (01-03) are all cross-referenced from a complete document rather than partial sections with pending markers.

---
*Phase: 01-foundation-alp-spec*
*Completed: 2026-09-27*

## Self-Check: PASSED

- `spec/vectors/README.md` verified present on disk with `[ -f ]`.
- Both task commits (`7732236`, `484bb34`) verified present in `git log --oneline --all`.
- Re-ran plan-level verification after self-check: `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm codegen:check`, `pnpm check:alp` (with all three negative tests re-confirmed rejecting) and `pnpm test` (13 files, 86 tests) all exit 0.
