/**
 * Character sheets, shaped entirely by rule-pack data.
 *
 * A pack's `sheet:` section (with its `defaults`, `alias`, `display`, `derived` and
 * `creation_constraints`) compiles once into an immutable `SheetSpec`
 * (`compileSheetSpec`); every function here takes that spec plus a `Sheet` — plain JSON
 * data, never mutated — and returns new data. Derived values are never stored on a sheet:
 * they are computed from the spec on each read. Problems with a sheet are reported as
 * data (`SheetViolation`, `FormulaIssue`, a refused write); only a malformed pack throws
 * (`SheetSpecError`, at compile time).
 *
 * Rolling a new character is `generateCharacter` (`generate.ts`). Not here: resolving a
 * system name to its pack (the rule-pack loader), storage.
 */

export {
  checkValue,
  displayName,
  getHitPoints,
  HP_ATTRIBUTE,
  HPMAX_ATTRIBUTE,
  type HitPointsRead,
  type HitPointsUpdate,
  type HitPointsWrite,
  hasCheckValue,
  resolveName,
  resourceLabels,
  type StatRead,
  setHitPoints,
  setSheetValue,
  sheetValue,
  type ValueWrite,
  type WriteRefusal,
} from "./access.ts";
export { SheetSpecError, type SheetSpecErrorCode } from "./errors.ts";
export {
  type AttributeRead,
  attributeSlot,
  canonicalValues,
  computeDerived,
  type DerivedValues,
  evaluateSheet,
  HP_NAME,
  HPMAX_NAME,
  type SheetEvaluation,
} from "./evaluate.ts";
export { type DerivedValue, FORMULA_FUNCTIONS, type FormulaIssue, type FormulaIssueCode, type FormulaKind } from "./formulas.ts";
export { type AttributeRoll, creationRolls, type GenerateOptions, type GeneratedCharacter, generateCharacter } from "./generate.ts";
export { newSheet, type RefreshOptions, type Refreshed, refreshSheet } from "./refresh.ts";
export {
  type HitPoints,
  type JsonObject,
  type JsonValue,
  type ParsedSheet,
  parseSheet,
  type Sheet,
  type SheetSection,
  type SheetViolation,
  type SheetViolationCode,
} from "./sheet.ts";
export {
  type AttributeConstraint,
  type Budget,
  type BudgetPart,
  type CreationConstraints,
  compileSheetSpec,
  type FieldValue,
  MAX_RESOURCES,
  type PointBuy,
  type Range,
  type ResourceSpec,
  type SheetPackSource,
  type SheetShape,
  type SheetSpec,
  type Vital,
} from "./spec.ts";
export { type Entry, type Table, tableGet, tableHas, tableWith, tableWithout } from "./table.ts";
export { coerceInt, normalizeAlias } from "./text.ts";
export { type ValidateOptions, type Validated, validateSheet } from "./validate.ts";
export { type WireResource, type WireResources, wireResources } from "./wire.ts";
