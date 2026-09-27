/**
 * Stint-owned structured error vocabulary for @stint/core.
 *
 * This is a public API surface consumed by receipts (Phase 3) and host UIs
 * (via the HostAdapter and CLI). Renaming or removing a code is a breaking
 * change for every integrating platform. This vocabulary is parallel to, and
 * deliberately independent of, `@stint/spec`'s `SpecErrorCode` — the core
 * reducer and policy engine never import spec's error codes.
 */

export const CORE_ERROR_CODES = [
  "illegal_transition",
  "wrong_actor",
  "extension_exceeds_max",
] as const;

export type CoreErrorCode = (typeof CORE_ERROR_CODES)[number];

export interface CoreError {
  readonly path: string;
  readonly code: CoreErrorCode;
  readonly message: string;
  readonly context?: Readonly<Record<string, string>>;
}

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly CoreError[] };
