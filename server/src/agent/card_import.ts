// Bringing a SillyTavern card (or a native lorecard) into a room: the step after parsing
// (`core/card`) that WRITES a card's parts as room documents.
//
// Two imports, and the split between them is iron rule 3's card split (拆卡):
//   - `importWorld` — the admin's world import. The card's lorebook becomes the room's lore
//     entries (keeper trust: secrecy honoured, render-time templates kept), its `[InitVar]`
//     declarations seed the variable tree, a native bundle's typed variables become module
//     variables, and the card's prose, standing directives and openings are kept for the
//     Keeper in a `world_card` document — whose existence is the room's "a world was
//     imported" marker. World machinery reaches a room through this function and nowhere
//     else. Whether the caller may run it (the admin check) is the command layer's.
//   - `importCharacter` — a player's character. Only the character half of `splitCard`
//     is read, and only its name and persona are written: a character document with a
//     sheet rolled for the room's rule pack — biased toward the concept the authoring lane
//     read from the persona, when the caller has one (`agent/lanes/genchar.ts`) — and the
//     persona as its background (or its notes, under the concept's backstory), seated for
//     the importing member. Nothing in this path writes a lore entry, a variable or a
//     directive, whatever the card holds; what was left behind is reported by count.
//
// Both are synchronous: the caller parses the bytes first (`parseCard`). Every refusal is
// decided before the first write; the writes then land in one store transaction, all or
// none, through the context's writer — a writer from a past generation of the room comes
// back as the `stale_writer` refusal, with nothing written.
//
// A second world import: the reference server's behaviour, kept. Re-importing the SAME card
// (same name) replaces that card's lore entries and its `world_card` document, and re-seeds
// the variable tree the MagVarUpdate way (a top-level key the room already has keeps the
// room's value, so a re-import never resets progress; the exposure list stays). A
// DIFFERENT card stacks: its entries are added beside the first card's, both cards'
// directives ride the Keeper's prompt (in import order), and the variable trees merge by
// the same rule. Stacking is what SillyTavern users do with lorebook add-on cards; an admin
// who wants a clean slate resets the room (`all`) first.
import { createHash } from "node:crypto";

import { splitCard, type CardMachinery, type CardSplit, type SplitWarning } from "../core/card/split.ts";
import type { ImportedCard } from "../core/card/parse.ts";
import {
  MAX_ALTERNATE_GREETINGS,
  MAX_DIRECTIVE_CHARS,
  MAX_OPENING_CHARS,
  MAX_WORLD_NAME_CHARS,
  MAX_WORLD_PROSE_CHARS,
  openingCount,
  prepareDirective,
  readWorldCardDocument,
  validateWorldCard,
  worldCardData,
  worldCardId,
  WORLD_CARD_TYPE,
  type WorldCard,
} from "../core/card/world_card.ts";
import {
  type CharacterConcept,
  CHARACTER_TYPE,
  characterData,
  characterOf,
  conceptCharacterSheet,
  type ConceptPersona,
  createCharacter,
  EMPTY_SEATING,
  MAX_CHARACTER_NAME_CHARS,
  readSeating,
  seatingData,
  SEATING_ID,
  SEATING_TYPE,
  switchCharacter,
} from "../core/characters/index.ts";
import type { JsonObject } from "../core/documents/model.ts";
import { DocumentRefused } from "../core/documents/raw.ts";
import {
  EMPTY_OVERLAY,
  LORE_ENTRY_TYPE,
  LORE_OVERLAY_ID,
  LORE_OVERLAY_TYPE,
  loreEntryDocument,
  loreSource,
  MAX_ROOM_LORE_ENTRIES,
  readOverlay,
  syncLoreSwitches,
  validateLoreEntry,
} from "../core/lore/index.ts";
import type { RulePack } from "../core/rulepacks/index.ts";
import {
  codePoints,
  defineVariable,
  EMPTY_MODULE_VARIABLES,
  MODULE_VARIABLES_ID,
  MODULE_VARIABLES_TYPE,
  moduleVariablesDocument,
  moduleVariablesPayload,
  normalizeModuleVariables,
  readVariableTree,
  seedTree,
  treeProblem,
  VARIABLE_TREE_ID,
  VARIABLE_TREE_TYPE,
  variableTreeData,
  variableTreeDocument,
} from "../core/variables/index.ts";
import { bindCharName, importLorebook, type MacroContext, substituteMacros } from "../core/worldbook/index.ts";
import { StaleGeneration } from "../infra/lifecycle/errors.ts";
import type { RoomContext, Services } from "./context.ts";
import type { CardDirectives } from "./prompt/snapshot.ts";

/** A character's persona (the card's description and personality), in code points. */
export const MAX_PERSONA_CHARS = 20_000;

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export type CardImportRefusalCode =
  /** The room moved to another generation (undo, reset, import) since the writer was made. */
  | "stale_writer"
  /** The card's lorebook holds more entries than one import takes (`MAX_IMPORT_ENTRIES`). */
  | "too_many_entries"
  /** The room would hold more than `MAX_ROOM_LORE_ENTRIES` lore entries. */
  | "lore_full"
  /** An entry the lore type refuses (`path`: `entries.<index>.<field>`, `detail`: its title). */
  | "entry_invalid"
  /** The card's name is longer than `MAX_WORLD_NAME_CHARS`. */
  | "name_too_long"
  /** A prose field is longer than `MAX_WORLD_PROSE_CHARS` (`path`: the field). */
  | "prose_too_long"
  /** A prepared directive is longer than `MAX_DIRECTIVE_CHARS` (`path`: `head` / `postHistory`). */
  | "directive_too_long"
  /** More than `MAX_ALTERNATE_GREETINGS` alternate greetings. */
  | "too_many_openings"
  /** An opening is longer than `MAX_OPENING_CHARS` (`path`: `opening` / `alternates.<index>`). */
  | "opening_too_long"
  /** The variable tree, seeded, would break the tree's bounds (`detail`: the tree problem). */
  | "variables_too_large"
  /** The room cannot declare another module variable (`detail`: the variable id). */
  | "module_variables_full"
  /** A character import with no member to own and play the character. */
  | "no_member"
  /** A character import into a room without a rule system. */
  | "no_rule_system"
  /** No usable character name: blank, or longer than `MAX_CHARACTER_NAME_CHARS`. */
  | "bad_name"
  /** A character with that name is already in the room (`detail`: the name). */
  | "name_taken"
  /** The persona is longer than `MAX_PERSONA_CHARS`. */
  | "persona_too_long"
  /** The character layer refused the sheet (`detail`: its code). */
  | "sheet_refused"
  /** The seating refused the seat (`detail`: its code). */
  | "seat_refused"
  /** A document type refused a write the checks above let through (`detail`: the type). */
  | "document_refused";

export interface CardImportRefusal {
  readonly ok: false;
  readonly code: CardImportRefusalCode;
  readonly path?: string;
  readonly detail?: string;
}

function refusal(code: CardImportRefusalCode, extra: { path?: string; detail?: string } = {}): CardImportRefusal {
  return { ok: false, code, ...extra };
}

/** A lore entry to embed for recall: what `indexLoreEntries` (`agent/recall.ts`) takes. */
export interface LoreToIndex {
  readonly id: string;
  readonly title: string;
  readonly content: string;
}

export interface WorldImported {
  readonly ok: true;
  /** `world_imported` for a card new to the room, `world_reimported` when it replaced itself. */
  readonly code: "world_imported" | "world_reimported";
  /** The `world_card` document id (also the lore entries' source). */
  readonly cardId: string;
  readonly name: string;
  /** Other world cards the room already holds (a stacked import when > 0). */
  readonly otherWorlds: number;
  readonly lore: {
    readonly written: number;
    /** Entries of an earlier import of this card that were replaced. */
    readonly replaced: number;
    /** Titles left out for exceeding the entry length bound. */
    readonly skippedTooLong: readonly string[];
    /** Titles stored disabled AND keyless: nothing can fire them until the admin binds them. */
    readonly unreachable: readonly string[];
    /** Secret (keeper-only) entries among those written. */
    readonly secret: number;
    /**
     * Entries the lore importer took for variable declarations (a title with `initvar`
     * but without the `[InitVar]` brackets the card split looks for): neither lore nor
     * read into the tree.
     */
    readonly declarationLike: number;
  };
  readonly variables: {
    /** Declaration entries the card carried, and how many of them could not be read. */
    readonly declarations: number;
    readonly unreadable: number;
    /** Top-level keys the tree gained (a key the room already had keeps its value). */
    readonly keysAdded: number;
    /** Typed module variables a native bundle declared. */
    readonly moduleVariables: number;
  };
  readonly directives: { readonly headChars: number; readonly postHistoryChars: number };
  readonly openings: number;
  readonly warnings: readonly SplitWarning[];
  /** What the card carries that 3.0 does not import (and why), by count. */
  readonly notImported: readonly LeftBehind[];
  /** The new lore entries, to embed for recall after the commit. */
  readonly index: readonly LoreToIndex[];
  /** The ids of the replaced entries, to drop from the recall index (`forgetItems`). */
  readonly forget: readonly string[];
}

export type LeftBehindPart =
  | "variable_declarations"
  | "templates"
  | "secret_entries"
  | "lore_entries"
  | "hooks"
  | "module_variables"
  | "directives"
  | "openings"
  | "scenario"
  | "pregens";

export type LeftBehindReason =
  /** World machinery: reaches a room only through the admin's world import. */
  | "world_machinery"
  /** Keeper-only text a player file may not mint. */
  | "keeper_only"
  /** Standing prompt text: only a world import keeps it. */
  | "world_only"
  /** 3.0 has no such feature (hook scripts), or not yet (a bundle's pregenerated cast). */
  | "unsupported";

export interface LeftBehind {
  readonly part: LeftBehindPart;
  readonly count: number;
  readonly reason: LeftBehindReason;
}

export interface CharacterImported {
  readonly ok: true;
  readonly code: "character_imported";
  readonly characterId: string;
  readonly name: string;
  readonly pack: string;
  /** The character the member played before (now unseated), or null. */
  readonly previous: string | null;
  /** Whether the card was a world card (its world half is waiting for a world import). */
  readonly worldCard: boolean;
  /** Everything of the card that did not come along, by count, with the reason. */
  readonly stripped: readonly LeftBehind[];
  readonly warnings: readonly SplitWarning[];
}

export type WorldImportResult = WorldImported | CardImportRefusal;
export type CharacterImportResult = CharacterImported | CardImportRefusal;

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

/** sha-256 of the parsed card: the same file always gives the same hash. */
function cardHash(card: ImportedCard): string {
  return createHash("sha256").update(JSON.stringify(card)).digest("hex");
}

/**
 * Run `body` (the writes) in one transaction; null when it committed. A stale writer or a document refusal rolls
 * everything back and comes back as a refusal; anything else is a defect and propagates.
 */
function commit(context: RoomContext, body: () => void): CardImportRefusal | null {
  try {
    context.services.store.transaction(body);
    return null;
  } catch (error) {
    if (error instanceof StaleGeneration) return refusal("stale_writer");
    if (error instanceof DocumentRefused) return refusal("document_refused", { detail: error.type });
    throw error;
  }
}

function nonZero(parts: readonly LeftBehind[]): LeftBehind[] {
  return parts.filter((part) => part.count > 0);
}

// ---------------------------------------------------------------------------
// The world import
// ---------------------------------------------------------------------------

export interface WorldImportOptions {
  /** Recorded as the importer; defaults to the context's member (null when none). */
  readonly importedBy?: string | null;
}

/** The card's prose and openings as a `WorldCard`, or the bound it breaks. */
function worldCardOf(card: ImportedCard, split: CardSplit, importedBy: string | null, now: number): WorldCard | CardImportRefusal {
  const source = card.card;
  const name = source.name;
  if (codePoints(name) > MAX_WORLD_NAME_CHARS) return refusal("name_too_long");
  const prose = {
    description: source.description,
    personality: source.personality,
    scenario: source.scenario,
    examples: source.exampleMessages,
    creatorNotes: source.creatorNotes,
  };
  for (const [field, text] of Object.entries(prose)) {
    if (codePoints(text) > MAX_WORLD_PROSE_CHARS) return refusal("prose_too_long", { path: field });
  }
  const head = prepareDirective(split.world.systemPrompt, name);
  const postHistory = prepareDirective(split.world.postHistoryInstructions, name);
  if (codePoints(head) > MAX_DIRECTIVE_CHARS) return refusal("directive_too_long", { path: "head" });
  if (codePoints(postHistory) > MAX_DIRECTIVE_CHARS) return refusal("directive_too_long", { path: "postHistory" });
  if (codePoints(source.firstMessage) > MAX_OPENING_CHARS) return refusal("opening_too_long", { path: "opening" });
  if (source.alternateGreetings.length > MAX_ALTERNATE_GREETINGS) return refusal("too_many_openings");
  const long = source.alternateGreetings.findIndex((greeting) => codePoints(greeting) > MAX_OPENING_CHARS);
  if (long >= 0) return refusal("opening_too_long", { path: `alternates.${long}` });
  return {
    name,
    ...prose,
    head,
    postHistory,
    opening: source.firstMessage,
    alternates: [...source.alternateGreetings],
    provenance: { hash: cardHash(card), importedAt: now, importedBy, format: card.source },
  };
}

/**
 * Import `card` as the room's world (the admin's action). Synchronous; every write in one
 * transaction through `context.writer`. See the file header for what lands where and what
 * a second import does.
 */
export function importWorld(context: RoomContext, card: ImportedCard, options: WorldImportOptions = {}): WorldImportResult {
  if (!context.writer.current()) return refusal("stale_writer");
  const { services, room } = context;
  const documents = services.documents;
  const split = splitCard(card);
  const importedBy = options.importedBy !== undefined ? options.importedBy : (context.who.member?.id ?? null);
  const world = worldCardOf(card, split, importedBy, services.clock.now());
  if ("ok" in world) return world;
  const validation = validateWorldCard(worldCardData(world));
  if (validation.length > 0) return refusal("document_refused", { detail: WORLD_CARD_TYPE, path: (validation[0] as { path: string }).path });
  const cardId = worldCardId(world.name);

  // Lore: the ORIGINAL entries (declarations taken out by the split), at keeper trust.
  const lore = importLorebook(split.world.entries, { trust: "keeper", source: cardId, charName: world.name });
  if (!lore.ok) return refusal("too_many_entries");
  const prepared: { id: string; data: JsonObject; meta: JsonObject; title: string; content: string; secret: boolean }[] = [];
  for (const [index, entry] of lore.entries.entries()) {
    const { data, meta } = loreEntryDocument(entry);
    const problem = validateLoreEntry(data)[0];
    if (problem !== undefined) return refusal("entry_invalid", { path: `entries.${index}.${problem.path}`, detail: entry.title });
    prepared.push({ id: "", data, meta, title: entry.title, content: entry.content, secret: entry.secret });
  }
  const existingLore = documents.list(room, LORE_ENTRY_TYPE);
  const replacedIds = existingLore.filter((document) => loreSource(document) === cardId).map((document) => document.id);
  if (existingLore.length - replacedIds.length + prepared.length > MAX_ROOM_LORE_ENTRIES) return refusal("lore_full");

  // The variable tree, seeded the MagVarUpdate way.
  const treeDocument = documents.get(room, VARIABLE_TREE_TYPE, VARIABLE_TREE_ID);
  let treeData: JsonObject | null = null;
  let keysAdded = 0;
  const declared = split.world.variables;
  if (declared !== null) {
    const stored = treeDocument === null ? { tree: new Map(), exposed: [] as readonly string[] } : readVariableTree(treeDocument.data);
    for (const key of declared.keys()) if (!stored.tree.has(key)) keysAdded += 1;
    const seeded = seedTree(stored.tree, declared);
    const problem = treeProblem(seeded.tree);
    if (problem !== null) return refusal("variables_too_large", { detail: problem });
    if (seeded.changed || treeDocument === null) {
      treeData = variableTreeData(seeded.tree, stored.exposed);
      if ((variableTreeDocument.validate?.(treeData) ?? []).length > 0) return refusal("variables_too_large", { detail: "bad_tree" });
    }
  }

  // A native bundle's typed variables.
  let moduleData: JsonObject | null = null;
  const specs = split.world.moduleVariables;
  if (specs.length > 0) {
    const stored = documents.get(room, MODULE_VARIABLES_TYPE, MODULE_VARIABLES_ID);
    let state = stored === null ? EMPTY_MODULE_VARIABLES : normalizeModuleVariables(stored.data);
    for (const spec of specs) {
      const write = defineVariable(state, spec);
      if (write.outcome.status === "refused") return refusal("module_variables_full", { detail: spec.id });
      state = write.state;
    }
    moduleData = moduleVariablesPayload(state);
    if ((moduleVariablesDocument.validate?.(moduleData) ?? []).length > 0) return refusal("document_refused", { detail: MODULE_VARIABLES_TYPE });
  }

  const previous = documents.get(room, WORLD_CARD_TYPE, cardId);
  const otherWorlds = documents.list(room, WORLD_CARD_TYPE).filter((document) => document.id !== cardId).length;
  for (const entry of prepared) entry.id = `lore-${services.clock.id()}`;

  const committed = commit(context, () => {
    for (const id of replacedIds) documents.delete(context.writer, LORE_ENTRY_TYPE, id);
    for (const entry of prepared) documents.put(context.writer, LORE_ENTRY_TYPE, entry.id, entry.data, entry.meta);
    // The room's switches outlive a re-import: the new entries take them in the same commit,
    // so an entry the admin turned off is never shown to players for even one turn.
    const overlayDocument = documents.get(room, LORE_OVERLAY_TYPE, LORE_OVERLAY_ID);
    syncLoreSwitches(documents, context.writer, overlayDocument === null || overlayDocument.corrupt ? EMPTY_OVERLAY : readOverlay(overlayDocument.data));
    if (treeData !== null) documents.put(context.writer, VARIABLE_TREE_TYPE, VARIABLE_TREE_ID, treeData);
    if (moduleData !== null) documents.put(context.writer, MODULE_VARIABLES_TYPE, MODULE_VARIABLES_ID, moduleData);
    documents.put(context.writer, WORLD_CARD_TYPE, cardId, worldCardData(world), { source: cardId });
  });
  if (committed !== null) return committed;

  const machinery = split.machinery;
  return {
    ok: true,
    code: previous === null ? "world_imported" : "world_reimported",
    cardId,
    name: world.name,
    otherWorlds,
    lore: {
      written: prepared.length,
      replaced: replacedIds.length,
      skippedTooLong: lore.skippedTitles,
      unreachable: lore.unreachableTitles,
      secret: prepared.filter((entry) => entry.secret).length,
      declarationLike: lore.declarations.length,
    },
    variables: {
      declarations: machinery.variableDeclarations,
      unreadable: split.world.declarations.filter((parsed) => !parsed.ok).length,
      keysAdded,
      moduleVariables: specs.length,
    },
    directives: { headChars: codePoints(world.head), postHistoryChars: codePoints(world.postHistory) },
    openings: openingCount(world),
    warnings: split.warnings,
    notImported: nonZero([
      { part: "hooks", count: machinery.unsupportedHooks, reason: "unsupported" },
      { part: "pregens", count: split.world.pregens.length, reason: "unsupported" },
    ]),
    index: prepared.map((entry) => ({ id: entry.id, title: entry.title, content: entry.content })),
    forget: replacedIds,
  };
}

// ---------------------------------------------------------------------------
// The character import
// ---------------------------------------------------------------------------

export interface CharacterImportOptions {
  /** A name to use instead of the card's. */
  readonly name?: string;
  /** The rule pack to build the sheet for; defaults to the room's (`context.pack`). */
  readonly pack?: RulePack;
  /**
   * The concept the authoring lane read from the persona (`agent/lanes/genchar.ts`), already
   * reviewed by the caller; absent or null, the sheet is rolled without one.
   */
  readonly concept?: CharacterConcept | null;
}

/** What a character import leaves behind of `split`, with the reason for each part. */
function strippedParts(split: CardSplit): LeftBehind[] {
  const machinery: CardMachinery = split.machinery;
  const card = split.character;
  // The kept lore of the character half: the plain entries a player file could have put
  // in the room. 3.0 writes none of them (see the file header).
  const plainEntries = card.book.length;
  const greetings = (card.firstMessage.trim() === "" ? 0 : 1) + card.alternateGreetings.length;
  return nonZero([
    { part: "variable_declarations", count: machinery.variableDeclarations, reason: "world_machinery" },
    { part: "templates", count: machinery.templateSpans, reason: "world_machinery" },
    { part: "module_variables", count: machinery.moduleVariables, reason: "world_machinery" },
    { part: "hooks", count: machinery.unsupportedHooks, reason: "unsupported" },
    { part: "secret_entries", count: machinery.secretEntries, reason: "keeper_only" },
    { part: "directives", count: machinery.directives, reason: "world_only" },
    { part: "lore_entries", count: plainEntries, reason: "world_only" },
    { part: "openings", count: greetings, reason: "world_only" },
    { part: "scenario", count: card.scenario.trim() === "" ? 0 : 1, reason: "world_only" },
    { part: "pregens", count: split.world.pregens.length, reason: "world_machinery" },
  ]);
}

/** The persona a character carries: the character half's description and personality, `{{char}}` bound to `name`. */
function personaParts(split: CardSplit, name: string): ConceptPersona {
  const card = split.character;
  return { description: bindCharName(card.description.trim(), name), personality: bindCharName(card.personality.trim(), name) };
}

function personaOf(split: CardSplit, name: string): string {
  const parts = personaParts(split, name);
  return [parts.description, parts.personality].filter((part) => part !== "").join("\n\n");
}

/** What a character import of a card shows the authoring lane. */
export interface CharacterPersona {
  readonly name: string;
  readonly description: string;
  readonly personality: string;
  readonly tags: readonly string[];
}

/**
 * The character half's persona as a character import reads it — only the character half
 * (the card split): its name (or `name`), description and personality with `{{char}}`
 * bound, and its tags. Null when the import would refuse the name or the persona anyway.
 */
export function characterPersona(card: ImportedCard, name?: string): CharacterPersona | null {
  const split = splitCard(card);
  const chosen = (name ?? split.character.name).trim();
  if (chosen === "" || codePoints(chosen) > MAX_CHARACTER_NAME_CHARS) return null;
  if (codePoints(personaOf(split, chosen)) > MAX_PERSONA_CHARS) return null;
  return { name: chosen, ...personaParts(split, chosen), tags: split.character.tags };
}

/**
 * Import `card` as a character for the context's member: a character document with a
 * rolled sheet (biased toward `options.concept`), the persona as its background, owned by the member and
 * seated for them (giving up whatever they played — the reference server made an imported
 * card the player's active character). Reads the character half of the split only.
 */
export function importCharacter(context: RoomContext, card: ImportedCard, options: CharacterImportOptions = {}): CharacterImportResult {
  if (!context.writer.current()) return refusal("stale_writer");
  const { services, room } = context;
  const documents = services.documents;
  const member = context.who.member;
  if (member === null) return refusal("no_member");
  const pack = options.pack ?? context.pack;
  if (pack === null) return refusal("no_rule_system");

  const split = splitCard(card);
  const name = (options.name ?? split.character.name).trim();
  if (name === "" || codePoints(name) > MAX_CHARACTER_NAME_CHARS) return refusal("bad_name");
  const folded = name.toLowerCase();
  for (const document of documents.list(room, CHARACTER_TYPE)) {
    const sheet = document.data.sheet;
    const existing = typeof sheet === "object" && sheet !== null && !Array.isArray(sheet) ? (sheet as JsonObject).name : undefined;
    if (typeof existing === "string" && existing.trim().toLowerCase() === folded) return refusal("name_taken", { detail: name });
  }
  const persona = personaOf(split, name);
  if (codePoints(persona) > MAX_PERSONA_CHARS) return refusal("persona_too_long");

  // Rolled as a new character is, biased toward the concept when the lane read one (the
  // reference's `build_sheet_from_persona`), the persona as its background or notes.
  const made = conceptCharacterSheet(pack.sheet, pack.source, context.random, { name, system: pack.id, persona: personaParts(split, name), concept: options.concept ?? null });
  const created = createCharacter(pack.sheet, made.sheet, { owner: member.id, creationMethod: made.method });
  if (!created.ok) return refusal("sheet_refused", { detail: created.code });

  const seatingDocument = documents.get(room, SEATING_TYPE, SEATING_ID);
  const seating = seatingDocument === null ? EMPTY_SEATING : (readSeating(seatingDocument.data) ?? EMPTY_SEATING);
  const previous = characterOf(seating, member.id);
  const id = `ch-${services.clock.id()}`;
  const seated = switchCharacter(seating, member.id, id, member.name);
  if (!seated.ok) return refusal("seat_refused", { detail: seated.code });

  const committed = commit(context, () => {
    documents.put(context.writer, CHARACTER_TYPE, id, characterData(created.data), { source: "card" });
    documents.put(context.writer, SEATING_TYPE, SEATING_ID, seatingData(seated.data));
  });
  if (committed !== null) return committed;
  return {
    ok: true,
    code: "character_imported",
    characterId: id,
    name: created.data.sheet.name,
    pack: pack.id,
    previous,
    worldCard: split.kind === "world",
    stripped: strippedParts(split),
    warnings: split.warnings,
  };
}

// ---------------------------------------------------------------------------
// Readers for the turn engine
// ---------------------------------------------------------------------------

export interface WorldCardReading {
  /** The prompt assembler's `cardDirectives`: null when no world card carries any. */
  readonly cardDirectives: CardDirectives | null;
  /** The prompt assembler's `worldImported`: whether any world card was imported. */
  readonly worldImported: boolean;
}

/**
 * What the Keeper's prompt takes from the room's world cards: every card's head text
 * joined (verbatim — bound at import, so the cached head stays byte-stable), every card's
 * post-history text joined and run through the per-turn macro pass, in import order.
 * `macros` is the same context the turn's lore assembly uses: the speaking member's
 * character as `{{user}}`, the Keeper-grade variables for `{{getvar}}`, the game clock,
 * the turn's dice and randomness — the reference server's pass on this text. `{{char}}`
 * was already bound at import; with several cards, a remaining one resolves to whatever
 * `macros.names.char` says.
 */
export function readWorldCard(services: Pick<Services, "documents">, room: string, macros: MacroContext): WorldCardReading {
  const documents = services.documents.list(room, WORLD_CARD_TYPE);
  const heads: string[] = [];
  const posts: string[] = [];
  for (const document of documents) {
    const card = readWorldCardDocument(document);
    if (card === null) continue;
    if (card.head !== "") heads.push(card.head);
    if (card.postHistory !== "") posts.push(card.postHistory);
  }
  // An unreadable world card still says a world was imported here.
  const worldImported = documents.length > 0;
  if (heads.length === 0 && posts.length === 0) return { cardDirectives: null, worldImported };
  const postHistory = posts.length === 0 ? "" : substituteMacros(posts.join("\n\n"), macros);
  return { cardDirectives: { head: heads.join("\n\n"), postHistory }, worldImported };
}

export interface WorldOpening {
  readonly cardId: string;
  readonly name: string;
  /** The first message ("" when the card has none but offers alternates). */
  readonly opening: string;
  readonly alternates: readonly string[];
}

/**
 * The room's opening: the first world card, in import order, that offers one. As the
 * author wrote it — template code and macros included; the caller renders it the way
 * lore is rendered before it is spoken, and what is spoken becomes an event. Null when
 * no world card offers an opening.
 */
export function readOpening(services: Pick<Services, "documents">, room: string): WorldOpening | null {
  for (const document of services.documents.list(room, WORLD_CARD_TYPE)) {
    const card = readWorldCardDocument(document);
    if (card === null || openingCount(card) === 0) continue;
    return { cardId: document.id, name: card.name, opening: card.opening, alternates: [...card.alternates] };
  }
  return null;
}
