/**
 * Pitfall 4: `invalidate_license` must be a REAL publisher call for hosted and
 * hybrid leases (not a placeholder `ok`), exactly once even across a retry, and
 * honestly `not_applicable` for delegated ones.
 */

import { rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { Lease } from "@stint/core";
import type { Manifest } from "@stint/spec";

import { EXIT_CODES } from "../src/exit.js";
import { main } from "../src/program.js";
import { publisherBindingFile } from "../src/store/publisher-binding.js";
import {
  NOW,
  createHarness,
  delegatedManifest,
  writeSignedManifest,
} from "./helpers/cli-harness.js";
import type { Harness } from "./helpers/cli-harness.js";
import { startPublisherStub } from "./helpers/publisher-stub.js";
import type { PublisherStub } from "./helpers/publisher-stub.js";
import { ORDERS } from "./helpers/run-fixture.js";
import { createTeardownRig, startRevocable, stepRecorder } from "./helpers/teardown-rig.js";
import type { TeardownRig } from "./helpers/teardown-rig.js";

const HYBRID_AUTH: Manifest["auth"] = {
  delegated: [{ provider: "google", resources: [ORDERS] }],
  hosted: { license_issuer: "pub.example", kid: "k1" },
};

let harness: Harness | undefined;
let stub: PublisherStub | undefined;
let revocation: Server | undefined;
let rig: TeardownRig | undefined;
let asRevocable: Awaited<ReturnType<typeof startRevocable>> | undefined;

afterEach(async () => {
  await stub?.stop();
  stub = undefined;
  if (revocation !== undefined) {
    const server = revocation;
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    revocation = undefined;
  }
  await asRevocable?.close();
  asRevocable = undefined;
  await harness?.cleanup();
  harness = undefined;
  await rig?.fx.harness.cleanup();
  rig = undefined;
});

interface HybridSetup {
  readonly harness: Harness;
  readonly stub: PublisherStub;
  readonly leaseId: string;
  readonly creds: string;
  readonly lease: () => Promise<Lease>;
  readonly argv: (command: "revoke" | "cleanup", ...rest: string[]) => string[];
}

/** A real ACTIVE hybrid lease made via `stint create --publisher`, plus a loopback RFC 7009 AS. */
async function setupHybrid(): Promise<HybridSetup> {
  const h = await createHarness();
  harness = h;
  const s = await startPublisherStub();
  stub = s;

  const manifest = delegatedManifest({
    scopes: [{ resource: ORDERS, access: ["read", "send"] }],
    auth: HYBRID_AUTH,
  });
  const fixture = await writeSignedManifest(h.root, manifest);
  await writeFile(path.join(h.root, "trust.json"), fixture.trustJson);
  const publisherFile = await s.writeBindingFile(h.root);
  const code = await main(
    ["--store", h.root, "create", fixture.manifestPath, "--publisher", publisherFile],
    h.deps,
  );
  if (code !== 0) throw new Error(`setup: create exited ${String(code)}: ${h.stderr.join("")}`);
  const leaseId = h.stdout.join("").trim();

  const server = createServer((_req, res) => {
    res.statusCode = 200;
    res.end();
  });
  revocation = server;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const creds = path.join(h.root, "credentials-hybrid.json");
  await writeFile(
    creds,
    JSON.stringify({
      [ORDERS]: {
        accessToken: "access-token-secret-do-not-leak",
        refreshToken: "refresh-token-secret-do-not-leak",
        expiry: NOW + 3600,
        tokenEndpoint: `http://127.0.0.1:${String(port)}/token`,
        resourceIndicator: "https://api.example.test/orders",
        clientId: "stint-test-client",
        revocationEndpoint: `http://127.0.0.1:${String(port)}/revoke`,
      },
    }),
  );
  h.stdout.length = 0;
  h.stderr.length = 0;

  const store = h.deps.storeFactory(h.root);
  return {
    harness: h,
    stub: s,
    leaseId,
    creds,
    lease: async () => {
      const lease = await store.load(leaseId);
      if (lease === undefined) throw new Error("setup: lease missing");
      return lease;
    },
    argv: (command, ...rest) => ["--store", h.root, command, leaseId, ...rest],
  };
}

describe("teardown invalidate_license collaborator (Pitfall 4)", () => {
  it("a hybrid revoke calls the publisher /license/invalidate exactly once and records ok", async () => {
    const hy = await setupHybrid();
    expect(hy.stub.hits.invalidate).toBe(0);

    const code = await main(hy.argv("revoke", "--yes", "--credentials", hy.creds), hy.harness.deps);

    expect(code).toBe(EXIT_CODES.ok);
    expect(hy.stub.hits.invalidate).toBe(1);
    expect(hy.stub.invalidated).toEqual([hy.leaseId]);
    const lease = await hy.lease();
    expect(lease.state).toBe("cleaned_up");
    expect(lease.teardownProgress?.invalidate_license).toBe("ok");

    // No license string reaches any output.
    const out = hy.harness.allOutput();
    expect(out).not.toContain("v4.public.");
    for (const token of hy.stub.issuedTokens) expect(out).not.toContain(token);
  });

  it("the invalidate call is NOT repeated when a cleanup_incomplete lease is retried", async () => {
    const hy = await setupHybrid();
    const faults = stepRecorder("cleanup_hook");
    const first = await main(hy.argv("revoke", "--yes", "--credentials", hy.creds), {
      ...hy.harness.deps,
      teardown: { decorateSteps: faults.decorateSteps },
    });

    expect(first).toBe(EXIT_CODES.cleanupIncomplete);
    expect((await hy.lease()).state).toBe("cleanup_incomplete");
    expect((await hy.lease()).teardownProgress?.invalidate_license).toBe("ok");
    expect(hy.stub.hits.invalidate).toBe(1);

    const retry = await main(
      hy.argv("cleanup", "--yes", "--credentials", hy.creds),
      hy.harness.deps,
    );

    expect(retry).toBe(EXIT_CODES.ok);
    expect((await hy.lease()).state).toBe("cleaned_up");
    expect(hy.stub.hits.invalidate).toBe(1);
  });

  it("an unreachable publisher records invalidate_license as failed, never a false ok", async () => {
    const hy = await setupHybrid();
    await hy.stub.stop();

    const code = await main(hy.argv("revoke", "--yes", "--credentials", hy.creds), hy.harness.deps);

    expect(code).toBe(EXIT_CODES.cleanupIncomplete);
    const lease = await hy.lease();
    expect(lease.state).toBe("cleanup_incomplete");
    expect(lease.teardownProgress?.invalidate_license).toBe("failed");
    // Fixed text only: no URL, port or upstream detail in any output.
    expect(hy.harness.allOutput()).not.toContain("127.0.0.1");
  });

  it("a hybrid lease whose publisher binding is gone fails invalidation honestly (no call, no ok)", async () => {
    const hy = await setupHybrid();
    await rm(publisherBindingFile(hy.harness.root, hy.leaseId));

    const code = await main(hy.argv("revoke", "--yes", "--credentials", hy.creds), hy.harness.deps);

    expect(code).toBe(EXIT_CODES.cleanupIncomplete);
    expect((await hy.lease()).teardownProgress?.invalidate_license).toBe("failed");
    expect(hy.stub.hits.invalidate).toBe(0);
  });

  it("a hybrid revoke still requires --credentials (hybrid carries OAuth grants, Pitfall 1)", async () => {
    const hy = await setupHybrid();

    const code = await main(hy.argv("revoke", "--yes"), hy.harness.deps);

    expect(code).toBe(EXIT_CODES.usage);
    expect((await hy.lease()).state).toBe("active");
    expect(hy.stub.hits.invalidate).toBe(0);
  });

  it("a delegated lease records invalidate_license as not_applicable and calls no publisher", async () => {
    rig = await createTeardownRig();
    asRevocable = await startRevocable(rig);
    // A publisher that would count any invalidate; a delegated lease must never reach it.
    stub = await startPublisherStub();

    const code = await main(
      rig.argv("revoke", "--yes", "--credentials", asRevocable.creds),
      asRevocable.deps(),
    );

    expect(code).toBe(EXIT_CODES.ok);
    const lease = await rig.lease();
    expect(lease.state).toBe("cleaned_up");
    expect(lease.teardownProgress?.invalidate_license).toBe("not_applicable");
    expect(stub.hits.invalidate).toBe(0);
  });
});
