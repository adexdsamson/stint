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
import type {
  TeardownBlockedPayload,
  TeardownStepPayload,
  TeardownTakeoverPayload,
} from "../src/generated/receipt.js";
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

describe("TeardownStepPayload.resource optional field (D-26)", () => {
  const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true });
  const validateReceiptEntry = ajv.compile(receiptSchema);

  function teardownStepEntry(payload: Record<string, unknown>): unknown {
    return {
      seq: 0,
      ts: 1000,
      chain: "verified",
      type: "teardown_step",
      prevHash: `jcs-sha256:${"0".repeat(64)}`,
      payload,
    };
  }

  const base = { step: "revoke_oauth", outcome: "discarded_revocation_unsupported" };

  it("type-checks a payload carrying resource", () => {
    const payload: TeardownStepPayload = { ...base, outcome: "discarded_revocation_unsupported", resource: "sheets.orders" };
    expect(payload.resource).toBe("sheets.orders");
  });

  it("validates an entry whose payload carries resource", () => {
    const entry = teardownStepEntry({ ...base, resource: "sheets.orders" });
    expect(validateReceiptEntry(entry), JSON.stringify(validateReceiptEntry.errors)).toBe(true);
  });

  it("still validates an entry without resource", () => {
    expect(validateReceiptEntry(teardownStepEntry(base)), JSON.stringify(validateReceiptEntry.errors)).toBe(true);
  });

  it("rejects an empty resource", () => {
    expect(validateReceiptEntry(teardownStepEntry({ ...base, resource: "" }))).toBe(false);
  });

  it("accepts a 128-character resource and rejects a 129-character one", () => {
    expect(validateReceiptEntry(teardownStepEntry({ ...base, resource: "r".repeat(128) }))).toBe(true);
    expect(validateReceiptEntry(teardownStepEntry({ ...base, resource: "r".repeat(129) }))).toBe(false);
  });

  it("still rejects an unknown extra payload field", () => {
    expect(validateReceiptEntry(teardownStepEntry({ ...base, resource: "sheets.orders", extra: "x" }))).toBe(false);
  });
});

describe("TeardownBlockedEntry (D-11, D-26)", () => {
  const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true });
  const validateReceiptEntry = ajv.compile(receiptSchema);

  function blockedEntry(payload: Record<string, unknown>): unknown {
    return {
      seq: 3,
      ts: 1000,
      chain: "verified",
      type: "teardown_blocked",
      prevHash: `jcs-sha256:${"0".repeat(64)}`,
      payload,
    };
  }

  it("type-checks a TeardownBlockedPayload", () => {
    const payload: TeardownBlockedPayload = { reason: "credentials_unavailable", resources: ["sheets.orders"] };
    expect(payload.resources).toHaveLength(1);
  });

  it("accepts one to 64 resource names", () => {
    const one = { reason: "credentials_unavailable", resources: ["a"] };
    expect(validateReceiptEntry(blockedEntry(one)), JSON.stringify(validateReceiptEntry.errors)).toBe(true);
    const many = {
      reason: "credentials_unavailable",
      resources: Array.from({ length: 64 }, (_, i) => `r${String(i)}`),
    };
    expect(validateReceiptEntry(blockedEntry(many)), JSON.stringify(validateReceiptEntry.errors)).toBe(true);
  });

  it("rejects an empty resources array", () => {
    expect(validateReceiptEntry(blockedEntry({ reason: "credentials_unavailable", resources: [] }))).toBe(false);
  });

  it("rejects 65 resources", () => {
    const tooMany = Array.from({ length: 65 }, (_, i) => `r${String(i)}`);
    expect(validateReceiptEntry(blockedEntry({ reason: "credentials_unavailable", resources: tooMany }))).toBe(false);
  });

  it("rejects an empty resource string and a 129-character one", () => {
    expect(validateReceiptEntry(blockedEntry({ reason: "credentials_unavailable", resources: [""] }))).toBe(false);
    expect(
      validateReceiptEntry(blockedEntry({ reason: "credentials_unavailable", resources: ["r".repeat(129)] })),
    ).toBe(false);
    expect(
      validateReceiptEntry(blockedEntry({ reason: "credentials_unavailable", resources: ["r".repeat(128)] })),
    ).toBe(true);
  });

  it("rejects an unknown reason", () => {
    expect(validateReceiptEntry(blockedEntry({ reason: "other", resources: ["a"] }))).toBe(false);
  });

  it("rejects an extra payload field", () => {
    expect(
      validateReceiptEntry(blockedEntry({ reason: "credentials_unavailable", resources: ["a"], extra: "x" })),
    ).toBe(false);
  });
});

describe("TeardownTakeoverEntry (Phase 9 D-11)", () => {
  const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true });
  const validateReceiptEntry = ajv.compile(receiptSchema);

  function takeoverEntry(payload: Record<string, unknown>): unknown {
    return {
      seq: 5,
      ts: 1000,
      chain: "verified",
      type: "teardown_takeover",
      prevHash: `jcs-sha256:${"0".repeat(64)}`,
      payload,
    };
  }

  it("type-checks a TeardownTakeoverPayload", () => {
    const payload: TeardownTakeoverPayload = { previousEpoch: 1, epoch: 2, reason: "fence_expired" };
    expect(payload.epoch).toBe(2);
  });

  it("accepts a takeover that moves the epoch forward", () => {
    const ok = { previousEpoch: 1, epoch: 2, reason: "fence_expired" };
    expect(validateReceiptEntry(takeoverEntry(ok)), JSON.stringify(validateReceiptEntry.errors)).toBe(true);
  });

  it("rejects an unknown reason, a missing field and an extra field", () => {
    expect(validateReceiptEntry(takeoverEntry({ previousEpoch: 1, epoch: 2, reason: "other" }))).toBe(false);
    expect(validateReceiptEntry(takeoverEntry({ previousEpoch: 1, reason: "fence_expired" }))).toBe(false);
    expect(
      validateReceiptEntry(takeoverEntry({ previousEpoch: 1, epoch: 2, reason: "fence_expired", extra: "x" })),
    ).toBe(false);
  });

  it("rejects a non-integer or out-of-range epoch", () => {
    expect(validateReceiptEntry(takeoverEntry({ previousEpoch: 0, epoch: 2, reason: "fence_expired" }))).toBe(false);
    expect(validateReceiptEntry(takeoverEntry({ previousEpoch: 1, epoch: 1, reason: "fence_expired" }))).toBe(false);
    expect(validateReceiptEntry(takeoverEntry({ previousEpoch: 1.5, epoch: 2, reason: "fence_expired" }))).toBe(false);
  });
});
