---
phase: 01-foundation-alp-spec
plan: 04
subsystem: spec
tags: [alp-spec, mermaid, ci, state-machine, ietf-draft]

requires:
  - phase: 01-foundation-alp-spec (plan 01)
    provides: "Green pnpm/tsdown/Vitest/ESLint monorepo and GitHub Actions CI workflow that this plan adds a check:alp step to"
provides:
  - "spec/ALP.md sections 1-3, 7.1-7.6, 8-14, 16 written normatively (sections 4, 5, 6, 15 left as ALP-PENDING markers for plan 01-05)"
  - "The normative 25-row (state, event, actor) -> next-state transition table (D-24), the exact contract Phase 2's reducer must match"
  - "scripts/check-alp-sections.mjs: a CI-gated structural checker for ALP.md, plus a --file override for negative testing"
  - "pnpm check:alp script, wired into CI immediately after pnpm lint"
affects: [02-pure-core-and-hostadapter, 03-receipts-and-licensing, 04-proxy-runtime, 05-teardown-and-verification, 06-cli-and-reference-hosts, 01-foundation-alp-spec (plan 01-05)]

actuals:
  tokens: 11825
  raw_tokens: 11825
  tasks: 3
  commits: 3

tech-stack:
  added: []
  patterns:
    - "The lease transition table lives as a single markdown table in spec/ALP.md section 7.4, which scripts/check-alp-sections.mjs parses directly (not a separate machine-readable spec/transitions.json) so the prose table stays the single source of truth Phase 2's reducer is built against"
    - "scripts/check-alp-sections.mjs accepts --file PATH so plan 01-04's own negative tests (and any future ones) can validate a mutated copy of ALP.md without touching the committed file"
    - "Every not-yet-designed wire detail is marked with a well-formed `[OPEN: Phase N]` marker (N from 2 to 7); the checker enforces the grammar globally, catching any stray malformed marker anywhere in the document, not just in one section"

key-files:
  created:
    - spec/ALP.md
    - scripts/check-alp-sections.mjs
  modified:
    - package.json
    - .github/workflows/ci.yml

key-decisions:
  - "Section 2's prose describing the OPEN marker convention originally used the literal placeholder `[OPEN: Phase N]` to explain the grammar; the checker's own global OPEN-marker well-formedness check correctly flagged this as malformed (N is not a digit 2-7). Reworded to use a concrete, well-formed example (`[OPEN: Phase 2]`) instead of a placeholder, which both reads better and satisfies the checker without weakening the check itself."
  - "The section 7.1 stateDiagram-v2 was written in Task 1 with all 25 transition-table edges already present (labelled `event / actor`), even though the section 7.4 prose table is not written until Task 2, so that the diagram and the eventual prose table are drawn from the same source data (this plan's context) rather than authored twice from memory."
  - "checkNonEmptyBodies (added in Task 3) treats \"## 7. Lease Lifecycle\" as a container heading with no direct body of its own, since all of its content lives in the 7.1-7.6 subsections; this avoids a false failure on a heading that legitimately has no body text between it and its first subsection."

patterns-established:
  - "Checker script is built incrementally alongside the document: each task extends check-alp-sections.mjs with only the checks its own new sections need, so the checker never has to check for content that a later task hasn't written yet."

requirements-completed: [SPEC-01]

coverage:
  - id: D1
    description: "A reader learns all eleven lease states from spec/ALP.md section 7.1, shown in one Mermaid stateDiagram-v2"
    requirement: "SPEC-01"
    verification:
      - kind: other
        ref: "node scripts/check-alp-sections.mjs (exactly one mermaid stateDiagram-v2 block naming all eleven states)"
        status: pass
      - kind: other
        ref: "negative test: sed removes the stateDiagram-v2 line -> checker rejects (exit 1)"
        status: pass
    human_judgment: false
  - id: D2
    description: "ALP.md section 7.4 holds the normative 25-row transition table; every triple not in the table is rejected by the checker, and no row returns a lease to active from an ending or teardown state"
    requirement: "SPEC-01"
    verification:
      - kind: other
        ref: "node scripts/check-alp-sections.mjs (table header, state/actor domain, unique triples, no agent actor, no path back to active, every state covered)"
        status: pass
      - kind: other
        ref: "negative test: actor mutated to agent -> checker rejects; negative test: failed/begin_teardown mutated to reach active -> checker rejects"
        status: pass
    human_judgment: false
  - id: D3
    description: "The actor list is exactly the seven named actors, and ALP.md states the agent is never an actor for ending, extending or completing a lease"
    requirement: "SPEC-01"
    verification:
      - kind: other
        ref: "node scripts/check-alp-sections.mjs (section 7.2 backticked-actor and agent-sentence checks)"
        status: pass
    human_judgment: false
  - id: D4
    description: "ALP.md defines the three auth modes with hybrid as the default, and distinguishes routine license refresh from lease extension"
    requirement: "SPEC-01"
    verification:
      - kind: other
        ref: "node scripts/check-alp-sections.mjs (section 8 auth-mode and hybrid-default checks); manual read of sections 7.5 and 8"
        status: pass
    human_judgment: true
    rationale: "The checker only proves the required phrases and mode names are present; whether the prose actually and clearly distinguishes refresh from extension is a reading-comprehension judgment deferred to the phase's end-of-phase human review (VALIDATION.md manual-only row for SPEC-01)."
  - id: D5
    description: "ALP.md defines the fixed teardown order, per-credential outcomes, and cleanup_incomplete with idempotent retry"
    requirement: "SPEC-01"
    verification:
      - kind: other
        ref: "node scripts/check-alp-sections.mjs (section 10 ordered five-step list and outcome-vocabulary checks)"
        status: pass
      - kind: other
        ref: "negative test: \"final signed receipt\" replaced with \"closing note\" -> checker rejects"
        status: pass
    human_judgment: false
  - id: D6
    description: "ALP.md defines verified and attested receipt chains with independent integrity and a display-only merged timeline"
    requirement: "SPEC-01"
    verification:
      - kind: other
        ref: "node scripts/check-alp-sections.mjs (section 11 verified/attested/display-only checks)"
        status: pass
    human_judgment: false
  - id: D7
    description: "ALP.md states the trust model and the four documented trust limits verbatim"
    requirement: "SPEC-01"
    verification:
      - kind: other
        ref: "node scripts/check-alp-sections.mjs (section 13 four-exact-phrase check)"
        status: pass
      - kind: other
        ref: "negative test: \"integrity, not completeness\" replaced with \"integrity only\" -> checker rejects"
        status: pass
    human_judgment: false
  - id: D8
    description: "ALP.md uses BCP 14 keywords with numbered sections, and every not-yet-designed wire detail carries a well-formed [OPEN: Phase N] marker"
    requirement: "SPEC-01"
    verification:
      - kind: other
        ref: "node scripts/check-alp-sections.mjs (BCP 14 sentence, heading order, global OPEN-marker grammar checks)"
        status: pass
    human_judgment: false
  - id: D9
    description: "pnpm check:alp runs in CI and fails on a missing heading, a missing state, an agent actor row, a missing teardown step or a missing trust-limit phrase, each failing direction proven by a negative check"
    requirement: "SPEC-01"
    verification:
      - kind: other
        ref: "six negative tests across all three tasks, each asserting a non-zero exit from scripts/check-alp-sections.mjs; .github/workflows/ci.yml runs pnpm check:alp after pnpm lint"
        status: pass
    human_judgment: false
  - id: D10
    description: "ALP.md contains no em-dash characters"
    requirement: "SPEC-01"
    verification:
      - kind: other
        ref: "node scripts/check-alp-sections.mjs (global U+2014 scan); pnpm check:alp passes on the committed document"
        status: pass
    human_judgment: false

duration: 55min
completed: 2026-09-27
status: complete
---

# Phase 1 Plan 4: ALP.md Normative Core and CI-Gated Structural Checker Summary

**Wrote the normative core of spec/ALP.md (lifecycle states/actors/events/transitions, auth modes, enforcement, teardown, receipts, trust model and limits, security considerations) as IETF-draft-style Markdown with four Mermaid diagrams, and built scripts/check-alp-sections.mjs, a CI-gated structural checker proven against six distinct negative mutations.**

## Performance

- **Duration:** 55 min
- **Started:** 2026-09-27T14:37:00Z (approx, per prior session's spec/ directory timestamps)
- **Completed:** 2026-09-27
- **Tasks:** 3 (1 tracer, 2 auto)
- **Files created:** 2
- **Files modified:** 2

## Accomplishments

- `spec/ALP.md`: title, section 1 (introduction, MCP/OAuth 2.1 relationship, two audiences, core guarantee, non-goals), section 2 (BCP 14 boilerplate, OPEN-marker convention, 22-term glossary), section 3 (roles overview plus a component flowchart), section 7 (all eleven lease states with a stateDiagram-v2 covering every transition, the seven backticked actors and the agent-never-an-actor sentence, all seventeen backticked events, the normative 25-row transition table under the exact `| From | Event | Actor | To |` header, expiry/extension/license-refresh rules, outcome verification), section 8 (delegated/hosted/hybrid auth modes with hybrid as the documented default), section 9 (connector bindings, deny-by-default, per-lease limits, out-of-band approvals bound to an args/binding/lease-version hash, a tool-call sequenceDiagram), section 10 (the fixed five-step teardown order, three per-credential outcomes, `cleanup_incomplete` with idempotent retry, a teardown sequenceDiagram), section 11 (verified vs attested receipt chains, checkpoints, redaction, the display-only merged timeline), section 12 (trust model per party), section 13 (the four documented trust limits verbatim, plus revocation-latency and signing-key-custody notes), section 14 (prompt injection, confused deputy, approval TOCTOU, secret redaction, manifest/key rotation, clock skew, size caps, consent-display spoofing), section 16 (eight normative RFC references plus JSON Schema draft-07, OAuth 2.1, PASETO v4 and MCP)
- Sections 4, 5, 6 and 15 (owned by plan 01-05) each hold exactly the `<!-- ALP-PENDING: 01-05 -->` marker, with headings and numbering already fixed
- `scripts/check-alp-sections.mjs`: an ESM, node-builtins-only checker that parses ALP.md (or a `--file PATH` override) and validates, incrementally per task: exact title line and heading presence/order; the BCP 14 sentence; exactly one stateDiagram-v2 naming all eleven states; a global no-em-dash scan; global well-formed `[OPEN: Phase N]` grammar; section 7.2's seven backticked actors and agent sentence; the section 7.4 transition table's structural and safety properties (state/actor domain, no agent actor, no path back to active from an ending state, every state covered, unique (From, Event, Actor) triples); every table event backticked in section 7.3; section 8's three auth-mode names and hybrid-default sentence; at least two sequenceDiagram blocks; section 10's ordered five-step list and outcome vocabulary; section 13's four exact trust-limit phrases; section 11's verified/attested/display-only vocabulary; section 16's eight RFC numbers; and a non-empty-body check for every section except the plan-01-05-owned 4/5/6/15 (and the container heading "## 7. Lease Lifecycle")
- `pnpm check:alp` root script and a CI step running it immediately after `pnpm lint`
- Six distinct negative tests (two per task) proving the checker's failing direction: missing state diagram, renamed heading, agent-actor row, path back to active, missing trust-limit phrase, missing teardown step

## Task Commits

Each task was committed atomically:

1. **Task 1: End-to-end spec gate: ALP.md outline, conventions and the state machine, verified by a CI-wired structural checker** - `591483e` (feat, tracer)
2. **Task 2: Lifecycle and authorization prose: overview, actors, events, transition table, expiry versus extension versus refresh, outcome verification, auth modes** - `b48d1f1` (feat)
3. **Task 3: Enforcement, teardown, receipts, trust model, trust limits, security considerations and references** - `9e711f6` (feat)

## Files Created/Modified

- `spec/ALP.md` - the normative ALP.md core (sections 1-3, 7.1-7.6, 8-14, 16), plus ALP-PENDING placeholders for 4, 5, 6, 15
- `scripts/check-alp-sections.mjs` - the CI-gated structural checker, `--file PATH` override
- `package.json` - added `"check:alp": "node scripts/check-alp-sections.mjs"`
- `.github/workflows/ci.yml` - added `pnpm check:alp` step immediately after `pnpm lint`

## Decisions Made

See frontmatter `key-decisions` for full detail. Summary:
1. Reworded the section 2 OPEN-marker explanation to use a concrete, well-formed `[OPEN: Phase 2]` example instead of a `[OPEN: Phase N]` placeholder, since the checker's own global well-formedness scan correctly flagged the placeholder form as malformed.
2. Wrote the full 25-edge stateDiagram-v2 in Task 1, ahead of the section 7.4 prose table (written in Task 2), from the same transition-table source data, so the diagram and the table were never independently authored.
3. Treated "## 7. Lease Lifecycle" as a container heading exempt from the non-empty-body check, since its content lives entirely in its 7.x subsections.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Section 2's OPEN-marker example collided with the checker's own well-formedness grammar**
- **Found during:** Task 1, first `node scripts/check-alp-sections.mjs` run before the initial commit
- **Issue:** Section 2 originally explained the marker convention using the literal placeholder text `[OPEN: Phase N]`. The checker's global OPEN-marker scan (by design) validates every bracketed `[OPEN...]` occurrence in the document against `^\[OPEN: Phase [2-7]\]$`, and `N` is not a digit in `2-7`, so the checker correctly rejected its own base document.
- **Fix:** Reworded the explanatory sentence to use a concrete, well-formed example (`` `[OPEN: Phase 2]` ``) instead of a generic placeholder.
- **Files modified:** spec/ALP.md
- **Verification:** `node scripts/check-alp-sections.mjs` passes on the committed document; the checker's grammar check remains unmodified and un-weakened.
- **Committed in:** 591483e (Task 1 commit; found and fixed before the first commit, not as a follow-up)

---

**Total deviations:** 1 auto-fixed (1 Rule 1 bug fix)
**Impact on plan:** The fix was a wording change to make the base document conform to the checker's own stated grammar; it did not touch the grammar itself, any acceptance criterion, or any must_haves truth. No scope creep.

## Issues Encountered

None beyond the deviation above.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `spec/ALP.md` sections 1-3, 7.1-7.6, 8-14, 16 are complete and CI-gated; plan 01-05 can now write sections 4, 5, 6 and 15 (Manifest, Signed Manifest Envelope and Content Hash, Consent, Conformance) against a fixed, numbered outline and extend `scripts/check-alp-sections.mjs` to reject any remaining `ALP-PENDING` marker.
- The normative 25-row transition table (section 7.4) is the fixed contract Phase 2's `@stint/core` reducer must match; the event names and actor list introduced here (`consent_granted`, `activate`, `outcome_verified`, and so on; `user`, `verifier`, `policy`, `clock`, `provider`, `publisher`, `runtime`) are now the canonical vocabulary downstream phases build against.
- **Outstanding, by design:** the plan's own must_haves note that "learn the full protocol" (SPEC-01) cannot be fully proven mechanically; a human read-through of ALP.md's prose completeness and clarity is deferred to end-of-phase (VALIDATION.md manual-only row), per this plan's Edge-Probe Fallback Coverage entry.

---
*Phase: 01-foundation-alp-spec*
*Completed: 2026-09-27*

## Self-Check: PASSED

- `spec/ALP.md` and `scripts/check-alp-sections.mjs` verified present on disk with `[ -f ]`.
- All three task commits (`591483e`, `b48d1f1`, `9e711f6`) verified present in `git log --oneline --all`.
- Re-ran plan-level verification after self-check: `pnpm check:alp` passes; all six negative tests (two per task, across all three tasks) still correctly reject with a non-zero exit; `pnpm lint` exits 0; `pnpm build`, `pnpm typecheck` and `pnpm test` (9 test files, 39 tests) all pass.
