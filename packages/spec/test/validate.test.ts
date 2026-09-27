import { describe, expect, it } from "vitest";

import { validateManifest } from "../src/validate.js";
import { paymentReconcilerManifest } from "./fixtures.js";

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
});
