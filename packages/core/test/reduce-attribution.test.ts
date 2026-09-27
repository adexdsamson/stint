import { describe, expect, it } from "vitest";

import { reduce } from "../src/lease.js";
import type { Lease } from "../src/lease.js";
import type { LeaseEvent } from "../src/events.js";
import {
  clockEvents,
  policyEvents,
  providerEvents,
  publisherEvents,
  runtimeEvents,
  userEvents,
  verifierEvents,
} from "../src/events.js";
import { EVENTS } from "../src/transitions.js";
import type { State } from "../src/transitions.js";

/** Builds a lease in an arbitrary state with sensible defaults, overridable per test. */
function makeLease(overrides: Partial<Lease> = {}): Lease {
  return {
    id: "lease-1",
    state: "proposed",
    version: 3,
    boundHash: `jcs-sha256:${"0".repeat(64)}`,
    grantedAt: 0,
    expiresAt: 1000,
    maxDurationSeconds: 3600,
    counters: { actionCount: 0, spentMinor: 0, denialErrorTimestamps: [] },
    ...overrides,
  };
}

interface LegalCase {
  readonly from: State;
  readonly event: LeaseEvent;
  readonly to: State;
}

/** All 25 legal (state, event, actor) triples of ALP.md §7.4. */
const LEGAL_CASES: readonly LegalCase[] = [
  { from: "proposed", event: userEvents.consentGranted(), to: "granted" },
  { from: "proposed", event: userEvents.consentDeclined(), to: "declined" },
  { from: "proposed", event: clockEvents.consentTimedOut(), to: "declined" },
  { from: "granted", event: runtimeEvents.activate(), to: "active" },
  { from: "granted", event: runtimeEvents.activationFailed(), to: "failed" },
  { from: "granted", event: userEvents.revoke(), to: "revoked" },
  { from: "granted", event: providerEvents.grantRevoked(), to: "revoked" },
  { from: "granted", event: publisherEvents.entitlementRevoked(), to: "revoked" },
  { from: "granted", event: clockEvents.expire(), to: "expired" },
  { from: "active", event: userEvents.extend(600), to: "active" },
  { from: "active", event: verifierEvents.outcomeVerified(), to: "completed" },
  { from: "active", event: clockEvents.expire(), to: "expired" },
  { from: "active", event: userEvents.revoke(), to: "revoked" },
  { from: "active", event: providerEvents.grantRevoked(), to: "revoked" },
  { from: "active", event: publisherEvents.entitlementRevoked(), to: "revoked" },
  { from: "active", event: policyEvents.errorThresholdExceeded(), to: "failed" },
  { from: "active", event: runtimeEvents.runtimeFailure(), to: "failed" },
  { from: "completed", event: runtimeEvents.beginTeardown(), to: "tearing_down" },
  { from: "expired", event: runtimeEvents.beginTeardown(), to: "tearing_down" },
  { from: "revoked", event: runtimeEvents.beginTeardown(), to: "tearing_down" },
  { from: "failed", event: runtimeEvents.beginTeardown(), to: "tearing_down" },
  { from: "tearing_down", event: runtimeEvents.teardownSucceeded(), to: "cleaned_up" },
  { from: "tearing_down", event: runtimeEvents.teardownIncomplete(), to: "cleanup_incomplete" },
  { from: "cleanup_incomplete", event: userEvents.retryTeardown(), to: "tearing_down" },
  { from: "cleanup_incomplete", event: runtimeEvents.retryTeardown(), to: "tearing_down" },
];

describe("reduce(): full §7.4 legality matrix", () => {
  it("has exactly 25 legal cases (D-05)", () => {
    expect(LEGAL_CASES).toHaveLength(25);
  });

  it.each(LEGAL_CASES)(
    "accepts $from + $event.type / $event.actor -> $to",
    ({ from, event, to }) => {
      const lease = makeLease({ state: from, version: 3 });
      const result = reduce(lease, event, 9999);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.lease.state).toBe(to);
      expect(result.value.lease.version).toBe(4);
    },
  );
});

describe("reduce(): illegal pairs and terminal-state re-entry", () => {
  it("rejects an illegal (state,event) pair with illegal_transition", () => {
    const lease = makeLease({ state: "active", version: 5 });
    const result = reduce(lease, runtimeEvents.beginTeardown(), 1000);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe("illegal_transition");
  });

  it("rejects re-dispatch to a terminal state (declined) and never changes state", () => {
    const lease = makeLease({ state: "declined", version: 2 });
    const result = reduce(lease, userEvents.revoke(), 1000);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe("illegal_transition");
    expect(lease.state).toBe("declined");
    expect(lease.version).toBe(2);
  });

  it("rejects re-dispatch to a terminal state (cleaned_up) and never changes state", () => {
    const lease = makeLease({ state: "cleaned_up", version: 7 });
    const result = reduce(lease, runtimeEvents.beginTeardown(), 1000);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe("illegal_transition");
    expect(lease.state).toBe("cleaned_up");
    expect(lease.version).toBe(7);
  });
});

describe("reduce(): wrong-actor rejection", () => {
  it("rejects a hand-built { type: 'expire', actor: 'user' } against active (expire is a clock event)", () => {
    const lease = makeLease({ state: "active", version: 1 });
    const forged: LeaseEvent = { type: "expire", actor: "user" };
    const result = reduce(lease, forged, 1000);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe("wrong_actor");
  });
});

describe("reduce(): agent-boundary guarantee (D-19)", () => {
  it("rejects a hand-forged { type: 'revoke', actor: 'agent' } — the agent can never end a lease", () => {
    const lease = makeLease({ state: "active", version: 1 });
    const forged = { type: "revoke", actor: "agent" as never } as LeaseEvent;
    const result = reduce(lease, forged, 1000);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe("wrong_actor");
    expect(lease.state).toBe("active");
  });

  it("rejects a hand-forged { type: 'extend', actor: 'agent' } against active — the agent can never extend a lease", () => {
    const lease = makeLease({ state: "active", version: 1, expiresAt: 5000, maxDurationSeconds: 3600 });
    const forged = { type: "extend", actor: "agent" as never, deltaSeconds: 600 } as LeaseEvent;
    const result = reduce(lease, forged, 1000);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(lease.expiresAt).toBe(5000);
  });
});

describe("reduce(): extend is bounded by lease.maxDurationSeconds (D-06)", () => {
  it("extend(600) on expiresAt:5000, maxDurationSeconds:3600 -> expiresAt 5600, state stays active", () => {
    const lease = makeLease({ state: "active", version: 2, expiresAt: 5000, maxDurationSeconds: 3600 });
    const result = reduce(lease, userEvents.extend(600), 1000);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lease.expiresAt).toBe(5600);
    expect(result.value.lease.state).toBe("active");
    expect(result.value.lease.version).toBe(3);
  });

  it("extend(4000) exceeds maxDurationSeconds:3600 -> extension_exceeds_max", () => {
    const lease = makeLease({ state: "active", expiresAt: 5000, maxDurationSeconds: 3600 });
    const result = reduce(lease, userEvents.extend(4000), 1000);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe("extension_exceeds_max");
  });

  it("extend(0) -> extension_exceeds_max", () => {
    const lease = makeLease({ state: "active", expiresAt: 5000, maxDurationSeconds: 3600 });
    const result = reduce(lease, userEvents.extend(0), 1000);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe("extension_exceeds_max");
  });

  it("a negative delta -> extension_exceeds_max", () => {
    const lease = makeLease({ state: "active", expiresAt: 5000, maxDurationSeconds: 3600 });
    const result = reduce(lease, userEvents.extend(-100), 1000);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe("extension_exceeds_max");
  });

  it("a non-integer delta -> extension_exceeds_max", () => {
    const lease = makeLease({ state: "active", expiresAt: 5000, maxDurationSeconds: 3600 });
    const result = reduce(lease, userEvents.extend(1.5), 1000);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]?.code).toBe("extension_exceeds_max");
  });
});

describe("reduce(): expire uses only the injected clock (D-07)", () => {
  it("clockEvents.expire() on active -> expired, transition.at === injected now", () => {
    const lease = makeLease({ state: "active", version: 1, expiresAt: 5000 });
    const result = reduce(lease, clockEvents.expire(), 9000);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lease.state).toBe("expired");
    expect(result.value.transition.at).toBe(9000);
    // expire never moves expiresAt — only grant/extend do (D-06, D-08).
    expect(result.value.lease.expiresAt).toBe(5000);
  });
});

describe("reduce(): no license-refresh path can move expiry (D-08)", () => {
  it("EVENTS contains no refresh/license_refresh/token_refresh member", () => {
    const refreshLike = EVENTS.filter((event) => /refresh/.test(event));
    expect(refreshLike).toHaveLength(0);
  });
});

describe("reduce(): retry_teardown is the only dual-actor key", () => {
  it("both userEvents.retryTeardown() and runtimeEvents.retryTeardown() from cleanup_incomplete succeed", () => {
    const leaseForUser = makeLease({ state: "cleanup_incomplete", version: 4 });
    const userResult = reduce(leaseForUser, userEvents.retryTeardown(), 1000);
    expect(userResult.ok).toBe(true);
    if (userResult.ok) expect(userResult.value.lease.state).toBe("tearing_down");

    const leaseForRuntime = makeLease({ state: "cleanup_incomplete", version: 4 });
    const runtimeResult = reduce(leaseForRuntime, runtimeEvents.retryTeardown(), 1000);
    expect(runtimeResult.ok).toBe(true);
    if (runtimeResult.ok) expect(runtimeResult.value.lease.state).toBe("tearing_down");
  });
});
