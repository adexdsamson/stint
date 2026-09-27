#!/usr/bin/env node
// Structural checker for spec/ALP.md.
// Reads spec/ALP.md, or the file given by --file PATH, collects every
// structural failure, then prints a report and exits 0 or 1.
//
// This script only checks *structure*: headings present and in order,
// required sentences and phrases, Mermaid diagram shape, the section 7.4
// transition table's safety properties, and a few textual conventions
// (no em-dash, well-formed [OPEN: Phase N] markers). It never validates
// prose quality; that is a human review task (see the plan's must_haves).

import { readFileSync } from "node:fs";

const DEFAULT_FILE = "spec/ALP.md";

const FIXED_OUTLINE = [
  "# Agent Lease Protocol (ALP), version alp/0.1",
  "## 1. Introduction",
  "## 2. Conventions and Terminology",
  "## 3. Protocol Overview",
  "## 4. Manifest",
  "## 5. Signed Manifest Envelope and Content Hash",
  "## 6. Consent",
  "## 7. Lease Lifecycle",
  "### 7.1 States",
  "### 7.2 Actors",
  "### 7.3 Events",
  "### 7.4 Transition Table",
  "### 7.5 Expiry, Extension and License Refresh",
  "### 7.6 Outcome Verification",
  "## 8. Authorization Modes",
  "## 9. Enforcement",
  "## 10. Teardown",
  "## 11. Receipts",
  "## 12. Trust Model",
  "## 13. Trust Limits",
  "## 14. Security Considerations",
  "## 15. Conformance",
  "## 16. References",
];

const STATES = [
  "proposed",
  "declined",
  "granted",
  "active",
  "completed",
  "expired",
  "revoked",
  "failed",
  "tearing_down",
  "cleaned_up",
  "cleanup_incomplete",
];

const ACTORS = ["user", "verifier", "policy", "clock", "provider", "publisher", "runtime"];

const ENDING_STATES = [
  "completed",
  "expired",
  "revoked",
  "failed",
  "tearing_down",
  "cleaned_up",
  "cleanup_incomplete",
];

const BCP14_SENTENCE = "interpreted as described in BCP 14 [RFC2119] [RFC8174]";
const AGENT_SENTENCE =
  "The agent is never an actor: no event originating from the agent, including any tool call, tool result or message claiming completion, ends, extends or completes a lease.";
const TRANSITION_TABLE_HEADER = "| From | Event | Actor | To |";
const HYBRID_DEFAULT_SENTENCE = "`hybrid` is the default";

const TEARDOWN_STEP_WORDS = ["Revoke", "Invalidate", "cleanup hook", "Delete", "final signed receipt"];
const TEARDOWN_OUTCOME_WORDS = ["revoked", "discarded_revocation_unsupported", "failed", "cleanup_incomplete"];
const TRUST_LIMIT_PHRASES = [
  "integrity, not completeness",
  "cross-resource data flow",
  "attested, not verified",
  "operated by the user or a neutral party",
];
const RECEIPTS_WORDS = ["verified", "attested", "display-only"];
const REFERENCE_RFCS = [
  "RFC 2119",
  "RFC 8174",
  "RFC 8785",
  "RFC 7515",
  "RFC 8037",
  "RFC 8032",
  "RFC 7009",
  "RFC 8707",
];

// Plan 01-05 writes section 4 first (Task 1); sections 5, 6 and 15 remain
// pending until Task 2. Every other leaf section already carries real
// prose. "## 7. Lease Lifecycle" is a container heading with no direct
// body of its own (its content lives entirely in the 7.x subsections), so
// it is excluded from the non-empty-body check too.
const PENDING_HEADINGS = new Set([
  "## 5. Signed Manifest Envelope and Content Hash",
  "## 6. Consent",
  "## 15. Conformance",
]);
const CONTAINER_HEADINGS = new Set(["## 7. Lease Lifecycle"]);
const PENDING_MARKER = "<!-- ALP-PENDING: 01-05 -->";

// Plan 01-05 Task 1 (D-21, D-25): the section 4 annotated example must
// never drift from the payment-reconciler conformance vector it is copied
// from.
const ANNOTATED_EXAMPLE_HEADING = "## 4. Manifest";
const ANNOTATED_EXAMPLE_VECTOR_PATH = "spec/vectors/valid/payment-reconciler.json";

const OPEN_MARKER_RE = /\[OPEN[^\]]*\]/g;
const WELLFORMED_OPEN_RE = /^\[OPEN: Phase [2-7]\]$/;

function parseArgs(argv) {
  const idx = argv.indexOf("--file");
  if (idx !== -1 && argv[idx + 1] !== undefined) return argv[idx + 1];
  return DEFAULT_FILE;
}

/** Returns the body text between `heading` and the next `##`/`###` heading, or null if not found. */
function getSection(lines, heading) {
  const startIdx = lines.findIndex((l) => l.trim() === heading);
  if (startIdx === -1) return null;
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    if (/^#{2,3}\s/.test(lines[i])) {
      endIdx = i;
      break;
    }
  }
  return lines.slice(startIdx + 1, endIdx).join("\n");
}

function checkTitleAndHeadings(lines, failures) {
  if (lines[0]?.trim() !== FIXED_OUTLINE[0]) {
    failures.push(`missing or incorrect title line: expected "${FIXED_OUTLINE[0]}"`);
  }

  let searchFrom = 0;
  for (const heading of FIXED_OUTLINE) {
    let found = -1;
    for (let i = searchFrom; i < lines.length; i++) {
      if (lines[i].trim() === heading) {
        found = i;
        break;
      }
    }
    if (found === -1) {
      failures.push(`missing or out-of-order heading: "${heading}"`);
    } else {
      searchFrom = found + 1;
    }
  }
}

function checkBcp14(lines, failures) {
  const section2 = getSection(lines, "## 2. Conventions and Terminology") ?? "";
  if (!section2.includes(BCP14_SENTENCE)) {
    failures.push("section 2 missing the BCP 14 sentence");
  }
}

function checkStateDiagram(text, failures) {
  const mermaidBlocks = [...text.matchAll(/```mermaid\n([\s\S]*?)```/g)].map((m) => m[1]);
  const stateDiagramBlocks = mermaidBlocks.filter((b) => b.includes("stateDiagram-v2"));
  if (stateDiagramBlocks.length !== 1) {
    failures.push(
      `expected exactly one mermaid stateDiagram-v2 block, found ${stateDiagramBlocks.length}`,
    );
    return;
  }
  const block = stateDiagramBlocks[0];
  for (const state of STATES) {
    if (!new RegExp(`\\b${state}\\b`).test(block)) {
      failures.push(`stateDiagram-v2 block missing state "${state}"`);
    }
  }
}

function checkEmDash(text, failures) {
  if (text.includes("—")) {
    failures.push("document contains an em-dash (U+2014) character");
  }
}

function checkOpenMarkers(text, failures) {
  for (const match of text.matchAll(OPEN_MARKER_RE)) {
    if (!WELLFORMED_OPEN_RE.test(match[0])) {
      failures.push(`malformed OPEN marker: "${match[0]}"`);
    }
  }
}

function checkActors(lines, failures) {
  const section = getSection(lines, "### 7.2 Actors") ?? "";
  for (const actor of ACTORS) {
    if (!section.includes(`\`${actor}\``)) {
      failures.push(`section 7.2 missing backticked actor "${actor}"`);
    }
  }
  if (!section.includes(AGENT_SENTENCE)) {
    failures.push("section 7.2 missing the agent-is-never-an-actor sentence");
  }
}

/**
 * Parses the markdown table in section 7.4 into { from, event, actor, to } rows.
 * Pushes a failure and returns [] if the exact header is missing.
 */
function parseTransitionRows(lines, failures) {
  const section = getSection(lines, "### 7.4 Transition Table") ?? "";
  const sectionLines = section.split("\n");
  const headerIdx = sectionLines.findIndex((l) => l.trim() === TRANSITION_TABLE_HEADER);
  if (headerIdx === -1) {
    failures.push(`section 7.4 missing the exact table header "${TRANSITION_TABLE_HEADER}"`);
    return [];
  }
  const rows = [];
  for (let i = headerIdx + 1; i < sectionLines.length; i++) {
    const line = sectionLines[i].trim();
    if (!line.startsWith("|")) break;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length !== 4) continue;
    if (cells.every((c) => /^:?-+:?$/.test(c))) continue; // markdown separator row
    const [from, event, actor, to] = cells;
    rows.push({ from, event, actor, to });
  }
  return rows;
}

function checkTransitionTable(rows, failures) {
  if (rows.length === 0) {
    failures.push("section 7.4 transition table has no data rows");
    return;
  }
  const seenStates = new Set();
  const seenTriples = new Set();
  for (const { from, event, actor, to } of rows) {
    seenStates.add(from);
    seenStates.add(to);
    if (!STATES.includes(from)) {
      failures.push(`transition table row has unknown From state "${from}"`);
    }
    if (!STATES.includes(to)) {
      failures.push(`transition table row has unknown To state "${to}"`);
    }
    if (!ACTORS.includes(actor)) {
      failures.push(
        `transition table row (${from}, ${event}, ${actor}) has an actor outside the seven-actor list`,
      );
    }
    const triple = `${from}|${event}|${actor}`;
    if (seenTriples.has(triple)) {
      failures.push(`transition table has a duplicate (From, Event, Actor) triple: ${triple}`);
    }
    seenTriples.add(triple);
    if ((from === "declined" || from === "cleaned_up") && from !== to) {
      failures.push(`terminal state "${from}" MUST NOT appear as a From state`);
    }
    if (to === "active" && ENDING_STATES.includes(from)) {
      failures.push(`transition table has a path back to active from ending state "${from}"`);
    }
  }
  for (const state of STATES) {
    if (!seenStates.has(state)) {
      failures.push(`transition table never mentions state "${state}"`);
    }
  }
}

function checkEventsBacktick(lines, rows, failures) {
  const section = getSection(lines, "### 7.3 Events") ?? "";
  const events = new Set(rows.map((r) => r.event));
  for (const event of events) {
    if (!section.includes(`\`${event}\``)) {
      failures.push(`section 7.3 missing backticked event "${event}"`);
    }
  }
}

function checkAuthModes(lines, failures) {
  const section = getSection(lines, "## 8. Authorization Modes") ?? "";
  for (const mode of ["delegated", "hosted", "hybrid"]) {
    if (!section.includes(`\`${mode}\``)) {
      failures.push(`section 8 missing auth mode "${mode}"`);
    }
  }
  if (!section.includes(HYBRID_DEFAULT_SENTENCE)) {
    failures.push("section 8 missing the hybrid-default sentence");
  }
}

function checkSequenceDiagrams(text, failures) {
  const mermaidBlocks = [...text.matchAll(/```mermaid\n([\s\S]*?)```/g)].map((m) => m[1]);
  const sequenceDiagramBlocks = mermaidBlocks.filter((b) => b.includes("sequenceDiagram"));
  if (sequenceDiagramBlocks.length < 2) {
    failures.push(
      `expected at least two mermaid sequenceDiagram blocks, found ${sequenceDiagramBlocks.length}`,
    );
  }
}

function checkTeardownSection(lines, failures) {
  const section = getSection(lines, "## 10. Teardown") ?? "";
  const items = section
    .split("\n")
    .filter((l) => /^\d+\.\s/.test(l.trim()))
    .map((l) => l.trim());
  if (items.length < TEARDOWN_STEP_WORDS.length) {
    failures.push(
      `section 10 numbered list has ${items.length} items, expected at least ${TEARDOWN_STEP_WORDS.length}`,
    );
  } else {
    TEARDOWN_STEP_WORDS.forEach((word, i) => {
      if (!items[i].includes(word)) {
        failures.push(`section 10 numbered list item ${i + 1} missing "${word}"`);
      }
    });
  }
  for (const word of TEARDOWN_OUTCOME_WORDS) {
    if (!section.includes(word)) {
      failures.push(`section 10 missing teardown outcome "${word}"`);
    }
  }
}

function checkTrustLimits(lines, failures) {
  const section = getSection(lines, "## 13. Trust Limits") ?? "";
  for (const phrase of TRUST_LIMIT_PHRASES) {
    if (!section.includes(phrase)) {
      failures.push(`section 13 missing required phrase "${phrase}"`);
    }
  }
}

function checkReceiptsSection(lines, failures) {
  const section = getSection(lines, "## 11. Receipts") ?? "";
  for (const word of RECEIPTS_WORDS) {
    if (!section.includes(word)) {
      failures.push(`section 11 missing "${word}"`);
    }
  }
}

function checkReferences(lines, failures) {
  const section = getSection(lines, "## 16. References") ?? "";
  for (const rfc of REFERENCE_RFCS) {
    if (!section.includes(rfc)) {
      failures.push(`section 16 missing "${rfc}"`);
    }
  }
}

/** Deep-equality over plain JSON values: array order matters, object key order does not. */
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (aKeys.length !== bKeys.length) return false;
  for (let i = 0; i < aKeys.length; i++) {
    if (aKeys[i] !== bKeys[i]) return false;
  }
  return aKeys.every((key) => deepEqual(a[key], b[key]));
}

/** Section 4 must link to the canonical schema instead of pasting it (D-21). */
function checkManifestSchemaLink(lines, failures) {
  const section = getSection(lines, ANNOTATED_EXAMPLE_HEADING) ?? "";
  if (!/\]\([^)]*manifest\.schema\.json\)/.test(section)) {
    failures.push(`section "${ANNOTATED_EXAMPLE_HEADING}" missing a relative link to manifest.schema.json`);
  }
}

/**
 * Section 4's annotated example (its first fenced json code block) must
 * deep-equal spec/vectors/valid/payment-reconciler.json's manifest member,
 * so the spec prose can never silently drift from the shipped conformance
 * vector (D-21, D-32).
 */
function checkAnnotatedExample(lines, failures) {
  const section = getSection(lines, ANNOTATED_EXAMPLE_HEADING) ?? "";
  const match = section.match(/```json\n([\s\S]*?)```/);
  if (!match) {
    failures.push(`section "${ANNOTATED_EXAMPLE_HEADING}" has no annotated-example json code block`);
    return;
  }

  let example;
  try {
    example = JSON.parse(match[1]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    failures.push(`section "${ANNOTATED_EXAMPLE_HEADING}" annotated example is not valid JSON: ${message}`);
    return;
  }

  let vectorText;
  try {
    vectorText = readFileSync(ANNOTATED_EXAMPLE_VECTOR_PATH, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    failures.push(`cannot read annotated-example vector at ${ANNOTATED_EXAMPLE_VECTOR_PATH}: ${message}`);
    return;
  }

  let vector;
  try {
    vector = JSON.parse(vectorText);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    failures.push(`annotated-example vector at ${ANNOTATED_EXAMPLE_VECTOR_PATH} is not valid JSON: ${message}`);
    return;
  }

  if (!deepEqual(example, vector.manifest)) {
    failures.push("annotated example drifted from vector");
  }
}

/** D-21: the schema is linked to, never pasted inline. */
function checkSchemaNotPasted(text, failures) {
  if (text.includes('"additionalProperties"')) {
    failures.push('document contains the quoted schema key "additionalProperties" (the schema must be linked, not pasted)');
  }
}

function checkNonEmptyBodies(lines, failures) {
  for (const heading of FIXED_OUTLINE) {
    if (heading === FIXED_OUTLINE[0]) continue; // title line, not a section
    if (CONTAINER_HEADINGS.has(heading)) continue;
    const body = (getSection(lines, heading) ?? "").trim();
    if (PENDING_HEADINGS.has(heading)) {
      if (body !== "" && body !== PENDING_MARKER) {
        failures.push(
          `section "${heading}" must hold real text or exactly "${PENDING_MARKER}", found: ${JSON.stringify(body).slice(0, 80)}`,
        );
      }
    } else if (body === "") {
      failures.push(`section "${heading}" has an empty body`);
    }
  }
}

function main() {
  const filePath = parseArgs(process.argv.slice(2));
  const failures = [];
  let text;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("ALP check failed:");
    console.error(`- cannot read file: ${filePath} (${message})`);
    process.exitCode = 1;
    return;
  }
  const lines = text.split("\n");

  checkTitleAndHeadings(lines, failures);
  checkBcp14(lines, failures);
  checkStateDiagram(text, failures);
  checkEmDash(text, failures);
  checkOpenMarkers(text, failures);
  checkActors(lines, failures);
  const transitionRows = parseTransitionRows(lines, failures);
  checkTransitionTable(transitionRows, failures);
  checkEventsBacktick(lines, transitionRows, failures);
  checkAuthModes(lines, failures);
  checkSequenceDiagrams(text, failures);
  checkTeardownSection(lines, failures);
  checkTrustLimits(lines, failures);
  checkReceiptsSection(lines, failures);
  checkReferences(lines, failures);
  checkNonEmptyBodies(lines, failures);
  checkManifestSchemaLink(lines, failures);
  checkAnnotatedExample(lines, failures);
  checkSchemaNotPasted(text, failures);

  if (failures.length > 0) {
    console.error("ALP check failed:");
    for (const f of failures) console.error(`- ${f}`);
    process.exitCode = 1;
    return;
  }
  console.log("ALP check passed");
}

main();
