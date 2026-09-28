/**
 * Task 1: the teardown tracer -- one end reason drives an end-to-end
 * teardown that lands `cleaned_up` with a verifiable final signed receipt
 * (TEAR-01). Proves: `runTeardown` auto-chains `begin_teardown` from a
 * terminal end state, walks the fixed 5 steps in order under the per-lease
 * serializer, persists per-step progress, appends one `teardown_step`
 * receipt per step plus the `begin_teardown`/`teardown_succeeded`
 * transition receipts, signs and writes a final checkpoint (D-31), and
 * fires `notify` with the terminal `cleaned_up` `LifecycleEvent` (D-25).
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { generateKeyPair } from "jose";
import type { CryptoKey } from "jose";
import { describe, expect, it } from "vitest";

import { verifyChain } from "@stint/core";
import type { Lease, LifecycleEvent } from "@stint/core";
import { createInMemoryLeaseStore, createInMemoryReceiptStore, makeTestLease } from "@stint/core/testing";

import { createDefaultTeardownSteps, runTeardown, TEARDOWN_STEP_ORDER } from "../src/index.js";
import type { TeardownDeps } from "../src/index.js";

const NOW = 1_700_000_000;
const LEASE_ID = "lease-teardown-happy-path";

async function buildDeps(): Promise<{
  deps: TeardownDeps;
  leaseStore: ReturnType<typeof createInMemoryLeaseStore>;
  receiptStore: ReturnType<typeof createInMemoryReceiptStore>;
  publicKey: CryptoKey;
  notified: LifecycleEvent[];
}> {
  const leaseStore = createInMemoryLeaseStore();
  const receiptStore = createInMemoryReceiptStore();
  const { privateKey, publicKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });

  const lease: Lease = makeTestLease(LEASE_ID, { state: "completed" });
  await leaseStore.save(lease);

  const notified: LifecycleEvent[] = [];
  const deps: TeardownDeps = {
    leaseStore,
    receiptStore,
    leaseId: LEASE_ID,
    steps: createDefaultTeardownSteps(receiptStore, privateKey),
    notify(event) {
      notified.push(event);
      return Promise.resolve();
    },
  };

  return { deps, leaseStore, receiptStore, publicKey, notified };
}

describe("runTeardown: end-to-end happy path (TEAR-01)", () => {
  it("auto-chains begin_teardown from a terminal end state and lands cleaned_up", async () => {
    const { deps, leaseStore } = await buildDeps();

    const finalLease = await runTeardown(deps, NOW);

    expect(finalLease.state).toBe("cleaned_up");
    const reloaded = await leaseStore.load(LEASE_ID);
    expect(reloaded?.state).toBe("cleaned_up");
  });

  it("records all five fixed steps in teardownProgress, in order, with the happy-path outcomes", async () => {
    const { deps, leaseStore } = await buildDeps();

    await runTeardown(deps, NOW);

    const lease = await leaseStore.load(LEASE_ID);
    expect(lease?.teardownProgress).toEqual({
      revoke_oauth: "revoked",
      invalidate_license: "ok",
      cleanup_hook: "attested_ok",
      delete_cached_data: "ok",
      final_receipt: "ok",
    });
    expect(Object.keys(lease?.teardownProgress ?? {})).toEqual(TEARDOWN_STEP_ORDER);
  });

  it("appends the begin_teardown + 5 teardown_step + teardown_succeeded receipts, and the chain verifies against the written checkpoint", async () => {
    const { deps, receiptStore, publicKey } = await buildDeps();

    await runTeardown(deps, NOW);

    const chain = await receiptStore.load("verified");
    expect(chain).toHaveLength(7);

    const [transition1, ...rest] = chain;
    expect(transition1?.type).toBe("transition");
    if (transition1?.type === "transition") {
      expect(transition1.payload).toEqual({ from: "completed", event: "begin_teardown", actor: "runtime", to: "tearing_down" });
    }

    const stepEntries = rest.slice(0, 5);
    const stepNames = stepEntries.map((entry) => (entry.type === "teardown_step" ? entry.payload.step : undefined));
    expect(stepNames).toEqual(TEARDOWN_STEP_ORDER);

    const lastEntry = rest.at(-1);
    expect(lastEntry?.type).toBe("transition");
    if (lastEntry?.type === "transition") {
      expect(lastEntry.payload).toEqual({ from: "tearing_down", event: "teardown_succeeded", actor: "runtime", to: "cleaned_up" });
    }

    const checkpoint = await receiptStore.readCheckpoint("verified");
    expect(checkpoint).toBeDefined();
    if (checkpoint === undefined) return;

    const verified = await verifyChain(chain, checkpoint, publicKey);
    expect(verified.ok).toBe(true);
  });

  it("fires notify with the terminal cleaned_up LifecycleEvent", async () => {
    const { deps, notified } = await buildDeps();

    await runTeardown(deps, NOW);

    expect(notified).toEqual([{ type: "cleaned_up", leaseId: LEASE_ID, at: NOW }]);
  });
});

const TEARDOWN_SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "teardown");

/** Strips `/* ... *\/` and `// ...` comments (best-effort) so the D-15 grep below checks actual CODE, not prose docstrings that explain the absence of retry/backoff logic. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function readTeardownSources(): readonly string[] {
  return readdirSync(TEARDOWN_SRC_DIR)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => stripComments(readFileSync(path.join(TEARDOWN_SRC_DIR, f), "utf8")));
}

describe("teardown one-pass discipline (D-15)", () => {
  it("no withRetry/setTimeout/backoff appears anywhere in the teardown module code", () => {
    for (const contents of readTeardownSources()) {
      expect(contents).not.toMatch(/withRetry|setTimeout|backoff/i);
    }
  });

  it("no leaseStore.load/.save is called directly in the teardown module source (only runInLeaseTransaction)", () => {
    for (const contents of readTeardownSources()) {
      expect(contents).not.toMatch(/leaseStore\.load\(|leaseStore\.save\(|deps\.leaseStore\.load\(|deps\.leaseStore\.save\(/);
    }
  });
});

