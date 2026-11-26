/**
 * The one error type of the sheet layer: a rule pack whose `sheet:`, `derived:`,
 * `defaults:`, `alias:`, `display:` or `creation_constraints:` section cannot be
 * compiled. It is raised at pack load, where the author can still fix the file, and
 * never while a table is playing: everything that can go wrong with a SHEET at run time
 * is reported as data (violations, formula issues, refused writes) instead.
 *
 * The message is an English diagnostic for the pack author; callers branch on `code`.
 */

export type SheetSpecErrorCode =
  /** A section or entry has the wrong type (a list where a mapping belongs, …). */
  | "BAD_SHAPE"
  /** A key the format does not define. */
  | "UNKNOWN_KEY"
  /** A required key is missing or empty. */
  | "MISSING"
  /** A number that must be a safe integer is not. */
  | "NOT_INTEGER"
  /** A formula failed to compile (the `ExprError` is the `cause`). */
  | "BAD_FORMULA"
  /** A derived entry names an engine-side computer; packs are data only. */
  | "UNSUPPORTED_COMPUTER"
  /** A `format:` template uses something other than `{}` / `{0}` and `{{` `}}`. */
  | "BAD_FORMAT"
  /** A bound that cannot hold: `floor_div` by 0, a min above its max, too many resources. */
  | "BAD_BOUND";

export class SheetSpecError extends Error {
  readonly code: SheetSpecErrorCode;
  readonly packId: string;
  /** Where in the pack, as dotted YAML keys (`sheet.vitals.SAN.start`). */
  readonly where: string;

  constructor(code: SheetSpecErrorCode, packId: string, where: string, detail: string, cause?: unknown) {
    super(`rule pack '${packId}': ${where}: ${detail}`, cause === undefined ? undefined : { cause });
    this.name = "SheetSpecError";
    this.code = code;
    this.packId = packId;
    this.where = where;
  }
}
