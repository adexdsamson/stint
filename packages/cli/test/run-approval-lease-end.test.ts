/**
 * End to end on the real JSON stores (PRXY-10, D-20): while an approval prompt
 * is on screen in a served lease, `stint revoke` on the same store completes
 * with its normal exit code and no busy error, the prompt shows the cancel
 * line, and the waiting call returns `denied: lease_ended`.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";

import { EXIT_CODES } from "../src/exit.js";
import { main } from "../src/program.js";
import { runLease } from "../src/run/run-lease.js";
import { terminalRig } from "./helpers/run-fixture.js";
import { createTeardownRig } from "./helpers/teardown-rig.js";
import type { TeardownRig } from "./helpers/teardown-rig.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

function text(result: CallToolResult): string {
  const [first] = result.content;
  if (first?.type !== "text") throw new Error("expected a text block");
  return first.text;
}

async function serve(rig: TeardownRig, approvalWatchMs: number) {
  const terminal = terminalRig();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await runLease({
    leaseId: rig.leaseId,
    root: rig.root,
    transport: serverTransport,
    adapter: terminal.adapter,
    deps: rig.fx.harness.deps,
    verified: rig.fx.verified,
    profile: rig.fx.profile,
    credentials: rig.fx.credentials,
    outboundFetch: rig.fx.outboundFetch,
    approvalWatchMs,
  });
  const client = new Client({ name: "test-agent", version: "0.0.0" });
  await client.connect(clientTransport);
  cleanups.push(async () => {
    await client.close();
    await rig.fx.harness.cleanup();
  });
  return { client, terminal };
}

describe("a lease revoked while an approval prompt is on screen", () => {
  it("lets revoke finish, cancels the prompt with the cancel line, and denies the call lease_ended", async () => {
    const rig = await createTeardownRig();
    const { client, terminal } = await serve(rig, 50);

    const pending = client.callTool({
      name: "send_notice",
      arguments: { to: "alice" },
    }) as Promise<CallToolResult>;
    await terminal.waitFor("Approve this action?");

    const code = await main(
      rig.argv("revoke", "--yes", "--credentials", rig.fx.credentialsPath),
      rig.deps,
    );

    expect(code).not.toBe(EXIT_CODES.leaseBusy);
    expect(code).toBe(EXIT_CODES.ok);
    expect(rig.fx.harness.stderr.join("")).not.toContain("The lease is busy");

    const result = await pending;
    expect(result.isError).toBe(true);
    expect(text(result)).toBe("denied: lease_ended");
    await terminal.waitFor("Lease ended, approval no longer needed.");
    expect(terminal.outText()).toContain("Lease ended, approval no longer needed.");

    // Nothing reached the downstream and exactly one denied call receipt was written.
    expect(rig.fx.fetchCalls).toHaveLength(0);
    const calls = await rig.entries("call");
    expect(calls).toHaveLength(1);
    const [call] = calls;
    if (call?.type !== "call") throw new Error("expected a call receipt");
    expect(call.payload.outcome).toBe("denied");
    expect(call.payload.redactedSummary).toBe('call to "send_notice" denied: lease_ended');
  });
});
