import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { TRANSITION_TABLE } from "../src/transitions.js";
import { clockEvents, publisherEvents, providerEvents, runtimeEvents, userEvents, verifierEvents } from "../src/events.js";

// packages/core/test -> packages/core -> packages -> repo root
const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, "..", "..", "..");
const alpPath = path.join(repoRoot, "spec", "ALP.md");

interface SpecTriple {
  readonly from: string;
  readonly event: string;
  readonly actor: string;
  readonly to: string;
}

/**
 * Parses the normative `### 7.4 Transition Table` markdown table directly
 * out of `spec/ALP.md`, so the code table and the spec table can never
 * silently diverge (D-05): this test's expected set comes from the spec
 * file itself, not from a value re-typed by hand.
 */
function parseSpecTransitionTable(): readonly SpecTriple[] {
  const text = readFileSync(alpPath, "utf8");

  const sectionStart = text.indexOf("### 7.4 Transition Table");
  if (sectionStart === -1) {
    throw new Error("Could not find '### 7.4 Transition Table' heading in spec/ALP.md");
  }
  const afterHeading = text.slice(sectionStart + "### 7.4 Transition Table".length);
  const nextHeadingIndex = afterHeading.indexOf("\n### ");
  const section = nextHeadingIndex === -1 ? afterHeading : afterHeading.slice(0, nextHeadingIndex);

  const rows: SpecTriple[] = [];
  for (const line of section.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;

    const cells = trimmed
      .split("|")
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length !== 4) continue;

    const [from, event, actor, to] = cells;
    if (from === undefined || event === undefined || actor === undefined || to === undefined) {
      continue;
    }
    // Skip the header row ("From | Event | Actor | To") and the separator
    // row ("---|---|---|---", possibly with alignment colons).
    if (from === "From" || /^:?-+:?$/.test(from)) continue;

    rows.push({ from, event, actor, to });
  }

  return rows;
}

describe("TRANSITION_TABLE matches ALP.md Section 7.4 exactly (D-05)", () => {
  const specTriples = parseSpecTransitionTable();

  it("parses exactly 25 triples across 24 keys from the spec", () => {
    expect(specTriples).toHaveLength(25);
    const keys = new Set(specTriples.map((triple) => `${triple.from}:${triple.event}`));
    expect(keys.size).toBe(24);
  });

  it("every parsed spec triple exists in TRANSITION_TABLE with a matching `to` and actor", () => {
    for (const triple of specTriples) {
      const key = `${triple.from}:${triple.event}`;
      const entry = TRANSITION_TABLE[key];
      expect(entry, `TRANSITION_TABLE is missing key "${key}"`).toBeDefined();
      expect(entry?.to).toBe(triple.to);
      expect(entry?.actors).toContain(triple.actor);
    }
  });

  it("TRANSITION_TABLE contains no key/actor triple absent from the parsed spec set", () => {
    const specTripleSet = new Set(
      specTriples.map((triple) => `${triple.from}:${triple.event}:${triple.actor}`),
    );

    for (const [key, entry] of Object.entries(TRANSITION_TABLE)) {
      for (const actor of entry.actors) {
        const tripleKey = `${key}:${actor}`;
        expect(
          specTripleSet.has(tripleKey),
          `TRANSITION_TABLE has triple "${tripleKey}" -> "${entry.to}" not present in spec/ALP.md Section 7.4`,
        ).toBe(true);
      }
    }
  });

  it("reads spec/ALP.md at runtime, not a hand-copied literal", () => {
    expect(specTriples.length).toBeGreaterThan(0);
  });
});

describe("TRANSITION_TABLE spot checks", () => {
  it("granted:activate deep-equals { actors: ['runtime'], to: 'active' }", () => {
    expect(TRANSITION_TABLE["granted:activate"]).toEqual({ actors: ["runtime"], to: "active" });
  });

  it("active:error_threshold_exceeded deep-equals { actors: ['policy'], to: 'failed' }", () => {
    expect(TRANSITION_TABLE["active:error_threshold_exceeded"]).toEqual({
      actors: ["policy"],
      to: "failed",
    });
  });

  it("cleanup_incomplete:retry_teardown has both user and runtime actors", () => {
    expect(TRANSITION_TABLE["cleanup_incomplete:retry_teardown"]?.actors).toEqual([
      "user",
      "runtime",
    ]);
  });

  it("declined:begin_teardown is undefined (terminal state, no outgoing transition)", () => {
    expect(TRANSITION_TABLE["declined:begin_teardown"]).toBeUndefined();
  });

  it("cleaned_up has no outgoing transitions", () => {
    const outgoing = Object.keys(TRANSITION_TABLE).filter((key) => key.startsWith("cleaned_up:"));
    expect(outgoing).toHaveLength(0);
  });
});

describe("actor-namespaced event constructors", () => {
  it("runtimeEvents.activate() returns { type: 'activate', actor: 'runtime' }", () => {
    expect(runtimeEvents.activate()).toEqual({ type: "activate", actor: "runtime" });
  });

  it("userEvents.extend(600) returns { type: 'extend', actor: 'user', deltaSeconds: 600 }", () => {
    expect(userEvents.extend(600)).toEqual({ type: "extend", actor: "user", deltaSeconds: 600 });
  });

  it("userEvents.retryTeardown() returns { type: 'retry_teardown', actor: 'user' }", () => {
    expect(userEvents.retryTeardown()).toEqual({ type: "retry_teardown", actor: "user" });
  });

  it("clockEvents.expire()/consentTimedOut() hard-code actor 'clock'", () => {
    expect(clockEvents.expire()).toEqual({ type: "expire", actor: "clock" });
    expect(clockEvents.consentTimedOut()).toEqual({ type: "consent_timed_out", actor: "clock" });
  });

  it("providerEvents.grantRevoked() / publisherEvents.entitlementRevoked() / verifierEvents.outcomeVerified()", () => {
    expect(providerEvents.grantRevoked()).toEqual({ type: "grant_revoked", actor: "provider" });
    expect(publisherEvents.entitlementRevoked()).toEqual({
      type: "entitlement_revoked",
      actor: "publisher",
    });
    expect(verifierEvents.outcomeVerified()).toEqual({
      type: "outcome_verified",
      actor: "verifier",
    });
  });

  it("runtimeEvents covers activationFailed, runtimeFailure, beginTeardown, teardownSucceeded, teardownIncomplete, retryTeardown", () => {
    expect(runtimeEvents.activationFailed()).toEqual({ type: "activation_failed", actor: "runtime" });
    expect(runtimeEvents.runtimeFailure()).toEqual({ type: "runtime_failure", actor: "runtime" });
    expect(runtimeEvents.beginTeardown()).toEqual({ type: "begin_teardown", actor: "runtime" });
    expect(runtimeEvents.teardownSucceeded()).toEqual({ type: "teardown_succeeded", actor: "runtime" });
    expect(runtimeEvents.teardownIncomplete()).toEqual({
      type: "teardown_incomplete",
      actor: "runtime",
    });
    expect(runtimeEvents.retryTeardown()).toEqual({ type: "retry_teardown", actor: "runtime" });
  });

  it("every constructed event is frozen", () => {
    expect(Object.isFrozen(userEvents.revoke())).toBe(true);
    expect(Object.isFrozen(runtimeEvents.activate())).toBe(true);
  });
});
