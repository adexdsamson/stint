/**
 * Phase 9 plan 10 (SUP-07, D-21): one supervisor per store. A second supervisor
 * is refused with exit 8 and a fixed message, a lock left by a killed holder is
 * taken over once it is stale, and a lock lost under a live holder is reported
 * through `compromised` so the loop can stop.
 */

import { mkdir, stat, utimes } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CliError, EXIT_CODES } from "../src/exit.js";
import { supervisorDir } from "../src/paths.js";
import { main } from "../src/program.js";
import { acquireSupervisorLock } from "../src/store/supervisor-lock.js";
import type { SupervisorLock } from "../src/store/supervisor-lock.js";
import { createHarness } from "./helpers/cli-harness.js";
import type { Harness } from "./helpers/cli-harness.js";

const BUSY = "stint: Another supervisor is already running on this store.\n";

let harness: Harness | undefined;
const held: SupervisorLock[] = [];

afterEach(async () => {
  for (const lock of held.splice(0)) await lock.release();
  await harness?.cleanup();
  harness = undefined;
});

async function setup(): Promise<Harness> {
  harness = await createHarness();
  return harness;
}

async function hold(root: string, staleMs = 5000): Promise<SupervisorLock> {
  const lock = await acquireSupervisorLock(root, { staleMs });
  held.push(lock);
  return lock;
}

function superviseOnce(h: Harness, flags: readonly string[] = []): Promise<number> {
  return main(["--store", h.root, "supervise", "--once", ...flags], {
    ...h.deps,
    supervise: { lockStaleMs: 5000, lockAcquireWindowMs: 300 },
  });
}

describe("one supervisor per store (D-21)", () => {
  it("refuses a second supervisor with exit 8 and the fixed message, then runs once the lock is released", async () => {
    const h = await setup();
    const lock = await hold(h.root);

    const refused = await superviseOnce(h);

    expect(refused).toBe(EXIT_CODES.leaseBusy);
    expect(h.stderr.join("")).toBe(BUSY);
    expect(h.stdout.join("")).toBe("");

    await lock.release();
    h.stderr.length = 0;
    const accepted = await superviseOnce(h);

    expect(accepted).toBe(EXIT_CODES.ok);
    expect(h.stderr.join("")).toBe("");
  });

  it("a finished supervise releases its own lock", async () => {
    const h = await setup();

    expect(await superviseOnce(h)).toBe(EXIT_CODES.ok);
    expect(await superviseOnce(h)).toBe(EXIT_CODES.ok);
  });

  it("creates the supervisor directory and locks <store>/supervisor/supervisor", async () => {
    const h = await setup();

    const lock = await hold(h.root);

    expect((await stat(supervisorDir(h.root))).isDirectory()).toBe(true);
    expect(supervisorDir(h.root)).toBe(path.resolve(h.root, "supervisor"));
    // proper-lockfile represents the lock as a `<target>.lock` directory.
    expect((await stat(path.join(h.root, "supervisor", "supervisor.lock"))).isDirectory()).toBe(true);
    await lock.release();
    await expect(stat(path.join(h.root, "supervisor", "supervisor.lock"))).rejects.toThrow();
  });

  it("release is idempotent and never throws", async () => {
    const h = await setup();
    const lock = await hold(h.root);

    await lock.release();
    await expect(lock.release()).resolves.toBeUndefined();
  });
});

describe("a lock left by a killed holder (T-09-44)", () => {
  it("is taken over when its mtime is 30 seconds old", async () => {
    const h = await setup();
    const lockDir = path.join(h.root, "supervisor", "supervisor.lock");
    await mkdir(lockDir, { recursive: true });
    const old = new Date(Date.now() - 30_000);
    await utimes(lockDir, old, old);

    const lock = await acquireSupervisorLock(h.root, { staleMs: 5000, acquireWindowMs: 500 });
    held.push(lock);

    // The takeover is a fresh lock: its directory was just refreshed.
    expect(Date.now() - (await stat(lockDir)).mtimeMs).toBeLessThan(5000);
  });

  it("a restart inside the stale window waits and then acquires instead of refusing", async () => {
    const h = await setup();
    const lockDir = path.join(h.root, "supervisor", "supervisor.lock");
    await mkdir(lockDir, { recursive: true });
    // 2 seconds from going stale: the retry loop must outlast it.
    const nearlyStale = new Date(Date.now() - 3000);
    await utimes(lockDir, nearlyStale, nearlyStale);

    const started = Date.now();
    const lock = await acquireSupervisorLock(h.root, { staleMs: 5000 });
    held.push(lock);

    expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
  }, 15_000);

  it("a live holder makes acquisition reject with the busy error after about the window", async () => {
    const h = await setup();
    await hold(h.root);

    const started = Date.now();
    const error: unknown = await acquireSupervisorLock(h.root, { staleMs: 5000, acquireWindowMs: 500 }).catch(
      (e: unknown) => e,
    );
    const elapsed = Date.now() - started;

    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe(EXIT_CODES.leaseBusy);
    expect((error as CliError).safeMessage).toBe("Another supervisor is already running on this store.");
    expect(elapsed).toBeGreaterThanOrEqual(400);
    expect(elapsed).toBeLessThan(3000);
  });
});

describe("a lost lock (T-09-45)", () => {
  it("resolves compromised within the update period when the lock directory is removed", async () => {
    const h = await setup();
    const lock = await hold(h.root);
    let settled = false;
    void lock.compromised.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    const { rm } = await import("node:fs/promises");
    await rm(path.join(h.root, "supervisor", "supervisor.lock"), { recursive: true, force: true });

    // staleMs 5000: the library refreshes every 2500 ms and notices the missing directory on the next one.
    await expect(lock.compromised).resolves.toBeUndefined();
    expect(settled).toBe(true);
  }, 15_000);

  it("never settles compromised for a healthy lock that is released", async () => {
    const h = await setup();
    const lock = await hold(h.root);
    let settled = false;
    void lock.compromised.then(() => {
      settled = true;
    });

    await lock.release();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(settled).toBe(false);
  });
});
