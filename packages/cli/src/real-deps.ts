/**
 * The production `CliDeps`: JSON stores, the terminal adapter over the process
 * streams, the real clock. Used only by `bin.ts`; tests build their own deps.
 */

import { askLine } from "./adapter/prompt.js";
import { createTerminalHostAdapter } from "./adapter/terminal-host-adapter.js";
import type { CliDeps, SuperviseSeams } from "./deps.js";
import { loadCheckpointPublicKey, loadOrCreateRuntimeKey } from "./keys/runtime-key.js";
import { colorDecision, createStyle } from "./render/style.js";
import { loadCredentials, seedVaultFromCredentials } from "./run/credentials.js";
import { abortableSleep } from "./supervise-timing.js";
import { createJsonLeaseStore } from "./store/json-lease-store.js";
import { createJsonReceiptStore } from "./store/json-receipt-store.js";
import { loadTrustStore } from "./trust/trust-store.js";

const DEFAULT_APPROVAL_TIMEOUT_SECONDS = 60;

/** `[y/N]` on the real terminal; the question goes to stderr so `--json` stdout stays clean. */
async function confirmOnTerminal(question: string): Promise<boolean | undefined> {
  if (!process.stdin.isTTY) return undefined;
  const answer = await askLine(
    process.stdin,
    process.stderr,
    question,
    new AbortController().signal,
  );
  if (answer === undefined) return undefined;
  return ["y", "yes"].includes(answer.trim().toLowerCase());
}

/** The slice of `process` the shutdown seam uses; a test passes a fake so no real signal is ever raised. */
export interface ShutdownProcess {
  readonly platform: string;
  readonly pid: number;
  on(signal: NodeJS.Signals, listener: () => void): unknown;
  off(signal: NodeJS.Signals, listener: () => void): unknown;
  kill(pid: number, signal: NodeJS.Signals): unknown;
  exit(code: number): never;
}

/**
 * The `supervise.shutdown` seam (Phase 9 D-21). Calling it starts listening for
 * `SIGINT`, `SIGHUP` and, on Windows, `SIGBREAK`; nothing is installed before
 * that, so every other command keeps the default Ctrl-C behaviour. The first
 * signal aborts the returned signal (the loop finishes the step in flight and
 * stops). A second signal removes the listeners and re-raises the same signal so
 * the platform default terminates the process at once. `dispose` removes the
 * listeners. Windows delivers no SIGTERM, and Task Scheduler "End" or `taskkill`
 * are hard stops; correctness there rests on the fence TTL and the lock going
 * stale, not on this path.
 */
export function createSuperviseShutdown(proc: ShutdownProcess = process): ReturnType<NonNullable<SuperviseSeams["shutdown"]>> {
  const controller = new AbortController();
  const names: NodeJS.Signals[] = ["SIGINT", "SIGHUP", ...(proc.platform === "win32" ? (["SIGBREAK"] as const) : [])];
  const listeners = new Map<NodeJS.Signals, () => void>();

  const dispose = (): void => {
    for (const [name, listener] of listeners) proc.off(name, listener);
    listeners.clear();
  };
  const onSignal = (name: NodeJS.Signals): void => {
    if (!controller.signal.aborted) {
      controller.abort();
      return;
    }
    // A second signal: stop being graceful and let the default handler end the process.
    dispose();
    try {
      proc.kill(proc.pid, name);
    } catch {
      proc.exit(130);
    }
  };
  for (const name of names) {
    const listener = (): void => {
      onSignal(name);
    };
    listeners.set(name, listener);
    proc.on(name, listener);
  }
  return { signal: controller.signal, dispose };
}

export function createRealDeps(): CliDeps {
  const clock = (): number => Math.floor(Date.now() / 1000);
  return {
    io: {
      out: (text) => {
        process.stdout.write(text);
      },
      err: (text) => {
        process.stderr.write(text);
      },
    },
    clock,
    style: (json) => createStyle(colorDecision({ json, env: process.env, output: process.stdout })),
    storeFactory: (root) => createJsonLeaseStore({ root }),
    receiptStoreFactory: (root, leaseId) => createJsonReceiptStore({ root, leaseId }),
    adapterFactory: (_io, ctx) => {
      // Under --json stdout carries the machine-readable result, so the human prompt goes to stderr.
      const output = ctx.json ? process.stderr : process.stdout;
      return createTerminalHostAdapter({
        input: process.stdin,
        output,
        approvalTimeoutSeconds: ctx.approvalTimeoutSeconds ?? DEFAULT_APPROVAL_TIMEOUT_SECONDS,
        clock,
        style: createStyle(colorDecision({ json: ctx.json, env: process.env, output })),
      });
    },
    keys: { loadOrCreate: loadOrCreateRuntimeKey, loadPublic: loadCheckpointPublicKey },
    loadTrustStore,
    credentials: { load: loadCredentials, seedVault: seedVaultFromCredentials },
    confirm: confirmOnTerminal,
    supervise: {
      shutdown: () => createSuperviseShutdown(),
      sleep: abortableSleep,
      monotonicMs: () => performance.now(),
    },
  };
}
