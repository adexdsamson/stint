import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { ReceiptEntry } from "@stint/spec";

import {
  GENESIS_PREV_HASH,
  appendEntry,
  canonicalizeEntry,
  verifyChain,
} from "../../src/receipts/chain.js";
import type { ReceiptEntryInput } from "../../src/receipts/chain.js";

// packages/core/test/receipts -> packages/core/test -> packages/core -> packages -> repo root
const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, "..", "..", "..", "..");
const vectorsDir = path.join(repoRoot, "spec", "vectors", "receipts");

function readVector(name: string): string {
  return readFileSync(path.join(vectorsDir, name), "utf8");
}

function loadGoldenChain(): readonly ReceiptEntry[] {
  return JSON.parse(readVector("chain-input.json")) as readonly ReceiptEntry[];
}

/** Strips seq/ts/prevHash from a fixture entry to reconstruct the ReceiptEntryInput appendEntry would have received. */
function toInput(entry: ReceiptEntry): ReceiptEntryInput {
  switch (entry.type) {
    case "call":
      return { chain: entry.chain, type: entry.type, payload: entry.payload };
    case "transition":
      return { chain: entry.chain, type: entry.type, payload: entry.payload };
    case "teardown_step":
      return { chain: entry.chain, type: entry.type, payload: entry.payload };
    case "attested_claim":
      return { chain: entry.chain, type: entry.type, payload: entry.payload };
  }
}

describe("golden vector: spec/vectors/receipts/", () => {
  it("canonical bytes of the last entry match the committed fixture exactly", () => {
    const chain = loadGoldenChain();
    const last = chain[chain.length - 1];
    if (last === undefined) throw new Error("fixture chain must be non-empty");

    expect(canonicalizeEntry(last)).toBe(readVector("chain-canonical.txt"));
  });

  it("head hash of the last entry matches the independently-computed fixture hash", async () => {
    const chain = loadGoldenChain();
    const last = chain[chain.length - 1];
    if (last === undefined) throw new Error("fixture chain must be non-empty");

    const expectedHash = readVector("chain-expected-hash.txt").trim();
    expect(expectedHash).toMatch(/^jcs-sha256:[0-9a-f]{64}$/);

    const result = await verifyChain(chain);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.headHash).toBe(expectedHash);
      expect(result.value.count).toBe(chain.length);
    }
  });
});

describe("verifyChain", () => {
  it("empty chain: ok, headHash === GENESIS_PREV_HASH, count 0", async () => {
    const result = await verifyChain([]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.headHash).toBe(GENESIS_PREV_HASH);
      expect(result.value.count).toBe(0);
    }
  });

  it("first entry's prevHash equals GENESIS_PREV_HASH", () => {
    const chain = loadGoldenChain();
    expect(chain[0]?.prevHash).toBe(GENESIS_PREV_HASH);
  });

  it("reports the exact break point when an entry's prevHash is tampered", async () => {
    const chain = loadGoldenChain();
    const tampered: ReceiptEntry[] = chain.map((entry, i) =>
      i === 2 ? { ...entry, prevHash: "jcs-sha256:" + "f".repeat(64) } : entry,
    );

    const result = await verifyChain(tampered);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toEqual({ brokenAtSeq: 2, reason: "hash_mismatch" });
    }
  });
});

describe("appendEntry", () => {
  it("empty chain: yields seq 0 with prevHash === GENESIS_PREV_HASH", () => {
    const entry = appendEntry(
      [],
      {
        chain: "verified",
        type: "transition",
        payload: { from: "granted", event: "activate", actor: "runtime", to: "active" },
      },
      1732104000,
    );

    expect(entry.seq).toBe(0);
    expect(entry.prevHash).toBe(GENESIS_PREV_HASH);
  });

  it("reproduces the golden fixture's exact bytes and hash when replayed from empty", async () => {
    const golden = loadGoldenChain();
    let generated: readonly ReceiptEntry[] = [];

    for (const fixtureEntry of golden) {
      const next = appendEntry(generated, toInput(fixtureEntry), fixtureEntry.ts);
      expect(next).toEqual(fixtureEntry);
      generated = [...generated, next];
    }

    const last = generated[generated.length - 1];
    if (last === undefined) throw new Error("generated chain must be non-empty");
    expect(canonicalizeEntry(last)).toBe(readVector("chain-canonical.txt"));

    const result = await verifyChain(generated);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.headHash).toBe(readVector("chain-expected-hash.txt").trim());
    }
  });

  it("chain of length N: yields seq N with prevHash === hashCanonical(chain[N-1])", () => {
    const golden = loadGoldenChain();
    const firstTwo = golden.slice(0, 2);
    const thirdFixtureEntry = golden[2];
    if (thirdFixtureEntry === undefined)
      throw new Error("fixture chain must have at least 3 entries");
    const next = appendEntry(firstTwo, toInput(thirdFixtureEntry), thirdFixtureEntry.ts);

    expect(next.seq).toBe(2);
    expect(next.prevHash).toBe(thirdFixtureEntry.prevHash);
  });
});
