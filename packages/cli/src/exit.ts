/**
 * Process exit codes and the CLI's typed error (D-14). Messages are FIXED and
 * never interpolate upstream error text, lease contents, or secrets (ALP §14).
 */

export const EXIT_CODES = {
  ok: 0,
  internal: 1,
  usage: 2,
  consentDeclined: 3,
  leaseNotFound: 4,
  manifestInvalid: 5,
  chainBroken: 6,
  cleanupIncomplete: 7,
  leaseBusy: 8,
  wrongState: 9,
  storeCorrupt: 10,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

/** A typed CLI failure: `code` is the process exit code, `safeMessage` is safe to print verbatim. */
export class CliError extends Error {
  readonly code: number;
  readonly safeMessage: string;

  constructor(code: number, safeMessage: string) {
    super(safeMessage);
    this.name = "CliError";
    this.code = code;
    this.safeMessage = safeMessage;
  }
}
