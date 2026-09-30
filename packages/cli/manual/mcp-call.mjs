/**
 * Manual-UAT MCP client for Phase 6 Test 1 (run approval prompt).
 *
 * Spawns the BUILT `stint run <lease>` over stdio exactly as an agent host
 * would, completes the MCP handshake, then calls the approval-gated
 * `send_notice` tool ONCE. The approval prompt fires on your real console
 * (CONIN$/CONOUT$ on Windows, /dev/tty on POSIX) — answer y / n / nothing.
 *
 * Env:  STINT_STORE  = store dir printed by setup.mjs
 *       STINT_LEASE  = an ACTIVE lease id (from a `create` you answered `y`)
 * Run from packages/cli:  node manual/mcp-call.mjs
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const store = process.env.STINT_STORE;
const lease = process.env.STINT_LEASE;
if (!store || !lease) {
  console.error("Set STINT_STORE and STINT_LEASE first (see setup.mjs output).");
  process.exit(2);
}

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/bin.js");
if (!existsSync(BIN)) {
  console.error("packages/cli/dist/bin.js missing — run `npx --yes pnpm@12.6.0 --filter @stint/cli build` first.");
  process.exit(2);
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [BIN, "--store", store, "run", lease, "--profile", path.join(store, "profile.json"), "--credentials", path.join(store, "credentials.json")],
  stderr: "pipe",
});
const protocolErrors = [];
transport.onerror = (e) => protocolErrors.push(String(e));
transport.stderr?.on("data", (c) => process.stderr.write(c));

const client = new Client({ name: "manual-uat-agent", version: "0.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log("tools/list ->", tools.map((t) => t.name).sort().join(", "));
console.log("Calling gated tool `send_notice` — answer the prompt on this console...\n");

const result = await client.callTool({ name: "send_notice", arguments: { to: "alice" } });
console.log("\ncallTool result:", JSON.stringify(result));
console.log("isError:", result.isError === true);
console.log("protocol stream errors (should be []):", JSON.stringify(protocolErrors));
console.log("secret leaked into result? (must be false):", JSON.stringify(result).includes("access-token-secret-do-not-leak"));

await client.close();
