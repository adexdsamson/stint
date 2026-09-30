/**
 * The host launcher (D-08): spawns `stint run` so its controlling-terminal
 * approval prompt shares the USER'S visible console, and speaks MCP to it over
 * the child's stdio.
 *
 * Why not the SDK's `StdioClientTransport`: on Windows it hard-codes
 * `windowsHide: true`, which gives the child a hidden console. The per-call
 * approval prompt then renders somewhere nobody can see, the approval times out,
 * and EVERY approval-gated call silently denies (the Phase-6 UAT finding). So
 * this is a small custom `Transport` over `child_process.spawn` with
 * `windowsHide: false` and `shell: false` HARD-CODED (never conditional). The
 * `spawn` function is injectable so a test can assert those options on every
 * platform (D-09); `packages/cli/manual/mcp-call-visible.mjs` remains the human
 * check on a real console.
 *
 * Framing uses the SDK's own `ReadBuffer` / `serializeMessage`, byte-for-byte
 * what the server transport (`StdioServerTransport`) speaks. The child's stdout
 * is the MCP channel and is never echoed anywhere; stderr defaults to inherit so
 * the human lines (and the approval prompt) stay visible.
 */

import { spawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { fileURLToPath } from "node:url";

import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

/** The slice of `child_process.spawn` the launcher needs; a test injects a spy. */
export type SpawnImpl = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

/** Options for {@link createVisibleConsoleTransport}. */
export interface VisibleConsoleTransportOptions {
  /** Arguments after the bin path, e.g. `["--store", dir, "run", leaseId, "--profile", p]`. */
  readonly args: readonly string[];
  /** What to do with the child's stderr. Default `"inherit"` (human lines + prompt stay visible). */
  readonly stderr?: "inherit" | "pipe" | "ignore";
  /** Injectable spawn (default `node:child_process.spawn`). */
  readonly spawnImpl?: SpawnImpl;
}

/**
 * Locates the built `@stint/cli` bin next to its package entry. Resolved via
 * `import.meta.resolve` (the package does not export its package.json) rather
 * than `node_modules/.bin/stint`, which differs per platform and package manager.
 */
export function resolveCliBin(): string {
  return fileURLToPath(new URL("./bin.js", import.meta.resolve("@stint/cli")));
}

/**
 * A client-side MCP `Transport` over a spawned `node <bin> ...args`. The child
 * is spawned on `start()` with `windowsHide: false`, `shell: false` and piped
 * stdin/stdout.
 */
export function createVisibleConsoleTransport(
  bin: string,
  options: VisibleConsoleTransportOptions,
): Transport {
  const spawnImpl: SpawnImpl = options.spawnImpl ?? spawn;
  const buffer = new ReadBuffer();
  let child: ChildProcess | undefined;

  const transport: Transport = {
    start(): Promise<void> {
      if (child !== undefined) return Promise.reject(new Error("Transport already started."));
      const spawned = spawnImpl(process.execPath, [bin, ...options.args], {
        stdio: ["pipe", "pipe", options.stderr ?? "inherit"],
        // Hard-coded, never conditional: a hidden console silently denies every approval (D-08).
        windowsHide: false,
        shell: false,
      });
      child = spawned;

      spawned.stdout?.on("data", (chunk: Buffer) => {
        buffer.append(chunk);
        for (;;) {
          let message: JSONRPCMessage | null;
          try {
            message = buffer.readMessage();
          } catch (error) {
            transport.onerror?.(error instanceof Error ? error : new Error("Malformed message."));
            return;
          }
          if (message === null) break;
          transport.onmessage?.(message);
        }
      });
      spawned.stdout?.on("error", (error: Error) => transport.onerror?.(error));
      // EPIPE after the child exited must not crash the host.
      spawned.stdin?.on("error", (error: Error) => transport.onerror?.(error));
      spawned.on("error", (error: Error) => transport.onerror?.(error));
      spawned.on("close", () => transport.onclose?.());
      return Promise.resolve();
    },

    send(message: JSONRPCMessage): Promise<void> {
      const stdin = child?.stdin;
      if (stdin === undefined || stdin === null) {
        return Promise.reject(new Error("Transport is not connected."));
      }
      return new Promise<void>((resolve) => {
        if (stdin.write(serializeMessage(message))) resolve();
        else stdin.once("drain", resolve);
      });
    },

    close(): Promise<void> {
      try {
        child?.stdin?.end();
      } catch {
        // Already closed.
      }
      child?.kill();
      return Promise.resolve();
    },
  };
  return transport;
}
