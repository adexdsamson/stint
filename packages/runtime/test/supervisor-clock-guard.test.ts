/**
 * Phase 9 plan 11 (SUP-06, D-19): a suspicious forward jump of the wall clock
 * pauses lease expiry, and only a confirmation bound to that pause resumes it.
 * Everything else the supervisor does (retries, the teardown of ended leases)
 * carries on while expiry is paused.
 */

import type { Telemetry, TelemetryEvent } from "@stint/core";
import { makeTestLease } from "@stint/core/testing";
import type { TeardownStep } from "@stint/proxy";
import type { ReceiptEntry } from "@stint/spec";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_SUPERVISOR_CONFIG,
  createInMemorySupervisorControl,
  createSweepState,
  forwardJumpSeconds,
  parseClockConfirm,
  parseClockPause,
  runSweep,
  seedLeaseCredentials,
} from "../src/index.js";
import type { ClockPause, RuntimePorts, SupervisorControl, SweepEvent, SweepState } from "../src/index.js";
import { buildRig, delegatedManifest, oauthCredential } from "./helpers.js";

const T0 = 5000;
const EXPIRING = "lease-expiring";
const RETRIED = "lease-retried";
const ENDED = "lease-ended";
/** The lease that expires at EXPIRES_AT; the retried lease has a hook that fails once. */
const EXPIRES_AT = 6000;
const CONFIG = { ...DEFAULT_SUPERVISOR_CONFIG, probeIntervalSeconds: 0 };

interface Harness {
  readonly ports: RuntimePorts;
  readonly now: { value: number; mono: number };
  readonly telemetry: TelemetryEvent[];
  readonly control: SupervisorControl;
  readonly state: SweepState;
  readonly ids: string[];
  readonly hook: { failures: number };
  readonly writes: { pauses: number };
}

async function setup(): Promise<Harness> {
  const rig = await buildRig(EXPIRING, delegatedManifest(["sheets.orders"]));
  const envelope = await rig.ports.artifacts.get(EXPIRING, "envelope");
  const now = { value: T0, mono: 0 };
  const telemetry: TelemetryEvent[] = [];
  const sink: Telemetry = {
    emit: (event) => {
      telemetry.push(event);
    },
  };
  const ports: RuntimePorts = { ...rig.ports, clock: () => now.value, telemetry: sink };
  await ports.leases.save(makeTestLease(EXPIRING, { state: "active", expiresAt: EXPIRES_AT }));
  const base = createInMemorySupervisorControl();
  const writes = { pauses: 0 };
  const control: SupervisorControl = {
    ...base,
    writePause: (pause) => {
      writes.pauses += 1;
      return base.writePause(pause);
    },
  };
  const h: Harness = {
    ports,
    now,
    telemetry,
    control,
    state: createSweepState(),
    ids: [],
    hook: { failures: 0 },
    writes,
  };
  await addLease(h, EXPIRING, envelope, undefined);
  return h;
}

/** Stores the envelope and credentials for a lease so a teardown can run. `state` undefined leaves the lease as saved. */
async function addLease(h: Harness, id: string, envelope: unknown, state: "expired" | undefined): Promise<void> {
  if (state !== undefined) await h.ports.leases.save(makeTestLease(id, { state, expiresAt: EXPIRES_AT }));
  if (id !== EXPIRING) await h.ports.artifacts.put(id, "envelope", envelope);
  await seedLeaseCredentials(h.ports, id, {
    "sheets.orders": oauthCredential("https://as.example.test/token", undefined),
  });
}

/** Wraps the cleanup hook so it fails `h.hook.failures` times for the retried lease only. */
function decorate(h: Harness): (steps: readonly TeardownStep[]) => readonly TeardownStep[] {
  return (steps) =>
    steps.map(
      (step): TeardownStep => ({
        name: step.name,
        run: (lease, at) => {
          if (step.name === "cleanup_hook" && lease.id === RETRIED && h.hook.failures > 0) {
            h.hook.failures -= 1;
            return Promise.resolve("failed");
          }
          return step.run(lease, at);
        },
      }),
    );
}

interface SweepOverrides {
  readonly state?: SweepState;
  readonly control?: SupervisorControl | undefined;
  readonly withMono?: boolean;
  readonly threshold?: number;
}

/** One sweep at wall time `wall` and monotonic time `mono` (ms). */
async function sweepAt(h: Harness, wall: number, mono: number, overrides: SweepOverrides = {}): Promise<SweepEvent[]> {
  h.now.value = wall;
  h.now.mono = mono;
  const events: SweepEvent[] = [];
  await runSweep(h.ports, {
    config: overrides.threshold === undefined ? CONFIG : { ...CONFIG, clockJumpThresholdSeconds: overrides.threshold },
    state: overrides.state ?? h.state,
    decorateSteps: decorate(h),
    control: "control" in overrides ? overrides.control : h.control,
    ...(overrides.withMono === false ? {} : { monotonicMs: () => h.now.mono }),
    randomId: () => {
      const id = `pause-${String(h.ids.length + 1)}`;
      h.ids.push(id);
      return id;
    },
    onEvent: (event) => {
      events.push(event);
    },
  });
  return events;
}

async function verified(h: Harness, id: string): Promise<readonly ReceiptEntry[]> {
  return h.ports.receipts(id).load("verified");
}

async function stateOf(h: Harness, id: string): Promise<string | undefined> {
  return (await h.ports.leases.load(id))?.state;
}

function expireTransitions(chain: readonly ReceiptEntry[]): number {
  return chain.filter(
    (entry) => entry.type === "transition" && (entry.payload as { event: string }).event === "expire",
  ).length;
}

/**
 * Sweep 1 (baseline) then sweep 2 after a 7200 s wall jump with 30 s of monotonic time: the first
 * sweep also lands the retried lease cleanup_incomplete, the second finds an ended lease to tear down.
 */
async function pausedScenario(): Promise<{ readonly h: Harness; readonly second: SweepEvent[] }> {
  const h = await setup();
  const envelope = await h.ports.artifacts.get(EXPIRING, "envelope");
  await addLease(h, RETRIED, envelope, "expired");
  h.hook.failures = 1;
  const first = await sweepAt(h, T0, 0);
  expect(first.map((e) => e.kind)).toEqual(["torn_down"]);
  expect(await stateOf(h, RETRIED)).toBe("cleanup_incomplete");
  await addLease(h, ENDED, envelope, "expired");
  const second = await sweepAt(h, T0 + 7200, 30_000);
  return { h, second };
}

describe("forwardJumpSeconds (SUP-06)", () => {
  it("is the wall advance minus the monotonic advance", () => {
    expect(forwardJumpSeconds({ wall: 1000, monoMs: 0 }, { wall: 8200, monoMs: 30_000 })).toBe(7170);
  });

  it("is zero when both clocks advance together and negative when the wall clock goes back", () => {
    expect(forwardJumpSeconds({ wall: 1000, monoMs: 0 }, { wall: 1030, monoMs: 30_000 })).toBe(0);
    expect(forwardJumpSeconds({ wall: 1000, monoMs: 0 }, { wall: 900, monoMs: 30_000 })).toBe(-130);
  });
});

describe("the marker parsers are strict", () => {
  it("accept exactly the version 1 shapes", () => {
    expect(parseClockPause({ v: 1, id: "abc", detectedAt: 10, jumpSeconds: 7170 })).toEqual({
      v: 1,
      id: "abc",
      detectedAt: 10,
      jumpSeconds: 7170,
    });
    expect(parseClockConfirm({ v: 1, id: "abc" })).toEqual({ v: 1, id: "abc" });
  });

  it("reject a wrong version, a bad id or a bad number", () => {
    const good = { v: 1, id: "abc", detectedAt: 10, jumpSeconds: 5 };
    for (const bad of [
      null,
      "text",
      [],
      { ...good, v: 2 },
      { ...good, id: "" },
      { ...good, id: "x".repeat(129) },
      { ...good, id: 7 },
      { ...good, detectedAt: -1 },
      { ...good, detectedAt: 1.5 },
      { ...good, jumpSeconds: -1 },
      { ...good, jumpSeconds: Number.NaN },
      { ...good, jumpSeconds: "5" },
    ]) {
      expect(parseClockPause(bad), JSON.stringify(bad)).toBeUndefined();
    }
    expect(parseClockPause({ ...good, id: "x".repeat(128) })?.id).toHaveLength(128);
    for (const bad of [null, 5, { v: 2, id: "a" }, { v: 1, id: "" }, { v: 1, id: "x".repeat(129) }, { v: 1 }]) {
      expect(parseClockConfirm(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });
});

describe("a suspicious forward clock jump pauses expiry (SUP-06, D-19)", () => {
  it("writes the pause, announces it once and leaves the past-expiry lease active with no expire receipt", async () => {
    const { h, second } = await pausedScenario();

    expect(second.filter((e) => e.kind === "clock_paused")).toEqual([
      { kind: "clock_paused", jumpSeconds: 7170, repeat: false },
    ]);
    expect(await h.control.readPause()).toEqual({ v: 1, id: "pause-1", detectedAt: T0 + 7200, jumpSeconds: 7170 });
    expect(await stateOf(h, EXPIRING)).toBe("active");
    expect(expireTransitions(await verified(h, EXPIRING))).toBe(0);
    expect(second.some((e) => e.kind === "expired")).toBe(false);
    expect(h.telemetry.filter((t) => t.name === "supervisor.clock_paused")).toEqual([
      { name: "supervisor.clock_paused", jumpSeconds: 7170 },
    ]);
    expect(h.telemetry.filter((t) => t.name === "supervisor.expiry_paused")).toEqual([
      { name: "supervisor.expiry_paused", leaseId: EXPIRING },
    ]);
  });

  it("still retries a due cleanup_incomplete lease and tears an ended lease down in the paused sweep", async () => {
    const { h, second } = await pausedScenario();

    const retried = second.filter((e) => e.kind === "retried");
    expect(retried).toHaveLength(1);
    expect(retried[0]).toMatchObject({ kind: "retried", leaseId: RETRIED });
    expect(await stateOf(h, RETRIED)).toBe("cleaned_up");
    expect(second.filter((e) => e.kind === "torn_down")).toMatchObject([{ kind: "torn_down", leaseId: ENDED }]);
    expect(await stateOf(h, ENDED)).toBe("cleaned_up");
  });

  it("does not pause for a jump of exactly the threshold, pauses for one second more and never for 30 minutes", async () => {
    for (const [extra, paused] of [
      [3600, false],
      [3601, true],
      [1800, false],
    ] as const) {
      const h = await setup();
      await sweepAt(h, T0, 0);
      // 30 s of monotonic time and 30 s plus `extra` of wall time: the jump is exactly `extra`.
      const events = await sweepAt(h, T0 + 30 + extra, 30_000);
      expect(events.some((e) => e.kind === "clock_paused"), `jump ${String(extra)}`).toBe(paused);
      expect(await h.control.readPause() !== undefined).toBe(paused);
      expect(await stateOf(h, EXPIRING)).toBe(paused ? "active" : "cleaned_up");
    }
  });

  it("honours a lower threshold given in the config", async () => {
    const h = await setup();
    await sweepAt(h, T0, 0, { threshold: 60 });
    const events = await sweepAt(h, T0 + 30 + 61, 30_000, { threshold: 60 });
    expect(events.filter((e) => e.kind === "clock_paused")).toHaveLength(1);
  });

  it("emits nothing new in later sweeps, keeps the baseline and keeps the first pause id on a second jump", async () => {
    const { h } = await pausedScenario();
    const baseline = h.state.clock.baseline;
    expect(baseline).toEqual({ wall: T0, monoMs: 0 });

    expect(await sweepAt(h, T0 + 7230, 60_000)).toEqual([]);
    // A second, larger jump while paused.
    expect(await sweepAt(h, T0 + 99_999, 90_000)).toEqual([]);

    expect(h.state.clock.baseline).toBe(baseline);
    expect(h.ids).toEqual(["pause-1"]);
    expect(h.writes.pauses).toBe(1);
    expect((await h.control.readPause())?.id).toBe("pause-1");
    expect(await stateOf(h, EXPIRING)).toBe("active");
  });
});

describe("an id-bound confirmation resumes expiry (D-19, T-09-48)", () => {
  it("ignores a confirmation for another pause id", async () => {
    const { h } = await pausedScenario();
    await h.control.writeConfirm({ v: 1, id: "some-other-pause" });

    const events = await sweepAt(h, T0 + 7230, 60_000);

    expect(events).toEqual([]);
    expect(await h.control.readPause()).toBeDefined();
    expect(await stateOf(h, EXPIRING)).toBe("active");
  });

  it("ignores a confirmation written before the pause existed", async () => {
    const h = await setup();
    await sweepAt(h, T0, 0);
    // Even a confirmation that already carries the id the next pause will get is cleared, not honoured.
    await h.control.writeConfirm({ v: 1, id: "pause-1" });

    const events = await sweepAt(h, T0 + 7200, 30_000);

    expect(events.map((e) => e.kind)).toEqual(["clock_paused"]);
    expect(await h.control.readConfirm()).toBeUndefined();
    expect(await h.control.readPause()).toBeDefined();
    expect(await stateOf(h, EXPIRING)).toBe("active");

    const later = await sweepAt(h, T0 + 7230, 60_000);
    expect(later).toEqual([]);
    expect(await stateOf(h, EXPIRING)).toBe("active");
  });

  it("with the matching id clears both markers, re-baselines and settles and tears down the lease in the same sweep", async () => {
    const { h } = await pausedScenario();
    await h.control.writeConfirm({ v: 1, id: "pause-1" });

    const events = await sweepAt(h, T0 + 7230, 60_000);

    expect(events.map((e) => e.kind)).toEqual(["clock_confirmed", "expired", "torn_down"]);
    expect(await h.control.readPause()).toBeUndefined();
    expect(await h.control.readConfirm()).toBeUndefined();
    expect(h.state.clock.baseline).toEqual({ wall: T0 + 7230, monoMs: 60_000 });
    expect(await stateOf(h, EXPIRING)).toBe("cleaned_up");
    expect(expireTransitions(await verified(h, EXPIRING))).toBe(1);
  });

  it("lets a later jump make a new pause with a new id and announce it again", async () => {
    const { h } = await pausedScenario();
    await h.control.writeConfirm({ v: 1, id: "pause-1" });
    await sweepAt(h, T0 + 7230, 60_000);

    const events = await sweepAt(h, T0 + 20_000, 90_000);

    expect(events.filter((e) => e.kind === "clock_paused")).toEqual([
      { kind: "clock_paused", jumpSeconds: Math.floor(20_000 - 7230 - 30), repeat: false },
    ]);
    expect((await h.control.readPause())?.id).toBe("pause-2");
  });

  it("a confirmation that arrives in a sweep with a large wall advance confirms the old pause and re-baselines at once", async () => {
    const { h } = await pausedScenario();
    await h.control.writeConfirm({ v: 1, id: "pause-1" });
    // The same sweep sees the old pause and its confirmation: the confirmation wins and re-baselines at once.
    const events = await sweepAt(h, T0 + 50_000, 60_000);
    expect(events[0]).toEqual({ kind: "clock_confirmed" });
    expect(await h.control.readPause()).toBeUndefined();
    expect(h.state.clock.baseline).toEqual({ wall: T0 + 50_000, monoMs: 60_000 });
  });
});

describe("a pause outlives the process that wrote it (D-19)", () => {
  it("a fresh state skips settling, announces once with repeat true and writes no new marker", async () => {
    const { h } = await pausedScenario();
    const fresh = createSweepState();

    const events = await sweepAt(h, T0 + 7260, 120_000, { state: fresh });
    const again = await sweepAt(h, T0 + 7290, 150_000, { state: fresh });

    expect(events.filter((e) => e.kind === "clock_paused")).toEqual([
      { kind: "clock_paused", jumpSeconds: 7170, repeat: true },
    ]);
    expect(again).toEqual([]);
    expect(h.writes.pauses).toBe(1);
    expect(await stateOf(h, EXPIRING)).toBe("active");
    expect(fresh.clock.baseline).toBeUndefined();
  });

  it("with no monotonic clock never detects a jump but still honours a persisted pause", async () => {
    const h = await setup();
    await sweepAt(h, T0, 0, { withMono: false });
    const events = await sweepAt(h, T0 + 100_000, 0, { withMono: false });
    expect(events.map((e) => e.kind)).toEqual(["expired", "torn_down"]);
    expect(await h.control.readPause()).toBeUndefined();

    const h2 = await setup();
    const pause: ClockPause = { v: 1, id: "persisted", detectedAt: T0, jumpSeconds: 9000 };
    await h2.control.writePause(pause);
    const paused = await sweepAt(h2, T0 + 100_000, 0, { withMono: false });
    expect(paused).toEqual([{ kind: "clock_paused", jumpSeconds: 9000, repeat: true }]);
    expect(await stateOf(h2, EXPIRING)).toBe("active");
  });

  it("never pauses without a control", async () => {
    const h = await setup();
    await sweepAt(h, T0, 0, { control: undefined });
    const events = await sweepAt(h, T0 + 100_000, 30_000, { control: undefined });
    expect(events.map((e) => e.kind)).toEqual(["expired", "torn_down"]);
  });
});

describe("a pause that cannot be read fails closed (T-09-49)", () => {
  it("settles nothing, says so once and keeps going once the marker reads again", async () => {
    const h = await setup();
    let broken = true;
    const control: SupervisorControl = {
      ...h.control,
      readPause: () => (broken ? Promise.reject(new Error("unreadable")) : h.control.readPause()),
    };

    const first = await sweepAt(h, T0 + 100_000, 0, { control });
    const second = await sweepAt(h, T0 + 100_030, 30_000, { control });

    expect(first).toEqual([{ kind: "clock_marker_unreadable" }]);
    expect(second).toEqual([]);
    expect(await stateOf(h, EXPIRING)).toBe("active");
    expect(expireTransitions(await verified(h, EXPIRING))).toBe(0);

    broken = false;
    const recovered = await sweepAt(h, T0 + 100_060, 60_000, { control });
    expect(recovered.map((e) => e.kind)).toEqual(["expired", "torn_down"]);
  });

  it("leaves expiry paused for the sweep when the pause cannot be written, and tries again next sweep", async () => {
    const h = await setup();
    let failing = true;
    const control: SupervisorControl = {
      ...h.control,
      writePause: (pause) => (failing ? Promise.reject(new Error("disk full")) : h.control.writePause(pause)),
    };
    await sweepAt(h, T0, 0, { control });

    const first = await sweepAt(h, T0 + 7200, 30_000, { control });
    expect(first).toEqual([]);
    expect(await stateOf(h, EXPIRING)).toBe("active");

    failing = false;
    const second = await sweepAt(h, T0 + 7230, 60_000, { control });
    expect(second.map((e) => e.kind)).toEqual(["clock_paused"]);
    expect(await h.control.readPause()).toBeDefined();
    expect(await stateOf(h, EXPIRING)).toBe("active");
  });

  it("keeps expiry paused when the pause cannot be cleared after a matching confirmation", async () => {
    const { h } = await pausedScenario();
    await h.control.writeConfirm({ v: 1, id: "pause-1" });
    const control: SupervisorControl = { ...h.control, clearPause: () => Promise.reject(new Error("locked")) };

    const events = await sweepAt(h, T0 + 7230, 60_000, { control });

    expect(events).toEqual([]);
    expect(await stateOf(h, EXPIRING)).toBe("active");
    expect(await h.control.readConfirm()).toEqual({ v: 1, id: "pause-1" });
  });
});
