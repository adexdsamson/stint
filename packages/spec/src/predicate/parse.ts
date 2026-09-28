/**
 * Hand-written tokenizer/recursive-descent parser for the closed
 * `resource_query` predicate grammar (D-01, D-28). See `ast.ts` for the
 * BNF this implements verbatim and spec/ALP.md Section 7.6 for the
 * normative prose statement of the same grammar.
 *
 * `parsePredicate` never throws to its caller and never interprets the
 * predicate string as executable code of any kind (T-05-02-E) — any
 * deviation from the grammar, however small, is reported as a `Result`
 * rejection with the fixed `invalid_predicate` code. Internally the parser
 * uses a private `ParseFailure` exception purely as short-circuit control
 * flow within this module; it is always caught and converted before this
 * function returns.
 */

import type { Result } from "../errors.js";
import type { Aggregate, CompareOp, PredicateAst, PredicateFilter } from "./ast.js";

const AGGREGATES: readonly Aggregate[] = ["count", "sum", "exists"];

/** Longest-prefix-first so `!=`/`<=`/`>=` are never mis-tokenized as `<`/`>` followed by stray input. */
const COMPARE_OPS_LONGEST_FIRST: readonly CompareOp[] = ["!=", "<=", ">=", "=", "<", ">"];

const IDENTIFIER_RE = /^[A-Za-z][A-Za-z0-9_]*/;
const NUMBER_RE = /^-?\d+(?:\.\d+)?/;

class ParseFailure extends Error {}

interface ParseState {
  readonly source: string;
  pos: number;
}

function isAtEnd(state: ParseState): boolean {
  return state.pos >= state.source.length;
}

function peek(state: ParseState): string {
  return state.source[state.pos] ?? "";
}

function skipWhitespace(state: ParseState): void {
  while (!isAtEnd(state) && /\s/.test(peek(state))) {
    state.pos += 1;
  }
}

function tryConsume(state: ParseState, literal: string): boolean {
  if (state.source.startsWith(literal, state.pos)) {
    state.pos += literal.length;
    return true;
  }
  return false;
}

function expectChar(state: ParseState, ch: string): void {
  if (!tryConsume(state, ch)) {
    throw new ParseFailure(`expected "${ch}"`);
  }
}

function parseIdentifier(state: ParseState): string {
  const match = IDENTIFIER_RE.exec(state.source.slice(state.pos));
  if (!match) {
    throw new ParseFailure("expected an identifier");
  }
  state.pos += match[0].length;
  return match[0];
}

function parseNumberLiteral(state: ParseState): number {
  const match = NUMBER_RE.exec(state.source.slice(state.pos));
  if (!match) {
    throw new ParseFailure("expected a number literal");
  }
  state.pos += match[0].length;
  return Number(match[0]);
}

function parseStringLiteral(state: ParseState): string {
  expectChar(state, "'");
  let value = "";
  while (!isAtEnd(state) && peek(state) !== "'") {
    value += peek(state);
    state.pos += 1;
  }
  if (isAtEnd(state)) {
    throw new ParseFailure("unterminated string literal");
  }
  state.pos += 1; // consume closing quote
  return value;
}

function parseLiteral(state: ParseState): string | number {
  if (peek(state) === "'") {
    return parseStringLiteral(state);
  }
  return parseNumberLiteral(state);
}

function parseCompareOp(state: ParseState): CompareOp {
  for (const op of COMPARE_OPS_LONGEST_FIRST) {
    if (tryConsume(state, op)) {
      return op;
    }
  }
  throw new ParseFailure("expected a comparison operator");
}

function parseFilter(state: ParseState): PredicateFilter {
  const field = parseIdentifier(state);
  skipWhitespace(state);
  const op = parseCompareOp(state);
  skipWhitespace(state);
  const literal = parseLiteral(state);
  return { field, op, literal };
}

interface AggregateExprResult {
  readonly aggregate: Aggregate;
  readonly aggregateField?: string;
  readonly filter?: PredicateFilter;
}

function parseAggregateExpr(state: ParseState): AggregateExprResult {
  const name = parseIdentifier(state);
  if (!(AGGREGATES as readonly string[]).includes(name)) {
    throw new ParseFailure(`unknown aggregate "${name}"`);
  }
  const aggregate = name as Aggregate;

  expectChar(state, "(");
  skipWhitespace(state);
  if (!tryConsume(state, "rows")) {
    throw new ParseFailure('expected "rows"');
  }

  let aggregateField: string | undefined;
  if (aggregate === "sum") {
    expectChar(state, ".");
    aggregateField = parseIdentifier(state);
  }

  skipWhitespace(state);
  let filter: PredicateFilter | undefined;
  if (tryConsume(state, "where")) {
    skipWhitespace(state);
    filter = parseFilter(state);
    skipWhitespace(state);
  }

  expectChar(state, ")");

  return {
    aggregate,
    ...(aggregateField !== undefined ? { aggregateField } : {}),
    ...(filter !== undefined ? { filter } : {}),
  };
}

function invalidPredicate(message: string): Result<never> {
  return {
    ok: false,
    errors: [
      {
        path: "",
        code: "invalid_predicate",
        message: `Predicate could not be parsed: ${message}.`,
      },
    ],
  };
}

/**
 * Parses `source` against the closed grammar in `ast.ts`, returning a
 * `Result<PredicateAst>`. Never throws. Any deviation from the grammar
 * (unknown aggregate, boolean combinators, unbalanced parens, missing
 * compare, trailing input, malformed literal, etc.) is reported as a
 * rejection with the fixed `invalid_predicate` code; this function is the
 * only place in `@stint/spec` that decides whether a predicate string is
 * in-grammar.
 */
export function parsePredicate(source: string): Result<PredicateAst> {
  try {
    const state: ParseState = { source, pos: 0 };
    skipWhitespace(state);

    const { aggregate, aggregateField, filter } = parseAggregateExpr(state);

    if (aggregate === "sum" && aggregateField === undefined) {
      throw new ParseFailure('"sum" requires an aggregate field (e.g. "sum(rows.amount)")');
    }
    if (aggregate !== "sum" && aggregateField !== undefined) {
      throw new ParseFailure(`only "sum" takes an aggregate field, not "${aggregate}"`);
    }

    skipWhitespace(state);
    const compareOp = parseCompareOp(state);
    skipWhitespace(state);
    const compareLiteral = parseNumberLiteral(state);
    skipWhitespace(state);

    if (!isAtEnd(state)) {
      // Rejects boolean combinators (AND/OR) and any other trailing input:
      // the grammar has no production that continues past the outer compare.
      throw new ParseFailure("unexpected trailing input after the comparison");
    }

    const ast: PredicateAst = {
      aggregate,
      ...(aggregateField !== undefined ? { aggregateField } : {}),
      ...(filter !== undefined ? { filter } : {}),
      compareOp,
      compareLiteral,
    };

    return { ok: true, value: ast };
  } catch (err) {
    const message = err instanceof ParseFailure ? err.message : "malformed predicate";
    return invalidPredicate(message);
  }
}
