import { describe, expect, expectTypeOf, it } from "vitest";

import type {
  Access,
  AuthMode,
  Manifest,
  ResourceQueryVerifier,
  Scope,
  Verifier,
} from "../src/generated/manifest.js";

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
