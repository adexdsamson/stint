/**
 * D-03 smoke: the SHIPPED `@stint/cli` bin (`dist/bin.js`), spawned as a real
 * child over MCP stdio, boots, lists the granted tools, and FAILS SAFE: an
 * approval-gated call (`mark_order_reconciled`, irreversible) is denied by
 * timeout because this spawned process has no console anyone answers. stdout is
 * the MCP channel, so any stray human byte would surface as a transport error;
 * and no access token or `v4.public.` license ever reaches the client.
 *
 * Uses the SDK `StdioClientTransport` (the deterministic CI path, research A8);
 * the `windowsHide:false` launcher is pinned separately by launcher.test.ts and
 * checked on a real console by `packages/cli/manual/`.
 *
 * Needs the build (`pnpm build`): the bin must exist.
 */

import { existsSync } from "node:fs";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";

import { resolveCliBin } from "../src/launcher.js";
import { prepareSpawnedLease } from "../src/spawned-lease.js";
import type { SpawnedLease } from "../src/spawned-lease.js";

let lease: SpawnedLease | undefined;
let client: Client | undefined;
afterEach(async () => {
  await client?.close().catch(() => undefined);
  await lease?.dispose();
  client = undefined;
  lease = undefined;
});

describe("built dist/bin.js over real stdio (D-03)", () => {
  it(
    "boots, lists tools, denies the gated call by timeout and keeps stdout protocol-clean",
    { timeout: 60_000 },
    async () => {
      const bin = resolveCliBin();
      if (!existsSync(bin)) {
        throw new Error("packages/cli/dist/bin.js is missing: run `pnpm build` before this test.");
      }
      // A 1s approval window: with no console answering, the child self-denies quickly.
      lease = await prepareSpawnedLease({ approvalTimeoutSeconds: 1 });

      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [
          bin,
          "--store",
          lease.root,
          "run",
          lease.leaseId,
          "--profile",
          lease.profilePath,
          "--credentials",
          lease.credentialsPath,
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
      expect(tools.map((t) => t.name).sort()).toEqual([
        "list_transactions",
        "mark_order_reconciled",
        "read_orders",
      ]);

      const result = (await client.callTool({
        name: "mark_order_reconciled",
        arguments: { order_id: "ord_1001", status: "reconciled" },
      })) as CallToolResult;
      expect(result.isError).toBe(true);
      const [first] = result.content;
      expect(first?.type === "text" ? first.text : "").toMatch(/^denied: /);

      // Nothing corrupted the stream, and nothing secret reached the agent or the child's stderr.
      expect(protocolErrors).toEqual([]);
      const seen = JSON.stringify({ tools, result }) + stderr;
      expect(seen).not.toContain("v4.public.");
      for (const secret of lease.secrets()) expect(seen).not.toContain(secret);
    },
  );
});
