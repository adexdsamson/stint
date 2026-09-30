/**
 * Like mcp-call.mjs, but spawns `stint run` with windowsHide:false via a custom
 * stdio transport, so its controlling-terminal prompt shares THIS visible
 * console (the SDK's StdioClientTransport forces windowsHide:true on Windows,
 * which hides the prompt). Proves the positive approve path.
 *
 * Env: STINT_STORE, STINT_LEASE (an ACTIVE lease).  Run: node manual/mcp-call-visible.mjs
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";

const store = process.env.STINT_STORE;
const lease = process.env.STINT_LEASE;
if (!store || !lease) {
  console.error("Set STINT_STORE and STINT_LEASE first.");
  process.exit(2);
}
const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/bin.js");

class ChildStdioTransport {
  constructor(child) {
    this.child = child;
    this._buf = new ReadBuffer();
  }
  async start() {
    this.child.stdout.on("data", (c) => {
      this._buf.append(c);
      for (;;) {
        let m;
        try {
          m = this._buf.readMessage();
        } catch (e) {
          this.onerror?.(e);
          return;
        }
        if (m === null) break;
        this.onmessage?.(m);
      }
    });
    this.child.stdout.on("error", (e) => this.onerror?.(e));
    this.child.on("close", () => this.onclose?.());
  }
  async send(message) {
    this.child.stdin.write(serializeMessage(message));
  }
  async close() {
    try {
      this.child.stdin.end();
    } catch {}
    this.child.kill();
  }
}

const child = spawn(
  process.execPath,
  [BIN, "--store", store, "run", lease, "--profile", path.join(store, "profile.json"), "--credentials", path.join(store, "credentials.json")],
  { stdio: ["pipe", "pipe", "inherit"], windowsHide: false },
);

const client = new Client({ name: "manual-uat-visible", version: "0.0.0" });
const transport = new ChildStdioTransport(child);
const protocolErrors = [];
transport.onerror = (e) => protocolErrors.push(String(e));
await client.connect(transport);

const { tools } = await client.listTools();
console.log("tools/list ->", tools.map((t) => t.name).sort().join(", "));
console.log("Calling gated `send_notice` — the approval prompt should appear HERE; answer y / n / nothing...\n");

const result = await client.callTool({ name: "send_notice", arguments: { to: "alice" } });
console.log("\ncallTool result:", JSON.stringify(result));
console.log("isError:", result.isError === true);
console.log("protocol stream errors (should be []):", JSON.stringify(protocolErrors));
console.log("secret leaked into result? (must be false):", JSON.stringify(result).includes("access-token-secret-do-not-leak"));

await client.close();
process.exit(0);
