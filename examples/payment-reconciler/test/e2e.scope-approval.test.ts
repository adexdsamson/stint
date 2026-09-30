/**
 * Deny-by-default and out-of-band approvals end to end (E2E-02, PRXY-02, PRXY-03,
 * PRXY-05), through the shipped runtime behind a real MCP client.
 *
 * - An UNGRANTED `pay`-class tool (`issue_refund`) is not in `tools/list`, is denied
 *   `no_binding` when the agent guesses it anyway, reaches no customer service and
 *   leaves a denied receipt. The agent's own guess grants nothing.
 * - An irreversible write the user approves updates the sheet; one the user denies is
 *   `denied: user_denied` with no service hit; one nobody answers is denied by core's
 *   own timeout (the adapter never owns the deny decision).
 *
 * Every server binds loopback port 0 and is stopped inside `runScenario`. The only
 * real timer is the approval deadline in the timeout case (1s, the assertion itself).
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, describe, expect, it } from "vitest";

import { runScenario } from "../src/scenario.js";
import type { ScenarioConfig, ScenarioResult } from "../src/scenario.js";

const disposers: Array<() => Promise<void>> = [];

async function scenario(config: ScenarioConfig = {}): Promise<ScenarioResult> {
  const result = await runScenario(config);
  disposers.push(result.dispose);
  return result;
}

afterAll(async () => {
  await Promise.all(disposers.splice(0).map((dispose) => dispose()));
});

function textOf(result: CallToolResult | undefined): string {
  const first = result?.content[0];
  return first?.type === "text" ? first.text : "";
}

const WRITE = {
  name: "mark_order_reconciled",
  arguments: { order_id: "ord_1001", status: "reconciled" },
} as const;

describe("an out-of-scope call (deny by default)", () => {
  it("hides the ungranted pay tool, denies no_binding, hits no service and receipts the denial", async () => {
    const run = await scenario({
      end: "none",
      script: [
        { name: "issue_refund", arguments: { transaction_id: "txn_1", amount: 1000 } },
        { name: "read_orders" },
      ],
      approvals: [],
    });

    // The agent is never told the tool exists.
    expect(run.toolNames).not.toContain("issue_refund");
    expect([...run.toolNames].sort()).toEqual([
      "list_transactions",
      "mark_order_reconciled",
      "read_orders",
    ]);

    // Guessing it anyway is a denial, not a transport failure.
    const refund = run.results[0];
    expect(refund?.isError).toBe(true);
    expect(textOf(refund)).toContain("denied: no_binding");

    // Zero customer-service hits for the denied call: the only traffic is the later
    // authorized sheet read, never Paystack.
    expect(run.paystackRequests).toHaveLength(0);
    expect(run.sheetsRequests.map((request) => request.kind)).toEqual(["read"]);
    expect(run.sheetsRequests.some((request) => request.kind === "write")).toBe(false);

    // The denial is on the signed verified chain, against no resolved resource.
    const denied = run.verifiedReceipts.flatMap((entry) =>
      entry.type === "call" && entry.payload.outcome === "denied" ? [entry.payload] : [],
    );
    expect(denied).toHaveLength(1);
    expect(denied[0]?.resource).toBe("unresolved");
    expect(denied[0]?.redactedSummary).toContain("no_binding");
    expect(run.exitCodes.verify).toBe(0);

    // The denial did not disturb the lease: the later in-scope call worked and it is still active.
    expect(run.results[1]?.isError).not.toBe(true);
    expect(run.lease?.state).toBe("active");
  });
});

describe("a per-call approval (PRXY-05)", () => {
  it("applies the approved write and denies the refused one with no service hit", async () => {
    const run = await scenario({
      end: "none",
      approvals: ["approve", "deny"],
      script: [
        WRITE,
        {
          name: "mark_order_reconciled",
          arguments: { order_id: "ord_1002", status: "reconciled" },
        },
      ],
    });

    // Approved: the sheet was really written, with the injected bearer.
    expect(run.results[0]?.isError).not.toBe(true);
    const writes = run.sheetsRequests.filter((request) => request.kind === "write");
    expect(writes).toHaveLength(1);
    expect(writes[0]?.authorization?.startsWith("Bearer ")).toBe(true);
    expect(run.sheetsRows.find((row) => row.order_id === "ord_1001")?.status).toBe("reconciled");

    // Denied: a user_denied result, no write, and the row is untouched.
    expect(run.results[1]?.isError).toBe(true);
    expect(textOf(run.results[1])).toContain("denied: user_denied");
    expect(run.sheetsRows.find((row) => row.order_id === "ord_1002")?.status).not.toBe(
      "reconciled",
    );

    // The adapter was asked once per irreversible write, each bound to the tool.
    expect(run.approvalRequests.map((request) => request.binding.tool)).toEqual([
      "mark_order_reconciled",
      "mark_order_reconciled",
    ]);

    // One allowed and one denied call receipt for the two writes.
    const outcomes = run.verifiedReceipts.flatMap((entry) =>
      entry.type === "call" ? [entry.payload.outcome] : [],
    );
    expect(outcomes).toEqual(["allowed", "denied"]);
    expect(run.lease?.state).toBe("active");
  });

  it("denies by timeout when nobody answers and makes no service hit", async () => {
    const run = await scenario({
      end: "none",
      approvals: ["hang"],
      approvalTimeoutSeconds: 1,
      script: [WRITE],
    });

    expect(run.results[0]?.isError).toBe(true);
    expect(textOf(run.results[0])).toMatch(/^denied: /);
    expect(textOf(run.results[0])).toContain("timeout");
    expect(run.approvalRequests).toHaveLength(1);

    // No write reached the sheet; the row is unchanged.
    expect(run.sheetsRequests.some((request) => request.kind === "write")).toBe(false);
    expect(run.sheetsRows.find((row) => row.order_id === "ord_1001")?.status).not.toBe(
      "reconciled",
    );
    expect(run.lease?.state).toBe("active");
  });
});
