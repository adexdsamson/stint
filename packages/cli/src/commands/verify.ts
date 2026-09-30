import type { CliDeps, GlobalOpts } from "../deps.js";
import { CliError, EXIT_CODES } from "../exit.js";

export type VerifyOpts = GlobalOpts;

/**
 * INTERFACE STUB: the signature is frozen (program.ts wires it); plan 06-07
 * replaces ONLY this body.
 */
export const verifyCommand: (
  deps: CliDeps,
  leaseId: string,
  opts: VerifyOpts,
) => Promise<number> = () => Promise.reject(new CliError(EXIT_CODES.internal, "Not implemented."));
