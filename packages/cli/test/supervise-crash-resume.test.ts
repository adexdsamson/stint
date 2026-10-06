/**
 * Phase 9 plan 03, task 2: the real killed-process proof for SUP-03 and D-10.
 *
 * A child process runs one supervisor sweep over the REAL JSON stores and is
 * killed with SIGKILL while step 3 of a teardown is in flight (the fence held,
 * steps 1 and 2 recorded). The next `stint-cli supervise --once` takes over the
 * expired fence with a `teardown_takeover` receipt, does not re-run the steps
 * recorded before the kill, and lands the lease. Only a real kill proves this: a
 * thrown error would release the fence.
 *
 * Asserts on final state only, never on timing. A killed holder leaves its lock
 * directory until it goes stale, so both sides use `staleMs: 5000` (the minimum).
 * The worker imports the built dist and the built `@stint/runtime`: build both first.
 */

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { verifyChain } from "@stint/core";
import { makeTestLease } from "@stint/core/testing";
import type { TeardownStep } from "@stint/proxy";
import lockfile from "proper-lockfile";
import { afterEach, describe, expect, it, vi } from "vitest";

import { seedFromCredentials } from "../src/custody.js";
import { EXIT_CODES } from "../src/exit.js";
import { main } from "../src/program.js";
import { buildRuntimePorts } from "../src/runtime-ports.js";
import { createJsonLeaseStore } from "../src/store/json-lease-store.js";
import { createTeardownRig } from "./helpers/teardown-rig.js";
import type { TeardownRig } from "./helpers/teardown-rig.js";

const WORKER = fileURLToPath(new URL("./fixtures/supervise-crash-worker.mjs", import.meta.url));
const STALE_MS = 5000;
/** Seconds added to the wall clock so the killed holder's fence is certainly expired. */
const PAST_FENCE_SECONDS = 200;

let rig: TeardownRig | undefined;
let child: ChildProcess | undefined;
afterEach(async () => {
  if (child !== undefined && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  child = undefined;
  vi.restoreAllMocks();
  await rig?.fx.harness.cleanup();
  rig = undefined;
});

/** Spawns the worker (never through a shell) and resolves once it prints `BLOCKED`. */
function startWorker(root: string): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [WORKER, root, String(STALE_MS)], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    child = proc;
    let out = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
      if (out.includes("BLOCKED")) resolve(proc);
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (!out.includes("BLOCKED")) {
        reject(new Error(`worker exited ${String(code)} before BLOCKED (output: ${out.trim()})`));
      }
    });
  });
}

function killAndWait(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    proc.once("close", () => {
      resolve();
    });
    proc.kill("SIGKILL");
  });
}

async function stepLog(root: string): Promise<string[]> {
  const text = await readFile(path.join(root, "steps.log"), "utf8");
  return text.split("\n").filter((line) => line !== "");
}

/** A decorator that appends each step name to the same steps.log the worker writes, then runs it. */
function logging(root: string): (steps: readonly TeardownStep[]) => readonly TeardownStep[] {
  return (steps) =>
    steps.map(
      (inner): TeardownStep => ({
        name: inner.name,
        run: async (lease, now) => {
          const { appendFile } = await import("node:fs/promises");
          await appendFile(path.join(root, "steps.log"), `${inner.name}\n`);
          return inner.run(lease, now);
        },
      }),
    );
}

const count = (lines: readonly string[], name: string): number => lines.filter((l) => l === name).length;

describe("a supervisor killed mid-teardown resumes on restart (SUP-03, D-10)", () => {
  it(
    "takes over the expired fence with a receipt, never repeats a recorded step, and lands the lease",
    async () => {
      const r = await createTeardownRig();
      rig = r;
      await seedFromCredentials(r.deps, buildRuntimePorts(r.deps, r.root), r.leaseId, r.fx.credentials);
      await r.setLease({ state: "expired" });
      r.clearOutput();

      // The real supervisor process gets into step 3 and is killed there.
      const worker = await startWorker(r.root);
      await killAndWait(worker);

      const crashed = await r.lease();
      expect(crashed.state).toBe("tearing_down");
      expect(crashed.fence?.epoch).toBe(1);
      expect(crashed.fence?.expiresAt).toBeGreaterThan(0);
      expect(crashed.teardownProgress?.revoke_oauth).toBeDefined();
      expect(crashed.teardownProgress?.invalidate_license).toBeDefined();
      expect(crashed.teardownProgress?.cleanup_hook).toBeUndefined();
      expect((await stepLog(r.root)).slice(0, 3)).toEqual(["revoke_oauth", "invalidate_license", "cleanup_hook"]);

      // The next sweep, in this process, past the dead holder's fence.
      const clock = (): number => Math.floor(Date.now() / 1000) + PAST_FENCE_SECONDS;
      const code = await main(
        ["--store", r.root, "supervise", "--once"],
        r.withDeps({
          clock,
          storeFactory: (root) => createJsonLeaseStore({ root, staleMs: STALE_MS }),
          teardown: { decorateSteps: logging(r.root) },
        }),
      );

      expect(code).toBe(EXIT_CODES.ok);
      const landed = await r.lease();
      expect(landed.state).toBe("cleaned_up");
      expect(landed.fence).toEqual({ epoch: 2, expiresAt: 0 });

      const takeovers = await r.entries("teardown_takeover");
      expect(takeovers).toHaveLength(1);
      expect(takeovers[0]?.payload).toEqual({ previousEpoch: 1, epoch: 2, reason: "fence_expired" });

      // The orchestrator's own receipt for a step carries no `resource`; revoke_oauth also leaves one
      // per-resource receipt from the vault. Neither kind may repeat for a step recorded before the kill.
      const stepPayloads = (await r.entries("teardown_step")).map(
        (e) => e.payload as { step: string; resource?: string },
      );
      const stepReceipts = stepPayloads.filter((p) => p.resource === undefined).map((p) => p.step);
      expect(count(stepReceipts, "revoke_oauth")).toBe(1);
      expect(count(stepReceipts, "invalidate_license")).toBe(1);
      expect(stepPayloads.filter((p) => p.step === "revoke_oauth" && p.resource !== undefined)).toHaveLength(1);

      const chain = await r.deps.receiptStoreFactory(r.root, r.leaseId).load("verified");
      expect((await verifyChain(chain)).ok).toBe(true);

      // Only steps recorded before the kill are guaranteed not to repeat; the step in flight may run again.
      const log = await stepLog(r.root);
      expect(count(log, "revoke_oauth")).toBe(1);
      expect(count(log, "invalidate_license")).toBe(1);
      expect(count(log, "cleanup_hook")).toBeGreaterThanOrEqual(1);
      expect(count(log, "cleanup_hook")).toBeLessThanOrEqual(2);
      expect(count(log, "delete_cached_data")).toBe(1);
      expect(count(log, "final_receipt")).toBe(1);

      // The takeover is readable in the timeline, never an unrecognized entry.
      r.clearOutput();
      const receiptsCode = await main(["--store", r.root, "receipts", r.leaseId], r.deps);
      expect(receiptsCode).toBe(EXIT_CODES.ok);
      const shown = r.fx.harness.stdout.join("");
      expect(shown).toContain("teardown takeover: epoch 1 -> 2 (fence_expired)");
      expect(shown).not.toContain("unrecognized receipt entry");
    },
    55_000,
  );
});

describe("JsonLeaseStoreOptions.staleMs", () => {
  async function staleUsedBy(opts: { readonly staleMs?: number }): Promise<number | undefined> {
    const root = await mkdtemp(path.join(os.tmpdir(), "stint-stale-"));
    try {
      const spy = vi.spyOn(lockfile, "lock");
      const store = createJsonLeaseStore({ root, ...opts });
      await store.save(makeTestLease("lease-stale-opt", { state: "active" }));
      const options = spy.mock.calls[0]?.[1];
      return options?.stale;
    } finally {
      vi.restoreAllMocks();
      await rm(root, { recursive: true, force: true });
    }
  }

  it("keeps the 10000 ms stale window when staleMs is not given", async () => {
    expect(await staleUsedBy({})).toBe(10_000);
  });

  it("uses the given window, raised to the 5000 ms minimum", async () => {
    expect(await staleUsedBy({ staleMs: 7000 })).toBe(7000);
    expect(await staleUsedBy({ staleMs: 5000 })).toBe(5000);
    expect(await staleUsedBy({ staleMs: 100 })).toBe(5000);
  });
});
