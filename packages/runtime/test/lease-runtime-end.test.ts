/**
 * A served lease ends and tears itself down (Phase 9 D-06 to D-08, D-18, SUP-01, SUP-04): the run
 * watches its own lease, settles expiry by its own clock, tears the lease down under the fence,
 * publishes its heartbeat and probes its own idle grant. No supervisor runs in any of these tests.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createBindingSet, credentialSecretKey, reduce, userEvents } from "@stint/core";
import type { HostAdapter, Lease, LeaseArtifactStore, TelemetryEvent } from "@stint/core";
import { createRecordingTelemetry, makeTestLease } from "@stint/core/testing";
import { appendTransitionReceipt, createToolCatalog } from "@stint/proxy";
import type { FetchLike } from "@stint/proxy";
import { startMockAuthServer } from "@stint/proxy/testing";
import type { MockAuthHarness } from "@stint/proxy/testing";
import { hashManifest } from "@stint/spec";
import type { ReceiptEntry, VerifiedManifest } from "@stint/spec";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createLeaseRuntime, loadLeaseManifest, seedLeaseCredentials } from "../src/index.js";
import type { LeaseEnded, RunProfile, RunningLease, RuntimePorts } from "../src/index.js";
import { buildRig, delegatedManifest, oauthCredential } from "./helpers.js";

const LEASE = "lease-end-1";
const ORDERS = "sheets.orders";
const GRANTED_AT = 1000;
const EXPIRES_AT = 3000;
const WATCH_MS = 20;

let mock: MockAuthHarness;
const cleanups: Array<() => Promise<void>> = [];

beforeEach(async () => {
  mock = await startMockAuthServer();
});

afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
  await mock.stop();
});

const adapter: HostAdapter = {
  requestConsent: () => Promise.reject(new Error("unused")),
  requestApproval: () => Promise.reject(new Error("unused")),
  requestOutcomeConfirmation: () => Promise.reject(new Error("unused")),
  notify: () => Promise.resolve(),
};

function profileFor(): RunProfile {
  return {
    catalog: createToolCatalog([
      {
        name: "read_orders",
        description: "Reads the order sheet",
        inputSchema: { type: "object", properties: {}, required: [] },
      },
    ]),
    bindings: createBindingSet([
      { tool: "read_orders", resource: ORDERS, access: "read", irreversible: false, provenance: "built_in" },
    ]),
    oauth: mock.oauthClient,
  };
}

interface Live {
  readonly ports: RuntimePorts;
  readonly now: { value: number };
  readonly verified: VerifiedManifest;
  readonly events: ReturnType<typeof createRecordingTelemetry>;
  /** Every artifact write the run made, in order: `[name, value]`. */
  readonly writes: Array<readonly [string, unknown]>;
  /** How the lease store's `load` and the artifact store's `put` behave; flipped by a test after the run started. */
  readonly switches: { loads: "ok" | "fail" | "missing"; puts: "ok" | "fail" };
  start(opts?: { readonly leaseWatchMs?: number; readonly probeIntervalSeconds?: number }): Promise<{
    client: Client;
    running: RunningLease;
  }>;
}

interface SetupOptions {
  readonly lease?: Partial<Lease>;
  readonly seed?: boolean;
  readonly clockAt?: number;
}

async function setup(options: SetupOptions = {}): Promise<Live> {
  const manifest = delegatedManifest([ORDERS]);
  const rig = await buildRig(LEASE, manifest);
  const events = createRecordingTelemetry();
  const now = { value: options.clockAt ?? 2000 };
  const writes: Array<readonly [string, unknown]> = [];
  const switches: Live["switches"] = { loads: "ok", puts: "ok" };
  const inner: LeaseArtifactStore = rig.ports.artifacts;
  const artifacts: LeaseArtifactStore = {
    get: (id, name) => inner.get(id, name),
    put: (id, name, value) => {
      if (switches.puts === "fail") return Promise.reject(new Error("disk full"));
      writes.push([name, value]);
      return inner.put(id, name, value);
    },
  };
  const leases = rig.ports.leases;
  const ports: RuntimePorts = {
    ...rig.ports,
    clock: () => now.value,
    telemetry: events,
    artifacts,
    leases: {
      ...leases,
      load: (id) => {
        if (switches.loads === "fail") return Promise.reject(new Error("store offline"));
        return switches.loads === "missing" ? Promise.resolve(undefined) : leases.load(id);
      },
      transaction: (id, mutator) => leases.transaction(id, mutator),
    },
  };
  await leases.save(
    makeTestLease(LEASE, {
      boundHash: hashManifest(manifest),
      grantedAt: GRANTED_AT,
      expiresAt: EXPIRES_AT,
      ...options.lease,
    }),
  );
  if (options.seed !== false) {
    await seedLeaseCredentials(ports, LEASE, {
      [ORDERS]: oauthCredential(mock.oauthClient.as.token_endpoint ?? "", mock.oauthClient.as.revocation_endpoint),
    });
  }
  const verified = await loadLeaseManifest(rig.ports, LEASE);
  const outboundFetch: FetchLike = () => Promise.resolve(new Response(JSON.stringify({ rows: [] }), { status: 200 }));
  return {
    ports,
    now,
    verified,
    events,
    writes,
    switches,
    async start(opts = {}) {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const running = await createLeaseRuntime(ports, {
        leaseId: LEASE,
        transport: serverTransport,
        adapter,
        verified,
        profile: profileFor(),
        outboundFetch,
        leaseWatchMs: opts.leaseWatchMs ?? WATCH_MS,
        probeIntervalSeconds: opts.probeIntervalSeconds ?? 0,
      });
      const client = new Client({ name: "agent", version: "0.0.0" });
      await client.connect(clientTransport);
      cleanups.push(async () => {
        await client.close().catch(() => undefined);
        await running.close();
      });
      return { client, running };
    },
  };
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

async function until(condition: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 300; i += 1) {
    if (await condition()) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Resolves with the sentinel when `promise` has not settled within `ms`. */
async function pendingFor<T>(promise: Promise<T>, ms: number): Promise<T | "pending"> {
  return await Promise.race([promise, sleep(ms).then((): "pending" => "pending")]);
}

async function callRead(client: Client): Promise<CallToolResult> {
  return (await client.callTool({ name: "read_orders", arguments: {} })) as CallToolResult;
}

async function transitionEvents(live: Live): Promise<string[]> {
  const chain: readonly ReceiptEntry[] = await live.ports.receipts(LEASE).load("verified");
  return chain
    .filter((entry) => entry.type === "transition")
    .map((entry) => (entry.payload as { event: string }).event);
}

async function stored(live: Live): Promise<Lease | undefined> {
  return await live.ports.leases.load(LEASE);
}

describe("a run ends and tears down its own lease (D-06, D-07, SUP-01)", () => {
  it("notices an idle expiry, settles it by its own clock and tears the lease down to cleaned_up", async () => {
    const live = await setup();
    const { running } = await live.start();

    live.now.value = EXPIRES_AT;
    const ended = await running.ended;

    expect(ended).toEqual({ reason: "expired", teardown: "cleaned_up" });
    expect(await transitionEvents(live)).toEqual(["expire", "begin_teardown", "teardown_succeeded"]);
    const lease = await stored(live);
    expect(lease?.state).toBe("cleaned_up");
    expect(lease?.fence).toEqual({ epoch: 1, expiresAt: 0 });
    expect(mock.revokeHits).toBe(1);
    await running.closed;
    // The clock jumped 1000 s, so the tick that noticed the expiry also beat once; the end then stamped endedAt.
    expect(await live.ports.artifacts.get(LEASE, "run_heartbeat")).toEqual({
      v: 1,
      beatAt: EXPIRES_AT,
      endedAt: EXPIRES_AT,
    });
  });

  it("does not end a lease one second before it expires", async () => {
    const live = await setup();
    const { running } = await live.start();

    live.now.value = EXPIRES_AT - 1;
    await sleep(150);

    expect(await pendingFor(running.ended, 10)).toBe("pending");
    expect((await stored(live))?.state).toBe("active");
  });

  it("ends and tears down a lease another process revoked", async () => {
    const live = await setup();
    const { running } = await live.start();

    await live.ports.leases.transaction(LEASE, async (lease) => {
      const result = reduce(lease, userEvents.revoke(), live.now.value);
      if (!result.ok) throw new Error("revoke refused");
      await appendTransitionReceipt(live.ports.receipts(LEASE), result.value.transition, live.now.value);
      return result.value.lease;
    });

    expect(await running.ended).toEqual({ reason: "revoked", teardown: "cleaned_up" });
    expect(await transitionEvents(live)).toEqual(["revoke", "begin_teardown", "teardown_succeeded"]);
    expect((await stored(live))?.state).toBe("cleaned_up");
  });

  it.each([
    ["completed", "completed"],
    ["failed", "failed"],
  ] as const)("ends and tears down a lease another process moved to %s", async (state, reason) => {
    const live = await setup();
    const { running } = await live.start();

    await live.ports.leases.transaction(LEASE, (lease) => Promise.resolve({ ...lease, state }));

    expect(await running.ended).toEqual({ reason, teardown: "cleaned_up" });
  });

  it("reports unavailable and runs nothing when the lease record is gone", async () => {
    const live = await setup();
    const { running } = await live.start();

    live.switches.loads = "missing";

    expect(await running.ended).toEqual({ reason: "unavailable", teardown: "not_run" });
    expect(mock.revokeHits).toBe(0);
  });
});

describe("another driver owns the teardown (D-06, D-09)", () => {
  async function tearingDown(live: Live, fence: Lease["fence"]): Promise<void> {
    await live.ports.leases.transaction(LEASE, async (lease) => {
      await appendTransitionReceipt(
        live.ports.receipts(LEASE),
        { from: "revoked", event: "begin_teardown", actor: "runtime", to: "tearing_down", at: live.now.value },
        live.now.value,
      );
      return { ...lease, state: "tearing_down", teardownProgress: {}, ...(fence === undefined ? {} : { fence }) };
    });
  }

  it("does not wait and runs no step when another epoch holds a live fence; the stored fence is unchanged", async () => {
    const live = await setup();
    const { running } = await live.start();
    const fence = { epoch: 7, expiresAt: live.now.value + 100 };

    await tearingDown(live, fence);
    const ended = await running.ended;

    expect(ended).toEqual({ reason: "revoked", teardown: "other_driver" });
    expect((await stored(live))?.fence).toEqual(fence);
    expect((await stored(live))?.state).toBe("tearing_down");
    expect(mock.revokeHits).toBe(0);
    expect(await live.ports.secrets.get(credentialSecretKey(LEASE, ORDERS))).toBeDefined();
    expect(live.events.events.some((e) => e.name === "teardown.step")).toBe(false);
  });

  it("leaves a lease another driver already landed alone", async () => {
    const live = await setup();
    const { running } = await live.start();

    await live.ports.leases.transaction(LEASE, async (lease) => {
      await appendTransitionReceipt(
        live.ports.receipts(LEASE),
        { from: "expired", event: "begin_teardown", actor: "runtime", to: "tearing_down", at: live.now.value },
        live.now.value,
      );
      return { ...lease, state: "cleaned_up", teardownProgress: {} };
    });

    expect(await running.ended).toEqual({ reason: "expired", teardown: "other_driver" });
    expect(mock.revokeHits).toBe(0);
  });

  it("takes over a tearing_down lease whose fence has lapsed", async () => {
    const live = await setup();
    const { running } = await live.start();

    await tearingDown(live, { epoch: 3, expiresAt: live.now.value - 1 });

    expect(await running.ended).toEqual({ reason: "revoked", teardown: "cleaned_up" });
    expect((await stored(live))?.fence).toEqual({ epoch: 4, expiresAt: 0 });
  });
});

describe("a blocked teardown (TEAR-07)", () => {
  it("reports blocked with the missing resource and leaves the lease for cleanup", async () => {
    const live = await setup({ seed: false });
    const { running } = await live.start();

    live.now.value = EXPIRES_AT;
    const ended = await running.ended;

    expect(ended).toEqual({ reason: "expired", teardown: "blocked", blockedResources: [ORDERS] });
    expect((await stored(live))?.state).toBe("expired");
    expect(mock.revokeHits).toBe(0);
  });
});

describe("the run heartbeat (D-18)", () => {
  async function heartbeat(live: Live): Promise<unknown> {
    return await live.ports.artifacts.get(LEASE, "run_heartbeat");
  }

  it("writes one when the run starts, rewrites it every 10 s and not before", async () => {
    const live = await setup();
    await live.start();
    expect(await heartbeat(live)).toEqual({ v: 1, beatAt: 2000 });

    live.now.value = 2009;
    await sleep(150);
    expect(await heartbeat(live)).toEqual({ v: 1, beatAt: 2000 });

    live.now.value = 2010;
    await until(async () => ((await heartbeat(live)) as { beatAt: number }).beatAt === 2010, "the 10 s beat");
    expect(await heartbeat(live)).toEqual({ v: 1, beatAt: 2010 });
  });

  it("writes endedAt on close(), stops writing and leaves ended pending", async () => {
    const live = await setup();
    const { running } = await live.start();

    await running.close();
    expect(await heartbeat(live)).toEqual({ v: 1, beatAt: 2000, endedAt: 2000 });
    const writesAfterClose = live.writes.length;

    live.now.value = 2500;
    await sleep(150);

    expect(live.writes.length).toBe(writesAfterClose);
    expect(await pendingFor(running.ended, 10)).toBe("pending");
    await running.closed;
  });

  it("stops the watcher when the agent disconnects, and the host's close() then writes endedAt", async () => {
    const live = await setup();
    const { client, running } = await live.start();

    await client.close();
    await running.closed;
    const writesAfterDisconnect = live.writes.length;
    live.now.value = 2500;
    await sleep(150);

    expect(live.writes.length).toBe(writesAfterDisconnect);
    expect(await pendingFor(running.ended, 10)).toBe("pending");

    await running.close();
    expect(await heartbeat(live)).toEqual({ v: 1, beatAt: 2000, endedAt: 2500 });
  });

  it("a failing artifact write never stops the run", async () => {
    const live = await setup();
    const { running } = await live.start();

    live.switches.puts = "fail";
    live.now.value = 2015;
    await sleep(150);
    expect(await pendingFor(running.ended, 10)).toBe("pending");

    live.now.value = EXPIRES_AT;
    expect(await running.ended).toEqual({ reason: "expired", teardown: "cleaned_up" });
  });
});

describe("a failing tick never escapes the timer (T-09-37)", () => {
  it("survives a store that cannot be read and ends the lease once it can", async () => {
    const live = await setup();
    const { running } = await live.start();

    live.switches.loads = "fail";
    live.now.value = EXPIRES_AT;
    await sleep(150);
    expect(await pendingFor(running.ended, 10)).toBe("pending");

    live.switches.loads = "ok";
    expect(await running.ended).toEqual({ reason: "expired", teardown: "cleaned_up" });
  });
});

describe("after the end", () => {
  it("closes the agent connection, so a later call fails", async () => {
    const live = await setup();
    const { client, running } = await live.start();
    expect((await callRead(client)).isError).not.toBe(true);

    live.now.value = EXPIRES_AT;
    await running.ended;
    await running.closed;

    await expect(callRead(client)).rejects.toThrow();
  });

  it("runs teardown only once however many ticks pass", async () => {
    const live = await setup();
    const { running } = await live.start();

    live.now.value = EXPIRES_AT;
    await running.ended;
    await sleep(120);

    expect(mock.revokeHits).toBe(1);
    expect(await transitionEvents(live)).toEqual(["expire", "begin_teardown", "teardown_succeeded"]);
  });
});

describe("the run probes its own idle grant (D-18, SUP-04)", () => {
  const INTERVAL = 60;

  it("ends the lease when the provider revoked the grant", async () => {
    const live = await setup({ clockAt: GRANTED_AT });
    const { running } = await live.start({ probeIntervalSeconds: INTERVAL });
    mock.forceNextTokenError("invalid_grant");

    live.now.value = GRANTED_AT + INTERVAL;
    const ended: LeaseEnded = await running.ended;

    expect(ended).toEqual({ reason: "revoked", teardown: "cleaned_up" });
    expect(await transitionEvents(live)).toEqual(["grant_revoked", "begin_teardown", "teardown_succeeded"]);
    expect(mock.tokenEndpointHits).toBe(1);
  });

  it("sends nothing one second before the interval", async () => {
    const live = await setup({ clockAt: GRANTED_AT });
    await live.start({ probeIntervalSeconds: INTERVAL });

    live.now.value = GRANTED_AT + INTERVAL - 1;
    await sleep(150);

    expect(mock.tokenEndpointHits).toBe(0);
  });

  it("counts an allowed call as activity: no token request before the call time plus the interval", async () => {
    const live = await setup({ clockAt: GRANTED_AT });
    const { client, running } = await live.start({ probeIntervalSeconds: INTERVAL });

    live.now.value = GRANTED_AT + 50;
    expect((await callRead(client)).isError).not.toBe(true);
    live.now.value = GRANTED_AT + 50 + INTERVAL - 1;
    await sleep(150);
    expect(mock.tokenEndpointHits).toBe(0);

    live.now.value = GRANTED_AT + 50 + INTERVAL;
    await until(() => mock.tokenEndpointHits === 1, "the probe");
    expect((await stored(live))?.state).toBe("active");
    expect(await pendingFor(running.ended, 10)).toBe("pending");
  });

  it("probeIntervalSeconds 0 never probes", async () => {
    const live = await setup({ clockAt: GRANTED_AT });
    await live.start({ probeIntervalSeconds: 0 });

    live.now.value = GRANTED_AT + 100_000;
    await sleep(150);

    expect(mock.tokenEndpointHits).toBe(0);
  });

  it("a 503 leaves the lease active and the run serving, and the next probe waits 60 s", async () => {
    const live = await setup({ clockAt: GRANTED_AT, lease: { expiresAt: 999_999_999 } });
    const { client, running } = await live.start({ probeIntervalSeconds: 900 });
    mock.forceNextTokenResponse(503, { error: "invalid_grant" });

    live.now.value = GRANTED_AT + 900;
    await until(() => mock.tokenEndpointHits === 1, "the probe");
    await sleep(100);

    expect((await stored(live))?.state).toBe("active");
    expect(await transitionEvents(live)).toEqual([]);
    expect(await pendingFor(running.ended, 10)).toBe("pending");

    live.now.value = GRANTED_AT + 900 + 59;
    await sleep(100);
    expect(mock.tokenEndpointHits).toBe(1);
    live.now.value = GRANTED_AT + 900 + 60;
    await until(() => mock.tokenEndpointHits === 2, "the retry");

    expect((await stored(live))?.state).toBe("active");
    expect((await callRead(client)).isError).not.toBe(true);
  });

  it("probes by default every 900 s", async () => {
    const live = await setup({ clockAt: GRANTED_AT, lease: { expiresAt: 999_999_999 } });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const running = await createLeaseRuntime(live.ports, {
      leaseId: LEASE,
      transport: serverTransport,
      adapter,
      verified: live.verified,
      profile: profileFor(),
      leaseWatchMs: WATCH_MS,
    });
    const client = new Client({ name: "agent", version: "0.0.0" });
    await client.connect(clientTransport);
    cleanups.push(async () => {
      await client.close().catch(() => undefined);
      await running.close();
    });

    live.now.value = GRANTED_AT + 899;
    await sleep(120);
    expect(mock.tokenEndpointHits).toBe(0);
    live.now.value = GRANTED_AT + 900;
    await until(() => mock.tokenEndpointHits === 1, "the default probe");
  });
});

describe("telemetry stays an observer", () => {
  it("emits the teardown transition events the run performed", async () => {
    const live = await setup();
    const { running } = await live.start();

    live.now.value = EXPIRES_AT;
    await running.ended;

    const names = live.events.events.map((e: TelemetryEvent) => e.name);
    expect(names).toContain("lease.transition");
  });
});
