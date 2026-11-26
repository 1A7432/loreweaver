/**
 * The one error type a caller meets when a rule pack does not load.
 *
 * A pack is content: it is checked once, when it loads, and every problem found there is
 * a `RulePackError` naming the pack, the offending field as a dotted path
 * (`subsystems.sanity_check.loss_ceiling.when`) and a stable `code` to branch on. The
 * layers a pack is compiled by (resolution, sheet spec, dice notation, expressions, YAML)
 * have their own error types; this module wraps them, keeping the inner code in
 * `layerCode` and the inner error as `cause`. The English `message` is a diagnostic for
 * the pack author, never shown to a player.
 */

export type RulePackErrorCode =
  /** The text is not valid YAML, or uses something the YAML reader refuses (`layerCode` has its code). */
  | "BAD_YAML"
  /** The document (or a base it extends) is not a mapping. */
  | "NOT_A_MAPPING"
  /** The pack id is not a slug. */
  | "BAD_ID"
  /** A value has the wrong type or shape, or a required value is missing or empty. */
  | "BAD_FIELD"
  /** A closed block carries a key the format does not define. */
  | "UNKNOWN_KEY"
  /** Two entries collapse to one name (case-folded words, table ids, locales), or a registry already holds the pack id. */
  | "DUPLICATE_ID"
  /** More entries than the format allows (subsystems, table entries). */
  | "TOO_MANY"
  /** A name the engine keeps for itself. */
  | "RESERVED_NAME"
  /** A reference to something the pack does not declare (a command's subsystem, a default table). */
  | "UNDECLARED"
  /** Dice notation does not parse (`cause` is the `DiceError`). */
  | "BAD_NOTATION"
  /** An expression does not compile (`cause` is the `ExprError`). */
  | "BAD_EXPRESSION"
  /** The pack needs the sandboxed rules-script lane (`resolution.script`, a `script` subsystem), which is not built. */
  | "SCRIPT_UNSUPPORTED"
  /** A subsystem whose template rolls the system's check, in a pack without a `resolution:` section. */
  | "NEEDS_RESOLUTION"
  /** A write target that is a derived attribute slot, which is never stored. */
  | "DERIVED_SLOT"
  /** `extends` is not a non-empty string. */
  | "EXTENDS_INVALID"
  /** `extends` names a base no loader knows. */
  | "EXTENDS_UNKNOWN"
  /** An `extends` chain comes back to a pack already in it. */
  | "EXTENDS_CYCLE"
  /** An `extends` chain has more bases than allowed. */
  | "EXTENDS_TOO_DEEP"
  /** The `resolution:` section does not compile (`layerCode` is the `ResolutionError` code). */
  | "BAD_RESOLUTION"
  /** A sheet-related section does not compile (`layerCode` is the `SheetSpecError` code). */
  | "BAD_SHEET";

export interface RulePackErrorDetails {
  readonly layerCode?: string;
  readonly cause?: unknown;
}

export class RulePackError extends Error {
  readonly code: RulePackErrorCode;
  readonly packId: string;
  /** Dotted path of the offending field; `(root)` for the document itself. */
  readonly path: string;
  /** The wrapped layer's own error code, for a wrapped error. */
  readonly layerCode: string | undefined;

  constructor(code: RulePackErrorCode, packId: string, path: string, detail: string, details: RulePackErrorDetails = {}) {
    super(`${code}: rule pack '${packId}': ${path}: ${detail}`, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = "RulePackError";
    this.code = code;
    this.packId = packId;
    this.path = path;
    this.layerCode = details.layerCode;
  }
}
