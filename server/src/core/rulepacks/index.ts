/**
 * Rule packs: one tabletop system described entirely as data, one YAML document each.
 *
 * `compileRulePack(id, text)` checks a pack once and returns a frozen `RulePack` holding
 * every section compiled — resolution, sheet spec, subsystems, commands, labels,
 * initiative, expertise, turn checks — with `extends:` already resolved. Every problem is
 * a `RulePackError` (stable `code`, pack id, dotted path). A `RulePackRegistry` is the
 * explicit set of packs a caller loaded, resolving a system by any of its names.
 * `builtInPacks()` compiles the three packs the binary carries.
 *
 * Not here: reading pack files from disk or discovering installed packs (the caller's
 * I/O), the rules-script lane (packs that need it are refused), running subsystems
 * (`core/subsystems`).
 */

export { builtInPackIds, builtInPackSource, builtInPacks } from "./builtin.ts";
export { type BaseSource, builtInBase, type CompileOptions, compileRulePack, PACK_ID } from "./compile.ts";
export { RulePackError, type RulePackErrorCode, type RulePackErrorDetails } from "./errors.ts";
export { type BaseDocumentLoader, MAX_EXTENDS_DEPTH, mergeDocuments, resolveExtends } from "./extends.ts";
export { expertiseText, rankDisplay, rankLabel, subsystemName, tableName } from "./labels.ts";
export { commandWord, RulePackRegistry } from "./registry.ts";
export type { CommandBinding, RankLabel, RulePack, TurnCheck } from "./types.ts";
