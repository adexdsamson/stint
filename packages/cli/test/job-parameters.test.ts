/**
 * Plan 10-05 Task 2: the pure job-parameter helpers (SPEC-08).
 * `parseJobParameterValue` is the typed gate every entered answer passes,
 * `orderParameterDeclarations` is the single ordering source, and
 * `bindJobParameters` is the internal binding helper `create` re-runs at
 * activation (the unreachable-by-UI defense).
 */

import { describe, expect, it } from "vitest";

import {
  bindJobParameters,
  orderParameterDeclarations,
  parseJobParameterValue,
} from "../src/run/job-parameters.js";

const STRING = { name: "reference", type: "string", required: true } as const;
const INTEGER = { name: "expected_amount_kobo", type: "integer", required: true } as const;
const CURRENCY = { name: "currency", type: "currency", required: true } as const;

describe("parseJobParameterValue", () => {
  it("string: accepts 1 to 128 characters; rejects empty and 129", () => {
    expect(parseJobParameterValue(STRING, "ref_1001")).toEqual({ ok: true, value: "ref_1001" });
    expect(parseJobParameterValue(STRING, "a")).toEqual({ ok: true, value: "a" });
    expect(parseJobParameterValue(STRING, "a".repeat(128))).toEqual({
      ok: true,
      value: "a".repeat(128),
    });
    expect(parseJobParameterValue(STRING, "")).toEqual({ ok: false, reason: "invalid_value" });
    expect(parseJobParameterValue(STRING, "a".repeat(129))).toEqual({
      ok: false,
      reason: "invalid_value",
    });
  });

  it("integer: accepts whole kobo of at least 1 as a JSON number; rejects abc, 30.5, -1, 0 and beyond safe integers", () => {
    expect(parseJobParameterValue(INTEGER, "30050")).toEqual({ ok: true, value: 30050 });
    expect(parseJobParameterValue(INTEGER, "1")).toEqual({ ok: true, value: 1 });
    for (const bad of ["abc", "30.5", "-1", "0", "1e3", " 30050", "30050 ", "٣٠٠٥٠", "9".repeat(400)]) {
      expect(parseJobParameterValue(INTEGER, bad), bad).toEqual({
        ok: false,
        reason: "invalid_value",
      });
    }
  });

  it("currency: accepts exactly three uppercase letters; rejects ngn, NG, NGNNGN and digits", () => {
    expect(parseJobParameterValue(CURRENCY, "NGN")).toEqual({ ok: true, value: "NGN" });
    expect(parseJobParameterValue(CURRENCY, "USD")).toEqual({ ok: true, value: "USD" });
    for (const bad of ["ngn", "Ngn", "NG", "NGNN", "NGNNGN", "N1N", "NG "]) {
      expect(parseJobParameterValue(CURRENCY, bad), bad).toEqual({
        ok: false,
        reason: "invalid_value",
      });
    }
  });

  it("never echoes the input in a failure result", () => {
    const bad = parseJobParameterValue(INTEGER, "30.5");
    expect(bad).toEqual({ ok: false, reason: "invalid_value" });
    expect(JSON.stringify(bad)).not.toContain("30.5");
  });

  it("rejects an unknown type fail-closed (defensive; the schema closes the set)", () => {
    expect(
      parseJobParameterValue({ name: "x", type: "float", required: true }, "1.5"),
    ).toEqual({ ok: false, reason: "invalid_value" });
  });
});

describe("orderParameterDeclarations", () => {
  it("returns manifest order, defaults required to true, keeps description and drops the generator index signature", () => {
    const declarations = orderParameterDeclarations([
      { name: "reference", type: "string", description: "The Paystack reference." },
      { name: "expected_amount_kobo", type: "integer" },
      { name: "currency", type: "currency", required: false },
    ]);
    expect(declarations).toEqual([
      { name: "reference", type: "string", description: "The Paystack reference.", required: true },
      { name: "expected_amount_kobo", type: "integer", required: true },
      { name: "currency", type: "currency", required: false },
    ]);
    expect(Object.keys(declarations[0] ?? {})).toEqual(["name", "type", "description", "required"]);
  });

  it("returns an empty list when the manifest declares no parameters", () => {
    expect(orderParameterDeclarations(undefined)).toEqual([]);
  });
});

describe("bindJobParameters (the internal binding helper)", () => {
  const vectorDeclarations = orderParameterDeclarations([
    { name: "reference", type: "string" },
    { name: "expected_amount_kobo", type: "integer" },
    { name: "currency", type: "currency" },
  ]);

  it("binds the three vector values in declaration order, kobo as a number", () => {
    const bound = bindJobParameters(vectorDeclarations, {
      currency: "NGN",
      reference: "ref_1001",
      expected_amount_kobo: 30050,
    });
    expect(bound).toEqual({ reference: "ref_1001", expected_amount_kobo: 30050, currency: "NGN" });
    expect(Object.keys(bound ?? {})).toEqual([
      "reference",
      "expected_amount_kobo",
      "currency",
    ]);
    expect(typeof (bound ?? {}).expected_amount_kobo).toBe("number");
  });

  it("omits skipped optionals and binds answered ones", () => {
    const declarations = orderParameterDeclarations([
      { name: "reference", type: "string" },
      { name: "note", type: "string", required: false },
    ]);
    expect(bindJobParameters(declarations, { reference: "ref_1" })).toEqual({ reference: "ref_1" });
    expect(bindJobParameters(declarations, { reference: "ref_1", note: "n" })).toEqual({
      reference: "ref_1",
      note: "n",
    });
    expect(bindJobParameters(orderParameterDeclarations([{ name: "note", type: "string", required: false }]), {})).toEqual(
      {},
    );
  });

  it.each([
    ["a missing required value", { reference: "ref_1", expected_amount_kobo: 30050 }],
    ["an unknown name", { reference: "ref_1", expected_amount_kobo: 30050, currency: "NGN", extra: "x" }],
    ["a float kobo", { reference: "ref_1", expected_amount_kobo: 30.5, currency: "NGN" }],
    ["a zero kobo", { reference: "ref_1", expected_amount_kobo: 0, currency: "NGN" }],
    ["an integer given as a string", { reference: "ref_1", expected_amount_kobo: "30050", currency: "NGN" }],
    ["a bad currency", { reference: "ref_1", expected_amount_kobo: 30050, currency: "ngn" }],
    ["a currency given as a number", { reference: "ref_1", expected_amount_kobo: 30050, currency: 30050 }],
    ["an empty required string", { reference: "", expected_amount_kobo: 30050, currency: "NGN" }],
  ])("a value failing re-validation (%s) returns undefined so create writes nothing", (_name, values) => {
    expect(bindJobParameters(vectorDeclarations, values)).toBeUndefined();
  });
});
