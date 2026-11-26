// A seeded room for the view tests: two seated players, a companion, a pregen on offer, and
// a distinctive marker in every field the table may not see.
import {
  CHARACTER_TYPE,
  characterData,
  claim,
  createCharacter,
  EMPTY_SEATING,
  SEATING_ID,
  SEATING_TYPE,
  seatingData,
  type Seating,
} from "../../../src/core/characters/index.ts";
import { addCombatant, GAME_CLOCK_ID, GAME_CLOCK_TYPE, gameClockData, INITIATIVE_ID, INITIATIVE_TYPE, initiativeData, NO_FIGHT, scheduleEvent, setTime, UNSET_CLOCK } from "../../../src/core/clock/index.ts";
import type { JsonObject } from "../../../src/core/documents/index.ts";
import {
  addNote,
  EMPTY_INTENTS,
  EMPTY_NOTES,
  EMPTY_SCENE,
  establishFact,
  intentLogData,
  KEEPER_NOTES_ID,
  KEEPER_NOTES_TYPE,
  keeperNotesData,
  NPC_INTENTS_ID,
  NPC_INTENTS_TYPE,
  recordIntent,
  SCENE_ID,
  SCENE_TYPE,
  sceneData,
  setSceneFocus,
  setSceneName,
} from "../../../src/core/notes/index.ts";
import { newSheet } from "../../../src/core/sheets/index.ts";
import { buildSpec, defineVariable, EMPTY_MODULE_VARIABLES, MODULE_VARIABLES_ID, MODULE_VARIABLES_TYPE, moduleVariablesPayload, type ModuleVariables } from "../../../src/core/variables/index.ts";
import { type ViewInputs, type ViewSource, NO_MODULE_VIEWS, type OnlineMember, type ViewerContext, viewerContext } from "../../../src/gateway/views/index.ts";
import { ADA, ADMIN, BAO, bench, type Bench, EVE, type Member, ROOM } from "../commands/bench.ts";
import { SECRET, seedChronicle, seedHabits, seedLore, seedNpc, seedRoster, seedVariables } from "../commands/seed.ts";

export { ADA, ADMIN, BAO, EVE, ROOM };

/** Markers this file adds to the command seed's. */
export const MARK = {
  adaNotes: "ADA-OWN-SHEET-NOTES",
  adaBackground: "ADA-OWN-BACKGROUND",
  baoNotes: "BAO-PRIVATE-SHEET-NOTES",
  baoBackground: "BAO-PRIVATE-BACKGROUND",
  companionNotes: "COMPANION-SHEET-NOTES",
  keeperNote: "KEEPER-NOTEBOOK-ENTRY",
  intent: "NPC-INTENT-ENTRY",
  scheduled: "SCHEDULED-EVENT-PLAN",
  modvarLabel: "MODVAR-KEEPER-LABEL",
  modvarValue: "MODVAR-KEEPER-VALUE",
  pregenNote: "PREGEN-KEEPER-NOTE",
} as const;

/** What no player or observer may ever be shown. */
export const TABLE_SECRETS: readonly string[] = [
  SECRET.lore,
  SECRET.loreTitle,
  SECRET.npcAgenda,
  SECRET.npcPersona,
  SECRET.npcFact,
  SECRET.variable,
  SECRET.recordKeeper,
  SECRET.summaryMargin,
  SECRET.thread,
  SECRET.habit,
  MARK.keeperNote,
  MARK.intent,
  MARK.scheduled,
  MARK.modvarLabel,
  MARK.modvarValue,
  MARK.pregenNote,
  MARK.companionNotes,
];

/** Variables an admin is shown, flagged: the unexposed leaf and the keeper-only tracker. */
export const ADMIN_ALLOWED: readonly string[] = [SECRET.variable, MARK.modvarLabel, MARK.modvarValue];

function put(b: Bench, type: string, id: string, data: JsonObject): void {
  b.services.documents.put(b.store.writer(ROOM), type, id, data);
}

function ok<T>(change: { readonly ok: true; readonly data: T } | { readonly ok: false; readonly code: string }): T {
  if (!change.ok) throw new Error(change.code);
  return change.data;
}

function character(b: Bench, id: string, name: string, owner: string | null, notes: string, background: string, status: readonly string[] = []): void {
  const pack = b.services.packs.get("coc7");
  if (pack === null) throw new Error("coc7");
  const sheet = { ...newSheet(pack.sheet, name, "coc7").sheet, notes, background };
  const created = createCharacter(pack.sheet, sheet, { owner });
  if (!created.ok) throw new Error(created.code);
  put(b, CHARACTER_TYPE, id, characterData({ ...created.data, status }));
}

function moduleVariables(): ModuleVariables {
  let state: ModuleVariables = EMPTY_MODULE_VARIABLES;
  for (const input of [
    { id: "morale", kind: "number", labels: { en: "Morale", zh: "士气" }, minimum: 0, maximum: 10, default: 7 },
    { id: "doom", kind: "text", visibility: "keeper", labels: { en: MARK.modvarLabel }, default: MARK.modvarValue },
  ]) {
    const spec = buildSpec(input);
    if (!spec.ok) throw new Error(spec.problem);
    state = defineVariable(state, spec.spec).state;
  }
  return state;
}

export interface Room {
  readonly b: Bench;
  online: OnlineMember[];
  source(): ViewSource;
  inputs(at?: number): ViewInputs;
  viewer(member: Member, locale?: string): ViewerContext;
}

export function seededRoom(): Room {
  const b = bench();
  seedLore(b);
  seedNpc(b);
  seedVariables(b);
  seedChronicle(b);
  seedHabits(b);
  seedRoster(b);
  character(b, "pc-ada", "Ada Lovelace", ADA.id, MARK.adaNotes, MARK.adaBackground);
  character(b, "pc-bao", "Bao Zheng", BAO.id, MARK.baoNotes, MARK.baoBackground, ["poisoned"]);
  character(b, "companion", "Rex", null, MARK.companionNotes, "");
  let seating: Seating = EMPTY_SEATING;
  seating = ok(claim(seating, ADA.id, "pc-ada", ADA.name));
  seating = ok(claim(seating, BAO.id, "pc-bao", BAO.name));
  put(b, SEATING_TYPE, SEATING_ID, seatingData(seating));
  put(b, MODULE_VARIABLES_TYPE, MODULE_VARIABLES_ID, moduleVariablesPayload(moduleVariables()));
  put(b, KEEPER_NOTES_TYPE, KEEPER_NOTES_ID, keeperNotesData(ok(addNote(EMPTY_NOTES, "plot", MARK.keeperNote, null))));
  put(b, NPC_INTENTS_TYPE, NPC_INTENTS_ID, intentLogData(ok(recordIntent(EMPTY_INTENTS, "mr-smith", MARK.intent, null))));
  put(b, GAME_CLOCK_TYPE, GAME_CLOCK_ID, gameClockData(ok(scheduleEvent(ok(setTime(UNSET_CLOCK, "Day 1 08:00")), "Day 2 06:00", MARK.scheduled))));
  const scene = ok(establishFact(ok(setSceneFocus(ok(setSceneName(EMPTY_SCENE, "The Farm")), "Searching the barn")), "The mill burned down", null));
  put(b, SCENE_TYPE, SCENE_ID, sceneData(scene));
  put(b, INITIATIVE_TYPE, INITIATIVE_ID, initiativeData(ok(addCombatant(ok(addCombatant(NO_FIGHT, "Ada Lovelace", 70)), "Cultist", 40))));

  const room: Room = {
    b,
    online: [ADA, BAO, ADMIN, EVE],
    source: () => ({
      services: b.services,
      room: ROOM,
      locale: "en",
      pack: b.services.packs.get("coc7"),
      online: room.online,
      commands: { registry: b.registry, contextFor: (who) => ({ ...b.context(who.member ?? EVE, { newTurn: false }), who }) },
    }),
    inputs: (at = 1) => ({ source: room.source(), modules: NO_MODULE_VIEWS, at }),
    viewer: (member, locale = "en") => viewerContext(b.services, ROOM, member, locale),
  };
  return room;
}

export function leaks(value: unknown, markers: readonly string[]): string[] {
  const text = JSON.stringify(value);
  return markers.filter((marker) => text.includes(marker));
}
