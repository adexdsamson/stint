/**
 * Typed entry and binding for publisher-declared job parameters (10-05,
 * SPEC-08). The user, not the agent, supplies the job's fixed inputs:
 * `orderParameterDeclarations` is the single ordering source (manifest
 * order) for entry, the consent screen and the lease record;
 * `parseJobParameterValue` is the typed gate every entered answer passes;
 * `interpretJobParameterAnswer` maps one seam answer to entered/omitted/
 * invalid/declined; `bindJobParameters` re-validates the accumulated values
 * against the declarations at activation (an unreachable-by-UI defense) and
 * builds the create-bound record in declaration order.
 */

import type { Manifest } from "@stint/spec";

/** One manifest job-parameter declaration as the entry loop consumes it. */
export interface JobParameterDeclaration {
  readonly name: string;
  readonly type: string;
  readonly description?: string;
  readonly required: boolean;
}

/**
 * One ask handed to the `askJobParameter` seam: the declaration the user
 * answers, plus (on the single re-ask after an invalid answer) the fixed
 * invalid-value line to show before the question.
 */
export interface JobParameterAsk extends JobParameterDeclaration {
  readonly invalidRetryMessage?: string;
}

/** A parse result never echoes the input; `reason` is a fixed closed code. */
export type JobParameterParseResult =
  | { readonly ok: true; readonly value: string | number }
  | { readonly ok: false; readonly reason: "invalid_value" };

/**
 * Validates one entered answer against the declared type: `string` is 1 to
 * 128 characters, `integer` is a whole-kobo digit string of at least 1 (and
 * within safe integers), `currency` is exactly three uppercase letters. Any
 * other type fails closed (the schema already closes the set; this is the
 * defensive double-check).
 */
export function parseJobParameterValue(
  declaration: Readonly<Pick<JobParameterDeclaration, "name" | "type" | "required">>,
  input: string,
): JobParameterParseResult {
  switch (declaration.type) {
    case "string":
      return input.length >= 1 && input.length <= 128
        ? { ok: true, value: input }
        : { ok: false, reason: "invalid_value" };
    case "integer": {
      if (!/^\d+$/.test(input)) return { ok: false, reason: "invalid_value" };
      const value = Number(input);
      return Number.isSafeInteger(value) && value >= 1
        ? { ok: true, value }
        : { ok: false, reason: "invalid_value" };
    }
    case "currency":
      return /^[A-Z]{3}$/.test(input)
        ? { ok: true, value: input }
        : { ok: false, reason: "invalid_value" };
    default:
      return { ok: false, reason: "invalid_value" };
  }
}

/** What one seam answer means for a declaration: a value, an explicit skip, an invalid answer, or no answer. */
export type InterpretedJobParameterAnswer =
  | { readonly kind: "value"; readonly value: string | number }
  | { readonly kind: "omitted" }
  | { readonly kind: "invalid" }
  | { readonly kind: "declined" };

/**
 * Maps one `askJobParameter` answer to its meaning: `undefined` is no answer
 * (no terminal, EOF, abort), an explicit empty answer skips an optional
 * parameter, and anything else must parse against the declared type. A
 * required parameter answered empty is invalid, so it is re-prompted.
 */
export function interpretJobParameterAnswer(
  declaration: JobParameterDeclaration,
  answer: string | undefined,
): InterpretedJobParameterAnswer {
  if (answer === undefined) return { kind: "declined" };
  if (!declaration.required && answer === "") return { kind: "omitted" };
  const parsed = parseJobParameterValue(declaration, answer);
  return parsed.ok ? { kind: "value", value: parsed.value } : { kind: "invalid" };
}

/**
 * The manifest's declarations in manifest order (a passthrough, never
 * sorted): the publisher's order tells the story the user reads at consent.
 * `required` defaults to true when absent (the 10-01 schema decision); the
 * generator's `x-` index signature is dropped by constructing fresh objects.
 */
export function orderParameterDeclarations(
  parameters: Manifest["job"]["parameters"],
): readonly JobParameterDeclaration[] {
  return (parameters ?? []).map((parameter) => ({
    name: parameter.name,
    type: parameter.type,
    ...(parameter.description === undefined ? {} : { description: parameter.description }),
    required: parameter.required ?? true,
  }));
}

/**
 * Re-validates the entered values against the declarations and builds the
 * create-bound record in declaration order. This is the binding helper
 * `create` runs once more at activation (the entry loop already parsed each
 * answer, so a mismatch is unreachable by UI): a missing required value, a
 * name no declaration mentions, or a value the declared type cannot hold
 * (including an integer or float in the wrong place) returns `undefined`,
 * and the caller must fail with the internal error and write nothing. An
 * all-optional manifest with every value skipped binds an empty record.
 */
export function bindJobParameters(
  declarations: readonly JobParameterDeclaration[],
  values: Readonly<Record<string, string | number>>,
): Readonly<Record<string, string | number>> | undefined {
  const bound: Record<string, string | number> = {};
  for (const declaration of declarations) {
    const has = Object.prototype.hasOwnProperty.call(values, declaration.name);
    const value = has ? values[declaration.name] : undefined;
    if (value === undefined) {
      if (declaration.required) return undefined;
      continue;
    }
    if (declaration.type === "integer") {
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) return undefined;
    } else if (typeof value !== "string") {
      return undefined;
    } else {
      const parsed = parseJobParameterValue(declaration, value);
      if (!parsed.ok) return undefined;
    }
    bound[declaration.name] = value;
  }
  for (const name of Object.keys(values)) {
    if (!declarations.some((declaration) => declaration.name === name)) return undefined;
  }
  return bound;
}
