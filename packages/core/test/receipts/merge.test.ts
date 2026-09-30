import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { ReceiptEntry } from "@stint/spec";

import { verifyChain } from "../../src/receipts/chain.js";
import { mergeTimeline } from "../../src/receipts/merge.js";

// packages/core/test/receipts -> packages/core/test -> packages/core -> packages -> repo root
const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, "..", "..", "..", "..");
const vectorsDir = path.join(repoRoot, "spec", "vectors", "receipts");

function readVector(name: string): string {
  return readFileSync(path.join(vectorsDir, name), "utf8");
}

function loadVerifiedChain(): readonly ReceiptEntry[] {
  return JSON.parse(readVector("chain-input.json")) as readonly ReceiptEntry[];
}

function loadAttestedChain(): readonly ReceiptEntry[] {
  return JSON.parse(readVector("attested-input.json")) as readonly ReceiptEntry[];
}

/** Deep-freezes a chain (the array itself and every entry) so mergeTimeline is forced to prove it never mutates its inputs. */
function deepFreezeChain(chain: readonly ReceiptEntry[]): readonly ReceiptEntry[] {
  for (const entry of chain) Object.freeze(entry);
  return Object.freeze(chain);
}

describe("mergeTimeline: edges", () => {
  it("mergeTimeline([], []) returns []", () => {
    expect(mergeTimeline([], [])).toEqual([]);
  });

  it("single-chain input (attested empty) returns just the verified chain's entries, tagged", () => {
    const verified = loadVerifiedChain();
    const result = mergeTimeline(verified, []);

    expect(result).toHaveLength(verified.length);
    for (const timelineEntry of result) {
      expect(timelineEntry.origin).toBe("verified");
    }
  });

  it("single-chain input (verified empty) returns just the attested chain's entries, tagged", () => {
    const attested = loadAttestedChain();
    const result = mergeTimeline([], attested);

    expect(result).toHaveLength(attested.length);
    for (const timelineEntry of result) {
      expect(timelineEntry.origin).toBe("attested");
    }
  });
});

describe("mergeTimeline: every entry appears once, correctly tagged, no mutation", () => {
  it("returns every input entry exactly once, tagged with the chain it came from", () => {
    const verified = deepFreezeChain(loadVerifiedChain());
    const attested = deepFreezeChain(loadAttestedChain());

    const result = mergeTimeline(verified, attested);

    expect(result).toHaveLength(verified.length + attested.length);

    const verifiedInResult = result.filter((t) => t.origin === "verified").map((t) => t.entry);
    const attestedInResult = result.filter((t) => t.origin === "attested").map((t) => t.entry);
    expect(verifiedInResult).toEqual(verified);
    expect(attestedInResult).toEqual(attested);
  });

  it("does not mutate frozen input chains (no throw, inputs unchanged)", () => {
    const verified = deepFreezeChain(loadVerifiedChain());
    const attested = deepFreezeChain(loadAttestedChain());

    const verifiedSnapshot = JSON.parse(JSON.stringify(verified)) as unknown;
    const attestedSnapshot = JSON.parse(JSON.stringify(attested)) as unknown;

    expect(() => mergeTimeline(verified, attested)).not.toThrow();

    expect(JSON.parse(JSON.stringify(verified))).toEqual(verifiedSnapshot);
    expect(JSON.parse(JSON.stringify(attested))).toEqual(attestedSnapshot);
    expect(Object.isFrozen(verified)).toBe(true);
    expect(Object.isFrozen(attested)).toBe(true);
  });

  it("verifyChain on each original chain still returns ok after mergeTimeline ran", async () => {
    const verified = loadVerifiedChain();
    const attested = loadAttestedChain();

    mergeTimeline(verified, attested);

    const verifiedResult = await verifyChain(verified);
    const attestedResult = await verifyChain(attested);
    expect(verifiedResult.ok).toBe(true);
    expect(attestedResult.ok).toBe(true);
  });
});

describe("mergeTimeline: deterministic ordering, no integrity meaning", () => {
  function makeTransitionEntry(
    seq: number,
    ts: number,
    chain: "verified" | "attested",
  ): ReceiptEntry {
    return {
      seq,
      ts,
      chain,
      type: "transition",
      prevHash: "jcs-sha256:" + "0".repeat(64),
      payload: { from: "granted", event: "activate", actor: "runtime", to: "active" },
    };
  }

  it("sorts by ts primarily", () => {
    const verified = [makeTransitionEntry(0, 200, "verified")];
    const attested = [makeTransitionEntry(0, 100, "attested")];

    const result = mergeTimeline(verified, attested);
    expect(result.map((t) => t.origin)).toEqual(["attested", "verified"]);
  });

  it("adjacency: equal timestamps do not collide - each retains its own origin tag and seq (stable secondary sort by origin then seq)", () => {
    const verified = [
      makeTransitionEntry(0, 100, "verified"),
      makeTransitionEntry(1, 100, "verified"),
    ];
    const attested = [makeTransitionEntry(0, 100, "attested")];

    const result = mergeTimeline(verified, attested);

    expect(result).toHaveLength(3);
    // "attested" sorts before "verified" lexically at equal ts.
    expect(result[0]).toEqual({ origin: "attested", entry: attested[0] });
    expect(result[1]).toEqual({ origin: "verified", entry: verified[0] });
    expect(result[2]).toEqual({ origin: "verified", entry: verified[1] });

    // Ordering carries no integrity meaning: reversing the merged output
    // changes nothing about the count or membership of either source chain.
    const reversed = [...result].reverse();
    expect(reversed).toHaveLength(3);
    expect(new Set(reversed.map((t) => t.entry))).toEqual(new Set(result.map((t) => t.entry)));
  });
});
