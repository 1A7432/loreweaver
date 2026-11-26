/**
 * The one error type of check resolution.
 *
 * Two audiences, one class. A pack author meets the compile-time codes, raised while a
 * rule pack loads, with `packId` and `path` pointing at the offending entry. A caller
 * meets the call-time codes, raised while a check is graded or rolled (a missing roll
 * parameter, a target the ladder needs but was not given), with `param` naming the slot
 * where one is involved. Callers branch on `code` and localize from it; the English
 * `message` is a diagnostic, never shown to a player.
 */

export type ResolutionErrorCode =
  // --- Compile time: the pack's `resolution:` section is malformed. ---
  /** A value has the wrong type or is missing where it is required. */
  | "BAD_FIELD"
  /** A mapping carries a key this format does not define. */
  | "UNKNOWN_KEY"
  /** `version` is not one this engine reads. */
  | "UNSUPPORTED_VERSION"
  /** An id (rank, variant, difficulty, parameter, modifier) is not a slug. */
  | "BAD_ID"
  /** Two entries collapse to the same id (prefix locales compare case-insensitively). */
  | "DUPLICATE_ID"
  /** More ranks, variants or difficulties than the limits allow. */
  | "TOO_MANY"
  /** An expression does not compile (`cause` is the `ExprError`). */
  | "BAD_EXPRESSION"
  /** An expression reads a name the check context never supplies. */
  | "UNKNOWN_NAME"
  /** An expression reads `target`/`raw_target` in a system declared `target: none`. */
  | "TARGET_FORBIDDEN"
  /** A ladder does not end with exactly one unconditional rule, last. */
  | "BAD_LADDER"
  /** Dice notation does not parse (`cause` is the `DiceError`). */
  | "BAD_NOTATION"
  /** Dice notation uses a `{slot}` the section does not declare under `params`. */
  | "UNDECLARED_PARAM"
  /** A parameter's `max` is below its `min`. */
  | "BAD_RANGE"
  /** `check` routes favourable/unfavourable counts to a modifier that is not declared. */
  | "UNDECLARED_MODIFIER"
  /** `resolution.script` (the sandboxed script lane) is not supported by this layer. */
  | "SCRIPT_UNSUPPORTED"
  // --- Call time: what the caller handed in. ---
  /** A declared roll parameter has no value and no default (`param` names it). */
  | "MISSING_PARAM"
  /** A roll parameter's value is not an integer (`param` names it). */
  | "INVALID_PARAM"
  /** A target that is not a safe integer. */
  | "INVALID_TARGET"
  /** Rolled values (total, faces, successes, ones) that are not safe integers. */
  | "INVALID_ROLL"
  /** A situational modifier that is not a safe integer. */
  | "INVALID_MODIFIER"
  /** A count (favourable/unfavourable, a roll modifier's, Luck already spent) that is not a safe integer. */
  | "INVALID_COUNT"
  /** A roll modifier name the pack does not declare. */
  | "UNKNOWN_MODIFIER"
  /** The ladder or margin read `target`/`raw_target`, and the caller gave no target. */
  | "TARGET_REQUIRED"
  /** The ladder or margin read `dice[i]` beyond the faces the roll kept. */
  | "DIE_MISSING"
  /** A pack expression failed on these values (`cause` is the `ExprError`), or yielded a non-number where a number is due. */
  | "EXPRESSION_FAILED"
  /** The dice engine refused the roll (`cause` is the `DiceError`), e.g. a parameter making a dice count negative. */
  | "ROLL_FAILED"
  /** Luck: the points to spend are not a positive integer. */
  | "LUCK_POINTS_NOT_POSITIVE"
  /** Luck: a fumble cannot be bought off. */
  | "LUCK_FUMBLE"
  /** Luck: the spend would take the roll below 1. */
  | "LUCK_EXCEEDS_ROLL";

export interface ResolutionErrorDetails {
  /** The pack whose section failed to compile. */
  readonly packId?: string;
  /** Where in the pack, as a dotted path (`resolution.variants.rule1.ranks[2].when`). */
  readonly path?: string;
  /** The roll parameter a call-time error is about. */
  readonly param?: string;
  /** The underlying `ExprError` or `DiceError`. */
  readonly cause?: unknown;
}

export class ResolutionError extends Error {
  readonly code: ResolutionErrorCode;
  readonly packId: string | undefined;
  readonly path: string | undefined;
  readonly param: string | undefined;

  constructor(code: ResolutionErrorCode, detail: string, details: ResolutionErrorDetails = {}) {
    const where = [details.packId === undefined ? "" : `rule pack '${details.packId}'`, details.path ?? ""].filter((part) => part !== "").join(": ");
    super(`${code}: ${where === "" ? "" : `${where}: `}${detail}`, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = "ResolutionError";
    this.code = code;
    this.packId = details.packId;
    this.path = details.path;
    this.param = details.param;
  }
}
