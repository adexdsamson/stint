import type { LifecycleEvent } from "@stint/core";
import { makeTestLease } from "@stint/core/testing";
import { appendReceiptEntry } from "@stint/proxy";
import type { TeardownStep } from "@stint/proxy";
import type { ReceiptEntry } from "@stint/spec";
import { describe, expect, it } from "vitest";

import { DEFAULT_SUPERVISOR_CONFIG, createSweepState, runSweep, seedLeaseCredentials } from "../src/index.js";
import type { RuntimePorts, SupervisorConfig, SweepEvent, SweepState } from "../src/index.js";
import { buildRig, delegatedManifest, oauthCredential } from "./helpers.js";

const LEASE = "lease-stuck-1";
const T0 = 5000;

interface Harness {
  readonly ports: RuntimePorts;
  readonly now: { value: number };
  readonly state: SweepState;
  readonly notified: LifecycleEvent[];
  /** While false the stored publisher key is removed from the trust store. */
  readonly trusted: { value: boolean };
  /** While true the revoke_oauth step reports failed. */
  readonly revokeFails: { value: boolean };
  /** How many more times `cleanup_hook` fails. */
  readonly hook: { failures: number; calls: number };
  readonly decorateSteps: (steps: readonly TeardownStep[]) => readonly TeardownStep[];
}

interface SetupOptions {
  readonly leaseState?: "expired" | "cleanup_incomplete";
  readonly seed?: boolean;
}

async function setup(options: SetupOptions = {}): Promise<Harness> {
  const rig = await buildRig(LEASE, delegatedManifest(["sheets.orders"]));
  const realTrust = await rig.ports.trust();
  const trusted = { value: true };
  const now = { value: T0 };
  const ports: RuntimePorts = {
    ...rig.ports,
    clock: () => now.value,
    trust: () => Promise.resolve(trusted.value ? realTrust : {}),
  };
  await ports.leases.save(makeTestLease(LEASE, { state: options.leaseState ?? "expired" }));
  if (options.seed !== false) {
    await seedLeaseCredentials(ports, LEASE, {
      "sheets.orders": oauthCredential("https://as.example.test/token", undefined),
    });
  }
  const revokeFails = { value: false };
  const hook = { failures: 0, calls: 0 };
  const decorateSteps = (steps: readonly TeardownStep[]): readonly TeardownStep[] =>
    steps.map(
      (step): TeardownStep => ({
        name: step.name,
        run: (lease, at) => {
          if (step.name === "revoke_oauth" && revokeFails.value) return Promise.resolve("failed");
          if (step.name === "cleanup_hook") {
            hook.calls += 1;
            if (hook.failures > 0) {
              hook.failures -= 1;
              return Promise.resolve("failed");
            }
          }
          return step.run(lease, at);
        },
      }),
    );
  return { ports, now, state: createSweepState(), notified: [], trusted, revokeFails, hook, decorateSteps };
}

async function sweep(
  h: Harness,
  at?: number,
  extra: { state?: SweepState; config?: SupervisorConfig } = {},
): Promise<readonly SweepEvent[]> {
  if (at !== undefined) h.now.value = at;
  const report = await runSweep(h.ports, {
    decorateSteps: h.decorateSteps,
    state: extra.state ?? h.state,
    ...(extra.config === undefined ? {} : { config: extra.config }),
    notify: (event) => {
      h.notified.push(event);
      return Promise.resolve();
    },
  });
  return report.events;
}

async function verified(h: Harness): Promise<readonly ReceiptEntry[]> {
  return h.ports.receipts(LEASE).load("verified");
}

function ofType(chain: readonly ReceiptEntry[], type: string): readonly ReceiptEntry[] {
  return chain.filter((entry) => entry.type === type);
}

function transitionEvents(chain: readonly ReceiptEntry[]): string[] {
  return ofType(chain, "transition").map((entry) => (entry.payload as { event: string }).event);
}

describe("credentials_unavailable (D-02)", () => {
  it("marks the lease stuck at once, receipts it once, and appends nothing on later sweeps", async () => {
    const h = await setup({ seed: false });

    const first = await sweep(h);
    expect(first).toEqual([
      { kind: "stuck", leaseId: LEASE, reason: "credentials_unavailable", attempts: 0, repeat: false },
    ]);
    const chain = await verified(h);
    expect(ofType(chain, "teardown_blocked")).toHaveLength(1);
    expect(ofType(chain, "teardown_stuck")).toHaveLength(1);
    expect(ofType(chain, "teardown_stuck")[0]?.payload).toEqual({ reason: "credentials_unavailable", attempts: 0 });
    expect(chain.findIndex((e) => e.type === "teardown_blocked")).toBeLessThan(
      chain.findIndex((e) => e.type === "teardown_stuck"),
    );
    expect((await h.ports.leases.load(LEASE))?.state).toBe("expired");
    expect(h.notified).toEqual([
      { type: "teardown_stuck", leaseId: LEASE, at: T0, reason: "credentials_unavailable" },
    ]);

    const snapshot = JSON.stringify(chain);
    for (let i = 1; i <= 4; i += 1) {
      expect(await sweep(h, T0 + i * 100)).toEqual([]);
    }
    expect(JSON.stringify(await verified(h))).toBe(snapshot);
    expect(ofType(await verified(h), "teardown_blocked")).toHaveLength(1);
    expect(h.notified).toHaveLength(1);
    expect((await h.ports.leases.load(LEASE))?.state).toBe("expired");
  });

  it("re-announces once for a fresh sweep state, writes no receipt and does not notify", async () => {
    const h = await setup({ seed: false });
    await sweep(h);
    const snapshot = JSON.stringify(await verified(h));
    const notifiedBefore = h.notified.length;

    const fresh = createSweepState();
    expect(await sweep(h, T0 + 10, { state: fresh })).toEqual([
      { kind: "stuck", leaseId: LEASE, reason: "credentials_unavailable", attempts: 0, repeat: true },
    ]);
    expect(await sweep(h, T0 + 20, { state: fresh })).toEqual([]);
    expect(JSON.stringify(await verified(h))).toBe(snapshot);
    expect(h.notified).toHaveLength(notifiedBefore);
  });

  it("tears the lease down normally once the credential is in the store", async () => {
    const h = await setup({ seed: false });
    await sweep(h);
    expect(h.state.announcedStuck.has(LEASE)).toBe(true);

    await seedLeaseCredentials(h.ports, LEASE, {
      "sheets.orders": oauthCredential("https://as.example.test/token", undefined),
    });
    const events = await sweep(h, T0 + 50);

    expect(events.map((e) => e.kind)).toEqual(["torn_down"]);
    expect((await h.ports.leases.load(LEASE))?.state).toBe("cleaned_up");
    expect(h.state.announcedStuck.has(LEASE)).toBe(false);
    expect(ofType(await verified(h), "teardown_stuck")).toHaveLength(1);
  });

  it("retries a cleanup_incomplete lease that went stuck on credentials as soon as they return, without waiting for the backoff", async () => {
    // A lease an earlier pass left cleanup_incomplete before revoke_oauth ran, with its credential gone.
    const h = await setup({ leaseState: "cleanup_incomplete", seed: false });
    await appendReceiptEntry(
      h.ports.receipts(LEASE),
      {
        chain: "verified",
        type: "transition",
        payload: { from: "tearing_down", event: "teardown_incomplete", actor: "runtime", to: "cleanup_incomplete" },
      },
      T0,
    );

    const stuck = await sweep(h, T0 + 60);
    expect(stuck).toEqual([
      { kind: "stuck", leaseId: LEASE, reason: "credentials_unavailable", attempts: 1, repeat: false },
    ]);
    expect(await sweep(h, T0 + 61)).toEqual([]);
    expect(ofType(await verified(h), "teardown_stuck")).toHaveLength(1);

    await seedLeaseCredentials(h.ports, LEASE, {
      "sheets.orders": oauthCredential("https://as.example.test/token", undefined),
    });
    const events = await sweep(h, T0 + 62);
    expect(events.map((e) => e.kind)).toEqual(["retried"]);
    expect((await h.ports.leases.load(LEASE))?.state).toBe("cleaned_up");
    expect(h.state.announcedStuck.has(LEASE)).toBe(false);
  });
});

describe("revocation_failed (user resolution 1)", () => {
  it("marks a cleanup_incomplete lease with a failed revocation stuck and never retries it", async () => {
    const h = await setup();
    h.revokeFails.value = true;
    expect((await sweep(h)).map((e) => e.kind)).toEqual(["torn_down"]);
    expect((await h.ports.leases.load(LEASE))?.state).toBe("cleanup_incomplete");

    const events = await sweep(h, T0 + 1);
    expect(events).toEqual([
      { kind: "stuck", leaseId: LEASE, reason: "revocation_failed", attempts: 1, repeat: false },
    ]);
    expect(ofType(await verified(h), "teardown_stuck")[0]?.payload).toEqual({
      reason: "revocation_failed",
      attempts: 1,
    });
    expect(h.notified).toEqual([
      { type: "teardown_stuck", leaseId: LEASE, at: T0 + 1, reason: "revocation_failed" },
    ]);

    const snapshot = JSON.stringify(await verified(h));
    for (const at of [T0 + 100, T0 + 100_000, T0 + 10_000_000]) {
      expect(await sweep(h, at)).toEqual([]);
    }
    expect(JSON.stringify(await verified(h))).toBe(snapshot);
    expect(transitionEvents(await verified(h))).not.toContain("retry_teardown");
    expect(h.notified).toHaveLength(1);
    expect((await h.ports.leases.load(LEASE))?.state).toBe("cleanup_incomplete");
  });
});

describe("manifest_invalid (user resolution 6)", () => {
  it("marks the lease stuck once, re-checks it without receipts, and tears it down when it verifies again", async () => {
    const h = await setup();
    h.trusted.value = false;

    expect(await sweep(h)).toEqual([
      { kind: "stuck", leaseId: LEASE, reason: "manifest_invalid", attempts: 0, repeat: false },
    ]);
    const chain = await verified(h);
    expect(ofType(chain, "teardown_stuck")).toHaveLength(1);
    expect(ofType(chain, "teardown_stuck")[0]?.payload).toEqual({ reason: "manifest_invalid", attempts: 0 });
    expect(h.notified).toEqual([{ type: "teardown_stuck", leaseId: LEASE, at: T0, reason: "manifest_invalid" }]);

    const snapshot = JSON.stringify(chain);
    for (let i = 1; i <= 3; i += 1) {
      expect(await sweep(h, T0 + i)).toEqual([]);
    }
    expect(JSON.stringify(await verified(h))).toBe(snapshot);
    expect((await h.ports.leases.load(LEASE))?.state).toBe("expired");

    h.trusted.value = true;
    const events = await sweep(h, T0 + 10);
    expect(events.map((e) => e.kind)).toEqual(["torn_down"]);
    expect((await h.ports.leases.load(LEASE))?.state).toBe("cleaned_up");
  });
});

describe("retries_exhausted and notification", () => {
  it("notifies once for the retries_exhausted marking too", async () => {
    const h = await setup({ leaseState: "cleanup_incomplete" });
    for (let i = 0; i < 2; i += 1) {
      await appendReceiptEntry(
        h.ports.receipts(LEASE),
        {
          chain: "verified",
          type: "transition",
          payload: { from: "tearing_down", event: "teardown_incomplete", actor: "runtime", to: "cleanup_incomplete" },
        },
        T0 + i,
      );
    }
    const config: SupervisorConfig = { ...DEFAULT_SUPERVISOR_CONFIG, retryBaseSeconds: 60, retryMaxSeconds: 3600, retryCap: 1 };

    const events = await sweep(h, T0 + 100_000, { config });
    expect(events).toEqual([
      { kind: "stuck", leaseId: LEASE, reason: "retries_exhausted", attempts: 2, repeat: false },
    ]);
    expect(h.notified).toEqual([
      { type: "teardown_stuck", leaseId: LEASE, at: T0 + 100_000, reason: "retries_exhausted" },
    ]);
    expect(await sweep(h, T0 + 200_000, { config })).toEqual([]);
    expect(h.notified).toHaveLength(1);
  });

  it("a notify that rejects changes no outcome", async () => {
    const h = await setup({ seed: false });
    const events = (
      await runSweep(h.ports, {
        decorateSteps: h.decorateSteps,
        state: h.state,
        notify: () => Promise.reject(new Error("host is down")),
      })
    ).events;

    expect(events).toEqual([
      { kind: "stuck", leaseId: LEASE, reason: "credentials_unavailable", attempts: 0, repeat: false },
    ]);
    expect(ofType(await verified(h), "teardown_stuck")).toHaveLength(1);
    expect(await sweep(h, T0 + 1)).toEqual([]);
  });

  it("a notify that throws synchronously changes no outcome", async () => {
    const h = await setup({ seed: false });
    const report = await runSweep(h.ports, {
      decorateSteps: h.decorateSteps,
      notify: () => {
        throw new Error("host is down");
      },
    });
    expect(report.events.map((e) => e.kind)).toEqual(["stuck"]);
    expect(ofType(await verified(h), "teardown_stuck")).toHaveLength(1);
  });
});
