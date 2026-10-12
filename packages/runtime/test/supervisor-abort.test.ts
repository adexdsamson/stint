import { verifyChain } from "@stint/core";
import { makeTestLease } from "@stint/core/testing";
import type { TeardownStep } from "@stint/proxy";
import { describe, expect, it } from "vitest";

import { createSweepState, runSweep, seedLeaseCredentials } from "../src/index.js";
import type { RuntimePorts } from "../src/index.js";
import { buildRig, delegatedManifest, oauthCredential } from "./helpers.js";

const T0 = 5000;

/** `ids` are all expired leases with credentials seeded; the first owns the rig's envelope. */
async function setup(ids: readonly string[]): Promise<RuntimePorts> {
  const first = ids[0] ?? "lease-a";
  const rig = await buildRig(first, delegatedManifest(["sheets.orders"]));
  const envelope = await rig.ports.artifacts.get(first, "envelope");
  const ports: RuntimePorts = { ...rig.ports, clock: () => T0 };
  for (const id of ids) {
    await ports.leases.save(makeTestLease(id, { state: "expired" }));
    if (id !== first) await ports.artifacts.put(id, "envelope", envelope);
    await seedLeaseCredentials(ports, id, {
      "sheets.orders": oauthCredential("https://as.example.test/token", undefined),
    });
  }
  return ports;
}

/** Counts the steps run per lease and aborts `controller` right after `abortAfter` ran for `abortOn`. */
function abortingSteps(
  controller: AbortController,
  abortOn: string,
  abortAfter: TeardownStep["name"],
  ran: string[],
): (steps: readonly TeardownStep[]) => readonly TeardownStep[] {
  return (steps) =>
    steps.map(
      (inner): TeardownStep => ({
        name: inner.name,
        async run(lease, now) {
          ran.push(`${lease.id}:${inner.name}`);
          const outcome = await inner.run(lease, now);
          if (lease.id === abortOn && inner.name === abortAfter) controller.abort();
          return outcome;
        },
      }),
    );
}

describe("runSweep stop signal (SUP-07, D-21)", () => {
  it("processes no lease and reports aborted when the signal is already aborted", async () => {
    const ports = await setup(["lease-a", "lease-b"]);
    const controller = new AbortController();
    controller.abort();

    const report = await runSweep(ports, { signal: controller.signal, state: createSweepState() });

    expect(report.aborted).toBe(true);
    expect(report.events).toEqual([]);
    expect((await ports.leases.load("lease-a"))?.state).toBe("expired");
    expect((await ports.leases.load("lease-b"))?.state).toBe("expired");
  });

  it("stops after the lease whose step aborted: it stays tearing_down with its fence released and the next lease is untouched", async () => {
    const ports = await setup(["lease-a", "lease-b"]);
    const controller = new AbortController();
    const ran: string[] = [];

    const report = await runSweep(ports, {
      signal: controller.signal,
      state: createSweepState(),
      decorateSteps: abortingSteps(controller, "lease-a", "invalidate_license", ran),
    });

    expect(report.aborted).toBe(true);
    const a = await ports.leases.load("lease-a");
    expect(a?.state).toBe("tearing_down");
    expect(a?.fence).toEqual({ epoch: 1, expiresAt: 0 });
    expect(Object.keys(a?.teardownProgress ?? {}).sort()).toEqual(["invalidate_license", "revoke_oauth"]);
    expect(ran).toEqual(["lease-a:revoke_oauth", "lease-a:invalidate_license"]);
    expect(report.events.filter((e) => e.kind === "torn_down")).toEqual([]);

    // The second lease was never started: still expired, no fence, no progress, no receipt.
    const b = await ports.leases.load("lease-b");
    expect(b?.state).toBe("expired");
    expect(b?.fence).toBeUndefined();
    expect(b?.teardownProgress).toBeUndefined();
    expect(await ports.receipts("lease-b").load("verified")).toEqual([]);
  });

  it("the next sweep finishes the interrupted lease without repeating a recorded step and with no takeover receipt", async () => {
    const ports = await setup(["lease-a", "lease-b"]);
    const controller = new AbortController();
    await runSweep(ports, {
      signal: controller.signal,
      state: createSweepState(),
      decorateSteps: abortingSteps(controller, "lease-a", "invalidate_license", []),
    });

    const ran: string[] = [];
    const report = await runSweep(ports, {
      state: createSweepState(),
      decorateSteps: abortingSteps(new AbortController(), "none", "final_receipt", ran),
    });

    expect(report.aborted).toBe(false);
    expect(report.events.filter((e) => e.kind === "torn_down").map((e) => e.leaseId)).toEqual(["lease-a", "lease-b"]);
    expect(ran.filter((entry) => entry.startsWith("lease-a:"))).toEqual([
      "lease-a:cleanup_hook",
      "lease-a:delete_cached_data",
      "lease-a:final_receipt",
    ]);
    const chain = await ports.receipts("lease-a").load("verified");
    expect(chain.filter((entry) => entry.type === "teardown_takeover")).toEqual([]);
    expect((await verifyChain(chain)).ok).toBe(true);
    expect((await ports.leases.load("lease-a"))?.state).toBe("cleaned_up");
    expect((await ports.leases.load("lease-a"))?.fence).toEqual({ epoch: 2, expiresAt: 0 });
  });

  it("reports aborted false when no signal is given", async () => {
    const ports = await setup(["lease-a"]);

    const report = await runSweep(ports, { state: createSweepState() });

    expect(report.aborted).toBe(false);
    expect(report.scanned).toBe(1);
  });
});
