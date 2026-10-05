import { afterEach, describe, expect, it } from "vitest";

import { appendEntry, mergeTimeline } from "@stint/core";
import type { Lease, ReceiptEntryInput } from "@stint/core";
import type { ReceiptChain, ReceiptEntry } from "@stint/spec";

import { EXIT_CODES } from "../src/exit.js";
import { main } from "../src/program.js";
import { NOW, createHarness } from "./helpers/cli-harness.js";
import type { Harness } from "./helpers/cli-harness.js";

const ESC = String.fromCharCode(27);

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const LEASE: Lease = {
  id: "lease-r1",
  state: "active",
  version: 2,
  boundHash: "jcs-sha256:deadbeef",
  grantedAt: NOW - 100,
  expiresAt: NOW + 3500,
  maxDurationSeconds: 3600,
  counters: { actionCount: 0, spentMinor: 0, denialErrorTimestamps: [], actionTimestamps: [] },
};

const HASH = "jcs-sha256:" + "a".repeat(64);

interface Seed {
  readonly chain: ReceiptChain;
  readonly ts: number;
  readonly input: Omit<ReceiptEntryInput, "chain">;
}

/** Appends real hash-linked entries through the real JSON receipt store. */
async function seed(harness: Harness, entries: readonly Seed[]): Promise<void> {
  const store = harness.deps.receiptStoreFactory(harness.root, LEASE.id);
  const chains: Record<ReceiptChain, ReceiptEntry[]> = { verified: [], attested: [] };
  for (const { chain, ts, input } of entries) {
    const entry = appendEntry(chains[chain], { ...input, chain } as ReceiptEntryInput, ts);
    chains[chain].push(entry);
    await store.append(chain, entry);
  }
}

async function harnessWithLease(): Promise<Harness> {
  const harness = await createHarness();
  h = harness;
  await harness.deps.storeFactory(harness.root).save(LEASE);
  return harness;
}

const VERIFIED_CALL: Seed = {
  chain: "verified",
  ts: NOW - 30,
  input: {
    type: "call",
    payload: {
      resource: "sheets.orders",
      argsHash: HASH,
      redactedSummary: "read range A1:D20",
      outcome: "allowed",
    },
  },
};
const ATTESTED_CLAIM: Seed = {
  chain: "attested",
  ts: NOW - 20,
  input: {
    type: "attested_claim",
    payload: {
      publisherId: "pub.example",
      kid: "k1",
      claimType: "job_completed",
      claimHash: HASH,
      sig: "sig-bytes",
    },
  },
};
const VERIFIED_TEARDOWN: Seed = {
  chain: "verified",
  ts: NOW - 10,
  input: { type: "teardown_step", payload: { step: "vault", outcome: "ok" } },
};

describe("stint receipts", () => {
  it("prints one tagged line per entry in chronological order", async () => {
    const harness = await harnessWithLease();
    // Each chain keeps its own append order; timeline order comes from mergeTimeline (ts).
    await seed(harness, [VERIFIED_CALL, VERIFIED_TEARDOWN, ATTESTED_CLAIM]);

    expect(await main(["--store", harness.root, "receipts", LEASE.id], harness.deps)).toBe(0);
    const lines = harness.stdout.join("").trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe(
      `${new Date((NOW - 30) * 1000).toISOString()} [verified] call allowed on sheets.orders: read range A1:D20`,
    );
    expect(lines[1]).toBe(
      `${new Date((NOW - 20) * 1000).toISOString()} [attested] publisher pub.example claims job_completed (not verified by the runtime)`,
    );
    expect(lines[2]).toBe(
      `${new Date((NOW - 10) * 1000).toISOString()} [verified] teardown vault: ok`,
    );
    expect(harness.stderr.join("")).toBe("");
  });

  it("describes a state transition with event and actor", async () => {
    const harness = await harnessWithLease();
    await seed(harness, [
      {
        chain: "verified",
        ts: NOW - 5,
        input: {
          type: "transition",
          payload: { from: "granted", event: "activate", actor: "runtime", to: "active" },
        },
      },
    ]);
    await main(["--store", harness.root, "receipts", LEASE.id], harness.deps);
    expect(harness.stdout.join("")).toContain(
      "[verified] lease granted -> active (activate by runtime)",
    );
  });

  it("--json emits exactly the mergeTimeline array, uncolored", async () => {
    const harness = await harnessWithLease();
    await seed(harness, [VERIFIED_CALL, VERIFIED_TEARDOWN, ATTESTED_CLAIM]);
    const store = harness.deps.receiptStoreFactory(harness.root, LEASE.id);
    const expected = mergeTimeline(await store.load("verified"), await store.load("attested"));

    expect(
      await main(["--store", harness.root, "--json", "receipts", LEASE.id], harness.deps),
    ).toBe(0);
    const out = harness.stdout.join("");
    expect(out).not.toContain(ESC);
    expect(JSON.parse(out)).toEqual(JSON.parse(JSON.stringify(expected)));
  });

  it("renders verified-only when the attested chain is empty", async () => {
    const harness = await harnessWithLease();
    await seed(harness, [VERIFIED_CALL, VERIFIED_TEARDOWN]);
    expect(await main(["--store", harness.root, "receipts", LEASE.id], harness.deps)).toBe(0);
    const out = harness.stdout.join("");
    expect(out.trimEnd().split("\n")).toHaveLength(2);
    expect(out).not.toContain("[attested]");
  });

  it("succeeds with a friendly line when the lease has no receipts at all", async () => {
    const harness = await harnessWithLease();
    expect(await main(["--store", harness.root, "receipts", LEASE.id], harness.deps)).toBe(0);
    expect(harness.stdout.join("")).toContain("No receipts");
    expect(
      await main(["--store", harness.root, "--json", "receipts", LEASE.id], harness.deps),
    ).toBe(0);
    expect(harness.stdout.join("").trim().endsWith("[]")).toBe(true);
  });

  it("prints only the redacted summary, never the args hash or attestation signature", async () => {
    const harness = await harnessWithLease();
    await seed(harness, [VERIFIED_CALL, ATTESTED_CLAIM]);
    await main(["--store", harness.root, "receipts", LEASE.id], harness.deps);
    const out = harness.stdout.join("");
    expect(out).toContain("read range A1:D20");
    expect(out).not.toContain(HASH);
    expect(out).not.toContain("sig-bytes");
  });

  it("neutralizes terminal control sequences that a receipt carries", async () => {
    const harness = await harnessWithLease();
    await seed(harness, [
      {
        chain: "verified",
        ts: NOW - 1,
        input: {
          type: "call",
          payload: {
            resource: "sheets.orders",
            argsHash: HASH,
            redactedSummary: `${ESC}[31mred${ESC}[0m\r\nforged line`,
            outcome: "denied",
          },
        },
      },
    ]);
    await main(["--store", harness.root, "receipts", LEASE.id], harness.deps);
    const out = harness.stdout.join("");
    expect(out).not.toContain(ESC);
    expect(out).not.toContain("\r");
    expect(out.trimEnd().split("\n")).toHaveLength(1);
  });

  it("does not throw on a hand-edited entry with a missing payload", async () => {
    const harness = await harnessWithLease();
    const store = harness.deps.receiptStoreFactory(harness.root, LEASE.id);
    await store.append("verified", {
      seq: 0,
      ts: NOW,
      chain: "verified",
      type: "call",
      prevHash: HASH,
    } as unknown as ReceiptEntry);
    expect(await main(["--store", harness.root, "receipts", LEASE.id], harness.deps)).toBe(0);
    expect(harness.stdout.join("")).toContain("call ? on ?: ?");
  });

  it("exits 4 for an unknown lease and 2 for an unsafe id", async () => {
    const harness = await harnessWithLease();
    expect(await main(["--store", harness.root, "receipts", "nope"], harness.deps)).toBe(
      EXIT_CODES.leaseNotFound,
    );
    expect(await main(["--store", harness.root, "receipts", "../evil"], harness.deps)).toBe(
      EXIT_CODES.usage,
    );
  });
});

function revokeStep(ts: number, outcome: string, resource?: string): Seed {
  return {
    chain: "verified",
    ts,
    input: {
      type: "teardown_step",
      payload: {
        step: "revoke_oauth",
        outcome,
        ...(resource === undefined ? {} : { resource }),
      },
    } as Omit<ReceiptEntryInput, "chain">,
  };
}

function toCleanedUp(ts: number): Seed {
  return {
    chain: "verified",
    ts,
    input: {
      type: "transition",
      payload: {
        from: "tearing_down",
        event: "teardown_succeeded",
        actor: "runtime",
        to: "cleaned_up",
      },
    },
  };
}

describe("stint receipts: SPEC-07 caveat", () => {
  it("labels the cleaned_up transition and names the credential to rotate", async () => {
    const harness = await harnessWithLease();
    await seed(harness, [
      revokeStep(NOW - 30, "discarded_revocation_unsupported", "sheets.orders"),
      revokeStep(NOW - 29, "discarded_revocation_unsupported"),
      toCleanedUp(NOW - 10),
    ]);
    expect(await main(["--store", harness.root, "receipts", LEASE.id], harness.deps)).toBe(0);
    const lines = harness.stdout.join("").trimEnd().split("\n");

    expect(lines[0]).toContain(
      "teardown revoke_oauth: discarded_revocation_unsupported for sheets.orders (not revoked upstream; rotate it in the provider dashboard)",
    );
    // The aggregate receipt names no credential, so it keeps the original shape.
    expect(lines[1]).toMatch(/teardown revoke_oauth: discarded_revocation_unsupported$/);
    expect(lines[2]).toContain(
      "lease tearing_down -> cleaned_up (credential not revoked upstream) (teardown_succeeded by runtime)",
    );
    expect(harness.stderr.join("")).toBe("");
  });

  it("a fully revoked chain shows neither the label nor the rotate instruction", async () => {
    const harness = await harnessWithLease();
    await seed(harness, [revokeStep(NOW - 30, "revoked", "sheets.orders"), toCleanedUp(NOW - 10)]);
    await main(["--store", harness.root, "receipts", LEASE.id], harness.deps);
    const out = harness.stdout.join("");

    expect(out).toContain("teardown revoke_oauth: revoked for sheets.orders\n");
    expect(out).toContain("lease tearing_down -> cleaned_up (teardown_succeeded by runtime)");
    expect(out).not.toContain("not revoked upstream");
    expect(out).not.toContain("rotate it in the provider dashboard");
  });

  it("a teardown step without a resource renders exactly as before", async () => {
    const harness = await harnessWithLease();
    await seed(harness, [VERIFIED_TEARDOWN]);
    await main(["--store", harness.root, "receipts", LEASE.id], harness.deps);
    expect(harness.stdout.join("")).toContain("[verified] teardown vault: ok\n");
  });

  it("sanitizes a resource name that carries an escape or bidi character (T-08-05)", async () => {
    const harness = await harnessWithLease();
    const bidi = String.fromCharCode(0x202e);
    await seed(harness, [
      revokeStep(
        NOW - 30,
        "discarded_revocation_unsupported",
        `evil${ESC}[31m${bidi}name\r\nforged line`,
      ),
    ]);
    await main(["--store", harness.root, "receipts", LEASE.id], harness.deps);
    const out = harness.stdout.join("");

    expect(out).not.toContain(ESC);
    expect(out).not.toContain(bidi);
    expect(out).not.toContain("\r");
    expect(out.trimEnd().split("\n")).toHaveLength(1);
    expect(out).toContain("for evilname forged line");
  });
});
