import type { CliDeps, GlobalOpts } from "../deps.js";
import { CliError, EXIT_CODES } from "../exit.js";

export interface CreateOpts extends GlobalOpts {
  readonly trust?: string | undefined;
}

/** INTERFACE STUB (replaced by Task 3 of this plan). */
export const createCommand: (
  deps: CliDeps,
  manifestPath: string,
  opts: CreateOpts,
) => Promise<number> = () => Promise.reject(new CliError(EXIT_CODES.internal, "Not implemented."));
