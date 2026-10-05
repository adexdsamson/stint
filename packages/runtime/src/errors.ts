/**
 * The runtime's error vocabulary. Hosts map `code` to their own surface (an
 * exit code, an HTTP status); `safeMessage` is fixed text that is always safe
 * to show a person and never interpolates upstream or user-supplied text.
 */

export type RuntimeErrorCode =
  | "lease_not_found"
  | "wrong_state"
  | "manifest_invalid"
  | "store_corrupt"
  | "usage"
  | "internal";

export class RuntimeError extends Error {
  readonly code: RuntimeErrorCode;
  readonly safeMessage: string;

  constructor(code: RuntimeErrorCode, safeMessage: string) {
    super(safeMessage);
    this.name = "RuntimeError";
    this.code = code;
    this.safeMessage = safeMessage;
  }
}
