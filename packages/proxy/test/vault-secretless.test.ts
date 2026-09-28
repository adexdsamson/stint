/**
 * PRXY-06 secretless-boundary proofs. Task 1: unit coverage for
 * `scrubCredential`/`scrubError` (D-02's narrow, exact-value-only scrubber)
 * and `createRestOutboundConnector`'s bearer-attachment (D-01) -- the
 * trusted-boundary code where the token legitimately appears. Task 3 (below
 * this point, once written) extends this file with the end-to-end
 * adversarial proofs: a real MCP `Client` driven against the vault-backed
 * `ExecuteStage` wired to an echoing/throwing adversarial
 * `OutboundConnector`, asserting the seeded access-token value appears in
 * neither the `CallToolResult`, any surfaced error, nor the receipt chain.
 */

import { describe, expect, it } from "vitest";

import { createRestOutboundConnector } from "../src/connectors/outbound-connector.js";
import type { FetchLike } from "../src/connectors/outbound-connector.js";
import { scrubCredential, scrubError } from "../src/vault/scrub.js";

const SECRET_TOKEN = "distinctive-secret-token-xyz789";

describe("scrubCredential", () => {
  it("strips the exact known secret from a plain string value", () => {
    const scrubbed = scrubCredential(`token=${SECRET_TOKEN}`, [SECRET_TOKEN]);
    expect(scrubbed).not.toContain(SECRET_TOKEN);
  });

  it("strips the secret from nested object/array values without touching unrelated content", () => {
    const value = {
      a: { b: [`prefix-${SECRET_TOKEN}-suffix`, "unrelated"] },
      c: 42,
      d: null,
      e: undefined,
    };

    const scrubbed = scrubCredential(value, [SECRET_TOKEN]);

    expect(JSON.stringify(scrubbed)).not.toContain(SECRET_TOKEN);
    expect(scrubbed.c).toBe(42);
    expect(scrubbed.d).toBeNull();
    expect(scrubbed.a.b[1]).toBe("unrelated");
  });

  it("leaves a value with no matching secret entirely untouched", () => {
    const value = { hello: "world", n: 1 };
    expect(scrubCredential(value, [SECRET_TOKEN])).toEqual(value);
  });

  it("strips only the exact known secret(s), never a generic secret-shaped pattern", () => {
    const value = "sk-live-lookalikeSecretButNotTheKnownOne";
    // A value that merely *looks* secret-shaped, but isn't in knownSecrets,
    // must survive untouched -- this scrubber is exact-match only (D-02).
    expect(scrubCredential(value, [SECRET_TOKEN])).toBe(value);
  });
});

describe("scrubError", () => {
  it("strips the secret from a thrown error's message", () => {
    const err = new Error(`request failed, token was ${SECRET_TOKEN}`);

    const scrubbed = scrubError(err, [SECRET_TOKEN]);

    expect(scrubbed).toBeInstanceOf(Error);
    expect(scrubbed.message).not.toContain(SECRET_TOKEN);
  });

  it("strips the secret from an echoed field the original error carries (e.g. a body/cause)", () => {
    const err = new Error("connector failure") as Error & { body?: unknown };
    err.body = { leaked: SECRET_TOKEN };

    const scrubbed = scrubError(err, [SECRET_TOKEN]) as Error & { body?: unknown };

    expect(JSON.stringify(scrubbed.body)).not.toContain(SECRET_TOKEN);
  });

  it("never mutates or returns the original error object", () => {
    const err = new Error(`leak: ${SECRET_TOKEN}`);

    const scrubbed = scrubError(err, [SECRET_TOKEN]);

    expect(scrubbed).not.toBe(err);
    expect(err.message).toContain(SECRET_TOKEN);
  });
});

describe("createRestOutboundConnector", () => {
  it("attaches the credential as a bearer Authorization header on the outbound request", async () => {
    let capturedInit: RequestInit | undefined;
    const fetchImpl: FetchLike = (_input, init) => {
      capturedInit = init;
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    };

    const connector = createRestOutboundConnector(fetchImpl);
    const binding = {
      tool: "t",
      resource: "https://api.example.test/x",
      access: "read" as const,
      irreversible: false,
      provenance: "built_in" as const,
    };

    const result = await connector.execute(binding, {}, { accessToken: SECRET_TOKEN });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true });
    const headers = new Headers(capturedInit?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${SECRET_TOKEN}`);
  });
});
