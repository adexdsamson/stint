import { credentialSecretKey } from "@stint/core";
import { makeTestLease } from "@stint/core/testing";
import { TeardownBlockedError } from "@stint/proxy";
import { startMockAuthServer } from "@stint/proxy/testing";
import type { MockAuthHarness } from "@stint/proxy/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveTeardown, seedLeaseCredentials } from "../src/index.js";
import { buildRig, delegatedManifest, hostedManifest, oauthCredential } from "./helpers.js";

const LEASE = "lease-resolve-1";
const NOW = 2000;

let serverA: MockAuthHarness;
let serverB: MockAuthHarness;

beforeEach(async () => {
  serverA = await startMockAuthServer();
  serverB = await startMockAuthServer();
});

afterEach(async () => {
  await serverA.stop();
  await serverB.stop();
});

function credentialFor(server: MockAuthHarness) {
  const { token_endpoint, revocation_endpoint } = server.oauthClient.as;
  return oauthCredential(token_endpoint ?? "", revocation_endpoint);
}

async function seedLease(rig: Awaited<ReturnType<typeof buildRig>>): Promise<void> {
  await rig.ports.leases.save(makeTestLease(LEASE, { state: "expired" }));
}

describe("resolveTeardown", () => {
  it("lands cleaned_up, revokes at the credential's own endpoint and empties the secret prefix", async () => {
    const rig = await buildRig(LEASE, delegatedManifest(["sheets.orders"]));
    await seedLease(rig);
    await seedLeaseCredentials(rig.ports, LEASE, { "sheets.orders": credentialFor(serverA) });

    const resolved = await resolveTeardown(rig.ports, { leaseId: LEASE });
    expect(resolved.expectedResources).toEqual(["sheets.orders"]);
    expect(await resolved.missingCredentials()).toEqual([]);

    const lease = await resolved.run(NOW);

    expect(lease.state).toBe("cleaned_up");
    expect(lease.teardownProgress?.revoke_oauth).toBe("revoked");
    expect(serverA.revokeHits).toBe(1);
    // Nothing remains under the lease's secret prefix: the credential key reads back absent.
    expect(await rig.ports.secrets.get(credentialSecretKey(LEASE, "sheets.orders"))).toBeUndefined();
  });

  it("revokes two credentials with different authorization servers, each at its own", async () => {
    const rig = await buildRig(LEASE, delegatedManifest(["res-a", "res-b"]));
    await seedLease(rig);
    await seedLeaseCredentials(rig.ports, LEASE, {
      "res-a": credentialFor(serverA),
      "res-b": credentialFor(serverB),
    });

    const resolved = await resolveTeardown(rig.ports, { leaseId: LEASE });
    const lease = await resolved.run(NOW);

    expect(lease.state).toBe("cleaned_up");
    expect(serverA.revokeHits).toBe(1);
    expect(serverB.revokeHits).toBe(1);
  });

  it("blocks with an unchanged lease and one teardown_blocked entry when the store is empty", async () => {
    const rig = await buildRig(LEASE, delegatedManifest(["sheets.orders"]));
    await seedLease(rig);

    const resolved = await resolveTeardown(rig.ports, { leaseId: LEASE });
    expect(await resolved.missingCredentials()).toEqual(["sheets.orders"]);

    const error = await resolved.run(NOW).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TeardownBlockedError);
    expect((error as TeardownBlockedError).resources).toEqual(["sheets.orders"]);

    const lease = await rig.ports.leases.load(LEASE);
    expect(lease?.state).toBe("expired");
    expect(lease?.teardownProgress).toBeUndefined();
    const chain = await rig.ports.receipts(LEASE).load("verified");
    expect(chain.filter((e) => e.type === "teardown_blocked")).toHaveLength(1);
    expect(chain).toHaveLength(1);
  });

  it("is blocked by the signed manifest's resources even with no grants artifact", async () => {
    const rig = await buildRig(LEASE, delegatedManifest(["sheets.orders"]));
    await seedLease(rig);
    expect(await rig.ports.artifacts.get(LEASE, "grants")).toBeUndefined();
    const resolved = await resolveTeardown(rig.ports, { leaseId: LEASE });
    await expect(resolved.run(NOW)).rejects.toBeInstanceOf(TeardownBlockedError);
  });

  it("never blocks a hosted-only lease and expects no credentials", async () => {
    const rig = await buildRig(LEASE, hostedManifest());
    await seedLease(rig);

    const resolved = await resolveTeardown(rig.ports, { leaseId: LEASE });
    expect(resolved.expectedResources).toEqual([]);
    expect(await resolved.missingCredentials()).toEqual([]);

    const lease = await resolved.run(NOW).catch((e: unknown) => e);
    expect(lease).not.toBeInstanceOf(TeardownBlockedError);
    expect(["cleaned_up", "cleanup_incomplete"]).toContain((lease as { state: string }).state);
  });

  it("wraps the five default steps with decorateSteps", async () => {
    const rig = await buildRig(LEASE, delegatedManifest(["sheets.orders"]));
    await seedLease(rig);
    await seedLeaseCredentials(rig.ports, LEASE, { "sheets.orders": credentialFor(serverA) });

    let seen: readonly string[] = [];
    const resolved = await resolveTeardown(rig.ports, {
      leaseId: LEASE,
      decorateSteps: (steps) => {
        seen = steps.map((s) => s.name);
        return steps;
      },
    });
    expect(seen).toEqual([
      "revoke_oauth",
      "invalidate_license",
      "cleanup_hook",
      "delete_cached_data",
      "final_receipt",
    ]);
    expect(resolved.deps.steps).toHaveLength(5);
  });
});
