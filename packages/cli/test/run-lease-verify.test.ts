/**
 * `runLease` host-side outcome verification and in-memory license custody
 * (plan 07-04 task 2): `RunningLease.verifyOutcome()` drives the manifest's
 * `resource_query` verifier to `completed` -> `cleaned_up` (LIFE-06, D-15);
 * the agent has no tool that can do so (Phase 5 D-03); the license is
 * refreshed best-effort, clamped to lease expiry, and never reaches the
 * outbound connector (LIC-03, LIC-05, D-17).
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createBindingSet } from "@stint/core";
import { afterEach, describe, expect, it } from "vitest";

import { CliError } from "../src/exit.js";
import { NOW } from "./helpers/cli-harness.js";
import { createHybridFixture } from "./helpers/hybrid-fixture.js";
import type { HybridFixture } from "./helpers/hybrid-fixture.js";

let fx: HybridFixture | undefined;
afterEach(async () => {
  await fx?.stop();
  fx = undefined;
});

const LEASE_TTL = 3600; // delegatedManifest's lease.max_duration_seconds

/** Reads `exp` out of a PASETO v4.public token (signed, not encrypted): payload = all but the 64-byte signature. */
function licenseExp(token: string): number {
  const encoded = token.split(".")[2] ?? "";
  const bytes = Buffer.from(encoded, "base64url");
  const claims = JSON.parse(bytes.subarray(0, bytes.length - 64).toString("utf8")) as {
    exp: string;
  };
  return Date.parse(claims.exp) / 1000;
}

async function call(
  client: Awaited<ReturnType<HybridFixture["start"]>>["client"],
  name: string,
  args: Record<string, unknown> = {},
): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

describe("RunningLease.verifyOutcome (D-15)", () => {
  it("a satisfied resource_query completes the lease and auto-chains teardown to cleaned_up", async () => {
    fx = await createHybridFixture({ cleanupHook: true });
    const { client, running } = await fx.start({ withIssuer: true });

    expect((await call(client, "list_transactions")).isError).not.toBe(true);
    expect((await call(client, "mark_order_reconciled", { order_id: "o-1" })).isError).not.toBe(
      true,
    );

    const lease = await running.verifyOutcome();
    expect(lease.state).toBe("cleaned_up");
    expect(lease.teardownProgress).toMatchObject({
      revoke_oauth: "revoked",
      invalidate_license: "ok",
      cleanup_hook: "attested_ok",
      delete_cached_data: "ok",
      final_receipt: "ok",
    });
    expect(fx.publisher.invalidated).toEqual([fx.leaseId]);
    expect(fx.publisher.hits.cleanup).toBe(1);

    // Exactly one verification receipt, secretless, naming the verifier actor.
    const chain = await fx.deps.receiptStoreFactory(fx.harness.root, fx.leaseId).load("verified");
    const verification = chain.filter(
      (e) => e.type === "call" && e.payload.redactedSummary.includes("resource_query verification"),
    );
    expect(verification).toHaveLength(1);
    const summary = verification[0]?.type === "call" ? verification[0].payload.redactedSummary : "";
    expect(summary).toContain("actor=verifier");
    expect(summary).toContain("outcome=true");
    expect(JSON.stringify(chain)).not.toContain('reconciled"');
  });

  it("an unsatisfied predicate is a no-op: the lease stays active and the agent is not told anything", async () => {
    fx = await createHybridFixture();
    const { client, running } = await fx.start();
    await call(client, "list_transactions");

    const lease = await running.verifyOutcome();
    expect(lease.state).toBe("active");
    expect(lease.teardownProgress).toBeUndefined();
  });

  it("the agent has NO tool that can trigger verification or completion (Phase 5 D-03)", async () => {
    fx = await createHybridFixture();
    const { client } = await fx.start();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "list_orders",
      "list_transactions",
      "mark_order_reconciled",
    ]);
    // An agent guessing at completion tools is denied (no binding), and the lease stays active.
    for (const name of ["verify_outcome", "verifyOutcome", "done", "complete_lease"]) {
      const denied = await client
        .callTool({ name, arguments: {} })
        .then((r) => r as CallToolResult)
        .catch(() => ({ isError: true }) as CallToolResult);
      expect(denied.isError).toBe(true);
    }
    const lease = await fx.deps.storeFactory(fx.harness.root).load(fx.leaseId);
    expect(lease?.state).toBe("active");
  });

  it("a profile with no read binding carrying a rowAdapter (a JSON profile) fails with fixed text pointing at revoke", async () => {
    fx = await createHybridFixture();
    const bare = {
      ...fx.profile,
      bindings: createBindingSet(
        Object.values(fx.profile.bindings).map(
          ({ tool, resource, access, irreversible, provenance }) => ({
            tool,
            resource,
            access,
            irreversible,
            provenance,
          }),
        ),
      ),
    };
    const { running } = await fx.start({ profile: bare });

    let caught: unknown;
    try {
      await running.verifyOutcome();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CliError);
    expect((caught as CliError).safeMessage).toContain("stint revoke");
    const lease = await fx.deps.storeFactory(fx.harness.root).load(fx.leaseId);
    expect(lease?.state).toBe("active");
  });

  it("a second verifyOutcome after completion is refused (the lease is no longer active)", async () => {
    fx = await createHybridFixture();
    const { client, running } = await fx.start({ withIssuer: true });
    await call(client, "mark_order_reconciled", { order_id: "o-1" });
    await running.verifyOutcome();

    await expect(running.verifyOutcome()).rejects.toBeInstanceOf(CliError);
  });
});

describe("license custody and best-effort refresh (D-07, D-17, LIC-03, LIC-05)", () => {
  it("issues at start, refreshes inside the window, and no reissued exp exceeds the lease expiry", async () => {
    fx = await createHybridFixture();
    const { client } = await fx.start({ withIssuer: true });
    const leaseExpiresAt = NOW + LEASE_TTL;
    expect(fx.publisher.hits.issue).toBe(2); // create (activation) + run start

    await call(client, "list_transactions");
    expect(fx.publisher.hits.reissue).toBe(0); // fresh license: no refresh

    fx.time.now = NOW + 250; // inside the 60s window before exp = NOW + 300
    expect((await call(client, "list_transactions")).isError).not.toBe(true);
    expect(fx.publisher.hits.reissue).toBe(1);

    fx.time.now = NOW + 3500; // near the lease end: the new exp must clamp to the lease expiry
    expect((await call(client, "list_transactions")).isError).not.toBe(true);
    expect(fx.publisher.hits.reissue).toBe(2);

    expect(fx.publisher.issuedTokens.length).toBeGreaterThanOrEqual(4);
    for (const token of fx.publisher.issuedTokens) {
      expect(licenseExp(token)).toBeLessThanOrEqual(leaseExpiresAt);
    }

    const lease = await fx.deps.storeFactory(fx.harness.root).load(fx.leaseId);
    expect(lease?.state).toBe("active");
    expect(lease?.expiresAt).toBe(leaseExpiresAt); // refresh never moves the lease's expiry
  });

  it.each(["refuse", "decline"] as const)(
    "a publisher that %ss the reissue leaves the lease active, unmoved, and adds no deny",
    async (behavior) => {
      fx = await createHybridFixture();
      const { client } = await fx.start({ withIssuer: true });
      const before = await fx.deps.storeFactory(fx.harness.root).load(fx.leaseId);
      fx.publisher.behavior = behavior;

      fx.time.now = NOW + 250;
      const result = await call(client, "list_transactions");
      expect(result.isError).not.toBe(true);
      expect(fx.publisher.hits.reissue).toBe(1);
      expect(fx.paystack.hits).toHaveLength(1);

      const after = await fx.deps.storeFactory(fx.harness.root).load(fx.leaseId);
      expect(after?.state).toBe("active");
      expect(after?.expiresAt).toBe(before?.expiresAt);
    },
  );

  it("an unreachable publisher at run start is best-effort: the run starts and calls still work", async () => {
    fx = await createHybridFixture();
    fx.publisher.behavior = "refuse";
    const { client } = await fx.start({ withIssuer: true });
    expect((await call(client, "list_transactions")).isError).not.toBe(true);
    expect(fx.paystack.hits).toHaveLength(1);
  });

  it("the license never reaches an outbound connector or a customer resource (LIC-05)", async () => {
    fx = await createHybridFixture();
    const { client } = await fx.start({ withIssuer: true });
    await call(client, "list_transactions");
    fx.time.now = NOW + 250;
    await call(client, "mark_order_reconciled", { order_id: "o-1" });

    expect(fx.publisher.issuedTokens.length).toBeGreaterThan(0);
    const seenByCustomerApis = JSON.stringify([fx.paystack.hits, fx.sheets.hits]);
    for (const token of fx.publisher.issuedTokens) {
      expect(seenByCustomerApis).not.toContain(token);
    }
    for (const hit of [...fx.paystack.hits, ...fx.sheets.hits]) {
      expect(hit.authorization).toMatch(/^Bearer /);
      expect(hit.authorization).not.toContain("v4.public.");
    }
  });

  it("teardown invalidates the license with the publisher and discards custody", async () => {
    fx = await createHybridFixture();
    const { client, running } = await fx.start({ withIssuer: true });
    await call(client, "mark_order_reconciled", { order_id: "o-1" });

    const lease = await running.verifyOutcome();
    expect(lease.teardownProgress?.invalidate_license).toBe("ok");
    expect(fx.publisher.invalidated).toEqual([fx.leaseId]);

    // After teardown no reissue is ever attempted again.
    const reissues = fx.publisher.hits.reissue;
    fx.time.now = NOW + 250;
    await call(client, "list_transactions").catch(() => undefined);
    expect(fx.publisher.hits.reissue).toBe(reissues);
  });
});
