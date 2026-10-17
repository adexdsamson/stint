/**
 * 10-04 Task 3 (PSTK-01, PSTK-04, PSTK-05): the runtime's composed outbound
 * connector sends a call to a resource in the closed API-key route table, with
 * an API-key credential, to the verify connector, and every other call to the
 * hardened REST connector. The verifier path driven through it denies a
 * transient upstream failure without ending the lease.
 */

import { createBindingSet } from "@stint/core";
import type { ConnectorBinding } from "@stint/core";
import {
  createInMemoryKeyProvider,
  createInMemoryLeaseStore,
  createInMemoryReceiptStore,
  makeTestLease,
} from "@stint/core/testing";
import {
  createCredentialVault,
  createDefaultTeardownSteps,
  runResourceQueryVerification,
  verdictRowAdapter,
} from "@stint/proxy";
import type { FetchLike, OAuthClient, OutboundConnector, OutboundCredential } from "@stint/proxy";
import { parsePredicate } from "@stint/spec";
import type { ReceiptEntry } from "@stint/spec";
import { describe, expect, it } from "vitest";

import { createRuntimeOutboundConnector } from "../src/index.js";

const NOW = 2000;
const KEY = "sk_test_runtime_dispatch_key";
const ORIGIN = "http://127.0.0.1:4545";
const PAYSTACK = "paystack.transactions";
const PARAMETERS = { reference: "ref_2002", expected_amount_kobo: 45000, currency: "NGN" } as const;
const PREDICATE = "exists(rows where verdict = 'confirmed') >= 1";

interface Recorded {
  readonly input: string;
  readonly init: RequestInit | undefined;
}

function recording(respond: () => Response | Promise<Response>): { readonly fetchImpl: FetchLike; readonly calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetchImpl: FetchLike = (input, init) => {
    calls.push({ input, init });
    return Promise.resolve(respond());
  };
  return { fetchImpl, calls };
}

const confirmedEnvelope = (): Response =>
  new Response(
    JSON.stringify({
      status: true,
      message: "Verification successful",
      data: {
        id: 77,
        status: "success",
        reference: "ref_2002",
        amount: 45750,
        requested_amount: 45000,
        currency: "NGN",
        customer: { email: "buyer@example.com" },
      },
    }),
    { status: 200 },
  );

function binding(resource: string, access: ConnectorBinding["access"] = "read"): ConnectorBinding {
  return { tool: "t", resource, access, irreversible: false, provenance: "built_in" };
}

const apiKey: OutboundCredential = { accessToken: KEY, kind: "api_key", origin: ORIGIN };
const oauth: OutboundCredential = { accessToken: "oauth-access", kind: "oauth" };

describe("createRuntimeOutboundConnector: the closed-table dispatch", () => {
  it("an api_key call to a tabled resource goes to the verify connector (origin + verify path, GET)", async () => {
    const { fetchImpl, calls } = recording(confirmedEnvelope);
    const connector = createRuntimeOutboundConnector({ fetchImpl, jobParameters: () => PARAMETERS });
    const result = await connector.execute(binding(PAYSTACK), {}, apiKey);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe(`${ORIGIN}/transaction/verify/ref_2002`);
    expect(calls[0]?.init?.method).toBe("GET");
    expect(calls[0]?.init?.redirect).toBe("error");
    expect((result.body as { rows: Array<{ verdict: string }> }).rows[0]?.verdict).toBe("confirmed");
  });

  it("an api_key call to a tabled resource ignores the endpoints map (the credential's origin is the one source)", async () => {
    const { fetchImpl, calls } = recording(confirmedEnvelope);
    const connector = createRuntimeOutboundConnector({
      fetchImpl,
      endpoints: { [PAYSTACK]: "https://elsewhere.example/hook" },
      jobParameters: () => PARAMETERS,
    });
    await connector.execute(binding(PAYSTACK), {}, apiKey);
    expect(calls[0]?.input).toBe(`${ORIGIN}/transaction/verify/ref_2002`);
  });

  it("a call to any other resource goes to the REST connector (POST, endpoints mapped, unchanged)", async () => {
    const { fetchImpl, calls } = recording(() => new Response(JSON.stringify({ rows: [] }), { status: 200 }));
    const connector = createRuntimeOutboundConnector({
      fetchImpl,
      endpoints: { "sheets.orders": "http://127.0.0.1:9999/orders" },
      jobParameters: () => PARAMETERS,
    });
    const result = await connector.execute(binding("sheets.orders"), { q: 1 }, oauth);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe("http://127.0.0.1:9999/orders");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ q: 1 }));
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe("Bearer oauth-access");
    expect(result).toEqual({ status: 200, body: { rows: [] } });
  });

  it("an OAuth credential on the tabled resource keeps the REST POST flow (the table keys on kind)", async () => {
    const { fetchImpl, calls } = recording(() => new Response(JSON.stringify({ rows: [] }), { status: 200 }));
    const connector = createRuntimeOutboundConnector({
      fetchImpl,
      endpoints: { [PAYSTACK]: "http://127.0.0.1:9998/paystack" },
      jobParameters: () => PARAMETERS,
    });
    await connector.execute(binding(PAYSTACK), { page: 1 }, oauth);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe("http://127.0.0.1:9998/paystack");
    expect(calls[0]?.init?.method).toBe("POST");
  });

  it("an api_key call to a resource outside the table stays on the REST connector (origin-pinned there)", async () => {
    const { fetchImpl, calls } = recording(() => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const connector = createRuntimeOutboundConnector({ fetchImpl, jobParameters: () => PARAMETERS });
    await connector.execute(binding(`${ORIGIN}/other/resource`), {}, apiKey);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init?.method).toBe("POST");
  });

  it("a lease without parameters yields no expectation and the route refuses with zero fetch calls", async () => {
    const { fetchImpl, calls } = recording(confirmedEnvelope);
    const noProvider = createRuntimeOutboundConnector({ fetchImpl });
    await expect(noProvider.execute(binding(PAYSTACK), {}, apiKey)).rejects.toThrow();
    const emptyProvider = createRuntimeOutboundConnector({ fetchImpl, jobParameters: () => undefined });
    await expect(emptyProvider.execute(binding(PAYSTACK), {}, apiKey)).rejects.toThrow();
    const badProvider = createRuntimeOutboundConnector({
      fetchImpl,
      jobParameters: () => ({ ...PARAMETERS, reference: "../evil" }),
    });
    await expect(badProvider.execute(binding(PAYSTACK), {}, apiKey)).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("reads the parameters at call time (the provider is a function, not a snapshot)", async () => {
    const { fetchImpl, calls } = recording(confirmedEnvelope);
    const state: { current: Record<string, string | number> | undefined } = { current: undefined };
    const connector = createRuntimeOutboundConnector({ fetchImpl, jobParameters: () => state.current });
    await expect(connector.execute(binding(PAYSTACK), {}, apiKey)).rejects.toThrow();
    state.current = { ...PARAMETERS };
    await connector.execute(binding(PAYSTACK), {}, apiKey);
    expect(calls).toHaveLength(1);
  });
});

/** An OAuth client the vault never consults for an API key. */
const UNUSED_OAUTH: OAuthClient = {
  as: { issuer: "https://as.dispatch-test.example" },
  client: { client_id: "c" },
  clientAuth: () => undefined,
};

describe("the verifier path through the composed connector (PSTK-05)", () => {
  const LEASE = "lease-verify-1";

  async function rig(
    respond: () => Response | Promise<Response>,
    ...rest: [] | [Readonly<Record<string, string | number>> | undefined]
  ) {
    const parameters = rest.length === 0 ? { ...PARAMETERS } : rest[0];
    const vault = createCredentialVault(UNUSED_OAUTH, () => NOW);
    vault.seedCredential(LEASE, PAYSTACK, { kind: "api_key", key: KEY, origin: ORIGIN });
    const leaseStore = createInMemoryLeaseStore();
    const receiptStore = createInMemoryReceiptStore();
    await leaseStore.save(makeTestLease(LEASE, parameters === undefined ? {} : { jobParameters: parameters }));
    const { privateKey } = await createInMemoryKeyProvider().loadOrCreate();
    const { fetchImpl, calls } = recording(respond);
    const loaded = await leaseStore.load(LEASE);
    const connector: OutboundConnector = createRuntimeOutboundConnector({
      fetchImpl,
      jobParameters: () => loaded?.jobParameters,
    });
    const ast = parsePredicate(PREDICATE);
    if (!ast.ok) throw new Error("test setup: predicate failed to parse");
    const readBinding = createBindingSet([
      { ...binding(PAYSTACK), tool: "verify_transaction", rowAdapter: verdictRowAdapter },
    ])["verify_transaction"];
    if (readBinding === undefined) throw new Error("test setup: binding missing");
    const run = () =>
      runResourceQueryVerification(
        {
          leaseStore,
          receiptStore,
          leaseId: LEASE,
          vault,
          connector,
          binding: readBinding,
          ast: ast.value,
          teardownSteps: createDefaultTeardownSteps(receiptStore, privateKey),
        },
        NOW,
      );
    return { run, calls, leaseStore, receiptStore };
  }

  it("a confirmed 200 drives the verification to true and the lease completes through the existing path", async () => {
    const { run, calls, leaseStore, receiptStore } = await rig(confirmedEnvelope);
    expect(await run()).toBe("true");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe(`${ORIGIN}/transaction/verify/ref_2002`);

    expect((await leaseStore.load(LEASE))?.state).toBe("cleaned_up");
    const chain = await receiptStore.load("verified");
    const completed = chain.some(
      (entry: ReceiptEntry) =>
        entry.type === "transition" && (entry.payload as { to?: string }).to === "completed",
    );
    expect(completed).toBe(true);
    // The wire body's PII never reaches a receipt.
    expect(JSON.stringify(chain)).not.toContain("buyer@example.com");
    expect(JSON.stringify(chain)).not.toContain(KEY);
  });

  it("a non-success transaction is a false outcome: the lease stays active", async () => {
    const { run, leaseStore } = await rig(
      () =>
        new Response(
          JSON.stringify({ status: true, data: { status: "failed", reference: "ref_2002", requested_amount: 45000, currency: "NGN" } }),
          { status: 200 },
        ),
    );
    expect(await run()).toBe("false");
    expect((await leaseStore.load(LEASE))?.state).toBe("active");
  });

  it("a 429 drives the verification to error: a denied receipt, the lease stays active, nothing completes", async () => {
    const { run, calls, leaseStore, receiptStore } = await rig(
      () => new Response(JSON.stringify({ message: "slow down" }), { status: 429 }),
    );
    expect(await run()).toBe("error");
    expect(calls).toHaveLength(1);

    expect((await leaseStore.load(LEASE))?.state).toBe("active");
    const chain = await receiptStore.load("verified");
    expect(chain.some((entry: ReceiptEntry) => entry.type === "transition")).toBe(false);
    const newest = chain[chain.length - 1];
    expect(newest?.type).toBe("call");
    const payload = newest?.payload as { outcome?: string; redactedSummary?: string };
    expect(payload.outcome).toBe("denied");
    expect(payload.redactedSummary).toContain("reason=verification_read_error");
  });

  it("a 503 and a network error behave exactly like a 429", async () => {
    for (const respond of [
      () => new Response("{}", { status: 503 }),
      () => Promise.reject(new TypeError("fetch failed")) as unknown as Response,
    ]) {
      const { run, leaseStore } = await rig(respond);
      expect(await run()).toBe("error");
      expect((await leaseStore.load(LEASE))?.state).toBe("active");
    }
  });

  it("a lease with no parameters denies the verification (error) with zero fetch calls", async () => {
    const { run, calls, leaseStore } = await rig(confirmedEnvelope, undefined);
    expect(await run()).toBe("error");
    expect(calls).toHaveLength(0);
    expect((await leaseStore.load(LEASE))?.state).toBe("active");
  });
});
