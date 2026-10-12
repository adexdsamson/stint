import { createServer } from "node:http";
import type { Server } from "node:http";

import { credentialSecretKey } from "@stint/core";
import type { LeaseArtifactStore, TelemetryEvent } from "@stint/core";
import { createRecordingTelemetry, makeTestLease } from "@stint/core/testing";
import { appendReceiptEntry, parseStoredCredential } from "@stint/proxy";
import type { SeededCredential } from "@stint/proxy";
import { startMockAuthServer } from "@stint/proxy/testing";
import type { MockAuthHarness } from "@stint/proxy/testing";
import type { ReceiptEntry } from "@stint/spec";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createSweepState,
  runSweep,
  seedLeaseCredentials,
  writeRunHeartbeat,
} from "../src/index.js";
import type { RuntimePorts, SupervisorConfig, SweepEvent, SweepState } from "../src/index.js";
import { DEFAULT_SUPERVISOR_CONFIG } from "../src/index.js";
import { buildRig, delegatedManifest, hostedManifest, oauthCredential } from "./helpers.js";

const LEASE = "lease-probe-1";
const GRANTED_AT = 1000;
const INTERVAL = 900;
const FIRST_DUE = GRANTED_AT + INTERVAL;

interface Harness {
  readonly ports: RuntimePorts;
  readonly now: { value: number };
  readonly state: SweepState;
  readonly telemetry: ReturnType<typeof createRecordingTelemetry>;
}

interface SetupOptions {
  readonly resources?: readonly string[];
  /** Per resource credential; defaults to one OAuth credential per resource at `tokenEndpoint`. */
  readonly credentials?: Record<string, SeededCredential>;
  readonly tokenEndpoint?: string;
  readonly hosted?: boolean;
  readonly leaseState?: "active" | "granted";
  readonly artifacts?: (inner: LeaseArtifactStore) => LeaseArtifactStore;
}

let mock: MockAuthHarness;
const stubs: Server[] = [];

beforeEach(async () => {
  mock = await startMockAuthServer();
});

afterEach(async () => {
  await mock.stop();
  for (const stub of stubs.splice(0)) {
    await new Promise<void>((resolve) => {
      stub.close(() => {
        resolve();
      });
      stub.closeAllConnections();
    });
  }
});

function mockTokenEndpoint(): string {
  return mock.oauthClient.as.token_endpoint ?? "";
}

async function setup(options: SetupOptions = {}): Promise<Harness> {
  const resources = options.resources ?? ["sheets.orders"];
  const rig = await buildRig(LEASE, options.hosted === true ? hostedManifest() : delegatedManifest(resources));
  const telemetry = createRecordingTelemetry();
  const now = { value: GRANTED_AT };
  const ports: RuntimePorts = {
    ...rig.ports,
    clock: () => now.value,
    telemetry,
    ...(options.artifacts === undefined ? {} : { artifacts: options.artifacts(rig.ports.artifacts) }),
  };
  await ports.leases.save(makeTestLease(LEASE, { state: options.leaseState ?? "active", grantedAt: GRANTED_AT }));
  const endpoint = options.tokenEndpoint ?? mockTokenEndpoint();
  const credentials: Record<string, SeededCredential> =
    options.credentials ??
    Object.fromEntries(
      options.hosted === true
        ? []
        : resources.map((resource) => [
            resource,
            oauthCredential(endpoint, undefined, { resourceIndicator: `https://${resource}.example/` }),
          ]),
    );
  await seedLeaseCredentials(ports, LEASE, credentials);
  return { ports, now, state: createSweepState(), telemetry };
}

async function sweep(h: Harness, at: number, config?: Partial<SupervisorConfig>): Promise<readonly SweepEvent[]> {
  h.now.value = at;
  const report = await runSweep(h.ports, {
    state: h.state,
    config: { ...DEFAULT_SUPERVISOR_CONFIG, ...config },
  });
  return report.events;
}

async function chain(h: Harness): Promise<readonly ReceiptEntry[]> {
  return h.ports.receipts(LEASE).load("verified");
}

function transitionTrail(entries: readonly ReceiptEntry[]): { event: string; actor: string }[] {
  return entries
    .filter((entry) => entry.type === "transition")
    .map((entry) => entry.payload as { event: string; actor: string })
    .map(({ event, actor }) => ({ event, actor }));
}

function probeEvents(h: Harness): readonly Extract<TelemetryEvent, { name: "supervisor.probe" }>[] {
  return h.telemetry.events.filter(
    (event): event is Extract<TelemetryEvent, { name: "supervisor.probe" }> => event.name === "supervisor.probe",
  );
}

async function leaseState(h: Harness): Promise<string | undefined> {
  return (await h.ports.leases.load(LEASE))?.state;
}

async function storedRefreshToken(h: Harness, resource: string): Promise<string | undefined> {
  const raw = await h.ports.secrets.get(credentialSecretKey(LEASE, resource));
  if (raw === undefined) return undefined;
  const parsed = parseStoredCredential(raw);
  return parsed === undefined || "key" in parsed ? undefined : parsed.refreshToken;
}

describe("a revoked grant ends an idle lease (SUP-04, D-14)", () => {
  it("receipts grant_revoked (provider) and begin_teardown, then tears the lease down in the same sweep", async () => {
    const h = await setup();
    mock.forceNextTokenError("invalid_grant");

    const events = await sweep(h, FIRST_DUE);

    expect(events.map((e) => e.kind)).toEqual(["grant_revoked", "torn_down"]);
    expect(events[0]).toEqual({ kind: "grant_revoked", leaseId: LEASE });
    expect(transitionTrail(await chain(h))).toEqual([
      { event: "grant_revoked", actor: "provider" },
      { event: "begin_teardown", actor: "runtime" },
      { event: "teardown_succeeded", actor: "runtime" },
    ]);
    expect(await leaseState(h)).toBe("cleaned_up");
    expect(probeEvents(h).map((e) => e.result)).toEqual(["revoked"]);
    expect(
      h.telemetry.events.some((e) => e.name === "supervisor.action" && e.action === "grant_revoked"),
    ).toBe(true);
  });

  it("does not probe again once the lease is cleaned up", async () => {
    const h = await setup();
    mock.forceNextTokenError("invalid_grant");
    await sweep(h, FIRST_DUE);
    const hits = mock.tokenEndpointHits;
    expect(await sweep(h, FIRST_DUE + 5000)).toEqual([]);
    expect(mock.tokenEndpointHits).toBe(hits);
  });
});

describe("schedule adjacency (D-15, D-16)", () => {
  it("probes at exactly one interval after the grant and not one second earlier", async () => {
    const h = await setup();
    expect(await sweep(h, FIRST_DUE - 1)).toEqual([]);
    expect(mock.tokenEndpointHits).toBe(0);
    expect(await sweep(h, FIRST_DUE)).toEqual([]);
    expect(mock.tokenEndpointHits).toBe(1);
  });

  it("counts the newest call receipt as the last activity when it is later than the grant", async () => {
    const h = await setup();
    await appendReceiptEntry(
      h.ports.receipts(LEASE),
      {
        chain: "verified",
        type: "call",
        payload: {
          resource: "sheets.orders",
          argsHash: `jcs-sha256:${"a".repeat(64)}`,
          redactedSummary: 'call to "read" allowed',
          outcome: "allowed",
        },
      },
      1500,
    );
    expect(await sweep(h, 1500 + INTERVAL - 1)).toEqual([]);
    expect(mock.tokenEndpointHits).toBe(0);
    await sweep(h, 1500 + INTERVAL);
    expect(mock.tokenEndpointHits).toBe(1);
  });

  it("does not probe a lease that made a call after the supervisor first scheduled it", async () => {
    const h = await setup();
    await sweep(h, 1100); // first sight: scheduled for FIRST_DUE
    await appendReceiptEntry(
      h.ports.receipts(LEASE),
      {
        chain: "verified",
        type: "call",
        payload: {
          resource: "sheets.orders",
          argsHash: `jcs-sha256:${"b".repeat(64)}`,
          redactedSummary: 'call to "read" allowed',
          outcome: "allowed",
        },
      },
      FIRST_DUE - 10,
    );
    await sweep(h, FIRST_DUE);
    expect(mock.tokenEndpointHits).toBe(0);
    await sweep(h, FIRST_DUE - 10 + INTERVAL);
    expect(mock.tokenEndpointHits).toBe(1);
  });

  it("an ok probe leaves the lease active, persists the rotated refresh token and schedules the next one 900 s later", async () => {
    const h = await setup();
    const before = await storedRefreshToken(h, "sheets.orders");

    expect(await sweep(h, FIRST_DUE)).toEqual([]);

    expect(mock.tokenEndpointHits).toBe(1);
    expect(await leaseState(h)).toBe("active");
    const after = await storedRefreshToken(h, "sheets.orders");
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
    expect(probeEvents(h)).toEqual([
      { name: "supervisor.probe", leaseId: LEASE, result: "ok", nextProbeInSeconds: INTERVAL },
    ]);

    await sweep(h, FIRST_DUE + INTERVAL - 1);
    expect(mock.tokenEndpointHits).toBe(1);
    await sweep(h, FIRST_DUE + INTERVAL);
    expect(mock.tokenEndpointHits).toBe(2);
    expect(await chain(h)).toEqual([]);
  });

  it("probeIntervalSeconds 0 sends nothing for any lease", async () => {
    const h = await setup();
    expect(await sweep(h, FIRST_DUE + 100_000, { probeIntervalSeconds: 0 })).toEqual([]);
    expect(mock.tokenEndpointHits).toBe(0);
    expect(probeEvents(h)).toEqual([]);
  });

  it("a shorter probeIntervalSeconds probes sooner", async () => {
    const h = await setup();
    await sweep(h, GRANTED_AT + 59, { probeIntervalSeconds: 60 });
    expect(mock.tokenEndpointHits).toBe(0);
    await sweep(h, GRANTED_AT + 60, { probeIntervalSeconds: 60 });
    expect(mock.tokenEndpointHits).toBe(1);
  });
});

describe("a transient failure never ends a lease (D-17)", () => {
  async function expectUntouched(h: Harness, events: readonly SweepEvent[], chainBefore: number): Promise<void> {
    expect(events).toEqual([]);
    expect(await leaseState(h)).toBe("active");
    expect((await chain(h)).length).toBe(chainBefore);
  }

  it.each([
    ["a 503", 503],
    ["a 429", 429],
  ])("%s with an invalid_grant body leaves the lease active with no receipt and no event", async (_name, status) => {
    const h = await setup();
    mock.forceNextTokenResponse(status, { error: "invalid_grant" });

    const events = await sweep(h, FIRST_DUE);

    await expectUntouched(h, events, 0);
    expect(mock.tokenEndpointHits).toBe(1);
    expect(probeEvents(h)).toEqual([
      { name: "supervisor.probe", leaseId: LEASE, result: "transient", nextProbeInSeconds: 60 },
    ]);
  });

  it("a network error leaves the lease active with no receipt and no event", async () => {
    const h = await setup({ tokenEndpoint: "http://127.0.0.1:1/token" });
    const events = await sweep(h, FIRST_DUE);
    await expectUntouched(h, events, 0);
    expect(probeEvents(h).map((e) => e.result)).toEqual(["transient"]);
  });

  it("a 200 with an unexpected body leaves the lease active", async () => {
    const h = await setup();
    mock.forceNextTokenResponse(200, { unexpected: true });
    const events = await sweep(h, FIRST_DUE);
    await expectUntouched(h, events, 0);
  });

  it("waits 60 s after the first transient failure: 59 s later nothing, 60 s later a probe", async () => {
    const h = await setup();
    mock.forceNextTokenResponse(503, { error: "temporarily_unavailable" });
    await sweep(h, FIRST_DUE);
    expect(mock.tokenEndpointHits).toBe(1);

    await sweep(h, FIRST_DUE + 59);
    expect(mock.tokenEndpointHits).toBe(1);
    await sweep(h, FIRST_DUE + 60);
    expect(mock.tokenEndpointHits).toBe(2);
    expect(await leaseState(h)).toBe("active");
  });

  it("doubles the wait with each consecutive failure, up to the probe interval", async () => {
    const h = await setup();
    let at = FIRST_DUE;
    const waits: number[] = [];
    for (let failure = 1; failure <= 6; failure += 1) {
      mock.forceNextTokenResponse(503, { error: "temporarily_unavailable" });
      await sweep(h, at);
      const last = probeEvents(h).at(-1);
      waits.push(last?.nextProbeInSeconds ?? -1);
      at += last?.nextProbeInSeconds ?? 0;
    }
    expect(waits).toEqual([60, 120, 240, 480, 900, 900]);
  });

  it("a success after failures resets the backoff", async () => {
    const h = await setup();
    mock.forceNextTokenResponse(503, { error: "temporarily_unavailable" });
    await sweep(h, FIRST_DUE);
    await sweep(h, FIRST_DUE + 60); // ok
    expect(probeEvents(h).map((e) => e.result)).toEqual(["transient", "ok"]);
    mock.forceNextTokenResponse(503, { error: "temporarily_unavailable" });
    await sweep(h, FIRST_DUE + 60 + INTERVAL);
    expect(probeEvents(h).at(-1)?.nextProbeInSeconds).toBe(60);
  });

  it("honours Retry-After: a 429 with Retry-After 300 delays the next probe to 300 s", async () => {
    let hits = 0;
    const stub = createServer((_req, res) => {
      hits += 1;
      res.writeHead(429, { "content-type": "application/json", "retry-after": "300" });
      res.end(JSON.stringify({ error: "invalid_grant" }));
    });
    stubs.push(stub);
    await new Promise<void>((resolve) => {
      stub.listen(0, "127.0.0.1", resolve);
    });
    const address = stub.address();
    if (address === null || typeof address === "string") throw new Error("no stub address");
    const h = await setup({ tokenEndpoint: `http://127.0.0.1:${String(address.port)}/token` });

    await sweep(h, FIRST_DUE);
    expect(hits).toBe(1);
    expect(probeEvents(h)).toEqual([
      { name: "supervisor.probe", leaseId: LEASE, result: "transient", nextProbeInSeconds: 300 },
    ]);

    await sweep(h, FIRST_DUE + 299);
    expect(hits).toBe(1);
    await sweep(h, FIRST_DUE + 300);
    expect(hits).toBe(2);
    expect(await leaseState(h)).toBe("active");
  });
});

describe("nothing probeable (D-16)", () => {
  it("never sends an API-key-only lease to the token endpoint", async () => {
    const h = await setup({ credentials: { "sheets.orders": { kind: "api_key", key: "k-1" } } });
    expect(await sweep(h, FIRST_DUE + 10_000)).toEqual([]);
    expect(mock.tokenEndpointHits).toBe(0);
    expect(await leaseState(h)).toBe("active");
    expect(probeEvents(h).map((e) => e.result)).toEqual(["not_probeable"]);
  });

  it("never sends a credential with an empty refresh token", async () => {
    const h = await setup({
      credentials: { "sheets.orders": oauthCredential(mockTokenEndpoint(), undefined, { refreshToken: "" }) },
    });
    expect(await sweep(h, FIRST_DUE)).toEqual([]);
    expect(mock.tokenEndpointHits).toBe(0);
    expect(await leaseState(h)).toBe("active");
  });

  it("never ends a lease that recorded no credential", async () => {
    const h = await setup({ credentials: {} });
    expect(await sweep(h, FIRST_DUE)).toEqual([]);
    expect(mock.tokenEndpointHits).toBe(0);
    expect(await leaseState(h)).toBe("active");
  });

  it("never ends a hosted lease with no delegated credential", async () => {
    const h = await setup({ hosted: true });
    expect(await sweep(h, FIRST_DUE)).toEqual([]);
    expect(mock.tokenEndpointHits).toBe(0);
    expect(await leaseState(h)).toBe("active");
  });
});

describe("ordering (D-16)", () => {
  it("probes credentials in ascending resource order and stops at the first revocation", async () => {
    const h = await setup({ resources: ["b.res", "a.res"] });
    mock.forceNextTokenError("invalid_grant");

    const events = await sweep(h, FIRST_DUE);

    expect(mock.tokenEndpointHits).toBe(1);
    expect(mock.lastTokenRequestBody?.resource).toBe("https://a.res.example/");
    expect(events.map((e) => e.kind)).toEqual(["grant_revoked", "torn_down"]);
  });

  it("probes every credential when none is revoked", async () => {
    const h = await setup({ resources: ["b.res", "a.res"] });
    await sweep(h, FIRST_DUE);
    expect(mock.tokenEndpointHits).toBe(2);
    expect(await leaseState(h)).toBe("active");
  });
});

describe("a live run is never probed (D-18)", () => {
  it("a heartbeat 10 s old suppresses the probe and leaves the schedule alone", async () => {
    const h = await setup();
    await writeRunHeartbeat(h.ports.artifacts, LEASE, { v: 1, beatAt: FIRST_DUE - 10 });
    expect(await sweep(h, FIRST_DUE)).toEqual([]);
    expect(mock.tokenEndpointHits).toBe(0);
    expect(probeEvents(h).map((e) => e.result)).toEqual(["skipped"]);

    // The beat is exactly 45 s old at FIRST_DUE + 35 (live), 46 s old a second later (not live).
    await sweep(h, FIRST_DUE + 35);
    expect(mock.tokenEndpointHits).toBe(0);
    await sweep(h, FIRST_DUE + 36);
    expect(mock.tokenEndpointHits).toBe(1);
  });

  it("a heartbeat 46 s old allows the probe, and so does one with endedAt", async () => {
    const stale = await setup();
    await writeRunHeartbeat(stale.ports.artifacts, LEASE, { v: 1, beatAt: FIRST_DUE - 46 });
    await sweep(stale, FIRST_DUE);
    expect(mock.tokenEndpointHits).toBe(1);

    const ended = await setup();
    await writeRunHeartbeat(ended.ports.artifacts, LEASE, { v: 1, beatAt: FIRST_DUE - 1, endedAt: FIRST_DUE - 1 });
    await sweep(ended, FIRST_DUE);
    expect(mock.tokenEndpointHits).toBe(2);
  });

  it("a run that starts between the outside check and the lease transaction suppresses the probe", async () => {
    let heartbeatReads = 0;
    const h = await setup({
      artifacts: (inner) => ({
        put: (leaseId, name, value) => inner.put(leaseId, name, value),
        get: async (leaseId, name) => {
          if (name !== "run_heartbeat") return inner.get(leaseId, name);
          heartbeatReads += 1;
          // First read (outside the transaction): no run. Later reads: a run just started.
          return heartbeatReads === 1 ? undefined : { v: 1, beatAt: FIRST_DUE };
        },
      }),
    });

    expect(await sweep(h, FIRST_DUE)).toEqual([]);

    expect(heartbeatReads).toBeGreaterThanOrEqual(2);
    expect(mock.tokenEndpointHits).toBe(0);
    expect(await leaseState(h)).toBe("active");
    expect(probeEvents(h).map((e) => e.result)).toEqual(["skipped"]);
  });
});

describe("only an active, unexpired, unstuck lease is probed", () => {
  it("never probes a granted lease", async () => {
    const h = await setup({ leaseState: "granted" });
    await sweep(h, FIRST_DUE + 10_000);
    expect(mock.tokenEndpointHits).toBe(0);
  });

  it("never probes a lease that carries a stuck marker", async () => {
    const h = await setup();
    await appendReceiptEntry(
      h.ports.receipts(LEASE),
      { chain: "verified", type: "teardown_stuck", payload: { reason: "revocation_failed", attempts: 1 } },
      GRANTED_AT,
    );
    await sweep(h, FIRST_DUE);
    expect(mock.tokenEndpointHits).toBe(0);
  });

  it("an expired lease is settled and torn down, not probed", async () => {
    const h = await setup();
    await h.ports.leases.save(makeTestLease(LEASE, { state: "active", grantedAt: GRANTED_AT, expiresAt: FIRST_DUE }));
    const events = await sweep(h, FIRST_DUE);
    expect(events.map((e) => e.kind)).toEqual(["expired", "torn_down"]);
    expect(mock.tokenEndpointHits).toBe(0);
  });

  it("skips the probe without a receipt when the manifest no longer verifies", async () => {
    const h = await setup();
    const withoutTrust: RuntimePorts = { ...h.ports, trust: () => Promise.resolve({}) };
    h.now.value = FIRST_DUE;
    const report = await runSweep(withoutTrust, { state: h.state });
    expect(report.events).toEqual([]);
    expect(mock.tokenEndpointHits).toBe(0);
    expect(await chain(h)).toEqual([]);
    expect(await leaseState(h)).toBe("active");
  });
});
