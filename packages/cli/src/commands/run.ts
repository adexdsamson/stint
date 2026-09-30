/**
 * `stint run <leaseId>`: serve the lease as an MCP proxy over stdio (D-01).
 *
 * The process's stdin/stdout ARE the MCP protocol channel, so this command
 * never writes to `process.stdout`: every human line goes to stderr
 * (`deps.io.err`) and approvals prompt on a separately opened controlling
 * terminal. With no terminal the adapter rejects every interactive request and
 * core denies (deny-by-default). Failures are reported on stderr here (never
 * through `main`, which prints `--json` errors on stdout).
 */

import { Readable, Writable } from "node:stream";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { resolveAuthMode } from "@stint/spec";

import type { PromptOutput } from "../adapter/prompt.js";
import { createTerminalHostAdapter } from "../adapter/terminal-host-adapter.js";
import type { CliDeps, GlobalOpts } from "../deps.js";
import { CliError, EXIT_CODES } from "../exit.js";
import { assertSafeLeaseId, resolveStoreRoot } from "../paths.js";
import { colorDecision, createStyle } from "../render/style.js";
import { loadStoredManifest } from "../store/envelope.js";
import { loadRunProfile } from "../run/profile.js";
import { runLease } from "../run/run-lease.js";
import { openControllingTerminal } from "../run/terminal.js";

export interface RunOpts extends GlobalOpts {
  readonly profile?: string | undefined;
  readonly credentials?: string | undefined;
}

/** A writable that forwards to `deps.io.err`, so nothing here needs `process.stderr` directly. */
function stderrStream(deps: CliDeps): Writable {
  return new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      deps.io.err(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      callback();
    },
  });
}

/** stdio is the protocol channel; stop serving when the agent host closes its end. */
function createStdioTransport(): Transport {
  const transport = new StdioServerTransport();
  process.stdin.once("end", () => {
    void transport.close();
  });
  return transport;
}

async function serve(deps: CliDeps, leaseId: string, opts: RunOpts): Promise<number> {
  assertSafeLeaseId(leaseId);
  const root = resolveStoreRoot(opts);

  if (opts.profile === undefined || opts.profile === "") {
    throw new CliError(EXIT_CODES.usage, "--profile <file> is required.");
  }
  if ((await deps.storeFactory(root).load(leaseId)) === undefined) {
    throw new CliError(EXIT_CODES.leaseNotFound, "Lease not found.");
  }
  const profile = await loadRunProfile(opts.profile);
  const verified = await loadStoredManifest(deps, root, leaseId);

  // Secrets: only from the credentials file, only into the in-memory vault (D-02).
  // Hybrid carries `auth.delegated` grants too, so only a purely hosted lease has no OAuth grants.
  const hasOAuthGrants = resolveAuthMode(verified.manifest) !== "hosted";
  if (hasOAuthGrants && (opts.credentials === undefined || opts.credentials === "")) {
    throw new CliError(
      EXIT_CODES.usage,
      "--credentials <file> is required for a lease with delegated or hybrid auth.",
    );
  }
  const credentials =
    opts.credentials === undefined || opts.credentials === ""
      ? undefined
      : await deps.credentials.load(opts.credentials);

  const terminal = (deps.run?.openTerminal ?? openControllingTerminal)();
  const errOut = stderrStream(deps);
  const output: PromptOutput = terminal?.output ?? errOut;
  const adapter = createTerminalHostAdapter({
    // No terminal: a non-TTY input makes the adapter reject, so core denies.
    input: terminal?.input ?? new Readable({ read: () => undefined }),
    output,
    errorOutput: errOut,
    approvalTimeoutSeconds: verified.manifest.approvals.timeout_seconds,
    clock: deps.clock,
    style: createStyle(colorDecision({ json: false, env: process.env, output })),
  });
  if (terminal === undefined) {
    deps.io.err(
      "stint: no controlling terminal is available; every approval-gated call will be denied.\n",
    );
  }

  try {
    const transport = (deps.run?.createTransport ?? createStdioTransport)();
    const running = await runLease({
      leaseId,
      root,
      transport,
      adapter,
      deps,
      verified,
      profile,
      credentials,
    });
    deps.io.err(`stint: serving lease ${leaseId} over MCP stdio.\n`);
    await running.closed;
    return EXIT_CODES.ok;
  } finally {
    terminal?.close();
  }
}

export async function runCommand(deps: CliDeps, leaseId: string, opts: RunOpts): Promise<number> {
  try {
    return await serve(deps, leaseId, opts);
  } catch (error) {
    // Never through `main`: under `--json` it would print the error on stdout, the MCP channel.
    if (error instanceof CliError) {
      deps.io.err(`stint: ${error.safeMessage}\n`);
      return error.code;
    }
    deps.io.err("stint: Internal error.\n");
    return EXIT_CODES.internal;
  }
}
