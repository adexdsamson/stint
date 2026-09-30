import { Ajv } from "ajv";
import type { ErrorObject, ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

import { manifestSchema, envelopeSchema } from "./generated/schemas.js";
import type { Manifest, Auth, AuthMode } from "./generated/manifest.js";
import type { SignedEnvelope } from "./generated/envelope.js";
import type { SpecError, Result } from "./errors.js";
import { parsePredicate } from "./predicate/parse.js";

/**
 * The generated `Manifest`/`SignedEnvelope` types (packages/spec/src/generated)
 * carry an index signature (`[k: string]: unknown`) on every object that uses
 * the `x-` passthrough pattern (D-12). This means TypeScript alone will NOT
 * flag a typo'd field name via excess-property checks the way a fully closed
 * interface would (RESEARCH Pitfall 4). The generated types are never a
 * substitute for calling `validateManifest`/`validateEnvelopeShape` — they
 * describe the *shape after* validation, not a runtime guarantee on their own.
 */

export const SUPPORTED_SPEC_VERSIONS = ["alp/0.1"] as const;

const VERIFIER_TYPES = ["resource_query", "user_confirm", "none"] as const;
type VerifierType = (typeof VERIFIER_TYPES)[number];

const VERIFIER_BRANCH_SCHEMA_KEY: Record<VerifierType, string> = {
  resource_query: "manifest#/definitions/ResourceQueryVerifier",
  user_confirm: "manifest#/definitions/UserConfirmVerifier",
  none: "manifest#/definitions/NoneVerifier",
};

const ajv = new Ajv({ allErrors: true, strict: true, allowUnionTypes: true });
// ajv-formats' CommonJS module sets `.default` to itself under NodeNext
// interop; call the `.default` property rather than the bare import.
addFormats.default(ajv);

ajv.addSchema(manifestSchema, "manifest");
ajv.addSchema(envelopeSchema, "envelope");

function requireCompiledSchema(key: string): ValidateFunction {
  const fn = ajv.getSchema(key);
  if (!fn) {
    throw new Error(`@stint/spec: failed to compile schema "${key}"`);
  }
  return fn;
}

const validateManifestSchema = requireCompiledSchema("manifest");
const validateEnvelopeSchemaFn = requireCompiledSchema("envelope");

/** Minimal shape mapAjvError actually reads — lets synthesized (non-Ajv) errors reuse the same mapper. */
interface MappableError {
  readonly keyword: string;
  readonly instancePath: string;
  readonly params: Record<string, unknown>;
}

function getAtPointer(value: unknown, pointer: string): unknown {
  const segments = pointer.split("/").filter((segment) => segment.length > 0);
  let current: unknown = value;
  for (const segment of segments) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function mapAjvError(err: MappableError): SpecError | null {
  const path = err.instancePath;
  switch (err.keyword) {
    case "required": {
      const missing = String(err.params.missingProperty);
      const fullPath = `${path}/${missing}`;
      return {
        path: fullPath,
        code: "missing_required",
        message: `Missing required property at "${fullPath}".`,
      };
    }
    case "additionalProperties": {
      const extra = String(err.params.additionalProperty);
      const fullPath = `${path}/${extra}`;
      return {
        path: fullPath,
        code: "unknown_field",
        message: `Unknown field at "${fullPath}".`,
      };
    }
    case "type":
      return { path, code: "invalid_type", message: `Value at "${path}" has an invalid type.` };
    case "enum": {
      const allowed = (err.params.allowedValues as unknown[]).map(String);
      return {
        path,
        code: "invalid_enum",
        message: `Value at "${path}" is not one of the allowed values.`,
        allowed,
      };
    }
    case "const": {
      if (path === "/spec_version") {
        return {
          path,
          code: "unsupported_spec_version",
          message: `Unsupported spec_version at "${path}".`,
          allowed: [...SUPPORTED_SPEC_VERSIONS],
        };
      }
      if (path === "/signature/alg") {
        return {
          path,
          code: "unsupported_algorithm",
          message: `Unsupported signature algorithm at "${path}".`,
          allowed: ["EdDSA"],
        };
      }
      return {
        path,
        code: "invalid_value",
        message: `Value at "${path}" must equal a fixed value.`,
        allowed: [String(err.params.allowedValue)],
      };
    }
    case "pattern":
    case "format":
      return { path, code: "invalid_format", message: `Value at "${path}" has an invalid format.` };
    case "minimum":
    case "maximum":
    case "exclusiveMinimum":
    case "exclusiveMaximum":
    case "minLength":
    case "maxLength":
    case "minItems":
    case "maxItems":
      return { path, code: "out_of_range", message: `Value at "${path}" is out of the allowed range.` };
    case "uniqueItems":
      return { path, code: "duplicate_item", message: `Duplicate item at "${path}".` };
    case "if":
      // The inner `then` schema's errors already carry the actionable information.
      return null;
    default:
      return { path, code: "invalid_value", message: `Value at "${path}" is invalid.` };
  }
}

/**
 * Ajv's raw `oneOf` output for `/job/verifier` is noisy by construction — it
 * reports failures from every branch (D-18, RESEARCH Pattern 3). Collapse it
 * to a single, meaningful error derived from the instance's own `type` field.
 */
function collapseVerifierErrors(rawErrors: ErrorObject[], input: unknown): MappableError[] {
  const hasVerifierOneOfFailure = rawErrors.some(
    (candidate) => candidate.instancePath === "/job/verifier" && candidate.keyword === "oneOf",
  );
  if (!hasVerifierOneOfFailure) {
    return rawErrors;
  }

  const otherErrors = rawErrors.filter(
    (candidate) =>
      candidate.instancePath !== "/job/verifier" && !candidate.instancePath.startsWith("/job/verifier/"),
  );

  const derived: MappableError[] = [];
  const verifierValue = getAtPointer(input, "/job/verifier");

  if (typeof verifierValue !== "object" || verifierValue === null || Array.isArray(verifierValue)) {
    derived.push({ keyword: "type", instancePath: "/job/verifier", params: {} });
  } else {
    const typeValue = (verifierValue as Record<string, unknown>).type;
    if (typeValue === undefined) {
      derived.push({ keyword: "required", instancePath: "/job/verifier", params: { missingProperty: "type" } });
    } else if (!(VERIFIER_TYPES as readonly unknown[]).includes(typeValue)) {
      derived.push({
        keyword: "enum",
        instancePath: "/job/verifier/type",
        params: { allowedValues: [...VERIFIER_TYPES] },
      });
    } else {
      const branchKey = VERIFIER_BRANCH_SCHEMA_KEY[typeValue as VerifierType];
      const branchValidate = ajv.getSchema(branchKey);
      if (branchValidate) {
        // Schemas are never $async here; the call is always synchronous boolean.
        void branchValidate(verifierValue);
        for (const branchError of branchValidate.errors ?? []) {
          derived.push({
            keyword: branchError.keyword,
            instancePath: `/job/verifier${branchError.instancePath}`,
            params: branchError.params as Record<string, unknown>,
          });
        }
      }
    }
  }

  return [...otherErrors, ...derived];
}

function dedupeAndSort(errors: SpecError[]): SpecError[] {
  const seen = new Map<string, SpecError>();
  for (const error of errors) {
    const key = `${error.path}\u0000${error.code}`;
    if (!seen.has(key)) {
      seen.set(key, error);
    }
  }
  return [...seen.values()].sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    if (a.code !== b.code) return a.code < b.code ? -1 : 1;
    return 0;
  });
}

/** Every scope resource seen so far, in declaration order, used by the semantic checks below. */
function collectSemanticErrors(manifest: Manifest): SpecError[] {
  const errors: SpecError[] = [];
  const seenScopeResources = new Set<string>();

  manifest.scopes.forEach((scope, index) => {
    if (seenScopeResources.has(scope.resource)) {
      const path = `/scopes/${String(index)}/resource`;
      errors.push({
        path,
        code: "duplicate_item",
        message: `Duplicate scope resource at "${path}".`,
      });
    } else {
      seenScopeResources.add(scope.resource);
    }
  });

  const auth: Auth = manifest.auth;
  const delegated = auth.delegated ?? [];
  delegated.forEach((grant, grantIndex) => {
    grant.resources.forEach((resource, resourceIndex) => {
      if (!seenScopeResources.has(resource)) {
        const path = `/auth/delegated/${String(grantIndex)}/resources/${String(resourceIndex)}`;
        errors.push({
          path,
          code: "unknown_resource_reference",
          message: `Delegated resource at "${path}" is not declared in scopes.`,
        });
      }
    });
  });

  // D-04: a resource_query verifier's predicate is unconstrained-string per
  // the JSON Schema (spec/manifest.schema.json: minLength 1, maxLength
  // 1000), so grammar checking is necessarily a semantic (post-schema) rule,
  // exactly like the unknown_resource_reference check above. A manifest
  // whose predicate is unparseable or out-of-grammar is rejected before
  // consent, the same gate as an unknown scope. The message never echoes
  // raw predicate internals beyond this fixed, non-interpolated summary
  // (T-05-02-I).
  if (manifest.job.verifier.type === "resource_query") {
    const parsed = parsePredicate(manifest.job.verifier.predicate);
    if (!parsed.ok) {
      const path = "/job/verifier/predicate";
      errors.push({
        path,
        code: "invalid_predicate",
        message: `Predicate at "${path}" is not valid resource_query grammar.`,
      });
    }
  }

  return errors;
}

/**
 * Validates `input` against the canonical manifest schema and returns a
 * Stint-owned structured `Result`. Never mutates `input` — on success, the
 * returned `value` is the exact same object reference (no `useDefaults`,
 * no coercion), so validation can never change a manifest's content hash.
 */
export function validateManifest(input: unknown): Result<Manifest> {
  const schemaValid = validateManifestSchema(input);

  if (!schemaValid) {
    const rawErrors = validateManifestSchema.errors ?? [];
    const collapsed = collapseVerifierErrors(rawErrors, input);
    const mapped = collapsed
      .map((error) => mapAjvError(error))
      .filter((error): error is SpecError => error !== null);
    return { ok: false, errors: dedupeAndSort(mapped) };
  }

  const manifest = input as Manifest;
  const semanticErrors = collectSemanticErrors(manifest);
  if (semanticErrors.length > 0) {
    return { ok: false, errors: dedupeAndSort(semanticErrors) };
  }

  return { ok: true, value: manifest };
}

/**
 * Validates `input` against the envelope shell schema only — this checks the
 * `{ manifest, signature }` shape, not the manifest's own validity or the
 * signature's cryptographic correctness (signature verification is a
 * separate, later concern; see D-03/D-04).
 */
export function validateEnvelopeShape(input: unknown): Result<SignedEnvelope> {
  const schemaValid = validateEnvelopeSchemaFn(input);

  if (!schemaValid) {
    const rawErrors = validateEnvelopeSchemaFn.errors ?? [];
    const mapped = rawErrors.map((error) => mapAjvError(error)).filter((error): error is SpecError => error !== null);
    return { ok: false, errors: dedupeAndSort(mapped) };
  }

  return { ok: true, value: input as SignedEnvelope };
}

/** `manifest.auth.mode ?? "hybrid"` (D-17: an omitted mode is held to the same requirements as hybrid). */
export function resolveAuthMode(manifest: Manifest): AuthMode {
  return manifest.auth.mode ?? "hybrid";
}
