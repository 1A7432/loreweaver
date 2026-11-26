/**
 * The one error type of the expression language.
 *
 * Expressions are pack-author content, so every failure carries a stable machine code
 * (callers branch on it, tests pin it) and the UTF-16 offset in the source where it
 * happened. The English message is a diagnostic for the author of the pack; anything a
 * player sees is localized by the caller from `code`.
 */

export type ExprErrorCode =
  // Bounds: the expression is larger than the evaluator agrees to look at.
  | "TOO_LONG"
  | "TOO_MANY_TOKENS"
  | "TOO_DEEP"
  // Syntax.
  | "EMPTY"
  | "UNEXPECTED_CHARACTER"
  | "UNTERMINATED_STRING"
  | "UNEXPECTED_TOKEN"
  | "UNEXPECTED_END"
  | "CHAINED_COMPARISON"
  | "BAD_SEGMENT"
  | "UNKNOWN_FUNCTION"
  | "ARITY"
  | "GETVAR_NAME"
  | "OUTSIDE_SUBSET"
  // Values (raised at compile time when the operands are all literals, else at run time).
  | "NUMBER_RANGE"
  | "VALUE_TOO_LARGE"
  | "TYPE_MISMATCH"
  | "UNORDERABLE"
  | "DIVISION_BY_ZERO"
  // Run time only: what the resolver supplied.
  | "ABSENT_NAME"
  | "BAD_VALUE";

export class ExprError extends Error {
  readonly code: ExprErrorCode;
  /** UTF-16 offset into the source text. */
  readonly position: number;
  /** The diagnostic without the position suffix. */
  readonly detail: string;

  constructor(code: ExprErrorCode, detail: string, position: number) {
    super(`${detail} (at ${position})`);
    this.name = "ExprError";
    this.code = code;
    this.position = position;
    this.detail = detail;
  }
}
