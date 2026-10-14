/**
 * 10-03 Task 2 (CRED-02, D-B): the reference REST connector is the one place a
 * secret meets a URL. An API key goes only to the origin recorded on its
 * stored credential (checked on the FINAL url handed to fetch), a redirect is
 * an error while any credential is attached, and the closed route table the
 * 10-04 verify connector implements is published as a constant.
 */

import { generateKeyPair } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createInMemoryLeaseStore, createInMemoryReceiptStore, makeTestLease } from "@stint/core/testing";
import type { ConnectorBinding } from "@stint/core";
import { parsePredicate } from "@stint/spec";

import {
  API_KEY_RESOURCE_ROUTES,
  OutboundOriginError,
  createRestOutboundConnector,
} from "../src/connectors/outbound-connector.js";
import type { FetchLike, OutboundConnector, OutboundCredential, RestRoute } from "../src/connectors/outbound-connector.js";
import {
  createCredentialVault,
  createDefaultTeardownSteps,
  createVaultExecuteStage,
  runResourceQueryVerification,
} from "../src/index.js";
import type { CallContext } from "../src/dispatch.js";
import type { OAuthClient } from "../src/vault/oauth-client.js";

const NOW = 1_700_000_000;
const KEY = "sk_test_distinctive_origin_key";
const LOOPBACK = "http://127.0.0.1:43999";

interface Recorded {
  readonly input: string;
  readonly init: RequestInit | undefined;
}

function recordingFetch(): { readonly fetchImpl: FetchLike; readonly calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetchImpl: FetchLike = (input, init) => {
    calls.push({ input, init });
    return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  };
  return { fetchImpl, calls };
}

function binding(resource: string): ConnectorBinding {
  return { tool: "t", resource, access: "read", irreversible: false, provenance: "built_in" };
}

const apiKey = (origin?: string): OutboundCredential =>
  origin === undefined ? { accessToken: KEY, kind: "api_key" } : { accessToken: KEY, kind: "api_key", origin };

describe("api_key origin enforcement on the final URL", () => {
  it("same origin: the call proceeds, one fetch, init.redirect is error", async () => {
    const { fetchImpl, calls } = recordingFetch();
    const connector = createRestOutboundConnector(fetchImpl);
    const result = await connector.execute(binding(`${LOOPBACK}/transaction/verify/abc`), {}, apiKey(LOOPBACK));
    expect(result.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init?.redirect).toBe("error");
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe(`Bearer ${KEY}`);
  });

  it("same origin passes when the recorded origin carries a trailing slash", async () => {
    const { fetchImpl, calls } = recordingFetch();
    const connector = createRestOutboundConnector(fetchImpl);
    await connector.execute(binding(`${LOOPBACK}/x`), {}, apiKey(`${LOOPBACK}/`));
    expect(calls).toHaveLength(1);
  });

  it("a path-ful endpoint on the same origin is permitted (origin equality only)", async () => {
    const { fetchImpl, calls } = recordingFetch();
    const connector = createRestOutboundConnector(fetchImpl);
    await connector.execute(binding(`${LOOPBACK}/base/deeper/path`), {}, apiKey(LOOPBACK));
    expect(calls).toHaveLength(1);
  });

  it("cross origin: rejects with OutboundOriginError and the fetch double is NEVER invoked", async () => {
    const { fetchImpl, calls } = recordingFetch();
    const connector = createRestOutboundConnector(fetchImpl);
    const attempt = connector.execute(binding("http://127.0.0.1:1/"), {}, apiKey("https://api.paystack.co"));
    await expect(attempt).rejects.toBeInstanceOf(OutboundOriginError);
    expect(calls).toHaveLength(0);
  });

  it("the refusal message is fixed text naming neither the URL, the host, nor the key", async () => {
    const { fetchImpl } = recordingFetch();
    const connector = createRestOutboundConnector(fetchImpl);
    const err: unknown = await connector
      .execute(binding("https://evil.example.test/steal"), {}, apiKey("https://api.paystack.co"))
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(OutboundOriginError);
    const failure = err as Error;
    const text = `${failure.name} ${failure.message}`;
    expect(text).not.toContain("evil.example.test");
    expect(text).not.toContain("steal");
    expect(text).not.toContain("paystack");
    expect(text).not.toContain(KEY);
  });

  it("a different port or scheme on the same host is a different origin and is refused", async () => {
    const { fetchImpl, calls } = recordingFetch();
    const connector = createRestOutboundConnector(fetchImpl);
    await expect(connector.execute(binding("http://127.0.0.1:44000/x"), {}, apiKey(LOOPBACK))).rejects.toBeInstanceOf(
      OutboundOriginError,
    );
    await expect(
      connector.execute(binding("https://api.paystack.co.evil.test/x"), {}, apiKey("https://api.paystack.co")),
    ).rejects.toBeInstanceOf(OutboundOriginError);
    await expect(
      connector.execute(binding("http://api.paystack.co/x"), {}, apiKey("https://api.paystack.co")),
    ).rejects.toBeInstanceOf(OutboundOriginError);
    expect(calls).toHaveLength(0);
  });

  it("an api_key credential with no origin is refused before any fetch (fail closed)", async () => {
    const { fetchImpl, calls } = recordingFetch();
    const connector = createRestOutboundConnector(fetchImpl);
    await expect(connector.execute(binding(`${LOOPBACK}/x`), {}, apiKey())).rejects.toBeInstanceOf(OutboundOriginError);
    expect(calls).toHaveLength(0);
  });

  it("a recorded origin that is not https or loopback is refused even when it matches the URL", async () => {
    const { fetchImpl, calls } = recordingFetch();
    const connector = createRestOutboundConnector(fetchImpl);
    await expect(
      connector.execute(binding("http://10.0.0.5:1/x"), {}, apiKey("http://10.0.0.5:1")),
    ).rejects.toBeInstanceOf(OutboundOriginError);
    expect(calls).toHaveLength(0);
  });

  it("an unparseable binding resource is refused for an api_key (no fetch)", async () => {
    const { fetchImpl, calls } = recordingFetch();
    const connector = createRestOutboundConnector(fetchImpl);
    await expect(connector.execute(binding("paystack.transactions"), {}, apiKey(LOOPBACK))).rejects.toBeInstanceOf(
      OutboundOriginError,
    );
    expect(calls).toHaveLength(0);
  });
});

describe("OAuth credentials keep their behavior apart from the redirect posture", () => {
  it("no origin member, no origin check, and the init still carries redirect: error", async () => {
    const { fetchImpl, calls } = recordingFetch();
    const connector = createRestOutboundConnector(fetchImpl);
    const result = await connector.execute(binding("https://api.example.test/anything"), { a: 1 }, {
      accessToken: "oauth-at",
      kind: "oauth",
    });
    expect(result.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init?.redirect).toBe("error");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ a: 1 }));
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe("Bearer oauth-at");
  });
});

describe("the default-constructed connector carries the same hardening", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the global fetch and passes redirect: error", async () => {
    const globalFetch = vi.fn<FetchLike>(() => Promise.resolve(new Response(JSON.stringify({}), { status: 200 })));
    vi.stubGlobal("fetch", globalFetch);
    const connector = createRestOutboundConnector();
    await connector.execute(binding("https://api.example.test/x"), {}, { accessToken: "t", kind: "oauth" });
    expect(globalFetch).toHaveBeenCalledTimes(1);
    expect(globalFetch.mock.calls[0]?.[1]?.redirect).toBe("error");
  });

  it("refuses a cross-origin key without touching the global fetch", async () => {
    const globalFetch = vi.fn<FetchLike>(() => Promise.resolve(new Response("{}", { status: 200 })));
    vi.stubGlobal("fetch", globalFetch);
    const connector = createRestOutboundConnector();
    await expect(
      connector.execute(binding("https://evil.example.test/x"), {}, apiKey("https://api.paystack.co")),
    ).rejects.toBeInstanceOf(OutboundOriginError);
    expect(globalFetch).not.toHaveBeenCalled();
  });
});

describe("API_KEY_RESOURCE_ROUTES (the closed table)", () => {
  it("deep-equals the single paystack entry", () => {
    expect(API_KEY_RESOURCE_ROUTES).toEqual({
      "paystack.transactions": { method: "GET", path: "/transaction/verify/:reference" },
    });
  });

  it("types the method union as GET | POST", () => {
    const get: RestRoute = { method: "GET", path: "/a" };
    const post: RestRoute = { method: "POST", path: "/b" };
    // @ts-expect-error -- only GET and POST are closed members of the union
    const del: RestRoute = { method: "DELETE", path: "/c" };
    expect([get.method, post.method, del.method]).toEqual(["GET", "POST", "DELETE"]);
  });
});

/** An OAuth client the vault never consults for an API key. */
const UNUSED_OAUTH: OAuthClient = {
  as: { issuer: "https://as.origin-test.example" },
  client: { client_id: "c" },
  clientAuth: () => undefined,
};

describe("the call sites pass the widened credential through", () => {
  function capturingConnector(): { readonly connector: OutboundConnector; readonly seen: OutboundCredential[] } {
    const seen: OutboundCredential[] = [];
    return {
      seen,
      connector: {
        execute(_binding, _args, credential) {
          seen.push(credential);
          return Promise.resolve({ status: 200, body: { rows: [{ status: "reconciled" }] } });
        },
      },
    };
  }

  it("execute-stage hands the connector kind and origin for an api_key", async () => {
    const vault = createCredentialVault(UNUSED_OAUTH, () => NOW);
    vault.seedCredential("lease-es", "paystack.transactions", { kind: "api_key", key: KEY, origin: LOOPBACK });
    const { connector, seen } = capturingConnector();
    const stage = createVaultExecuteStage(vault, connector);
    const ctx: CallContext = {
      leaseId: "lease-es",
      tool: "t",
      resolvedArgs: {},
      binding: binding("paystack.transactions"),
      leaseVersion: 1,
    };
    await stage.execute(ctx, NOW);
    expect(seen).toEqual([{ accessToken: KEY, kind: "api_key", origin: LOOPBACK }]);
  });

  it("the verifier read hands the connector kind and origin for an api_key", async () => {
    const vault = createCredentialVault(UNUSED_OAUTH, () => NOW);
    vault.seedCredential("lease-rq", "paystack.transactions", { kind: "api_key", key: KEY, origin: LOOPBACK });
    const { connector, seen } = capturingConnector();

    const leaseStore = createInMemoryLeaseStore();
    const receiptStore = createInMemoryReceiptStore();
    const { privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
    await leaseStore.save(makeTestLease("lease-rq"));
    const parsed = parsePredicate("count(rows where status = 'reconciled') >= 1");
    if (!parsed.ok) throw new Error("test setup: predicate failed to parse");

    const outcome = await runResourceQueryVerification(
      {
        leaseStore,
        receiptStore,
        leaseId: "lease-rq",
        vault,
        connector,
        binding: {
          ...binding("paystack.transactions"),
          rowAdapter: (result) => ({ rows: (result.body as { rows: Array<Record<string, unknown>> }).rows }),
        },
        ast: parsed.value,
        teardownSteps: createDefaultTeardownSteps(receiptStore, privateKey),
      },
      NOW,
    );
    expect(outcome).toBe("true");
    expect(seen).toEqual([{ accessToken: KEY, kind: "api_key", origin: LOOPBACK }]);
  });
});
