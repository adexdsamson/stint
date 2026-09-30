/**
 * `stint run` under a REAL MCP `Client` (SC#2, HOST-02, CLI-01): per-call
 * approval through the reference terminal adapter, timeout-deny, no-TTY deny,
 * `user_confirm` through `runUserConfirmVerification`, and the `run` command
 * itself over an injected transport. The terminal is a faked TTY (PassThrough
 * with `isTTY`), the transport is `InMemoryTransport`, nothing spawns.
 */

import { readFile, writeFile } from "node:fs/promises";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";

import { runUserConfirmVerification } from "@stint/proxy";

import { EXIT_CODES } from "../src/exit.js";
import { main } from "../src/program.js";
import { runLease } from "../src/run/run-lease.js";
import type { RunningLease } from "../src/run/run-lease.js";
import { envelopeFile } from "../src/store/envelope.js";
import { NOW } from "./helpers/cli-harness.js";
import { ACCESS_TOKEN, createRunFixture, terminalRig } from "./helpers/run-fixture.js";
import type { RunFixture, TerminalRig } from "./helpers/run-fixture.js";

interface Live {
  readonly fx: RunFixture;
  readonly rig: TerminalRig;
  readonly client: Client;
  readonly running: RunningLease;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

function text(result: CallToolResult): string {
  const [first] = result.content;
  if (first?.type !== "text") throw new Error("expected a text block");
  return first.text;
}

async function startRun(
  options: { approvalTimeoutSeconds?: number; tty?: boolean } = {},
): Promise<Live> {
  const fx = await createRunFixture(
    options.approvalTimeoutSeconds === undefined
      ? {}
      : { approvalTimeoutSeconds: options.approvalTimeoutSeconds },
  );
  const rig = terminalRig({
    ...(options.tty === undefined ? {} : { tty: options.tty }),
    ...(options.approvalTimeoutSeconds === undefined
      ? {}
      : { approvalTimeoutSeconds: options.approvalTimeoutSeconds }),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const running = await runLease({
    leaseId: fx.leaseId,
    root: fx.harness.root,
    transport: serverTransport,
    adapter: rig.adapter,
    deps: fx.harness.deps,
    verified: fx.verified,
    profile: fx.profile,
    credentials: fx.credentials,
    outboundFetch: fx.outboundFetch,
  });
  const client = new Client({ name: "test-agent", version: "0.0.0" });
  await client.connect(clientTransport);
  cleanups.push(async () => {
    await client.close();
    await fx.harness.cleanup();
  });
  return { fx, rig, client, running };
}

const sendNotice = { name: "send_notice", arguments: { to: "alice" } };

async function receipts(fx: RunFixture) {
  return await fx.harness.deps.receiptStoreFactory(fx.harness.root, fx.leaseId).load("verified");
}

describe("stint run: tools and the secretless boundary", () => {
  it("tools/list shows exactly the profile's tools (no user_confirm/done tool is added)", async () => {
    const { client } = await startRun();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["read_orders", "send_notice"]);
  });

  it("a read call needs no approval, hits the downstream with the vault token, and never leaks it to the agent", async () => {
    const { client, fx } = await startRun();
    const result = (await client.callTool({
      name: "read_orders",
      arguments: {},
    })) as CallToolResult;

    expect(result.isError).not.toBe(true);
    expect(JSON.parse(text(result))).toEqual({ rows: 3 });
    expect(JSON.stringify(result)).not.toContain(ACCESS_TOKEN);
    expect(fx.fetchCalls).toHaveLength(1);
    expect(fx.fetchCalls[0]?.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);

    const chain = await receipts(fx);
    const last = chain[chain.length - 1];
    expect(last?.type).toBe("call");
    if (last?.type === "call") expect(last.payload.outcome).toBe("allowed");
  });
});

describe("stint run: per-call approval through the terminal adapter (SC#2)", () => {
  it("y approves: the call executes and an allowed receipt is appended", async () => {
    const { client, rig, fx } = await startRun();
    const pending = client.callTool(sendNotice) as Promise<CallToolResult>;
    await rig.waitFor("Approve this action?");
    expect(rig.outText()).toContain("send_notice");
    rig.input.write("y\n");
    const result = await pending;

    expect(result.isError).not.toBe(true);
    expect(fx.fetchCalls).toHaveLength(1);
    const chain = await receipts(fx);
    const call = chain.filter((e) => e.type === "call").at(-1);
    if (call?.type !== "call") throw new Error("expected a call receipt");
    expect(call.payload.outcome).toBe("allowed");
  });

  it("n denies: the call never reaches the downstream and a denied receipt is appended", async () => {
    const { client, rig, fx } = await startRun();
    const pending = client.callTool(sendNotice) as Promise<CallToolResult>;
    await rig.waitFor("Approve this action?");
    rig.input.write("n\n");
    const result = await pending;

    expect(result.isError).toBe(true);
    expect(text(result)).toBe("denied: user_denied");
    expect(fx.fetchCalls).toHaveLength(0);
    const chain = await receipts(fx);
    const call = chain.filter((e) => e.type === "call").at(-1);
    if (call?.type !== "call") throw new Error("expected a call receipt");
    expect(call.payload.outcome).toBe("denied");
  });

  it("an unanswered prompt is denied by core's timeout once approvals.timeout_seconds elapses", async () => {
    const { client, rig, fx } = await startRun({ approvalTimeoutSeconds: 1 });
    const started = Date.now();
    const pending = client.callTool(sendNotice) as Promise<CallToolResult>;
    await rig.waitFor("Approve this action?");
    // Deliberately no answer.
    const result = await pending;

    expect(result.isError).toBe(true);
    expect(text(result)).toBe("denied: timeout");
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(fx.fetchCalls).toHaveLength(0);
  });

  it(
    "with no TTY every approval denies immediately, without blocking (deny-by-default)",
    { timeout: 10_000 },
    async () => {
      // A 60s approval window: if the no-TTY path blocked, this test would time out at 10s.
      const { client, rig, fx } = await startRun({ tty: false });
      const result = (await client.callTool(sendNotice)) as CallToolResult;

      expect(result.isError).toBe(true);
      expect(text(result)).toMatch(/^denied: /);
      expect(fx.fetchCalls).toHaveLength(0);
      expect(rig.errText()).toContain("no interactive terminal");
    },
  );
});

describe("stint run: user_confirm outcome verification through the terminal adapter", () => {
  function confirmDeps(fx: RunFixture, rig: TerminalRig, signal: AbortSignal) {
    return {
      leaseStore: fx.harness.deps.storeFactory(fx.harness.root),
      receiptStore: fx.harness.deps.receiptStoreFactory(fx.harness.root, fx.leaseId),
      leaseId: fx.leaseId,
      adapter: rig.adapter,
      prompt: "Did the reconciliation finish?",
      signal,
    };
  }

  it("confirm (y) completes the lease", async () => {
    const fx = await createRunFixture();
    cleanups.push(() => fx.harness.cleanup());
    const rig = terminalRig();
    const pending = runUserConfirmVerification(
      confirmDeps(fx, rig, new AbortController().signal),
      NOW,
    );
    await rig.waitFor("Did this happen?");
    rig.input.write("y\n");

    expect(await pending).toBe("true");
    const lease = await fx.harness.deps.storeFactory(fx.harness.root).load(fx.leaseId);
    expect(lease?.state).not.toBe("active");
    expect(["completed", "tearing_down", "cleaned_up"]).toContain(lease?.state);
  });

  it("reject (n) never completes the lease", async () => {
    const fx = await createRunFixture();
    cleanups.push(() => fx.harness.cleanup());
    const rig = terminalRig();
    const pending = runUserConfirmVerification(
      confirmDeps(fx, rig, new AbortController().signal),
      NOW,
    );
    await rig.waitFor("Did this happen?");
    rig.input.write("n\n");

    expect(await pending).toBe("false");
    expect((await fx.harness.deps.storeFactory(fx.harness.root).load(fx.leaseId))?.state).toBe(
      "active",
    );
  });

  it("an unanswered prompt that times out never completes the lease", async () => {
    const fx = await createRunFixture();
    cleanups.push(() => fx.harness.cleanup());
    const rig = terminalRig();
    const controller = new AbortController();
    const pending = runUserConfirmVerification(confirmDeps(fx, rig, controller.signal), NOW);
    await rig.waitFor("Did this happen?");
    controller.abort();

    expect(await pending).toBe("false");
    expect((await fx.harness.deps.storeFactory(fx.harness.root).load(fx.leaseId))?.state).toBe(
      "active",
    );
  });
});

describe("stint run command (in-process, injected transport)", () => {
  function runArgs(fx: RunFixture, extra: string[] = []): string[] {
    return [
      "--store",
      fx.harness.root,
      "run",
      fx.leaseId,
      "--profile",
      fx.profilePath,
      "--credentials",
      fx.credentialsPath,
      ...extra,
    ];
  }

  it("serves tools, denies an approval-gated call with no controlling terminal, exits 0 on disconnect, and never writes stdout", async () => {
    const fx = await createRunFixture();
    cleanups.push(() => fx.harness.cleanup());
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const deps = {
      ...fx.harness.deps,
      run: { openTerminal: () => undefined, createTransport: () => serverTransport },
    };
    const done = main(runArgs(fx), deps);

    const client = new Client({ name: "test-agent", version: "0.0.0" });
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(2);
    const result = (await client.callTool(sendNotice)) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/^denied: /);
    await client.close();

    expect(await done).toBe(EXIT_CODES.ok);
    expect(fx.harness.stdout).toEqual([]);
    expect(fx.harness.stderr.join("")).toContain("no controlling terminal");
  });

  it("--profile is required (exit 2) and, even under --json, errors go to stderr, not stdout", async () => {
    const fx = await createRunFixture();
    cleanups.push(() => fx.harness.cleanup());
    const code = await main(
      ["--store", fx.harness.root, "--json", "run", fx.leaseId],
      fx.harness.deps,
    );
    expect(code).toBe(EXIT_CODES.usage);
    expect(fx.harness.stdout).toEqual([]);
    expect(fx.harness.stderr.join("")).toContain("--profile");
  });

  it("an unknown lease exits 4; a delegated lease without --credentials exits 2", async () => {
    const fx = await createRunFixture();
    cleanups.push(() => fx.harness.cleanup());
    expect(
      await main(
        ["--store", fx.harness.root, "run", "no-such-lease", "--profile", fx.profilePath],
        fx.harness.deps,
      ),
    ).toBe(EXIT_CODES.leaseNotFound);
    expect(
      await main(
        ["--store", fx.harness.root, "run", fx.leaseId, "--profile", fx.profilePath],
        fx.harness.deps,
      ),
    ).toBe(EXIT_CODES.usage);
  });

  it("a tampered stored envelope fails verification (exit 5) before anything is served", async () => {
    const fx = await createRunFixture();
    cleanups.push(() => fx.harness.cleanup());
    const file = envelopeFile(fx.harness.root, fx.leaseId);
    const tampered = (await readFile(file, "utf8")).replace(
      "Order Reconciler",
      "Order Reconcilerx",
    );
    await writeFile(file, tampered);

    expect(await main(runArgs(fx), fx.harness.deps)).toBe(EXIT_CODES.manifestInvalid);
    expect(fx.harness.stdout).toEqual([]);
  });

  it("a lease whose bound hash no longer matches the manifest is failed, receipted, and not served (exit 9)", async () => {
    const fx = await createRunFixture();
    cleanups.push(() => fx.harness.cleanup());
    const store = fx.harness.deps.storeFactory(fx.harness.root);
    await store.transaction(fx.leaseId, (l) => ({ ...l, boundHash: "jcs-sha256:0000" }));

    expect(await main(runArgs(fx), fx.harness.deps)).toBe(EXIT_CODES.wrongState);
    const lease = await store.load(fx.leaseId);
    expect(lease?.state).toBe("failed");
    const chain = await receipts(fx);
    expect(chain.some((e) => e.type === "transition")).toBe(true);
  });

  it("a lease that is not active is not served (exit 9)", async () => {
    const fx = await createRunFixture();
    cleanups.push(() => fx.harness.cleanup());
    const store = fx.harness.deps.storeFactory(fx.harness.root);
    await store.transaction(fx.leaseId, (l) => ({ ...l, state: "revoked" }));
    expect(await main(runArgs(fx), fx.harness.deps)).toBe(EXIT_CODES.wrongState);
  });
});
