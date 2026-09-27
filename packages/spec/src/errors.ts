/**
 * Stint-owned structured error vocabulary for @stint/spec.
 *
 * This is a public API surface (D-31): host UIs render `code` and `allowed`
 * directly. Renaming or removing a code is a breaking change for every
 * integrating platform. Raw Ajv `ErrorObject`s never cross this boundary.
 */

export const SPEC_ERROR_CODES = [
  "missing_required",
  "unknown_field",
  "invalid_type",
  "invalid_enum",
  "invalid_value",
  "invalid_format",
  "out_of_range",
  "duplicate_item",
  "unsupported_spec_version",
  "unknown_resource_reference",
  "invalid_json",
  "envelope_too_large",
  "not_canonicalizable",
  "unsupported_algorithm",
  "unknown_publisher",
  "unknown_key",
  "invalid_signature",
] as const;

export type SpecErrorCode = (typeof SPEC_ERROR_CODES)[number];

export interface SpecError {
  readonly path: string;
  readonly code: SpecErrorCode;
  readonly message: string;
  readonly allowed?: readonly string[];
}

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly SpecError[] };
