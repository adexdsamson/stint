/**
 * Phase 9 plan 05: a lease the supervisor cannot tear down on its own is marked
 * stuck at once, shown to the operator with the exact fix, labelled in `inspect`,
 * and makes `supervise --once` exit 7 so cron can alert. There is no way to abandon
 * a stuck lease (SUP-02, D-01 to D-04, user resolution 2).
 */

import type { TeardownStep } from "@stint/proxy";
import { afterEach, describe, expect, it } from "vitest";

import { seedFromCredentials } from "../src/custody.js";
import { EXIT_CODES } from "../src/exit.js";
import { sweepStuckLine } from "../src/messages.js";
import { main } from "../src/program.js";
import { buildRuntimePorts } from "../src/runtime-ports.js";
import { ACCESS_TOKEN } from "./helpers/run-fixture.js";
import { createTeardownRig } from "./helpers/teardown-rig.js";
import type { TeardownRig } from "./helpers/teardown-rig.js";

let rig: TeardownRig | undefined;
afterEach(async () => {
  await rig?.fx.harness.cleanup();
  rig = undefined;
});

const stdoutOf = (r: TeardownRig): string => r.fx.harness.stdout.join("");
const stderrOf = (r: TeardownRig): string => r.fx.harness.stderr.join("");

function supervise(r: TeardownRig, clock: number, flags: readonly string[] = [], globals: readonly string[] = []) {
  return main(
    ["--store", r.root, ...globals, "supervise", "--once", ...flags],
    r.withDeps({ clock: () => clock }),
  );
}

/** An `expired` lease with no credential in the store: teardown is blocked. */
async function setupBlocked(): Promise<{ readonly rig: TeardownRig; readonly clock: number }> {
  rig = await createTeardownRig();
  await rig.setLease({ state: "expired" });
  const lease = await rig.lease();
  rig.clearOutput();
  return { rig, clock: lease.expiresAt + 1 };
}

describe("supervise --once with a lease stuck on credentials", () => {
  it("exits 7 with exactly one stuck line naming the reason and the fix, twice, adding no receipt the second time", async () => {
    const { rig: r, clock } = await setupBlocked();

    expect(await supervise(r, clock)).toBe(EXIT_CODES.cleanupIncomplete);
    const line = `stint: ${sweepStuckLine(r.leaseId, "credentials_unavailable")}\n`;
    expect(stderrOf(r)).toBe(line);
    expect(stderrOf(r)).toContain("credentials_unavailable");
    expect(stderrOf(r)).toContain(`stint-cli cleanup ${r.leaseId} --credentials <file>`);
    expect(stdoutOf(r)).toBe("");
    expect((await r.lease()).state).toBe("expired");
    expect(await r.entries("teardown_blocked")).toHaveLength(1);
    const stuck = await r.entries("teardown_stuck");
    expect(stuck).toHaveLength(1);
    expect(stuck[0]?.payload).toEqual({ reason: "credentials_unavailable", attempts: 0 });

    // A new process re-announces the stuck lease once and exits 7 again; nothing is appended.
    r.clearOutput();
    const snapshot = await r.allReceiptsJson();
    expect(await supervise(r, clock + 500)).toBe(EXIT_CODES.cleanupIncomplete);
    expect(stderrOf(r)).toBe(line);
    expect(await r.allReceiptsJson()).toBe(snapshot);
    expect((await r.lease()).state).toBe("expired");
    expect(r.fx.harness.allOutput()).not.toContain(ACCESS_TOKEN);
  });

  it("stint-cli inspect shows the stuck label, and inspect --json keeps printing the raw lease", async () => {
    const { rig: r, clock } = await setupBlocked();
    expect(await supervise(r, clock)).toBe(EXIT_CODES.cleanupIncomplete);
    const stored = await r.lease();
    r.clearOutput();

    expect(await main(["--store", r.root, "inspect", r.leaseId], r.withDeps({ clock: () => clock }))).toBe(EXIT_CODES.ok);
    expect(stdoutOf(r)).toContain("state: expired (stuck: credentials_unavailable)");

    r.clearOutput();
    expect(await main(["--store", r.root, "--json", "inspect", r.leaseId], r.withDeps({ clock: () => clock }))).toBe(
      EXIT_CODES.ok,
    );
    expect(JSON.parse(stdoutOf(r))).toEqual(JSON.parse(JSON.stringify(stored)));
    expect(stdoutOf(r)).not.toContain("stuck");
  });

  it("cleanup with the credentials file then succeeds, and the next supervise --once exits 0 with no output", async () => {
    const { rig: r, clock } = await setupBlocked();
    expect(await supervise(r, clock)).toBe(EXIT_CODES.cleanupIncomplete);
    r.clearOutput();

    expect(
      await main(r.argv("cleanup", "--yes", "--credentials", r.fx.credentialsPath), r.withDeps({ clock: () => clock + 1 })),
    ).toBe(EXIT_CODES.ok);
    expect((await r.lease()).state).toBe("cleaned_up");
    r.clearOutput();

    expect(await supervise(r, clock + 2)).toBe(EXIT_CODES.ok);
    expect(stderrOf(r)).toBe("");
    expect(stdoutOf(r)).toBe("");
  });

  it("recovers on its own once the credential is in the store", async () => {
    const { rig: r, clock } = await setupBlocked();
    expect(await supervise(r, clock)).toBe(EXIT_CODES.cleanupIncomplete);
    r.clearOutput();

    await seedFromCredentials(r.deps, buildRuntimePorts(r.deps, r.root), r.leaseId, r.fx.credentials);
    expect(await supervise(r, clock + 1)).toBe(EXIT_CODES.ok);

    expect((await r.lease()).state).toBe("cleaned_up");
    expect(stderrOf(r)).toContain(`Lease ${r.leaseId}`);
    expect(stderrOf(r)).not.toContain("stuck");
  });

  it("under --json prints one stuck object with the listed scalar fields, then the same with repeat true", async () => {
    const { rig: r, clock } = await setupBlocked();

    expect(await supervise(r, clock, [], ["--json"])).toBe(EXIT_CODES.cleanupIncomplete);
    expect(stdoutOf(r).trim().split("\n").map((l) => JSON.parse(l) as unknown)).toEqual([
      { event: "stuck", leaseId: r.leaseId, reason: "credentials_unavailable", attempts: 0, repeat: false },
    ]);
    expect(stderrOf(r)).toBe("");

    r.clearOutput();
    expect(await supervise(r, clock + 1, [], ["--json"])).toBe(EXIT_CODES.cleanupIncomplete);
    expect(stdoutOf(r).trim().split("\n").map((l) => JSON.parse(l) as unknown)).toEqual([
      { event: "stuck", leaseId: r.leaseId, reason: "credentials_unavailable", attempts: 0, repeat: true },
    ]);
  });
});

describe("a lease stuck with retries_exhausted", () => {
  it("shows cleanup_incomplete (stuck: retries_exhausted) in inspect", async () => {
    rig = await createTeardownRig();
    const r = rig;
    const lease = await r.lease();
    await seedFromCredentials(r.deps, buildRuntimePorts(r.deps, r.root), r.leaseId, r.fx.credentials);
    const decorateSteps = (steps: readonly TeardownStep[]): readonly TeardownStep[] =>
      steps.map(
        (step): TeardownStep => ({
          name: step.name,
          run: (l, now) => (step.name === "cleanup_hook" ? Promise.resolve("failed") : step.run(l, now)),
        }),
      );
    const run = (clock: number, flags: readonly string[] = []): Promise<number> =>
      main(["--store", r.root, "supervise", "--once", ...flags], r.withDeps({ clock: () => clock, teardown: { decorateSteps } }));
    const landing = lease.expiresAt + 1;
    expect(await run(landing)).toBe(EXIT_CODES.ok);
    expect(await run(landing + 60, ["--retry-cap", "1"])).toBe(EXIT_CODES.cleanupIncomplete);
    r.clearOutput();

    expect(await main(["--store", r.root, "inspect", r.leaseId], r.withDeps({ clock: () => landing + 61 }))).toBe(
      EXIT_CODES.ok,
    );
    expect(stdoutOf(r)).toContain("state: cleanup_incomplete (stuck: retries_exhausted)");
  });
});

describe("no way to abandon a stuck lease (D-03)", () => {
  it("supervise --abandon is an unknown option and exits 2", async () => {
    const { rig: r, clock } = await setupBlocked();

    expect(await supervise(r, clock, ["--abandon"])).toBe(EXIT_CODES.usage);
    expect(await main(["--store", r.root, "supervise", "abandon"], r.withDeps({}))).toBe(EXIT_CODES.usage);
    expect((await r.lease()).state).toBe("expired");
    expect(await r.entries("teardown_stuck")).toHaveLength(0);
  });
});
