// Chronicle tools: the Keeper's own record of a beat (with its Keeper-only margin), and
// the open loops it must not forget. The Scribe writes most records automatically; this
// tool is the voluntary one, and the only one that carries a spoiler margin.
import {
  CHRONICLE_RECORD_TYPE,
  chronicleRecordData,
  chronicleRecordId,
  MAX_RECORD_CHARACTERS,
  MAX_RECORD_KEEPER_CHARS,
  MAX_RECORD_TEXT_CHARS,
  MAX_SCENE_CHARS,
  MAX_THREAD_LABEL_CHARS,
  MAX_THREAD_NOTES_CHARS,
  newChronicleRecord,
  newPlotThread,
  PLOT_THREAD_TYPE,
  plotThreadData,
  plotThreadId,
  readPlotThread,
  type ThreadStatus,
  updatePlotThread,
} from "../../core/chronicle/index.ts";
import type { RoomContext } from "../context.ts";
import { param } from "./params.ts";
import { getDocument, listDocuments, putDocument, refuse } from "./shared.ts";
import { defineTool, type ToolResult } from "./types.ts";

const RECORD_ID = /^c(\d{6})$/;

/** The next record id: one past the highest written, by anyone (the Scribe writes them too). */
function nextRecordSequence(context: RoomContext): number {
  let highest = 0;
  for (const document of listDocuments(context, CHRONICLE_RECORD_TYPE)) {
    const match = RECORD_ID.exec(document.id);
    if (match !== null) highest = Math.max(highest, Number(match[1]));
  }
  return highest + 1;
}

const RECORD_LIMITS: Readonly<Record<string, string>> = {
  text: `the text must be 1-${MAX_RECORD_TEXT_CHARS} characters`,
  keeper: `keeper_notes must be at most ${MAX_RECORD_KEEPER_CHARS} characters`,
  characters: `at most ${MAX_RECORD_CHARACTERS} character names`,
  scene: `the scene label must be at most ${MAX_SCENE_CHARS} characters`,
};

export const recordChronicleTool = defineTool({
  name: "record_chronicle",
  description:
    "Record one campaign-chronicle entry: what the table just DID — a decision, consequence, discovery, or scene beat worth remembering across sessions.",
  params: {
    text: param.string("the public narrative record of the beat, terse (one stretch of play)"),
    keeper_notes: param.string("optional keeper-only annotations (spoilers allowed here)").or(""),
    pcs: param.string("optional comma-separated character names whose personal arcs this beat belongs to").or(""),
    scene: param.string("optional scene/location label").or(""),
  },
  flags: {},
  suspends: null,
  run(context, args): ToolResult {
    // The engine stamps the turn: a record is history, never a plan.
    const change = newChronicleRecord({ text: args.text, keeper: args.keeper_notes, characters: args.pcs.split(","), scene: args.scene }, context.turn);
    if (!change.ok) {
      const field = change.path.split(".")[0] ?? change.path;
      return refuse(`chronicle_${change.code}`, `Chronicle entry rejected: ${RECORD_LIMITS[field] ?? `${change.code} at ${change.path}`}.`);
    }
    const id = chronicleRecordId(nextRecordSequence(context));
    if (!id.ok) return refuse("chronicle_limit_reached", "Chronicle entry rejected: this room's chronicle is full.");
    putDocument(context, CHRONICLE_RECORD_TYPE, id.data, chronicleRecordData(change.data), null);
    return { text: `Chronicle entry ${id.data} recorded (turn ${change.data.turn}).` };
  },
});

const THREAD_STATUSES: readonly ThreadStatus[] = ["open", "resolved"];

export const updateThreadTool = defineTool({
  name: "update_thread",
  description:
    "Open, update, or resolve a campaign thread — an open loop the table must not forget (planted foreshadowing, an unresolved hook, an armed consequence).",
  params: {
    label: param.string("the loop's short name"),
    status: param.string("open | resolved").or("open"),
    notes: param.string("optional keeper-only detail (omitted keeps the previous notes)").or(""),
  },
  flags: {},
  suspends: null,
  run(context, args): ToolResult {
    const status = args.status.trim().toLowerCase();
    if (!(THREAD_STATUSES as readonly string[]).includes(status)) {
      return refuse("bad_status", `Invalid thread status "${status}" — use one of: ${THREAD_STATUSES.join(", ")}.`);
    }
    const id = plotThreadId(args.label);
    const document = getDocument(context, PLOT_THREAD_TYPE, id);
    const existing = document === null || document.corrupt ? null : readPlotThread(document.data);
    const notes = args.notes.trim() === "" ? undefined : args.notes;
    const change =
      existing === null
        ? (() => {
            const opened = newPlotThread(args.label, notes ?? "");
            return opened.ok ? updatePlotThread(opened.data, { status: status as ThreadStatus }) : opened;
          })()
        : updatePlotThread(existing, notes === undefined ? { status: status as ThreadStatus } : { status: status as ThreadStatus, notes });
    if (!change.ok) {
      const limit = change.path === "notes" ? `notes must be at most ${MAX_THREAD_NOTES_CHARS} characters` : `the label must be 1-${MAX_THREAD_LABEL_CHARS} characters`;
      return refuse(`thread_${change.code}`, `Thread not updated: ${limit}.`);
    }
    putDocument(context, PLOT_THREAD_TYPE, id, plotThreadData(change.data), document);
    return { text: `Thread "${change.data.label}" is now ${change.data.status}.` };
  },
});
