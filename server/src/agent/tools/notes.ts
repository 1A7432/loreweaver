// The Keeper's notebook and the game clock.
//
// `kp_note` files notes under categories. Two categories are the table's scene card
// (`current_scene`, `current_focus` → the `scene` document, which every viewer sees);
// `npc_intents` reads back what NPC actors said they intend (the `npc_intents` log, which
// the NPC tool writes — never this one); every other category is the Keeper-only
// `keeper_notes` document.
//
// `game_clock` is offered only while the Keeper owns the room's clock (decision 36: a
// module that claims it keeps it).
import {
  advanceClock,
  type GameClock,
  gameClockData,
  GAME_CLOCK_ID,
  GAME_CLOCK_TYPE,
  readGameClock,
  scheduleEvent,
  setTime,
  UNSET_CLOCK,
} from "../../core/clock/index.ts";
import type { Document } from "../../core/documents/model.ts";
import {
  addNote,
  dropCategory,
  EMPTY_NOTES,
  EMPTY_SCENE,
  KEEPER_NOTES_ID,
  KEEPER_NOTES_TYPE,
  type KeeperNotes,
  keeperNotesData,
  MAX_CATEGORY_CHARS,
  MAX_NOTE_CHARS,
  MAX_NOTE_CATEGORIES,
  MAX_NOTES_PER_CATEGORY,
  MAX_SCENE_FOCUS_CHARS,
  MAX_SCENE_NAME_CHARS,
  NPC_INTENTS_ID,
  NPC_INTENTS_TYPE,
  notesIn,
  readIntentLog,
  readKeeperNotes,
  readScene,
  reviseLastNote,
  SCENE_ID,
  SCENE_TYPE,
  type Scene,
  sceneData,
  setNote,
  setSceneFocus,
  setSceneName,
} from "../../core/notes/index.ts";
import { NPC_TYPE } from "../../core/npcs/index.ts";
import type { RoomContext } from "../context.ts";
import { param } from "./params.ts";
import { clockText, getDocument, putDocument, refuse } from "./shared.ts";
import { defineTool, type ToolResult } from "./types.ts";

const SCENE_CATEGORIES = new Map([
  ["current_scene", "name"],
  ["current_focus", "focus"],
] as const);

/** The category the NPC tool fills; read here, written only by `speak_as_npc`. */
export const INTENTS_CATEGORY = "npc_intents";

const NOTE_REFUSALS: Readonly<Record<string, string>> = {
  bad_category: `The category name must be 1-${MAX_CATEGORY_CHARS} characters.`,
  bad_note: `A note must be 1-${MAX_NOTE_CHARS} characters.`,
  bad_at: "The game clock's text could not be stamped on the note.",
  too_many_categories: `The notebook already has ${MAX_NOTE_CATEGORIES} categories; delete one you no longer need.`,
  category_full: `That category already holds ${MAX_NOTES_PER_CATEGORY} notes; delete it or start another.`,
};

function readNotes(document: Document | null): KeeperNotes {
  return document === null || document.corrupt ? EMPTY_NOTES : (readKeeperNotes(document.data) ?? EMPTY_NOTES);
}

function readSceneDocument(document: Document | null): Scene {
  return document === null || document.corrupt ? EMPTY_SCENE : (readScene(document.data) ?? EMPTY_SCENE);
}

function sceneNote(context: RoomContext, action: string, category: string, field: "name" | "focus", content: string): ToolResult {
  const document = getDocument(context, SCENE_TYPE, SCENE_ID);
  const scene = readSceneDocument(document);
  const write = (value: string): ToolResult | null => {
    const change = field === "name" ? setSceneName(scene, value) : setSceneFocus(scene, value);
    if (!change.ok) return refuse(change.code, `${category} must be at most ${field === "name" ? MAX_SCENE_NAME_CHARS : MAX_SCENE_FOCUS_CHARS} characters.`);
    putDocument(context, SCENE_TYPE, SCENE_ID, sceneData(change.data), document);
    return null;
  };
  // A single-value scene field has no list to append to: add and update set it.
  if (action === "set" || action === "add" || action === "update") {
    const refused = write(content);
    if (refused !== null) return refused;
    return { text: `Set ${category} = ${content}. Players now see this on their scene card, so keep it table-facing.` };
  }
  const value = scene[field];
  if (action === "delete") {
    if (value === "") return refuse("unknown_category", `Category ${category} does not exist.`);
    const refused = write("");
    if (refused !== null) return refused;
    return { text: `Deleted category ${category}.` };
  }
  if (action === "get" || action === "list") {
    if (value === "") return { text: `No notes in ${category} yet.` };
    return { text: action === "get" ? `${category} = ${value}` : `${category} notes (1 total):\n\n1. [-] ${value}` };
  }
  return refuse("unknown_action", `Unsupported action: ${action}`);
}

function intentNotes(context: RoomContext, action: string): ToolResult {
  if (action !== "get" && action !== "list") {
    return refuse("read_only_category", `${INTENTS_CATEGORY} is written automatically after each speak_as_npc line; it can only be read (get/list).`);
  }
  const document = getDocument(context, NPC_INTENTS_TYPE, NPC_INTENTS_ID);
  const log = document === null || document.corrupt ? null : readIntentLog(document.data);
  const intents = log?.intents ?? [];
  if (intents.length === 0) return { text: `No notes in ${INTENTS_CATEGORY} yet.` };
  const nameOf = (id: string): string => {
    const npc = getDocument(context, NPC_TYPE, id);
    const name = npc?.data.name;
    return typeof name === "string" ? name : id;
  };
  const lines = [`${INTENTS_CATEGORY} notes (${intents.length} total):`, ""];
  intents.forEach((item, index) => lines.push(`${index + 1}. [${item.at ?? "-"}] ${nameOf(item.npc)} intends: ${item.intent}`));
  return { text: lines.join("\n") };
}

export const kpNoteTool = defineTool({
  name: "kp_note",
  // Carried over with one sentence removed: the module knowledge pool it set the notebook
  // apart from is not in 3.0 (decision 31).
  description:
    "The AI KP's free-form notebook -- improvised scenes, world-state changes, NPC status updates, player-action history, etc. current_scene and current_focus are PLAYER-VISIBLE (shown on every player's scene card): table-facing text only there (the scene's name, what the table is doing). Every other category is keeper-only.",
  params: {
    action: param.string(
      "set (set a single-value state) / add (append a note) / update (edit the last note) / delete (remove a whole category) / get or list (read a category back: the single value, or every note in it).",
    ),
    category: param.string(
      "The note category, e.g. current_scene, current_focus, improvised_scenes, npc_status, world_changes, player_actions, kp_reasoning.",
    ),
    content: param.string("The note text. For action=set this is the single value (e.g. a scene name); for action=add/update it is the note's content.").or(""),
  },
  flags: {},
  suspends: null,
  run(context, args): ToolResult {
    const action = args.action.trim().toLowerCase();
    const category = args.category.trim();
    const sceneField = SCENE_CATEGORIES.get(category as "current_scene");
    if (sceneField !== undefined) return sceneNote(context, action, category, sceneField, args.content);
    if (category === INTENTS_CATEGORY) return intentNotes(context, action);

    const document = getDocument(context, KEEPER_NOTES_TYPE, KEEPER_NOTES_ID);
    const notes = readNotes(document);
    const save = (change: ReturnType<typeof addNote>, done: string): ToolResult => {
      if (!change.ok) {
        if (change.code === "unknown_category") return refuse(change.code, `Category ${category} does not exist.`);
        if (change.code === "empty_category") return refuse(change.code, `${category} is empty; nothing to update.`);
        return refuse(change.code, NOTE_REFUSALS[change.code] ?? change.code);
      }
      putDocument(context, KEEPER_NOTES_TYPE, KEEPER_NOTES_ID, keeperNotesData(change.data), document);
      return { text: done };
    };
    switch (action) {
      case "set":
        return save(setNote(notes, category, args.content, clockText(context)), `Set ${category} = ${args.content}`);
      case "add": {
        const preview = Array.from(args.content.trim()).slice(0, 50).join("");
        return save(addNote(notes, category, args.content, clockText(context)), `Logged to ${category}: ${preview}...`);
      }
      case "update":
        return save(reviseLastNote(notes, category, args.content), `Updated the last note in ${category}.`);
      case "delete":
        return save(dropCategory(notes, category), `Deleted category ${category}.`);
      case "get":
      case "list": {
        const entries = notesIn(notes, category);
        if (entries.length === 0) return { text: `No notes in ${category} yet.` };
        // A category holding one value (what `set` leaves) reads back as that value.
        if (action === "get" && entries.length === 1) return { text: `${category} = ${(entries[0] as { text: string }).text}` };
        const lines = [`${category} notes (${entries.length} total):`, ""];
        entries.forEach((entry, index) => lines.push(`${index + 1}. [${entry.at ?? "-"}] ${entry.text}`));
        return { text: lines.join("\n") };
      }
      default:
        return refuse("unknown_action", `Unsupported action: ${args.action}`);
    }
  },
});

// ---------------------------------------------------------------------------
// game_clock
// ---------------------------------------------------------------------------

/** How many scheduled events `show` lists (the newest). */
const SHOWN_EVENTS = 10;

function readClock(document: Document | null): GameClock {
  return document === null || document.corrupt ? UNSET_CLOCK : (readGameClock(document.data) ?? UNSET_CLOCK);
}

const CLOCK_REFUSALS: Readonly<Record<string, string>> = {
  bad_time: "The time text is empty or too long.",
  bad_event: "The event description is empty or too long.",
  events_full: "The clock already holds the most scheduled events it can; let some pass first.",
};

export const gameClockTool = defineTool({
  name: "game_clock",
  description: "Manage in-game time: advance the clock, log a scheduled event, or view the current timeline during play.",
  params: {
    action: param
      .string("show (view current time) / set (set the time) / advance (move time forward) / add_event (log a scheduled event) / list_events (list every logged event).")
      .or("show"),
    value: param
      .string(
        "Depends on action. For set, e.g. \"1926-03-15 14:00\"; for advance, e.g. \"+2 hours\"/\"+1 day\"; for add_event, the event description.",
      )
      .or(""),
  },
  flags: {},
  suspends: null,
  run(context, args): ToolResult {
    const action = args.action.trim().toLowerCase();
    const document = getDocument(context, GAME_CLOCK_TYPE, GAME_CLOCK_ID);
    const clock = readClock(document);
    const now = clock.now === "" ? "not set" : clock.now;
    const eventLines = (events: GameClock["events"]): string[] => events.map((event) => `  • ${event.at}: ${event.what}`);
    switch (action) {
      case "show": {
        const lines = [`Current game time: ${now}`, ""];
        if (clock.events.length === 0) lines.push("No events logged yet.");
        else lines.push("Logged events:", ...eventLines(clock.events.slice(-SHOWN_EVENTS)));
        return { text: lines.join("\n") };
      }
      case "set": {
        const change = setTime(clock, args.value);
        if (!change.ok) return refuse(change.code, CLOCK_REFUSALS[change.code] ?? change.code);
        putDocument(context, GAME_CLOCK_TYPE, GAME_CLOCK_ID, gameClockData(change.data), document);
        return { text: `Game time set to: ${change.data.now}` };
      }
      case "advance": {
        const result = advanceClock(clock, args.value);
        if (!result.ok) {
          if (result.code === "unset") return refuse("unset", "The clock is not set yet, so there is nothing to advance from: `set` the time first (e.g. \"1926-03-15 14:00\").");
          if (result.code === "before_start") {
            return refuse(result.code, `"${args.value}" from "${now}" would move the clock before day 1 — refused, the clock is unchanged. Advance forward, or \`set\` an explicit earlier time.`);
          }
          return refuse(
            result.code,
            `Could not parse "${args.value}" — the clock is unchanged. Advance with e.g. "+30 minutes"/"+2 hours"/"+1 day", or \`set\` an explicit time like "1926-03-15 14:00".`,
          );
        }
        putDocument(context, GAME_CLOCK_TYPE, GAME_CLOCK_ID, gameClockData(result.data), document);
        const advance = result.advance;
        // A clock face the engine cannot move (a module's own calendar) stays as written,
        // but the advance still happened: the room's calendar hooks count the delta.
        const text = advance.moved
          ? `Game time advanced by ${args.value}; now: ${advance.to}`
          : `Advance of ${args.value} recorded (the room's calendar hooks receive it). The clock face "${advance.from}" is not a format the engine can move by itself, so it is unchanged — \`set\` the new face text yourself (a module with its own calendar: advance to count, set to display).`;
        return { text, bookkeeping: { clockAdvances: [advance] } };
      }
      case "add_event": {
        const change = scheduleEvent(clock, clock.now === "" ? "?" : clock.now, args.value);
        if (!change.ok) return refuse(change.code, CLOCK_REFUSALS[change.code] ?? change.code);
        putDocument(context, GAME_CLOCK_TYPE, GAME_CLOCK_ID, gameClockData(change.data), document);
        return { text: `Logged event: [${clock.now === "" ? "?" : clock.now}] ${args.value.trim()}` };
      }
      case "list_events":
        return { text: clock.events.length === 0 ? "No events logged yet." : ["All logged events:", "", ...eventLines(clock.events)].join("\n") };
      default:
        return refuse("unknown_action", `Unsupported action: ${args.action}`);
    }
  },
});
