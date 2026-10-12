import { ReceiptConflictError, verifyChain } from "@stint/core";
import type { ReceiptEntry, ReceiptEntryInput, ReceiptStore } from "@stint/core";
import { createInMemoryReceiptStore } from "@stint/core/testing";
import { hashCanonical } from "@stint/spec";
import { describe, expect, it } from "vitest";

import { appendReceiptEntry, RECEIPT_APPEND_ATTEMPTS } from "../src/receipts/append.js";

function transitionInput(i: number): ReceiptEntryInput {
  return {
    chain: "verified",
    type: "transition",
    payload: { from: `state-${String(i)}`, event: "advance", actor: "runtime", to: `state-${String(i + 1)}` },
  };
}

/** Wraps `inner` so each `load` yields to the microtask queue after reading, opening the interleaving window. */
function withLoadAppendGap(inner: ReceiptStore): ReceiptStore {
  return {
    async load(chain) {
      const entries = await inner.load(chain);
      await Promise.resolve();
      await Promise.resolve();
      return entries;
    },
    append: (chain, entry) => inner.append(chain, entry),
    readCheckpoint: (chain) => inner.readCheckpoint(chain),
    writeCheckpoint: (checkpoint) => inner.writeCheckpoint(checkpoint),
  };
}

describe("appendReceiptEntry", () => {
  it("loads, derives and appends, returning the stored entry", async () => {
    const store = createInMemoryReceiptStore();

    const first = await appendReceiptEntry(store, transitionInput(0), 1000);
    const second = await appendReceiptEntry(store, transitionInput(1), 1001);

    expect(first.seq).toBe(0);
    expect(second.seq).toBe(1);
    expect(second.prevHash).toBe(hashCanonical(first));
    expect(await store.load("verified")).toEqual([first, second]);
  });

  it("two concurrent appends through a load/append gap both land: seq 0 and 1, chain verifies", async () => {
    const store = withLoadAppendGap(createInMemoryReceiptStore());

    const [a, b] = await Promise.all([
      appendReceiptEntry(store, transitionInput(0), 1000),
      appendReceiptEntry(store, transitionInput(1), 1001),
    ]);

    const stored = await store.load("verified");
    expect(stored).toHaveLength(2);
    expect(stored.map((e) => e.seq)).toEqual([0, 1]);
    expect([a.seq, b.seq].sort()).toEqual([0, 1]);
    const result = await verifyChain(stored);
    expect(result.ok).toBe(true);
  });

  it("many concurrent appends keep a gapless verifying chain when the writers fit inside the bound", async () => {
    const store = withLoadAppendGap(createInMemoryReceiptStore());
    const writers = RECEIPT_APPEND_ATTEMPTS;

    await Promise.all(
      Array.from({ length: writers }, (_, i) => appendReceiptEntry(store, transitionInput(i), 1000 + i)),
    );

    const stored = await store.load("verified");
    expect(stored.map((e) => e.seq)).toEqual(Array.from({ length: writers }, (_, i) => i));
    const result = await verifyChain(stored);
    expect(result.ok).toBe(true);
  });

  it("rethrows the ReceiptConflictError after exactly RECEIPT_APPEND_ATTEMPTS append attempts", async () => {
    const inner = createInMemoryReceiptStore();
    let appendAttempts = 0;
    let loads = 0;
    const store: ReceiptStore = {
      async load(chain) {
        loads += 1;
        return inner.load(chain);
      },
      append(chain) {
        appendAttempts += 1;
        return Promise.reject(new ReceiptConflictError(chain, 0));
      },
      readCheckpoint: (chain) => inner.readCheckpoint(chain),
      writeCheckpoint: (checkpoint) => inner.writeCheckpoint(checkpoint),
    };

    await expect(appendReceiptEntry(store, transitionInput(0), 1000)).rejects.toBeInstanceOf(ReceiptConflictError);

    expect(appendAttempts).toBe(RECEIPT_APPEND_ATTEMPTS);
    expect(loads).toBe(RECEIPT_APPEND_ATTEMPTS);
  });

  it("rethrows any other store error at once without another attempt", async () => {
    const inner = createInMemoryReceiptStore();
    let appendAttempts = 0;
    const boom = new Error("disk full");
    const store: ReceiptStore = {
      load: (chain) => inner.load(chain),
      append() {
        appendAttempts += 1;
        return Promise.reject(boom);
      },
      readCheckpoint: (chain) => inner.readCheckpoint(chain),
      writeCheckpoint: (checkpoint) => inner.writeCheckpoint(checkpoint),
    };

    await expect(appendReceiptEntry(store, transitionInput(0), 1000)).rejects.toBe(boom);

    expect(appendAttempts).toBe(1);
  });

  it("re-derives seq and prevHash from a reloaded chain after one conflict", async () => {
    const inner = createInMemoryReceiptStore();
    let injected = false;
    const store: ReceiptStore = {
      load: (chain) => inner.load(chain),
      async append(chain, entry) {
        if (!injected) {
          injected = true;
          // A rival writer lands first, then this append sees the conflict.
          const rival = await appendReceiptEntry(inner, transitionInput(9), 999);
          expect(rival.seq).toBe(0);
        }
        return inner.append(chain, entry);
      },
      readCheckpoint: (chain) => inner.readCheckpoint(chain),
      writeCheckpoint: (checkpoint) => inner.writeCheckpoint(checkpoint),
    };

    const entry: ReceiptEntry = await appendReceiptEntry(store, transitionInput(0), 1000);

    expect(entry.seq).toBe(1);
    const stored = await inner.load("verified");
    expect(stored).toHaveLength(2);
    const result = await verifyChain(stored);
    expect(result.ok).toBe(true);
  });
});
