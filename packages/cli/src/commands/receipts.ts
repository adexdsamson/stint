import type { CliDeps, GlobalOpts } from "../deps.js";
import { CliError, EXIT_CODES } from "../exit.js";

export interface ReceiptsOpts extends GlobalOpts {
  readonly verify?: boolean | undefined;
}

/**
 * INTERFACE STUB: the signature is frozen (program.ts wires it); plan 06-07
 * replaces ONLY this body.
 */
export const receiptsCommand: (
  deps: CliDeps,
  leaseId: string,
  opts: ReceiptsOpts,
) => Promise<number> = () => Promise.reject(new CliError(EXIT_CODES.internal, "Not implemented."));
