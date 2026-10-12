import { describe, expect, it } from "vitest";

import type { ReceiptEntry } from "@stint/spec";

import { GENESIS_PREV_HASH, appendEntry, verifyChain } from "../../src/receipts/chain.js";
import type { ReceiptEntryInput } from "../../src/receipts/chain.js";

const transition: ReceiptEntryInput = {
  chain: "verified",
  type: "transition",
  payload: { from: "active", event: "begin_teardown", actor: "system", to: "tearing_down" },
};

const blocked: ReceiptEntryInput = {
  chain: "verified",
  type: "teardown_blocked",
  payload: { reason: "credentials_unavailable", resources: ["a", "b"] },
};

describe("teardown_blocked receipt entries", () => {
  it("appends with seq equal to the chain length and links prevHash to the previous entry", () => {
    const first = appendEntry([], transition, 1000);
    const second = appendEntry([first], blocked, 2000);
    expect(second.type).toBe("teardown_blocked");
    expect(second.seq).toBe(1);
    expect(second.ts).toBe(2000);
    expect(second.prevHash).not.toBe(GENESIS_PREV_HASH);
    expect(second.payload).toEqual({ reason: "credentials_unavailable", resources: ["a", "b"] });
  });

  it("links to genesis when it is the first entry", () => {
    const entry = appendEntry([], blocked, 1000);
    expect(entry.seq).toBe(0);
    expect(entry.prevHash).toBe(GENESIS_PREV_HASH);
  });

  it("verifies in a chain with other entry kinds", async () => {
    const chain: ReceiptEntry[] = [];
    chain.push(appendEntry(chain, transition, 1000));
    chain.push(appendEntry(chain, blocked, 2000));
    chain.push(
      appendEntry(chain, { chain: "verified", type: "teardown_step", payload: { step: "revoke_oauth", outcome: "ok" } }, 3000),
    );
    const result = await verifyChain(chain);
    expect(result.ok).toBe(true);
  });

  it("detects tampering with a blocked payload", async () => {
    const chain: ReceiptEntry[] = [];
    chain.push(appendEntry(chain, blocked, 1000));
    chain.push(appendEntry(chain, transition, 2000));
    const [head, tail] = chain;
    if (head === undefined || tail === undefined) throw new Error("chain must have two entries");
    const tampered: ReceiptEntry[] = [
      { ...head, payload: { reason: "credentials_unavailable", resources: ["x"] } } as ReceiptEntry,
      tail,
    ];
    const result = await verifyChain(tampered);
    expect(result.ok).toBe(false);
  });
});
