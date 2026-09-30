/**
 * A user revokes the lease while the agent is still connected (E2E-02, LIFE-02,
 * TEAR-01). `stint revoke` is the USER actor: it moves the lease to teardown and
 * auto-chains the full five-step teardown, all through the shipped runtime. The
 * agent (which has no way to revoke) then tries one more call and finds a dead
 * lease: deny-by-default, no customer service hit, no new credential use.
 *
 * Every server binds loopback port 0 and is stopped inside `runScenario`. No sleeps.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runScenario } from "../src/scenario.js";
import type { ScenarioResult } from "../src/scenario.js";

function textOf(result: CallToolResult | undefined): string {
  const first = result?.content[0];
  return first?.type === "text" ? first.text : "";
}

describe("user revoke mid-run", () => {
  let run: ScenarioResult;

  beforeAll(async () => {
    run = await runScenario({
      end: "revoke",
      approvals: [],
      script: [{ name: "list_transactions" }, { name: "read_orders" }],
      postEndCall: { name: "read_orders" },
    });
  });

  afterAll(async () => {
    await run.dispose();
  });

  it("tears the lease down to cleaned_up and exits 0", () => {
    expect(run.exitCodes.create).toBe(0);
    expect(run.exitCodes.end).toBe(0);
    expect(run.lease?.state).toBe("cleaned_up");
    expect(run.lease?.teardownProgress).toEqual({
      revoke_oauth: "revoked",
      invalidate_license: "ok",
      cleanup_hook: "attested_ok",
      delete_cached_data: "ok",
      final_receipt: "ok",
    });

    // The two pre-revoke calls worked.
    expect(run.results).toHaveLength(2);
    for (const result of run.results) expect(result.isError).not.toBe(true);
  });

  it("denies the next agent call with lease_not_active and touches no service", () => {
    expect(run.postEndResult?.isError).toBe(true);
    expect(textOf(run.postEndResult)).toContain("denied: lease_not_active");

    // Only the two authorized pre-revoke calls ever reached a service.
    expect(run.paystackRequests).toHaveLength(1);
    expect(run.sheetsRequests.map((request) => request.kind)).toEqual(["read"]);

    // The lease never came back to active after the revoke.
    expect(run.lease?.state).toBe("cleaned_up");

    // The denial is receipted on the verified chain, after teardown began.
    const last = run.verifiedReceipts[run.verifiedReceipts.length - 1];
    expect(last?.type).toBe("call");
    if (last?.type === "call") {
      expect(last.payload.outcome).toBe("denied");
      expect(last.payload.redactedSummary).toContain("lease_not_active");
    }
  });

  it("revokes each OAuth grant at the authorization server exactly once, never per call", () => {
    // One POST /revoke per acquired grant (Paystack and the orders sheet): teardown
    // revokes each exactly once, and the post-revoke denied call triggered no more.
    const grants = Object.keys(run.credentials).length;
    expect(grants).toBe(2);
    expect(run.as.revokeHits).toBe(grants);
    expect(run.publisher.invalidateHits).toBe(1);
    expect(run.publisher.cleanupHits).toBe(1);
  });

  it("leaves both receipt chains verifiable and records the user as the revoker", async () => {
    expect(run.exitCodes.verify).toBe(0);
    const verify = await run.cli(["verify", run.leaseId]);
    expect(verify.code).toBe(0);

    const transitions = run.verifiedReceipts.flatMap((entry) =>
      entry.type === "transition" ? [entry.payload] : [],
    );
    const revoked = transitions.find((t) => t.event === "revoke");
    expect(revoked?.actor).toBe("user");
    // The agent is never the actor of any transition.
    expect(transitions.every((t) => t.actor !== "agent")).toBe(true);
  });
});
