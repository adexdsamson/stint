/**
 * Phase 9 plan 10 (SUP-07, D-20, D-21, D-22): `stint-cli supervise` without
 * `--once` is a long-running process over the REAL JSON stores. The loop sweeps,
 * sleeps one bounded interval and repeats until told to stop; a stop request lets
 * the pass in flight finish its step, releases the fence and the store lock and
 * exits 0; a lost lock stops the loop with exit 8. Time and signals arrive only
 * through the injected `deps.supervise` seams, so no test waits a real interval.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { TeardownStep } from "@stint/proxy";
import { afterEach, describe, expect, it } from "vitest";

import { seedFromCredentials } from "../src/custody.js";
import type { CliDeps, SuperviseSeams } from "../src/deps.js";
import { EXIT_CODES } from "../src/exit.js";
import { leaseDir, supervisorDir } from "../src/paths.js";
import { main } from "../src/program.js";
import { createSuperviseShutdown } from "../src/real-deps.js";
import type { ShutdownProcess } from "../src/real-deps.js";
import { buildRuntimePorts } from "../src/runtime-ports.js";
import { acquireSupervisorLock } from "../src/store/supervisor-lock.js";
import { abortableSleep } from "../src/supervise-timing.js";
import { createHarness } from "./helpers/cli-harness.js";
import { createTeardownRig, stepRecorder } from "./helpers/teardown-rig.js";
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

interface Loop {
  /** The `deps.supervise` seams to inject. */
  readonly seams: SuperviseSeams;
  /** The `ms` every sleep call received. */
  readonly sleeps: number[];
  readonly controller: AbortController;
  readonly stats: { shutdownCalls: number; disposed: number };
}

interface LoopOptions {
  /** Abort the stop signal on this (1-based) sleep call; never when absent. */
  readonly abortOnSleep?: number;
  /** Runs inside each sleep call, with its 1-based number, before any abort. */
  readonly onSleep?: (call: number) => void | Promise<void>;
  /** Start with the stop signal already aborted. */
  readonly abortedAtStart?: boolean;
  /** Replaces the sleep with a real, abortable wait of this many milliseconds. */
  readonly realSleepMs?: number;
  readonly lockStaleMs?: number;
}

function loopSeams(options: LoopOptions = {}): Loop {
  const controller = new AbortController();
  if (options.abortedAtStart === true) controller.abort();
  const sleeps: number[] = [];
  const stats = { shutdownCalls: 0, disposed: 0 };
  const seams: SuperviseSeams = {
    shutdown: () => {
      stats.shutdownCalls += 1;
      return {
        signal: controller.signal,
        dispose: () => {
          stats.disposed += 1;
        },
      };
    },
    sleep: async (ms, signal) => {
      sleeps.push(ms);
      await options.onSleep?.(sleeps.length);
      if (options.abortOnSleep !== undefined && sleeps.length >= options.abortOnSleep) controller.abort();
      if (options.realSleepMs !== undefined) await abortableSleep(options.realSleepMs, signal);
    },
    lockStaleMs: options.lockStaleMs ?? 5000,
    lockAcquireWindowMs: 300,
  };
  return { seams, sleeps, controller, stats };
}

/** `supervise` with no `--once`; `--probe-interval 0` keeps the idle lease from probing a provider. */
function supervise(
  r: TeardownRig,
  clock: () => number,
  loop: Loop,
  flags: readonly string[] = [],
  overrides: Partial<CliDeps> = {},
): Promise<number> {
  return main(
    ["--store", r.root, ...flags.filter((f) => f === "--json"), "supervise", "--probe-interval", "0", ...flags.filter((f) => f !== "--json")],
    r.withDeps({ clock, supervise: loop.seams, ...overrides }),
  );
}

/** A second supervisor can take the store lock again, so the loop released it. */
async function lockIsFree(r: TeardownRig): Promise<boolean> {
  try {
    const lock = await acquireSupervisorLock(r.root, { staleMs: 5000, acquireWindowMs: 300 });
    await lock.release();
    return true;
  } catch {
    return false;
  }
}

describe("the long-running loop (SUP-07, D-21, D-22)", () => {
  it("sweeps, sleeps 30000 ms each time, prints nothing for idle sweeps, releases the lock and exits 0", async () => {
    const { rig: r, expiresAt } = await setup();
    const loop = loopSeams({ abortOnSleep: 3 });

    const code = await supervise(r, () => expiresAt - 1, loop);

    expect(code).toBe(EXIT_CODES.ok);
    expect(loop.sleeps).toEqual([30_000, 30_000, 30_000]);
    expect(stdoutOf(r)).toBe("");
    expect(stderrOf(r)).toBe("");
    expect((await r.lease()).state).toBe("active");
    expect(loop.stats).toEqual({ shutdownCalls: 1, disposed: 1 });
    expect(await lockIsFree(r)).toBe(true);
  });

  it("an expired lease that appears before the second sweep is torn down and printed then", async () => {
    const { rig: r, expiresAt } = await setup();
    const now = { t: expiresAt - 1 };
    let stderrAtFirstSleep: string | undefined;
    const loop = loopSeams({
      abortOnSleep: 3,
      onSleep: (call) => {
        if (call === 1) {
          stderrAtFirstSleep = stderrOf(r);
          now.t = expiresAt + 1;
        }
      },
    });

    const code = await supervise(r, () => now.t, loop);

    expect(code).toBe(EXIT_CODES.ok);
    expect(stderrAtFirstSleep).toBe("");
    expect((await r.lease()).state).toBe("cleaned_up");
    const stderr = stderrOf(r);
    expect(stderr).toContain(`stint: Lease ${r.leaseId} expired and was settled.`);
    expect(stderr).toContain(`stint: Lease ${r.leaseId} teardown finished: cleaned_up`);
    // The third sweep finds nothing to do and prints nothing more.
    expect(stderr.match(/expired and was settled/g)).toHaveLength(1);
    expect(loop.sleeps).toHaveLength(3);
  });

  it("--sweep-interval 5 makes the sleep receive 5000", async () => {
    const { rig: r, expiresAt } = await setup();
    const loop = loopSeams({ abortOnSleep: 2 });

    expect(await supervise(r, () => expiresAt - 1, loop, ["--sweep-interval", "5"])).toBe(EXIT_CODES.ok);

    expect(loop.sleeps).toEqual([5000, 5000]);
  });

  it("one SweepState spans the loop: a corrupt record is reported once, not once per sweep", async () => {
    const { rig: r, expiresAt } = await setup();
    const dir = leaseDir(r.root, "torn-lease");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "lease.json"), '{"id": "torn-lease", "state": ');
    const loop = loopSeams({ abortOnSleep: 3 });

    expect(await supervise(r, () => expiresAt - 1, loop)).toBe(EXIT_CODES.ok);

    expect(stderrOf(r).match(/Lease record torn-lease could not be read/g)).toHaveLength(1);
  });

  it("an aborted signal before the first sweep runs no sweep and exits 0", async () => {
    const { rig: r, expiresAt } = await setup();
    const loop = loopSeams({ abortedAtStart: true });

    const code = await supervise(r, () => expiresAt + 1, loop);

    expect(code).toBe(EXIT_CODES.ok);
    expect(loop.sleeps).toEqual([]);
    expect((await r.lease()).state).toBe("active");
    expect(stderrOf(r)).toBe("");
    expect(loop.stats).toEqual({ shutdownCalls: 1, disposed: 1 });
    expect(await lockIsFree(r)).toBe(true);
  });

  it("a stop requested during the sleep ends the loop without another sweep", async () => {
    const { rig: r, expiresAt } = await setup();
    const now = { t: expiresAt - 1 };
    // The lease expires while the loop sleeps, but the stop arrives in the same sleep.
    const loop = loopSeams({
      abortOnSleep: 1,
      onSleep: () => {
        now.t = expiresAt + 1;
      },
    });

    expect(await supervise(r, () => now.t, loop)).toBe(EXIT_CODES.ok);

    expect(loop.sleeps).toHaveLength(1);
    expect((await r.lease()).state).toBe("active");
    expect(stderrOf(r)).toBe("");
  });

  it("does not listen for signals under --once", async () => {
    const { rig: r, expiresAt } = await setup();
    const loop = loopSeams();

    const code = await main(
      ["--store", r.root, "supervise", "--once", "--probe-interval", "0"],
      r.withDeps({ clock: () => expiresAt - 1, supervise: loop.seams }),
    );

    expect(code).toBe(EXIT_CODES.ok);
    expect(loop.stats.shutdownCalls).toBe(0);
    expect(loop.sleeps).toEqual([]);
  });

  it("under --json prints only JSON lines on stdout and no human line", async () => {
    const { rig: r, expiresAt } = await setup();
    const now = { t: expiresAt - 1 };
    const loop = loopSeams({
      abortOnSleep: 2,
      onSleep: (call) => {
        if (call === 1) now.t = expiresAt + 1;
      },
    });

    expect(await supervise(r, () => now.t, loop, ["--json"])).toBe(EXIT_CODES.ok);

    const lines = stdoutOf(r).trim().split("\n");
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(() => JSON.parse(line) as unknown).not.toThrow();
    expect(JSON.parse(lines[0] ?? "") as unknown).toEqual({ event: "expired", leaseId: r.leaseId });
    expect(stderrOf(r)).toBe("");
  });

  it("a sweep that fails as a whole is told once per failure streak and the loop carries on", async () => {
    const { rig: r, expiresAt } = await setup();
    const real = r.deps.storeFactory(r.root);
    // Fails on sweeps 1, 2 and 4; succeeds on sweep 3: two streaks, so two lines.
    const failOn = new Set([1, 2, 4]);
    let scans = 0;
    const flaky: CliDeps["storeFactory"] = () => ({
      ...real,
      scan: () => {
        scans += 1;
        return failOn.has(scans) ? Promise.reject(new Error("store went away: SECRET-DETAIL")) : real.scan();
      },
    });
    const loop = loopSeams({ abortOnSleep: 4 });

    const code = await supervise(r, () => expiresAt - 1, loop, [], { storeFactory: flaky });

    expect(code).toBe(EXIT_CODES.ok);
    const line = "stint: The sweep could not read the store; it will try again at the next interval.\n";
    expect(stderrOf(r)).toBe(line + line);
    expect(stderrOf(r)).not.toContain("SECRET-DETAIL");
    expect(loop.sleeps).toHaveLength(4);
  });

  it("under --once a sweep that fails as a whole is the usual internal error", async () => {
    const { rig: r, expiresAt } = await setup();
    const real = r.deps.storeFactory(r.root);
    const broken: CliDeps["storeFactory"] = () => ({ ...real, scan: () => Promise.reject(new Error("boom")) });

    const code = await main(
      ["--store", r.root, "supervise", "--once"],
      r.withDeps({ clock: () => expiresAt - 1, storeFactory: broken, supervise: loopSeams().seams }),
    );

    expect(code).toBe(EXIT_CODES.internal);
    expect(stderrOf(r)).toBe("stint: Internal error.\n");
  });
});

describe("a graceful stop (D-21)", () => {
  /** Aborts `controller` right after the lease's `invalidate_license` step ran, the way Ctrl-C lands mid-pass. */
  function abortAfterInvalidate(controller: AbortController): NonNullable<NonNullable<CliDeps["teardown"]>["decorateSteps"]> {
    return (steps) =>
      steps.map(
        (step): TeardownStep => ({
          name: step.name,
          run: async (lease, now) => {
            const outcome = await step.run(lease, now);
            if (step.name === "invalidate_license") controller.abort();
            return outcome;
          },
        }),
      );
  }

  it("ends the loop with exit 0, leaves the lease tearing_down with its fence released and starts no sleep", async () => {
    const { rig: r, expiresAt } = await setup();
    const loop = loopSeams();

    const code = await supervise(r, () => expiresAt + 1, loop, [], {
      teardown: { decorateSteps: abortAfterInvalidate(loop.controller) },
    });

    expect(code).toBe(EXIT_CODES.ok);
    expect(loop.sleeps).toEqual([]);
    const lease = await r.lease();
    expect(lease.state).toBe("tearing_down");
    expect(lease.fence).toEqual({ epoch: 1, expiresAt: 0 });
    expect(Object.keys(lease.teardownProgress ?? {}).sort()).toEqual(["invalidate_license", "revoke_oauth"]);
    expect(loop.stats).toEqual({ shutdownCalls: 1, disposed: 1 });
    expect(await lockIsFree(r)).toBe(true);
  });

  it("a following supervise --once finishes it with no teardown_takeover and no repeated step", async () => {
    const { rig: r, expiresAt } = await setup();
    const loop = loopSeams();
    await supervise(r, () => expiresAt + 1, loop, [], {
      teardown: { decorateSteps: abortAfterInvalidate(loop.controller) },
    });
    const recorder = stepRecorder();

    const code = await main(
      ["--store", r.root, "supervise", "--once", "--probe-interval", "0"],
      r.withDeps({
        clock: () => expiresAt + 1,
        teardown: { decorateSteps: recorder.decorateSteps },
        supervise: { lockStaleMs: 5000, lockAcquireWindowMs: 300 },
      }),
    );

    expect(code).toBe(EXIT_CODES.ok);
    expect((await r.lease()).state).toBe("cleaned_up");
    expect(recorder.ran).toEqual(["cleanup_hook", "delete_cached_data", "final_receipt"]);
    expect(await r.entries("teardown_takeover")).toEqual([]);
    expect((await r.lease()).fence).toEqual({ epoch: 2, expiresAt: 0 });
  });
});

describe("a lost lock (T-09-45)", () => {
  it("stops the loop with exit 8 and the fixed line within a few seconds", async () => {
    const { rig: r, expiresAt } = await setup();
    const loop = loopSeams({
      realSleepMs: 100,
      onSleep: async (call) => {
        if (call === 1) {
          await rm(path.join(supervisorDir(r.root), "supervisor.lock"), { recursive: true, force: true });
        }
      },
    });

    const code = await supervise(r, () => expiresAt - 1, loop);

    expect(code).toBe(EXIT_CODES.leaseBusy);
    expect(stderrOf(r)).toBe("stint: The supervisor lock was lost; stopping.\n");
    expect(loop.stats.disposed).toBe(1);
  }, 20_000);

  it("a second supervisor on the same store is refused with exit 8 in the long-running mode too", async () => {
    const { rig: r, expiresAt } = await setup();
    const held = await acquireSupervisorLock(r.root, { staleMs: 5000 });
    const loop = loopSeams({ abortOnSleep: 1 });

    try {
      const code = await supervise(r, () => expiresAt - 1, loop);

      expect(code).toBe(EXIT_CODES.leaseBusy);
      expect(stderrOf(r)).toBe("stint: Another supervisor is already running on this store.\n");
      expect(loop.sleeps).toEqual([]);
      // The stop listener is installed before the lock (G-09-1), so even a refused run started and disposed it.
      expect(loop.stats).toEqual({ shutdownCalls: 1, disposed: 1 });
    } finally {
      await held.release();
    }
  });
});

describe("--sweep-interval validation (T-09-42)", () => {
  const message = "stint: --sweep-interval must be a whole number of seconds from 1 to 2147483.\n";

  it.each(["0", "1.5", "abc", "2147484"])("rejects %s with exit 2 before touching the store", async (value) => {
    const h = await createHarness();
    try {
      const loop = loopSeams({ abortedAtStart: true });
      const code = await main(["--store", h.root, "supervise", "--sweep-interval", value], {
        ...h.deps,
        supervise: loop.seams,
      });

      expect(code).toBe(EXIT_CODES.usage);
      expect(h.stderr.join("")).toBe(message);
      expect(loop.stats.shutdownCalls).toBe(0);
    } finally {
      await h.cleanup();
    }
  });

  it.each([
    ["1", 1000],
    ["2147483", 2_147_483_000],
  ])("accepts %s and sleeps %i ms", async (value, ms) => {
    const h = await createHarness();
    try {
      const loop = loopSeams({ abortOnSleep: 1 });
      const code = await main(["--store", h.root, "supervise", "--sweep-interval", value], {
        ...h.deps,
        supervise: loop.seams,
      });

      expect(code).toBe(EXIT_CODES.ok);
      expect(loop.sleeps).toEqual([ms]);
      // 2147483000 is below the 2^31-1 ms timer limit.
      expect(ms).toBeLessThanOrEqual(2 ** 31 - 1);
    } finally {
      await h.cleanup();
    }
  });

  it("also validates under --once", async () => {
    const h = await createHarness();
    try {
      const code = await main(["--store", h.root, "supervise", "--once", "--sweep-interval", "0"], h.deps);

      expect(code).toBe(EXIT_CODES.usage);
      expect(h.stderr.join("")).toBe(message);
    } finally {
      await h.cleanup();
    }
  });
});

describe("supervise --help", () => {
  it("lists --once as optional and --sweep-interval", async () => {
    const h = await createHarness();
    try {
      const code = await main(["supervise", "--help"], h.deps);

      expect(code).toBe(EXIT_CODES.ok);
      const help = h.stdout.join("");
      expect(help).toContain("--once");
      expect(help).toContain("--sweep-interval <seconds>");
      expect(help).toContain("runs until stopped");
    } finally {
      await h.cleanup();
    }
  });
});

describe("the signal wiring lives in real-deps and installs listeners only when asked (D-21)", () => {
  type Listener = () => void;

  interface FakeProcess extends ShutdownProcess {
    readonly listeners: Map<string, Listener>;
    readonly kills: string[];
    readonly exits: number[];
    failKill: boolean;
  }

  function fakeProcess(platform: string): FakeProcess {
    const listeners = new Map<string, Listener>();
    const kills: string[] = [];
    const exits: number[] = [];
    const proc: FakeProcess = {
      platform,
      pid: 4242,
      listeners,
      kills,
      exits,
      failKill: false,
      on: (signal, listener) => {
        listeners.set(signal, listener);
      },
      off: (signal, listener) => {
        if (listeners.get(signal) === listener) listeners.delete(signal);
      },
      kill: (pid, signal) => {
        if (proc.failKill) throw new Error("ENOSYS");
        kills.push(`${String(pid)}:${signal}`);
        return true;
      },
      exit: (code) => {
        exits.push(code);
        return undefined as never;
      },
    };
    return proc;
  }

  it("installs nothing until called, then listens for SIGINT, SIGHUP and SIGBREAK on Windows", () => {
    const proc = fakeProcess("win32");
    expect(proc.listeners.size).toBe(0);

    const shutdown = createSuperviseShutdown(proc);

    expect([...proc.listeners.keys()].sort()).toEqual(["SIGBREAK", "SIGHUP", "SIGINT"]);
    expect(shutdown.signal.aborted).toBe(false);
  });

  it("does not listen for SIGBREAK off Windows", () => {
    const proc = fakeProcess("linux");

    createSuperviseShutdown(proc);

    expect([...proc.listeners.keys()].sort()).toEqual(["SIGHUP", "SIGINT"]);
  });

  it("the first signal aborts and the second removes the listeners and re-raises the same signal", () => {
    const proc = fakeProcess("linux");
    const shutdown = createSuperviseShutdown(proc);

    proc.listeners.get("SIGINT")?.();
    expect(shutdown.signal.aborted).toBe(true);
    expect(proc.kills).toEqual([]);
    expect(proc.listeners.size).toBe(2);

    proc.listeners.get("SIGHUP")?.();
    expect(proc.kills).toEqual(["4242:SIGHUP"]);
    expect(proc.listeners.size).toBe(0);
  });

  it("falls back to exit 130 when the platform cannot re-raise the signal", () => {
    const proc = fakeProcess("win32");
    proc.failKill = true;
    createSuperviseShutdown(proc);

    proc.listeners.get("SIGBREAK")?.();
    proc.listeners.get("SIGBREAK")?.();

    expect(proc.exits).toEqual([130]);
  });

  it("dispose removes every listener", () => {
    const proc = fakeProcess("win32");
    const shutdown = createSuperviseShutdown(proc);

    shutdown.dispose();

    expect(proc.listeners.size).toBe(0);
  });

  it("no command source file references process (command code uses only the seam)", async () => {
    const source = await readFile(path.join(import.meta.dirname, "..", "src", "commands", "supervise.ts"), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

    expect(code).not.toMatch(/\bprocess\b/);
  });
});
