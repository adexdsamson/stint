import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { ReceiptEntry } from "@stint/spec";

import { GENESIS_PREV_HASH, appendEntry, verifyChain } from "../../src/receipts/chain.js";
import type { ReceiptEntryInput } from "../../src/receipts/chain.js";

// packages/core/test/receipts -> packages/core/test -> packages/core -> packages -> repo root
const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, "..", "..", "..", "..");

// @stint/core does not depend on ajv; resolve the validator the spec package already ships.
const requireFromSpec = createRequire(path.join(repoRoot, "packages", "spec", "package.json"));
interface SchemaValidator {
  (value: unknown): boolean;
  errors?: unknown;
}
const { Ajv } = requireFromSpec("ajv") as {
  Ajv: new (options: object) => { compile(schema: object): SchemaValidator };
};
const receiptSchema: unknown = JSON.parse(
  readFileSync(path.join(repoRoot, "spec", "receipt.schema.json"), "utf8"),
);
const validateReceiptEntry = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true }).compile(
  receiptSchema as object,
);

const transition: ReceiptEntryInput = {
  chain: "verified",
  type: "transition",
  payload: { from: "active", event: "begin_teardown", actor: "system", to: "tearing_down" },
};

const takeover: ReceiptEntryInput = {
  chain: "verified",
  type: "teardown_takeover",
  payload: { previousEpoch: 1, epoch: 2, reason: "fence_expired" },
};

describe("teardown_takeover receipt entries", () => {
  it("appends with seq equal to the chain length and links prevHash to the previous entry", () => {
    const first = appendEntry([], transition, 1000);
    const second = appendEntry([first], takeover, 2000);
    expect(second.type).toBe("teardown_takeover");
    expect(second.seq).toBe(1);
    expect(second.ts).toBe(2000);
    expect(second.prevHash).not.toBe(GENESIS_PREV_HASH);
    expect(second.payload).toEqual({ previousEpoch: 1, epoch: 2, reason: "fence_expired" });
  });

  it("links to genesis when it is the first entry", () => {
    const entry = appendEntry([], takeover, 1000);
    expect(entry.seq).toBe(0);
    expect(entry.prevHash).toBe(GENESIS_PREV_HASH);
  });

  it("produces an entry that validates against spec/receipt.schema.json", () => {
    const entry = appendEntry([], takeover, 1000);
    expect(validateReceiptEntry(entry), JSON.stringify(validateReceiptEntry.errors)).toBe(true);
  });

  it("verifies in a chain with other entry kinds", async () => {
    const chain: ReceiptEntry[] = [];
    chain.push(appendEntry(chain, transition, 1000));
    chain.push(appendEntry(chain, takeover, 2000));
    chain.push(
      appendEntry(
        chain,
        { chain: "verified", type: "teardown_step", payload: { step: "revoke_oauth", outcome: "ok" } },
        3000,
      ),
    );
    const result = await verifyChain(chain);
    expect(result.ok).toBe(true);
  });

  it("detects tampering with a takeover payload", async () => {
    const chain: ReceiptEntry[] = [];
    chain.push(appendEntry(chain, takeover, 1000));
    chain.push(appendEntry(chain, transition, 2000));
    const [head, tail] = chain;
    if (head === undefined || tail === undefined) throw new Error("chain must have two entries");
    const tampered: ReceiptEntry[] = [
      { ...head, payload: { previousEpoch: 1, epoch: 3, reason: "fence_expired" } } as ReceiptEntry,
      tail,
    ];
    const result = await verifyChain(tampered);
    expect(result.ok).toBe(false);
  });
});
