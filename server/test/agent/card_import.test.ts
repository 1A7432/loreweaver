import { describe, expect, test } from "bun:test";
import type { Who } from "loreweaver/module";

import { importCharacter, importWorld, MAX_PERSONA_CHARS, readOpening, readWorldCard } from "../../src/agent/card_import.ts";
import type { RoomContext, Services } from "../../src/agent/context.ts";
import { LORECARD_FORMAT, MAX_ALTERNATE_GREETINGS, parseCard, worldCardDocumentType, WORLD_CARD_TYPE, type ImportedCard } from "../../src/core/card/index.ts";
import {
  CHARACTER_TYPE,
  characterDocumentType,
  claimableDocument,
  readSeating,
  seatingDocument,
  SEATING_ID,
  SEATING_TYPE,
} from "../../src/core/characters/index.ts";
import { DocumentTypes, KEEPER, type JsonObject } from "../../src/core/documents/model.ts";
import { documentCatalog, RawDocuments } from "../../src/core/documents/raw.ts";
import { DocumentViews } from "../../src/core/documents/views.ts";
import { LORE_ENTRY_TYPE, loreEntryDocumentType, loreOverlayDocumentType, loreTimersDocumentType, MAX_ROOM_LORE_ENTRIES } from "../../src/core/lore/index.ts";
import { SeededRandom } from "../../src/core/random.ts";
import { builtInPacks, RulePackRegistry } from "../../src/core/rulepacks/index.ts";
import type { SheetSpec } from "../../src/core/sheets/index.ts";
import {
  decodeTree,
  MODULE_VARIABLES_TYPE,
  moduleVariablesDocument,
  toJson,
  VARIABLE_TREE_ID,
  VARIABLE_TREE_TYPE,
  variableTreeData,
  variableTreeDocument,
  fromPlain,
  type VarMap,
} from "../../src/core/variables/index.ts";
import { MAX_CONDITION_CHARS, MAX_IMPORT_ENTRIES, MAX_TITLE_CHARS } from "../../src/core/worldbook/index.ts";
import { ScriptedLLM } from "../../src/infra/llm/index.ts";
import { openDatabase } from "../../src/infra/runtime/sqlite.ts";
import { type RoomWriter, Store } from "../../src/infra/store.ts";
import { testClock } from "../helpers.ts";

const ROOM = "card-room";
const ADA: Who = { member: { id: "m-ada", name: "Ada", role: "player" }, character: null };
const ADMIN: Who = { member: { id: "m-admin", name: "Root", role: "admin" }, character: null };

interface Room {
  readonly store: Store;
  readonly services: Services;
  readonly packs: RulePackRegistry;
  context(who?: Who, writer?: RoomWriter): RoomContext;
  rows(): string;
}

function room(): Room {
  const store = new Store(openDatabase(":memory:"));
  const packs = new RulePackRegistry(builtInPacks());
  const specFor = (id: string): SheetSpec | null => packs.get(id)?.sheet ?? null;
  const types = new DocumentTypes();
  for (const type of [
    loreEntryDocumentType,
    loreOverlayDocumentType,
    loreTimersDocumentType,
    variableTreeDocument,
    moduleVariablesDocument,
    worldCardDocumentType,
    characterDocumentType(specFor),
    seatingDocument,
    claimableDocument,
  ]) {
    types.register(type as Parameters<DocumentTypes["register"]>[0]);
  }
  const llm = new ScriptedLLM([]);
  const services: Services = {
    store,
    types,
    documents: new RawDocuments(store, types),
    views: new DocumentViews(store, types),
    packs,
    models: { keeper: llm, npc: llm, scribe: llm, director: llm, memory: llm },
    clock: testClock(),
    report: () => {},
  };
  return {
    store,
    services,
    packs,
    context(who = ADMIN, writer = store.beginTurn(ROOM)) {
      return {
        services,
        room: ROOM,
        turn: writer.turn,
        writer,
        locale: "en",
        pack: packs.get("coc7"),
        variant: null,
        who,
        random: new SeededRandom("cards"),
      };
    },
    rows: () => JSON.stringify(store.docList(ROOM)),
  };
}

function cardOf(raw: unknown, filename = "card.json"): ImportedCard {
  return parseCard(new TextEncoder().encode(JSON.stringify(raw)), filename);
}

// A distinctive marker in every machinery field: none may survive a character import.
const MK = {
  plainLore: "MK-PLAINLORE",
  secret: "MK-SECRET",
  initvar: "MK_INITVAR",
  ejsDescription: "MK-EJSDESC",
  ejsEntry: "MK-EJSENTRY",
  system: "MK-SYSTEM",
  post: "MK-POSTHIST",
  hook: "MK-HOOK",
  scenario: "MK-SCENARIO",
  greeting: "MK-GREETING",
  alternate: "MK-ALTERNATE",
} as const;

function stuffedRaw(name = "Mira"): JsonObject {
  return {
    spec: "chara_card_v2",
    spec_version: "2.0",
    data: {
      name,
      description: `A wandering cartographer.<% var s = "${MK.ejsDescription}"; %>`,
      personality: "Curious and stubborn.",
      scenario: `${MK.scenario}: the drowned city`,
      first_mes: `${MK.greeting} — {{user}} meets {{char}}.`,
      alternate_greetings: [`${MK.alternate} at dawn`],
      system_prompt: `${MK.system} You are {{char}}. {{original}}`,
      post_history_instructions: `${MK.post} Keep {{user}} in view. {{// note}} Roll {{roll:1}}.`,
      tags: ["explorer"],
      character_book: {
        entries: [
          { keys: ["harbor"], content: `${MK.plainLore} The harbor is older than the city.`, comment: "Harbor" },
          { keys: ["vault"], content: `${MK.secret} The vault key is under the altar.`, comment: "Vault", secret: true },
          { keys: [], content: `\`\`\`yaml\n${MK.initvar}:\n  depth: 3\n\`\`\``, comment: "[InitVar] state" },
          { keys: ["gate"], content: `<%= "${MK.ejsEntry}" %> The gate is sealed.`, comment: "Gate" },
        ],
      },
      extensions: { loreweaver_hooks: [{ event: "turn_start", code: `/* ${MK.hook} */ return null;` }] },
    },
  };
}

function plainRaw(name: string, extra: Record<string, unknown> = {}): JsonObject {
  return { spec: "chara_card_v2", spec_version: "2.0", data: { name, description: `${name} is a sailor.`, personality: "Calm.", ...extra } } as JsonObject;
}

function treeOf(r: Room): unknown {
  const document = r.services.documents.get(ROOM, VARIABLE_TREE_TYPE, VARIABLE_TREE_ID);
  if (document === null) return null;
  return toJson(decodeTree(document.data.tree as string) as VarMap);
}

describe("importWorld", () => {
  test("writes the lore, seeds the variables, keeps the directives and the opening, marks the room", () => {
    const r = room();
    const result = importWorld(r.context(), cardOf(stuffedRaw()));
    if (!result.ok) throw new Error(result.code);
    expect(result.code).toBe("world_imported");
    expect(result.cardId).toBe("card:Mira");
    expect(result.lore).toMatchObject({ written: 3, replaced: 0, secret: 1 });
    expect(result.variables).toMatchObject({ declarations: 1, unreadable: 0, keysAdded: 1, moduleVariables: 0 });
    expect(result.openings).toBe(2);
    expect(result.warnings).toEqual([{ code: "hooks_unsupported", count: 1 }]);
    expect(result.notImported).toEqual([{ part: "hooks", count: 1, reason: "unsupported" }]);

    const lore = r.services.documents.list(ROOM, LORE_ENTRY_TYPE);
    expect(lore.map((document) => document.data.title)).toEqual(["Harbor", "Vault", "Gate"]);
    expect(lore.every((document) => document.meta.source === "card:Mira")).toBe(true);
    // Render-time templates in world lore are what this path exists to carry.
    expect(lore[2]?.data.content).toContain(MK.ejsEntry);
    expect(lore[1]?.data.secret).toBe(true);
    expect(treeOf(r)).toEqual({ [MK.initvar]: { depth: 3 } });

    const card = r.services.documents.get(ROOM, WORLD_CARD_TYPE, "card:Mira");
    expect(card?.data.head).toBe(`${MK.system} You are Mira.`);
    expect(card?.data.postHistory).toBe(`${MK.post} Keep {{user}} in view.  Roll {{roll:1}}.`);
    expect(card?.data.opening).toBe(`${MK.greeting} — {{user}} meets {{char}}.`);
    expect(card?.data.alternates).toEqual([`${MK.alternate} at dawn`]);
    expect(card?.data.provenance).toMatchObject({ importedBy: "m-admin", format: "sillytavern" });
    expect((card?.data.provenance as JsonObject).hash).toMatch(/^[0-9a-f]{64}$/u);

    // The recall hook: the new entries, by id, title and content.
    expect(result.index.map((entry) => entry.id)).toEqual(lore.map((document) => document.id));
    expect(result.index[0]).toEqual({ id: lore[0]?.id as string, title: "Harbor", content: lore[0]?.data.content as string });
    expect(result.forget).toEqual([]);
  });

  test("a native bundle's typed variables become module variables", () => {
    const r = room();
    const bundle = {
      format: LORECARD_FORMAT,
      format_version: 1,
      name: "Bundle",
      variables: [{ id: "alarm", kind: "number", labels: { en: "Alarm" }, minimum: 0, maximum: 5, default: 1 }],
      pregens: [{ name: "Pip", blurb: "a deckhand" }],
    };
    const imported = cardOf(bundle);
    expect(imported.source).toBe("lorecard");
    const result = importWorld(r.context(), imported);
    if (!result.ok) throw new Error(result.code);
    expect(result.variables.moduleVariables).toBe(1);
    expect(result.notImported).toEqual([{ part: "pregens", count: 1, reason: "unsupported" }]);
    const stored = r.services.documents.get(ROOM, MODULE_VARIABLES_TYPE, "variables");
    expect(JSON.stringify(stored?.data)).toContain("alarm");
  });

  test("a second import of the same card replaces it; the room's variable values win", () => {
    const r = room();
    const first = importWorld(r.context(), cardOf(stuffedRaw()));
    if (!first.ok) throw new Error(first.code);
    // Play moved the variable on, and the admin exposed it.
    const writer = r.store.beginTurn(ROOM);
    r.services.documents.put(writer, VARIABLE_TREE_TYPE, VARIABLE_TREE_ID, variableTreeData(fromPlain({ [MK.initvar]: { depth: 9 } }) as VarMap, [MK.initvar]));

    const second = importWorld(r.context(), cardOf(stuffedRaw()));
    if (!second.ok) throw new Error(second.code);
    expect(second.code).toBe("world_reimported");
    expect(second.otherWorlds).toBe(0);
    expect(second.lore.replaced).toBe(3);
    expect(second.forget).toEqual(first.index.map((entry) => entry.id));
    expect(second.variables.keysAdded).toBe(0);
    expect(r.services.documents.list(ROOM, LORE_ENTRY_TYPE)).toHaveLength(3);
    expect(r.services.documents.list(ROOM, WORLD_CARD_TYPE)).toHaveLength(1);
    expect(treeOf(r)).toEqual({ [MK.initvar]: { depth: 9 } });
    expect(r.services.documents.get(ROOM, VARIABLE_TREE_TYPE, VARIABLE_TREE_ID)?.data.exposed).toEqual([MK.initvar]);
  });

  test("a different card stacks beside the first", () => {
    const r = room();
    importWorld(r.context(), cardOf(stuffedRaw()));
    const addon = plainRaw("Addon", {
      system_prompt: "Second head.",
      character_book: { entries: [{ keys: ["reef"], content: "The reef.", comment: "Reef" }, { keys: [], content: "x: 1", comment: "[InitVar] more" }] },
    });
    const result = importWorld(r.context(), cardOf(addon));
    if (!result.ok) throw new Error(result.code);
    expect(result.code).toBe("world_imported");
    expect(result.otherWorlds).toBe(1);
    expect(r.services.documents.list(ROOM, LORE_ENTRY_TYPE)).toHaveLength(4);
    expect(treeOf(r)).toEqual({ x: 1, [MK.initvar]: { depth: 3 } });
    const reading = readWorldCard(r.services, ROOM, {});
    expect(reading.cardDirectives?.head).toBe(`${MK.system} You are Mira.\n\nSecond head.`);
  });

  test("caps refuse the whole import, writing nothing", () => {
    const r = room();
    const before = r.rows();
    const tooMany = plainRaw("Big", { character_book: { entries: Array.from({ length: MAX_IMPORT_ENTRIES + 1 }, (_, i) => ({ keys: [`k${i}`], content: `c${i}`, comment: `e${i}` })) } });
    expect(importWorld(r.context(), cardOf(tooMany))).toMatchObject({ ok: false, code: "too_many_entries" });
    const greetings = plainRaw("Chatty", { alternate_greetings: Array.from({ length: MAX_ALTERNATE_GREETINGS + 1 }, () => "hi") });
    expect(importWorld(r.context(), cardOf(greetings))).toMatchObject({ ok: false, code: "too_many_openings" });
    expect(importWorld(r.context(), cardOf(plainRaw("名".repeat(201))))).toMatchObject({ ok: false, code: "name_too_long" });
    expect(r.rows()).toBe(before);
  });

  test("one entry over a bound is left out and counted; the rest of the card is imported", () => {
    // A long category once made the store refuse the whole import.
    const r = room();
    const card = plainRaw("Category", {
      character_book: {
        entries: [
          { keys: ["a"], content: "b", comment: "long", extensions: { category: "x".repeat(201) } },
          { keys: ["c"], content: "d", comment: "fine" },
        ],
      },
    });
    const imported = importWorld(r.context(), cardOf(card));
    if (!imported.ok) throw new Error(imported.code);
    expect(imported.lore.leftOut).toEqual([{ title: "long", reason: "category_too_long", field: "category" }]);
    expect(r.services.documents.list(ROOM, LORE_ENTRY_TYPE).map((document) => document.data.title)).toEqual(["fine"]);
  });

  test("a room that would hold too many lore entries refuses", () => {
    const r = room();
    const per = MAX_IMPORT_ENTRIES;
    let index = 0;
    while (r.services.documents.list(ROOM, LORE_ENTRY_TYPE).length + per <= MAX_ROOM_LORE_ENTRIES) {
      const batch = plainRaw(`Book ${index}`, { character_book: { entries: Array.from({ length: per }, (_, i) => ({ keys: [`k${i}`], content: `c${i}`, comment: `e${i}` })) } });
      const result = importWorld(r.context(), cardOf(batch));
      if (!result.ok) throw new Error(result.code);
      index += 1;
    }
    const before = r.rows();
    const last = plainRaw("Overflow", { character_book: { entries: Array.from({ length: per }, (_, i) => ({ keys: [`k${i}`], content: `c${i}`, comment: `e${i}` })) } });
    expect(importWorld(r.context(), cardOf(last))).toMatchObject({ ok: false, code: "lore_full" });
    expect(r.rows()).toBe(before);
  });
});

describe("importWorld: what a card's entries say is read one way, and nothing is dropped unsaid", () => {
  function entriesCard(entries: unknown[]): ImportedCard {
    return cardOf({ spec: "chara_card_v2", spec_version: "2.0", data: { name: "Isle", description: "An isle.", character_book: { entries } } });
  }

  test("top-level secret: true is stored secret whatever extensions.secret says; secret: 1 is refused, counted with its title", () => {
    const r = room();
    const result = importWorld(
      r.context(),
      entriesCard([
        { comment: "truth", content: "x", keys: ["k"], secret: true, extensions: { secret: false } },
        { comment: "one", content: "y", keys: ["k"], secret: 1 },
      ]),
    );
    if (!result.ok) throw new Error(result.code);
    const lore = r.services.documents.list(ROOM, LORE_ENTRY_TYPE);
    expect(lore.map((document) => [document.data.title, document.data.secret])).toEqual([["truth", true]]);
    expect(result.lore).toMatchObject({ written: 1, secret: 1, leftOut: [{ title: "one", reason: "flag_not_boolean", field: "secret" }] });
    expect(result.warnings).toEqual([{ code: "secret_unreadable", count: 1 }]);
  });

  test("an entry titled `initvar notes` is lore: stored, not swallowed as a declaration", () => {
    const r = room();
    const result = importWorld(r.context(), entriesCard([{ comment: "initvar notes", content: "The island remembers.", keys: ["isle"] }]));
    if (!result.ok) throw new Error(result.code);
    expect(r.services.documents.list(ROOM, LORE_ENTRY_TYPE).map((document) => document.data.title)).toEqual(["initvar notes"]);
    expect(result.lore).toMatchObject({ written: 1, leftOut: [] });
    expect(result.variables.declarations).toBe(0);
  });

  test("an over-long condition, title or key leaves its entry out, counted with the reason; the rest imports whole", () => {
    const r = room();
    const condition = `a == 1 || ${"x".repeat(MAX_CONDITION_CHARS)} || b == 2`;
    const result = importWorld(
      r.context(),
      entriesCard([
        { comment: "gated", content: `@@if ${condition}\nThe gate opens.` },
        { comment: "t".repeat(MAX_TITLE_CHARS + 1), content: "x" },
        { comment: "keyed", content: "x", keys: ["k".repeat(201)] },
        { comment: "kept", content: "Fine.", keys: ["k"] },
      ]),
    );
    if (!result.ok) throw new Error(result.code);
    expect(r.services.documents.list(ROOM, LORE_ENTRY_TYPE).map((document) => document.data.title)).toEqual(["kept"]);
    expect(result.lore.leftOut.map((entry) => entry.reason)).toEqual(["condition_too_long", "title_too_long", "key_too_long"]);
    // No stored condition is a truncated one.
    expect(r.rows()).not.toContain("a == 1 ||");
  });

  test("a native bundle's skipped rows reach the result as card warnings", () => {
    const r = room();
    const bundle = { format: LORECARD_FORMAT, format_version: 1, name: "Bundle", worldbook: [{ title: "s", content: "x", secret: "false" }, { title: "ok", content: "y" }] };
    const result = importWorld(r.context(), cardOf(bundle, "b.lorecard.json"));
    if (!result.ok) throw new Error(result.code);
    expect(result.cardWarnings).toEqual([{ code: "flag_not_boolean", where: "worldbook[0].secret" }]);
    expect(r.services.documents.list(ROOM, LORE_ENTRY_TYPE).map((document) => [document.data.title, document.data.secret])).toEqual([["ok", false]]);
  });
});

describe("importCharacter", () => {
  test("a persona becomes a character with the pack's default sheet, seated for the importing player", () => {
    const r = room();
    const result = importCharacter(r.context(ADA), cardOf(plainRaw("Ned")));
    if (!result.ok) throw new Error(result.code);
    expect(result).toMatchObject({ code: "character_imported", name: "Ned", pack: "coc7", previous: null, worldCard: false });
    const stored = r.services.documents.get(ROOM, CHARACTER_TYPE, result.characterId);
    expect(stored?.data.owner).toBe("m-ada");
    expect((stored?.data.sheet as JsonObject).background).toBe("Ned is a sailor.\n\nCalm.");
    const seating = readSeating(r.services.documents.get(ROOM, SEATING_TYPE, SEATING_ID)?.data ?? {});
    expect(seating?.seats).toEqual([{ member: "m-ada", character: result.characterId, memberName: "Ada" }]);

    // A second import moves the player to the new character.
    const again = importCharacter(r.context(ADA), cardOf(plainRaw("Bo")));
    if (!again.ok) throw new Error(again.code);
    expect(again.previous).toBe(result.characterId);
  });

  test("THE SPLIT: a stuffed card imported as a character writes no lore, variable or directive", () => {
    const r = room();
    const writer = r.store.beginTurn(ROOM);
    r.services.documents.put(writer, VARIABLE_TREE_TYPE, VARIABLE_TREE_ID, variableTreeData(fromPlain({ existing: 1 }) as VarMap, []));
    const loreBefore = JSON.stringify(r.services.documents.list(ROOM, LORE_ENTRY_TYPE));
    const treeBefore = JSON.stringify(r.services.documents.get(ROOM, VARIABLE_TREE_TYPE, VARIABLE_TREE_ID));

    const result = importCharacter(r.context(ADA), cardOf(stuffedRaw()));
    if (!result.ok) throw new Error(result.code);
    expect(result.worldCard).toBe(true);
    expect(JSON.stringify(r.services.documents.list(ROOM, LORE_ENTRY_TYPE))).toBe(loreBefore);
    expect(JSON.stringify(r.services.documents.get(ROOM, VARIABLE_TREE_TYPE, VARIABLE_TREE_ID))).toBe(treeBefore);
    expect(r.services.documents.list(ROOM, WORLD_CARD_TYPE)).toEqual([]);
    expect(r.services.documents.list(ROOM, MODULE_VARIABLES_TYPE)).toEqual([]);
    expect(readWorldCard(r.services, ROOM, {})).toEqual({ cardDirectives: null, worldImported: false });

    const everything = r.rows();
    for (const mark of Object.values(MK)) expect(everything).not.toContain(mark);
    expect(everything).toContain("cartographer");

    const stripped = new Map(result.stripped.map((part) => [part.part, part]));
    expect(stripped.get("variable_declarations")).toEqual({ part: "variable_declarations", count: 1, reason: "world_machinery" });
    expect(stripped.get("templates")?.reason).toBe("world_machinery");
    expect(stripped.get("secret_entries")).toEqual({ part: "secret_entries", count: 1, reason: "keeper_only" });
    expect(stripped.get("hooks")).toEqual({ part: "hooks", count: 1, reason: "unsupported" });
    expect(stripped.get("directives")).toEqual({ part: "directives", count: 2, reason: "world_only" });
    expect(stripped.get("lore_entries")).toEqual({ part: "lore_entries", count: 2, reason: "world_only" });
    expect(stripped.get("openings")?.count).toBe(2);
    expect(stripped.get("scenario")?.count).toBe(1);
  });

  test("refusals", () => {
    const r = room();
    expect(importCharacter(r.context({ member: null, character: null }), cardOf(plainRaw("Ned")))).toMatchObject({ code: "no_member" });
    const noPack = { ...r.context(ADA), pack: null };
    expect(importCharacter(noPack, cardOf(plainRaw("Ned")))).toMatchObject({ code: "no_rule_system" });
    expect(importCharacter(r.context(ADA), cardOf(plainRaw("   ")))).toMatchObject({ code: "bad_name" });
    expect(importCharacter(r.context(ADA), cardOf(plainRaw("x".repeat(65))))).toMatchObject({ code: "bad_name" });
    expect(importCharacter(r.context(ADA), cardOf(plainRaw("Ned", { description: "y".repeat(MAX_PERSONA_CHARS + 1) })))).toMatchObject({ code: "persona_too_long" });
    const ok = importCharacter(r.context(ADA), cardOf(plainRaw("Ned")));
    expect(ok.ok).toBe(true);
    expect(importCharacter(r.context(ADMIN), cardOf(plainRaw("NED")))).toMatchObject({ code: "name_taken", detail: "NED" });
    const renamed = importCharacter(r.context(ADMIN), cardOf(plainRaw("Ned")), { name: "Edda" });
    expect(renamed).toMatchObject({ ok: true, name: "Edda" });
  });
});

describe("the room's lifecycle", () => {
  test("a stale writer is refused and writes nothing", () => {
    const r = room();
    const old = r.context(ADMIN);
    r.store.beginTurn(ROOM);
    r.store.undoTo(ROOM, 1);
    const before = r.rows();
    expect(importWorld(old, cardOf(stuffedRaw()))).toEqual({ ok: false, code: "stale_writer" });
    expect(importCharacter({ ...old, who: ADA }, cardOf(plainRaw("Ned")))).toEqual({ ok: false, code: "stale_writer" });
    expect(r.rows()).toBe(before);
  });

  test("undo of the import turn restores the room exactly", () => {
    const r = room();
    const writer = r.store.beginTurn(ROOM);
    r.services.documents.put(writer, VARIABLE_TREE_TYPE, VARIABLE_TREE_ID, variableTreeData(fromPlain({ kept: 1 }) as VarMap, []));
    importWorld(r.context(), cardOf(plainRaw("Older", { character_book: { entries: [{ keys: ["a"], content: "old", comment: "Old" }] } })));
    const before = r.rows();
    const turn = r.store.room(ROOM).turn;
    const world = importWorld(r.context(), cardOf(stuffedRaw()));
    const character = importCharacter(r.context(ADA), cardOf(plainRaw("Ned")));
    expect(world.ok && character.ok).toBe(true);
    expect(r.rows()).not.toBe(before);
    r.store.undoTo(ROOM, turn);
    expect(r.rows()).toBe(before);
  });

  test("reset scopes: the world survives story and chars, dies with all; characters die with chars", () => {
    for (const scope of ["story", "chars", "all"] as const) {
      const r = room();
      importWorld(r.context(), cardOf(stuffedRaw()));
      importCharacter(r.context(ADA), cardOf(plainRaw("Ned")));
      r.store.reset(ROOM, scope, documentCatalog(r.services.types));
      const worldLeft = r.services.documents.list(ROOM, WORLD_CARD_TYPE).length;
      const loreLeft = r.services.documents.list(ROOM, LORE_ENTRY_TYPE).length;
      const charactersLeft = r.services.documents.list(ROOM, CHARACTER_TYPE).length;
      expect([scope, worldLeft, loreLeft]).toEqual([scope, scope === "all" ? 0 : 1, scope === "all" ? 0 : 3]);
      expect([scope, charactersLeft]).toEqual([scope, scope === "story" ? 1 : 0]);
      expect(readWorldCard(r.services, ROOM, {}).worldImported).toBe(scope !== "all");
    }
  });
});

describe("readers", () => {
  test("readWorldCard: no world, then the directives with the post-history macros expanded per turn", () => {
    const r = room();
    expect(readWorldCard(r.services, ROOM, {})).toEqual({ cardDirectives: null, worldImported: false });
    importWorld(r.context(), cardOf(stuffedRaw()));
    const reading = readWorldCard(r.services, ROOM, { names: { user: "Ada", char: "Mira" }, roll: () => 1 });
    expect(reading).toEqual({
      worldImported: true,
      cardDirectives: { head: `${MK.system} You are Mira.`, postHistory: `${MK.post} Keep Ada in view.  Roll 1.` },
    });
  });

  test("a world card without directives still marks the room", () => {
    const r = room();
    importWorld(r.context(), cardOf(plainRaw("Quiet")));
    expect(readWorldCard(r.services, ROOM, {})).toEqual({ cardDirectives: null, worldImported: true });
    expect(readOpening(r.services, ROOM)).toBeNull();
  });

  test("readOpening: the first world card that offers one, as written", () => {
    const r = room();
    importWorld(r.context(), cardOf(plainRaw("Quiet")));
    importWorld(r.context(), cardOf(stuffedRaw()));
    expect(readOpening(r.services, ROOM)).toEqual({
      cardId: "card:Mira",
      name: "Mira",
      opening: `${MK.greeting} — {{user}} meets {{char}}.`,
      alternates: [`${MK.alternate} at dawn`],
    });
  });

  test("the stored world card's projections keep the directives with the Keeper", () => {
    const r = room();
    importWorld(r.context(), cardOf(stuffedRaw()));
    const player = JSON.stringify(r.services.views.views(ROOM, WORLD_CARD_TYPE, { grade: "player", locale: "en", memberId: "m-ada" }));
    for (const mark of [MK.system, MK.post, MK.greeting, MK.alternate, MK.scenario]) expect(player).not.toContain(mark);
    expect(player).toContain("Mira");
    expect(JSON.stringify(r.services.views.views(ROOM, WORLD_CARD_TYPE, KEEPER))).toContain(MK.system);
  });
});
