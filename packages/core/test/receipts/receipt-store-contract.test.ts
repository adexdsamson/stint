import { describe, expect, it } from "vitest";

import type { ReceiptEntry } from "@stint/spec";

import { appendEntry, verifyChain } from "../../src/receipts/chain.js";
import { createInMemoryReceiptStore } from "../../src/testing.js";

describe("createInMemoryReceiptStore: append/load/checkpoint round-trip (D-08)", () => {
  it("a fresh store's load returns [] and readCheckpoint returns undefined", async () => {
    const store = createInMemoryReceiptStore();

    expect(await store.load("verified")).toEqual([]);
    expect(await store.readCheckpoint("verified")).toBeUndefined();
  });

  it("append then load returns the appended entries in append order for that chain", async () => {
    const store = createInMemoryReceiptStore();

    let chain: readonly ReceiptEntry[] = [];
    const first = appendEntry(
      chain,
      { chain: "verified", type: "transition", payload: { from: "created", event: "activate", actor: "runtime", to: "active" } },
      1000,
    );
    chain = [...chain, first];
    const second = appendEntry(
      chain,
      { chain: "verified", type: "call", payload: { resource: "sheets:read", argsHash: "jcs-sha256:aa", redactedSummary: "read row", outcome: "allowed" } },
      1001,
    );

    await store.append("verified", first);
    await store.append("verified", second);

    const loaded = await store.load("verified");
    expect(loaded).toEqual([first, second]);
  });

  it("the two chains are stored separately", async () => {
    const store = createInMemoryReceiptStore();

    const verifiedEntry = appendEntry(
      [],
      { chain: "verified", type: "transition", payload: { from: "created", event: "activate", actor: "runtime", to: "active" } },
      1000,
    );
    const attestedEntry = appendEntry(
      [],
      {
        chain: "attested",
        type: "attested_claim",
        payload: { publisherId: "pub-1", kid: "key-1", claimType: "usage", claimHash: "jcs-sha256:bb", sig: "sig" },
      },
      1000,
    );

    await store.append("verified", verifiedEntry);
    await store.append("attested", attestedEntry);

    expect(await store.load("verified")).toEqual([verifiedEntry]);
    expect(await store.load("attested")).toEqual([attestedEntry]);
  });

  it("writeCheckpoint then readCheckpoint returns the same checkpoint value", async () => {
    const store = createInMemoryReceiptStore();
    const checkpoint = { chain: "verified" as const, count: 0, headHash: "jcs-sha256:" + "0".repeat(64), ts: 1000, sig: "sig" };

    await store.writeCheckpoint(checkpoint);

    expect(await store.readCheckpoint("verified")).toEqual(checkpoint);
  });

  it("a chain loaded back still passes verifyChain (persistence does not alter linkage)", async () => {
    const store = createInMemoryReceiptStore();

    let chain: readonly ReceiptEntry[] = [];
    const first = appendEntry(
      chain,
      { chain: "verified", type: "transition", payload: { from: "created", event: "activate", actor: "runtime", to: "active" } },
      1000,
    );
    chain = [...chain, first];
    const second = appendEntry(
      chain,
      { chain: "verified", type: "call", payload: { resource: "sheets:read", argsHash: "jcs-sha256:aa", redactedSummary: "read row", outcome: "allowed" } },
      1001,
    );

    await store.append("verified", first);
    await store.append("verified", second);

    const loaded = await store.load("verified");
    const result = await verifyChain(loaded);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.count).toBe(2);
    }
  });
});
