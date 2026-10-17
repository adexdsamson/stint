/**
 * 10-04 Task 2 (PSTK-01, PSTK-03, PSTK-04, PSTK-05, CRED-02): the verify
 * connector is one closed GET. It carries the key only to the credential's
 * origin, never across a redirect, ignores the agent's arguments entirely,
 * strips the upstream body down to the R5 allowlist, and turns every transient
 * upstream failure into a typed error the verifier path denies on.
 */

import { describe, expect, it } from "vitest";

import type { ConnectorBinding } from "@stint/core";

import { OutboundOriginError } from "../src/connectors/outbound-connector.js";
import type { FetchLike, OutboundCredential } from "../src/connectors/outbound-connector.js";
import {
  PAYSTACK_VERIFY_TIMEOUT_MS,
  PaystackVerifyUsageError,
  TransientUpstreamError,
  createPaystackVerifyConnector,
} from "../src/connectors/paystack-verify.js";
import type { TransactionExpectation } from "../src/connectors/paystack-verify.js";

const KEY = "sk_test_distinctive_verify_key";
const ORIGIN = "http://127.0.0.1:4444";
const EXPECTED: TransactionExpectation = { reference: "ref_1001", expectedAmountKobo: 30050, currency: "NGN" };

const BINDING: ConnectorBinding = {
  tool: "verify_transaction",
  resource: "paystack.transactions",
  access: "read",
  irreversible: false,
  provenance: "built_in",
};

const CREDENTIAL: OutboundCredential = { accessToken: KEY, kind: "api_key", origin: ORIGIN };

interface Recorded {
  readonly input: string;
  readonly init: RequestInit | undefined;
}

function recording(respond: () => Promise<Response>): { readonly fetchImpl: FetchLike; readonly calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetchImpl: FetchLike = (input, init) => {
    calls.push({ input, init });
    return respond();
  };
  return { fetchImpl, calls };
}

function json(status: number, body: unknown): () => Promise<Response> {
  return () => Promise.resolve(new Response(JSON.stringify(body), { status }));
}

/** A 200 verify envelope carrying every hidden field the allowlist must strip. */
const WIRE = {
  status: true,
  message: "Verification successful",
  data: {
    id: 4099260516,
    status: "success",
    reference: "ref_1001",
    amount: 40333,
    requested_amount: 30050,
    currency: "NGN",
    fees: 10283,
    channel: "card",
    domain: "test",
    paid_at: "2026-10-01T10:00:00.000Z",
    created_at: "2026-10-01T09:58:00.000Z",
    ip_address: "203.0.113.9",
    authorization: { authorization_code: "AUTH_hidden123", last4: "4081", bin: "408408" },
    customer: { id: 1, email: "buyer@example.com", customer_code: "CUS_hidden456" },
  },
};

const connectorOver = (fetchImpl: FetchLike, ...rest: [] | [TransactionExpectation | undefined]) => {
  const expectation = rest.length === 0 ? EXPECTED : rest[0];
  return createPaystackVerifyConnector(fetchImpl, { expectation: () => expectation });
};

describe("createPaystackVerifyConnector: the closed GET", () => {
  it("issues one GET to origin + /transaction/verify/{reference} with a bearer key, redirect error and a timeout signal", async () => {
    const { fetchImpl, calls } = recording(json(200, WIRE));
    const result = await connectorOver(fetchImpl).execute(BINDING, {}, CREDENTIAL);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe("http://127.0.0.1:4444/transaction/verify/ref_1001");
    expect(calls[0]?.init?.method).toBe("GET");
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe(`Bearer ${KEY}`);
    expect(calls[0]?.init?.redirect).toBe("error");
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0]?.init?.body).toBeUndefined();

    expect(result.status).toBe(200);
    const rows = (result.body as { rows: Array<Record<string, unknown>> }).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      verdict: "confirmed",
      status: "success",
      amount: 40333,
      requested_amount: 30050,
      currency: "NGN",
      reference: "ref_1001",
      paid_at: "2026-10-01T10:00:00.000Z",
      created_at: "2026-10-01T09:58:00.000Z",
      channel: "card",
      domain: "test",
      fees: 10283,
    });
  });

  it("the timeout is the OAuth-class 15 seconds", () => {
    expect(PAYSTACK_VERIFY_TIMEOUT_MS).toBe(15_000);
  });

  it("ignores the agent's arguments entirely: a different reference argument records the byte-identical URL", async () => {
    const first = recording(json(200, WIRE));
    const second = recording(json(200, WIRE));
    await connectorOver(first.fetchImpl).execute(BINDING, {}, CREDENTIAL);
    await connectorOver(second.fetchImpl).execute(
      BINDING,
      { reference: "OTHER", amount: 1, currency: "USD", url: "https://evil.example/x" },
      CREDENTIAL,
    );
    expect(first.calls).toHaveLength(1);
    expect(second.calls).toHaveLength(1);
    expect(second.calls[0]?.input).toBe(first.calls[0]?.input);
    expect(second.calls[0]?.init?.method).toBe(first.calls[0]?.init?.method);
  });

  it("the resource name on the binding does not steer the URL", async () => {
    const { fetchImpl, calls } = recording(json(200, WIRE));
    await connectorOver(fetchImpl).execute({ ...BINDING, resource: "https://evil.example/steal" }, {}, CREDENTIAL);
    expect(calls[0]?.input).toBe("http://127.0.0.1:4444/transaction/verify/ref_1001");
  });

  it("a recorded origin with a trailing slash or path still yields origin + route", async () => {
    const { fetchImpl, calls } = recording(json(200, WIRE));
    await connectorOver(fetchImpl).execute(BINDING, {}, { ...CREDENTIAL, origin: `${ORIGIN}/` });
    expect(calls[0]?.input).toBe("http://127.0.0.1:4444/transaction/verify/ref_1001");
  });

  it("deep scan: none of the hidden fields appear anywhere in the returned body", async () => {
    const { fetchImpl } = recording(json(200, WIRE));
    const result = await connectorOver(fetchImpl).execute(BINDING, {}, CREDENTIAL);
    const serialized = JSON.stringify(result);
    for (const hidden of [
      "AUTH_hidden123",
      "authorization_code",
      "4081",
      "buyer@example.com",
      "CUS_hidden456",
      "203.0.113.9",
      "ip_address",
      "4099260516",
      "customer",
      KEY,
    ]) {
      expect(serialized).not.toContain(hidden);
    }
  });

  it("an envelope trap reaches the wire as not_success: status true, data.status failed", async () => {
    const { fetchImpl } = recording(json(200, { ...WIRE, data: { ...WIRE.data, status: "failed" } }));
    const result = await connectorOver(fetchImpl).execute(BINDING, {}, CREDENTIAL);
    expect((result.body as { rows: Array<{ verdict: string }> }).rows[0]?.verdict).toBe("not_success");
  });

  it("an unrecognised 200 body is an unknown verdict row, not an error and not a confirmation", async () => {
    const { fetchImpl } = recording(json(200, { hello: "world" }));
    const result = await connectorOver(fetchImpl).execute(BINDING, {}, CREDENTIAL);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ rows: [{ verdict: "unknown" }] });
  });
});

describe("createPaystackVerifyConnector: refusals before any fetch", () => {
  const refusals: ReadonlyArray<readonly [string, TransactionExpectation | undefined]> = [
    ["a reference with a path escape", { ...EXPECTED, reference: "../evil" }],
    ["a reference with a slash", { ...EXPECTED, reference: "a/b" }],
    ["a reference with a query character", { ...EXPECTED, reference: "a?x=1" }],
    ["an empty reference", { ...EXPECTED, reference: "" }],
    ["an over-long reference", { ...EXPECTED, reference: "a".repeat(129) }],
    ["no usable expectation", undefined],
  ];
  for (const [name, expectation] of refusals) {
    it(`${name}: a typed usage error and ZERO fetch calls`, async () => {
      const { fetchImpl, calls } = recording(json(200, WIRE));
      await expect(connectorOver(fetchImpl, expectation).execute(BINDING, {}, CREDENTIAL)).rejects.toBeInstanceOf(
        PaystackVerifyUsageError,
      );
      expect(calls).toHaveLength(0);
    });
  }

  it("the usage error text is fixed and carries no reference or key", async () => {
    const { fetchImpl } = recording(json(200, WIRE));
    const error = await connectorOver(fetchImpl, { ...EXPECTED, reference: "../evil" })
      .execute(BINDING, {}, CREDENTIAL)
      .then(
        () => new Error("resolved"),
        (e: unknown) => e as Error,
      );
    expect(error.message).not.toContain("evil");
    expect(error.message).not.toContain(KEY);
  });

  it("an api_key credential with no origin is refused with zero fetch calls", async () => {
    const { fetchImpl, calls } = recording(json(200, WIRE));
    await expect(
      connectorOver(fetchImpl).execute(BINDING, {}, { accessToken: KEY, kind: "api_key" }),
    ).rejects.toBeInstanceOf(OutboundOriginError);
    expect(calls).toHaveLength(0);
  });

  it("a plain-http non-loopback origin is refused with zero fetch calls", async () => {
    const { fetchImpl, calls } = recording(json(200, WIRE));
    await expect(
      connectorOver(fetchImpl).execute(BINDING, {}, { ...CREDENTIAL, origin: "http://10.0.0.5:80" }),
    ).rejects.toBeInstanceOf(OutboundOriginError);
    expect(calls).toHaveLength(0);
  });

  it("an OAuth credential is refused defensively with zero fetch calls", async () => {
    const { fetchImpl, calls } = recording(json(200, WIRE));
    await expect(
      connectorOver(fetchImpl).execute(BINDING, {}, { accessToken: "oauth-token", kind: "oauth" }),
    ).rejects.toBeInstanceOf(PaystackVerifyUsageError);
    expect(calls).toHaveLength(0);
  });
});

describe("createPaystackVerifyConnector: 404 and transient failures", () => {
  it("HTTP 404 yields a not_found row (status passthrough), no throw", async () => {
    const { fetchImpl } = recording(json(404, { status: false, message: "Transaction reference not found" }));
    const result = await connectorOver(fetchImpl).execute(BINDING, {}, CREDENTIAL);
    expect(result.status).toBe(404);
    expect(result.body).toEqual({ rows: [{ verdict: "not_found" }] });
  });

  for (const status of [429, 500, 502, 503, 400, 401, 403]) {
    it(`HTTP ${String(status)} is a TransientUpstreamError with no row and a fixed message`, async () => {
      const { fetchImpl } = recording(json(status, { message: "secret detail" }));
      const error = await connectorOver(fetchImpl)
        .execute(BINDING, {}, CREDENTIAL)
        .then(
        () => new Error("resolved"),
        (e: unknown) => e as Error,
      );
      expect(error).toBeInstanceOf(TransientUpstreamError);
      expect(error.message).not.toContain("secret detail");
      expect(error.message).not.toContain(KEY);
    });
  }

  it("a 3xx without a followable redirect (status only) is transient, never a verdict", async () => {
    const { fetchImpl } = recording(() => Promise.resolve(new Response(null, { status: 304 })));
    await expect(connectorOver(fetchImpl).execute(BINDING, {}, CREDENTIAL)).rejects.toBeInstanceOf(
      TransientUpstreamError,
    );
  });

  it("a network error (fetch rejects, including a redirect refusal) is a TransientUpstreamError", async () => {
    const { fetchImpl } = recording(() => Promise.reject(new TypeError(`fetch failed for ${KEY}`)));
    const error = await connectorOver(fetchImpl)
      .execute(BINDING, {}, CREDENTIAL)
      .then(
        () => new Error("resolved"),
        (e: unknown) => e as Error,
      );
    expect(error).toBeInstanceOf(TransientUpstreamError);
    expect(error.message).not.toContain(KEY);
  });

  it("an already-aborted signal (timeout) is a TransientUpstreamError", async () => {
    const { fetchImpl } = recording(() => Promise.reject(new DOMException("The operation was aborted.", "TimeoutError")));
    await expect(connectorOver(fetchImpl).execute(BINDING, {}, CREDENTIAL)).rejects.toBeInstanceOf(
      TransientUpstreamError,
    );
  });

  it("a request that never settles is cut by the timeout signal and becomes a TransientUpstreamError", async () => {
    const hanging: FetchLike = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      });
    const connector = createPaystackVerifyConnector(hanging, { expectation: () => EXPECTED, timeoutMs: 20 });
    await expect(connector.execute(BINDING, {}, CREDENTIAL)).rejects.toBeInstanceOf(TransientUpstreamError);
  });

  it("an unparseable 200 body is a TransientUpstreamError: not a verdict", async () => {
    const { fetchImpl } = recording(() => Promise.resolve(new Response("<html>gateway</html>", { status: 200 })));
    await expect(connectorOver(fetchImpl).execute(BINDING, {}, CREDENTIAL)).rejects.toBeInstanceOf(
      TransientUpstreamError,
    );
  });

  it("the transient error message is fixed text", () => {
    expect(new TransientUpstreamError().message).toBe(new TransientUpstreamError().message);
    expect(new TransientUpstreamError().name).toBe("TransientUpstreamError");
  });
});
