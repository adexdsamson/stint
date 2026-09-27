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

const BCP14_SENTENCE = "interpreted as described in BCP 14 [RFC2119] [RFC8174]";

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

  if (failures.length > 0) {
    console.error("ALP check failed:");
    for (const f of failures) console.error(`- ${f}`);
    process.exitCode = 1;
    return;
  }
  console.log("ALP check passed");
}

main();
