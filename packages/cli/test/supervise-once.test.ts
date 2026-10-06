/**
 * Phase 9 plan 01 tracer: `stint-cli supervise --once` over the REAL JSON stores
 * settles an idle active lease whose `expiresAt` has passed and tears it down to
 * `cleaned_up` under the teardown fence, with no other command (SUP-01, D-05, D-20).
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { verifyChain } from "@stint/core";
import { afterEach, describe, expect, it } from "vitest";

import { EXIT_CODES } from "../src/exit.js";
import { leaseDir } from "../src/paths.js";
import { main } from "../src/program.js";
import { buildRuntimePorts } from "../src/runtime-ports.js";
import { seedFromCredentials } from "../src/custody.js";
import { ACCESS_TOKEN, ORDERS } from "./helpers/run-fixture.js";
import { createTeardownRig } from "./helpers/teardown-rig.js";
import type { TeardownRig } from "./helpers/teardown-rig.js";

let rig: TeardownRig | undefined;
afterEach(async () => {
  await rig?.fx.harness.cleanup();
  rig = undefined;
});

/** An active lease with its credentials seeded into the store, plus the lease's expiry. */
async function setup(): Promise<{ readonly rig: TeardownRig; readonly expiresAt: number }> {
  rig = await createTeardownRig();
  const lease = await rig.lease();
  expect(lease.state).toBe("active");
  expect(lease.expiresAt).toBeGreaterThan(0);
  await seedFromCredentials(rig.deps, buildRuntimePorts(rig.deps, rig.root), rig.leaseId, rig.fx.credentials);
  rig.clearOutput();
  return { rig, expiresAt: lease.expiresAt };
}

function supervise(r: TeardownRig, clock: number, ...flags: string[]): Promise<number> {
  return main(["--store", r.root, ...flags, "supervise", "--once"], r.withDeps({ clock: () => clock }));
}

async function transitionEvents(r: TeardownRig): Promise<string[]> {
  return (await r.entries("transition")).map((entry) => {
    const payload = entry.payload as { event: string };
    return payload.event;
  });
}

const stdoutOf = (r: TeardownRig): string => r.fx.harness.stdout.join("");
const stderrOf = (r: TeardownRig): string => r.fx.harness.stderr.join("");

describe("supervise --once (SUP-01)", () => {
  it("settles an idle expired lease and tears it down under a fence, with a verifying chain", async () => {
    const { rig: r, expiresAt } = await setup();

    const code = await supervise(r, expiresAt + 1);

    expect(code).toBe(EXIT_CODES.ok);
    const lease = await r.lease();
    expect(lease.state).toBe("cleaned_up");
    expect((await transitionEvents(r)).slice(-3)).toEqual(["expire", "begin_teardown", "teardown_succeeded"]);
    expect(lease.fence).toEqual({ epoch: 1, expiresAt: 0 });

    const chain = await r.deps.receiptStoreFactory(r.root, r.leaseId).load("verified");
    expect((await verifyChain(chain)).ok).toBe(true);

    expect(stdoutOf(r)).toBe("");
    const stderr = stderrOf(r);
    expect(stderr).toContain(`stint: Lease ${r.leaseId} expired and was settled.`);
    expect(stderr).toContain(
      `stint: Lease ${r.leaseId} teardown finished: cleaned_up (credential not revoked upstream).`,
    );
    expect(stderr).toContain("The credential for sheets.orders was not revoked upstream. Rotate it in the provider dashboard.");
    expect(stderr).not.toContain(ACCESS_TOKEN);
  });

  it("settles a lease whose expiresAt equals the clock exactly", async () => {
    const { rig: r, expiresAt } = await setup();

    expect(await supervise(r, expiresAt)).toBe(EXIT_CODES.ok);

    expect((await r.lease()).state).toBe("cleaned_up");
    expect((await transitionEvents(r)).slice(-3)).toEqual(["expire", "begin_teardown", "teardown_succeeded"]);
  });

  it("leaves a lease one second before expiry active, with no output and no new receipt", async () => {
    const { rig: r, expiresAt } = await setup();
    const before = await r.allReceiptsJson();
    const leaseBefore = await r.lease();

    expect(await supervise(r, expiresAt - 1)).toBe(EXIT_CODES.ok);

    expect(stdoutOf(r)).toBe("");
    expect(stderrOf(r)).toBe("");
    expect(await r.lease()).toEqual(leaseBefore);
    expect((await r.lease()).state).toBe("active");
    expect(await r.allReceiptsJson()).toBe(before);
  });

  it("under --json prints exactly two JSON lines on stdout and no human line", async () => {
    const { rig: r, expiresAt } = await setup();

    expect(await supervise(r, expiresAt + 1, "--json")).toBe(EXIT_CODES.ok);

    const lines = stdoutOf(r).trim().split("\n");
    expect(lines).toHaveLength(2);
    const [first, second] = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(first).toEqual({ event: "expired", leaseId: r.leaseId });
    expect(second).toEqual({
      event: "torn_down",
      leaseId: r.leaseId,
      state: "cleaned_up",
      unrevoked: [ORDERS],
    });
    expect(stderrOf(r)).toBe("");
    expect(stdoutOf(r)).not.toContain(ACCESS_TOKEN);
  });

  it("prints nothing and writes no receipt for an already cleaned_up lease", async () => {
    const { rig: r, expiresAt } = await setup();
    await r.setLease({ state: "cleaned_up" });
    const before = await r.allReceiptsJson();

    expect(await supervise(r, expiresAt + 1)).toBe(EXIT_CODES.ok);

    expect(stdoutOf(r)).toBe("");
    expect(stderrOf(r)).toBe("");
    expect(await r.allReceiptsJson()).toBe(before);
  });

  it("never settles a granted lease whose expiresAt is 0", async () => {
    const { rig: r, expiresAt } = await setup();
    await r.setLease({ state: "granted", expiresAt: 0 });
    const before = await r.allReceiptsJson();

    expect(await supervise(r, expiresAt + 1)).toBe(EXIT_CODES.ok);

    expect(stdoutOf(r)).toBe("");
    expect(stderrOf(r)).toBe("");
    expect((await r.lease()).state).toBe("granted");
    expect(await r.allReceiptsJson()).toBe(before);
  });

  it("settles and tears down a granted lease past expiry like an active one", async () => {
    const { rig: r, expiresAt } = await setup();
    await r.setLease({ state: "granted" });

    expect(await supervise(r, expiresAt + 1)).toBe(EXIT_CODES.ok);

    expect((await r.lease()).state).toBe("cleaned_up");
  });

  it("reports an unreadable lease record by id and keeps sweeping the others", async () => {
    const { rig: r, expiresAt } = await setup();
    const dir = leaseDir(r.root, "torn-lease");
    await mkdir(dir, { recursive: true });
    const tornFile = path.join(dir, "lease.json");
    await writeFile(tornFile, '{"id": "torn-lease", "state": ');

    expect(await supervise(r, expiresAt + 1)).toBe(EXIT_CODES.ok);

    expect((await r.lease()).state).toBe("cleaned_up");
    const stderr = stderrOf(r);
    expect(stderr).toContain("Lease record torn-lease could not be read (store_corrupt)");
    expect(stderr).not.toContain('"state"');
  });

  it("refuses to run without --once (exit 2) and changes nothing", async () => {
    const { rig: r, expiresAt } = await setup();

    const code = await main(["--store", r.root, "supervise"], r.withDeps({ clock: () => expiresAt + 1 }));

    expect(code).toBe(EXIT_CODES.usage);
    expect(stderrOf(r)).toBe("stint: Pass --once to run a single sweep.\n");
    expect((await r.lease()).state).toBe("active");
  });
});
