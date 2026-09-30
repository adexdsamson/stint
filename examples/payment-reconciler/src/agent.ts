/**
 * The example's AGENT STUB: a real `@modelcontextprotocol/sdk` `Client` that
 * talks to the lease proxy over an injected `Transport`.
 *
 * It is the untrusted side of the boundary. It holds no credentials, never sees
 * the license, and takes nothing but a `Transport`, so the same stub serves the
 * in-process harness (one half of an `InMemoryTransport` pair) and a spawned
 * `stint run` over stdio. It imports no license, vault or runtime code on
 * purpose: whatever it can observe is exactly what a real agent could observe.
 *
 * A failed call is not an exception here. A denial reaches the agent as an
 * `isError` tool result (that is the proxy's contract), and a transport failure
 * is folded into a fixed-text error result so a scenario can assert on it.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** One tool call the agent issues. `before` runs first (a harness hook, e.g. to move a shared test clock). */
export interface AgentStep {
  readonly name: string;
  readonly arguments?: Readonly<Record<string, unknown>>;
  readonly before?: () => void | Promise<void>;
}

/** What a finished scripted run observed, all of it agent-visible. */
export interface AgentRun {
  /** The tool names `tools/list` advertised. */
  readonly toolNames: readonly string[];
  /** One `CallToolResult` per scripted step, in order. */
  readonly results: readonly CallToolResult[];
}

/** A connected agent that can keep issuing calls (used for calls made after a lease has ended). */
export interface ConnectedAgent {
  readonly toolNames: readonly string[];
  readonly call: (step: AgentStep) => Promise<CallToolResult>;
  readonly close: () => Promise<void>;
}

const CALL_FAILED: CallToolResult = {
  isError: true,
  content: [{ type: "text", text: "agent_call_failed" }],
};

/** Connects an MCP client to `transport` and lists the tools the proxy exposes. */
export async function connectAgent(transport: Transport): Promise<ConnectedAgent> {
  const client = new Client({ name: "payment-reconciler-agent", version: "0.0.0" });
  await client.connect(transport);
  const { tools } = await client.listTools();

  const call = async (step: AgentStep): Promise<CallToolResult> => {
    await step.before?.();
    try {
      return (await client.callTool({
        name: step.name,
        arguments: { ...(step.arguments ?? {}) },
      })) as CallToolResult;
    } catch {
      // Never surface SDK error text: the agent-visible record stays fixed and secret-free.
      return CALL_FAILED;
    }
  };

  return {
    toolNames: tools.map((tool) => tool.name),
    call,
    close: () => client.close(),
  };
}

/** Connects, lists tools, issues `script` in order and returns everything the agent saw. The client is closed afterwards. */
export async function runAgent(
  transport: Transport,
  script: readonly AgentStep[],
): Promise<AgentRun> {
  const agent = await connectAgent(transport);
  try {
    const results: CallToolResult[] = [];
    for (const step of script) results.push(await agent.call(step));
    return { toolNames: agent.toolNames, results };
  } finally {
    await agent.close();
  }
}
