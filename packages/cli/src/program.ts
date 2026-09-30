/**
 * The commander@15 program factory and the top-level `main` (Pattern 2).
 *
 * This file is the single command-registration surface: all seven commands are
 * registered here with their positional args and flags (D-03). It is FROZEN
 * after plan 06-04 — later plans replace only their own `commands/*.ts`
 * bodies and never re-register anything here.
 *
 * No action calls `process.exit`, and library code never touches
 * `process.exitCode`: an action stores its result in an `ExitSink` and `main`
 * returns the integer, so in-process tests cannot poison the runner's exit
 * status. Only `bin.ts` turns the returned code into `process.exitCode`.
 */

import { Command, CommanderError } from "commander";

import { cleanupCommand } from "./commands/cleanup.js";
import type { CleanupOpts } from "./commands/cleanup.js";
import { createCommand } from "./commands/create.js";
import type { CreateOpts } from "./commands/create.js";
import { inspectCommand } from "./commands/inspect.js";
import type { InspectOpts } from "./commands/inspect.js";
import { receiptsCommand } from "./commands/receipts.js";
import type { ReceiptsOpts } from "./commands/receipts.js";
import { revokeCommand } from "./commands/revoke.js";
import type { RevokeOpts } from "./commands/revoke.js";
import { runCommand } from "./commands/run.js";
import type { RunOpts } from "./commands/run.js";
import { verifyCommand } from "./commands/verify.js";
import type { VerifyOpts } from "./commands/verify.js";
import type { CliDeps, GlobalOpts } from "./deps.js";
import { CliError, EXIT_CODES } from "./exit.js";

/** Kept in step with packages/cli/package.json `version`. */
const CLI_VERSION = "0.0.0";

/** Where an action leaves its exit code; `main` reads it back. */
export interface ExitSink {
  code: number;
}

/** Commander usage errors are exit 2; help and version are success (Pattern 2). */
export function mapCommander(error: CommanderError): number {
  if (error.code === "commander.helpDisplayed" || error.code === "commander.version") {
    return EXIT_CODES.ok;
  }
  return EXIT_CODES.usage;
}

export function buildProgram(deps: CliDeps, sink: ExitSink = { code: 0 }): Command {
  const program = new Command()
    .name("stint")
    .description("Install, run, and cleanly uninstall specialist AI agents under a lease.")
    .version(CLI_VERSION)
    .option("--store <dir>", "store root (default: $STINT_HOME or ~/.stint)")
    .option("--json", "machine-readable output")
    .exitOverride()
    .configureOutput({ writeOut: deps.io.out, writeErr: deps.io.err });

  program
    .command("create")
    .description("Verify a signed manifest, ask for consent, and activate a lease")
    .argument("<manifest-path>", "path to a signed manifest envelope (JSON)")
    .option("--trust <file>", "publisher trust file (default: <store>/trust.json)")
    .option(
      "--publisher <file>",
      "publisher binding file (issue/reissue/invalidate URLs + license public key) for hosted/hybrid leases",
    )
    .action(async (manifestPath: string, _opts: unknown, cmd: Command) => {
      sink.code = await createCommand(deps, manifestPath, cmd.optsWithGlobals<CreateOpts>());
    });

  program
    .command("inspect")
    .description("Show a lease's state, limits, and counters")
    .argument("<leaseId>", "lease id")
    .action(async (leaseId: string, _opts: unknown, cmd: Command) => {
      sink.code = await inspectCommand(deps, leaseId, cmd.optsWithGlobals<InspectOpts>());
    });

  program
    .command("run")
    .description("Serve the lease as an MCP proxy over stdio")
    .argument("<leaseId>", "lease id")
    .option("--profile <file>", "run profile (catalog, bindings, OAuth metadata)")
    .option("--credentials <file>", "credentials file to seed the in-memory vault")
    .action(async (leaseId: string, _opts: unknown, cmd: Command) => {
      sink.code = await runCommand(deps, leaseId, cmd.optsWithGlobals<RunOpts>());
    });

  program
    .command("revoke")
    .description("Revoke a lease and run teardown")
    .argument("<leaseId>", "lease id")
    .option("--yes", "skip the confirmation prompt")
    .option("--credentials <file>", "credentials file so OAuth grants can be revoked upstream")
    .action(async (leaseId: string, _opts: unknown, cmd: Command) => {
      sink.code = await revokeCommand(deps, leaseId, cmd.optsWithGlobals<RevokeOpts>());
    });

  program
    .command("cleanup")
    .description("Run or retry teardown for a lease that has ended")
    .argument("<leaseId>", "lease id")
    .option("--yes", "skip the confirmation prompt")
    .option("--credentials <file>", "credentials file so OAuth grants can be revoked upstream")
    .action(async (leaseId: string, _opts: unknown, cmd: Command) => {
      sink.code = await cleanupCommand(deps, leaseId, cmd.optsWithGlobals<CleanupOpts>());
    });

  program
    .command("receipts")
    .description("Show a lease's receipt timeline")
    .argument("<leaseId>", "lease id")
    .option("--verify", "also verify the receipt chains and checkpoint")
    .action(async (leaseId: string, _opts: unknown, cmd: Command) => {
      sink.code = await receiptsCommand(deps, leaseId, cmd.optsWithGlobals<ReceiptsOpts>());
    });

  program
    .command("verify")
    .description("Verify a lease's receipt chains and checkpoint")
    .argument("<leaseId>", "lease id")
    .action(async (leaseId: string, _opts: unknown, cmd: Command) => {
      sink.code = await verifyCommand(deps, leaseId, cmd.optsWithGlobals<VerifyOpts>());
    });

  return program;
}

/** Prints a failure using only fixed text: plain on stderr, or `{error,code}` on stdout under `--json`. */
function report(deps: CliDeps, json: boolean, code: number, message: string): void {
  if (json) {
    deps.io.out(`${JSON.stringify({ error: message, code })}\n`);
  } else {
    deps.io.err(`stint: ${message}\n`);
  }
}

/** Runs the CLI and returns the process exit code; never calls `process.exit`. */
export async function main(argv: readonly string[], deps: CliDeps): Promise<number> {
  const sink: ExitSink = { code: EXIT_CODES.ok };
  const program = buildProgram(deps, sink);
  try {
    await program.parseAsync([...argv], { from: "user" });
    return sink.code;
  } catch (error) {
    if (error instanceof CommanderError) return mapCommander(error);
    const json = program.opts<GlobalOpts>().json === true;
    if (error instanceof CliError) {
      report(deps, json, error.code, error.safeMessage);
      return error.code;
    }
    // Never surface unexpected error text: it may carry paths, tokens or upstream detail.
    report(deps, json, EXIT_CODES.internal, "Internal error.");
    return EXIT_CODES.internal;
  }
}
