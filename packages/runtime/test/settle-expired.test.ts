import { createInMemoryLeaseStore, createInMemoryReceiptStore, makeTestLease } from "@stint/core/testing";
import type { ReceiptStore, TelemetryEvent } from "@stint/core";
import { describe, expect, it } from "vitest";

import { RuntimeError, settleExpired } from "../src/index.js";

const LEASE_ID = "lease-settle-1";
const EXPIRES_AT = 5000;

function setup(overrides?: Parameters<typeof makeTestLease>[1]) {
  const leases = createInMemoryLeaseStore();
  const receiptStores = new Map<string, ReceiptStore>();
  const receipts = (id: string): ReceiptStore => {
    let store = receiptStores.get(id);
    if (store === undefined) {
      store = createInMemoryReceiptStore();
      receiptStores.set(id, store);
    }
    return store;
  };
  const events: TelemetryEvent[] = [];
  return {
    leases,
    receipts,
    events,
    telemetry: { emit: (e: TelemetryEvent) => void events.push(e) },
    seed: () => leases.save(makeTestLease(LEASE_ID, { expiresAt: EXPIRES_AT, ...overrides })),
  };
}

describe("settleExpired", () => {
  it("settles the lease when the clock equals expiresAt exactly", async () => {
    const s = setup();
    await s.seed();
    const result = await settleExpired(
      { leases: s.leases, receipts: s.receipts, clock: () => EXPIRES_AT, telemetry: s.telemetry },
      LEASE_ID,
    );
    expect(result.settled).toBe(true);
    expect(result.lease.state).toBe("expired");
    expect((await s.leases.load(LEASE_ID))?.state).toBe("expired");
    const chain = await s.receipts(LEASE_ID).load("verified");
    expect(chain.map((e) => e.payload)).toEqual([
      { from: "active", event: "expire", actor: "clock", to: "expired" },
    ]);
  });

  it("does not settle one second before expiresAt", async () => {
    const s = setup();
    await s.seed();
    const result = await settleExpired(
      { leases: s.leases, receipts: s.receipts, clock: () => EXPIRES_AT - 1 },
      LEASE_ID,
    );
    expect(result.settled).toBe(false);
    expect(result.lease.state).toBe("active");
    expect(await s.receipts(LEASE_ID).load("verified")).toHaveLength(0);
  });

  it("rejects a missing lease with lease_not_found and appends no receipt", async () => {
    const s = setup();
    const err = await settleExpired(
      { leases: s.leases, receipts: s.receipts, clock: () => EXPIRES_AT },
      "no-such-lease",
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RuntimeError);
    expect((err as RuntimeError).code).toBe("lease_not_found");
    expect((err as RuntimeError).safeMessage).toBe("Lease not found.");
    expect(await s.receipts("no-such-lease").load("verified")).toHaveLength(0);
  });

  it("a second call is a no-op reporting settled: false", async () => {
    const s = setup();
    await s.seed();
    const ports = { leases: s.leases, receipts: s.receipts, clock: () => EXPIRES_AT + 10 };
    expect((await settleExpired(ports, LEASE_ID)).settled).toBe(true);
    const again = await settleExpired(ports, LEASE_ID);
    expect(again.settled).toBe(false);
    expect(again.lease.state).toBe("expired");
    expect(await s.receipts(LEASE_ID).load("verified")).toHaveLength(1);
  });

  it("a throwing telemetry sink does not change the result", async () => {
    const s = setup();
    await s.seed();
    const result = await settleExpired(
      {
        leases: s.leases,
        receipts: s.receipts,
        clock: () => EXPIRES_AT,
        telemetry: {
          emit: () => {
            throw new Error("sink exploded");
          },
        },
      },
      LEASE_ID,
    );
    expect(result.settled).toBe(true);
    expect(result.lease.state).toBe("expired");
  });

  it("emits exactly one lease.transition from active to expired by clock", async () => {
    const s = setup();
    await s.seed();
    await settleExpired(
      { leases: s.leases, receipts: s.receipts, clock: () => EXPIRES_AT, telemetry: s.telemetry },
      LEASE_ID,
    );
    expect(s.events).toEqual([
      { name: "lease.transition", leaseId: LEASE_ID, from: "active", to: "expired", actor: "clock" },
    ]);
  });
});
