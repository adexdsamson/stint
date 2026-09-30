/**
 * The controlling terminal for `stint run` (D-01, Pitfall 4). Under stdio MCP the
 * process's stdin/stdout ARE the JSON-RPC stream, so the human prompt must use a
 * separate handle to the user's console: `/dev/tty` on POSIX, `CONIN$`/`CONOUT$`
 * on Windows. When none can be opened (a detached agent host, CI, a pipe-only
 * spawn) this returns `undefined`; the caller then gives the adapter a non-TTY
 * input, so every interactive request REJECTS and core denies (deny-by-default).
 *
 * A1: opening the Windows console was not exercised in the sandbox; it is a
 * human-check in end-of-phase UAT.
 */

import fs from "node:fs";
import tty from "node:tty";

export interface ControllingTerminal {
  readonly input: tty.ReadStream;
  readonly output: tty.WriteStream;
  /** Releases both handles (safe to call more than once). */
  readonly close: () => void;
}

/** Test seams; production uses the real `fs`/`tty`. */
export interface TerminalOpenOps {
  readonly platform?: NodeJS.Platform;
  readonly openSync?: (path: string, flags: string) => number;
  readonly closeSync?: (fd: number) => void;
  readonly isatty?: (fd: number) => boolean;
}

const WINDOWS_CONSOLE = { in: "\\\\.\\CONIN$", out: "\\\\.\\CONOUT$" } as const;

export function openControllingTerminal(
  ops: TerminalOpenOps = {},
): ControllingTerminal | undefined {
  const platform = ops.platform ?? process.platform;
  const openSync = ops.openSync ?? ((p: string, f: string) => fs.openSync(p, f));
  const closeSync =
    ops.closeSync ??
    ((fd: number) => {
      fs.closeSync(fd);
    });
  const isatty = ops.isatty ?? ((fd: number) => tty.isatty(fd));

  // Windows needs r+ on both console handles (Node TTY docs); POSIX uses one read and one write fd.
  const target =
    platform === "win32"
      ? { inPath: WINDOWS_CONSOLE.in, inFlags: "r+", outPath: WINDOWS_CONSOLE.out, outFlags: "r+" }
      : { inPath: "/dev/tty", inFlags: "r", outPath: "/dev/tty", outFlags: "w" };

  let inFd: number | undefined;
  let outFd: number | undefined;
  try {
    inFd = openSync(target.inPath, target.inFlags);
    outFd = openSync(target.outPath, target.outFlags);
    if (!isatty(inFd) || !isatty(outFd)) throw new Error("not a terminal");
    const input = new tty.ReadStream(inFd);
    const output = new tty.WriteStream(outFd);
    return {
      input,
      output,
      close: () => {
        input.destroy();
        output.destroy();
      },
    };
  } catch {
    for (const fd of [inFd, outFd]) {
      if (fd === undefined) continue;
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
    }
    return undefined;
  }
}
