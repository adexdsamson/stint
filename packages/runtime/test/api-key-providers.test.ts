/**
 * Plan 10-02 Task 2: the closed API-key provider table. `API_KEY_PROVIDERS` is
 * runtime-owned configuration (D-B): membership decides which delegated
 * resources take API keys; the values are the origins plan 10-03 binds keys to.
 */

import { describe, expect, it } from "vitest";
import type { Manifest } from "@stint/spec";

import { API_KEY_PROVIDERS, delegatedApiKeyProviders } from "../src/index.js";
import { manifestFor } from "./helpers.js";

const PAYSTACK = "paystack.transactions";

function delegated(providers: readonly string[], resources: readonly string[]): Manifest {
  return manifestFor(
    {
      mode: "delegated",
      delegated: providers.map((provider) => ({ provider, resources: [...resources] })),
    } as Manifest["auth"],
    resources,
  );
}

describe("API_KEY_PROVIDERS", () => {
  it("is the closed paystack-only table", () => {
    expect(API_KEY_PROVIDERS).toEqual({ paystack: "https://api.paystack.co" });
  });
});

describe("delegatedApiKeyProviders", () => {
  it("returns paystack for the payment-reconciler manifest", () => {
    expect(delegatedApiKeyProviders(delegated(["paystack"], [PAYSTACK]))).toEqual(["paystack"]);
  });

  it("is empty when no delegated entry names a table provider", () => {
    expect(delegatedApiKeyProviders(delegated(["google"], ["sheets.orders"]))).toEqual([]);
  });

  it("is empty for a hosted-only manifest", () => {
    expect(delegatedApiKeyProviders(manifestFor({ mode: "hosted", hosted: { license_issuer: "pub.example" } }))).toEqual([]);
  });

  it("reads only auth.delegated, never scopes", () => {
    const manifest = manifestFor(
      { mode: "delegated", delegated: [{ provider: "google", resources: [PAYSTACK] }] },
      [PAYSTACK],
    );
    expect(delegatedApiKeyProviders(manifest)).toEqual([]);
  });

  it("de-duplicates and sorts table providers across delegated entries", () => {
    const manifest = manifestFor({
      mode: "delegated",
      delegated: [
        { provider: "paystack", resources: [PAYSTACK] },
        { provider: "google", resources: ["sheets.orders"] },
        { provider: "paystack", resources: ["paystack.refunds"] },
      ],
    });
    expect(delegatedApiKeyProviders(manifest)).toEqual(["paystack"]);
  });

  it("does not mutate the manifest", () => {
    const manifest = delegated(["paystack"], [PAYSTACK]);
    const before = JSON.parse(JSON.stringify(manifest)) as Manifest;
    delegatedApiKeyProviders(manifest);
    expect(manifest).toEqual(before);
  });
});
