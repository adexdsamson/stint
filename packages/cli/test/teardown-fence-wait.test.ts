/**
 * Phase 9 plan 03, task 1: `cleanup` and `revoke` coexist with a running
 * supervisor (D-13, user resolution 5). While another driver holds a live
 * teardown fence they wait quietly (one poll a second, at most 30 s), never run a
 * step under that fence, finish when the other driver lets go or lands the lease,
 * and otherwise exit 8 with the fixed message naming `stint-cli cleanup <id>`.
 *
 * Time is injected: a fake `sleep` seam drives the "other driver" (it rewrites the
 * stored lease) and counts polls, so no test waits on a real timer.
 */

import { TeardownFencedError } from "@stint/proxy";
import { afterEach, describe, expect, it } from "vitest";

import { withFenceWait } from "../src/commands/teardown-support.js";
import { seedFromCredentials } from "../src/custody.js";
import type { CliDeps } from "../src/deps.js";
import { EXIT_CODES } from "../src/exit.js";
import { teardownBusyMessage } from "../src/messages.js";
import { main } from "../src/program.js";
import { buildRuntimePorts } from "../src/runtime-ports.js";
import { NOW, createTeardownRig, stepRecorder } from "./helpers/teardown-rig.js";
import type { TeardownRig } from "./helpers/teardown-rig.js";

let rig: TeardownRig | undefined;
afterEach(async () => {
  await rig?.fx.harness.cleanup();
  rig = undefined;
});

/** An active lease with its credentials in the store, so a teardown can run to the end. */
async function setup(): Promise<TeardownRig> {
  rig = await createTeardownRig();
  await seedFromCredentials(
    rig.deps,
    buildRuntimePorts(rig.deps, rig.root),
    rig.leaseId,
    rig.fx.credentials,
  );
  rig.clearOutput();
  return rig;
}

/** Another driver's live fence: valid for 60 s past the injected clock. */
const LIVE = { epoch: 1, expiresAt: NOW + 60 } as const;

interface Wait {
  readonly sleeps: number[];
  readonly deps: (rec: ReturnType<typeof stepRecorder>, fenceWaitMs?: number) => CliDeps;
}

/** Deps whose `sleep` records each interval and calls `onSleep(n)` (1-based) as the other driver. */
function waiting(r: TeardownRig, onSleep: (call: number) => Promise<void>, clock?: () => number): Wait {
  const sleeps: number[] = [];
  return {
    sleeps,
    deps: (rec, fenceWaitMs = 30_000) =>
      r.withDeps({
        ...(clock === undefined ? {} : { clock }),
        teardown: {
          decorateSteps: rec.decorateSteps,
          fenceWaitMs,
          sleep: async (ms) => {
            sleeps.push(ms);
            await onSleep(sleeps.length);
          },
        },
      }),
  };
}

const stderrOf = (r: TeardownRig): string => r.fx.harness.stderr.join("");
const stdoutOf = (r: TeardownRig): string => r.fx.harness.stdout.join("");

describe("cleanup while another driver holds a live fence (D-13)", () => {
  it("waits silently and reports the lease the other driver landed, running no step here", async () => {
    const r = await setup();
    await r.setLease({ state: "expired", fence: LIVE });
    const rec = stepRecorder();
    const wait = waiting(r, async (call) => {
      if (call === 3) await r.setLease({ state: "cleaned_up", fence: { epoch: 1, expiresAt: 0 } });
    });

    const code = await main(r.argv("cleanup", "--yes"), wait.deps(rec));

    expect(code).toBe(EXIT_CODES.ok);
    expect(wait.sleeps).toEqual([1000, 1000, 1000]);
    expect(rec.ran).toEqual([]);
    expect(stdoutOf(r)).toContain("cleaned_up");
    // No warning while waiting: stderr is only the normal closing pointer to the signed trail.
    expect(stderrOf(r)).toBe(
      `stint: See the signed per-step trail with "stint-cli receipts ${r.leaseId}" and "stint-cli verify ${r.leaseId}".\n`,
    );
  });

  it("re-attempts when the other driver releases without landing, taking epoch 2 and running every step once", async () => {
    const r = await setup();
    await r.setLease({ state: "expired", fence: LIVE });
    const rec = stepRecorder();
    const wait = waiting(r, async (call) => {
      if (call === 2) await r.setLease({ fence: { epoch: 1, expiresAt: 0 } });
    });

    const code = await main(r.argv("cleanup", "--yes"), wait.deps(rec));

    expect(code).toBe(EXIT_CODES.ok);
    expect(wait.sleeps).toEqual([1000, 1000]);
    expect(rec.ran).toEqual([
      "revoke_oauth",
      "invalidate_license",
      "cleanup_hook",
      "delete_cached_data",
      "final_receipt",
    ]);
    const lease = await r.lease();
    expect(lease.state).toBe("cleaned_up");
    expect(lease.fence).toEqual({ epoch: 2, expiresAt: 0 });
    // A released fence is not a crash: no takeover receipt.
    expect(await r.entries("teardown_takeover")).toHaveLength(0);
  });

  it("exits 8 with the fixed message when the fence is never released, changing nothing", async () => {
    const r = await setup();
    await r.setLease({ state: "expired", fence: LIVE });
    const before = await r.lease();
    const receiptsBefore = await r.allReceiptsJson();
    const rec = stepRecorder();
    const wait = waiting(r, () => Promise.resolve());

    const code = await main(r.argv("cleanup", "--yes"), wait.deps(rec, 3000));

    expect(code).toBe(EXIT_CODES.leaseBusy);
    expect(code).toBe(8);
    expect(stderrOf(r)).toContain(`stint: ${teardownBusyMessage(r.leaseId)}`);
    expect(teardownBusyMessage(r.leaseId)).toContain(`stint-cli cleanup ${r.leaseId}`);
    expect(wait.sleeps).toEqual([1000, 1000, 1000]);
    expect(rec.ran).toEqual([]);
    expect(await r.lease()).toEqual(before);
    expect(await r.allReceiptsJson()).toBe(receiptsBefore);
  });

  it("boundary: a release seen on the last poll before the deadline lets the command finish", async () => {
    const r = await setup();
    await r.setLease({ state: "expired", fence: LIVE });
    const rec = stepRecorder();
    const wait = waiting(r, async (call) => {
      if (call === 3) await r.setLease({ fence: { epoch: 1, expiresAt: 0 } });
    });

    const code = await main(r.argv("cleanup", "--yes"), wait.deps(rec, 3000));

    expect(code).toBe(EXIT_CODES.ok);
    expect(wait.sleeps).toEqual([1000, 1000, 1000]);
    expect((await r.lease()).state).toBe("cleaned_up");
    expect(rec.ran).toHaveLength(5);
  });

  it("treats a fence that lapses by the injected clock like a release and takes it over with a receipt", async () => {
    const r = await setup();
    let now = NOW;
    await r.setLease({ state: "expired", fence: { epoch: 1, expiresAt: NOW + 2 } });
    const rec = stepRecorder();
    const wait = waiting(
      r,
      () => {
        now += 1;
        return Promise.resolve();
      },
      () => now,
    );

    const code = await main(r.argv("cleanup", "--yes"), wait.deps(rec));

    expect(code).toBe(EXIT_CODES.ok);
    expect(wait.sleeps).toEqual([1000, 1000]);
    const takeovers = await r.entries("teardown_takeover");
    expect(takeovers.map((e) => e.payload)).toEqual([
      { previousEpoch: 1, epoch: 2, reason: "fence_expired" },
    ]);
    expect(rec.ran).toHaveLength(5);
    expect((await r.lease()).fence).toEqual({ epoch: 2, expiresAt: 0 });
  });

  it("reports a lease the other driver left cleanup_incomplete as that outcome (exit 7)", async () => {
    const r = await setup();
    await r.setLease({ state: "cleanup_incomplete", fence: LIVE });
    const rec = stepRecorder();
    const wait = waiting(r, async (call) => {
      if (call === 1) {
        await r.setLease({ state: "cleanup_incomplete", fence: { epoch: 1, expiresAt: 0 } });
      }
    });

    const code = await main(r.argv("cleanup", "--yes"), wait.deps(rec));

    expect(code).toBe(EXIT_CODES.cleanupIncomplete);
    expect(rec.ran).toEqual([]);
  });
});

describe("revoke while another driver holds a live fence (D-13)", () => {
  it("receipts the revoke, then exits 8 when the fence is never released", async () => {
    const r = await setup();
    await r.setLease({ fence: LIVE });
    const rec = stepRecorder();
    const wait = waiting(r, () => Promise.resolve());

    const code = await main(r.argv("revoke", "--yes"), wait.deps(rec, 2000));

    expect(code).toBe(EXIT_CODES.leaseBusy);
    expect(stderrOf(r)).toContain(`stint: ${teardownBusyMessage(r.leaseId)}`);
    expect(wait.sleeps).toEqual([1000, 1000]);
    expect(rec.ran).toEqual([]);
    const lease = await r.lease();
    expect(lease.state).toBe("revoked");
    expect(lease.fence).toEqual(LIVE);
    const events = (await r.entries("transition")).map((e) => (e.payload as { event: string }).event);
    expect(events).toEqual(["revoke"]);
  });

  it("finishes the teardown when the other driver lets go within the wait", async () => {
    const r = await setup();
    await r.setLease({ fence: LIVE });
    const rec = stepRecorder();
    const wait = waiting(r, async (call) => {
      if (call === 1) await r.setLease({ fence: { epoch: 1, expiresAt: 0 } });
    });

    const code = await main(r.argv("revoke", "--yes"), wait.deps(rec));

    expect(code).toBe(EXIT_CODES.ok);
    expect((await r.lease()).state).toBe("cleaned_up");
    expect(rec.ran).toHaveLength(5);
  });
});

describe("withFenceWait", () => {
  const unusedStore = { load: () => Promise.reject(new Error("must not load")) } as never;
  const quiet = { clock: () => NOW, teardown: { sleep: () => Promise.resolve() } } as unknown as CliDeps;

  it("rethrows a stale fence error at once without waiting", async () => {
    await expect(
      withFenceWait(quiet, unusedStore, "lease-x", () => Promise.reject(new TeardownFencedError("stale"))),
    ).rejects.toMatchObject({ kind: "stale" });
  });

  it("propagates any other error unchanged", async () => {
    const boom = new Error("boom");
    await expect(withFenceWait(quiet, unusedStore, "lease-x", () => Promise.reject(boom))).rejects.toBe(boom);
  });
});
