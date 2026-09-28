import { Ajv } from "ajv";
import { describe, expect, expectTypeOf, it } from "vitest";

import type {
  Access,
  AuthMode,
  Manifest,
  ResourceQueryVerifier,
  Scope,
  Verifier,
} from "../src/generated/manifest.js";
import type { TeardownStepPayload } from "../src/generated/receipt.js";
import { receiptSchema } from "../src/generated/schemas.js";

// Verifier narrows on `type` — this only compiles if the discriminated union
// (D-18) actually narrows per-branch, since `.predicate`/`.prompt` are not
// present on every branch.
function describeVerifier(verifier: Verifier): string {
  if (verifier.type === "resource_query") {
    return verifier.predicate;
  }
  if (verifier.type === "user_confirm") {
    return verifier.prompt;
  }
  return "none";
}

// @ts-expect-error - "delete" is not a member of the Access union.
const scopeWithInvalidAccess: Scope = { resource: "r", access: ["delete"] };

// @ts-expect-error - ResourceQueryVerifier requires `predicate`.
const verifierMissingPredicate: ResourceQueryVerifier = { type: "resource_query", resource: "r" };

describe("generated types", () => {
  it("Access is exactly the four-member union", () => {
    expectTypeOf<Access>().toEqualTypeOf<"read" | "write" | "send" | "pay">();
  });

  it("AuthMode is exactly delegated, hosted or hybrid", () => {
    expectTypeOf<AuthMode>().toEqualTypeOf<"delegated" | "hosted" | "hybrid">();
  });

  it("Manifest['cleanup'] accepts null", () => {
    const cleanup: Manifest["cleanup"] = null;
    expect(cleanup).toBeNull();
  });

  it("Verifier narrows on type", () => {
    expect(describeVerifier({ type: "none" })).toBe("none");
    expect(
      describeVerifier({ type: "resource_query", resource: "r", predicate: "p" }),
    ).toBe("p");
    expect(describeVerifier({ type: "user_confirm", prompt: "confirm?" })).toBe("confirm?");
  });

  it("invalid Scope/ResourceQueryVerifier shapes are rejected at compile time", () => {
    // Referenced only so the @ts-expect-error assignments above count as used.
    expect(scopeWithInvalidAccess.resource).toBe("r");
    expect(verifierMissingPredicate.type).toBe("resource_query");
  });
});

describe("TeardownStepPayload.outcome widened enum (D-24)", () => {
  // Type-level: this only compiles once `ok`/`not_applicable`/`attested_ok`
  // are members of the generated `TeardownStepPayload.outcome` union.
  const okPayload: TeardownStepPayload = { step: "cleanup_hook", outcome: "ok" };
  const notApplicablePayload: TeardownStepPayload = { step: "delete_cached_data", outcome: "not_applicable" };
  const attestedOkPayload: TeardownStepPayload = { step: "cleanup_hook", outcome: "attested_ok" };

  const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true });
  const validateReceiptEntry = ajv.compile(receiptSchema);

  function teardownStepEntry(payload: TeardownStepPayload): unknown {
    return {
      seq: 0,
      ts: 1000,
      chain: "verified",
      type: "teardown_step",
      prevHash: `jcs-sha256:${"0".repeat(64)}`,
      payload,
    };
  }

  it("ok/not_applicable/attested_ok type-check as TeardownStepPayload.outcome", () => {
    expect(okPayload.outcome).toBe("ok");
    expect(notApplicablePayload.outcome).toBe("not_applicable");
    expect(attestedOkPayload.outcome).toBe("attested_ok");
  });

  it("ok/not_applicable/attested_ok validate against spec/receipt.schema.json", () => {
    expect(validateReceiptEntry(teardownStepEntry(okPayload)), JSON.stringify(validateReceiptEntry.errors)).toBe(true);
    expect(
      validateReceiptEntry(teardownStepEntry(notApplicablePayload)),
      JSON.stringify(validateReceiptEntry.errors),
    ).toBe(true);
    expect(
      validateReceiptEntry(teardownStepEntry(attestedOkPayload)),
      JSON.stringify(validateReceiptEntry.errors),
    ).toBe(true);
  });

  it("still validates the pre-existing revoked outcome (additive-safe)", () => {
    const revokedPayload: TeardownStepPayload = { step: "revoke_oauth", outcome: "revoked" };
    expect(validateReceiptEntry(teardownStepEntry(revokedPayload))).toBe(true);
  });
});
