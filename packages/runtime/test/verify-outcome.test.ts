/**
 * 10-06 Task 1 (CLI-03): `runOutcomeCheck`, the one shared evaluation of a
 * lease's verifier. It serves a standalone caller (the `verify-outcome`
 * command) and a live run's `verifyOutcome()` through the same path, over
 * `resource_query` (the connector-computed verdict rows) and `user_confirm`
 * (the terminal adapter), and refuses `none` and a lease that is not active.
 */

import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createBindingSet } from "@stint/core";
import type { HostAdapter, OutcomeConfirmDecision, OutcomeConfirmRequest } from "@stint/core";
import { makeTestLease } from "@stint/core/testing";
import { createToolCatalog, verdictRowAdapter } from "@stint/proxy";
import type { FetchLike } from "@stint/proxy";
import { startMockAuthServer } from "@stint/proxy/testing";
import type { MockAuthHarness } from "@stint/proxy/testing";
import { hashManifest } from "@stint/spec";
import type { Manifest } from "@stint/spec";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RuntimeError, createLeaseRuntime, loadLeaseManifest, runOutcomeCheck, seedLeaseCredentials } from "../src/index.js";
import type { RunProfile } from "../src/index.js";
import { buildRig, delegatedManifest, oauthCredential } from "./helpers.js";
import type { Rig } from "./helpers.js";

const LEASE = "lease-outcome-1";
const ORDERS = "sheets.orders";
const PREDICATE = "exists(rows where verdict = 'confirmed') >= 1";
const PROMPT = "Did the reconciliation finish?";

let mock: MockAuthHarness;
beforeEach(async () => {
  mock = await startMockAuthServer();
});
afterEach(async () => {
  await mock.stop();
});

function resourceQueryManifest(): Manifest {
  const base = delegatedManifest([ORDERS]);
  return {
    ...base,
    job: {
      description: base.job.description,
      verifier: { type: "resource_query", resource: ORDERS, predicate: PREDICATE },
    },
  };
}

function userConfirmManifest(): Manifest {
  const base = delegatedManifest([ORDERS]);
  return { ...base, job: { description: base.job.description, verifier: { type: "user_confirm", prompt: PROMPT } } };
}

function verdictProfile(): RunProfile {
  return {
    catalog: createToolCatalog([
      { name: "read_orders", description: "Reads orders", inputSchema: { type: "object", properties: {}, required: [] } },
    ]),
    bindings: createBindingSet([
      {
        tool: "read_orders",
        resource: ORDERS,
        access: "read",
        irreversible: false,
        provenance: "built_in",
        rowAdapter: verdictRowAdapter,
      },
    ]),
    oauth: mock.oauthClient,
  };
}

interface ScriptedAdapter extends HostAdapter {
  readonly requests: OutcomeConfirmRequest[];
}

/** An adapter that answers the outcome prompt from `answer` and records what it was asked. */
function scripted(answer: () => Promise<OutcomeConfirmDecision>): ScriptedAdapter {
  const requests: OutcomeConfirmRequest[] = [];
  return {
    requests,
    requestConsent: () => Promise.reject(new Error("unused")),
    requestApproval: () => Promise.reject(new Error("unused")),
    requestOutcomeConfirmation: (request) => {
      requests.push(request);
      return answer();
    },
    notify: () => Promise.resolve(),
  };
}

const confirm = (): Promise<OutcomeConfirmDecision> => Promise.resolve({ decision: "confirm" });
const reject = (): Promise<OutcomeConfirmDecision> => Promise.resolve({ decision: "reject", reason: "user_rejected" });
const unusedAdapter: HostAdapter = scripted(() => Promise.reject(new Error("unused")));

/** A fetch double answering the verify-connector row shape the verdict adapter reads. */
function verdictFetch(verdict: string): { readonly fetchImpl: FetchLike; readonly calls: () => number } {
  let calls = 0;
  const fetchImpl: FetchLike = () => {
    calls += 1;
    return Promise.resolve(new Response(JSON.stringify({ rows: [{ verdict }] }), { status: 200 }));
  };
  return { fetchImpl, calls: () => calls };
}

async function setup(manifest: Manifest, state: "active" | "expired" = "active"): Promise<Rig> {
  const rig = await buildRig(LEASE, manifest);
  await rig.ports.leases.save(makeTestLease(LEASE, { state, boundHash: hashManifest(manifest) }));
  const { token_endpoint, revocation_endpoint } = mock.oauthClient.as;
  await seedLeaseCredentials(rig.ports, LEASE, {
    [ORDERS]: oauthCredential(token_endpoint ?? "", revocation_endpoint),
  });
  return rig;
}

async function chainShape(rig: Rig): Promise<string[]> {
  const chain = await rig.ports.receipts(LEASE).load("verified");
  return chain.flatMap((entry) => {
    const payload = entry.payload as { event?: string; outcome?: string; redactedSummary?: string; resource?: string };
    if (entry.type === "transition") return [`transition:${payload.event ?? "?"}`];
    if (entry.type === "call") return [`call:${payload.resource ?? "?"}:${payload.outcome ?? "?"}`];
    return [];
  });
}

const signal = (): AbortSignal => new AbortController().signal;

describe("runOutcomeCheck: resource_query", () => {
  it("a confirmed verdict completes the lease: verification receipt, outcome_verified, begin_teardown", async () => {
    const rig = await setup(resourceQueryManifest());
    const { fetchImpl } = verdictFetch("confirmed");

    const result = await runOutcomeCheck(rig.ports, {
      leaseId: LEASE,
      profile: verdictProfile(),
      adapter: unusedAdapter,
      signal: signal(),
      outboundFetch: fetchImpl,
    });

    expect(result).toMatchObject({ kind: "resource_query", outcome: "true", verdict: "confirmed" });
    expect(["completed", "tearing_down", "cleaned_up"]).toContain(result.lease.state);
    expect(result.lease.state).toBe("cleaned_up");
    const shape = await chainShape(rig);
    expect(shape.slice(0, 3)).toEqual([`call:${ORDERS}:allowed`, "transition:outcome_verified", "transition:begin_teardown"]);
    expect(mock.revokeHits).toBe(1);
  });

  it("a not_success verdict leaves the lease active with exactly one denied receipt", async () => {
    const rig = await setup(resourceQueryManifest());
    const { fetchImpl } = verdictFetch("not_success");

    const result = await runOutcomeCheck(rig.ports, {
      leaseId: LEASE,
      profile: verdictProfile(),
      adapter: unusedAdapter,
      signal: signal(),
      outboundFetch: fetchImpl,
    });

    expect(result).toMatchObject({ kind: "resource_query", outcome: "false", verdict: "not_success" });
    expect(result.lease.state).toBe("active");
    expect(await chainShape(rig)).toEqual([`call:${ORDERS}:denied`]);
  });

  it("a read error is outcome error with no verdict, a denied verification_read_error receipt and an active lease", async () => {
    const rig = await setup(resourceQueryManifest());
    const fetchImpl: FetchLike = () => Promise.reject(new Error("connection reset"));

    const result = await runOutcomeCheck(rig.ports, {
      leaseId: LEASE,
      profile: verdictProfile(),
      adapter: unusedAdapter,
      signal: signal(),
      outboundFetch: fetchImpl,
    });

    expect(result.kind).toBe("resource_query");
    expect(result.outcome).toBe("error");
    expect("verdict" in result).toBe(false);
    expect(result.lease.state).toBe("active");
    const chain = await rig.ports.receipts(LEASE).load("verified");
    expect(chain).toHaveLength(1);
    expect(JSON.stringify(chain[0]?.payload)).toContain("verification_read_error");
  });

  it("a resource_query verifier with no profile is a usage error and calls nothing", async () => {
    const rig = await setup(resourceQueryManifest());
    const { fetchImpl, calls } = verdictFetch("confirmed");

    const error = await runOutcomeCheck(rig.ports, {
      leaseId: LEASE,
      adapter: unusedAdapter,
      signal: signal(),
      outboundFetch: fetchImpl,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RuntimeError);
    expect((error as RuntimeError).code).toBe("usage");
    expect(calls()).toBe(0);
    expect((await rig.ports.leases.load(LEASE))?.state).toBe("active");
  });

  it("a profile with no read binding carrying a row adapter is a usage error, never a silent pass", async () => {
    const rig = await setup(resourceQueryManifest());
    const bare: RunProfile = { ...verdictProfile(), bindings: createBindingSet([]) };

    const error = await runOutcomeCheck(rig.ports, {
      leaseId: LEASE,
      profile: bare,
      adapter: unusedAdapter,
      signal: signal(),
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RuntimeError);
    expect((error as RuntimeError).code).toBe("usage");
    expect(await chainShape(rig)).toEqual([]);
  });
});

describe("runOutcomeCheck: user_confirm", () => {
  it("a confirm completes the lease: user_confirm receipt before outcome_verified, then begin_teardown", async () => {
    const rig = await setup(userConfirmManifest());
    const adapter = scripted(confirm);

    const result = await runOutcomeCheck(rig.ports, { leaseId: LEASE, adapter, signal: signal() });

    expect(result).toMatchObject({ kind: "user_confirm", outcome: "true" });
    expect(adapter.requests).toEqual([{ leaseId: LEASE, prompt: PROMPT }]);
    expect(["completed", "tearing_down", "cleaned_up"]).toContain(result.lease.state);
    expect((await chainShape(rig)).slice(0, 3)).toEqual([
      "call:user_confirm:allowed",
      "transition:outcome_verified",
      "transition:begin_teardown",
    ]);
  });

  it("a reject leaves the lease active with a denied receipt recording the reason", async () => {
    const rig = await setup(userConfirmManifest());

    const result = await runOutcomeCheck(rig.ports, { leaseId: LEASE, adapter: scripted(reject), signal: signal() });

    expect(result).toMatchObject({ kind: "user_confirm", outcome: "false" });
    expect(result.lease.state).toBe("active");
    expect(await chainShape(rig)).toEqual(["call:user_confirm:denied"]);
    const chain = await rig.ports.receipts(LEASE).load("verified");
    expect(JSON.stringify(chain[0]?.payload)).toContain("user_rejected");
  });

  it("an aborted signal is a timeout: outcome false, lease active, the prompt never lets it complete", async () => {
    const rig = await setup(userConfirmManifest());
    const controller = new AbortController();
    controller.abort();

    const result = await runOutcomeCheck(rig.ports, {
      leaseId: LEASE,
      adapter: scripted(() => new Promise<OutcomeConfirmDecision>(() => undefined)),
      signal: controller.signal,
    });

    expect(result.outcome).toBe("false");
    expect(result.lease.state).toBe("active");
    const chain = await rig.ports.receipts(LEASE).load("verified");
    expect(JSON.stringify(chain[0]?.payload)).toContain("timeout");
  });

  it("holds no lease lock while the prompt waits: a concurrent transaction lands before the answer", async () => {
    const rig = await setup(userConfirmManifest());
    let answer: (decision: OutcomeConfirmDecision) => void = () => undefined;
    let asked: () => void = () => undefined;
    const wasAsked = new Promise<void>((resolve) => {
      asked = resolve;
    });
    const adapter = scripted(
      () =>
        new Promise<OutcomeConfirmDecision>((resolve) => {
          answer = resolve;
          asked();
        }),
    );

    const pending = runOutcomeCheck(rig.ports, { leaseId: LEASE, adapter, signal: signal() });
    await wasAsked;

    // The prompt is pending. A transaction by another caller completes now, proving the wait holds no serialization.
    const bumped = await rig.ports.leases.transaction(LEASE, (lease) => ({
      ...lease,
      counters: { ...lease.counters, actionCount: lease.counters.actionCount + 1 },
    }));
    expect(bumped.counters.actionCount).toBe(1);
    expect(await chainShape(rig)).toEqual([]);

    answer({ decision: "confirm" });
    const result = await pending;
    expect(result.outcome).toBe("true");
    // The completion saw the concurrent update: nothing was overwritten.
    expect(result.lease.counters.actionCount).toBe(1);
  });
});

describe("runOutcomeCheck: refusals", () => {
  it("a none verifier is a usage error naming stint revoke, and appends nothing", async () => {
    const none = delegatedManifest([ORDERS]);
    const rig = await setup(none);

    const error = await runOutcomeCheck(rig.ports, { leaseId: LEASE, adapter: unusedAdapter, signal: signal() }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(RuntimeError);
    expect((error as RuntimeError).code).toBe("usage");
    expect((error as RuntimeError).safeMessage).toContain("stint revoke");
    expect(await chainShape(rig)).toEqual([]);
  });

  it("a lease that is not active is wrong_state and changes nothing", async () => {
    const rig = await setup(userConfirmManifest(), "expired");
    const adapter = scripted(confirm);

    const error = await runOutcomeCheck(rig.ports, { leaseId: LEASE, adapter, signal: signal() }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RuntimeError);
    expect((error as RuntimeError).code).toBe("wrong_state");
    expect(adapter.requests).toHaveLength(0);
    expect(await chainShape(rig)).toEqual([]);
    expect((await rig.ports.leases.load(LEASE))?.state).toBe("expired");
  });

  it("a missing lease is lease_not_found", async () => {
    const rig = await buildRig(LEASE, userConfirmManifest());
    const error = await runOutcomeCheck(rig.ports, { leaseId: LEASE, adapter: unusedAdapter, signal: signal() }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(RuntimeError);
    expect((error as RuntimeError).code).toBe("lease_not_found");
  });
});

describe("a live run's verifyOutcome delegates to the same path", () => {
  async function liveRun(manifest: Manifest, adapter: HostAdapter, fetchImpl?: FetchLike) {
    const rig = await setup(manifest);
    const verified = await loadLeaseManifest(rig.ports, LEASE);
    const [, serverTransport] = InMemoryTransport.createLinkedPair();
    const running = await createLeaseRuntime(rig.ports, {
      leaseId: LEASE,
      transport: serverTransport,
      adapter,
      verified,
      profile: verdictProfile(),
      ...(fetchImpl === undefined ? {} : { outboundFetch: fetchImpl }),
    });
    return { rig, running };
  }

  it("works over a user_confirm manifest (the earlier usage error is gone)", async () => {
    const { rig, running } = await liveRun(userConfirmManifest(), scripted(confirm));
    try {
      const lease = await running.verifyOutcome();
      expect(["completed", "tearing_down", "cleaned_up"]).toContain(lease.state);
      expect((await chainShape(rig)).slice(0, 2)).toEqual(["call:user_confirm:allowed", "transition:outcome_verified"]);
    } finally {
      await running.close();
    }
  });

  it("a user_confirm reject through the live run leaves the lease active", async () => {
    const { running } = await liveRun(userConfirmManifest(), scripted(reject));
    try {
      expect((await running.verifyOutcome()).state).toBe("active");
    } finally {
      await running.close();
    }
  });

  it("over the verdict manifest returns the same results as the standalone call", async () => {
    const { rig, running } = await liveRun(resourceQueryManifest(), unusedAdapter, verdictFetch("confirmed").fetchImpl);
    try {
      const lease = await running.verifyOutcome();
      expect(lease.state).toBe("cleaned_up");
      expect((await chainShape(rig)).slice(0, 3)).toEqual([
        `call:${ORDERS}:allowed`,
        "transition:outcome_verified",
        "transition:begin_teardown",
      ]);
    } finally {
      await running.close();
    }
  });

  it("over a none manifest rejects with a usage error", async () => {
    const { running } = await liveRun(delegatedManifest([ORDERS]), unusedAdapter);
    try {
      const error = await running.verifyOutcome().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RuntimeError);
      expect((error as RuntimeError).code).toBe("usage");
    } finally {
      await running.close();
    }
  });
});
