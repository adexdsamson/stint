/**
 * The quickstart (`pnpm example:payment-reconciler`, D-11/D-12/D-19): ONE command
 * that runs the whole Agent Lease lifecycle on loopback with real process
 * boundaries for the serving step, then prints the honest success signal: the
 * merged `stint receipts` timeline plus a one-line terminal-state summary.
 *
 *   mocks (authorization server, publisher, Paystack, orders sheet) ->
 *   headless OAuth grants -> signed manifest -> `stint create --publisher`
 *   (ACTIVE) -> spawned `stint run` over MCP stdio on a VISIBLE console ->
 *   the agent stub's tool calls -> `stint revoke --yes` -> teardown ->
 *   `stint receipts`.
 *
 * Non-interactive by default so the verbatim command always finishes: with no
 * terminal, consent is auto-granted (with a printed notice) and the irreversible
 * write is denied on a short approvals timeout, the fail-safe behavior. On a
 * real terminal, consent and the per-call approval prompt are yours to answer.
 * The approved-call evidence (verifier completion, refresh, partial teardown)
 * lives in the e2e suite (`pnpm test:e2e`), not here.
 *
 * Secrets: nothing printed here ever contains an access token or a `v4.public.`
 * license. Every line goes through `emit`, which refuses to print one, and the
 * child's stdout (the MCP channel) is never echoed.
 */

import { connectAgent } from "./agent.js";
import type { AgentStep } from "./agent.js";
import { createVisibleConsoleTransport, resolveCliBin } from "./launcher.js";
import { prepareSpawnedLease } from "./spawned-lease.js";
import type { SpawnedLease } from "./spawned-lease.js";

/** Approvals window when a human can answer / when nobody can (fail-safe deny). */
const INTERACTIVE_APPROVAL_SECONDS = 60;
const NON_INTERACTIVE_APPROVAL_SECONDS = 2;

const DEMO_SCRIPT: readonly AgentStep[] = [
  { name: "list_transactions" },
  { name: "read_orders" },
  { name: "mark_order_reconciled", arguments: { order_id: "ord_1001", status: "reconciled" } },
];

function textOf(result: { content: readonly { type: string; text?: string }[] }): string {
  const first = result.content[0];
  return first?.type === "text" && typeof first.text === "string" ? first.text : "";
}

async function run(): Promise<number> {
  const interactive = process.stdin.isTTY && process.stdout.isTTY;
  let lease: SpawnedLease | undefined;

  // The single stdout sink: refuses to print a secret-shaped value.
  const emit = (line: string): void => {
    const secrets = lease?.secrets() ?? [];
    if (line.includes("v4.public.") || secrets.some((secret) => line.includes(secret))) {
      throw new Error("Refusing to print a secret-shaped value.");
    }
    process.stdout.write(`${line}\n`);
  };

  emit("Stint quickstart: payment-reconciler (hermetic, loopback only)");
  if (!interactive) {
    emit(
      "No terminal detected: consent is auto-granted for this demo, and the irreversible write will be denied on timeout (fail-safe).",
    );
  }

  try {
    lease = await prepareSpawnedLease({
      approvalTimeoutSeconds: interactive
        ? INTERACTIVE_APPROVAL_SECONDS
        : NON_INTERACTIVE_APPROVAL_SECONDS,
      interactive,
    });
    emit(`Lease ${lease.leaseId} created and ACTIVE. Serving it over MCP stdio...`);

    // The visible-console launcher: the approval prompt shares this console (D-08).
    const transport = createVisibleConsoleTransport(resolveCliBin(), {
      args: [
        "--store",
        lease.root,
        "run",
        lease.leaseId,
        "--profile",
        lease.profilePath,
        "--credentials",
        lease.credentialsPath,
      ],
    });
    const agent = await connectAgent(transport);
    try {
      emit(`Agent saw tools: ${[...agent.toolNames].sort().join(", ")}`);
      for (const step of DEMO_SCRIPT) {
        const result = await agent.call(step);
        emit(`  ${step.name} -> ${result.isError === true ? textOf(result) : "ok"}`);
      }

      // End the lease as the user WHILE the agent is still connected: full five-step teardown.
      const ended = await lease.cli([
        "revoke",
        lease.leaseId,
        "--yes",
        "--credentials",
        lease.credentialsPath,
      ]);
      if (ended.code !== 0) throw new Error("Teardown failed: `stint revoke` did not succeed.");
    } finally {
      await agent.close().catch(() => undefined);
    }

    const receipts = await lease.cli(["receipts", lease.leaseId]);
    if (receipts.code !== 0) throw new Error("`stint receipts` did not succeed.");
    emit("");
    emit("Receipts timeline ([verified] = runtime-signed chain, [attested] = publisher claims):");
    for (const line of receipts.out.split("\n")) if (line !== "") emit(line);

    const state = await lease.state();
    const hookAttested = receipts.out.includes("teardown cleanup_hook: attested_ok");
    emit("");
    emit(
      `Lease ${lease.leaseId} finished: ${state ?? "unknown"} (publisher cleanup ${hookAttested ? "attested" : "not attested"}).`,
    );
    return state === "cleaned_up" ? 0 : 1;
  } catch (error) {
    // Fixed-text only: never an upstream error body, token or license.
    const message =
      error instanceof Error && /^(Setup|Teardown|`stint|OAuth|Refusing)/.test(error.message)
        ? error.message
        : "unexpected error.";
    process.stderr.write(`quickstart failed: ${message}
`);
    return 1;
  } finally {
    await lease?.dispose();
  }
}

process.exitCode = await run();
