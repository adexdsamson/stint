/**
 * SUP-04 (09-06) Task 1: the status-guarded token-error classifier, Retry-After
 * extraction and request timeouts, driven through the real `refreshAccessToken`
 * and `revokeCredential` against a `node:http` stub endpoint. The stub, not
 * `oauth2-mock-server`, is used because a row has to control the status, the
 * headers and the body of the token response.
 */

import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_OAUTH_TIMEOUT_MS,
  oauthClientFromCredential,
  refreshAccessToken,
  retryAfterFromError,
  revokeCredential,
} from "../src/vault/oauth-client.js";
import type { OAuthSeededCredential, RefreshResult } from "../src/vault/oauth-client.js";

const NOW = 1_700_000_000;

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

let server: Server | undefined;

afterEach(async () => {
  const current = server;
  server = undefined;
  if (current === undefined) return;
  // A never-answering stub keeps sockets open: drop them so close() resolves.
  current.closeAllConnections();
  await new Promise<void>((resolve) => current.close(() => resolve()));
});

async function startStub(handler: Handler): Promise<string> {
  const created = createServer(handler);
  server = created;
  await new Promise<void>((resolve) => created.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${String((created.address() as AddressInfo).port)}`;
}

function credentialFor(origin: string): OAuthSeededCredential {
  return {
    accessToken: "stale-access-token",
    refreshToken: "seed-refresh-token",
    expiry: NOW - 10,
    tokenEndpoint: `${origin}/token`,
    revocationEndpoint: `${origin}/revoke`,
    resourceIndicator: "https://api.classify-test.example/v1",
  };
}

async function refreshVia(origin: string, timeoutMs?: number): Promise<RefreshResult> {
  const credential = credentialFor(origin);
  return refreshAccessToken(oauthClientFromCredential(credential), credential, NOW, {
    allowInsecureRequests: true,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

interface Row {
  readonly name: string;
  readonly status: number;
  readonly headers?: Record<string, string>;
  readonly body?: Record<string, unknown>;
  readonly expected: "provider_revoked" | "transient_error";
}

const CLASSIFICATION_ROWS: readonly Row[] = [
  { name: "400 invalid_grant", status: 400, body: { error: "invalid_grant" }, expected: "provider_revoked" },
  { name: "403 invalid_grant", status: 403, body: { error: "invalid_grant" }, expected: "provider_revoked" },
  { name: "401 invalid_token body", status: 401, body: { error: "invalid_token" }, expected: "provider_revoked" },
  {
    name: "401 WWW-Authenticate Bearer error=invalid_token",
    status: 401,
    headers: { "WWW-Authenticate": 'Bearer error="invalid_token"' },
    body: {},
    expected: "provider_revoked",
  },
  { name: "401 invalid_client", status: 401, body: { error: "invalid_client" }, expected: "transient_error" },
  {
    name: "401 WWW-Authenticate Bearer error=invalid_client",
    status: 401,
    headers: { "WWW-Authenticate": 'Bearer error="invalid_client"' },
    body: {},
    expected: "transient_error",
  },
  { name: "500 with an invalid_grant body", status: 500, body: { error: "invalid_grant" }, expected: "transient_error" },
  { name: "503 with an invalid_grant body", status: 503, body: { error: "invalid_grant" }, expected: "transient_error" },
  { name: "429 with an invalid_grant body", status: 429, body: { error: "invalid_grant" }, expected: "transient_error" },
  { name: "400 invalid_request", status: 400, body: { error: "invalid_request" }, expected: "transient_error" },
  { name: "200 with an invalid_grant body", status: 200, body: { error: "invalid_grant" }, expected: "transient_error" },
];

describe("classifyTokenError through refreshAccessToken (D-17)", () => {
  it.each(CLASSIFICATION_ROWS)("$name -> $expected", async (row) => {
    const origin = await startStub((_req, res) => {
      res.writeHead(row.status, { "content-type": "application/json", ...row.headers });
      res.end(JSON.stringify(row.body ?? {}));
    });
    const result = await refreshVia(origin);
    expect(result.kind).toBe(row.expected);
  });

  it("a closed port is a transient_error", async () => {
    const origin = await startStub((_req, res) => res.end());
    const live = server;
    server = undefined;
    live?.closeAllConnections();
    await new Promise<void>((resolve) => live?.close(() => resolve()));
    const result = await refreshVia(origin);
    expect(result.kind).toBe("transient_error");
  });

  it("a token endpoint that never answers is a transient_error once timeoutMs elapses", async () => {
    const origin = await startStub(() => {
      // Never respond.
    });
    const started = Date.now();
    const result = await refreshVia(origin, 200);
    expect(result.kind).toBe("transient_error");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("a successful refresh still returns ok with the new token and expiry", async () => {
    const origin = await startStub((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: "new-at", token_type: "Bearer", expires_in: 600, refresh_token: "new-rt" }));
    });
    const result = await refreshVia(origin);
    expect(result).toEqual({ kind: "ok", accessToken: "new-at", refreshToken: "new-rt", expiry: NOW + 600 });
  });

  it("the default request timeout is 15 seconds", () => {
    expect(DEFAULT_OAUTH_TIMEOUT_MS).toBe(15_000);
  });
});

describe("Retry-After on a transient failure (T-09-27)", () => {
  interface RetryRow {
    readonly name: string;
    readonly header: (() => string) | undefined;
    readonly expected: number | undefined;
  }
  const RETRY_ROWS: readonly RetryRow[] = [
    { name: "delta-seconds 120", header: () => "120", expected: 120 },
    { name: "HTTP date 30 s after now", header: () => new Date((NOW + 30) * 1000).toUTCString(), expected: 30 },
    { name: "HTTP date in the past clamps to 0", header: () => new Date((NOW - 500) * 1000).toUTCString(), expected: 0 },
    { name: "99999 clamps to 3600", header: () => "99999", expected: 3600 },
    { name: "a negative value is ignored", header: () => "-5", expected: undefined },
    { name: "an unparseable value is ignored", header: () => "soon", expected: undefined },
    { name: "an absent header is ignored", header: undefined, expected: undefined },
  ];

  it.each(RETRY_ROWS)("429: $name", async (row) => {
    const origin = await startStub((_req, res) => {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (row.header !== undefined) headers["retry-after"] = row.header();
      res.writeHead(429, headers);
      res.end(JSON.stringify({ error: "invalid_grant" }));
    });
    const result = await refreshVia(origin);
    expect(result.kind).toBe("transient_error");
    if (result.kind !== "transient_error") return;
    expect(result.retryAfterSeconds).toBe(row.expected);
    if (row.expected === undefined) expect("retryAfterSeconds" in result).toBe(false);
  });

  it("a 503 carries Retry-After too", async () => {
    const origin = await startStub((_req, res) => {
      res.writeHead(503, { "content-type": "application/json", "retry-after": "7" });
      res.end(JSON.stringify({ error: "temporarily_unavailable" }));
    });
    const result = await refreshVia(origin);
    expect(result).toMatchObject({ kind: "transient_error", retryAfterSeconds: 7 });
  });

  it("retryAfterFromError finds a Response on err.cause and tolerates non-errors", () => {
    const response = new Response(null, { headers: { "retry-after": "15" } });
    expect(retryAfterFromError(new Error("x", { cause: response }), NOW)).toBe(15);
    expect(retryAfterFromError(new Error("plain"), NOW)).toBeUndefined();
    expect(retryAfterFromError("not an error", NOW)).toBeUndefined();
    expect(retryAfterFromError(undefined, NOW)).toBeUndefined();
  });
});

describe("revokeCredential timeout (T-09-24)", () => {
  it("a revocation endpoint that never answers is failed once timeoutMs elapses", async () => {
    const origin = await startStub(() => {
      // Never respond.
    });
    const credential = credentialFor(origin);
    const started = Date.now();
    const result = await revokeCredential(oauthClientFromCredential(credential), credential.refreshToken, {
      allowInsecureRequests: true,
      timeoutMs: 200,
    });
    expect(result.kind).toBe("failed");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("a 200 revocation response is still revoked", async () => {
    const origin = await startStub((_req, res) => {
      res.writeHead(200);
      res.end();
    });
    const credential = credentialFor(origin);
    const result = await revokeCredential(oauthClientFromCredential(credential), credential.refreshToken, {
      allowInsecureRequests: true,
    });
    expect(result.kind).toBe("revoked");
  });

  it("an outer signal aborts the request without waiting for the timeout", async () => {
    const origin = await startStub(() => {
      // Never respond.
    });
    const credential = credentialFor(origin);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const started = Date.now();
    const result = await revokeCredential(oauthClientFromCredential(credential), credential.refreshToken, {
      allowInsecureRequests: true,
      signal: controller.signal,
    });
    expect(result.kind).toBe("failed");
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
