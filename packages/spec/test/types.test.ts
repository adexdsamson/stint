import { Ajv } from "ajv";
import addFormats from "ajv-formats";
import { describe, expect, expectTypeOf, it } from "vitest";

import type {
  Access,
  AuthMode,
  JobParameter,
  Manifest,
  ResourceQueryVerifier,
  Scope,
  Verifier,
} from "../src/generated/manifest.js";
import type {
  TeardownBlockedPayload,
  TeardownStepPayload,
  TeardownStuckPayload,
  TeardownTakeoverPayload,
} from "../src/generated/receipt.js";
import { manifestSchema, receiptSchema } from "../src/generated/schemas.js";
import { cloneManifest, paymentReconcilerManifest } from "./fixtures.js";

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

// @ts-expect-error - "number" is not a member of the JobParameter type union.
const parameterWithInvalidType: JobParameter = { name: "reference", type: "number" };

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
    expect(parameterWithInvalidType.name).toBe("reference");
  });
});

describe("Job.parameters (SPEC-08)", () => {
  const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true });
  // ajv-formats' CommonJS module sets `.default` to itself under NodeNext
  // interop (same as validate.ts); the manifest schema uses `format: "uri"`.
  addFormats.default(ajv);
  const validateSchema = ajv.compile(manifestSchema);

  /** The first error's keyword and instancePath, for the schema-level reject cases below. */
  function firstError(): { keyword: string; instancePath: string } {
    const error = validateSchema.errors?.[0];
    if (!error) throw new Error("test setup: expected at least one schema error");
    return { keyword: error.keyword, instancePath: error.instancePath };
  }

  it("JobParameter.type is exactly the closed string, integer, currency union", () => {
    expectTypeOf<JobParameter["type"]>().toEqualTypeOf<"string" | "integer" | "currency">();
  });

  it("Manifest['job']['parameters'] is an optional list of JobParameter", () => {
    type JobParameters = NonNullable<Manifest["job"]["parameters"]>;
    expectTypeOf<JobParameters[number]>().toEqualTypeOf<JobParameter>();
    expectTypeOf<Manifest["job"]["parameters"] | undefined>().toEqualTypeOf<Manifest["job"]["parameters"]>();
  });

  it("accepts the three typed parameters the payment-reconciler declares", () => {
    const manifest = paymentReconcilerManifest();
    expect(manifest.job.parameters?.map((parameter) => [parameter.name, parameter.type])).toEqual([
      ["reference", "string"],
      ["expected_amount_kobo", "integer"],
      ["currency", "currency"],
    ]);
    expect(validateSchema(manifest), JSON.stringify(validateSchema.errors)).toBe(true);
  });

  it("accepts a job with no parameters at all", () => {
    const manifest = cloneManifest(paymentReconcilerManifest());
    delete manifest.job.parameters;
    expect(validateSchema(manifest), JSON.stringify(validateSchema.errors)).toBe(true);
  });

  it("accepts a parameter carrying description and required false", () => {
    const manifest = cloneManifest(paymentReconcilerManifest());
    manifest.job.parameters = [
      {
        name: "reference",
        type: "string",
        description: "The Paystack transaction reference to reconcile.",
        required: false,
      },
    ];
    expect(validateSchema(manifest), JSON.stringify(validateSchema.errors)).toBe(true);
  });

  it("rejects a type outside string, integer and currency (enum)", () => {
    const manifest = cloneManifest(paymentReconcilerManifest());
    (manifest.job as { parameters: unknown[] }).parameters = [{ name: "reference", type: "number" }];
    expect(validateSchema(manifest)).toBe(false);
    expect(firstError()).toEqual({ keyword: "enum", instancePath: "/job/parameters/0/type" });
  });

  it("rejects an unknown field in a parameter object (additionalProperties)", () => {
    const manifest = cloneManifest(paymentReconcilerManifest());
    (manifest.job as { parameters: unknown[] }).parameters = [{ name: "reference", type: "string", foo: 1 }];
    expect(validateSchema(manifest)).toBe(false);
    expect(firstError()).toEqual({ keyword: "additionalProperties", instancePath: "/job/parameters/0" });
  });

  it("rejects a name outside the Identifier charset (pattern)", () => {
    const manifest = cloneManifest(paymentReconcilerManifest());
    (manifest.job as { parameters: unknown[] }).parameters = [{ name: "Bad Name", type: "string" }];
    expect(validateSchema(manifest)).toBe(false);
    expect(firstError()).toEqual({ keyword: "pattern", instancePath: "/job/parameters/0/name" });
  });

  it("rejects 17 parameters (maxItems)", () => {
    const manifest = cloneManifest(paymentReconcilerManifest());
    (manifest.job as { parameters: unknown[] }).parameters = Array.from({ length: 17 }, (_, i) => ({
      name: `p${String(i)}`,
      type: "string",
    }));
    expect(validateSchema(manifest)).toBe(false);
    expect(firstError()).toEqual({ keyword: "maxItems", instancePath: "/job/parameters" });
  });

  it("accepts exactly 16 parameters and rejects an empty list (minItems)", () => {
    const sixteen = cloneManifest(paymentReconcilerManifest());
    (sixteen.job as { parameters: unknown[] }).parameters = Array.from({ length: 16 }, (_, i) => ({
      name: `p${String(i)}`,
      type: "string",
    }));
    expect(validateSchema(sixteen), JSON.stringify(validateSchema.errors)).toBe(true);

    const empty = cloneManifest(paymentReconcilerManifest());
    (empty.job as { parameters: unknown[] }).parameters = [];
    expect(validateSchema(empty)).toBe(false);
    expect(firstError()).toEqual({ keyword: "minItems", instancePath: "/job/parameters" });
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

describe("TeardownStuckEntry (Phase 9 D-01)", () => {
  const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true });
  const validateReceiptEntry = ajv.compile(receiptSchema);
  const reasons = ["credentials_unavailable", "retries_exhausted", "revocation_failed", "manifest_invalid"] as const;

  function stuckEntry(payload: Record<string, unknown>): unknown {
    return {
      seq: 6,
      ts: 1000,
      chain: "verified",
      type: "teardown_stuck",
      prevHash: `jcs-sha256:${"0".repeat(64)}`,
      payload,
    };
  }

  it("type-checks a TeardownStuckPayload", () => {
    const payload: TeardownStuckPayload = { reason: "retries_exhausted", attempts: 8 };
    expect(payload.attempts).toBe(8);
  });

  it.each(reasons)("accepts the reason %s", (reason) => {
    expect(validateReceiptEntry(stuckEntry({ reason, attempts: 0 })), JSON.stringify(validateReceiptEntry.errors)).toBe(
      true,
    );
    expect(validateReceiptEntry(stuckEntry({ reason, attempts: 8 }))).toBe(true);
  });

  it("rejects an unknown reason", () => {
    expect(validateReceiptEntry(stuckEntry({ reason: "other", attempts: 1 }))).toBe(false);
  });

  it("rejects a negative or fractional attempts count", () => {
    expect(validateReceiptEntry(stuckEntry({ reason: "retries_exhausted", attempts: -1 }))).toBe(false);
    expect(validateReceiptEntry(stuckEntry({ reason: "retries_exhausted", attempts: 1.5 }))).toBe(false);
  });

  it("rejects a missing field and an extra field", () => {
    expect(validateReceiptEntry(stuckEntry({ reason: "retries_exhausted" }))).toBe(false);
    expect(validateReceiptEntry(stuckEntry({ attempts: 1 }))).toBe(false);
    expect(validateReceiptEntry(stuckEntry({ reason: "retries_exhausted", attempts: 1, extra: "x" }))).toBe(false);
  });
});
