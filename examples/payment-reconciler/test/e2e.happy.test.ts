/**
 * The hybrid HAPPY PATH end to end (E2E-01, E2E-02): the whole real stack in one
 * process. acquire (PKCE vs the mock AS) -> license issued and held -> Paystack
 * read through the injected token -> orders write (approved) -> verifyOutcome ->
 * completed -> teardown -> `cleaned_up`, all through the shipped proxy, vault,
 * teardown and receipts. The adapter only proposes; core owns every deny.
 *
 * Every server binds loopback port 0 and is stopped inside `runScenario`; the
 * per-scenario temp dir is removed in `afterEach`. No sleeps.
 */

import { afterEach, describe, expect, it } from "vitest";

import { runScenario } from "../src/scenario.js";
import type { ScenarioResult } from "../src/scenario.js";

const disposers: Array<() => Promise<void>> = [];

async function scenario(config: Parameters<typeof runScenario>[0] = {}): Promise<ScenarioResult> {
  const result = await runScenario(config);
  disposers.push(result.dispose);
  return result;
}

afterEach(async () => {
  await Promise.all(disposers.splice(0).map((dispose) => dispose()));
});

describe("hybrid happy path", () => {
  it("runs acquire -> license -> governed calls -> approved write -> verifier -> cleaned_up", async () => {
    const run = await scenario();

    expect(run.exitCodes.create).toBe(0);
    expect(run.lease?.state).toBe("cleaned_up");

    // Every agent call succeeded (the approved write included).
    expect(run.results).toHaveLength(3);
    for (const result of run.results) expect(result.isError).not.toBe(true);

    // Each customer service got exactly the authorized traffic the script implies.
    const bearer = (request: { authorization: string | undefined }): boolean =>
      request.authorization?.startsWith("Bearer ") === true &&
      request.authorization.length > "Bearer ".length;
    expect(run.paystackRequests).toHaveLength(1);
    expect(run.paystackRequests.every(bearer)).toBe(true);
    // Sheet: one agent read, one approved write, one verifier read.
    expect(run.sheetsRequests.map((request) => request.kind)).toEqual(["read", "write", "read"]);
    expect(run.sheetsRequests.every(bearer)).toBe(true);
    expect(run.sheetsRows.find((row) => row.order_id === "ord_1001")?.status).toBe("reconciled");

    // The merged timeline is non-empty and ends in the terminal state.
    expect(run.timeline.length).toBeGreaterThan(0);
    const last = run.timeline[run.timeline.length - 1];
    expect(last?.origin).toBe("verified");
    expect(last?.entry.type).toBe("transition");
    if (last?.entry.type === "transition") expect(last.entry.payload.to).toBe("cleaned_up");
  });
});
