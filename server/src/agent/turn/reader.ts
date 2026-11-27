// The room as the Keeper's prompt reads it: everything the turn engine turns into a
// `KeeperPromptSnapshot`, read synchronously from the store at Keeper grade (iron rule 3:
// the Keeper holds the room's whole truth; restraint is its behaviour, not this input's
// shape). Plus the turn's other reads — the replayed history derived from the event log,
// the variables modules are shown, the Scribe's whispers and the pending module facts as
// the text the prompt carries.
//
// History is DERIVED from the log, never stored twice (§12 3.3): a completed turn is its
// player `narrative` (turn N) paired with the Keeper's `kp` `narrative` (turn N). A turn
// with no reply is skipped; NPC lines, dice and system lines are not replayed. A turn with
// a Keeper reply and no player line is a narrate-now turn: it replays with the fixed line
// it was asked with (`FACTS_TURN_LINE`), so it stays byte-stable from turn to turn.
//
// How far back the log is read: pages of `HISTORY_PAGE_EVENTS`, newest first, until the
// scan has passed a PLAYER line at or below the summary's through-turn (player lines are
// logged in turn order when they are accepted, and a turn's reply always comes after its
// line, so every reply the prompt still replays has been seen by then) AND has found
// `RECENT_TRANSCRIPT_MESSAGES` worth of completed turns for the retrieval window (2.6
// `_recent_transcript` read folded turns too: a folded turn stopped being replayed, not
// being what just happened). Before the first fold that is the whole log — the fold is what
// bounds it. A log past `MAX_HISTORY_SCAN_EVENTS` is cut there and the cut is reported.
import type { ClockReading, JsonObject as ModuleJson } from "loreweaver/module";

import {
  CAMPAIGN_SUMMARY_ID,
  CAMPAIGN_SUMMARY_TYPE,
  type CampaignSummary,
  CHRONICLE_RECORD_TYPE,
  type ChronicleRecord,
  PLOT_THREAD_TYPE,
  type PlotThread,
  readCampaignSummary,
  readChronicleRecord,
  readPlotThread,
} from "../../core/chronicle/index.ts";
import { CHARACTER_TYPE, readSeating, SEATING_ID, SEATING_TYPE } from "../../core/characters/index.ts";
import type { CharacterTableView } from "../../core/characters/index.ts";
import {
  CLOCK_OWNER_ID,
  CLOCK_OWNER_TYPE,
  GAME_CLOCK_ID,
  GAME_CLOCK_TYPE,
  type GameClockTableView,
  INITIATIVE_ID,
  INITIATIVE_TYPE,
  type InitiativeView,
  keeperMayAdvance,
  readClockOwnership,
  readGameClock,
} from "../../core/clock/index.ts";
import type { Viewer } from "../../core/documents/model.ts";
import { readTableHabits, TABLE_HABITS_ID, TABLE_HABITS_TYPE, type TableHabits } from "../../core/habits/index.ts";
import { LORE_OVERLAY_ID, LORE_OVERLAY_TYPE, pendingSetup, readOverlay, type SetupItem } from "../../core/lore/index.ts";
import { KEEPER_NOTES_ID, KEEPER_NOTES_TYPE, type KeeperNotes, readKeeperNotes, readScene, SCENE_ID, SCENE_TYPE, type SceneView } from "../../core/notes/index.ts";
import { readRelationships, RELATIONSHIPS_ID, RELATIONSHIPS_TYPE, type Relationships } from "../../core/relationships/index.ts";
import type { RulePack } from "../../core/rulepacks/index.ts";
import {
  MODULE_VARIABLES_ID,
  MODULE_VARIABLES_TYPE,
  type ModuleVariables,
  normalizeModuleVariables,
  readVariableTree,
  toJson,
  VARIABLE_TREE_ID,
  VARIABLE_TREE_TYPE,
  type VarMap,
} from "../../core/variables/index.ts";
import type { MacroContext } from "../../core/worldbook/index.ts";
import type { Store } from "../../infra/store.ts";
import { readWorldCard } from "../card_import.ts";
import type { RoomContext, Services } from "../context.ts";
import type { PendingFact } from "../effects.ts";
import type { Whisper } from "../lanes/scribe.ts";
import type { ClockInfo } from "../modules.ts";
import type { KeeperPromptSnapshot, ModuleCommandLine, PartyMember, PastExchange, PlayerAction } from "../prompt/index.ts";
import { turnText } from "./catalog.ts";

/** Events read per page while walking the log back. */
export const HISTORY_PAGE_EVENTS = 256;
/** The log scan's hard stop; past it the history is cut and the cut reported. */
export const MAX_HISTORY_SCAN_EVENTS = 20_000;
/** Messages of the conversation's tail that seed lore matching and recall (2.6: 6). */
export const RECENT_TRANSCRIPT_MESSAGES = 6;
/** The retrieval text's length, in code points (2.6: 2,000). */
export const RECENT_TRANSCRIPT_MAX_CHARS = 2_000;
/** Recalled chronicle records the prompt receives. */
export const MAX_RECALLED_RECORDS = 12;

/**
 * The user line of a narrate-now turn, which has no player line: written FOR THE MODEL,
 * English only (a corrective-style instruction), and the line that turn replays with.
 */
export const FACTS_TURN_LINE =
  "(No player spoke. Module events need narrating: they are listed under the module event notes above. Narrate them for the table now.)";

/**
 * The note that hands the Keeper a world card's authored opening on the room's first Keeper
 * turn (2.6 kept it in the keeper-only module brief and told the Keeper to open play by
 * quoting or adapting it). Text for the model, English only.
 */
export const OPENING_NOTE =
  "This is the first scene of the game. The imported world card's authored opening follows (keeper-side material: open play by quoting or adapting it, and do not mention that it was given to you):";

// ---------------------------------------------------------------- history

export interface HistoryReading {
  /** Completed turns after the summary's through-turn, oldest first. */
  readonly history: readonly PastExchange[];
  /** The newest messages of the conversation (folded turns included), oldest first. */
  readonly recent: readonly string[];
  /** Whether the scan found any Keeper reply at all (false in a room the Keeper never answered). */
  readonly keeperHasReplied: boolean;
  /** Whether the scan reached the start of the log. */
  readonly reachedStart: boolean;
  /** The current turn's player line's timestamp, or the newest event's; null in an empty log. */
  readonly nowMs: number | null;
  /** The scan stopped at `MAX_HISTORY_SCAN_EVENTS`. */
  readonly truncated: boolean;
}

interface Line {
  readonly name: string;
  readonly text: string;
}

function narrativeOf(data: unknown): { speaker: string; name: string; text: string } | null {
  if (typeof data !== "object" || data === null) return null;
  const record = data as Record<string, unknown>;
  if (typeof record.speaker !== "string" || typeof record.text !== "string") return null;
  return { speaker: record.speaker, name: typeof record.name === "string" ? record.name : "", text: record.text };
}

/**
 * The replayed history of the turn `currentTurn`, bounded as the file header says. Turns
 * at or after `currentTurn` are not history.
 */
export function readHistory(store: Store, room: string, currentTurn: number, throughTurn: number): HistoryReading {
  const players = new Map<number, Line>();
  const replies = new Map<number, string>();
  /** Per turn, what NPCs said as their own messages, oldest first. */
  const spoken = new Map<number, Line[]>();
  let before = store.room(room).head + 1;
  let scanned = 0;
  let passedThrough = false;
  let reachedStart = false;
  let truncated = false;
  let nowMs: number | null = null;
  let newestTs: number | null = null;
  const completedEnough = (): boolean => {
    let count = 0;
    for (const turn of replies.keys()) if (players.has(turn)) count++;
    return count * 2 >= RECENT_TRANSCRIPT_MESSAGES;
  };
  for (;;) {
    const page = store.eventsBefore(room, before, HISTORY_PAGE_EVENTS);
    if (page.length === 0) {
      reachedStart = true;
      break;
    }
    for (let index = page.length - 1; index >= 0; index--) {
      const event = page[index];
      if (event === undefined) continue;
      if (newestTs === null) newestTs = event.ts;
      if (event.kind !== "narrative" || event.turn === undefined) continue;
      const line = narrativeOf(event.data);
      if (line === null) continue;
      const turn = event.turn;
      if (line.speaker === "player") {
        if (turn === currentTurn && nowMs === null) nowMs = event.ts;
        if (turn < currentTurn && !players.has(turn)) players.set(turn, { name: line.name, text: line.text });
        if (throughTurn > 0 && turn <= throughTurn) passedThrough = true;
      } else if (line.speaker === "kp" && turn < currentTurn && !replies.has(turn)) {
        replies.set(turn, line.text);
      } else if (line.speaker === "npc" && turn < currentTurn && line.text.trim() !== "") {
        // The scan runs newest first: each older line goes in front.
        const lines = spoken.get(turn) ?? [];
        lines.unshift({ name: line.name, text: line.text });
        spoken.set(turn, lines);
      }
    }
    scanned += page.length;
    before = (page[0] as { seq: number }).seq;
    if (page.length < HISTORY_PAGE_EVENTS) {
      reachedStart = true;
      break;
    }
    if (passedThrough && completedEnough()) break;
    if (scanned >= MAX_HISTORY_SCAN_EVENTS) {
      truncated = true;
      break;
    }
  }

  const all: PastExchange[] = [];
  for (const [turn, reply] of replies) {
    const player = players.get(turn);
    const npcLines = spoken.get(turn);
    const said = npcLines === undefined ? {} : { npcLines };
    if (player !== undefined) all.push({ turn, speaker: player.name, playerText: player.text, keeperReply: reply, ...said });
    // A reply with no player line is a narrate-now turn — unless the scan stopped before
    // reaching that turn's line, which only a cut scan can do.
    else if (reachedStart || turn > throughTurn) all.push({ turn, speaker: "", playerText: FACTS_TURN_LINE, keeperReply: reply, ...said });
  }
  all.sort((a, b) => a.turn - b.turn);
  const history = all.filter((exchange) => throughTurn <= 0 || exchange.turn > throughTurn);
  const recent = all.flatMap((exchange) => [exchange.playerText, exchange.keeperReply]).slice(-RECENT_TRANSCRIPT_MESSAGES);
  return { history, recent, keeperHasReplied: replies.size > 0, reachedStart, nowMs: nowMs ?? newestTs, truncated };
}

/** The retrieval text: the recent messages and this turn's line, cut to their last `RECENT_TRANSCRIPT_MAX_CHARS`. */
export function retrievalWindow(recent: readonly string[], line: string): string[] {
  const parts = [...recent, line].map((part) => part.trim()).filter((part) => part !== "");
  const joined = Array.from(parts.join("\n"));
  if (joined.length <= RECENT_TRANSCRIPT_MAX_CHARS) return parts;
  return [joined.slice(joined.length - RECENT_TRANSCRIPT_MAX_CHARS).join("")];
}

// ---------------------------------------------------------------- what the prompt consumes

/** A whisper as the Keeper reads it, in the room's language (the 2.6 texts, `turn.json`). */
export function renderWhisper(locale: string, whisper: Whisper): string {
  switch (whisper.kind) {
    case "note":
      return whisper.text;
    case "unrolled_check":
      return turnText(locale, "scribe.whisper.unrolled_check", { skill: whisper.skill, quote: whisper.quote });
    case "npc_overreach":
      return turnText(locale, "scribe.whisper.npc_overreach", { npc: whisper.npc, quote: whisper.quote, fact: whisper.fact });
  }
}

/**
 * Pending module facts as module notes for the prompt: a Keeper fact's text, a table fact's
 * data (its text was already shown at the table). The prompt snapshot has no slot of its
 * own for facts, so they ride the module-notes section beside this turn's injections.
 */
export function renderPendingFacts(facts: readonly PendingFact[]): string[] {
  const lines: string[] = [];
  for (const fact of facts) {
    const parts: string[] = [];
    if (fact.text !== null && fact.text.trim() !== "") parts.push(fact.text.trim());
    if (fact.data !== null) parts.push(JSON.stringify(fact.data));
    if (parts.length > 0) lines.push(`- [${fact.module}] ${parts.join(" ")}`);
  }
  return lines;
}

// ---------------------------------------------------------------- what modules are shown

/** The room's variables as a module reads them: the imported tree, then module variables by id (they win, as in a read). */
export function moduleVariablesJson(services: Pick<Services, "documents">, room: string): ModuleJson {
  const out: Record<string, unknown> = {};
  const treeDocument = services.documents.get(room, VARIABLE_TREE_TYPE, VARIABLE_TREE_ID);
  if (treeDocument !== null && !treeDocument.corrupt) {
    const tree = toJson(readVariableTree(treeDocument.data).tree);
    if (typeof tree === "object" && tree !== null && !Array.isArray(tree)) Object.assign(out, tree);
  }
  const variables = services.documents.get(room, MODULE_VARIABLES_TYPE, MODULE_VARIABLES_ID);
  if (variables !== null && !variables.corrupt) {
    for (const variable of normalizeModuleVariables(variables.data).variables) out[variable.spec.id] = variable.value;
  }
  return out as ModuleJson;
}

/** Whether the Keeper keeps the room's clock (no ownership document: it does). */
export function keeperOwnsClock(services: Pick<Services, "documents">, room: string): boolean {
  const document = services.documents.get(room, CLOCK_OWNER_TYPE, CLOCK_OWNER_ID);
  if (document === null || document.corrupt) return document === null;
  const ownership = readClockOwnership(document.data);
  return ownership === null ? false : keeperMayAdvance(ownership);
}

/** The stored game clock's text; null when the room keeps none. */
export function storedClockText(services: Pick<Services, "documents">, room: string): string | null {
  const document = services.documents.get(room, GAME_CLOCK_TYPE, GAME_CLOCK_ID);
  if (document === null || document.corrupt) return null;
  const clock = readGameClock(document.data);
  return clock === null || clock.now === "" ? null : clock.now;
}

/** The clock a module exchange carries: the claiming module's reading, else the stored clock. */
export function clockReading(services: Pick<Services, "documents">, room: string, moduleClock: ClockInfo | null): ClockReading | null {
  if (moduleClock !== null) return moduleClock.round === null ? { time: moduleClock.time } : { time: moduleClock.time, round: moduleClock.round };
  const text = storedClockText(services, room);
  return text === null ? null : { time: text };
}

// ---------------------------------------------------------------- the snapshot

/** What the turn has worked out itself; the rest of the snapshot is read from the room. */
export interface SnapshotParts {
  readonly pack: RulePack | null;
  readonly skills: readonly string[];
  readonly moduleCommands: readonly ModuleCommandLine[];
  readonly lore: string;
  readonly whispers: readonly string[];
  readonly playerActions: readonly PlayerAction[];
  readonly injections: readonly string[];
  readonly recalled: readonly string[];
  readonly history: readonly PastExchange[];
  readonly speaker: string;
  readonly line: string;
  /** The claiming module's clock reading this turn, when a module keeps the clock. */
  readonly moduleClock: ClockInfo | null;
  /** The per-turn macro pass over the world card's post-history text. */
  readonly macros: MacroContext;
}

function keeperViewer(locale: string): Viewer {
  return { grade: "keeper", locale };
}

export function readSummary(services: Pick<Services, "documents">, room: string): CampaignSummary | null {
  const document = services.documents.get(room, CAMPAIGN_SUMMARY_TYPE, CAMPAIGN_SUMMARY_ID);
  return document === null || document.corrupt ? null : readCampaignSummary(document.data);
}

/** The room's chronicle records by id, in stored order (unreadable ones left out). */
export function readRecords(services: Pick<Services, "documents">, room: string): Map<string, ChronicleRecord> {
  const records = new Map<string, ChronicleRecord>();
  for (const document of services.documents.list(room, CHRONICLE_RECORD_TYPE)) {
    if (document.corrupt) continue;
    const record = readChronicleRecord(document.data);
    if (record !== null) records.set(document.id, record);
  }
  return records;
}

function party(services: Services, room: string, viewer: Viewer): PartyMember[] {
  const seatingDocument = services.documents.get(room, SEATING_TYPE, SEATING_ID);
  const seating = seatingDocument === null || seatingDocument.corrupt ? null : readSeating(seatingDocument.data);
  if (seating === null) return [];
  const members: PartyMember[] = [];
  for (const seat of seating.seats) {
    const document = services.documents.get(room, CHARACTER_TYPE, seat.character);
    if (document === null) continue;
    const view = services.types.project(document, viewer) as CharacterTableView | null;
    if (view === null) continue;
    members.push({ name: view.name, resources: view.resources, status: view.status });
  }
  return members;
}

/** The whole snapshot, read now. Synchronous: call it in the stretch that sends the prompt. */
export function readKeeperSnapshot(context: RoomContext, parts: SnapshotParts): KeeperPromptSnapshot {
  const { services, room, locale } = context;
  const viewer = keeperViewer(locale);
  const get = (type: string, id: string) => {
    const document = services.documents.get(room, type, id);
    return document === null || document.corrupt ? null : document;
  };

  const card = readWorldCard(services, room, parts.macros);
  const sceneDocument = get(SCENE_TYPE, SCENE_ID);
  const scene: SceneView | null = sceneDocument === null ? null : readScene(sceneDocument.data);
  let clock: GameClockTableView | null = null;
  if (parts.moduleClock !== null) clock = { now: parts.moduleClock.time };
  else {
    const text = storedClockText(services, room);
    clock = text === null ? null : { now: text };
  }
  const notesDocument = get(KEEPER_NOTES_TYPE, KEEPER_NOTES_ID);
  const keeperNotes: KeeperNotes | null = notesDocument === null ? null : readKeeperNotes(notesDocument.data);
  const initiativeDocument = get(INITIATIVE_TYPE, INITIATIVE_ID);
  const initiative = initiativeDocument === null ? null : (services.types.project(initiativeDocument, viewer) as InitiativeView | null);
  const relationshipsDocument = get(RELATIONSHIPS_TYPE, RELATIONSHIPS_ID);
  const relationships: Relationships | null = relationshipsDocument === null ? null : readRelationships(relationshipsDocument.data);
  const habitsDocument = get(TABLE_HABITS_TYPE, TABLE_HABITS_ID);
  const habits: TableHabits | null = habitsDocument === null ? null : readTableHabits(habitsDocument.data);
  const variablesDocument = get(MODULE_VARIABLES_TYPE, MODULE_VARIABLES_ID);
  const variables: ModuleVariables | null = variablesDocument === null ? null : normalizeModuleVariables(variablesDocument.data);
  const overlayDocument = get(LORE_OVERLAY_TYPE, LORE_OVERLAY_ID);
  const setupPending: SetupItem[] = overlayDocument === null ? [] : pendingSetup(readOverlay(overlayDocument.data));
  const treeDocument = get(VARIABLE_TREE_TYPE, VARIABLE_TREE_ID);
  const variableTree: VarMap | null = treeDocument === null ? null : readVariableTree(treeDocument.data).tree;
  const threads: PlotThread[] = [];
  for (const document of services.documents.list(room, PLOT_THREAD_TYPE)) {
    if (document.corrupt) continue;
    const thread = readPlotThread(document.data);
    if (thread !== null) threads.push(thread);
  }
  const recalled: ChronicleRecord[] = [];
  for (const id of parts.recalled) {
    if (recalled.length >= MAX_RECALLED_RECORDS) break;
    const document = get(CHRONICLE_RECORD_TYPE, id);
    const record = document === null ? null : readChronicleRecord(document.data);
    if (record !== null && record.folded) recalled.push(record);
  }

  return {
    locale,
    pack: parts.pack,
    cardDirectives: card.cardDirectives,
    skills: parts.skills,
    moduleCommands: parts.moduleCommands,
    summary: readSummary(services, room),
    worldImported: card.worldImported,
    lore: parts.lore,
    scene,
    clock,
    party: party(services, room, viewer),
    keeperNotes,
    initiative,
    relationships,
    habits,
    variables,
    setupPending,
    variableTree,
    whispers: parts.whispers,
    playerActions: parts.playerActions,
    injections: parts.injections,
    threads,
    recalled,
    history: parts.history,
    speaker: parts.speaker,
    line: parts.line,
  };
}

/** A module command's line in the prompt: its id and the first line of its description. */
export function commandLine(id: string, description: string): ModuleCommandLine {
  const first = description.split(/\r?\n/u).find((line) => line.trim() !== "")?.trim() ?? "";
  return { id, summary: first };
}
