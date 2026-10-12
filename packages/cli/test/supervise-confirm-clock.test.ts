/**
 * Phase 9 plan 11 (SUP-06, D-19, D-20): after a suspicious forward clock jump a
 * running `stint-cli supervise` stops settling lease expiry and says how to
 * resume it; `stint-cli supervise --confirm-clock`, run headless from another
 * process, confirms the clock and the next sweep resumes. Time arrives only
 * through the injected `clock`, `monotonicMs` and `sleep` seams, so no test waits.
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { seedFromCredentials } from "../src/custody.js";
import type { SuperviseSeams } from "../src/deps.js";
import { EXIT_CODES } from "../src/exit.js";
import { supervisorDir } from "../src/paths.js";
import { main } from "../src/program.js";
import { buildRuntimePorts } from "../src/runtime-ports.js";
import { createFileSupervisorControl } from "../src/store/supervisor-control.js";
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
  await seedFromCredentials(rig.deps, buildRuntimePorts(rig.deps, rig.root), rig.leaseId, rig.fx.credentials);
  rig.clearOutput();
  return { rig, expiresAt: lease.expiresAt };
}

const stdoutOf = (r: TeardownRig): string => r.fx.harness.stdout.join("");
const stderrOf = (r: TeardownRig): string => r.fx.harness.stderr.join("");

const pauseFile = (r: TeardownRig): string => path.join(supervisorDir(r.root), "clock-pause.json");
const confirmFile = (r: TeardownRig): string => path.join(supervisorDir(r.root), "clock-confirm.json");

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

const PAUSE_LINE = "The system clock jumped forward by 7170 seconds; lease expiry is paused.";
const FIX = "stint-cli supervise --confirm-clock";

interface Clocks {
  /** Wall time in epoch seconds and monotonic time in milliseconds, both under the test's control. */
  readonly t: { wall: number; mono: number };
}

interface LoopRun {
  readonly code: number;
  readonly sleeps: number;
}

/**
 * The long-running `supervise` with injected time. `onSleep(call)` runs inside each sleep, before the
 * next sweep, and is where a test moves the clocks or runs a second command.
 */
async function runLoop(
  r: TeardownRig,
  clocks: Clocks,
  abortOnSleep: number,
  onSleep: (call: number) => void | Promise<void>,
  flags: readonly string[] = [],
): Promise<LoopRun> {
  const controller = new AbortController();
  let sleeps = 0;
  const seams: SuperviseSeams = {
    shutdown: () => ({ signal: controller.signal, dispose: () => undefined }),
    sleep: async () => {
      sleeps += 1;
      await onSleep(sleeps);
      if (sleeps >= abortOnSleep) controller.abort();
    },
    monotonicMs: () => clocks.t.mono,
    lockStaleMs: 5000,
    lockAcquireWindowMs: 300,
  };
  const argv = [
    "--store",
    r.root,
    ...flags.filter((f) => f === "--json"),
    "supervise",
    "--probe-interval",
    "0",
    ...flags.filter((f) => f !== "--json"),
  ];
  const code = await main(argv, r.withDeps({ clock: () => clocks.t.wall, supervise: seams }));
  return { code, sleeps };
}

/** `--once` with a fixed clock. */
function once(r: TeardownRig, wall: number, flags: readonly string[] = []): Promise<number> {
  return main(
    ["--store", r.root, ...flags.filter((f) => f === "--json"), "supervise", "--once", "--probe-interval", "0", ...flags.filter((f) => f !== "--json")],
    r.withDeps({ clock: () => wall }),
  );
}

function confirmClock(r: TeardownRig, wall: number, flags: readonly string[] = []): Promise<number> {
  return main(["--store", r.root, ...flags, "supervise", "--confirm-clock"], r.withDeps({ clock: () => wall }));
}

describe("a forward clock jump pauses expiry and --confirm-clock resumes it (SUP-06, D-19)", () => {
  it("prints one pause line with the jump and the fix, settles nothing, then resumes after a headless confirmation", async () => {
    const { rig: r, expiresAt } = await setup();
    const clocks: Clocks = { t: { wall: expiresAt - 100, mono: 0 } };
    let stderrAtFirstSleep: string | undefined;
    let stderrAtSecondSleep = "";
    let confirmCode: number | undefined;
    let pauseExistedAtSecondSleep = false;
    let leaseAtSecondSleep: string | undefined;

    const { code } = await runLoop(r, clocks, 3, async (call) => {
      if (call === 1) {
        stderrAtFirstSleep = stderrOf(r);
        // 7200 s of wall time but only 30 s of monotonic time: the system clock was set forward.
        clocks.t.wall += 7200;
        clocks.t.mono += 30_000;
      }
      if (call === 2) {
        stderrAtSecondSleep = stderrOf(r);
        pauseExistedAtSecondSleep = await exists(pauseFile(r));
        leaseAtSecondSleep = (await r.lease()).state;
        // From "another terminal": no lock, no prompt, nothing but the store.
        confirmCode = await confirmClock(r, clocks.t.wall);
        clocks.t.wall += 30;
        clocks.t.mono += 30_000;
      }
    });

    expect(code).toBe(EXIT_CODES.ok);
    expect(stderrAtFirstSleep).toBe("");
    // The pause line appears exactly once, with the jump in seconds and the fix command.
    expect(stderrAtSecondSleep).toContain(`stint: ${PAUSE_LINE}`);
    expect(stderrAtSecondSleep).toContain(FIX);
    expect(stderrAtSecondSleep.match(/lease expiry is paused/g)).toHaveLength(1);
    expect(pauseExistedAtSecondSleep).toBe(true);
    expect(leaseAtSecondSleep).toBe("active");

    expect(confirmCode).toBe(EXIT_CODES.ok);
    const stderr = stderrOf(r);
    expect(stderr).toContain("stint: Clock confirmed. The supervisor resumes lease expiry on its next sweep.");
    expect(stderr).toContain("stint: Clock confirmed; lease expiry resumed.");
    expect(stderr.match(/lease expiry is paused/g)).toHaveLength(1);
    expect(stderr).toContain(`stint: Lease ${r.leaseId} expired and was settled.`);

    expect(await exists(pauseFile(r))).toBe(false);
    expect(await exists(confirmFile(r))).toBe(false);
    expect((await r.lease()).state).toBe("cleaned_up");
    expect(stdoutOf(r)).toBe("");
  });

  it("never settles while the operator stays silent, however many sweeps pass", async () => {
    const { rig: r, expiresAt } = await setup();
    const clocks: Clocks = { t: { wall: expiresAt - 100, mono: 0 } };
    const transitionsBefore = (await r.entries("transition")).length;

    const { code } = await runLoop(r, clocks, 5, (call) => {
      if (call === 1) clocks.t.wall += 7200;
      else clocks.t.wall += 30;
      clocks.t.mono += 30_000;
    });

    expect(code).toBe(EXIT_CODES.ok);
    expect((await r.lease()).state).toBe("active");
    // No expire, teardown or other transition receipt was appended.
    expect(await r.entries("transition")).toHaveLength(transitionsBefore);
    expect(stderrOf(r).match(/lease expiry is paused/g)).toHaveLength(1);
    expect(await exists(pauseFile(r))).toBe(true);
  });

  it("--clock-jump-threshold lowers the line: a 100 s jump pauses with 60 and not with the default", async () => {
    const jump = async (flags: readonly string[]): Promise<string> => {
      const { rig: r, expiresAt } = await setup();
      const clocks: Clocks = { t: { wall: expiresAt - 1000, mono: 0 } };
      await runLoop(
        r,
        clocks,
        2,
        (call) => {
          if (call === 1) {
            clocks.t.wall += 130;
            clocks.t.mono += 30_000;
          }
        },
        flags,
      );
      const out = stderrOf(r);
      await r.fx.harness.cleanup();
      rig = undefined;
      return out;
    };

    expect(await jump(["--clock-jump-threshold", "60"])).toContain("The system clock jumped forward by 100 seconds");
    expect(await jump([])).not.toContain("jumped forward");
  });

  it("--json prints the clock events as objects on stdout and no human line", async () => {
    const { rig: r, expiresAt } = await setup();
    const clocks: Clocks = { t: { wall: expiresAt - 100, mono: 0 } };

    const { code } = await runLoop(
      r,
      clocks,
      3,
      async (call) => {
        if (call === 1) {
          clocks.t.wall += 7200;
          clocks.t.mono += 30_000;
        }
        if (call === 2) {
          const control = createFileSupervisorControl(r.root);
          const pause = await control.readPause();
          if (pause === undefined) throw new Error("expected a pause");
          await control.writeConfirm({ v: 1, id: pause.id });
        }
      },
      ["--json"],
    );

    expect(code).toBe(EXIT_CODES.ok);
    const lines = stdoutOf(r)
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines[0]).toEqual({ event: "clock_paused", jumpSeconds: 7170, repeat: false });
    expect(lines[1]).toEqual({ event: "clock_confirmed" });
    expect(lines.map((l) => l.event)).toEqual(["clock_paused", "clock_confirmed", "expired", "torn_down"]);
    expect(stderrOf(r)).toBe("");
  });

  it("a confirmation for another pause is ignored by the running supervisor", async () => {
    const { rig: r, expiresAt } = await setup();
    const clocks: Clocks = { t: { wall: expiresAt - 100, mono: 0 } };

    await runLoop(r, clocks, 4, async (call) => {
      if (call === 1) {
        clocks.t.wall += 7200;
        clocks.t.mono += 30_000;
      }
      if (call === 2) {
        await createFileSupervisorControl(r.root).writeConfirm({ v: 1, id: "not-this-pause" });
      }
      clocks.t.mono += 30_000;
      clocks.t.wall += 30;
    });

    expect((await r.lease()).state).toBe("active");
    expect(await exists(pauseFile(r))).toBe(true);
    expect(stderrOf(r)).not.toContain("Clock confirmed");
  });
});

describe("--confirm-clock (D-19)", () => {
  it("with no pause prints the no-pause line, exits 0 and writes nothing", async () => {
    const { rig: r, expiresAt } = await setup();

    const code = await confirmClock(r, expiresAt - 1);

    expect(code).toBe(EXIT_CODES.ok);
    expect(stderrOf(r)).toBe("stint: No clock pause is active.\n");
    expect(stdoutOf(r)).toBe("");
    expect(await exists(confirmFile(r))).toBe(false);
    expect(await exists(pauseFile(r))).toBe(false);
  });

  it("writes a confirmation bound to the current pause id", async () => {
    const { rig: r, expiresAt } = await setup();
    await createFileSupervisorControl(r.root).writePause({ v: 1, id: "pause-abc", detectedAt: expiresAt, jumpSeconds: 5000 });

    const code = await confirmClock(r, expiresAt);

    expect(code).toBe(EXIT_CODES.ok);
    expect(JSON.parse(await readFile(confirmFile(r), "utf8")) as unknown).toEqual({ v: 1, id: "pause-abc" });
    // The pause itself is the supervisor's to clear.
    expect(await exists(pauseFile(r))).toBe(true);
  });

  it("together with --once exits 2 and writes nothing", async () => {
    const { rig: r, expiresAt } = await setup();
    await createFileSupervisorControl(r.root).writePause({ v: 1, id: "pause-abc", detectedAt: expiresAt, jumpSeconds: 5000 });

    const code = await main(
      ["--store", r.root, "supervise", "--once", "--confirm-clock"],
      r.withDeps({ clock: () => expiresAt }),
    );

    expect(code).toBe(EXIT_CODES.usage);
    expect(stderrOf(r)).toContain("--confirm-clock cannot be used with --once.");
    expect(await exists(confirmFile(r))).toBe(false);
  });

  it("under --json prints one object and no human line", async () => {
    const { rig: r, expiresAt } = await setup();

    expect(await confirmClock(r, expiresAt, ["--json"])).toBe(EXIT_CODES.ok);
    expect(JSON.parse(stdoutOf(r)) as unknown).toEqual({ event: "no_clock_pause" });
    expect(stderrOf(r)).toBe("");
  });

  it("takes no store lock: it works while another supervisor holds it", async () => {
    const { rig: r, expiresAt } = await setup();
    await createFileSupervisorControl(r.root).writePause({ v: 1, id: "pause-abc", detectedAt: expiresAt, jumpSeconds: 5000 });
    const clocks: Clocks = { t: { wall: expiresAt - 100, mono: 0 } };
    let confirmCode: number | undefined;

    await runLoop(r, clocks, 1, async () => {
      confirmCode = await confirmClock(r, clocks.t.wall);
    });

    expect(confirmCode).toBe(EXIT_CODES.ok);
  });
});

describe("a pause that outlives its supervisor (D-19)", () => {
  it("supervise --once with a pause on disk settles nothing, prints the pause line once and exits 0", async () => {
    const { rig: r, expiresAt } = await setup();
    await createFileSupervisorControl(r.root).writePause({ v: 1, id: "pause-abc", detectedAt: expiresAt, jumpSeconds: 7170 });

    const code = await once(r, expiresAt + 1);

    expect(code).toBe(EXIT_CODES.ok);
    expect((await r.lease()).state).toBe("active");
    const stderr = stderrOf(r);
    expect(stderr).toContain(`stint: ${PAUSE_LINE}`);
    expect(stderr).toContain(FIX);
    expect(stderr.match(/lease expiry is paused/g)).toHaveLength(1);
  });

  it("a confirmed pause lets the next --once settle the lease and clears both markers", async () => {
    const { rig: r, expiresAt } = await setup();
    const control = createFileSupervisorControl(r.root);
    await control.writePause({ v: 1, id: "pause-abc", detectedAt: expiresAt, jumpSeconds: 7170 });
    expect(await confirmClock(r, expiresAt + 1)).toBe(EXIT_CODES.ok);
    r.clearOutput();

    const code = await once(r, expiresAt + 1);

    expect(code).toBe(EXIT_CODES.ok);
    expect(stderrOf(r)).toContain("stint: Clock confirmed; lease expiry resumed.");
    expect((await r.lease()).state).toBe("cleaned_up");
    expect(await exists(pauseFile(r))).toBe(false);
    expect(await exists(confirmFile(r))).toBe(false);
  });
});

describe("a pause marker that cannot be read fails closed (T-09-49)", () => {
  const BROKEN = "{ this is not json";

  it("supervise --once settles nothing, names the fix and exits 10", async () => {
    const { rig: r, expiresAt } = await setup();
    await mkdir(supervisorDir(r.root), { recursive: true });
    await writeFile(pauseFile(r), BROKEN);

    const code = await once(r, expiresAt + 1);

    expect(code).toBe(EXIT_CODES.storeCorrupt);
    expect((await r.lease()).state).toBe("active");
    expect(stderrOf(r)).toContain("lease expiry stays paused");
    expect(stderrOf(r)).toContain("remove supervisor/clock-pause.json");
    expect(await readFile(pauseFile(r), "utf8")).toBe(BROKEN);
  });

  it("--confirm-clock exits 10 and leaves the file byte-identical", async () => {
    const { rig: r, expiresAt } = await setup();
    await mkdir(supervisorDir(r.root), { recursive: true });
    await writeFile(pauseFile(r), BROKEN);

    const code = await confirmClock(r, expiresAt);

    expect(code).toBe(EXIT_CODES.storeCorrupt);
    expect(await readFile(pauseFile(r), "utf8")).toBe(BROKEN);
    expect(await exists(confirmFile(r))).toBe(false);
  });

  it("a well-formed JSON file of the wrong shape is just as unreadable", async () => {
    const { rig: r, expiresAt } = await setup();
    await mkdir(supervisorDir(r.root), { recursive: true });
    await writeFile(pauseFile(r), JSON.stringify({ v: 2, id: "x", detectedAt: 1, jumpSeconds: 1 }));

    expect(await confirmClock(r, expiresAt)).toBe(EXIT_CODES.storeCorrupt);
    expect(await once(r, expiresAt + 1)).toBe(EXIT_CODES.storeCorrupt);
    expect((await r.lease()).state).toBe("active");
  });
});

describe("--clock-jump-threshold validation (T-09-47)", () => {
  it.each(["0", "1.5", "2147484", "abc", "-1"])("rejects %s with exit 2 before any store access", async (value) => {
    const { rig: r, expiresAt } = await setup();

    const code = await once(r, expiresAt - 1, ["--clock-jump-threshold", value]);

    expect(code).toBe(EXIT_CODES.usage);
    expect(stderrOf(r)).toContain("--clock-jump-threshold must be a whole number of seconds from 1 to 2147483.");
    expect(await exists(supervisorDir(r.root))).toBe(false);
  });

  it.each(["1", "3600", "2147483"])("accepts %s", async (value) => {
    const { rig: r, expiresAt } = await setup();

    expect(await once(r, expiresAt - 1, ["--clock-jump-threshold", value])).toBe(EXIT_CODES.ok);
  });
});
