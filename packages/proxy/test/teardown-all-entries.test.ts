/**
 * Phase 5 Plan 8, Task 2: TEAR-05 entry-agnosticism (however a lease ends,
 * the fixed teardown runs the same way) + the phase gate (D-26): zero
 * `[OPEN: Phase 5]` markers remain in `spec/ALP.md` and `check:alp` passes.
 *
 * Constructs a lease fixture DIRECTLY in each of the four terminal end
 * states (`completed`/`expired`/`revoked`/`failed`) -- per
 * 05-RESEARCH.md Pitfall 4, the `expire`/error-threshold/`user`-revoke event
 * dispatch is un-wired and deferred to Phase 6, so this suite never drives
 * those events through `reduce()`. It proves entry-agnosticism the same way
 * 05-03's own `teardown-orchestrate.test.ts` does for a single state (a
 * lease constructed already in a terminal end state, letting `runTeardown`'s
 * own auto-chain perform `begin_teardown`), across all four states in the
 * TEAR-05 union.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";

import { verifyChain } from "@stint/core";
import type { Lease } from "@stint/core";
import { createInMemoryLeaseStore, createInMemoryReceiptStore, makeTestLease } from "@stint/core/testing";

import { createDefaultTeardownSteps, runTeardown, TEARDOWN_STEP_ORDER } from "../src/index.js";
import type { TeardownDeps } from "../src/index.js";

const NOW = 1_700_000_000;

/** The full TEAR-05 union of terminal end states `runTeardown`'s own `TERMINAL_END_STATES` set recognizes. */
const TERMINAL_END_STATES: readonly Lease["state"][] = ["completed", "expired", "revoked", "failed"];

describe("teardown-all-entries (TEAR-05): the fixed teardown runs for every terminal end reason", () => {
  for (const state of TERMINAL_END_STATES) {
    it(`a lease ending via "${state}" runs the same fixed 5-step teardown, in order, and lands cleaned_up with a verifiable final receipt`, async () => {
      const leaseId = `lease-all-entries-${state}`;
      const leaseStore = createInMemoryLeaseStore();
      const receiptStore = createInMemoryReceiptStore();
      const { privateKey, publicKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });

      const lease: Lease = makeTestLease(leaseId, { state });
      await leaseStore.save(lease);

      const deps: TeardownDeps = {
        leaseStore,
        receiptStore,
        leaseId,
        steps: createDefaultTeardownSteps(receiptStore, privateKey),
      };

      const finalLease = await runTeardown(deps, NOW);

      expect(finalLease.state).toBe("cleaned_up");

      const reloaded = await leaseStore.load(leaseId);
      // The SAME fixed order, every time, regardless of end reason (D-33):
      // all five step names recorded, in TEARDOWN_STEP_ORDER's exact order.
      expect(Object.keys(reloaded?.teardownProgress ?? {})).toEqual(TEARDOWN_STEP_ORDER);
      expect(reloaded?.teardownProgress).toEqual({
        revoke_oauth: "revoked",
        invalidate_license: "ok",
        cleanup_hook: "attested_ok",
        delete_cached_data: "ok",
        final_receipt: "ok",
      });

      const chain = await receiptStore.load("verified");
      const checkpoint = await receiptStore.readCheckpoint("verified");
      expect(checkpoint).toBeDefined();
      if (checkpoint === undefined) return;
      const verified = await verifyChain(chain, checkpoint, publicKey);
      expect(verified.ok).toBe(true);

      // The begin_teardown transition's own "from" field names THIS state --
      // proving the run actually auto-chained from the terminal state under
      // test, never a fixed/hardcoded default.
      const beginTeardownEntry = chain.find(
        (entry) => entry.type === "transition" && entry.payload.event === "begin_teardown",
      );
      expect(beginTeardownEntry?.type).toBe("transition");
      if (beginTeardownEntry?.type === "transition") {
        expect(beginTeardownEntry.payload.from).toBe(state);
        expect(beginTeardownEntry.payload.to).toBe("tearing_down");
      }

      const stepEntries = chain.filter((entry) => entry.type === "teardown_step");
      const stepNames = stepEntries.map((entry) => entry.payload.step);
      expect(stepNames).toEqual(TEARDOWN_STEP_ORDER);
    });
  }
});

describe("phase gate (D-26): spec/ALP.md has zero [OPEN: Phase 5] markers and check:alp passes", () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const specPath = path.join(repoRoot, "spec", "ALP.md");

  it("no [OPEN: Phase 5] marker remains anywhere in spec/ALP.md", () => {
    const contents = readFileSync(specPath, "utf8");
    expect(contents).not.toContain("[OPEN: Phase 5]");
  });

  it("check:alp (scripts/check-alp-sections.mjs) exits 0", () => {
    expect(() =>
      execFileSync("node", ["scripts/check-alp-sections.mjs"], { cwd: repoRoot, stdio: "pipe" }),
    ).not.toThrow();
  });
});
