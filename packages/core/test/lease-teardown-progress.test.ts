import { describe, expect, it } from "vitest";

import { createInMemoryLeaseStore, makeTearingDownTestLease, makeTestLease } from "../src/testing.js";
import { reduce } from "../src/lease.js";
import type { TeardownProgress } from "../src/lease.js";
import { runtimeEvents } from "../src/events.js";

describe("Lease.teardownProgress (D-14)", () => {
  it("round-trips unchanged through createInMemoryLeaseStore save/load", async () => {
    const store = createInMemoryLeaseStore();
    const progress: TeardownProgress = { revoke_oauth: "revoked", invalidate_license: "ok" };
    const lease = makeTestLease("lease-progress", { state: "tearing_down", teardownProgress: progress });

    await store.save(lease);
    const loaded = await store.load("lease-progress");

    expect(loaded?.teardownProgress).toEqual(progress);
    expect(loaded).toEqual(lease);
  });

  it("reduce() carries teardownProgress forward unchanged across an unrelated transition", () => {
    const progress: TeardownProgress = { revoke_oauth: "revoked", cleanup_hook: "attested_ok" };
    const lease = makeTestLease("lease-carry", { state: "tearing_down", teardownProgress: progress });

    const result = reduce(lease, runtimeEvents.teardownSucceeded(), 5000);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.lease.state).toBe("cleaned_up");
      expect(result.value.lease.teardownProgress).toEqual(progress);
    }
  });

  it("a lease with no teardown started has teardownProgress === undefined", () => {
    const lease = makeTestLease("lease-fresh");

    expect(lease.teardownProgress).toBeUndefined();
  });

  it("makeTearingDownTestLease produces a tearing_down lease with a caller-supplied partial progress record", () => {
    const lease = makeTearingDownTestLease("lease-tearing", {
      teardownProgress: { revoke_oauth: "discarded_revocation_unsupported" },
    });

    expect(lease.state).toBe("tearing_down");
    expect(lease.teardownProgress).toEqual({ revoke_oauth: "discarded_revocation_unsupported" });
  });
});
