/**
 * D-09 regression guard: the host launcher must spawn `stint run` with
 * `windowsHide: false` (a visible console, so the approval prompt can be seen
 * and answered), `shell: false`, and piped stdin/stdout (the MCP channel).
 * A spy `spawn` records the options and returns a fake child, so this runs on
 * every platform and performs no real spawn. The hidden-console fail-safe
 * direction (a hidden spawn denies by timeout) is proven by the built-bin smoke.
 */

import { EventEmitter } from "node:events";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { createVisibleConsoleTransport, resolveCliBin } from "../src/launcher.js";
import type { SpawnImpl } from "../src/launcher.js";

interface Recorded {
  command: string;
  args: readonly string[];
  options: SpawnOptions;
}

function spySpawn(): {
  spawnImpl: SpawnImpl;
  calls: Recorded[];
  child: EventEmitter & { stdin: PassThrough; stdout: PassThrough; kill: () => boolean };
} {
  const calls: Recorded[] = [];
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    kill: () => true,
  });
  return {
    calls,
    child,
    spawnImpl: (command, args, options) => {
      calls.push({ command, args, options });
      return child as unknown as ChildProcess;
    },
  };
}

describe("visible-console launcher (D-08/D-09)", () => {
  it("spawns with windowsHide:false, shell:false and piped stdin/stdout", async () => {
    const spy = spySpawn();
    const bin = resolveCliBin();
    const transport = createVisibleConsoleTransport(bin, {
      args: ["--store", "s", "run", "lease"],
      spawnImpl: spy.spawnImpl,
    });
    await transport.start();

    expect(spy.calls).toHaveLength(1);
    const [call] = spy.calls;
    expect(call?.command).toBe(process.execPath);
    expect(call?.args[0]).toBe(bin);
    expect(call?.args.slice(1)).toEqual(["--store", "s", "run", "lease"]);
    expect(call?.options.windowsHide).toBe(false);
    expect(call?.options.shell).not.toBe(true);
    const stdio = call?.options.stdio as unknown[];
    expect(stdio[0]).toBe("pipe");
    expect(stdio[1]).toBe("pipe");
    await transport.close();
  });

  it("resolves the built @stint/cli bin next to its package entry", () => {
    expect(resolveCliBin()).toMatch(/[\\/]cli[\\/]dist[\\/]bin\.js$/);
  });

  it("frames child stdout as MCP messages and reports close", async () => {
    const spy = spySpawn();
    const transport = createVisibleConsoleTransport(resolveCliBin(), {
      args: [],
      spawnImpl: spy.spawnImpl,
    });
    const received: unknown[] = [];
    let closed = false;
    transport.onmessage = (message) => received.push(message);
    transport.onclose = () => {
      closed = true;
    };
    await transport.start();

    spy.child.stdout.write('{"jsonrpc":"2.0","id":1,"result":{}}\n');
    await new Promise((resolve) => setImmediate(resolve));
    expect(received).toEqual([{ jsonrpc: "2.0", id: 1, result: {} }]);

    spy.child.emit("close");
    expect(closed).toBe(true);
  });
});
