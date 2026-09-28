/**
 * `caps-concurrency.test.ts` -- unit tests for the real `CapEnforcer`
 * (`createCapEnforcer`, PRXY-04, D-05, D-06) and `extractSpendMinor` (D-07)
 * (Task 1), plus the cap-boundary and concurrency integration proofs
 * driving the 04-02 server over `InMemoryTransport` (Task 3).
 */

import { describe, expect, it } from "vitest";

import type { Lease, PolicyCall } from "@stint/core";
import type { Limits } from "@stint/spec";

import { createCapEnforcer } from "../src/caps/cap-enforcer.js";
import { extractSpendMinor } from "../src/catalog.js";
import type { ToolCatalogEntry } from "../src/catalog.js";

const NOW = 1_700_000_000;
const HOUR = 3600;

function makeLease(overrides?: Partial<Lease>): Lease {
  return {
    id: "lease-unit",
    state: "active",
    version: 0,
    boundHash: "jcs-sha256:test",
    grantedAt: NOW - 100,
    expiresAt: NOW + HOUR,
    maxDurationSeconds: HOUR,
    counters: { actionCount: 0, spentMinor: 0, denialErrorTimestamps: [], actionTimestamps: [] },
    ...overrides,
  };
}

const READ_CALL: PolicyCall = { tool: "read_message" };

describe("createCapEnforcer: authorize (sliding-window actions_per_hour)", () => {
  it("denies over_actions_per_hour once the strict-window count reaches the limit", () => {
    const enforcer = createCapEnforcer();
    const limits: Limits = { max_actions: 100, actions_per_hour: 3 };
    const lease = makeLease({
      counters: {
        actionCount: 3,
        spentMinor: 0,
        denialErrorTimestamps: [],
        actionTimestamps: [NOW - 10, NOW - 20, NOW - 30],
      },
    });

    expect(enforcer.authorize(lease, READ_CALL, limits, NOW)).toEqual({
      ok: false,
      reason: "over_actions_per_hour",
    });
  });

  it("allows when the strict-window count is below the limit", () => {
    const enforcer = createCapEnforcer();
    const limits: Limits = { max_actions: 100, actions_per_hour: 3 };
    const lease = makeLease({
      counters: {
        actionCount: 2,
        spentMinor: 0,
        denialErrorTimestamps: [],
        actionTimestamps: [NOW - 10, NOW - 20],
      },
    });

    expect(enforcer.authorize(lease, READ_CALL, limits, NOW)).toEqual({ ok: true });
  });

  it("excludes a timestamp exactly now-3600 (strict `>`, outside the window)", () => {
    const enforcer = createCapEnforcer();
    const limits: Limits = { max_actions: 100, actions_per_hour: 1 };
    const lease = makeLease({
      counters: {
        actionCount: 1,
        spentMinor: 0,
        denialErrorTimestamps: [],
        actionTimestamps: [NOW - HOUR],
      },
    });

    expect(enforcer.authorize(lease, READ_CALL, limits, NOW)).toEqual({ ok: true });
  });

  it("never denies when limits.actions_per_hour is undefined", () => {
    const enforcer = createCapEnforcer();
    const limits: Limits = { max_actions: 100 };
    const lease = makeLease({
      counters: {
        actionCount: 50,
        spentMinor: 0,
        denialErrorTimestamps: [],
        actionTimestamps: Array.from({ length: 50 }, () => NOW),
      },
    });

    expect(enforcer.authorize(lease, READ_CALL, limits, NOW)).toEqual({ ok: true });
  });
});

describe("createCapEnforcer: commit", () => {
  it("increments actionCount, appends now to a window-pruned actionTimestamps, and adds spendMinor to spentMinor, without mutating the input lease", () => {
    const enforcer = createCapEnforcer();
    const lease = makeLease({
      counters: {
        actionCount: 5,
        spentMinor: 100,
        denialErrorTimestamps: [],
        actionTimestamps: [NOW - HOUR, NOW - 10],
      },
    });
    const call: PolicyCall = { tool: "pay_invoice", spendMinor: 50 };

    const next = enforcer.commit(lease, call, NOW);

    expect(next).not.toBe(lease);
    expect(next.counters.actionCount).toBe(6);
    expect(next.counters.actionTimestamps).toEqual([NOW - 10, NOW]);
    expect(next.counters.spentMinor).toBe(150);
    // input unchanged
    expect(lease.counters.actionCount).toBe(5);
    expect(lease.counters.actionTimestamps).toEqual([NOW - HOUR, NOW - 10]);
    expect(lease.counters.spentMinor).toBe(100);
  });

  it("adds 0 to spentMinor when the call declares no spendMinor", () => {
    const enforcer = createCapEnforcer();
    const lease = makeLease({
      counters: { actionCount: 0, spentMinor: 0, denialErrorTimestamps: [], actionTimestamps: [NOW - HOUR] },
    });

    const next = enforcer.commit(lease, READ_CALL, NOW);

    expect(next.counters.spentMinor).toBe(0);
    expect(next.counters.actionCount).toBe(1);
    // the now-3600 entry is pruned away, leaving only the freshly-appended `now`.
    expect(next.counters.actionTimestamps).toEqual([NOW]);
  });
});

describe("extractSpendMinor", () => {
  const payEntry: ToolCatalogEntry = {
    name: "pay_invoice",
    description: "Pays an invoice",
    inputSchema: { type: "object", properties: { amount: { type: "number" } }, required: ["amount"] },
    payAmount: { amountArgPath: "amount", currency: "USD" },
  };

  const readEntry: ToolCatalogEntry = {
    name: "read_message",
    description: "Reads a message",
    inputSchema: { type: "object", properties: {}, required: [] },
  };

  it("returns the integer minor amount at the declared arg path for a pay entry", () => {
    expect(extractSpendMinor(payEntry, { amount: 500 })).toBe(500);
  });

  it("returns undefined for an entry with no payAmount descriptor", () => {
    expect(extractSpendMinor(readEntry, { amount: 500 })).toBeUndefined();
  });

  it("returns undefined when the declared arg path is absent", () => {
    expect(extractSpendMinor(payEntry, {})).toBeUndefined();
  });

  it("returns undefined when the value at the arg path is not a non-negative integer", () => {
    expect(extractSpendMinor(payEntry, { amount: -5 })).toBeUndefined();
    expect(extractSpendMinor(payEntry, { amount: 1.5 })).toBeUndefined();
    expect(extractSpendMinor(payEntry, { amount: "500" })).toBeUndefined();
  });

  it("a __proto__ arg path never reaches Object.prototype", () => {
    const protoEntry: ToolCatalogEntry = {
      ...payEntry,
      payAmount: { amountArgPath: "__proto__", currency: "USD" },
    };

    expect(extractSpendMinor(protoEntry, {})).toBeUndefined();
  });
});
