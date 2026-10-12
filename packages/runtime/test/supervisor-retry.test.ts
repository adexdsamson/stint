import { makeTestLease } from "@stint/core/testing";
import type { Telemetry, TelemetryEvent } from "@stint/core";
import { appendReceiptEntry } from "@stint/proxy";
import type { TeardownStep } from "@stint/proxy";
import type { ReceiptEntry } from "@stint/spec";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_SUPERVISOR_CONFIG,
  createSweepState,
  markStuck,
  resolveTeardown,
  runSweep,
  seedLeaseCredentials,
} from "../src/index.js";
import type { RuntimePorts, SupervisorConfig, SweepEvent, SweepState } from "../src/index.js";
import { buildRig, delegatedManifest, oauthCredential } from "./helpers.js";

const LEASE = "lease-retry-1";
const T0 = 5000;

interface Harness {
  readonly ports: RuntimePorts;
  readonly now: { value: number };
  readonly telemetry: TelemetryEvent[];
  /** One state for every sweep of a test, like one supervisor process. */
  readonly state: SweepState;
  /** How many more times `cleanup_hook` fails; `Infinity` fails every time. */
  readonly hook: { failures: number; calls: number };
  readonly decorateSteps: (steps: readonly TeardownStep[]) => readonly TeardownStep[];
}

async function setup(initialState: "expired" | "cleanup_incomplete" = "expired"): Promise<Harness> {
  const rig = await buildRig(LEASE, delegatedManifest(["sheets.orders"]));
  const now = { value: T0 };
  const telemetry: TelemetryEvent[] = [];
  const sink: Telemetry = {
    emit: (event) => {
      telemetry.push(event);
    },
  };
  const ports: RuntimePorts = { ...rig.ports, clock: () => now.value, telemetry: sink };
  await ports.leases.save(makeTestLease(LEASE, { state: initialState }));
  await seedLeaseCredentials(ports, LEASE, {
    "sheets.orders": oauthCredential("https://as.example.test/token", undefined),
  });
  const hook = { failures: 0, calls: 0 };
  const decorateSteps = (steps: readonly TeardownStep[]): readonly TeardownStep[] =>
    steps.map(
      (step): TeardownStep => ({
        name: step.name,
        run: (lease, at) => {
          if (step.name !== "cleanup_hook") return step.run(lease, at);
          hook.calls += 1;
          if (hook.failures > 0) {
            hook.failures -= 1;
            return Promise.resolve("failed");
          }
          return step.run(lease, at);
        },
      }),
    );
  return { ports, now, telemetry, hook, decorateSteps, state: createSweepState() };
}

async function verified(h: Harness): Promise<readonly ReceiptEntry[]> {
  return h.ports.receipts(LEASE).load("verified");
}

function transitionEvents(chain: readonly ReceiptEntry[]): { event: string; actor: string }[] {
  return chain
    .filter((entry) => entry.type === "transition")
    .map((entry) => {
      const payload = entry.payload as { event: string; actor: string };
      return { event: payload.event, actor: payload.actor };
    });
}

async function sweepAt(h: Harness, at: number, config?: SupervisorConfig): Promise<readonly SweepEvent[]> {
  h.now.value = at;
  const report = await runSweep(h.ports, {
    decorateSteps: h.decorateSteps,
    state: h.state,
    ...(config === undefined ? {} : { config }),
  });
  return report.events;
}

describe("supervisor retry (SUP-02)", () => {
  it("retries a lease whose cleanup hook failed once after the backoff and lands cleaned_up, every attempt receipted", async () => {
    const h = await setup();
    h.hook.failures = 1;

    const first = await sweepAt(h, T0);
    expect(first.map((e) => e.kind)).toEqual(["torn_down"]);
    expect((await h.ports.leases.load(LEASE))?.state).toBe("cleanup_incomplete");
    const afterLanding = await verified(h);

    // One second before the backoff ends: nothing happens.
    expect(await sweepAt(h, T0 + 59)).toEqual([]);
    expect(await verified(h)).toEqual(afterLanding);
    expect((await h.ports.leases.load(LEASE))?.state).toBe("cleanup_incomplete");

    // Exactly at the end of the backoff: retried.
    const events = await sweepAt(h, T0 + 60);
    const retried = events.filter((e) => e.kind === "retried");
    expect(retried).toHaveLength(1);
    expect(retried[0]).toMatchObject({ kind: "retried", leaseId: LEASE, attempt: 1 });
    expect(events.map((e) => e.kind)).toEqual(["retried"]);
    const lease = await h.ports.leases.load(LEASE);
    expect(lease?.state).toBe("cleaned_up");
    expect((retried[0] as Extract<SweepEvent, { kind: "retried" }>).lease.state).toBe("cleaned_up");

    const chain = await verified(h);
    const transitions = transitionEvents(chain.slice(afterLanding.length));
    expect(transitions).toEqual([
      { event: "retry_teardown", actor: "runtime" },
      { event: "teardown_succeeded", actor: "runtime" },
    ]);
    const stepReceipts = chain.slice(afterLanding.length).filter((e) => e.type === "teardown_step");
    expect(stepReceipts.length).toBeGreaterThan(0);
    expect(chain.filter((e) => e.type === "teardown_stuck")).toHaveLength(0);

    expect(h.telemetry).toContainEqual({ name: "supervisor.action", leaseId: LEASE, action: "retried" });
  });

  it("makes exactly 8 retries for a hook that always fails, then writes one teardown_stuck after the ninth failed pass", async () => {
    const h = await setup();
    h.hook.failures = Number.POSITIVE_INFINITY;
    await sweepAt(h, T0);

    const all: SweepEvent[] = [];
    let clock = T0;
    for (let retry = 1; retry <= 7; retry += 1) {
      clock += 4000;
      all.push(...(await sweepAt(h, clock)));
    }
    // The eighth failed pass (seventh retry) does not write the stuck marker.
    expect((await verified(h)).filter((e) => e.type === "teardown_stuck")).toHaveLength(0);
    expect(all.filter((e) => e.kind === "stuck")).toHaveLength(0);

    clock += 4000;
    all.push(...(await sweepAt(h, clock)));

    const chain = await verified(h);
    const stuckIndex = chain.findIndex((e) => e.type === "teardown_stuck");
    expect(stuckIndex).toBeGreaterThan(0);
    const before = chain.slice(0, stuckIndex);
    const retries = transitionEvents(before).filter((t) => t.event === "retry_teardown");
    expect(retries).toHaveLength(8);
    expect(retries.every((t) => t.actor === "runtime")).toBe(true);
    const stuckEntries = chain.filter((e) => e.type === "teardown_stuck");
    expect(stuckEntries).toHaveLength(1);
    expect(stuckEntries[0]?.payload).toEqual({ reason: "retries_exhausted", attempts: 9 });

    const retried = all.filter((e) => e.kind === "retried");
    expect(retried.map((e) => (e as { attempt: number }).attempt)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const stuck = all.filter((e) => e.kind === "stuck");
    expect(stuck).toEqual([{ kind: "stuck", leaseId: LEASE, reason: "retries_exhausted", attempts: 9, repeat: false }]);
    expect((await h.ports.leases.load(LEASE))?.state).toBe("cleanup_incomplete");
    expect(h.telemetry).toContainEqual({ name: "supervisor.action", leaseId: LEASE, action: "stuck" });

    // Ten more sweeps far in the future add no receipt and no event.
    const snapshot = JSON.stringify(await verified(h));
    const callsBefore = h.hook.calls;
    for (let i = 1; i <= 10; i += 1) {
      expect(await sweepAt(h, clock + i * 1_000_000)).toEqual([]);
    }
    expect(JSON.stringify(await verified(h))).toBe(snapshot);
    expect(h.hook.calls).toBe(callsBefore);
    expect((await h.ports.leases.load(LEASE))?.state).toBe("cleanup_incomplete");
  });

  it("a manual cleanup still retries a stuck lease, and a failed manual pass restarts the retry budget", async () => {
    const h = await setup();
    h.hook.failures = Number.POSITIVE_INFINITY;
    await sweepAt(h, T0);
    let clock = T0;
    for (let retry = 1; retry <= 8; retry += 1) {
      clock += 4000;
      await sweepAt(h, clock);
    }
    expect((await verified(h)).filter((e) => e.type === "teardown_stuck")).toHaveLength(1);

    // The user runs cleanup: the retry runs even though the lease is stuck, and it fails again.
    clock += 100;
    h.now.value = clock;
    const callsBefore = h.hook.calls;
    const resolved = await resolveTeardown(h.ports, { leaseId: LEASE, decorateSteps: h.decorateSteps });
    const landed = await resolved.retry("user", clock);
    expect(landed.state).toBe("cleanup_incomplete");
    expect(h.hook.calls).toBe(callsBefore + 1);
    const chain = await verified(h);
    expect(transitionEvents(chain).filter((t) => t.actor === "user" && t.event === "retry_teardown")).toHaveLength(1);

    // Not due 59 s later, due at +60: the supervisor retries again with a fresh budget (attempt 1).
    expect(await sweepAt(h, clock + 59)).toEqual([]);
    const events = await sweepAt(h, clock + 60);
    expect(events.filter((e) => e.kind === "retried")).toMatchObject([{ kind: "retried", attempt: 1 }]);
    expect(events.some((e) => e.kind === "stuck")).toBe(false);
  });

  it("marks an already exhausted lease stuck at the start of a sweep without retrying", async () => {
    const h = await setup("cleanup_incomplete");
    const store = h.ports.receipts(LEASE);
    for (let i = 0; i < 2; i += 1) {
      await appendReceiptEntry(
        store,
        {
          chain: "verified",
          type: "transition",
          payload: { from: "tearing_down", event: "teardown_incomplete", actor: "runtime", to: "cleanup_incomplete" },
        },
        T0 + i,
      );
    }
    const config: SupervisorConfig = { ...DEFAULT_SUPERVISOR_CONFIG, retryBaseSeconds: 60, retryMaxSeconds: 3600, retryCap: 1 };

    const events = await sweepAt(h, T0 + 100_000, config);

    expect(events).toEqual([{ kind: "stuck", leaseId: LEASE, reason: "retries_exhausted", attempts: 2, repeat: false }]);
    expect(h.hook.calls).toBe(0);
    expect((await verified(h)).filter((e) => e.type === "teardown_stuck")).toHaveLength(1);
    expect(await sweepAt(h, T0 + 200_000, config)).toEqual([]);
  });

  it("does nothing for a lease that was never retried before the first backoff", async () => {
    const h = await setup("cleanup_incomplete");
    // No landing in the chain: failedPasses is 0, so there is nothing to retry.
    expect(await sweepAt(h, T0 + 100_000)).toEqual([]);
    expect(await verified(h)).toEqual([]);
  });
});

describe("markStuck", () => {
  it("writes one receipt for the same payload and reports true then false", async () => {
    const h = await setup("cleanup_incomplete");
    const payload = { reason: "retries_exhausted", attempts: 9 } as const;

    expect(await markStuck(h.ports, LEASE, payload, T0)).toBe(true);
    expect(await markStuck(h.ports, LEASE, payload, T0 + 1)).toBe(false);

    const chain = await verified(h);
    expect(chain.filter((e) => e.type === "teardown_stuck")).toHaveLength(1);
    expect(chain.at(-1)?.payload).toEqual(payload);
    // A stuck marker is not a state change (D-01).
    const lease = await h.ports.leases.load(LEASE);
    expect(lease?.state).toBe("cleanup_incomplete");
  });

  it("writes a new receipt when the reason or the attempts differ", async () => {
    const h = await setup("cleanup_incomplete");
    expect(await markStuck(h.ports, LEASE, { reason: "retries_exhausted", attempts: 9 }, T0)).toBe(true);
    expect(await markStuck(h.ports, LEASE, { reason: "retries_exhausted", attempts: 10 }, T0)).toBe(true);
    expect(await markStuck(h.ports, LEASE, { reason: "revocation_failed", attempts: 10 }, T0)).toBe(true);
    expect((await verified(h)).filter((e) => e.type === "teardown_stuck")).toHaveLength(3);
  });
});
