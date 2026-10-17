/**
 * Plan 10-02 Task 2: the closed API-key provider table. `API_KEY_PROVIDERS` is
 * runtime-owned configuration (D-B): membership decides which delegated
 * resources take API keys; the values are the origins plan 10-03 binds keys to.
 */

import { describe, expect, it } from "vitest";
import { createBindingSet, credentialSecretKey } from "@stint/core";
import { createToolCatalog, parseStoredCredential } from "@stint/proxy";
import type { SeededCredential } from "@stint/proxy";
import type { Manifest } from "@stint/spec";

import {
  API_KEY_PROVIDERS,
  RuntimeError,
  apiKeyOriginFor,
  delegatedApiKeyProviders,
  enrichFromProfile,
  seedLeaseCredentials,
} from "../src/index.js";
import type { RunProfile } from "../src/index.js";
import { buildRig, manifestFor } from "./helpers.js";

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

const TABLE_ORIGIN = "https://api.paystack.co";
const LOOPBACK_ORIGIN = "http://127.0.0.1:3999";
const LEASE = "lease-origin-chain";

function profileWith(providerOrigins?: Readonly<Record<string, string>>): RunProfile {
  return {
    catalog: createToolCatalog([]),
    bindings: createBindingSet([]),
    oauth: {
      as: { issuer: "https://as.chain.example", revocation_endpoint: "https://as.chain.example/revoke" },
      client: { client_id: "profile-client" },
      clientAuth: () => undefined,
    },
    ...(providerOrigins === undefined ? {} : { providerOrigins }),
  };
}

async function storedOrigin(rig: Awaited<ReturnType<typeof buildRig>>, resource: string): Promise<string | undefined> {
  const stored = parseStoredCredential((await rig.ports.secrets.get(credentialSecretKey(LEASE, resource))) ?? "");
  return stored?.kind === "api_key" ? stored.origin : undefined;
}

describe("apiKeyOriginFor", () => {
  const manifest = delegated(["paystack"], [PAYSTACK]);

  it("falls back to the closed table", () => {
    expect(apiKeyOriginFor(manifest, PAYSTACK)).toBe(TABLE_ORIGIN);
    expect(apiKeyOriginFor(manifest, PAYSTACK, {})).toBe(TABLE_ORIGIN);
  });

  it("prefers the profile override for the resource's provider", () => {
    expect(apiKeyOriginFor(manifest, PAYSTACK, { paystack: LOOPBACK_ORIGIN })).toBe(LOOPBACK_ORIGIN);
  });

  it("ignores an override for a different provider", () => {
    expect(apiKeyOriginFor(manifest, PAYSTACK, { google: LOOPBACK_ORIGIN })).toBe(TABLE_ORIGIN);
  });

  it("is undefined for a resource whose provider is not in the table, or not delegated at all", () => {
    const other = delegated(["google"], ["sheets.orders"]);
    expect(apiKeyOriginFor(other, "sheets.orders", { google: LOOPBACK_ORIGIN })).toBeUndefined();
    expect(apiKeyOriginFor(manifest, "unrelated.resource")).toBeUndefined();
  });

  it("returns the normalized origin only (no path, no trailing slash)", () => {
    expect(apiKeyOriginFor(manifest, PAYSTACK, { paystack: `${LOOPBACK_ORIGIN}/base/` })).toBe(LOOPBACK_ORIGIN);
  });

  it("fails closed on an override that is neither https nor loopback http (no silent fallback)", () => {
    expect(apiKeyOriginFor(manifest, PAYSTACK, { paystack: "http://10.0.0.5:1" })).toBeUndefined();
    expect(apiKeyOriginFor(manifest, PAYSTACK, { paystack: "not a url" })).toBeUndefined();
  });
});

describe("enrichFromProfile and api_key origins", () => {
  const manifest = delegated(["paystack"], [PAYSTACK]);

  it("leaves an OAuth credential's shape unchanged (clientId and revocation fill only)", () => {
    const enrich = enrichFromProfile(profileWith({ paystack: LOOPBACK_ORIGIN }), manifest);
    const oauth: SeededCredential = {
      accessToken: "a",
      refreshToken: "r",
      expiry: 1,
      tokenEndpoint: "https://as.chain.example/token",
      resourceIndicator: "https://res.example/",
    };
    expect(enrich("sheets.orders", oauth)).toEqual({
      ...oauth,
      clientId: "profile-client",
      revocationEndpoint: "https://as.chain.example/revoke",
    });
  });

  it("fills only a MISSING api_key origin, from providerOrigins", () => {
    const enrich = enrichFromProfile(profileWith({ paystack: LOOPBACK_ORIGIN }), manifest);
    expect(enrich(PAYSTACK, { kind: "api_key", key: "sk" })).toEqual({
      kind: "api_key",
      key: "sk",
      origin: LOOPBACK_ORIGIN,
    });
    expect(enrich(PAYSTACK, { kind: "api_key", key: "sk", origin: TABLE_ORIGIN })).toEqual({
      kind: "api_key",
      key: "sk",
      origin: TABLE_ORIGIN,
    });
  });

  it("falls to the closed table when the profile names no override", () => {
    const enrich = enrichFromProfile(profileWith(), manifest);
    expect(enrich(PAYSTACK, { kind: "api_key", key: "sk" })).toEqual({
      kind: "api_key",
      key: "sk",
      origin: TABLE_ORIGIN,
    });
  });

  it("leaves an unresolvable api_key unchanged (the seed refuses it later)", () => {
    const enrich = enrichFromProfile(profileWith(), delegated(["google"], ["sheets.orders"]));
    expect(enrich("sheets.orders", { kind: "api_key", key: "sk" })).toEqual({ kind: "api_key", key: "sk" });
  });
});

describe("seed-time origin resolution, end to end", () => {
  const manifest = delegated(["paystack"], [PAYSTACK]);

  it("a file entry with an explicit origin wins over providerOrigins and the table", async () => {
    const rig = await buildRig(LEASE, undefined);
    await seedLeaseCredentials(
      rig.ports,
      LEASE,
      { [PAYSTACK]: { kind: "api_key", key: "sk", origin: "http://localhost:4000" } },
      { enrich: enrichFromProfile(profileWith({ paystack: LOOPBACK_ORIGIN }), manifest), manifest },
    );
    expect(await storedOrigin(rig, PAYSTACK)).toBe("http://localhost:4000");
  });

  it("with no entry origin, the profile's providerOrigins wins over the table", async () => {
    const rig = await buildRig(LEASE, undefined);
    await seedLeaseCredentials(
      rig.ports,
      LEASE,
      { [PAYSTACK]: { kind: "api_key", key: "sk" } },
      { enrich: enrichFromProfile(profileWith({ paystack: LOOPBACK_ORIGIN }), manifest), manifest },
    );
    expect(await storedOrigin(rig, PAYSTACK)).toBe(LOOPBACK_ORIGIN);
  });

  it("with no entry origin and no profile, the closed table supplies https://api.paystack.co", async () => {
    const rig = await buildRig(LEASE, undefined);
    await seedLeaseCredentials(rig.ports, LEASE, { [PAYSTACK]: { kind: "api_key", key: "sk" } }, { manifest });
    expect(await storedOrigin(rig, PAYSTACK)).toBe(TABLE_ORIGIN);
  });

  it("no resolvable origin fails the whole seed with a fixed usage message and writes nothing", async () => {
    const rig = await buildRig(LEASE, undefined);
    const other = delegated(["google"], ["sheets.orders"]);
    const err: unknown = await seedLeaseCredentials(
      rig.ports,
      LEASE,
      {
        "sheets.orders": { kind: "api_key", key: "sk-secret-do-not-echo" },
        aaa: { kind: "api_key", key: "sk-other", origin: TABLE_ORIGIN },
      },
      { manifest: other },
    ).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RuntimeError);
    const failure = err as RuntimeError;
    expect(failure.code).toBe("usage");
    expect(failure.safeMessage).not.toContain("sk-secret-do-not-echo");
    expect(failure.safeMessage).not.toContain("sheets.orders");
    expect(await rig.ports.secrets.get(credentialSecretKey(LEASE, "sheets.orders"))).toBeUndefined();
    expect(await rig.ports.secrets.get(credentialSecretKey(LEASE, "aaa"))).toBeUndefined();
    expect(await rig.ports.artifacts.get(LEASE, "grants")).toBeUndefined();
  });

  it("an unresolvable api_key with no manifest at all is refused the same way", async () => {
    const rig = await buildRig(LEASE, undefined);
    await expect(
      seedLeaseCredentials(rig.ports, LEASE, { [PAYSTACK]: { kind: "api_key", key: "sk" } }),
    ).rejects.toBeInstanceOf(RuntimeError);
  });

  it.each([
    ["a non-https non-loopback origin", "http://10.0.0.5:1"],
    ["a non-URL origin", "not a url"],
    ["a plain-http public origin", "http://api.paystack.co"],
  ])("refuses an entry carrying %s, writing nothing", async (_label, origin) => {
    const rig = await buildRig(LEASE, undefined);
    await expect(
      seedLeaseCredentials(rig.ports, LEASE, { [PAYSTACK]: { kind: "api_key", key: "sk", origin } }, { manifest }),
    ).rejects.toBeInstanceOf(RuntimeError);
    expect(await rig.ports.secrets.get(credentialSecretKey(LEASE, PAYSTACK))).toBeUndefined();
  });

  it("stores the normalized origin (a path or trailing slash is dropped)", async () => {
    const rig = await buildRig(LEASE, undefined);
    await seedLeaseCredentials(
      rig.ports,
      LEASE,
      { [PAYSTACK]: { kind: "api_key", key: "sk", origin: `${LOOPBACK_ORIGIN}/v1/` } },
      { manifest },
    );
    expect(await storedOrigin(rig, PAYSTACK)).toBe(LOOPBACK_ORIGIN);
  });

  it("put-if-absent: a second seed with a different resolvable origin leaves the stored origin unchanged", async () => {
    const rig = await buildRig(LEASE, undefined);
    await seedLeaseCredentials(rig.ports, LEASE, { [PAYSTACK]: { kind: "api_key", key: "sk" } }, { manifest });
    const second = await seedLeaseCredentials(
      rig.ports,
      LEASE,
      { [PAYSTACK]: { kind: "api_key", key: "sk-new", origin: LOOPBACK_ORIGIN } },
      { manifest },
    );
    expect(second).toEqual({ written: [], skipped: [PAYSTACK] });
    expect(await storedOrigin(rig, PAYSTACK)).toBe(TABLE_ORIGIN);
  });
});
