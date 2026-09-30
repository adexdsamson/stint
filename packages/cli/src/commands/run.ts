import type { CliDeps, GlobalOpts } from "../deps.js";
import { CliError, EXIT_CODES } from "../exit.js";

export interface RunOpts extends GlobalOpts {
  readonly profile?: string | undefined;
  readonly credentials?: string | undefined;
}

/**
 * INTERFACE STUB: the signature is frozen (program.ts wires it); plan 06-05
 * replaces ONLY this body.
 */
export const runCommand: (deps: CliDeps, leaseId: string, opts: RunOpts) => Promise<number> = () =>
  Promise.reject(new CliError(EXIT_CODES.internal, "Not implemented."));
