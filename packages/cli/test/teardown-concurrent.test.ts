/**
 * TEAR-06 cross-process proof: teardown drivers racing on one lease over the
 * REAL JSON stores run each step that succeeds once, leave one unforked
 * verifying chain and land the lease once. Asserts on FINAL STATE ONLY (never
 * timing). The worker imports the built dist, so build cli and proxy first.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { exportJWK, generateKeyPair } from "jose";
import type { CryptoKey } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { verifyChain } from "@stint/core";
import type { ReceiptEntry, TeardownStepName } from "@stint/core";
import { makeTestLease } from "@stint/core/testing";
import { createDefaultTeardownSteps, runTeardown, TEARDOWN_STEP_ORDER } from "@stint/proxy";
import type { TeardownStep } from "@stint/proxy";

import { createJsonLeaseStore } from "../src/store/json-lease-store.js";
import { createJsonReceiptStore } from "../src/store/json-receipt-store.js";

const WORKER = fileURLToPath(new URL("./fixtures/teardown-worker.mjs", import.meta.url));
const LEASE_ID = "lease-teardown-race";
const NOW = 1_700_000_000;

const roots: string[] = [];
let signingKey: CryptoKey;
let jwkPath: string;
let keyDir: string;

beforeAll(async () => {
  const pair = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
  signingKey = pair.privateKey;
  keyDir = mkdtempSync(path.join(os.tmpdir(), "stint-teardown-key-"));
  jwkPath = path.join(keyDir, "key.jwk");
  writeFileSync(jwkPath, JSON.stringify(await exportJWK(pair.privateKey)));
});

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  rmSync(keyDir, { recursive: true, force: true });
});

async function expiredRoot(): Promise<string> {
  const root = mkdtempSync(path.join(os.tmpdir(), "stint-teardown-race-"));
  roots.push(root);
  await createJsonLeaseStore({ root }).save(makeTestLease(LEASE_ID, { state: "expired" }));
  return root;
}

function transitionEvents(chain: readonly ReceiptEntry[]): string[] {
  return chain.flatMap((entry) => (entry.type === "transition" ? [entry.payload.event] : []));
}

function stepLog(root: string): string[] {
  return readFileSync(path.join(root, "steps.log"), "utf8").split("\n").filter((line) => line !== "");
}

interface WorkerExit {
  readonly code: number | null;
  readonly state: string | undefined;
}

function runWorker(root: string, failStep: string): Promise<WorkerExit> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [WORKER, root, LEASE_ID, failStep, jwkPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const line = out.trim().split("\n").pop() ?? "";
      try {
        resolve({ code, state: (JSON.parse(line) as { state?: string }).state });
      } catch {
        reject(new Error(`teardown worker exited ${String(code)} without a JSON summary`));
      }
    });
  });
}

async function verifiedChain(root: string): Promise<readonly ReceiptEntry[]> {
  return createJsonReceiptStore({ root, leaseId: LEASE_ID }).load("verified");
}

describe("teardown race over the JSON stores (TEAR-06)", () => {
  it("two store instances over one root in one process: each step once, chain verifies, one landing", async () => {
    const root = await expiredRoot();
    const runs: TeardownStepName[] = [];

    function driver() {
      const leaseStore = createJsonLeaseStore({ root });
      const receiptStore = createJsonReceiptStore({ root, leaseId: LEASE_ID });
      const steps = createDefaultTeardownSteps(receiptStore, signingKey).map(
        (inner): TeardownStep => ({
          name: inner.name,
          run(lease, now) {
            runs.push(inner.name);
            return inner.run(lease, now);
          },
        }),
      );
      return runTeardown({ leaseStore, receiptStore, leaseId: LEASE_ID, steps, signingKey }, NOW);
    }

    const results = await Promise.allSettled([driver(), driver()]);

    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    expect([...runs].sort()).toEqual([...TEARDOWN_STEP_ORDER].sort());
    expect((await createJsonLeaseStore({ root }).load(LEASE_ID))?.state).toBe("cleaned_up");

    const chain = await verifiedChain(root);
    expect((await verifyChain(chain)).ok).toBe(true);
    const events = transitionEvents(chain);
    expect(events.filter((e) => e === "begin_teardown")).toHaveLength(1);
    expect(events.filter((e) => e === "teardown_succeeded")).toHaveLength(1);
  });

  it("three child processes: every child exits 0, each step is logged once, one verifying chain, one landing", async () => {
    const root = await expiredRoot();

    const exits = await Promise.all([runWorker(root, "-"), runWorker(root, "-"), runWorker(root, "-")]);

    for (const exit of exits) expect(exit.code).toBe(0);
    expect([...stepLog(root)].sort()).toEqual([...TEARDOWN_STEP_ORDER].sort());
    expect((await createJsonLeaseStore({ root }).load(LEASE_ID))?.state).toBe("cleaned_up");

    const chain = await verifiedChain(root);
    expect((await verifyChain(chain)).ok).toBe(true);
    expect(new Set(chain.map((e) => e.seq)).size).toBe(chain.length);
    const events = transitionEvents(chain);
    expect(events.filter((e) => e === "begin_teardown")).toHaveLength(1);
    expect(events.filter((e) => e === "teardown_succeeded")).toHaveLength(1);
  });

  it("three child processes with one step forced to fail: cleanup_incomplete, one teardown_incomplete, every child exits 0", async () => {
    const root = await expiredRoot();

    const exits = await Promise.all([
      runWorker(root, "cleanup_hook"),
      runWorker(root, "cleanup_hook"),
      runWorker(root, "cleanup_hook"),
    ]);

    for (const exit of exits) expect(exit.code).toBe(0);
    const log = stepLog(root);
    for (const name of TEARDOWN_STEP_ORDER) {
      const count = log.filter((line) => line === name).length;
      // A step that succeeds runs once. The failing step may be re-run by a driver that joined
      // the pass in flight (Phase 8 D-29), but never more than once per driver.
      if (name === "cleanup_hook") {
        expect(count).toBeGreaterThanOrEqual(1);
        expect(count).toBeLessThanOrEqual(3);
      } else {
        expect(count).toBe(1);
      }
    }
    expect((await createJsonLeaseStore({ root }).load(LEASE_ID))?.state).toBe("cleanup_incomplete");

    const chain = await verifiedChain(root);
    expect((await verifyChain(chain)).ok).toBe(true);
    const events = transitionEvents(chain);
    expect(events.filter((e) => e === "begin_teardown")).toHaveLength(1);
    expect(events.filter((e) => e === "teardown_incomplete")).toHaveLength(1);
    expect(events.filter((e) => e === "teardown_succeeded")).toHaveLength(0);
  });
});
