/**
 * The production `CliDeps`: JSON stores, the terminal adapter over the process
 * streams, the real clock. Used only by `bin.ts`; tests build their own deps.
 */

import { askLine } from "./adapter/prompt.js";
import { createTerminalHostAdapter } from "./adapter/terminal-host-adapter.js";
import type { CliDeps } from "./deps.js";
import { loadCheckpointPublicKey, loadOrCreateRuntimeKey } from "./keys/runtime-key.js";
import { colorDecision, createStyle } from "./render/style.js";
import { loadCredentials, seedVaultFromCredentials } from "./run/credentials.js";
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
  };
}
