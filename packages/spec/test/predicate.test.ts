import { describe, expect, it } from "vitest";

import { evaluatePredicate, parsePredicate } from "../src/index.js";
import type { PredicateAst, PredicateRow } from "../src/index.js";

describe("parsePredicate", () => {
  it("parses the spec's own conformance example verbatim", () => {
    const result = parsePredicate("count(rows where status = 'reconciled') >= 1");
    expect(result.ok).toBe(true);
    if (result.ok) {
      const expected: PredicateAst = {
        aggregate: "count",
        filter: { field: "status", op: "=", literal: "reconciled" },
        compareOp: ">=",
        compareLiteral: 1,
      };
      expect(result.value).toEqual(expected);
    }
  });

  it("parses a sum predicate with an aggregate field and no filter", () => {
    const result = parsePredicate("sum(rows.amount) >= 100");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        aggregate: "sum",
        aggregateField: "amount",
        compareOp: ">=",
        compareLiteral: 100,
      });
    }
  });

  it("parses a sum predicate with an aggregate field and a filter", () => {
    const result = parsePredicate("sum(rows.amount where currency = 'usd') > 0");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        aggregate: "sum",
        aggregateField: "amount",
        filter: { field: "currency", op: "=", literal: "usd" },
        compareOp: ">",
        compareLiteral: 0,
      });
    }
  });

  it("parses an exists predicate as a numeric truthiness compare", () => {
    const result = parsePredicate("exists(rows where status = 'failed') >= 1");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.aggregate).toBe("exists");
      expect(result.value.compareLiteral).toBe(1);
      expect(typeof result.value.compareLiteral).toBe("number");
    }
  });

  it("rejects a boolean-combinator predicate (no AND/OR)", () => {
    const result = parsePredicate("count(rows where status = 'reconciled') >= 1 AND count(rows) < 5");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.code).toBe("invalid_predicate");
    }
  });

  it("rejects nested/boolean OR combinators", () => {
    const result = parsePredicate("count(rows) >= 1 OR exists(rows) >= 1");
    expect(result.ok).toBe(false);
  });

  it("rejects unbalanced parentheses", () => {
    const result = parsePredicate("count(rows where status = 'reconciled' >= 1");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.code).toBe("invalid_predicate");
    }
  });

  it("rejects an unknown aggregate", () => {
    const result = parsePredicate("max(rows.amount) >= 1");
    expect(result.ok).toBe(false);
  });

  it("rejects a missing compare operator", () => {
    const result = parsePredicate("count(rows where status = 'reconciled')");
    expect(result.ok).toBe(false);
  });

  it("rejects sum without an aggregate field", () => {
    const result = parsePredicate("sum(rows) >= 1");
    expect(result.ok).toBe(false);
  });

  it("rejects count with an aggregate field", () => {
    const result = parsePredicate("count(rows.amount) >= 1");
    expect(result.ok).toBe(false);
  });

  it("never throws on malformed input", () => {
    const inputs = ["", "()", "count(", "count(rows) >=", "'; DROP TABLE rows; --", "eval(1)"];
    for (const input of inputs) {
      expect(() => parsePredicate(input)).not.toThrow();
      expect(parsePredicate(input).ok).toBe(false);
    }
  });
});

describe("evaluatePredicate", () => {
  const rows: readonly PredicateRow[] = [
    { status: "reconciled", amount: 100 },
    { status: "pending", amount: 50 },
    { status: "reconciled", amount: 25 },
  ];

  it("evaluates true when a reconciled row is present (spec example)", () => {
    const parsed = parsePredicate("count(rows where status = 'reconciled') >= 1");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(evaluatePredicate(parsed.value, rows)).toBe(true);
    }
  });

  it("evaluates false when no row matches the filter", () => {
    const parsed = parsePredicate("count(rows where status = 'reconciled') >= 1");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(evaluatePredicate(parsed.value, [{ status: "pending", amount: 50 }])).toBe(false);
    }
  });

  it("evaluates sum correctly", () => {
    const parsed = parsePredicate("sum(rows.amount where status = 'reconciled') >= 100");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(evaluatePredicate(parsed.value, rows)).toBe(true);
      expect(evaluatePredicate(parsed.value, [{ status: "reconciled", amount: 10 }])).toBe(false);
    }
  });

  it("evaluates exists correctly", () => {
    const parsed = parsePredicate("exists(rows where status = 'failed') >= 1");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(evaluatePredicate(parsed.value, rows)).toBe(false);
      expect(evaluatePredicate(parsed.value, [...rows, { status: "failed", amount: 1 }])).toBe(true);
    }
  });

  it("evaluates count with no filter over all rows", () => {
    const parsed = parsePredicate("count(rows) >= 3");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(evaluatePredicate(parsed.value, rows)).toBe(true);
      expect(evaluatePredicate(parsed.value, rows.slice(0, 1))).toBe(false);
    }
  });

  it("never throws and never matches on a type-mismatched filter value", () => {
    const parsed = parsePredicate("count(rows where amount = 'not-a-number') >= 1");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(() => evaluatePredicate(parsed.value, rows)).not.toThrow();
      expect(evaluatePredicate(parsed.value, rows)).toBe(false);
    }
  });
});
