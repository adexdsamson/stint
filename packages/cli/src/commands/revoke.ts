import type { CliDeps, GlobalOpts } from "../deps.js";
import { CliError, EXIT_CODES } from "../exit.js";

export interface RevokeOpts extends GlobalOpts {
  readonly yes?: boolean | undefined;
  readonly credentials?: string | undefined;
}

/**
 * INTERFACE STUB: the signature is frozen (program.ts wires it); plan 06-06
 * replaces ONLY this body.
 */
export const revokeCommand: (
  deps: CliDeps,
  leaseId: string,
  opts: RevokeOpts,
) => Promise<number> = () => Promise.reject(new CliError(EXIT_CODES.internal, "Not implemented."));
