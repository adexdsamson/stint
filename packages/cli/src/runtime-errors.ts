/**
 * `toCliError` maps the runtime's error vocabulary onto the CLI's exit codes.
 * A `RuntimeError` carries a fixed, always-safe message, so it is passed on
 * verbatim; anything else is returned unchanged so the caller can rethrow it
 * and let `main` report it as an internal error (no unexpected error text is
 * ever surfaced).
 */

import { RuntimeError } from "@stint/runtime";
import type { RuntimeErrorCode } from "@stint/runtime";

import { CliError, EXIT_CODES } from "./exit.js";

const EXIT_FOR_CODE: Readonly<Record<RuntimeErrorCode, number>> = {
  lease_not_found: EXIT_CODES.leaseNotFound,
  wrong_state: EXIT_CODES.wrongState,
  manifest_invalid: EXIT_CODES.manifestInvalid,
  store_corrupt: EXIT_CODES.storeCorrupt,
  usage: EXIT_CODES.usage,
  internal: EXIT_CODES.internal,
};

export function toCliError(error: unknown): unknown {
  if (error instanceof RuntimeError) {
    return new CliError(EXIT_FOR_CODE[error.code], error.safeMessage);
  }
  return error;
}
