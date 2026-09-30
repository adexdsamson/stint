import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RECEIPT_VERIFY_REASONS, appendEntry, signCheckpoint, verifyChain } from "@stint/core";
import type { Lease } from "@stint/core";
import type { ReceiptChain, ReceiptEntry } from "@stint/spec";
import { generateKeyPair } from "jose";

import { EXIT_CODES } from "../src/exit.js";
import { leaseDir } from "../src/paths.js";
import { main } from "../src/program.js";
import { REASON_MESSAGES } from "../src/render/verify.js";
import { NOW, createHarness } from "./helpers/cli-harness.js";
import type { Harness } from "./helpers/cli-harness.js";

const ESC = String.fromCharCode(27);

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const LEASE: Lease = {
  id: "lease-v1",
  state: "revoked",
  version: 3,
  boundHash: "jcs-sha256:deadbeef",
  grantedAt: NOW - 100,
  expiresAt: NOW + 3500,
  maxDurationSeconds: 3600,
  counters: { actionCount: 0, spentMinor: 0, denialErrorTimestamps: [], actionTimestamps: [] },
};

const HASH = "jcs-sha256:" + "b".repeat(64);
const CHAIN_LENGTH = 4;

async function harnessWithLease(): Promise<Harness> {
  const harness = await createHarness();
  h = harness;
  await harness.deps.storeFactory(harness.root).save(LEASE);
  return harness;
}

/** Appends `CHAIN_LENGTH` real hash-linked call entries through the real JSON store. */
async function seedVerified(harness: Harness, count = CHAIN_LENGTH): Promise<ReceiptEntry[]> {
  const store = harness.deps.receiptStoreFactory(harness.root, LEASE.id);
  const entries: ReceiptEntry[] = [];
  for (let i = 0; i < count; i++) {
    const entry = appendEntry(
      entries,
      {
        chain: "verified",
        type: "call",
        payload: {
          resource: "sheets.orders",
          argsHash: HASH,
          redactedSummary: `read row ${String(i)}`,
          outcome: "allowed",
        },
      },
      NOW - 100 + i,
    );
    entries.push(entry);
    await store.append("verified", entry);
  }
  return entries;
}

/** Signs and stores a checkpoint over the whole seeded chain with the runtime key. */
async function checkpointVerified(harness: Harness, entries: readonly ReceiptEntry[]) {
  const key = await harness.deps.keys.loadOrCreate(harness.root);
  const result = await verifyChain(entries);
  if (!result.ok) throw new Error("seeded chain must verify");
  const checkpoint = await signCheckpoint(
    "verified",
    result.value.count,
    result.value.headHash,
    NOW,
    key.privateKey,
  );
  await harness.deps.receiptStoreFactory(harness.root, LEASE.id).writeCheckpoint(checkpoint);
  return checkpoint;
}

function chainPath(harness: Harness, chain: ReceiptChain): string {
  return path.join(leaseDir(harness.root, LEASE.id), "receipts", `${chain}.json`);
}

/** Edits the on-disk chain file between CLI calls, the way a tamperer would. */
async function editChain(
  harness: Harness,
  edit: (entries: Record<string, unknown>[]) => Record<string, unknown>[],
  chain: ReceiptChain = "verified",
): Promise<void> {
  const file = chainPath(harness, chain);
  const entries = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>[];
  await writeFile(file, JSON.stringify(edit(entries)));
}

function payloadOf(entry: Record<string, unknown> | undefined): Record<string, unknown> {
  return (entry as { payload: Record<string, unknown> }).payload;
}

const verify = (harness: Harness, ...extra: string[]): Promise<number> =>
  main(["--store", harness.root, ...extra, "verify", LEASE.id], harness.deps);

describe("stint verify", () => {
  it("passes a clean chain, printing the entry count and exiting 0", async () => {
    const harness = await harnessWithLease();
    const entries = await seedVerified(harness);
    await checkpointVerified(harness, entries);

    expect(await verify(harness)).toBe(0);
    const out = harness.stdout.join("");
    expect(out).toContain("verified chain: 4 entries verified");
    expect(out).toContain("attested chain: 0 entries verified");
    expect(out).toContain("4 entries in total");
  });

  it("passes when a lease has no receipts at all", async () => {
    const harness = await harnessWithLease();
    expect(await verify(harness)).toBe(0);
    expect(harness.stdout.join("")).toContain("0 entries in total");
  });

  it("reports a mid-chain payload edit at entry N+1 as hash_mismatch (exit 6)", async () => {
    const harness = await harnessWithLease();
    const entries = await seedVerified(harness);
    await checkpointVerified(harness, entries);
    const n = 1;
    await editChain(harness, (e) => {
      payloadOf(e[n]).redactedSummary = "edited after the fact";
      return e;
    });

    expect(await verify(harness)).toBe(EXIT_CODES.chainBroken);
    const out = harness.stdout.join("");
    expect(out).toContain(`broken at entry ${String(n + 1)}`);
    expect(out).toContain("[hash_mismatch]");
    expect(out).toContain(REASON_MESSAGES.hash_mismatch);
  });

  it("--json reports the structured break locus", async () => {
    const harness = await harnessWithLease();
    await seedVerified(harness);
    await editChain(harness, (e) => {
      payloadOf(e[0]).redactedSummary = "edited";
      return e;
    });

    expect(await verify(harness, "--json")).toBe(EXIT_CODES.chainBroken);
    const out = harness.stdout.join("");
    expect(out).not.toContain(ESC);
    const parsed = JSON.parse(out) as {
      verified: { ok: boolean; errors: { brokenAtSeq: number; reason: string }[] };
      attested: { ok: boolean };
    };
    expect(parsed.verified.ok).toBe(false);
    expect(parsed.verified.errors).toEqual([{ brokenAtSeq: 1, reason: "hash_mismatch" }]);
    expect(parsed.attested.ok).toBe(true);
  });

  it("catches a final-entry edit only through the checkpoint, at checkpoint.count-1", async () => {
    const harness = await harnessWithLease();
    const entries = await seedVerified(harness);
    const tamper = (e: Record<string, unknown>[]): Record<string, unknown>[] => {
      payloadOf(e[CHAIN_LENGTH - 1]).redactedSummary = "edited last entry";
      return e;
    };

    // Without a checkpoint nothing points at the last entry, so the walk cannot see the edit.
    await editChain(harness, tamper);
    expect(await verify(harness)).toBe(0);
    expect(harness.stdout.join("")).toContain("no signed checkpoint");

    // Restore, anchor with a checkpoint, and edit again.
    await editChain(harness, (e) => {
      payloadOf(e[CHAIN_LENGTH - 1]).redactedSummary = `read row ${String(CHAIN_LENGTH - 1)}`;
      return e;
    });
    const checkpoint = await checkpointVerified(harness, entries);
    await editChain(harness, tamper);

    expect(await verify(harness, "--json")).toBe(EXIT_CODES.chainBroken);
    const parsed = JSON.parse(harness.stdout.join("").trim().split("\n").at(-1) ?? "") as {
      verified: { errors: { brokenAtSeq: number; reason: string }[] };
    };
    expect(parsed.verified.errors).toEqual([
      { brokenAtSeq: checkpoint.count - 1, reason: "hash_mismatch" },
    ]);
  });

  it("reports a deleted tail as truncated", async () => {
    const harness = await harnessWithLease();
    const entries = await seedVerified(harness);
    await checkpointVerified(harness, entries);
    await editChain(harness, (e) => e.slice(0, 3));

    expect(await verify(harness)).toBe(EXIT_CODES.chainBroken);
    const out = harness.stdout.join("");
    expect(out).toContain("broken at entry 3");
    expect(out).toContain("[truncated]");
  });

  it("reports two swapped entries as reordered", async () => {
    const harness = await harnessWithLease();
    const entries = await seedVerified(harness);
    await checkpointVerified(harness, entries);
    await editChain(harness, (e) => {
      const [a, b] = [e[1], e[2]];
      if (a === undefined || b === undefined) throw new Error("seed missing");
      e[1] = b;
      e[2] = a;
      return e;
    });

    expect(await verify(harness)).toBe(EXIT_CODES.chainBroken);
    expect(harness.stdout.join("")).toContain("[reordered]");
  });

  it("reports an altered checkpoint as checkpoint_sig_invalid", async () => {
    const harness = await harnessWithLease();
    const entries = await seedVerified(harness);
    const checkpoint = await checkpointVerified(harness, entries);
    await harness.deps
      .receiptStoreFactory(harness.root, LEASE.id)
      .writeCheckpoint({ ...checkpoint, count: checkpoint.count - 1 });

    expect(await verify(harness)).toBe(EXIT_CODES.chainBroken);
    expect(harness.stdout.join("")).toContain("[checkpoint_sig_invalid]");
  });

  it("fails closed when a checkpoint exists but the runtime public key does not", async () => {
    const harness = await harnessWithLease();
    const entries = await seedVerified(harness);
    const result = await verifyChain(entries);
    if (!result.ok) throw new Error("seeded chain must verify");
    const stranger = await generateKeyPair("EdDSA", { crv: "Ed25519" });
    const checkpoint = await signCheckpoint(
      "verified",
      result.value.count,
      result.value.headHash,
      NOW,
      stranger.privateKey,
    );
    await harness.deps.receiptStoreFactory(harness.root, LEASE.id).writeCheckpoint(checkpoint);

    // No runtime key was ever created in this store.
    expect(await verify(harness)).toBe(EXIT_CODES.chainBroken);
    expect(harness.stdout.join("")).toContain("[checkpoint_sig_invalid]");
  });

  it("reports an untrusted attested claim as claim_sig_invalid", async () => {
    const harness = await harnessWithLease();
    const store = harness.deps.receiptStoreFactory(harness.root, LEASE.id);
    const claim = appendEntry(
      [],
      {
        chain: "attested",
        type: "attested_claim",
        payload: {
          publisherId: "pub.unknown",
          kid: "k1",
          claimType: "job_completed",
          claimHash: HASH,
          sig: "not-a-real-signature",
        },
      },
      NOW,
    );
    await store.append("attested", claim);

    expect(await verify(harness)).toBe(EXIT_CODES.chainBroken);
    const out = harness.stdout.join("");
    expect(out).toContain("attested chain broken at entry 0");
    expect(out).toContain("[claim_sig_invalid]");
  });

  it("prints no receipt content or secrets in its messages", async () => {
    const harness = await harnessWithLease();
    await seedVerified(harness);
    await editChain(harness, (e) => {
      payloadOf(e[0]).redactedSummary = `${ESC}[31mforged${ESC}[0m`;
      return e;
    });
    expect(await verify(harness)).toBe(EXIT_CODES.chainBroken);
    const out = harness.allOutput();
    expect(out).not.toContain(ESC);
    expect(out).not.toContain("forged");
    expect(out).not.toContain(HASH);
  });

  it("exits 4 for an unknown lease and 2 for an unsafe id", async () => {
    const harness = await harnessWithLease();
    expect(await main(["--store", harness.root, "verify", "nope"], harness.deps)).toBe(
      EXIT_CODES.leaseNotFound,
    );
    expect(await main(["--store", harness.root, "verify", "../evil"], harness.deps)).toBe(
      EXIT_CODES.usage,
    );
  });

  it("`receipts --verify` runs the same verification", async () => {
    const harness = await harnessWithLease();
    await seedVerified(harness);
    await editChain(harness, (e) => {
      payloadOf(e[0]).redactedSummary = "edited";
      return e;
    });
    expect(
      await main(["--store", harness.root, "receipts", "--verify", LEASE.id], harness.deps),
    ).toBe(EXIT_CODES.chainBroken);
  });

  it("has a plain-language message for every reason in the enum", () => {
    for (const reason of RECEIPT_VERIFY_REASONS) {
      expect(REASON_MESSAGES[reason].length).toBeGreaterThan(10);
    }
    expect(Object.keys(REASON_MESSAGES).sort()).toEqual([...RECEIPT_VERIFY_REASONS].sort());
  });
});
