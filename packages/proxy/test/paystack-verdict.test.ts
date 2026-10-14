/**
 * 10-04 Task 1 (PSTK-02, PSTK-03, D-C): the Paystack transaction verdict is pure
 * code over a documented envelope. Every trap the research found (R2 the
 * envelope's own status, R3 the closed status list, R4 the fees-inclusive
 * amount) is a zero-I/O table case here, and anything unexpected fails closed
 * to `unknown`.
 */

import { describe, expect, it } from "vitest";

import {
  ALLOWLISTED_TRANSACTION_FIELDS,
  PAYSTACK_TRANSACTION_STATUSES,
  allowlistTransactionData,
  computeTransactionVerdict,
  transactionExpectationFromParameters,
} from "../src/connectors/paystack-verify.js";
import type { TransactionExpectation } from "../src/connectors/paystack-verify.js";
import { verdictRowAdapter } from "../src/connectors/verdict-rows.js";

const EXPECTED: TransactionExpectation = { reference: "ref_1001", expectedAmountKobo: 30050, currency: "NGN" };

function envelope(data: Record<string, unknown>, status: boolean = true): Record<string, unknown> {
  return { status, message: "Verification successful", data };
}

function data(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "success",
    reference: "ref_1001",
    amount: 30050,
    requested_amount: 30050,
    currency: "NGN",
    ...overrides,
  };
}

describe("computeTransactionVerdict: the closed R3 status list", () => {
  it("covers exactly the eight documented statuses", () => {
    expect([...PAYSTACK_TRANSACTION_STATUSES].sort()).toEqual(
      ["abandoned", "failed", "ongoing", "pending", "processing", "queued", "reversed", "success"].sort(),
    );
  });

  for (const status of [
    "abandoned",
    "failed",
    "ongoing",
    "pending",
    "processing",
    "queued",
    "reversed",
    "success",
  ]) {
    it(`status ${status} with matching amount and currency`, () => {
      const verdict = computeTransactionVerdict(envelope(data({ status })), EXPECTED);
      expect(verdict).toBe(status === "success" ? "confirmed" : "not_success");
    });
  }

  it("the table above iterates every member of the exported constant (a new status cannot skip a case)", () => {
    for (const status of PAYSTACK_TRANSACTION_STATUSES) {
      const verdict = computeTransactionVerdict(envelope(data({ status })), EXPECTED);
      expect(verdict).toBe(status === "success" ? "confirmed" : "not_success");
    }
  });
});

describe("computeTransactionVerdict: the traps", () => {
  it("fees trap (R4): data.amount equals the expected kobo but requested_amount differs -> amount_mismatch", () => {
    const body = envelope(data({ amount: 30050, requested_amount: 20000 }));
    expect(computeTransactionVerdict(body, EXPECTED)).toBe("amount_mismatch");
  });

  it("fees trap (R4): the documented sample, requested 30050 / amount 40333 / fees 10283 -> confirmed", () => {
    const body = envelope(data({ amount: 40333, requested_amount: 30050, fees: 10283 }));
    expect(computeTransactionVerdict(body, EXPECTED)).toBe("confirmed");
  });

  it("envelope trap (R2): response.status true with data.status failed -> not_success, never confirmed", () => {
    expect(computeTransactionVerdict(envelope(data({ status: "failed" }), true), EXPECTED)).toBe("not_success");
  });

  it("envelope trap (R2): response.status false with no data -> unknown", () => {
    expect(computeTransactionVerdict({ status: false, message: "Transaction reference not found" }, EXPECTED)).toBe(
      "unknown",
    );
  });

  it("envelope trap (R2): response.status false even with a success-looking data -> unknown", () => {
    expect(computeTransactionVerdict(envelope(data(), false), EXPECTED)).toBe("unknown");
  });

  it("currency trap: matching amounts, currency USD against NGN -> currency_mismatch", () => {
    expect(computeTransactionVerdict(envelope(data({ currency: "USD" })), EXPECTED)).toBe("currency_mismatch");
  });

  it("an amount difference wins over a currency difference (amount is checked first)", () => {
    expect(computeTransactionVerdict(envelope(data({ requested_amount: 1, currency: "USD" })), EXPECTED)).toBe(
      "amount_mismatch",
    );
  });

  it("a non-success status is not_success even when amount and currency differ", () => {
    expect(computeTransactionVerdict(envelope(data({ status: "failed", requested_amount: 1 })), EXPECTED)).toBe(
      "not_success",
    );
  });
});

describe("computeTransactionVerdict: fail closed to unknown", () => {
  const cases: ReadonlyArray<readonly [string, unknown]> = [
    ["data.status in the wrong case (SUCCESS)", envelope(data({ status: "SUCCESS" }))],
    ["an undocumented data.status (settled)", envelope(data({ status: "settled" }))],
    ["data.status missing", envelope((({ status: _s, ...rest }) => rest)(data()))],
    ["data.status not a string", envelope(data({ status: true }))],
    ["data absent", { status: true, message: "ok" }],
    ["data an array", { status: true, message: "ok", data: [data()] }],
    ["data null", { status: true, message: "ok", data: null }],
    ["data a string", { status: true, message: "ok", data: "success" }],
    ["requested_amount a float", envelope(data({ requested_amount: 30050.5 }))],
    ["requested_amount a string", envelope(data({ requested_amount: "30050" }))],
    ["requested_amount absent", envelope((({ requested_amount: _r, ...rest }) => rest)(data()))],
    ["requested_amount beyond the safe integer range", envelope(data({ requested_amount: 2 ** 60 }))],
    ["currency absent", envelope((({ currency: _c, ...rest }) => rest)(data()))],
    ["currency not a string", envelope(data({ currency: 566 }))],
    ["envelope status not a boolean", { status: "true", message: "ok", data: data() }],
    ["the body a string", "success"],
    ["the body null", null],
    ["the body undefined", undefined],
    ["the body an array", [data()]],
    ["the body a number", 200],
    ["a reference that does not match the expectation", envelope(data({ reference: "someone_elses" }))],
  ];
  for (const [name, body] of cases) {
    it(`${name} -> unknown`, () => {
      expect(computeTransactionVerdict(body, EXPECTED)).toBe("unknown");
    });
  }

  it("an absent reference in data is tolerated (the lookup was by reference)", () => {
    const { reference: _ref, ...rest } = data();
    expect(computeTransactionVerdict(envelope(rest), EXPECTED)).toBe("confirmed");
  });

  it("never reads the fees-inclusive amount: amount absent, requested_amount matching -> confirmed", () => {
    const { amount: _amount, ...rest } = data();
    expect(computeTransactionVerdict(envelope(rest), EXPECTED)).toBe("confirmed");
  });
});

describe("allowlistTransactionData (R5)", () => {
  const FULL = {
    status: "success",
    amount: 40333,
    requested_amount: 30050,
    currency: "NGN",
    reference: "ref_1001",
    paid_at: "2026-10-01T10:00:00.000Z",
    created_at: "2026-10-01T09:58:00.000Z",
    channel: "card",
    domain: "test",
    fees: 10283,
  };

  it("names exactly the ten R5 fields", () => {
    expect([...ALLOWLISTED_TRANSACTION_FIELDS].sort()).toEqual(Object.keys(FULL).sort());
  });

  it("returns exactly the R5 keys and values from a fixture that also carries PII and ids", () => {
    const fixture = {
      ...FULL,
      id: 4099260516,
      ip_address: "203.0.113.9",
      authorization: { authorization_code: "AUTH_8dfhjjdt", last4: "4081", bin: "408408" },
      customer: { id: 1, email: "buyer@example.com", customer_code: "CUS_xnxdt6s1zg1f4nx" },
      log: { history: [{ type: "action", message: "Attempted to pay" }] },
      metadata: { note: "x" },
    };
    const result = allowlistTransactionData(fixture);
    expect(Object.keys(result).sort()).toEqual(Object.keys(FULL).sort());
    expect(result).toEqual(FULL);
    const serialized = JSON.stringify(result);
    for (const leaked of ["AUTH_8dfhjjdt", "4081", "buyer@example.com", "CUS_xnxdt6s1zg1f4nx", "203.0.113.9", "4099260516"]) {
      expect(serialized).not.toContain(leaked);
    }
  });

  it("projects only the allowlisted keys that are present", () => {
    expect(allowlistTransactionData({ status: "success", id: 7 })).toEqual({ status: "success" });
  });

  it("drops a non-primitive value under an allowlisted key (no nested object can ride through)", () => {
    expect(allowlistTransactionData({ status: "success", domain: { email: "a@b.c" }, channel: ["card"] })).toEqual({
      status: "success",
    });
  });

  it("anything malformed yields {}", () => {
    for (const bad of [undefined, null, "x", 5, true, ["success"]]) {
      expect(allowlistTransactionData(bad)).toEqual({});
    }
  });

  it("does not pick up an inherited property", () => {
    const inherited = Object.create({ status: "success" }) as unknown;
    expect(allowlistTransactionData(inherited)).toEqual({});
  });
});

describe("transactionExpectationFromParameters (the three closed names)", () => {
  it("accepts a well-formed parameter record", () => {
    expect(
      transactionExpectationFromParameters({ reference: "ref_1001", expected_amount_kobo: 30050, currency: "NGN" }),
    ).toEqual(EXPECTED);
  });

  it("ignores extra parameter names (only the three closed names are read)", () => {
    expect(
      transactionExpectationFromParameters({
        reference: "ref_1001",
        expected_amount_kobo: 30050,
        currency: "NGN",
        callback_url: "https://evil.example",
      }),
    ).toEqual(EXPECTED);
  });

  const bad: ReadonlyArray<readonly [string, unknown]> = [
    ["a reference with a slash", { reference: "a/b", expected_amount_kobo: 30050, currency: "NGN" }],
    ["a reference with a space", { reference: "a b", expected_amount_kobo: 30050, currency: "NGN" }],
    ["a reference with a dot-dot slash", { reference: "../evil", expected_amount_kobo: 30050, currency: "NGN" }],
    ["an empty reference", { reference: "", expected_amount_kobo: 30050, currency: "NGN" }],
    ["a 129 character reference", { reference: "a".repeat(129), expected_amount_kobo: 30050, currency: "NGN" }],
    ["a numeric reference", { reference: 1001, expected_amount_kobo: 30050, currency: "NGN" }],
    ["a kobo of 0", { reference: "r", expected_amount_kobo: 0, currency: "NGN" }],
    ["a negative kobo", { reference: "r", expected_amount_kobo: -5, currency: "NGN" }],
    ["a float kobo", { reference: "r", expected_amount_kobo: 1.5, currency: "NGN" }],
    ["a string kobo", { reference: "r", expected_amount_kobo: "30050", currency: "NGN" }],
    ["an unsafe-integer kobo", { reference: "r", expected_amount_kobo: 2 ** 60, currency: "NGN" }],
    ["a lowercase currency", { reference: "r", expected_amount_kobo: 1, currency: "ngn" }],
    ["a two letter currency", { reference: "r", expected_amount_kobo: 1, currency: "NG" }],
    ["a missing reference", { expected_amount_kobo: 1, currency: "NGN" }],
    ["a missing amount", { reference: "r", currency: "NGN" }],
    ["a missing currency", { reference: "r", expected_amount_kobo: 1 }],
    ["undefined", undefined],
    ["null", null],
    ["an array", ["r", 1, "NGN"]],
    ["a string", "r"],
  ];
  for (const [name, parameters] of bad) {
    it(`rejects ${name}`, () => {
      expect(transactionExpectationFromParameters(parameters)).toBeUndefined();
    });
  }
});

describe("verdictRowAdapter (the named built-in)", () => {
  it("projects body.rows to { verdict, ...allowlisted } and nothing else", () => {
    const { rows } = verdictRowAdapter({
      status: 200,
      body: {
        rows: [
          {
            verdict: "confirmed",
            status: "success",
            requested_amount: 30050,
            currency: "NGN",
            authorization: { authorization_code: "AUTH_x" },
            id: 9,
          },
        ],
      },
    });
    expect(rows).toEqual([{ verdict: "confirmed", status: "success", requested_amount: 30050, currency: "NGN" }]);
  });

  it("a verdict outside the closed list is coerced to unknown", () => {
    const { rows } = verdictRowAdapter({ status: 200, body: { rows: [{ verdict: "settled" }, { verdict: 1 }] } });
    expect(rows).toEqual([{ verdict: "unknown" }, { verdict: "unknown" }]);
  });

  it("a malformed body yields no rows, so it can never satisfy the predicate", () => {
    for (const body of [undefined, null, "x", 5, [], {}, { rows: "confirmed" }, { rows: null }, { rows: {} }]) {
      expect(verdictRowAdapter({ status: 200, body })).toEqual({ rows: [] });
    }
  });

  it("skips non-record row entries", () => {
    const { rows } = verdictRowAdapter({ status: 200, body: { rows: [null, "confirmed", 3, ["confirmed"], { verdict: "confirmed" }] } });
    expect(rows).toEqual([{ verdict: "confirmed" }]);
  });
});
