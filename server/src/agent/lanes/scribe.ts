// The Scribe: the quiet ledger clerk that reads every finished turn and does the
// bookkeeping the Keeper should not have to remember. One model call (lane `scribe`),
// after the reply has reached the table and outside the room's turn lock, so nobody waits
// for it. It proposes; the engine disposes:
//
// - variable updates the reply plainly establishes, each with a VERBATIM quotation of the
//   Keeper's reply that justifies it. The player's own words say what they attempted,
//   never what happened (iron rule 2 rests on the same line), so an op whose quotation is
//   not literally in the reply is dropped. A variable a module wrote this turn is
//   deterministic code's for this turn and is left alone: the reply-phase hooks run after
//   the narration is final, so where the two disagree the narration is the stale one
//   (docs/notes/implemented/scribe-writes-answer-to-hook-veto.md). Every other op is put to
//   the modules' veto as the `set_variable`/`adjust_variable` call it stands for — that
//   exchange is the CALLER's, between `computeScribe` and `commitScribe`, so the commit
//   takes only `AllowedScribeOps`;
// - up to three short whispers for the Keeper's next prompt (judgment stays the Keeper's);
// - an unrolled check and an NPC overreach, as observations held to the same evidence
//   rule, riding the whisper channel;
// - a table habit observation (`core/habits` counts sightings until one is promoted);
// - ONE player-grade chronicle line for a material turn, from the reply alone, and none
//   when the Keeper recorded one itself this turn. It never writes the Keeper annotation:
//   that margin belongs to the Keeper's own tool;
// - the beat: an ENUM VALUE ONLY. The Scribe reads Keeper-grade data; the Stage Director is
//   player-side, so nothing the Scribe wrote may reach it — only which kind of moment.
//
// The commit is one synchronous block through the writer of the turn the pass was
// SCHEDULED on (`RoomContext`), so a pass that finishes after later turns began still lands
// under its own turn, and the chronicle record is stamped with that turn — never a counter
// read at commit time (the M21 trap). A room undone, reset or replaced since refuses the
// writer (`StaleGeneration`); the commit then returns `stale` and writes nothing. That is
// expected, not an error.
import { charCount } from "loreweaver-protocol/v3";
import type { ToolCall } from "loreweaver/module";

import { CHRONICLE_RECORD_TYPE, chronicleRecordData, chronicleRecordId, MAX_RECORD_SEQUENCE, newChronicleRecord } from "../../core/chronicle/records.ts";
import { KEEPER, type JsonObject, type Viewer } from "../../core/documents/model.ts";
import { observeHabit, readTableHabits, TABLE_HABITS_ID, TABLE_HABITS_TYPE, tableHabitsData } from "../../core/habits/index.ts";
import { NPC_TYPE, readNpc } from "../../core/npcs/index.ts";
import { MODULE_VARIABLES_ID, MODULE_VARIABLES_TYPE, moduleVariablesPayload, type ModuleVariablesView } from "../../core/variables/documents.ts";
import { adjustVariable, normalizeModuleVariables, setVariable, type ModuleVariables, type VariableValue } from "../../core/variables/modvars.ts";
import type { WriteRefusalCode } from "../../core/variables/results.ts";
import { jsonStateKey } from "../../infra/lifecycle/declarations.ts";
import { StaleGeneration } from "../../infra/lifecycle/errors.ts";
import { type ChatResult, LLMError, withLane } from "../../infra/llm/index.ts";
import type { RoomContext, Services } from "../context.ts";
import type { ToolVerdict } from "../modules.ts";
import { BEATS, type Beat, isBeat } from "./director.ts";

export const SCRIBE_LANE = "scribe";

export const MAX_OPS = 8;
export const MAX_WHISPERS = 3;
export const MAX_WHISPER_CHARS = 300;
export const MAX_STORED_WHISPERS = 5;
/** The player's line and the reply, as the 2.6 Scribe sliced them (here: code points). */
export const MAX_TURN_TEXT_CHARS = 4_000;
/** The shortest quotation that counts as evidence. */
export const MIN_EVIDENCE_CHARS = 4;
/** One automatic chronicle record: a LINE of history, not a retelling. */
export const MAX_AUTO_CHRONICLE_CHARS = 400;
/** The NPC boundary watch: how many NPCs one pass shows, and how much of each one's facts. */
export const MAX_WATCHED_NPCS = 8;
export const MAX_NPC_FACTS_CHARS = 300;
export const MAX_SKILL_CHARS = 60;
export const MAX_NPC_NAME_CHARS = 60;
export const MAX_OVERREACH_FACT_CHARS = 120;
/** How many tool names the prompt lists. */
export const MAX_TOOL_NAMES = 64;

// ---------------------------------------------------------------------------
// Prompt — the 2.6 text, verbatim (`agent/scribe.py` `_PROMPT`, `_NPC_WATCH_BLOCK`). Text
// for the model: English, and it lives with the code that sends it. Fields are filled the
// way Python's `str.format` fills them (`{{`/`}}` are literal braces).
// ---------------------------------------------------------------------------

const NPC_WATCH_BLOCK = `
NPC knowledge boundaries — KEEPER-ONLY, never to be repeated outward (name | the facts this NPC knows). These lists mark SECRET boundaries, not complete minds — everyday knowledge (weather, town routine, their own trade) never crosses one. If dialogue the game-master reply attributes to one of these NPCs reveals something clearly beyond both its listed facts and everyday knowledge, add one extra key to the JSON: "npc_overreach": {{"npc": "<name>", "quote": "<verbatim dialogue quote from the reply>", "fact": "<what it revealed beyond its boundary>"}} — at most one, the clearest crossing. Omit the key when nothing crossed or you are unsure.
{npc_lines}
`;

const PROMPT = `You are the table Scribe for a TTRPG engine — a silent ledger clerk, not a storyteller.

Given ONE game turn (player action + game-master reply) and the room's current trackers, output ONLY a JSON object:
{{"ops": [{{"op": "set", "id": "<tracker id>", "value": <number>, "evidence": "<verbatim quote>"}} | {{"op": "adjust", "id": "<tracker id>", "delta": <number>, "evidence": "<verbatim quote>"}}], "whispers": ["<short keeper-side note>"], "unrolled_check": {{"skill": "<skill>", "evidence": "<verbatim quote>"}} or null, "habit": {{"summary": "<one line>", "detail": "<a sentence or two>"}} or null, "chronicle": "<one line of campaign history, or empty>", "beat": "<beat>"}}

Rules:
- "ops" ONLY for tracker changes the narration plainly establishes as fact. "evidence" is REQUIRED: a short verbatim quote copied from the GAME-MASTER reply that establishes the tracked quantity ITSELF changed. The player's message states what they ATTEMPT, never what happened — it can never be evidence, and an op whose evidence is not an exact quote of the game-master reply is discarded.
- You see only each tracker's id/label/range, not what earns a point. Acquiring some item is NOT evidence for an item counter unless the text explicitly identifies it as one of the things that counter counts; time passing counts on a day-tracker only when the text states the story moved to a new day. If the tracker's meaning leaves any doubt, do NOT write — whisper instead.
- "unrolled_check": set it when this turn resolved something whose outcome was genuinely uncertain and no dice were rolled for it — name the skill it called for and quote the exact text that shows the resolution. Tools the game-master called this turn are listed below; if a dice tool is among them, this is null. A declared intention with no outcome yet, a foregone conclusion, and pure conversation are all null. You are reporting an observation for the keeper to judge, not issuing an instruction — say nothing when unsure.
- "habit": how THIS TABLE plays, when the turn shows it — pacing they prefer, how much combat they have patience for, what kind of scene they lean into, a keeper technique that landed or fell flat. Write about the group's behaviour, not about the story: "they cut short investigation scenes to get to confrontation" is a habit, "they found the key" is not. Only when the turn actually shows it; null is the right answer most turns. Repeated observations are what make it stick, so write the same habit the same way each time you see it.
- "whispers" (0-{max_whispers}, each <= {max_whisper_chars} chars) for anything needing the keeper's judgment: scene/clock drift vs the fiction, players stuck without progress, an earned gain no tracker captures.
- Write whispers in the language the turn text is written in (Chinese turn -> Chinese whispers).
- "chronicle": ONE short past-tense line recording what this turn established for the campaign's history — what the table would want to remember months from now. This record is shown to PLAYERS, and the game-master reply is the ONLY thing you may build it from: write what that reply said out loud, never a motive or consequence it left unsaid. Everything else in this prompt — tracker labels and values, NPC knowledge lists — is keeper-only material the players have not learned; a name, object or explanation that appears there but not in the reply must stay out of this line, however true it is. Empty string when the turn established nothing that outlasts it (talk, out-of-character chatter, an intention with no outcome yet). Write it in the language of the turn text.
- "beat" classifies this turn as a MOMENT worth staging, one of: {beats}, or "none". Use "none" unless the turn clearly is one of them — most turns are "none".
  - scene_change: the group moved somewhere else, or time visibly moved on.
  - act_transition: a chapter/day/act of the story turned over.
  - handout: a document, picture, map or object the players can now LOOK at appeared.
  - spike: a critical success, a fumble, or a shock the table will remember.
  It is a single word, not a description — write nothing else about the beat.
- Never invent trackers not listed. Never narrate. Empty ops and empty whispers is a fine answer.

Trackers (id | label | value | range):
{trackers}
{npc_watch}
Tools the game-master called this turn: {tools}

--- TURN ---
Player: {player}
Game master: {reply}
--- END ---

JSON only.`;

function format(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{\{|\}\}|\{([a-z_]+)\}/g, (match, name: string | undefined) => {
    if (match === "{{") return "{";
    if (match === "}}") return "}";
    const value = name === undefined ? undefined : values[name];
    if (value === undefined) throw new Error(`scribe prompt: no value for ${match}`);
    return String(value);
  });
}

function slice(text: string, max: number): string {
  return charCount(text) <= max ? text : Array.from(text).slice(0, max).join("");
}

/** Whitespace runs as single spaces, so a quotation survives re-wrapping. */
function squash(text: string): string {
  return text.split(/\s+/u).filter((part) => part !== "").join(" ");
}

// ---------------------------------------------------------------------------
// Whispers: the room's queue for the Keeper's next prompt
// ---------------------------------------------------------------------------

/**
 * A whisper is data, not a sentence: the prompt assembler renders it. `note` is the
 * Scribe's own words (written in the turn's language, for the Keeper); the observations
 * carry their parts.
 */
export type Whisper =
  | { readonly kind: "note"; readonly text: string }
  | { readonly kind: "unrolled_check"; readonly skill: string; readonly quote: string }
  | { readonly kind: "npc_overreach"; readonly npc: string; readonly fact: string; readonly quote: string };

function isWhisper(value: unknown): value is Whisper {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const fits = (key: string, max: number): boolean => typeof record[key] === "string" && charCount(record[key] as string) <= max;
  switch (record.kind) {
    case "note":
      return fits("text", MAX_WHISPER_CHARS);
    case "unrolled_check":
      return fits("skill", MAX_SKILL_CHARS) && fits("quote", MAX_TURN_TEXT_CHARS);
    case "npc_overreach":
      return fits("npc", MAX_NPC_NAME_CHARS) && fits("fact", MAX_OVERREACH_FACT_CHARS) && fits("quote", MAX_TURN_TEXT_CHARS);
    default:
      return false;
  }
}

function isWhisperList(value: unknown): value is Whisper[] {
  return Array.isArray(value) && value.length <= MAX_STORED_WHISPERS && value.every(isWhisper);
}

/**
 * The pending whispers, oldest first; the Keeper's prompt assembler reads and clears them.
 * Story lifecycle (2.6 owner verdict 2026-08-14): the queue belongs to the session that
 * produced it — a fresh story's first prompt must not open with the last story's notes.
 */
export const WHISPERS_KEY = jsonStateKey<Whisper[]>("scribe.whispers", { reset: "story" }, isWhisperList);

// ---------------------------------------------------------------------------
// The snapshot
// ---------------------------------------------------------------------------

/** One declared variable, as the Keeper sees it. */
export interface ScribeVariable {
  readonly id: string;
  readonly label: string;
  readonly value: VariableValue;
  readonly min?: number;
  readonly max?: number;
}

/** One NPC's recorded knowledge, for the boundary watch. Keeper-grade. */
export interface NpcBoundary {
  readonly name: string;
  /** The facts joined, at most `MAX_NPC_FACTS_CHARS`. */
  readonly facts: string;
}

/** What the turn itself tells the caller; the rest of the snapshot is read from the room. */
export interface ScribeTurnFacts {
  readonly player: string;
  readonly reply: string;
  /** Names of the tools the Keeper called this turn. */
  readonly toolsCalled: readonly string[];
  /** Variables a MODULE wrote this turn: the Scribe does not touch them. */
  readonly moduleWrites: ReadonlySet<string>;
  /** The Keeper recorded a chronicle entry itself this turn. */
  readonly keeperRecordedChronicle: boolean;
}

/** Everything one Scribe pass reads: a plain value, taken when the pass is scheduled. */
export interface ScribeSnapshot extends ScribeTurnFacts {
  readonly room: string;
  /** The room's declared variables at KEEPER grade. */
  readonly variables: readonly ScribeVariable[];
  /** NPCs that have recorded knowledge; empty when none do (the watch is then off). */
  readonly npcs: readonly NpcBoundary[];
}

/** The snapshot of `room` now, for the turn described by `facts`. */
export function readScribeSnapshot(services: Services, room: string, locale: string, facts: ScribeTurnFacts): ScribeSnapshot {
  const keeper: Viewer = { ...KEEPER, locale };
  const view = services.views.view(room, MODULE_VARIABLES_TYPE, MODULE_VARIABLES_ID, keeper) as ModuleVariablesView | null;
  const variables = (view?.variables ?? []).map(
    (variable): ScribeVariable => ({
      id: variable.id,
      label: variable.label,
      value: variable.value,
      ...(variable.min === undefined ? {} : { min: variable.min }),
      ...(variable.max === undefined ? {} : { max: variable.max }),
    }),
  );
  const npcs: NpcBoundary[] = [];
  for (const document of services.documents.list(room, NPC_TYPE)) {
    if (npcs.length >= MAX_WATCHED_NPCS) break;
    const npc = document.corrupt ? null : readNpc(document.data);
    if (npc === null || npc.name.trim() === "" || npc.knowledge.length === 0) continue;
    npcs.push({ name: npc.name, facts: slice(npc.knowledge.join("; "), MAX_NPC_FACTS_CHARS) });
  }
  return { ...facts, room, variables, npcs };
}

// ---------------------------------------------------------------------------
// Compute
// ---------------------------------------------------------------------------

export type ScribeOp =
  | { readonly op: "set"; readonly id: string; readonly value: VariableValue; readonly evidence: string }
  | { readonly op: "adjust"; readonly id: string; readonly delta: number; readonly evidence: string };

export interface ScribeDropped {
  /** Not an op object, an unknown op, or a value of the wrong shape. */
  readonly malformed: number;
  /** A variable id the snapshot does not hold. */
  readonly unknownVariable: number;
  /** The quotation is not literally in the reply. */
  readonly noEvidence: number;
  /** A module wrote that variable this turn. */
  readonly moduleOwned: number;
  /** Past `MAX_OPS` or `MAX_WHISPERS`. */
  readonly overCap: number;
  /** A whisper, habit or chronicle line longer than its cap (refused, never cut). */
  readonly tooLong: number;
}

export type ScribeStatus = "ok" | "empty_reply" | "model_failed" | "aborted" | "unparsed";

export interface ScribeProposal {
  readonly status: ScribeStatus;
  /** Ops that passed the evidence rule, on known variables no module wrote this turn. */
  readonly ops: readonly ScribeOp[];
  readonly whispers: readonly Whisper[];
  readonly habit: { readonly summary: string; readonly detail: string } | null;
  /** The player-grade line, or null. */
  readonly chronicle: string | null;
  /** The moment to stage, or null for an ordinary turn. The only thing the Director sees. */
  readonly beat: Beat | null;
  readonly dropped: ScribeDropped;
}

const NONE_DROPPED: ScribeDropped = { malformed: 0, unknownVariable: 0, noEvidence: 0, moduleOwned: 0, overCap: 0, tooLong: 0 };

function empty(status: ScribeStatus): ScribeProposal {
  return { status, ops: [], whispers: [], habit: null, chronicle: null, beat: null, dropped: NONE_DROPPED };
}

function buildPrompt(snapshot: ScribeSnapshot): string {
  const trackers = snapshot.variables.map((variable) => {
    const range = variable.min === undefined ? "" : ` | ${variable.min}..${variable.max ?? ""}`;
    return `- ${variable.id} | ${variable.label} | ${String(variable.value)}${range}`;
  });
  const watch = snapshot.npcs.length === 0 ? "" : format(NPC_WATCH_BLOCK, { npc_lines: snapshot.npcs.map((npc) => `- ${npc.name} | ${npc.facts}`).join("\n") });
  return format(PROMPT, {
    max_whispers: MAX_WHISPERS,
    max_whisper_chars: MAX_WHISPER_CHARS,
    beats: BEATS.join(", "),
    trackers: trackers.join("\n") || "(none)",
    npc_watch: watch,
    tools: snapshot.toolsCalled.slice(0, MAX_TOOL_NAMES).join(", ") || "(none)",
    player: slice(snapshot.player, MAX_TURN_TEXT_CHARS),
    reply: slice(snapshot.reply, MAX_TURN_TEXT_CHARS),
  });
}

function extractJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function own(source: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(source, key) ? source[key] : undefined;
}

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * The quotation, whitespace-squashed, when it is literally in the reply (and long enough
 * to mean something); otherwise null. The haystack is the reply alone — the same slice the
 * model saw.
 */
function evidenced(raw: unknown, haystack: string): string | null {
  const quote = squash(typeof raw === "string" ? raw : "");
  return charCount(quote) >= MIN_EVIDENCE_CHARS && haystack.includes(quote) ? quote : null;
}

/** One model call, its reply validated. Never throws for the model's sake. */
export async function computeScribe(snapshot: ScribeSnapshot, services: Services, signal?: AbortSignal): Promise<ScribeProposal> {
  if (snapshot.reply.trim() === "") return empty("empty_reply");
  const prompt = buildPrompt(snapshot);
  let result: ChatResult;
  try {
    result = await withLane(SCRIBE_LANE, () => services.models.scribe.chat([{ role: "user", content: prompt }], signal === undefined ? {} : { signal }), { room: snapshot.room });
  } catch (error) {
    if (signal?.aborted === true || (error instanceof LLMError && error.code === "aborted")) return empty("aborted");
    return empty("model_failed");
  }
  const parsed = extractJson(result.content);
  return parsed === null ? empty("unparsed") : validateScribeReply(parsed, snapshot);
}

/** The model's JSON object against the snapshot: the evidence rule and every cap. */
export function validateScribeReply(parsed: Record<string, unknown>, snapshot: ScribeSnapshot): ScribeProposal {
  const haystack = squash(slice(snapshot.reply, MAX_TURN_TEXT_CHARS));
  const known = new Set(snapshot.variables.map((variable) => variable.id));
  const dropped: { -readonly [K in keyof ScribeDropped]: number } = { ...NONE_DROPPED };

  const ops: ScribeOp[] = [];
  const rawOps = own(parsed, "ops");
  for (const raw of Array.isArray(rawOps) ? rawOps : []) {
    if (ops.length >= MAX_OPS) {
      dropped.overCap += 1;
      continue;
    }
    const op = record(raw);
    const id = op === null ? undefined : own(op, "id");
    const kind = op === null ? undefined : own(op, "op");
    if (op === null || typeof id !== "string" || (kind !== "set" && kind !== "adjust")) {
      dropped.malformed += 1;
      continue;
    }
    if (!known.has(id)) {
      dropped.unknownVariable += 1;
      continue;
    }
    const evidence = evidenced(own(op, "evidence"), haystack);
    if (evidence === null) {
      dropped.noEvidence += 1;
      continue;
    }
    if (snapshot.moduleWrites.has(id)) {
      dropped.moduleOwned += 1;
      continue;
    }
    if (kind === "set") {
      const value = own(op, "value");
      if (typeof value !== "number" && typeof value !== "boolean" && typeof value !== "string") {
        dropped.malformed += 1;
        continue;
      }
      ops.push({ op: "set", id, value, evidence });
    } else {
      const delta = own(op, "delta");
      if (typeof delta !== "number" || !Number.isSafeInteger(delta)) {
        dropped.malformed += 1;
        continue;
      }
      ops.push({ op: "adjust", id, delta, evidence });
    }
  }

  const whispers: Whisper[] = [];
  const push = (whisper: Whisper): void => {
    if (whispers.length >= MAX_WHISPERS) dropped.overCap += 1;
    else whispers.push(whisper);
  };
  const rawWhispers = own(parsed, "whispers");
  for (const raw of Array.isArray(rawWhispers) ? rawWhispers : []) {
    const text = trimmed(raw);
    if (text === "") continue;
    if (charCount(text) > MAX_WHISPER_CHARS) dropped.tooLong += 1;
    else push({ kind: "note", text });
  }

  // An observation, never an instruction: the Keeper decides whether a roll was due.
  const unrolled = record(own(parsed, "unrolled_check"));
  if (unrolled !== null) {
    const skill = trimmed(own(unrolled, "skill"));
    const quote = evidenced(own(unrolled, "evidence"), haystack);
    if (skill !== "" && charCount(skill) <= MAX_SKILL_CHARS && quote !== null) push({ kind: "unrolled_check", skill, quote });
    else if (skill !== "" || own(unrolled, "evidence") !== undefined) dropped.noEvidence += 1;
  }

  // Consulted only when the watch was armed: a field volunteered for a room with no NPC
  // records is a hallucination, and the speaker must be one the pass showed a boundary for.
  const overreach = snapshot.npcs.length === 0 ? null : record(own(parsed, "npc_overreach"));
  if (overreach !== null) {
    const npc = trimmed(own(overreach, "npc"));
    const fact = trimmed(own(overreach, "fact"));
    const quote = evidenced(own(overreach, "quote"), haystack);
    const watched = snapshot.npcs.some((boundary) => boundary.name === npc);
    if (watched && fact !== "" && charCount(fact) <= MAX_OVERREACH_FACT_CHARS && charCount(npc) <= MAX_NPC_NAME_CHARS && quote !== null) push({ kind: "npc_overreach", npc, fact, quote });
    else dropped.noEvidence += 1;
  }

  const habitRaw = record(own(parsed, "habit"));
  const summary = habitRaw === null ? "" : trimmed(own(habitRaw, "summary"));
  const habit = summary === "" || habitRaw === null ? null : { summary, detail: trimmed(own(habitRaw, "detail")) };

  let chronicle: string | null = trimmed(own(parsed, "chronicle"));
  if (chronicle === "" || snapshot.keeperRecordedChronicle) chronicle = null;
  else if (charCount(chronicle) > MAX_AUTO_CHRONICLE_CHARS) {
    dropped.tooLong += 1;
    chronicle = null;
  }

  // A single word from a closed vocabulary, or nothing: anything else is discarded, never
  // forwarded, because this is the only thing that crosses to the player side.
  const beatRaw = trimmed(own(parsed, "beat"));
  const beat = isBeat(beatRaw) ? beatRaw : null;

  return { status: "ok", ops, whispers, habit, chronicle, beat, dropped };
}

// ---------------------------------------------------------------------------
// The modules' veto — the caller's exchange between compute and commit
// ---------------------------------------------------------------------------

/** The proposal's ops as the tool calls they stand for, for one veto exchange. */
export function scribeVetoCalls(proposal: ScribeProposal): ToolCall[] {
  return proposal.ops.map((op, index): ToolCall =>
    op.op === "set"
      ? { id: `scribe-${index}`, name: "set_variable", args: { var_id: op.id, value: op.value } }
      : { id: `scribe-${index}`, name: "adjust_variable", args: { var_id: op.id, delta: op.delta } },
  );
}

/** The ops the modules allowed. Only this type reaches `commitScribe`. */
export interface AllowedScribeOps {
  readonly ops: readonly ScribeOp[];
  /** How many a module refused. */
  readonly vetoed: number;
}

/**
 * The verdicts of the veto exchange applied to the proposal, one verdict per call of
 * `scribeVetoCalls`, in order. A missing verdict allows (the exchange fails open, like the
 * Keeper's).
 */
export function allowedScribeOps(proposal: ScribeProposal, verdicts: readonly ToolVerdict[]): AllowedScribeOps {
  const ops: ScribeOp[] = [];
  let vetoed = 0;
  proposal.ops.forEach((op, index) => {
    if (verdicts[index]?.allowed === false) vetoed += 1;
    else ops.push(op);
  });
  return { ops, vetoed };
}

/** For a room with no module code: nothing to ask. */
export function allowAllScribeOps(proposal: ScribeProposal): AllowedScribeOps {
  return { ops: proposal.ops, vetoed: 0 };
}

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

export type HabitResult = "none" | "observed" | "promoted" | "refused";

export type ScribeCommit =
  | {
      readonly status: "committed";
      /** A variable's value actually moved: views of the room's state are stale. */
      readonly variablesChanged: boolean;
      readonly opsApplied: number;
      /** Ops the variable rules refused (a value out of kind, a variable since removed). */
      readonly opsRefused: readonly { readonly id: string; readonly code: WriteRefusalCode | "no_variables" }[];
      readonly whispers: number;
      readonly habit: HabitResult;
      /** The id of the chronicle record written, or null. */
      readonly chronicleRecord: string | null;
      /** For the Stage Director: the enum, nothing else. */
      readonly beat: Beat | null;
    }
  | { readonly status: "stale" };

/** The id after the highest `c######` record id the room holds now. */
function nextChronicleRecordId(context: RoomContext): string | null {
  let highest = 0;
  for (const document of context.services.documents.list(context.room, CHRONICLE_RECORD_TYPE)) {
    const match = /^c(\d{6})$/.exec(document.id);
    if (match !== null) highest = Math.max(highest, Number(match[1]));
  }
  if (highest >= MAX_RECORD_SEQUENCE) return null;
  const id = chronicleRecordId(highest + 1);
  return id.ok ? id.data : null;
}

function applyOps(context: RoomContext, ops: readonly ScribeOp[]): { changed: boolean; applied: number; refused: { id: string; code: WriteRefusalCode | "no_variables" }[] } {
  const refusedAll = (code: "no_variables") => ({ changed: false, applied: 0, refused: ops.map((op) => ({ id: op.id, code })) });
  if (ops.length === 0) return { changed: false, applied: 0, refused: [] };
  const { documents } = context.services;
  const document = documents.get(context.room, MODULE_VARIABLES_TYPE, MODULE_VARIABLES_ID);
  // A corrupt document must never be rewritten as if blank.
  if (document === null || document.corrupt) return refusedAll("no_variables");
  let state: ModuleVariables = normalizeModuleVariables(document.data);
  let changed = false;
  let applied = 0;
  const refused: { id: string; code: WriteRefusalCode }[] = [];
  for (const op of ops) {
    const write = op.op === "set" ? setVariable(state, op.id, op.value) : adjustVariable(state, op.id, op.delta);
    if (write.outcome.status === "refused") {
      refused.push({ id: op.id, code: write.outcome.code });
      continue;
    }
    applied += 1;
    if (write.outcome.old !== write.outcome.value) changed = true;
    state = write.state;
  }
  if (changed) documents.put(context.writer, MODULE_VARIABLES_TYPE, MODULE_VARIABLES_ID, moduleVariablesPayload(state), document.meta);
  return { changed, applied, refused };
}

/**
 * Commit one pass through the context it was SCHEDULED with, in one synchronous block:
 * every write lands under `context.turn`, or — when the room has moved to another
 * generation since — none does and the result is `stale`.
 */
export function commitScribe(context: RoomContext, proposal: ScribeProposal, allowed: AllowedScribeOps): ScribeCommit {
  const { store, documents } = context.services;
  try {
    return store.transaction((): ScribeCommit => {
      // Checked first even when nothing would be written: a stale pass reports stale.
      if (!context.writer.current()) throw new StaleGeneration(context.room, context.writer.epoch, store.room(context.room).epoch);

      const ops = applyOps(context, allowed.ops);

      if (proposal.whispers.length > 0) {
        const queued = store.stateGet(context.room, WHISPERS_KEY) ?? [];
        const merged = [...queued, ...proposal.whispers];
        context.writer.statePut(WHISPERS_KEY, merged.slice(Math.max(0, merged.length - MAX_STORED_WHISPERS)));
      }

      let habit: HabitResult = "none";
      if (proposal.habit !== null) {
        const existing = documents.get(context.room, TABLE_HABITS_TYPE, TABLE_HABITS_ID);
        if (existing?.corrupt === true) habit = "refused";
        else {
          const observed = observeHabit(existing === null ? readTableHabits({}) : readTableHabits(existing.data), proposal.habit.summary, proposal.habit.detail);
          if (!observed.ok) habit = "refused";
          else {
            documents.put(context.writer, TABLE_HABITS_TYPE, TABLE_HABITS_ID, tableHabitsData(observed.data.habits));
            habit = observed.data.promoted ? "promoted" : "observed";
          }
        }
      }

      let chronicleRecord: string | null = null;
      if (proposal.chronicle !== null) {
        // The turn the pass was scheduled on — never a counter read now (the M21 trap).
        const record = newChronicleRecord({ text: proposal.chronicle }, context.turn);
        const id = record.ok ? nextChronicleRecordId(context) : null;
        if (record.ok && id !== null) {
          const data: JsonObject = chronicleRecordData(record.data);
          documents.put(context.writer, CHRONICLE_RECORD_TYPE, id, data, { source: "scribe" });
          chronicleRecord = id;
        }
      }

      return {
        status: "committed",
        variablesChanged: ops.changed,
        opsApplied: ops.applied,
        opsRefused: ops.refused,
        whispers: proposal.whispers.length,
        habit,
        chronicleRecord,
        beat: proposal.beat,
      };
    });
  } catch (error) {
    if (error instanceof StaleGeneration) return { status: "stale" };
    throw error;
  }
}
