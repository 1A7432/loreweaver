// Imported cards: SillyTavern character cards (v1/v2/v3, JSON or PNG) and the native
// lorecard bundle, parsed and split into what a player import and a world import keep.
export { CardError, type CardErrorCode } from "./errors.ts";
export { MAX_BOOK_ENTRIES, MAX_CARD_FILE_BYTES, MAX_CARD_JSON_DEPTH, normalizeStCard, parseStCardBytes, type BookEntry, type CharacterCard } from "./card.ts";
export { extractPngCardText, isPng, MAX_INFLATED_TEXT_BYTES } from "./png.ts";
export {
  countHookScripts,
  looksLikeLorecard,
  parseLorecard,
  LORECARD_FORMAT,
  LORECARD_VERSION,
  MAX_LORECARD_ENTRIES,
  MAX_LORECARD_FILE_BYTES,
  type Lorecard,
  type LorecardWarning,
  type LorecardWarningCode,
  type Pregen,
} from "./lorecard.ts";
export { parseCard, type ImportedCard } from "./parse.ts";
export {
  countCardHooks,
  entryTitle,
  isSecretEntry,
  isVariableDeclaration,
  isWorld,
  parseDeclaration,
  splitCard,
  splitDecorators,
  stripTemplates,
  type CardKind,
  type CardMachinery,
  type CardSplit,
  type SplitWarning,
  type WorldImport,
} from "./split.ts";
