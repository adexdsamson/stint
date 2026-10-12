/**
 * `stint run` custody (D-06, D-08, D-09, D-28): a credentials file is copied into
 * the secret store, the plaintext warning and the unrevocable notice go to
 * stderr only (stdout is the MCP channel), and a lease whose store already holds
 * every credential is served with no file at all.
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { credentialSecretKey } from "@stint/core";
import { makeTestLease } from "@stint/core/testing";
import { hashManifest } from "@stint/spec";
import { signManifestForTest } from "@stint/spec/testing";
import { afterEach, describe, expect, it } from "vitest";

import { EXIT_CODES } from "../src/exit.js";
import { PLAINTEXT_WARNING, unrevocableNotice } from "../src/messages.js";
import { main } from "../src/program.js";
import { buildRuntimePorts } from "../src/runtime-ports.js";
import { saveEnvelope } from "../src/store/envelope.js";
import { delegatedManifest } from "./helpers/cli-harness.js";
import { CREDENTIALS_JSON, ORDERS, PROFILE_JSON, createRunFixture } from "./helpers/run-fixture.js";
import type { RunFixture } from "./helpers/run-fixture.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

const SECRETS = ["access-token-secret-do-not-leak", "refresh-token-secret-do-not-leak"];

async function fixture(): Promise<RunFixture> {
  const fx = await createRunFixture();
  cleanups.push(() => fx.harness.cleanup());
  return fx;
}

function runArgs(
  fx: RunFixture,
  opts: { readonly credentials?: string | null; readonly profile?: string; readonly leaseId?: string } = {},
): string[] {
  const credentials = opts.credentials === undefined ? fx.credentialsPath : opts.credentials;
  return [
    "--store",
    fx.harness.root,
    "run",
    opts.leaseId ?? fx.leaseId,
    "--profile",
    opts.profile ?? fx.profilePath,
    ...(credentials === null ? [] : ["--credentials", credentials]),
  ];
}

/** Runs the command to a clean disconnect over an injected in-memory transport; resolves with the exit code. */
async function serve(fx: RunFixture, args: string[]): Promise<number> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const deps = {
    ...fx.harness.deps,
    run: { openTerminal: () => undefined, createTransport: () => serverTransport },
  };
  const done = main(args, deps);
  const client = new Client({ name: "test-agent", version: "0.0.0" });
  const connected = (async (): Promise<undefined> => {
    await client.connect(clientTransport);
    await client.listTools();
    await client.close();
    return undefined;
  })();
  // A command that fails before serving finishes first; report its code instead of hanging.
  const early = await Promise.race([done, connected]);
  return early ?? (await done);
}

/** Runs a command that is expected to fail before anything is served. */
function refuse(fx: RunFixture, args: string[]): Promise<number> {
  return main(args, fx.harness.deps);
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function expectNoSecrets(fx: RunFixture): void {
  const all = fx.harness.allOutput();
  for (const secret of SECRETS) expect(all).not.toContain(secret);
}

async function storeHolds(fx: RunFixture, leaseId: string = fx.leaseId): Promise<boolean> {
  const ports = buildRuntimePorts(fx.harness.deps, fx.harness.root);
  return (await ports.secrets.get(credentialSecretKey(leaseId, ORDERS))) !== undefined;
}

describe("stint run custody", () => {
  it("prints the plaintext warning once and the unrevocable notice on stderr, nothing on stdout, and stores the credential", async () => {
    const fx = await fixture();

    expect(await serve(fx, runArgs(fx))).toBe(EXIT_CODES.ok);

    const stderr = fx.harness.stderr.join("");
    expect(count(stderr, PLAINTEXT_WARNING)).toBe(1);
    expect(count(stderr, unrevocableNotice(ORDERS))).toBe(1);
    expect(stderr).toContain("until you rotate it in the provider dashboard");
    expect(fx.harness.stdout).toEqual([]);
    expectNoSecrets(fx);
    expect(await storeHolds(fx)).toBe(true);
  });

  it("a second run with the same file prints neither the warning nor the notice", async () => {
    const fx = await fixture();
    expect(await serve(fx, runArgs(fx))).toBe(EXIT_CODES.ok);
    fx.harness.stderr.length = 0;

    expect(await serve(fx, runArgs(fx))).toBe(EXIT_CODES.ok);

    const stderr = fx.harness.stderr.join("");
    expect(stderr).not.toContain(PLAINTEXT_WARNING);
    expect(stderr).not.toContain("cannot be revoked by Stint");
    expect(fx.harness.stdout).toEqual([]);
  });

  it("a credential with a revocation endpoint gets the plaintext warning and no unrevocable notice", async () => {
    const fx = await fixture();
    const file = path.join(fx.harness.root, "credentials-revocable.json");
    await writeFile(
      file,
      JSON.stringify({
        [ORDERS]: {
          ...CREDENTIALS_JSON[ORDERS],
          clientId: "stint-test-client",
          revocationEndpoint: "https://as.example.test/revoke",
        },
      }),
    );

    expect(await serve(fx, runArgs(fx, { credentials: file }))).toBe(EXIT_CODES.ok);

    const stderr = fx.harness.stderr.join("");
    expect(count(stderr, PLAINTEXT_WARNING)).toBe(1);
    expect(stderr).not.toContain("cannot be revoked by Stint");
    expect(fx.harness.stdout).toEqual([]);
    expectNoSecrets(fx);
  });

  it("a profile with a revocation endpoint gets the plaintext warning and no unrevocable notice", async () => {
    const fx = await fixture();
    const profile = path.join(fx.harness.root, "profile-revocable.json");
    await writeFile(
      profile,
      JSON.stringify({
        ...PROFILE_JSON,
        oauth: {
          ...PROFILE_JSON.oauth,
          as: { ...PROFILE_JSON.oauth.as, revocation_endpoint: "https://as.example.test/revoke" },
        },
      }),
    );

    expect(await serve(fx, runArgs(fx, { profile }))).toBe(EXIT_CODES.ok);

    const stderr = fx.harness.stderr.join("");
    expect(count(stderr, PLAINTEXT_WARNING)).toBe(1);
    expect(stderr).not.toContain("cannot be revoked by Stint");
    expect(fx.harness.stdout).toEqual([]);
  });

  it("serves the lease with no credentials file once the store holds every expected credential", async () => {
    const fx = await fixture();
    expect(await serve(fx, runArgs(fx))).toBe(EXIT_CODES.ok);
    fx.harness.stderr.length = 0;

    expect(await serve(fx, runArgs(fx, { credentials: null }))).toBe(EXIT_CODES.ok);

    expect(fx.harness.stderr.join("")).not.toContain(PLAINTEXT_WARNING);
    expect(fx.harness.stdout).toEqual([]);
  });

  it("exits 2 with the existing message when the store is empty and no file is given", async () => {
    const fx = await fixture();

    expect(await refuse(fx, runArgs(fx, { credentials: null }))).toBe(EXIT_CODES.usage);

    expect(fx.harness.stderr.join("")).toContain(
      "--credentials <file> is required for a lease with delegated or hybrid auth.",
    );
    expect(fx.harness.stdout).toEqual([]);
    expect(await storeHolds(fx)).toBe(false);
  });

  it("serves a hosted-only lease with no file and prints no custody line", async () => {
    const fx = await fixture();
    const manifest = delegatedManifest({
      auth: { mode: "hosted", hosted: { license_issuer: "pub.example" } },
      scopes: [{ resource: ORDERS, access: ["read"] }],
    });
    const { envelope, publicJwk } = await signManifestForTest(manifest, { kid: "k1" });
    await writeFile(
      path.join(fx.harness.root, "trust.json"),
      JSON.stringify({ [manifest.publisher.id]: { k1: publicJwk } }),
    );
    const leaseId = "hosted-lease";
    await saveEnvelope(fx.harness.root, leaseId, envelope);
    await fx.harness.deps
      .storeFactory(fx.harness.root)
      .save(makeTestLease(leaseId, { boundHash: hashManifest(manifest) }));

    expect(await serve(fx, runArgs(fx, { credentials: null, leaseId }))).toBe(EXIT_CODES.ok);

    const stderr = fx.harness.stderr.join("");
    expect(stderr).not.toContain(PLAINTEXT_WARNING);
    expect(stderr).not.toContain("cannot be revoked by Stint");
    expect(fx.harness.stdout).toEqual([]);
  });
});
