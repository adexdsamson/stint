import { describe, expect, it } from "vitest";

import type { VerifiedManifest } from "../src/envelope.js";
import { verifyEnvelope } from "../src/envelope.js";
import { signManifestForTest } from "../src/testing.js";
import { paymentReconcilerManifest } from "./fixtures.js";

describe("VerifiedManifest brand", () => {
  it("a plain object literal with manifest/contentHash/publisherId/kid is not assignable to VerifiedManifest", () => {
    const manifest = paymentReconcilerManifest();

    // @ts-expect-error a plain object literal has every field VerifiedManifest declares except the
    // module-private brand symbol, which is never exported -- so no code outside envelope.ts can
    // construct one without a type assertion (enforced by `pnpm typecheck`).
    const fake: VerifiedManifest = {
      manifest,
      contentHash: `jcs-sha256:${"0".repeat(64)}`,
      publisherId: "reconciler-labs.example",
      kid: "test-key",
    };

    expect(fake.publisherId).toBe("reconciler-labs.example");
  });

  it("verifyEnvelope is the only way to mint a real VerifiedManifest", async () => {
    const manifest = paymentReconcilerManifest();
    const { envelope, trustStore } = await signManifestForTest(manifest);

    const result = await verifyEnvelope(envelope, trustStore);

    expect(result.ok).toBe(true);
  });
});
