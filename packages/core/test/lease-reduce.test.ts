import { describe, expect, it } from "vitest";

import { reduce } from "../src/lease.js";
import type { Lease } from "../src/lease.js";
import { userEvents } from "../src/events.js";

function proposedLease(): Lease {
  return {
    id: "lease-1",
    state: "proposed",
    version: 0,
    boundHash: "jcs-sha256:0000000000000000000000000000000000000000000000000000000000000000",
    grantedAt: 0,
    expiresAt: 0,
    maxDurationSeconds: 3600,
    counters: { actionCount: 0, spentMinor: 0, denialErrorTimestamps: [], actionTimestamps: [] },
  };
}

describe("reduce", () => {
  it("LEGAL path: proposed + consent_granted / user -> granted", () => {
    const proposed = proposedLease();
    const result = reduce(proposed, userEvents.consentGranted(), 1000);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.lease.state).toBe("granted");
    expect(result.value.lease.version).toBe(1);
    expect(result.value.lease.grantedAt).toBe(1000);
    expect(result.value.lease.expiresAt).toBe(1000 + 3600);
    expect(result.value.transition).toEqual({
      from: "proposed",
      event: "consent_granted",
      actor: "user",
      to: "granted",
      at: 1000,
    });
  });

  it("INPUT IMMUTABILITY: the original lease is untouched and the returned lease is frozen", () => {
    const proposed = proposedLease();
    const result = reduce(proposed, userEvents.consentGranted(), 1000);

    expect(proposed.state).toBe("proposed");
    expect(proposed.version).toBe(0);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.isFrozen(result.value.lease)).toBe(true);
  });

  it("ILLEGAL path: proposed + revoke / user is rejected and leaves the lease unchanged", () => {
    const proposed = proposedLease();
    const result = reduce(proposed, userEvents.revoke(), 1000);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe("illegal_transition");

    expect(proposed.state).toBe("proposed");
    expect(proposed.version).toBe(0);
  });

  it("DETERMINISM: identical inputs yield deep-equal results", () => {
    const proposed = proposedLease();
    const first = reduce(proposed, userEvents.consentGranted(), 1000);
    const second = reduce(proposed, userEvents.consentGranted(), 1000);

    expect(first).toEqual(second);
  });
});
