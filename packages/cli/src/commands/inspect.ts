import type { CliDeps, GlobalOpts } from "../deps.js";
import { CliError, EXIT_CODES } from "../exit.js";

export type InspectOpts = GlobalOpts;

/** INTERFACE STUB (replaced by Task 3 of this plan). */
export const inspectCommand: (
  deps: CliDeps,
  leaseId: string,
  opts: InspectOpts,
) => Promise<number> = () => Promise.reject(new CliError(EXIT_CODES.internal, "Not implemented."));
