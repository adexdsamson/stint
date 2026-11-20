/**
 * Plan 11-02 follow-through (KEYC-03): with the keychain as the active custody,
 * consent names the keychain and never the plaintext statement, `create` prints
 * no "stored unencrypted" warning, and an unavailable keychain is refused with
 * the fixed opt-in message BEFORE any consent request or lease is saved.
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { credentialSecretKey } from "@stint/core";
import type { ConsentDecision, ConsentRequest, HostAdapter } from "@stint/core";

import type { CliDeps } from "../src/deps.js";
import { EXIT_CODES } from "../src/exit.js";
import {
  CONSENT_KEYCHAIN_LINE,
  CONSENT_PLAINTEXT_LINE,
  PLAINTEXT_WARNING,
} from "../src/messages.js";
import { main } from "../src/program.js";
import { buildRuntimePorts } from "../src/runtime-ports.js";
import { renderConsent } from "../src/adapter/consent-view.js";
import {
  KEYCHAIN_UNAVAILABLE_MESSAGE,
  createDefaultSecretStore,
} from "../src/store/default-secret-store.js";
import { createHarness, delegatedManifest, writeSignedManifest } from "./helpers/cli-harness.js";
import type { Harness } from "./helpers/cli-harness.js";
import { FakeKeychainBinding } from "./helpers/fake-keychain-binding.js";
import { ORDERS } from "./helpers/run-fixture.js";

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

const grant = (): Promise<ConsentDecision> => Promise.resolve({ decision: "grant" });

const CREDENTIALS = {
  [ORDERS]: {
    accessToken: "access-token-secret-do-not-leak",
    refreshToken: "refresh-token-secret-do-not-leak",
    expiry: 1_800_003_600,
    tokenEndpoint: "https://as.example.test/token",
    resourceIndicator: "https://api.example.test/orders",
    clientId: "stint-test-client",
    revocationEndpoint: "https://as.example.test/revoke",
  },
};

interface Setup {
  readonly harness: Harness;
  readonly binding: FakeKeychainBinding;
  readonly manifestPath: string;
  readonly credentialsPath: string;
  readonly requests: ConsentRequest[];
}

/** A harness whose custody is the keychain-primary default over a fake binding. */
async function setup(): Promise<Setup> {
  const harness = await createHarness({ consent: grant });
  h = harness;
  const binding = new FakeKeychainBinding();
  const requests: ConsentRequest[] = [];
  const inner = harness.deps.adapterFactory;
  const deps: CliDeps = {
    ...harness.deps,
    secrets: (root: string) =>
      createDefaultSecretStore({ root, env: {}, platform: process.platform, binding }).store,
    secretBackend: "os_keychain",
    keychainBinding: binding,
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
  (harness as { deps: CliDeps }).deps = deps;
  const fixture = await writeSignedManifest(harness.root, delegatedManifest());
  await writeFile(path.join(harness.root, "trust.json"), fixture.trustJson);
  const credentialsPath = path.join(harness.root, "creds.json");
  await writeFile(credentialsPath, JSON.stringify(CREDENTIALS));
  return { harness, binding, manifestPath: fixture.manifestPath, credentialsPath, requests };
}

const create = (s: Setup, ...extra: string[]) =>
  main(["--store", s.harness.root, "create", s.manifestPath, ...extra], s.harness.deps);

describe("create with the keychain as custody", () => {
  it("tells consent the keychain holds the credentials and prints no plaintext warning", async () => {
    const s = await setup();
    const code = await create(s, "--credentials", s.credentialsPath);

    expect(code).toBe(EXIT_CODES.ok);
    expect(s.requests).toHaveLength(1);
    expect(s.requests[0]?.custody).toEqual({
      storage: "os_keychain",
      credentials: [{ resource: ORDERS, kind: "oauth", revocation: "supported" }],
    });
    expect(s.harness.allOutput()).not.toContain(PLAINTEXT_WARNING);
    expect(s.harness.allOutput()).not.toContain(CONSENT_PLAINTEXT_LINE);

    const leases = await s.harness.deps.storeFactory(s.harness.root).list();
    const lease = leases[0];
    if (lease === undefined) throw new Error("no lease");
    const ports = buildRuntimePorts(s.harness.deps, s.harness.root);
    expect(await ports.secrets.get(credentialSecretKey(lease.id, ORDERS))).toBeDefined();
    expect(s.harness.allOutput()).not.toContain("access-token-secret-do-not-leak");
  });

  it("refuses with the fixed opt-in message before consent when the keychain is unavailable", async () => {
    const s = await setup();
    s.binding.failWith = new Error("native: org.freedesktop.secrets was not provided");
    const code = await create(s, "--credentials", s.credentialsPath);

    expect(code).toBe(EXIT_CODES.internal);
    expect(s.harness.stderr.join("")).toContain(KEYCHAIN_UNAVAILABLE_MESSAGE);
    expect(s.harness.allOutput()).not.toContain("org.freedesktop.secrets");
    expect(s.requests).toHaveLength(0);
    expect(await s.harness.deps.storeFactory(s.harness.root).list()).toHaveLength(0);
  });

  it("does not probe the keychain for a lease that holds no credentials at create", async () => {
    const s = await setup();
    s.binding.failWith = new Error("native: unavailable");
    const code = await create(s);

    expect(code).toBe(EXIT_CODES.ok);
    expect(s.binding.calls).toBe(0);
  });
});

describe("renderConsent storage line", () => {
  const credentials = [{ resource: "a.one", kind: "oauth", revocation: "supported" }] as const;

  it("shows the keychain line, and never the plaintext line, for os_keychain", () => {
    const text = renderConsent(delegatedManifest(), undefined, {
      storage: "os_keychain",
      credentials,
    });
    expect(text).toContain("a.one (oauth): can be revoked when the lease ends");
    expect(text.split(CONSENT_KEYCHAIN_LINE)).toHaveLength(2);
    expect(text).not.toContain(CONSENT_PLAINTEXT_LINE);
  });

  it("keeps the plaintext line, and no keychain line, for plaintext_file", () => {
    const text = renderConsent(delegatedManifest(), undefined, {
      storage: "plaintext_file",
      credentials,
    });
    expect(text.split(CONSENT_PLAINTEXT_LINE)).toHaveLength(2);
    expect(text).not.toContain(CONSENT_KEYCHAIN_LINE);
  });
});
