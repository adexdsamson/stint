import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createBindingSet, credentialSecretKey, leaseSecretPrefix } from "@stint/core";
import type { HostAdapter, TelemetryEvent } from "@stint/core";
import { makeTestLease } from "@stint/core/testing";
import { createToolCatalog, parseStoredCredential } from "@stint/proxy";
import type { FetchLike } from "@stint/proxy";
import { startMockAuthServer } from "@stint/proxy/testing";
import type { MockAuthHarness } from "@stint/proxy/testing";
import { hashManifest } from "@stint/spec";
import type { Manifest, VerifiedManifest } from "@stint/spec";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RuntimeError, createLeaseRuntime, loadLeaseManifest, seedLeaseCredentials } from "../src/index.js";
import type { RunProfile, RunningLease } from "../src/index.js";
import { NOW, buildRig, delegatedManifest, oauthCredential } from "./helpers.js";
import type { Rig } from "./helpers.js";

const LEASE = "lease-run-1";
const ORDERS = "sheets.orders";
const PREDICATE = "count(rows where status = 'reconciled') >= 1";

let mock: MockAuthHarness;
const cleanups: Array<() => Promise<void>> = [];

beforeEach(async () => {
  mock = await startMockAuthServer();
});

afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
  await mock.stop();
});

/** A host adapter that is never reached: the calls here need no approval. */
const adapter: HostAdapter = {
  requestConsent: () => Promise.reject(new Error("unused")),
  requestApproval: () => Promise.reject(new Error("unused")),
  requestOutcomeConfirmation: () => Promise.reject(new Error("unused")),
  notify: () => Promise.resolve(),
};

function manifestWithVerifier(): Manifest {
  const base = delegatedManifest([ORDERS]);
  return {
    ...base,
    job: {
      description: base.job.description,
      verifier: { type: "resource_query", resource: ORDERS, predicate: PREDICATE },
    },
  };
}

function profileFor(withRowAdapter: boolean): RunProfile {
  return {
    catalog: createToolCatalog([
      {
        name: "read_orders",
        description: "Reads the order sheet",
        inputSchema: { type: "object", properties: {}, required: [] },
      },
    ]),
    bindings: createBindingSet([
      {
        tool: "read_orders",
        resource: ORDERS,
        access: "read",
        irreversible: false,
        provenance: "built_in",
        ...(withRowAdapter
          ? {
              rowAdapter: (result: { body: unknown }) => ({
                rows: (result.body as { rows?: Array<Record<string, unknown>> }).rows ?? [],
              }),
            }
          : {}),
      },
    ]),
    oauth: mock.oauthClient,
  };
}

interface Live {
  readonly rig: Rig;
  readonly verified: VerifiedManifest;
  readonly events: TelemetryEvent[];
  readonly authorizations: Array<string | null>;
  readonly outboundFetch: FetchLike;
  start(opts?: {
    credentials?: Parameters<typeof createLeaseRuntime>[1]["credentials"];
    profile?: RunProfile;
  }): Promise<{ client: Client; running: RunningLease }>;
}

async function setup(manifest: Manifest = manifestWithVerifier()): Promise<Live> {
  const rig = await buildRig(LEASE, manifest);
  const events: TelemetryEvent[] = [];
  const ports = { ...rig.ports, telemetry: { emit: (e: TelemetryEvent) => void events.push(e) } };
  await rig.ports.leases.save(makeTestLease(LEASE, { boundHash: hashManifest(manifest) }));
  const verified = await loadLeaseManifest(rig.ports, LEASE);
  const authorizations: Array<string | null> = [];
  const outboundFetch: FetchLike = (_url, init) => {
    authorizations.push(new Headers(init?.headers).get("authorization"));
    return Promise.resolve(
      new Response(JSON.stringify({ rows: [{ status: "reconciled" }] }), { status: 200 }),
    );
  };
  return {
    rig,
    verified,
    events,
    authorizations,
    outboundFetch,
    async start(opts = {}) {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const running = await createLeaseRuntime(ports, {
        leaseId: LEASE,
        transport: serverTransport,
        adapter,
        verified,
        profile: opts.profile ?? profileFor(true),
        outboundFetch,
        ...(opts.credentials === undefined ? {} : { credentials: opts.credentials }),
      });
      const client = new Client({ name: "agent", version: "0.0.0" });
      await client.connect(clientTransport);
      cleanups.push(async () => {
        await client.close();
        await running.close();
      });
      return { client, running };
    },
  };
}

function oauthFor(overrides: Parameters<typeof oauthCredential>[2] = {}) {
  const { token_endpoint, revocation_endpoint } = mock.oauthClient.as;
  return oauthCredential(token_endpoint ?? "", revocation_endpoint, overrides);
}

async function callRead(client: Client): Promise<CallToolResult> {
  return (await client.callTool({ name: "read_orders", arguments: {} })) as CallToolResult;
}

function storedCredential(rig: Rig) {
  return rig.ports.secrets
    .get(credentialSecretKey(LEASE, ORDERS))
    .then((raw) => (raw === undefined ? undefined : parseStoredCredential(raw)));
}

describe("createLeaseRuntime start-up checks", () => {
  it("rejects a missing lease with lease_not_found", async () => {
    const rig = await buildRig("other-lease", manifestWithVerifier());
    const verified = await loadLeaseManifest(rig.ports, "other-lease");
    const [, serverTransport] = InMemoryTransport.createLinkedPair();
    const error = await createLeaseRuntime(rig.ports, {
      leaseId: LEASE,
      transport: serverTransport,
      adapter,
      verified,
      profile: profileFor(true),
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RuntimeError);
    expect((error as RuntimeError).code).toBe("lease_not_found");
  });

  it("rejects a lease that is not active with wrong_state and the fixed text", async () => {
    const live = await setup();
    await live.rig.ports.leases.save(
      makeTestLease(LEASE, { state: "expired", boundHash: hashManifest(live.verified.manifest) }),
    );
    const [, serverTransport] = InMemoryTransport.createLinkedPair();
    const error = await createLeaseRuntime(live.rig.ports, {
      leaseId: LEASE,
      transport: serverTransport,
      adapter,
      verified: live.verified,
      profile: profileFor(true),
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RuntimeError);
    expect((error as RuntimeError).code).toBe("wrong_state");
    expect((error as RuntimeError).safeMessage).toBe("The lease is not active, so there is nothing to run.");
  });

  it("fails the lease, receipts the transition and rejects on a bound-hash mismatch", async () => {
    const live = await setup();
    await live.rig.ports.leases.save(makeTestLease(LEASE, { boundHash: "jcs-sha256:something-else" }));
    const [, serverTransport] = InMemoryTransport.createLinkedPair();
    const error = await createLeaseRuntime(live.rig.ports, {
      leaseId: LEASE,
      transport: serverTransport,
      adapter,
      verified: live.verified,
      profile: profileFor(true),
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RuntimeError);
    expect((error as RuntimeError).code).toBe("wrong_state");
    expect((error as RuntimeError).safeMessage).toBe(
      "The stored manifest no longer matches the lease's bound hash; the lease was failed. Run cleanup to finish teardown.",
    );
    expect((await live.rig.ports.leases.load(LEASE))?.state).toBe("failed");
    const chain = await live.rig.ports.receipts(LEASE).load("verified");
    expect(chain.some((entry) => entry.type === "transition")).toBe(true);
  });
});

describe("createLeaseRuntime credential custody", () => {
  it("seeds given credentials into the store with the profile enrichment and records the grant", async () => {
    const live = await setup();
    // The file entry carries no client id and no revocation endpoint: the profile fills both in.
    await live.start({ credentials: { [ORDERS]: oauthCredential(mock.oauthClient.as.token_endpoint ?? "", undefined) } });

    const stored = await storedCredential(live.rig);
    expect(stored).toMatchObject({
      clientId: mock.oauthClient.client.client_id,
      revocationEndpoint: mock.oauthClient.as.revocation_endpoint,
    });
    expect(await live.rig.ports.artifacts.get(LEASE, "grants")).toEqual({
      version: 1,
      grants: [{ resource: ORDERS, kind: "oauth", revocation: "supported" }],
    });
  });

  it("does not overwrite a credential the store already holds", async () => {
    const live = await setup();
    await seedLeaseCredentials(live.rig.ports, LEASE, {
      [ORDERS]: oauthFor({ accessToken: "stored-access" }),
    });
    await live.start({ credentials: { [ORDERS]: oauthFor({ accessToken: "file-access" }) } });

    expect(await storedCredential(live.rig)).toMatchObject({ accessToken: "stored-access" });
  });

  it("loads a stored credential through for a call that needs a token", async () => {
    const live = await setup();
    await seedLeaseCredentials(live.rig.ports, LEASE, {
      [ORDERS]: oauthFor({ accessToken: "stored-access" }),
    });
    const { client } = await live.start();

    expect((await callRead(client)).isError).not.toBe(true);
    expect(live.authorizations).toEqual(["Bearer stored-access"]);
  });

  it("writes a refreshed credential through to the store", async () => {
    const live = await setup();
    await seedLeaseCredentials(live.rig.ports, LEASE, {
      [ORDERS]: oauthFor({ accessToken: "expired-access", expiry: NOW - 10 }),
    });
    const { client } = await live.start();

    expect((await callRead(client)).isError).not.toBe(true);
    expect(mock.tokenEndpointHits).toBe(1);

    const stored = await storedCredential(live.rig);
    expect(stored).toBeDefined();
    expect((stored as { accessToken: string }).accessToken).not.toBe("expired-access");
    expect((stored as { expiry: number }).expiry).toBeGreaterThan(NOW);
    expect(live.authorizations[0]).not.toBe("Bearer expired-access");
  });

  it("starts a delegated lease with an empty store and denies the call for lack of a credential", async () => {
    const live = await setup();
    const { client } = await live.start();

    const result = await callRead(client);
    expect(result.isError).toBe(true);
    expect(live.authorizations).toEqual([]);
  });
});

describe("createLeaseRuntime outcome and teardown", () => {
  it("completes the lease on a true predicate, tears down to cleaned_up and leaves no secret behind", async () => {
    const live = await setup();
    await seedLeaseCredentials(live.rig.ports, LEASE, { [ORDERS]: oauthFor() });
    const { client, running } = await live.start();
    expect((await callRead(client)).isError).not.toBe(true);

    const lease = await running.verifyOutcome();

    expect(lease.state).toBe("cleaned_up");
    expect(lease.teardownProgress?.revoke_oauth).toBe("revoked");
    // Every in-process driver is fenced (Phase 9 D-09): the verifier completion acquired epoch 1 and released it at landing.
    expect(lease.fence).toEqual({ epoch: 1, expiresAt: 0 });
    expect((await live.rig.ports.leases.load(LEASE))?.fence).toEqual({ epoch: 1, expiresAt: 0 });
    expect(mock.revokeHits).toBe(1);
    expect(await live.rig.ports.secrets.get(credentialSecretKey(LEASE, ORDERS))).toBeUndefined();
    // Nothing remains under the lease's secret prefix: deleting the prefix removes zero keys.
    expect(await live.rig.ports.secrets.deletePrefix(leaseSecretPrefix(LEASE))).toBe(0);
  });

  it("rejects verifyOutcome with a usage error when the profile has no read binding with a row adapter", async () => {
    const live = await setup();
    const { running } = await live.start({ profile: profileFor(false) });
    const error = await running.verifyOutcome().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RuntimeError);
    expect((error as RuntimeError).code).toBe("usage");
    expect((await live.rig.ports.leases.load(LEASE))?.state).toBe("active");
  });
});

describe("createLeaseRuntime telemetry", () => {
  it("emits call.decided for calls made through the served proxy", async () => {
    const live = await setup();
    await seedLeaseCredentials(live.rig.ports, LEASE, { [ORDERS]: oauthFor() });
    const { client } = await live.start();
    await callRead(client);

    expect(live.events).toContainEqual({
      name: "call.decided",
      leaseId: LEASE,
      tool: "read_orders",
      outcome: "allowed",
    });
  });
});
