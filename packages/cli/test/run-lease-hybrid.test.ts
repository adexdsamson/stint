/**
 * `runLease` for a HYBRID lease (plan 07-04 task 1): the REAL REST connector
 * reaches loopback "customer APIs" through the profile's `endpoints` map
 * (identifier != URL, Pitfall 3), the vault refreshes over a loopback
 * authorization server (derived `allowInsecureRequests`, Pitfall 2), and real
 * teardown steps are wired (Pattern 3).
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";

import { CliError } from "../src/exit.js";
import { parseRunProfile } from "../src/run/profile.js";
import { createHybridFixture, PAYSTACK, SHEETS } from "./helpers/hybrid-fixture.js";
import type { HybridFixture } from "./helpers/hybrid-fixture.js";

let fx: HybridFixture | undefined;
afterEach(async () => {
  await fx?.stop();
  fx = undefined;
});

const PROFILE_JSON = {
  catalog: [{ name: "list_transactions", description: "d", inputSchema: { type: "object" } }],
  bindings: [
    {
      tool: "list_transactions",
      resource: PAYSTACK,
      access: "read",
      irreversible: false,
      provenance: "built_in",
    },
  ],
  oauth: {
    as: { issuer: "https://as.example.test", token_endpoint: "https://as.example.test/token" },
    client_id: "c",
    auth_method: "none",
  },
};

describe("run profile `endpoints` map", () => {
  it("is optional: a profile without it parses unchanged", () => {
    expect(parseRunProfile(PROFILE_JSON).endpoints).toBeUndefined();
  });

  it("accepts https and loopback-http URLs", () => {
    const profile = parseRunProfile({
      ...PROFILE_JSON,
      endpoints: { [PAYSTACK]: "https://api.paystack.co/transaction", x: "http://127.0.0.1:9/api" },
    });
    expect(profile.endpoints).toEqual({
      [PAYSTACK]: "https://api.paystack.co/transaction",
      x: "http://127.0.0.1:9/api",
    });
  });

  it.each([
    ["a non-loopback http URL", { [PAYSTACK]: "http://api.example.test/x" }],
    ["an unparseable URL", { [PAYSTACK]: "not a url" }],
    ["a non-string value", { [PAYSTACK]: 5 }],
    ["an empty value", { [PAYSTACK]: "" }],
    ["a non-record", ["https://api.example.test"]],
  ])("rejects %s with the fixed usage error and never echoes it", (_name, endpoints) => {
    let caught: unknown;
    try {
      parseRunProfile({ ...PROFILE_JSON, endpoints });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CliError);
    expect((caught as CliError).safeMessage).toBe("The run profile has an unexpected shape.");
    expect((caught as CliError).safeMessage).not.toContain("example.test");
  });
});

function body(result: CallToolResult): unknown {
  const [first] = result.content;
  if (first?.type !== "text") throw new Error("expected a text block");
  return JSON.parse(first.text) as unknown;
}

describe("runLease: hybrid outbound through the endpoints map", () => {
  it("reaches both loopback APIs at the mapped URL with a Bearer token; the bare identifier is never a URL", async () => {
    fx = await createHybridFixture();
    const { client } = await fx.start();

    const list = (await client.callTool({
      name: "list_transactions",
      arguments: {},
    })) as CallToolResult;
    expect(list.isError).not.toBe(true);
    expect(body(list)).toEqual({ transactions: [{ id: "t1", amount: 1000 }] });

    const mark = (await client.callTool({
      name: "mark_order_reconciled",
      arguments: { order_id: "o-1" },
    })) as CallToolResult;
    expect(mark.isError).not.toBe(true);

    expect(fx.paystack.hits).toHaveLength(1);
    expect(fx.sheets.hits).toHaveLength(1);
    expect(fx.paystack.hits[0]?.authorization).toMatch(/^Bearer .+/);
    expect(fx.sheets.hits[0]?.authorization).toMatch(/^Bearer .+/);
    expect(fx.sheets.hits[0]?.body).toEqual({ order_id: "o-1" });

    expect(fx.outboundUrls).toEqual([fx.paystack.url, fx.sheets.url]);
    expect(fx.outboundUrls).not.toContain(PAYSTACK);
    expect(fx.outboundUrls).not.toContain(SHEETS);
  });

  it("refreshes over the loopback authorization server with no clock jump (forceNextExpiresIn)", async () => {
    fx = await createHybridFixture();
    fx.mock.forceNextExpiresIn(1);
    const { client } = await fx.start();

    // Seeded credential is already expired: the first call refreshes over loopback http.
    await client.callTool({ name: "list_transactions", arguments: {} });
    expect(fx.mock.tokenEndpointHits).toBe(1);
    const first = fx.paystack.hits[0]?.authorization;

    // The refreshed token lives 1s: moving the shared clock 5s forces another refresh.
    fx.time.now += 5;
    const again = (await client.callTool({
      name: "list_transactions",
      arguments: {},
    })) as CallToolResult;
    expect(again.isError).not.toBe(true);
    expect(fx.mock.tokenEndpointHits).toBe(2);
    expect(fx.paystack.hits).toHaveLength(2);
    expect(first).toMatch(/^Bearer .+/);
  });
});

describe("runLease: real teardown steps", () => {
  it("a provider revocation mid-run runs the real teardown instead of leaving the lease tearing_down", async () => {
    fx = await createHybridFixture();
    const { client } = await fx.start();
    fx.mock.forceNextTokenError("invalid_grant");

    const denied = (await client.callTool({
      name: "list_transactions",
      arguments: {},
    })) as CallToolResult;
    expect(denied.isError).toBe(true);

    const lease = await fx.deps.storeFactory(fx.harness.root).load(fx.leaseId);
    expect(lease?.state).not.toBe("tearing_down");
    expect(["cleaned_up", "cleanup_incomplete"]).toContain(lease?.state);
    // A hybrid lease with no reachable publisher client cannot invalidate its license: honest failure.
    expect(lease?.teardownProgress?.invalidate_license).toBe("failed");
    expect(lease?.teardownProgress?.final_receipt).toBe("ok");
    expect(fx.paystack.hits).toHaveLength(0);
  });
});
