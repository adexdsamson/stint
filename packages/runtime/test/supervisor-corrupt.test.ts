import type { LeaseScanEntry, ReceiptStore } from "@stint/core";
import { makeTestLease } from "@stint/core/testing";
import { describe, expect, it } from "vitest";

import { DEFAULT_SUPERVISOR_CONFIG, RuntimeError, createSweepState, runSweep, seedLeaseCredentials } from "../src/index.js";
import type { RuntimePorts, SweepEvent, SweepState } from "../src/index.js";
import { buildRig, delegatedManifest, oauthCredential } from "./helpers.js";

const T0 = 5000;
const REPEAT = DEFAULT_SUPERVISOR_CONFIG.corruptRepeatSeconds;

/** A failure only the injected predicate recognises as corruption. */
class FakeCorruptError extends Error {}

interface Harness {
  readonly ports: RuntimePorts;
  readonly now: { value: number };
  readonly state: SweepState;
  /** Lease ids whose record the store reports unreadable, with the fingerprint it reports. */
  readonly unreadable: Map<string, { unreadable: "corrupt" | "io_error"; fingerprint: string }>;
  /** Lease ids whose receipt store throws on load, and what it throws. */
  readonly brokenReceipts: Map<string, Error>;
}

/** `ids` are all expired leases with credentials seeded. */
async function setup(ids: readonly string[]): Promise<Harness> {
  const first = ids[0] ?? "lease-a";
  const rig = await buildRig(first, delegatedManifest(["sheets.orders"]));
  const envelope = await rig.ports.artifacts.get(first, "envelope");
  const now = { value: T0 };
  const unreadable = new Map<string, { unreadable: "corrupt" | "io_error"; fingerprint: string }>();
  const brokenReceipts = new Map<string, Error>();
  const ports: RuntimePorts = {
    ...rig.ports,
    clock: () => now.value,
    leases: {
      ...rig.ports.leases,
      scan: async (): Promise<readonly LeaseScanEntry[]> => {
        const real = await rig.ports.leases.scan();
        const out: LeaseScanEntry[] = [];
        for (const entry of real) {
          const bad = unreadable.get(entry.id);
          out.push(bad === undefined ? entry : { id: entry.id, ...bad });
        }
        for (const [id, bad] of unreadable) {
          if (!real.some((entry) => entry.id === id)) out.push({ id, ...bad });
        }
        return out.sort((a, b) => (a.id < b.id ? -1 : 1));
      },
    },
    receipts: (id): ReceiptStore => {
      const real = rig.ports.receipts(id);
      const error = brokenReceipts.get(id);
      if (error === undefined) return real;
      return {
        ...real,
        load: () => Promise.reject(error),
      };
    },
  };
  for (const id of ids) {
    await ports.leases.save(makeTestLease(id, { state: "expired" }));
    if (id !== first) await ports.artifacts.put(id, "envelope", envelope);
    await seedLeaseCredentials(ports, id, {
      "sheets.orders": oauthCredential("https://as.example.test/token", undefined),
    });
  }
  return { ports, now, state: createSweepState(), unreadable, brokenReceipts };
}

async function sweep(
  h: Harness,
  at?: number,
  extra: { state?: SweepState; isStoreCorrupt?: (error: unknown) => boolean } = {},
): Promise<readonly SweepEvent[]> {
  if (at !== undefined) h.now.value = at;
  const report = await runSweep(h.ports, {
    state: extra.state ?? h.state,
    ...(extra.isStoreCorrupt === undefined ? {} : { isStoreCorrupt: extra.isStoreCorrupt }),
  });
  return report.events;
}

async function stateOf(h: Harness, id: string): Promise<string | undefined> {
  return (await h.ports.leases.load(id))?.state;
}

const isFake = (error: unknown): boolean => error instanceof FakeCorruptError;

describe("a corrupt lease record among several leases (SUP-05)", () => {
  it("reports the corrupt record and still tears down every other lease in the same sweep", async () => {
    const h = await setup(["lease-a", "lease-b", "lease-c"]);
    h.unreadable.set("lease-b", { unreadable: "corrupt", fingerprint: "f1" });

    const events = await sweep(h);

    expect(events.filter((e) => e.kind === "corrupt_record")).toEqual([
      { kind: "corrupt_record", leaseId: "lease-b", unreadable: "corrupt" },
    ]);
    expect(events.filter((e) => e.kind === "torn_down").map((e) => e.leaseId)).toEqual(["lease-a", "lease-c"]);
    expect(await stateOf(h, "lease-a")).toBe("cleaned_up");
    expect(await stateOf(h, "lease-c")).toBe("cleaned_up");
  });

  it("does not report again at the same fingerprint, but reports a changed fingerprint", async () => {
    const h = await setup(["lease-b"]);
    h.unreadable.set("lease-b", { unreadable: "corrupt", fingerprint: "f1" });

    expect(await sweep(h, T0)).toHaveLength(1);
    expect(await sweep(h, T0 + 10)).toEqual([]);
    expect(await sweep(h, T0 + 20)).toEqual([]);

    h.unreadable.set("lease-b", { unreadable: "corrupt", fingerprint: "f2" });
    expect(await sweep(h, T0 + 30)).toEqual([{ kind: "corrupt_record", leaseId: "lease-b", unreadable: "corrupt" }]);
    expect(await sweep(h, T0 + 40)).toEqual([]);
  });

  it("repeats after exactly corruptRepeatSeconds and not one second earlier", async () => {
    const h = await setup(["lease-b"]);
    h.unreadable.set("lease-b", { unreadable: "corrupt", fingerprint: "f1" });

    expect(await sweep(h, T0)).toHaveLength(1);
    expect(await sweep(h, T0 + REPEAT - 1)).toEqual([]);
    expect(await sweep(h, T0 + REPEAT)).toEqual([{ kind: "corrupt_record", leaseId: "lease-b", unreadable: "corrupt" }]);
    // The quiet period restarts from the repeat.
    expect(await sweep(h, T0 + REPEAT + REPEAT - 1)).toEqual([]);
    expect(await sweep(h, T0 + REPEAT + REPEAT)).toHaveLength(1);
  });

  it("reports a record that became readable and is corrupted again, even at the old fingerprint", async () => {
    const h = await setup(["lease-b"]);
    h.unreadable.set("lease-b", { unreadable: "corrupt", fingerprint: "f1" });
    expect(await sweep(h, T0)).toHaveLength(1);

    h.unreadable.delete("lease-b");
    const repaired = await sweep(h, T0 + 10);
    expect(repaired.map((e) => e.kind)).toEqual(["torn_down"]);

    await h.ports.leases.save(makeTestLease("lease-b", { state: "active", expiresAt: 0 }));
    h.unreadable.set("lease-b", { unreadable: "corrupt", fingerprint: "f1" });
    expect(await sweep(h, T0 + 20)).toEqual([{ kind: "corrupt_record", leaseId: "lease-b", unreadable: "corrupt" }]);
  });

  it("reports every lease and does nothing else when every record is corrupt", async () => {
    const h = await setup(["lease-a", "lease-b", "lease-c"]);
    for (const id of ["lease-a", "lease-b", "lease-c"]) {
      h.unreadable.set(id, { unreadable: "corrupt", fingerprint: `fp-${id}` });
    }

    const events = await sweep(h);

    expect(events).toEqual([
      { kind: "corrupt_record", leaseId: "lease-a", unreadable: "corrupt" },
      { kind: "corrupt_record", leaseId: "lease-b", unreadable: "corrupt" },
      { kind: "corrupt_record", leaseId: "lease-c", unreadable: "corrupt" },
    ]);
    for (const id of ["lease-a", "lease-b", "lease-c"]) expect(await stateOf(h, id)).toBe("expired");
  });

  it("emits supervisor.corrupt_record telemetry only when a report is emitted", async () => {
    const h = await setup(["lease-b"]);
    const seen: unknown[] = [];
    const ports: RuntimePorts = { ...h.ports, telemetry: { emit: (event) => void seen.push(event) } };
    h.unreadable.set("lease-b", { unreadable: "corrupt", fingerprint: "f1" });

    await runSweep(ports, { state: h.state });
    await runSweep(ports, { state: h.state });

    expect(seen.filter((e) => (e as { name: string }).name === "supervisor.corrupt_record")).toEqual([
      { name: "supervisor.corrupt_record", leaseId: "lease-b" },
    ]);
  });
});

describe("corrupt per-lease data is isolated (SUP-05)", () => {
  it("reports a lease whose receipts the predicate calls corrupt and still tears down the others", async () => {
    const h = await setup(["lease-a", "lease-b", "lease-c"]);
    h.brokenReceipts.set("lease-b", new FakeCorruptError("receipts"));

    const events = await sweep(h, undefined, { isStoreCorrupt: isFake });

    expect(events.filter((e) => e.kind === "corrupt_record")).toEqual([
      { kind: "corrupt_record", leaseId: "lease-b", unreadable: "corrupt" },
    ]);
    expect(events.filter((e) => e.kind === "torn_down").map((e) => e.leaseId)).toEqual(["lease-a", "lease-c"]);
    expect(await stateOf(h, "lease-a")).toBe("cleaned_up");
    expect(await stateOf(h, "lease-c")).toBe("cleaned_up");
    expect(await stateOf(h, "lease-b")).toBe("expired");
  });

  it("a corrupt first lease does not stop the leases after it", async () => {
    const h = await setup(["lease-a", "lease-b"]);
    h.brokenReceipts.set("lease-a", new FakeCorruptError("receipts"));

    const events = await sweep(h, undefined, { isStoreCorrupt: isFake });

    expect(events.map((e) => `${e.kind}:${"leaseId" in e ? e.leaseId : ""}`)).toEqual(["corrupt_record:lease-a", "torn_down:lease-b"]);
  });

  it("by default recognises a RuntimeError with code store_corrupt", async () => {
    const h = await setup(["lease-a", "lease-b"]);
    h.brokenReceipts.set("lease-a", new RuntimeError("store_corrupt", "The stored publisher binding is invalid."));

    const events = await sweep(h);

    expect(events.map((e) => `${e.kind}:${"leaseId" in e ? e.leaseId : ""}`)).toEqual(["corrupt_record:lease-a", "torn_down:lease-b"]);
  });

  it("deduplicates in-data corruption by the quiet period only", async () => {
    const h = await setup(["lease-a"]);
    h.brokenReceipts.set("lease-a", new FakeCorruptError("receipts"));
    const opts = { isStoreCorrupt: isFake };

    expect(await sweep(h, T0, opts)).toHaveLength(1);
    expect(await sweep(h, T0 + 10, opts)).toEqual([]);
    expect(await sweep(h, T0 + REPEAT - 1, opts)).toEqual([]);
    expect(await sweep(h, T0 + REPEAT, opts)).toHaveLength(1);
  });

  it("reports an ordinary failure as one lease_error and deduplicates it across sweeps", async () => {
    const h = await setup(["lease-a", "lease-b"]);
    h.brokenReceipts.set("lease-a", new Error("disk went away"));

    const first = await sweep(h, T0);
    expect(first.map((e) => `${e.kind}:${"leaseId" in e ? e.leaseId : ""}`)).toEqual(["lease_error:lease-a", "torn_down:lease-b"]);
    expect(await sweep(h, T0 + 10)).toEqual([]);
    expect(await sweep(h, T0 + REPEAT - 1)).toEqual([]);
    expect(await sweep(h, T0 + REPEAT)).toEqual([{ kind: "lease_error", leaseId: "lease-a" }]);
  });

  it("reports again once the fault is fixed and comes back", async () => {
    const h = await setup(["lease-a"]);
    h.brokenReceipts.set("lease-a", new Error("disk went away"));
    expect(await sweep(h, T0)).toHaveLength(1);

    h.brokenReceipts.delete("lease-a");
    expect((await sweep(h, T0 + 10)).map((e) => e.kind)).toEqual(["torn_down"]);

    await h.ports.leases.save(makeTestLease("lease-a", { state: "expired" }));
    h.brokenReceipts.set("lease-a", new Error("disk went away"));
    expect(await sweep(h, T0 + 20)).toEqual([{ kind: "lease_error", leaseId: "lease-a" }]);
  });

  it("a predicate that throws counts as not corrupt", async () => {
    const h = await setup(["lease-a"]);
    h.brokenReceipts.set("lease-a", new FakeCorruptError("receipts"));

    const events = await sweep(h, undefined, {
      isStoreCorrupt: () => {
        throw new Error("predicate bug");
      },
    });

    expect(events).toEqual([{ kind: "lease_error", leaseId: "lease-a" }]);
  });
});
