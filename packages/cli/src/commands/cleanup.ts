import type { CliDeps, GlobalOpts } from "../deps.js";
import { CliError, EXIT_CODES } from "../exit.js";

export interface CleanupOpts extends GlobalOpts {
  readonly yes?: boolean | undefined;
  readonly credentials?: string | undefined;
}

/**
 * INTERFACE STUB: the signature is frozen (program.ts wires it); plan 06-06
 * replaces ONLY this body.
 */
export const cleanupCommand: (
  deps: CliDeps,
  leaseId: string,
  opts: CleanupOpts,
) => Promise<number> = () => Promise.reject(new CliError(EXIT_CODES.internal, "Not implemented."));
