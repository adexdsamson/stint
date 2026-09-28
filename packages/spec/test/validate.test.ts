import { describe, expect, it } from "vitest";

import { SPEC_ERROR_CODES } from "../src/errors.js";
import { resolveAuthMode, validateManifest } from "../src/validate.js";
import { cloneManifest, paymentReconcilerManifest, withoutMode } from "./fixtures.js";

describe("validateManifest", () => {
  it("valid manifest: payment-reconciler passes", () => {
    const manifest = paymentReconcilerManifest();
    const result = validateManifest(manifest);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(manifest);
    }
  });

  it("invalid manifest: unknown top-level field yields unknown_field", () => {
    const manifest = { ...paymentReconcilerManifest(), tools: [] };
    const result = validateManifest(manifest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.path).toBe("/tools");
      expect(result.errors[0]?.code).toBe("unknown_field");
      expect(typeof result.errors[0]?.message).toBe("string");
    }
  });

  it("rejects unknown access value", () => {
    const manifest = cloneManifest(paymentReconcilerManifest());
    (manifest.scopes[0] as { access: string[] }).access = ["delete"];
    const result = validateManifest(manifest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([
        {
          path: "/scopes/0/access/0",
          code: "invalid_enum",
          message: expect.any(String) as string,
          allowed: ["read", "write", "send", "pay"],
        },
      ]);
    }
  });

  it("rejects unknown approval value", () => {
    const manifest = cloneManifest(paymentReconcilerManifest());
    (manifest.approvals as { require_for: string[] }).require_for = ["refund"];
    const result = validateManifest(manifest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([
        {
          path: "/approvals/require_for/0",
          code: "invalid_enum",
          message: expect.any(String) as string,
          allowed: ["send", "pay", "irreversible"],
        },
      ]);
    }
  });

  it("rejects unknown verifier type", () => {
    const manifest = cloneManifest(paymentReconcilerManifest());
    manifest.job.verifier = { type: "publisher_code" } as unknown as typeof manifest.job.verifier;
    const result = validateManifest(manifest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([
        {
          path: "/job/verifier/type",
          code: "invalid_enum",
          message: expect.any(String) as string,
          allowed: ["resource_query", "user_confirm", "none"],
        },
      ]);
    }
  });

  it("rejects unknown auth mode", () => {
    const manifest = cloneManifest(paymentReconcilerManifest());
    manifest.auth.mode = "anonymous" as unknown as typeof manifest.auth.mode;
    const result = validateManifest(manifest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([
        {
          path: "/auth/mode",
          code: "invalid_enum",
          message: expect.any(String) as string,
          allowed: ["delegated", "hosted", "hybrid"],
        },
      ]);
    }
  });

  it("rejects verifier with fields from two branches", () => {
    const manifest = cloneManifest(paymentReconcilerManifest());
    (manifest.job.verifier as unknown as Record<string, unknown>).prompt = "extra";
    const result = validateManifest(manifest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([
        {
          path: "/job/verifier/prompt",
          code: "unknown_field",
          message: expect.any(String) as string,
        },
      ]);
    }
  });

  it("auth mode default: omitted mode resolves to hybrid", () => {
    const manifest = withoutMode(paymentReconcilerManifest());
    expect(resolveAuthMode(manifest)).toBe("hybrid");
  });

  it("auth mode default: omitted mode is held to hybrid requirements", () => {
    const withoutHosted = withoutMode(paymentReconcilerManifest());
    delete withoutHosted.auth.hosted;
    const resultNoHosted = validateManifest(withoutHosted);
    expect(resultNoHosted.ok).toBe(false);
    if (!resultNoHosted.ok) {
      expect(resultNoHosted.errors).toEqual([
        { path: "/auth/hosted", code: "missing_required", message: expect.any(String) as string },
      ]);
    }

    const withoutDelegated = withoutMode(paymentReconcilerManifest());
    delete withoutDelegated.auth.delegated;
    const resultNoDelegated = validateManifest(withoutDelegated);
    expect(resultNoDelegated.ok).toBe(false);
    if (!resultNoDelegated.ok) {
      expect(resultNoDelegated.errors).toEqual([
        { path: "/auth/delegated", code: "missing_required", message: expect.any(String) as string },
      ]);
    }

    // Identical to the explicit-hybrid case.
    const explicitHybridNoHosted = paymentReconcilerManifest();
    delete explicitHybridNoHosted.auth.hosted;
    const resultExplicit = validateManifest(explicitHybridNoHosted);
    expect(resultExplicit.ok).toBe(false);
    if (!resultExplicit.ok && !resultNoHosted.ok) {
      expect(resultExplicit.errors).toEqual(resultNoHosted.errors);
    }
  });

  it("auth mode default: validation does not mutate input", () => {
    const validInput = paymentReconcilerManifest();
    const validBefore = cloneManifest(validInput);
    validateManifest(validInput);
    expect(validInput).toEqual(validBefore);

    const invalidInput = cloneManifest(paymentReconcilerManifest());
    (invalidInput.scopes[0] as { access: string[] }).access = ["delete"];
    const invalidBefore = cloneManifest(invalidInput);
    validateManifest(invalidInput);
    expect(invalidInput).toEqual(invalidBefore);
  });

  it("auth.delegated accepts a list of provider grants", () => {
    const twoGrants = paymentReconcilerManifest();
    expect(validateManifest(twoGrants).ok).toBe(true);

    const oneGrant = cloneManifest(paymentReconcilerManifest());
    oneGrant.auth.delegated = [{ provider: "paystack", resources: ["paystack.transactions"] }];
    expect(validateManifest(oneGrant).ok).toBe(true);

    const emptyGrant = cloneManifest(paymentReconcilerManifest());
    (emptyGrant.auth as { delegated: unknown[] }).delegated = [];
    const result = validateManifest(emptyGrant);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([
        { path: "/auth/delegated", code: "out_of_range", message: expect.any(String) as string },
      ]);
    }
  });

  it("pay requires spend", () => {
    const withoutSpend = cloneManifest(paymentReconcilerManifest());
    (withoutSpend.scopes[0] as { access: string[] }).access = ["pay"];
    withoutSpend.approvals.require_for = ["pay"];
    const resultMissing = validateManifest(withoutSpend);
    expect(resultMissing.ok).toBe(false);
    if (!resultMissing.ok) {
      expect(resultMissing.errors).toEqual([
        { path: "/limits/spend", code: "missing_required", message: expect.any(String) as string },
      ]);
    }

    const withSpend = cloneManifest(withoutSpend);
    withSpend.limits.spend = { amount_minor: 100, currency: "USD" };
    expect(validateManifest(withSpend).ok).toBe(true);
  });

  it("durations are integer seconds", () => {
    const isoDuration = cloneManifest(paymentReconcilerManifest());
    (isoDuration.lease as { max_duration_seconds: unknown }).max_duration_seconds = "PT1H";
    const resultIso = validateManifest(isoDuration);
    expect(resultIso.ok).toBe(false);
    if (!resultIso.ok) {
      expect(resultIso.errors).toEqual([
        { path: "/lease/max_duration_seconds", code: "invalid_type", message: expect.any(String) as string },
      ]);
    }

    const fractional = cloneManifest(paymentReconcilerManifest());
    fractional.limits.spend = { amount_minor: 12.5, currency: "USD" };
    const resultFractional = validateManifest(fractional);
    expect(resultFractional.ok).toBe(false);
    if (!resultFractional.ok) {
      expect(resultFractional.errors).toEqual([
        { path: "/limits/spend/amount_minor", code: "invalid_type", message: expect.any(String) as string },
      ]);
    }
  });

  it("x- keys are accepted and unknown keys rejected", () => {
    const withExtension = cloneManifest(paymentReconcilerManifest());
    (withExtension as unknown as Record<string, unknown>)["x-note"] = "hi";
    (withExtension.scopes[0] as unknown as Record<string, unknown>)["x-note"] = "hi";
    expect(validateManifest(withExtension).ok).toBe(true);

    const withBogus = cloneManifest(paymentReconcilerManifest());
    (withBogus.scopes[0] as unknown as Record<string, unknown>).bogus = 1;
    const result = validateManifest(withBogus);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([
        { path: "/scopes/0/bogus", code: "unknown_field", message: expect.any(String) as string },
      ]);
    }
  });

  it("unsupported spec version", () => {
    const manifest = cloneManifest(paymentReconcilerManifest());
    (manifest as { spec_version: string }).spec_version = "alp/0.2";
    const result = validateManifest(manifest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([
        {
          path: "/spec_version",
          code: "unsupported_spec_version",
          message: expect.any(String) as string,
          allowed: ["alp/0.1"],
        },
      ]);
    }
  });

  it("cleanup accepts null and rejects non-loopback http", () => {
    const withNullCleanup = cloneManifest(paymentReconcilerManifest());
    withNullCleanup.cleanup = null;
    expect(validateManifest(withNullCleanup).ok).toBe(true);

    const withEvilHttp = cloneManifest(paymentReconcilerManifest());
    withEvilHttp.cleanup = { hook: { url: "http://evil.example" }, publisher_retains: "none" };
    const resultEvil = validateManifest(withEvilHttp);
    expect(resultEvil.ok).toBe(false);
    if (!resultEvil.ok) {
      expect(resultEvil.errors).toEqual([
        { path: "/cleanup/hook/url", code: "invalid_format", message: expect.any(String) as string },
      ]);
    }

    const withLoopbackHttp = cloneManifest(paymentReconcilerManifest());
    withLoopbackHttp.cleanup = {
      hook: { url: "http://127.0.0.1:8787/cleanup" },
      publisher_retains: "none",
    };
    expect(validateManifest(withLoopbackHttp).ok).toBe(true);
  });

  it("semantic: delegated resources must be scope resources", () => {
    const manifest = cloneManifest(paymentReconcilerManifest());
    manifest.auth.delegated = [{ provider: "paystack", resources: ["unknown.resource"] }];
    const result = validateManifest(manifest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([
        {
          path: "/auth/delegated/0/resources/0",
          code: "unknown_resource_reference",
          message: expect.any(String) as string,
        },
      ]);
    }
  });

  it("semantic: duplicate scope resources", () => {
    const manifest = cloneManifest(paymentReconcilerManifest());
    manifest.scopes = [
      { resource: "paystack.transactions", access: ["read"] },
      { resource: "paystack.transactions", access: ["write"] },
    ];
    // Keep every delegated grant pointing at a resource that still exists in
    // `scopes` so this test isolates the duplicate_item error from any
    // unrelated unknown_resource_reference error.
    manifest.auth.delegated = [{ provider: "paystack", resources: ["paystack.transactions"] }];
    const result = validateManifest(manifest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([
        { path: "/scopes/1/resource", code: "duplicate_item", message: expect.any(String) as string },
      ]);
    }
  });

  it("semantic: resource_query verifier with a valid predicate passes", () => {
    const manifest = cloneManifest(paymentReconcilerManifest());
    expect(manifest.job.verifier.type).toBe("resource_query");
    expect(validateManifest(manifest).ok).toBe(true);
  });

  it("semantic: resource_query verifier with an out-of-grammar predicate is rejected with invalid_predicate", () => {
    const manifest = cloneManifest(paymentReconcilerManifest());
    if (manifest.job.verifier.type !== "resource_query") {
      throw new Error("fixture drifted: expected a resource_query verifier");
    }
    // AND is a boolean combinator; the grammar has none (D-01).
    manifest.job.verifier.predicate = "count(rows where status = 'reconciled') >= 1 AND count(rows) < 5";
    const result = validateManifest(manifest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([
        {
          path: "/job/verifier/predicate",
          code: "invalid_predicate",
          message: expect.any(String) as string,
        },
      ]);
    }
  });

  it("semantic: resource_query verifier with an unparseable predicate is rejected with invalid_predicate", () => {
    const manifest = cloneManifest(paymentReconcilerManifest());
    if (manifest.job.verifier.type !== "resource_query") {
      throw new Error("fixture drifted: expected a resource_query verifier");
    }
    manifest.job.verifier.predicate = "not a predicate at all";
    const result = validateManifest(manifest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([
        {
          path: "/job/verifier/predicate",
          code: "invalid_predicate",
          message: expect.any(String) as string,
        },
      ]);
    }
  });

  it("semantic: user_confirm verifier never triggers predicate parsing", () => {
    const manifest = cloneManifest(paymentReconcilerManifest());
    manifest.job.verifier = { type: "user_confirm", prompt: "Did this complete correctly?" };
    expect(validateManifest(manifest).ok).toBe(true);
  });

  it("semantic: none verifier never triggers predicate parsing", () => {
    const manifest = cloneManifest(paymentReconcilerManifest());
    manifest.job.verifier = { type: "none" };
    expect(validateManifest(manifest).ok).toBe(true);
  });

  it("errors are deterministic and Stint-owned", () => {
    const manifest = cloneManifest(paymentReconcilerManifest());
    (manifest.scopes[0] as { access: string[] }).access = ["delete"];
    (manifest.approvals as { require_for: string[] }).require_for = ["refund"];

    const run1 = validateManifest(manifest);
    const run2 = validateManifest(manifest);
    expect(run1.ok).toBe(false);
    expect(run2.ok).toBe(false);
    if (!run1.ok && !run2.ok) {
      expect(run2.errors).toEqual(run1.errors);
      for (const error of run1.errors) {
        expect(Object.keys(error).sort()).toEqual(
          error.allowed === undefined ? ["code", "message", "path"] : ["allowed", "code", "message", "path"],
        );
        expect(SPEC_ERROR_CODES).toContain(error.code);
      }
      const sorted = [...run1.errors].sort((a, b) => {
        if (a.path !== b.path) return a.path < b.path ? -1 : 1;
        return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
      });
      expect(run1.errors).toEqual(sorted);
    }
  });
});
