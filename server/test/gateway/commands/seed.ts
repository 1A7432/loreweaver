// Room content for the command tests, written the way the engine's own code writes it.
import { createHash } from "node:crypto";

import { characterData, claimableData, createCharacter, EMPTY_CLAIMABLE, offerCharacter, CHARACTER_TYPE, CLAIMABLE_ID, CLAIMABLE_TYPE } from "../../../src/core/characters/index.ts";
import {
  CAMPAIGN_SUMMARY_ID,
  CAMPAIGN_SUMMARY_TYPE,
  campaignSummaryData,
  CHRONICLE_RECORD_TYPE,
  chronicleRecordData,
  newChronicleRecord,
  newPlotThread,
  PLOT_THREAD_TYPE,
  plotThreadData,
  plotThreadId,
} from "../../../src/core/chronicle/index.ts";
import { observeHabit, NO_HABITS, TABLE_HABITS_ID, TABLE_HABITS_TYPE, tableHabitsData, type TableHabits } from "../../../src/core/habits/index.ts";
import { LORE_ENTRY_TYPE, loreEntryDocument, LORE_ENTRY_DEFAULTS } from "../../../src/core/lore/index.ts";
import { createNpc, NPC_TYPE, npcData, npcSlug } from "../../../src/core/npcs/index.ts";
import { newSheet } from "../../../src/core/sheets/index.ts";
import { fromPlain, VARIABLE_TREE_ID, VARIABLE_TREE_TYPE, variableTreeData, type VarMap } from "../../../src/core/variables/index.ts";
import type { JsonObject } from "../../../src/core/documents/index.ts";
import { addUpload } from "../../../src/gateway/audio.ts";
import { type Bench, ROOM } from "./bench.ts";

function put(bench: Bench, type: string, id: string, data: JsonObject, meta?: JsonObject): void {
  bench.services.documents.put(bench.store.writer(ROOM), type, id, data, meta);
}

/** Every marker a secret seed carries; none may reach a player. */
export const SECRET = {
  lore: "LORE-SECRET-CONTENT",
  loreTitle: "The Hidden Truth",
  npcAgenda: "NPC-SECRET-AGENDA",
  npcPersona: "NPC-PRIVATE-PERSONA",
  npcFact: "NPC-PRIVATE-FACT",
  variable: "VAR-UNEXPOSED-VALUE",
  recordKeeper: "CHRONICLE-KEEPER-ANNOTATION",
  summaryMargin: "SUMMARY-KEEPER-MARGIN",
  thread: "THREAD-KEEPER-LABEL",
  habit: "HABIT-ABOUT-THE-PLAYERS",
} as const;

export function seedLore(bench: Bench): void {
  const open = loreEntryDocument({ ...LORE_ENTRY_DEFAULTS, title: "Arkham", content: "A town by the river.", source: "pack:demo" });
  put(bench, LORE_ENTRY_TYPE, "lore-open", open.data, open.meta);
  const secret = loreEntryDocument({ ...LORE_ENTRY_DEFAULTS, title: SECRET.loreTitle, content: SECRET.lore, secret: true, keys: ["truth"], source: "pack:demo" });
  put(bench, LORE_ENTRY_TYPE, "lore-secret", secret.data, secret.meta);
}

export function seedNpc(bench: Bench): void {
  const made = createNpc({ name: "Mr Smith", publicDescription: "A grocer.", persona: SECRET.npcPersona, secretAgenda: SECRET.npcAgenda, knowledge: [SECRET.npcFact] });
  if (!made.ok) throw new Error(made.code);
  put(bench, NPC_TYPE, npcSlug("Mr Smith") as string, npcData(made.data));
}

export function seedVariables(bench: Bench): void {
  const tree = fromPlain({ stats: { hp: 10 }, plot: { ending: SECRET.variable } }) as VarMap;
  put(bench, VARIABLE_TREE_TYPE, VARIABLE_TREE_ID, variableTreeData(tree, ["stats"]));
}

export function seedChronicle(bench: Bench): void {
  const record = newChronicleRecord({ text: "The party reached the farm.", keeper: SECRET.recordKeeper }, 1);
  if (!record.ok) throw new Error(record.code);
  put(bench, CHRONICLE_RECORD_TYPE, "c000001", chronicleRecordData(record.data));
  const later = newChronicleRecord({ text: "They found the cellar.", keeper: SECRET.recordKeeper }, 3);
  if (!later.ok) throw new Error(later.code);
  put(bench, CHRONICLE_RECORD_TYPE, "c000002", chronicleRecordData(later.data));
  put(bench, CAMPAIGN_SUMMARY_TYPE, CAMPAIGN_SUMMARY_ID, campaignSummaryData({ text: "The story began in Arkham.", throughTurn: 2, foldCount: 1, keeper: SECRET.summaryMargin, foldMeter: null }));
  const thread = newPlotThread(SECRET.thread, "armed");
  if (!thread.ok) throw new Error(thread.code);
  put(bench, PLOT_THREAD_TYPE, plotThreadId(SECRET.thread), plotThreadData(thread.data));
}

export function seedHabits(bench: Bench): void {
  let habits: TableHabits = NO_HABITS;
  for (let index = 0; index < 3; index++) {
    const seen = observeHabit(habits, SECRET.habit, "they like long fights");
    if (!seen.ok) throw new Error(seen.code);
    habits = seen.data.habits;
  }
  put(bench, TABLE_HABITS_TYPE, TABLE_HABITS_ID, tableHabitsData(habits));
}

/** A pregenerated CoC character on the room's roster, unowned. */
export function seedRoster(bench: Bench): void {
  const pack = bench.services.packs.get("coc7");
  if (pack === null) throw new Error("coc7");
  const created = createCharacter(pack.sheet, newSheet(pack.sheet, "Holmes", "coc7").sheet);
  if (!created.ok) throw new Error(created.code);
  put(bench, CHARACTER_TYPE, "pregen-holmes", characterData(created.data));
  const offered = offerCharacter(EMPTY_CLAIMABLE, { id: "pregen-holmes", name: "Holmes", blurb: "A detective.", source: { kind: "pack", id: "demo" }, keeperNote: "PREGEN-KEEPER-NOTE" });
  if (!offered.ok) throw new Error(offered.code);
  put(bench, CLAIMABLE_TYPE, CLAIMABLE_ID, claimableData(offered.data));
}

/** An OGG file: the signature the media store checks, then `tag`. */
export function oggFile(tag: string): Uint8Array {
  return new Uint8Array([0x4f, 0x67, 0x67, 0x53, ...new TextEncoder().encode(tag)]);
}

/**
 * Sounds in the room's audio library, uploaded by the admin as the room does it: the bytes
 * through `Uploads` with purpose `audio`, then the library entry. Needs a bench with media.
 * Returns their hashes, in order.
 */
export async function seedSounds(bench: Bench, names: readonly string[] = ["Rain Night.ogg", "Tavern.ogg"]): Promise<string[]> {
  const uploads = bench.uploads;
  if (uploads === null) throw new Error("the bench keeps no files");
  const hashes: string[] = [];
  for (const name of names) {
    const bytes = oggFile(name);
    const offered = uploads.offer(ROOM, { id: "m-root", role: "admin" }, { name, mime: "audio/ogg", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), purpose: "audio" });
    if (!offered.ok) throw new Error(offered.code);
    const record = offered.kind === "existing" ? offered.record : await uploads.receive(ROOM, { id: "m-root", role: "admin" }, offered.uploadId, bytes).then((received) => (received.ok ? received.record : null));
    if (record === null) throw new Error("sound not stored");
    const writer = bench.store.writer(ROOM);
    bench.store.transaction(() => addUpload(writer, bench.store, record, "m-root", 1));
    hashes.push(record.hash);
  }
  return hashes;
}
