// The card split (拆卡): a SillyTavern "heavy card" is a world wearing a character card's
// clothes — variable schemas and template code ride along with the persona because a
// single-player frontend had nowhere else to put them. Import splits every card into:
//   - the CHARACTER half: persona prose and plain personal lore, safe for any player to
//     import into a room;
//   - the WORLD machinery: variable declarations (`[InitVar]` entries) and template code
//     (EJS), which reach a room only through the admin's WORLD import;
//   - the card's standing DIRECTIVES (`system_prompt`, `post_history_instructions`): not
//     machinery (a plain persona card often has a system prompt), but standing prompt
//     text all the same, so only a world import keeps them.
//
// Classification and stripping are pure functions (iron rule 1), so the player path is
// safe by construction: a stripped card cannot seed the variable tree or carry template
// code, however it is phrased (iron rule 3).
//
// 3.0 has no hooks. A card still carrying hook scripts (a lorecard's `hooks`, or
// `extensions.loreweaver_hooks` at the root or in `data`) carries machinery 3.0 does not
// run: it is a world card, the scripts are reported in a warning, and neither import
// keeps them.
import { initVarBody, mergeDeclarations, parseInitVar, type InitVarParse, type VariableSpec, type VarMap } from "../variables/index.ts";
import { entrySecrecy, entryTitle as sharedEntryTitle, isVariableDeclaration as sharedIsVariableDeclaration, splitDecorators as sharedSplitDecorators } from "../worldbook/index.ts";
import { isObject, text, type BookEntry, type CharacterCard } from "./card.ts";
import { countHookScripts } from "./lorecard.ts";
import type { ImportedCard } from "./parse.ts";

export type CardKind = "world" | "character";

/** What the world half of a card holds, by count (all zero for a plain persona card). */
export interface CardMachinery {
  readonly variableDeclarations: number;
  readonly templateSpans: number;
  /**
   * Keeper-only lore entries (`secret: true`, at the entry or in its `extensions`), and
   * entries whose `secret` is not a boolean (fail closed: never on the character half).
   */
  readonly secretEntries: number;
  readonly unsupportedHooks: number;
  /** Typed module variables a native bundle declares (shared room state, like a tree). */
  readonly moduleVariables: number;
  /** Non-blank standing directives, 0-2. Not machinery: never makes a card a world card. */
  readonly directives: number;
}

export interface SplitWarning {
  /** `secret_unreadable`: entries whose `secret` is neither a boolean nor absent (the lore import refuses them). */
  readonly code: "hooks_unsupported" | "declaration_unreadable" | "secret_unreadable";
  readonly count: number;
}

export interface WorldImport {
  /** The ORIGINAL lore, variable declarations taken out (they are the tree, not lore). */
  readonly entries: readonly BookEntry[];
  /** The declared tree, merged from every readable declaration in order; null when none. */
  readonly variables: VarMap | null;
  /** Each declaration entry's parse, in order. */
  readonly declarations: readonly InitVarParse[];
  /** A native bundle's typed variables and pregenerated cast (world machinery). */
  readonly moduleVariables: readonly VariableSpec[];
  readonly pregens: NonNullable<ImportedCard["lorecard"]>["pregens"];
  readonly systemPrompt: string;
  readonly postHistoryInstructions: string;
}

export interface CardSplit {
  readonly kind: CardKind;
  readonly machinery: CardMachinery;
  /** What a PLAYER import keeps: the character half (its `raw` is null). */
  readonly character: CharacterCard;
  /** What an admin's WORLD import keeps. */
  readonly world: WorldImport;
  readonly warnings: readonly SplitWarning[];
}

// One EJS span in any form (`<%`, `<%=`, `<%-`, `<%#`, `<%_`, trimming closers); a
// dangling opener strips to the end of the text — fail closed: no template fragment may
// survive into prose that a prompt renders.
const EJS_SPAN = /<%[\s\S]*?%>/g;
const EJS_DANGLING = /<%[\s\S]*$/;

/** `text` with every EJS span removed, and how many were. */
export function stripTemplates(source: string): { readonly text: string; readonly spans: number } {
  if (!source.includes("<%")) return { text: source, spans: 0 };
  let spans = 0;
  let clean = source.replace(EJS_SPAN, () => {
    spans += 1;
    return "";
  });
  if (clean.includes("<%")) {
    clean = clean.replace(EJS_DANGLING, "");
    spans += 1;
  }
  return { text: clean, spans };
}

// ---------------------------------------------------------------------------
// Variable declarations
// ---------------------------------------------------------------------------

/** Leading `@@decorator` lines of an entry: the lore import's reader (`core/worldbook/decorators.ts`). */
export const splitDecorators = sharedSplitDecorators;

/** An entry's title: `title`, else `comment`, else `name` (the first non-empty string). */
export function entryTitle(entry: BookEntry): string {
  return sharedEntryTitle(entry);
}

/**
 * Whether an entry declares variables rather than telling lore: the one recogniser the
 * lore import uses too (`core/worldbook/entry_rules.ts`, where the rule is stated).
 */
export function isVariableDeclaration(entry: BookEntry): boolean {
  return sharedIsVariableDeclaration(entry);
}

/**
 * Whether an entry stays off the character half as keeper-only: `secret: true` at the
 * entry or in its `extensions`, or a `secret` that is not a boolean (fail closed; the lore
 * import refuses such an entry). The definition is `entrySecrecy`'s.
 */
export function isSecretEntry(entry: BookEntry): boolean {
  return entrySecrecy(entry) !== "public";
}

/** The declaration an entry carries, parsed (decorators and wrappers off first). */
export function parseDeclaration(entry: BookEntry): InitVarParse {
  return parseInitVar(initVarBody(splitDecorators(text(entry.content)).body));
}

// ---------------------------------------------------------------------------
// Hooks (unsupported in 3.0)
// ---------------------------------------------------------------------------

const HOOKS_EXTENSION = "loreweaver_hooks";

/**
 * Hook scripts a SillyTavern-shaped document carries, counted in EVERY place a 2.x card
 * put them: a top-level `hooks` list, `data.extensions.loreweaver_hooks` and the root
 * `extensions.loreweaver_hooks` (2.x looked in one place only, so a v2 card's
 * `data.extensions` hid root-level hooks from the classifier).
 */
export function countCardHooks(raw: CharacterCard["raw"]): number {
  if (raw === null) return 0;
  let count = countHookScripts(raw.hooks);
  const data = raw.data;
  if (isObject(data) && isObject(data.extensions)) count += countHookScripts(data.extensions[HOOKS_EXTENSION]);
  if (isObject(raw.extensions)) count += countHookScripts(raw.extensions[HOOKS_EXTENSION]);
  return count;
}

// ---------------------------------------------------------------------------
// The split
// ---------------------------------------------------------------------------

/**
 * Split a parsed card. The character half strips EJS from every text a prompt or a panel
 * can show — the prose fields, the alternate greetings, and each kept entry's content,
 * title and keys — drops variable declarations and keeper-only entries, blanks the
 * directives, and carries NO source document (`raw: null`), so nothing downstream can
 * read machinery back off it. The world import keeps the original lore (minus the
 * declarations, which become the variable tree) and the directives. The input is never
 * modified.
 */
export function splitCard(imported: ImportedCard): CardSplit {
  const card = imported.card;
  let templateSpans = 0;
  const clean = (source: string): string => {
    const stripped = stripTemplates(source);
    templateSpans += stripped.spans;
    return stripped.text;
  };

  const characterEntries: BookEntry[] = [];
  const worldEntries: BookEntry[] = [];
  const declarations: InitVarParse[] = [];
  let variables: VarMap | null = null;
  let secretEntries = 0;
  let secretUnreadable = 0;
  for (const entry of card.book) {
    if (isVariableDeclaration(entry)) {
      const parsed = parseDeclaration(entry);
      declarations.push(parsed);
      if (parsed.ok) variables = variables === null ? parsed.tree : mergeDeclarations(variables, parsed.tree);
      continue;
    }
    worldEntries.push(entry);
    if (isSecretEntry(entry)) {
      secretEntries += 1;
      if (entrySecrecy(entry) === "invalid") secretUnreadable += 1;
      continue;
    }
    const kept: Record<string, unknown> = { ...entry };
    for (const field of ["content", "title", "comment", "name"] as const) {
      if (typeof entry[field] === "string") kept[field] = clean(entry[field]);
    }
    for (const field of ["keys", "secondary_keys", "key", "keysecondary"] as const) {
      const keys = entry[field];
      // A key that was nothing but template code is no key at all.
      if (Array.isArray(keys)) {
        kept[field] = keys.flatMap((key) => {
          if (typeof key !== "string") return [key];
          const stripped = clean(key);
          return stripped === "" && key !== "" ? [] : [stripped];
        });
      }
    }
    characterEntries.push(kept as BookEntry);
  }

  const directives = [card.systemPrompt, card.postHistoryInstructions].filter((value) => value.trim() !== "").length;
  const character: CharacterCard = {
    ...card,
    name: clean(card.name),
    description: clean(card.description),
    personality: clean(card.personality),
    scenario: clean(card.scenario),
    firstMessage: clean(card.firstMessage),
    exampleMessages: clean(card.exampleMessages),
    creatorNotes: clean(card.creatorNotes),
    creatorNotesMultilingual: Object.fromEntries(Object.entries(card.creatorNotesMultilingual).map(([lang, note]) => [lang, clean(note)])),
    systemPrompt: "",
    postHistoryInstructions: "",
    tags: card.tags.map(clean).filter((tag) => tag !== ""),
    alternateGreetings: card.alternateGreetings.map(clean),
    book: characterEntries,
    raw: null,
  };

  const machinery: CardMachinery = {
    variableDeclarations: declarations.length,
    templateSpans,
    secretEntries,
    unsupportedHooks: imported.unsupportedHooks,
    moduleVariables: imported.lorecard?.variables.length ?? 0,
    directives,
  };
  const warnings: SplitWarning[] = [];
  if (machinery.unsupportedHooks > 0) warnings.push({ code: "hooks_unsupported", count: machinery.unsupportedHooks });
  const unreadable = declarations.filter((parsed) => !parsed.ok).length;
  if (unreadable > 0) warnings.push({ code: "declaration_unreadable", count: unreadable });
  if (secretUnreadable > 0) warnings.push({ code: "secret_unreadable", count: secretUnreadable });
  return {
    kind: isWorld(machinery) ? "world" : "character",
    machinery,
    character,
    world: {
      entries: worldEntries,
      variables,
      declarations,
      moduleVariables: imported.lorecard?.variables ?? [],
      pregens: imported.lorecard?.pregens ?? [],
      systemPrompt: card.systemPrompt,
      postHistoryInstructions: card.postHistoryInstructions,
    },
    warnings,
  };
}

/** A card is a world card exactly when it carries machinery; directives never count. */
export function isWorld(machinery: CardMachinery): boolean {
  return machinery.variableDeclarations > 0 || machinery.templateSpans > 0 || machinery.secretEntries > 0 || machinery.unsupportedHooks > 0 || machinery.moduleVariables > 0;
}
