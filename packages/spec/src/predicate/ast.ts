/**
 * Closed AST for the `resource_query` predicate grammar (D-01, D-28,
 * spec/ALP.md Section 7.6).
 *
 * Grammar (informal BNF; the parser in `parse.ts` implements exactly this,
 * and spec/ALP.md Section 7.6 states the same grammar in prose so neither
 * drifts from the other):
 *
 *   predicate      = aggregate-expr ws compare-op ws number
 *   aggregate-expr = "count(rows" [ws "where" ws filter] ")"
 *                   | "sum(rows." field [ws "where" ws filter] ")"
 *                   | "exists(rows" [ws "where" ws filter] ")"
 *   filter         = field ws compare-op ws literal
 *   compare-op     = "!=" | "<=" | ">=" | "=" | "<" | ">"
 *   field          = identifier
 *   literal        = string-literal | number
 *   string-literal = "'" { any character except "'" } "'"
 *   number         = ["-"] digit {digit} ["." digit {digit}]
 *   identifier     = letter { letter | digit | "_" }
 *
 * Deliberately closed and minimal: no `AND`/`OR`, no nesting, no more than
 * one filter clause, and the outer comparison is always against a numeric
 * literal (an `exists` predicate is compared as a truthiness count, e.g.
 * `exists(rows where status = 'reconciled') >= 1`, never as a boolean
 * literal). Grammar size is attack surface (T-05-02-E): the parser in
 * `parse.ts` is a hand-written tokenizer/recursive-descent parser and never
 * interprets the predicate string as executable code of any kind.
 */

/** The fixed aggregate vocabulary. No other aggregate is ever accepted. */
export type Aggregate = "count" | "sum" | "exists";

/** The fixed comparison-operator vocabulary, used for both the optional filter and the outer compare. */
export type CompareOp = "=" | "!=" | "<" | "<=" | ">" | ">=";

/** A single, non-combinable `field OP literal` filter clause. */
export interface PredicateFilter {
  readonly field: string;
  readonly op: CompareOp;
  readonly literal: string | number;
}

/**
 * A closed predicate AST. `aggregateField` is present if and only if
 * `aggregate === "sum"`. `filter` is optional; when absent the aggregate
 * runs over every row. `compareLiteral` is always numeric (D-01): `count`
 * and `sum` compare a count/sum, and `exists` compares its truthiness count
 * (`0` or `1`), never a boolean literal.
 */
export interface PredicateAst {
  readonly aggregate: Aggregate;
  readonly aggregateField?: string;
  readonly filter?: PredicateFilter;
  readonly compareOp: CompareOp;
  readonly compareLiteral: number;
}
