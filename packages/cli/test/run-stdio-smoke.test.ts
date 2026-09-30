/**
 * Stdio smoke: spawns the BUILT `dist/bin.js run <id>` exactly as an agent host
 * would and talks MCP to it over `StdioClientTransport` (Pitfall 4). Proves the
 * handshake and `tools/list` succeed, so stdout is protocol-clean (any stray
 * human byte would surface as a parse error on the client transport), and that
 * an approval-gated call is DENIED with the spawned process holding no
 * interactive terminal that answers (deny-by-default).
 *
 * Needs the build (`pnpm build`, which root `pnpm test` runs first).
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";

import { ACCESS_TOKEN, createRunFixture } from "./helpers/run-fixture.js";
import type { RunFixture } from "./helpers/run-fixture.js";

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/bin.js");

let fx: RunFixture | undefined;
let client: Client | undefined;
afterEach(async () => {
  await client?.close();
  await fx?.harness.cleanup();
  client = undefined;
  fx = undefined;
});

describe("stint run over real stdio (built dist/bin.js)", () => {
  it(
    "completes the MCP handshake with a clean stdout and denies an approval-gated call",
    { timeout: 60_000 },
    async () => {
      if (!existsSync(BIN)) {
        throw new Error("packages/cli/dist/bin.js is missing: run `pnpm build` before this test.");
      }
      // A 1s approval window: if the child happens to reach a console, it still self-denies quickly.
      fx = await createRunFixture({ approvalTimeoutSeconds: 1 });

      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [
          BIN,
          "--store",
          fx.harness.root,
          "run",
          fx.leaseId,
          "--profile",
          fx.profilePath,
          "--credentials",
          fx.credentialsPath,
        ],
        stderr: "pipe",
      });
      let stderr = "";
      const protocolErrors: unknown[] = [];
      transport.onerror = (e) => protocolErrors.push(e);
      transport.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      client = new Client({ name: "smoke-agent", version: "0.0.0" });
      await client.connect(transport);

      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(["read_orders", "send_notice"]);

      const result = (await client.callTool({
        name: "send_notice",
        arguments: { to: "alice" },
      })) as CallToolResult;
      expect(result.isError).toBe(true);
      const [first] = result.content;
      expect(first?.type === "text" ? first.text : "").toMatch(/^denied: /);

      // Nothing corrupted the stream, and no secret leaked to the agent or the child's stderr.
      expect(protocolErrors).toEqual([]);
      expect(JSON.stringify(result)).not.toContain(ACCESS_TOKEN);
      expect(stderr).not.toContain(ACCESS_TOKEN);
      expect(fx.fetchCalls).toHaveLength(0);
    },
  );
});
