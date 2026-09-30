import { afterEach, describe, expect, it } from "vitest";

import type { Lease } from "@stint/core";

import { EXIT_CODES } from "../src/exit.js";
import { main } from "../src/program.js";
import { NOW, createHarness } from "./helpers/cli-harness.js";
import type { Harness } from "./helpers/cli-harness.js";

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

function lease(overrides: Partial<Lease> = {}): Lease {
  return {
    id: "lease-abc",
    state: "active",
    version: 2,
    boundHash: "jcs-sha256:deadbeef",
    grantedAt: NOW - 100,
    expiresAt: NOW + 3500,
    maxDurationSeconds: 3600,
    counters: {
      actionCount: 7,
      spentMinor: 1250,
      denialErrorTimestamps: [NOW - 5],
      actionTimestamps: [NOW - 10, NOW - 9],
    },
    ...overrides,
  };
}

async function saved(l: Lease): Promise<Harness> {
  const harness = await createHarness();
  h = harness;
  await harness.deps.storeFactory(harness.root).save(l);
  return harness;
}

describe("stint inspect", () => {
  it("prints state, limits, and counters and exits 0", async () => {
    const harness = await saved(lease());
    expect(await main(["--store", harness.root, "inspect", "lease-abc"], harness.deps)).toBe(0);
    const out = harness.stdout.join("");
    expect(out).toContain("Lease lease-abc");
    expect(out).toContain("state: active");
    expect(out).toContain("max duration: 3600s");
    expect(out).toContain("expires at: " + new Date((NOW + 3500) * 1000).toISOString());
    expect(out).toContain("actions: 7");
    expect(out).toContain("spent (minor units): 1250");
    expect(out).toContain("recent denial errors: 1");
    expect(out).toContain("actions in rate window: 2");
    expect(harness.stderr.join("")).toBe("");
  });

  it("an unknown id exits 4 with a fixed message", async () => {
    const harness = await createHarness();
    h = harness;
    expect(await main(["--store", harness.root, "inspect", "does-not-exist"], harness.deps)).toBe(
      EXIT_CODES.leaseNotFound,
    );
    expect(harness.stderr.join("")).toBe("stint: Lease not found.\n");
  });

  it("an id that could escape the store root is a usage error (exit 2)", async () => {
    const harness = await createHarness();
    h = harness;
    expect(await main(["--store", harness.root, "inspect", "../etc"], harness.deps)).toBe(
      EXIT_CODES.usage,
    );
  });

  it("--json emits the Lease object", async () => {
    const l = lease();
    const harness = await saved(l);
    expect(
      await main(["--store", harness.root, "inspect", "lease-abc", "--json"], harness.deps),
    ).toBe(0);
    expect(JSON.parse(harness.stdout.join(""))).toEqual(l);
  });

  it("notes an active lease that is past its expiry, without changing it", async () => {
    const harness = await saved(lease({ expiresAt: NOW - 1 }));
    await main(["--store", harness.root, "inspect", "lease-abc"], harness.deps);
    expect(harness.stdout.join("")).toContain("past its expiry");
    const after = await harness.deps.storeFactory(harness.root).load("lease-abc");
    expect(after?.state).toBe("active");
  });

  it("prints teardown progress when present", async () => {
    const harness = await saved(
      lease({ state: "tearing_down", teardownProgress: { revoke_oauth: "revoked" } }),
    );
    await main(["--store", harness.root, "inspect", "lease-abc"], harness.deps);
    expect(harness.stdout.join("")).toContain("revoke_oauth: revoked");
  });
});
