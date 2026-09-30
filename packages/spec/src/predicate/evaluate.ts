/**
 * Pure evaluator for the closed `resource_query` predicate AST (D-01, D-28).
 *
 * `evaluatePredicate` performs no I/O and never throws: an aggregate whose
 * field is missing or whose values are the wrong type for a comparison
 * simply does not match/does not contribute, rather than raising. Rows are
 * the runtime-normalized `{ field: value }` shape a connector binding's row
 * adapter produces (spec/ALP.md Section 7.6, Section 9); this module never
 * reads or writes anything outside its arguments.
 */

import type { Aggregate, CompareOp, PredicateAst } from "./ast.js";

/** A single normalized row: field name to scalar value. */
export type PredicateRow = Readonly<Record<string, unknown>>;

function compareNumeric(actual: number, op: CompareOp, literal: number): boolean {
  switch (op) {
    case "=":
      return actual === literal;
    case "!=":
      return actual !== literal;
    case "<":
      return actual < literal;
    case "<=":
      return actual <= literal;
    case ">":
      return actual > literal;
    case ">=":
      return actual >= literal;
  }
}

function compareStrings(actual: string, op: CompareOp, literal: string): boolean {
  switch (op) {
    case "=":
      return actual === literal;
    case "!=":
      return actual !== literal;
    case "<":
      return actual < literal;
    case "<=":
      return actual <= literal;
    case ">":
      return actual > literal;
    case ">=":
      return actual >= literal;
  }
}

/**
 * Compares a row's field value against the filter's literal. A type
 * mismatch (e.g. a string literal against a numeric field) never matches,
 * rather than throwing or coercing.
 */
function matchesFilterValue(actual: unknown, op: CompareOp, literal: string | number): boolean {
  if (typeof literal === "number") {
    return typeof actual === "number" && compareNumeric(actual, op, literal);
  }
  return typeof actual === "string" && compareStrings(actual, op, literal);
}

function selectMatchingRows(ast: PredicateAst, rows: readonly PredicateRow[]): readonly PredicateRow[] {
  const { filter } = ast;
  if (filter === undefined) {
    return rows;
  }
  return rows.filter((row) => matchesFilterValue(row[filter.field], filter.op, filter.literal));
}

/**
 * Computes the aggregate's numeric value over the (already filtered) rows.
 * `exists` is a truthiness count (`0` or `1`, D-01): the outer compare is
 * always numeric, so `exists(...) >= 1` is how "at least one row matches"
 * is expressed, never a boolean literal.
 */
function computeAggregateValue(aggregate: Aggregate, aggregateField: string | undefined, rows: readonly PredicateRow[]): number {
  switch (aggregate) {
    case "count":
      return rows.length;
    case "exists":
      return rows.length > 0 ? 1 : 0;
    case "sum": {
      if (aggregateField === undefined) {
        return 0;
      }
      return rows.reduce((total, row) => {
        const value = row[aggregateField];
        return total + (typeof value === "number" ? value : 0);
      }, 0);
    }
  }
}

/**
 * Evaluates `ast` against `rows`, returning the boolean result of the
 * predicate's outer comparison. Pure, no I/O, never throws.
 */
export function evaluatePredicate(ast: PredicateAst, rows: readonly PredicateRow[]): boolean {
  const matchingRows = selectMatchingRows(ast, rows);
  const aggregateValue = computeAggregateValue(ast.aggregate, ast.aggregateField, matchingRows);
  return compareNumeric(aggregateValue, ast.compareOp, ast.compareLiteral);
}
