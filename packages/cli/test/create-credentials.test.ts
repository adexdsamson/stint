/**
 * Plan 08-12: `stint-cli create --credentials`. Consent learns which credentials cannot be
 * revoked, the store is seeded only after consent is granted (T-08-55), and every lease
 * records a grants artifact so teardown can fail closed (D-14, D-15, D-28).
 */

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { credentialSecretKey, parseGrantsArtifact } from "@stint/core";
import type { ConsentDecision, ConsentRequest, HostAdapter } from "@stint/core";
import type { Manifest } from "@stint/spec";

import { EXIT_CODES } from "../src/exit.js";
import { PLAINTEXT_WARNING } from "../src/messages.js";
import { leaseSecretsDir } from "../src/paths.js";
import { main } from "../src/program.js";
import { buildRuntimePorts } from "../src/runtime-ports.js";
import { renderConsent } from "../src/adapter/consent-view.js";
import { createStyle } from "../src/render/style.js";
import { loadCredentials } from "../src/run/credentials.js";
import { createHarness, delegatedManifest, writeSignedManifest } from "./helpers/cli-harness.js";
import type { Harness, HarnessOptions } from "./helpers/cli-harness.js";
import { startPublisherStub } from "./helpers/publisher-stub.js";
import type { PublisherStub } from "./helpers/publisher-stub.js";
import { ORDERS } from "./helpers/run-fixture.js";

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const grant = (): Promise<ConsentDecision> => Promise.resolve({ decision: "grant" });
const decline = (): Promise<ConsentDecision> =>
  Promise.resolve({ decision: "decline", reason: "user_declined" });

const OAUTH_NO_REVOCATION = {
  accessToken: "access-token-secret-do-not-leak",
  refreshToken: "refresh-token-secret-do-not-leak",
  expiry: 1_800_003_600,
  tokenEndpoint: "https://as.example.test/token",
  resourceIndicator: "https://api.example.test/orders",
};
const OAUTH_WITH_REVOCATION = {
  ...OAUTH_NO_REVOCATION,
  clientId: "stint-test-client",
  revocationEndpoint: "https://as.example.test/revoke",
};

interface Setup {
  readonly harness: Harness;
  readonly manifestPath: string;
  readonly requests: ConsentRequest[];
  readonly credentialsPath: string;
}

/** A harness whose adapter factory records every ConsentRequest it is asked to answer. */
async function setup(
  consent: HarnessOptions["consent"] = grant,
  manifest: Manifest = delegatedManifest(),
  credentials: unknown = { [ORDERS]: OAUTH_NO_REVOCATION },
): Promise<Setup> {
  const harness = await createHarness({ consent });
  h = harness;
  const requests: ConsentRequest[] = [];
  const inner = harness.deps.adapterFactory;
  const deps = {
    ...harness.deps,
    adapterFactory: (...args: Parameters<typeof inner>): HostAdapter => {
      const adapter = inner(...args);
      return {
        ...adapter,
        requestConsent: (request, signal) => {
          requests.push(request);
          return adapter.requestConsent(request, signal);
        },
      };
    },
  };
  (harness as { deps: typeof deps }).deps = deps;
  const fixture = await writeSignedManifest(harness.root, manifest);
  await writeFile(path.join(harness.root, "trust.json"), fixture.trustJson);
  const credentialsPath = path.join(harness.root, "creds.json");
  await writeFile(credentialsPath, JSON.stringify(credentials));
  return { harness, manifestPath: fixture.manifestPath, requests, credentialsPath };
}

const create = (s: Setup, ...extra: string[]) =>
  main(["--store", s.harness.root, "create", s.manifestPath, ...extra], s.harness.deps);

async function onlyLease(s: Setup) {
  const all = await s.harness.deps.storeFactory(s.harness.root).list();
  expect(all).toHaveLength(1);
  const lease = all[0];
  if (lease === undefined) throw new Error("no lease");
  return lease;
}

async function grantsOf(s: Setup, leaseId: string) {
  const ports = buildRuntimePorts(s.harness.deps, s.harness.root);
  return parseGrantsArtifact(await ports.artifacts.get(leaseId, "grants"));
}

describe("create without --credentials", () => {
  it("behaves as before, records the delegated resources as grants and stores no secret", async () => {
    const s = await setup();
    const code = await create(s);

    expect(code).toBe(EXIT_CODES.ok);
    const lease = await onlyLease(s);
    expect(lease.state).toBe("active");
    expect(await grantsOf(s, lease.id)).toEqual({
      version: 1,
      grants: [{ resource: ORDERS, kind: "oauth" }],
    });
    expect(existsSync(leaseSecretsDir(s.harness.root, lease.id))).toBe(false);
    expect(s.harness.stderr.join("")).not.toContain(PLAINTEXT_WARNING);
  });

  it("tells consent that revocation capability is not yet known", async () => {
    const s = await setup();
    await create(s);
    expect(s.requests[0]?.custody).toEqual({
      storage: "plaintext_file",
      credentials: [{ resource: ORDERS, kind: "oauth", revocation: "unknown" }],
    });
  });
});

describe("create with --credentials", () => {
  it("passes custody to consent, seeds the store after grant and prints the warning once", async () => {
    const s = await setup();
    const code = await create(s, "--credentials", s.credentialsPath);

    expect(code).toBe(EXIT_CODES.ok);
    expect(s.requests).toHaveLength(1);
    expect(s.requests[0]?.custody).toEqual({
      storage: "plaintext_file",
      credentials: [{ resource: ORDERS, kind: "oauth", revocation: "unsupported" }],
    });

    const lease = await onlyLease(s);
    expect(lease.state).toBe("active");
    const ports = buildRuntimePorts(s.harness.deps, s.harness.root);
    expect(await ports.secrets.get(credentialSecretKey(lease.id, ORDERS))).toBeDefined();
    const warnings = s.harness.stderr
      .join("")
      .split("\n")
      .filter((line) => line.includes(PLAINTEXT_WARNING));
    expect(warnings).toHaveLength(1);
    expect(await grantsOf(s, lease.id)).toEqual({
      version: 1,
      grants: [{ resource: ORDERS, kind: "oauth", revocation: "unsupported" }],
    });
    expect(s.harness.allOutput()).not.toContain("access-token-secret-do-not-leak");
  });

  it("marks a credential with a revocation endpoint as supported", async () => {
    const s = await setup(grant, delegatedManifest(), { [ORDERS]: OAUTH_WITH_REVOCATION });
    await create(s, "--credentials", s.credentialsPath);
    expect(s.requests[0]?.custody?.credentials[0]?.revocation).toBe("supported");
    const lease = await onlyLease(s);
    expect((await grantsOf(s, lease.id))?.grants[0]?.revocation).toBe("supported");
  });

  it("writes nothing to the store and prints no warning when consent is declined", async () => {
    const s = await setup(decline);
    const code = await create(s, "--credentials", s.credentialsPath);

    expect(code).toBe(EXIT_CODES.consentDeclined);
    const lease = await onlyLease(s);
    expect(lease.state).toBe("declined");
    expect(existsSync(path.join(s.harness.root, "secrets"))).toBe(false);
    expect(s.harness.stderr.join("")).not.toContain(PLAINTEXT_WARNING);
  });

  it("exits 2 with the fixed message for a malformed file, before any consent request", async () => {
    const s = await setup();
    await writeFile(s.credentialsPath, "{ not json");
    const code = await create(s, "--credentials", s.credentialsPath);

    expect(code).toBe(EXIT_CODES.usage);
    expect(s.requests).toHaveLength(0);
    expect(s.harness.stderr.join("")).toContain("The credentials file is not valid JSON.");
    expect(await s.harness.deps.storeFactory(s.harness.root).list()).toHaveLength(0);
  });

  it("lists a delegated resource missing from the file as unknown and still records it", async () => {
    const s = await setup(
      grant,
      delegatedManifest({
        auth: {
          mode: "delegated",
          delegated: [{ provider: "google", resources: [ORDERS, "sheets.extra"] }],
        },
        scopes: [
          { resource: ORDERS, access: ["read"] },
          { resource: "sheets.extra", access: ["read"] },
        ],
      }),
    );
    await create(s, "--credentials", s.credentialsPath);

    const byResource = Object.fromEntries(
      (s.requests[0]?.custody?.credentials ?? []).map((c) => [c.resource, c.revocation]),
    );
    expect(byResource).toEqual({ [ORDERS]: "unsupported", "sheets.extra": "unknown" });
    const lease = await onlyLease(s);
    const resources = (await grantsOf(s, lease.id))?.grants.map((g) => g.resource);
    expect(resources).toEqual(["sheets.extra", ORDERS]);
  });
});

describe("create for a hosted-only manifest", () => {
  let stub: PublisherStub | undefined;
  afterEach(async () => {
    await stub?.stop();
    stub = undefined;
  });

  it("shows no custody, records an empty grants list and prints no plaintext warning", async () => {
    const manifest = delegatedManifest({
      auth: { mode: "hosted", hosted: { license_issuer: "pub.example", kid: "k1" } },
    });
    const s = await setup(grant, manifest);
    stub = await startPublisherStub();
    const bindingFile = await stub.writeBindingFile(s.harness.root);

    const code = await create(s, "--publisher", bindingFile);

    expect(code).toBe(EXIT_CODES.ok);
    expect(s.requests[0]?.custody).toEqual({ storage: "none", credentials: [] });
    const lease = await onlyLease(s);
    expect(await grantsOf(s, lease.id)).toEqual({ version: 1, grants: [] });
    expect(s.harness.stderr.join("")).not.toContain(PLAINTEXT_WARNING);
  });
});

describe("cleanup after create --credentials", () => {
  it("reaches cleaned_up from the stored credentials with no credentials flag", async () => {
    const s = await setup();
    expect(await create(s, "--credentials", s.credentialsPath)).toBe(EXIT_CODES.ok);
    const lease = await onlyLease(s);
    const store = s.harness.deps.storeFactory(s.harness.root);
    await store.save({ ...lease, state: "revoked" });

    const code = await main(
      ["--store", s.harness.root, "cleanup", lease.id, "--yes"],
      s.harness.deps,
    );

    expect(code).toBe(EXIT_CODES.ok);
    const ended = (await store.list()).find((l) => l.id === lease.id);
    expect(ended?.state).toBe("cleaned_up");
    expect(existsSync(leaseSecretsDir(s.harness.root, lease.id))).toBe(false);
    expect(await readFile(s.credentialsPath, "utf8")).toContain("access-token-secret-do-not-leak");
  });
});

const PAYSTACK = "paystack.transactions";
const API_KEY_ENTRY = { kind: "api_key", key: "sk_test_fixture_do_not_leak" };

/** A delegated-only manifest whose one delegated provider is paystack (an API-key provider). */
function paystackManifest(): Manifest {
  return delegatedManifest({
    auth: { mode: "delegated", delegated: [{ provider: "paystack", resources: [PAYSTACK] }] },
    scopes: [{ resource: PAYSTACK, access: ["read"] }],
  });
}

describe("create --credentials with api_key entries", () => {
  it("parses an api_key entry into the LoadedCredential union", async () => {
    const s = await setup(grant, paystackManifest(), { [PAYSTACK]: API_KEY_ENTRY });
    const file = path.join(s.harness.root, "api-key-only.json");
    await writeFile(file, JSON.stringify({ [PAYSTACK]: { kind: "api_key", key: "sk_test_x" } }));
    await expect(loadCredentials(file)).resolves.toEqual({
      [PAYSTACK]: { kind: "api_key", key: "sk_test_x" },
    });
    await s.harness.cleanup();
  });

  it("rejects an api_key entry with an empty key or an origin field with the fixed message", async () => {
    for (const entry of [
      { kind: "api_key", key: "", origin: "https://api.paystack.co" },
      { kind: "api_key", key: "sk_test_x", origin: "https://api.paystack.co" },
      { kind: "api_key" },
      { kind: "api_key", key: 7 },
      { kind: "basic", key: "sk_test_x" },
    ]) {
      const s = await setup(grant, paystackManifest(), { [PAYSTACK]: entry });
      const code = await create(s, "--credentials", s.credentialsPath);
      expect(code).toBe(EXIT_CODES.usage);
      expect(s.harness.stderr.join("")).toContain("The credentials file has an unexpected shape.");
      expect(s.requests).toHaveLength(0);
      await s.harness.cleanup();
    }
  });

  it("accepts an explicit kind oauth entry exactly as a kindless one", async () => {
    const s = await setup(grant, delegatedManifest(), { [ORDERS]: { kind: "oauth", ...OAUTH_NO_REVOCATION } });
    expect(await create(s, "--credentials", s.credentialsPath)).toBe(EXIT_CODES.ok);
    expect(s.requests[0]?.custody?.credentials[0]).toEqual({
      resource: ORDERS,
      kind: "oauth",
      revocation: "unsupported",
    });
    await s.harness.cleanup();
  });

  it("seeds an api_key entry through the same path as OAuth and receipts it api_key/unsupported", async () => {
    const s = await setup(grant, paystackManifest(), { [PAYSTACK]: API_KEY_ENTRY });
    const code = await create(s, "--credentials", s.credentialsPath);

    expect(code).toBe(EXIT_CODES.ok);
    expect(s.requests[0]?.custody).toEqual({
      storage: "plaintext_file",
      credentials: [{ resource: PAYSTACK, kind: "api_key", revocation: "unsupported" }],
    });
    const lease = await onlyLease(s);
    expect(lease.state).toBe("active");
    const ports = buildRuntimePorts(s.harness.deps, s.harness.root);
    expect(await ports.secrets.get(credentialSecretKey(lease.id, PAYSTACK))).toBeDefined();
    expect(await grantsOf(s, lease.id)).toEqual({
      version: 1,
      grants: [{ resource: PAYSTACK, kind: "api_key", revocation: "unsupported" }],
    });
    const warnings = s.harness.stderr
      .join("")
      .split("\n")
      .filter((line) => line.includes(PLAINTEXT_WARNING));
    expect(warnings).toHaveLength(1);
    expect(s.harness.allOutput()).not.toContain("sk_test_fixture_do_not_leak");
    await s.harness.cleanup();
  });

  it("renders the api_key kind beside the not-revocable capability on the consent screen", async () => {
    const s = await setup(grant, paystackManifest(), { [PAYSTACK]: API_KEY_ENTRY });
    await create(s, "--credentials", s.credentialsPath);
    const rendered = renderConsent(paystackManifest(), createStyle(false), s.requests[0]?.custody);
    expect(rendered).toContain(`${PAYSTACK} (api_key): cannot be revoked by Stint`);
    await s.harness.cleanup();
  });

  it("loads a mixed OAuth + api_key file and shows both kinds with their capabilities", async () => {
    const manifest = delegatedManifest({
      auth: {
        mode: "delegated",
        delegated: [
          { provider: "google", resources: [ORDERS] },
          { provider: "paystack", resources: [PAYSTACK] },
        ],
      },
      scopes: [
        { resource: ORDERS, access: ["read", "write"] },
        { resource: PAYSTACK, access: ["read"] },
      ],
    });
    const s = await setup(grant, manifest, {
      [ORDERS]: OAUTH_WITH_REVOCATION,
      [PAYSTACK]: API_KEY_ENTRY,
    });
    const code = await create(s, "--credentials", s.credentialsPath);

    expect(code).toBe(EXIT_CODES.ok);
    expect(s.requests[0]?.custody?.credentials).toEqual([
      { resource: PAYSTACK, kind: "api_key", revocation: "unsupported" },
      { resource: ORDERS, kind: "oauth", revocation: "supported" },
    ]);
    const rendered = renderConsent(manifest, createStyle(false), s.requests[0]?.custody);
    expect(rendered).toContain(`${ORDERS} (oauth): can be revoked when the lease ends`);
    expect(rendered).toContain(`${PAYSTACK} (api_key): cannot be revoked by Stint`);
    const lease = await onlyLease(s);
    expect(await grantsOf(s, lease.id)).toEqual({
      version: 1,
      grants: [
        { resource: PAYSTACK, kind: "api_key", revocation: "unsupported" },
        { resource: ORDERS, kind: "oauth", revocation: "supported" },
      ],
    });
    const warnings = s.harness.stderr
      .join("")
      .split("\n")
      .filter((line) => line.includes(PLAINTEXT_WARNING));
    expect(warnings).toHaveLength(1);
    await s.harness.cleanup();
  });
});
