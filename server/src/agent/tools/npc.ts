// NPC tools: create and change NPC records, read them (Keeper-only: they carry secrets),
// and hand one NPC's line to its knowledge-scoped actor.
//
// Iron rule 3: `speak_as_npc` passes the actor lane this NPC's own document and nothing
// else; the lane builds the prompt from it alone. The line the table hears is the
// narrative EVENT this tool returns on success — never its text for the model, so a
// refusal can never be spoken as the NPC — and the actor's private intent goes to the
// Keeper-only `npc_intents` log, never into the line.
import { CHARACTER_TYPE, CLAIMABLE_ID, CLAIMABLE_TYPE, readClaimable } from "../../core/characters/index.ts";
import type { Document } from "../../core/documents/model.ts";
import { EMPTY_INTENTS, intentLogData, NPC_INTENTS_ID, NPC_INTENTS_TYPE, readIntentLog, recordIntent } from "../../core/notes/index.ts";
import {
  createNpc,
  learn,
  MAX_DISPOSITION_CHARS,
  MAX_FACT_CHARS,
  MAX_KNOWLEDGE_FACTS,
  MAX_LOCATION_CHARS,
  MAX_NPC_NAME_CHARS,
  MAX_PERSONA_CHARS,
  MAX_PUBLIC_DESCRIPTION_CHARS,
  MAX_SECRET_AGENDA_CHARS,
  MAX_STYLE_CHARS,
  moveNpc,
  type Npc,
  type NpcChange,
  npcData,
  npcSlug,
  NPC_TYPE,
  readNpc,
  setDisposition,
} from "../../core/npcs/index.ts";
import type { RoomContext } from "../context.ts";
import { param } from "./params.ts";
import { clockText, getDocument, listDocuments, putDocument, refuse } from "./shared.ts";
import { defineTool, type NpcEffort, type ToolResult } from "./types.ts";

/** Put at the top of every result that shows an NPC's secrets. */
export const KEEPER_BANNER = "[KEEPER-ONLY — internal reasoning material, including secrets. Never quote, paraphrase, or reveal this to players.]";

/** How many numbered ids (`name-2`, `name-3`, …) are tried for a name whose id is taken. */
const MAX_ID_SUFFIX = 999;

interface NpcRecord {
  readonly id: string;
  readonly document: Document;
  readonly npc: Npc;
}

function npcRecords(context: RoomContext): NpcRecord[] {
  const records: NpcRecord[] = [];
  for (const document of listDocuments(context, NPC_TYPE)) {
    if (document.corrupt) continue;
    const npc = readNpc(document.data);
    if (npc !== null) records.push({ id: document.id, document, npc });
  }
  return records;
}

function fold(text: string): string {
  return text.trim().toLowerCase();
}

/**
 * The NPC a model's reference names: exact id, then exact name (case-insensitive), then
 * the name's id, then a name containing it. Exact name outranks the id derived from a
 * name, so two names that slug alike never shadow each other.
 */
export function findNpc(context: RoomContext, reference: string): NpcRecord | null {
  const wanted = fold(reference);
  if (wanted === "") return null;
  const records = npcRecords(context);
  return (
    records.find((record) => record.id === reference.trim()) ??
    records.find((record) => fold(record.npc.name) === wanted) ??
    records.find((record) => record.id === npcSlug(reference)) ??
    records.find((record) => fold(record.npc.name).includes(wanted)) ??
    null
  );
}

/** The names of the room's player characters and claimable cast, case-folded: never NPCs. */
function playerNames(context: RoomContext): Set<string> {
  const names = new Set<string>();
  for (const document of listDocuments(context, CHARACTER_TYPE)) {
    const sheet = document.data.sheet;
    const name = typeof sheet === "object" && sheet !== null && !Array.isArray(sheet) ? (sheet as { name?: unknown }).name : undefined;
    if (typeof name === "string") names.add(fold(name));
  }
  const claimable = getDocument(context, CLAIMABLE_TYPE, CLAIMABLE_ID);
  const list = claimable === null || claimable.corrupt ? null : readClaimable(claimable.data);
  for (const entry of list?.characters ?? []) names.add(fold(entry.name));
  return names;
}

const NPC_REFUSALS: Readonly<Record<string, string>> = {
  bad_name: `The NPC's name must be 1-${MAX_NPC_NAME_CHARS} characters and contain a letter or digit.`,
  bad_public_description: `The description must be at most ${MAX_PUBLIC_DESCRIPTION_CHARS} characters.`,
  bad_persona: `The persona must be at most ${MAX_PERSONA_CHARS} characters.`,
  bad_style: `The speech style must be at most ${MAX_STYLE_CHARS} characters.`,
  bad_secret_agenda: `The secret agenda must be at most ${MAX_SECRET_AGENDA_CHARS} characters.`,
  bad_fact: `Each fact must be 1-${MAX_FACT_CHARS} characters.`,
  knowledge_full: `An NPC knows at most ${MAX_KNOWLEDGE_FACTS} facts.`,
  bad_disposition: `The disposition must be at most ${MAX_DISPOSITION_CHARS} characters.`,
  bad_location: `The location must be at most ${MAX_LOCATION_CHARS} characters.`,
};

function refusedChange(change: Extract<NpcChange, { ok: false }>): ToolResult {
  return refuse(change.code, `Refused: ${NPC_REFUSALS[change.code] ?? change.code} Nothing was changed.`);
}

function notFound(reference: string): ToolResult {
  return refuse("npc_not_found", `No NPC found matching "${reference}".`);
}

function splitFacts(text: string): string[] {
  return text
    .split(/[,\n]+/u)
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

/** Create an NPC record, or hand back the one that already has this name. */
function create(context: RoomContext, draft: Parameters<typeof createNpc>[0]): ToolResult {
  const name = draft.name.trim();
  if (playerNames(context).has(fold(name))) {
    return refuse(
      "name_is_player",
      `"${name}" is a PLAYER character in this room (has a character sheet here, or is on the claimable cast) — a player is never an NPC. Address them by narration; their sheet is theirs.`,
    );
  }
  const records = npcRecords(context);
  // The model's history keeps only final replies, so a later turn may "create" an NPC it
  // seeded before: the seeded record (with its secrets and knowledge) is never shadowed.
  const existing = records.find((record) => fold(record.npc.name) === fold(name));
  if (existing !== undefined) return { text: `NPC "${existing.npc.name}" (id: ${existing.id}) already exists; its record was left untouched.` };
  const change = createNpc({ ...draft, name });
  if (!change.ok) return refusedChange(change);
  const base = npcSlug(name);
  if (base === null) return refusedChange({ ok: false, code: "bad_name" });
  const taken = new Set(listDocuments(context, NPC_TYPE).map((document) => document.id));
  let id = base;
  for (let suffix = 2; taken.has(id); suffix++) {
    if (suffix > MAX_ID_SUFFIX) return refuse("too_many_namesakes", `Too many NPCs share the id "${base}"; choose a more distinct name.`);
    id = `${base}-${suffix}`;
  }
  putDocument(context, NPC_TYPE, id, npcData(change.data), null);
  return { text: `Created NPC "${change.data.name}" (id: ${id}).` };
}

export const createNpcTool = defineTool({
  name: "create_npc",
  // Carried over verbatim but for one mention: the two follow-up tools it named
  // (`update_npc`, `set_npc_knowledge`) are not in 3.0; `npc_learns` is what appends now.
  description:
    "Create a new AI-played NPC, scoped to this room, seeding the WHOLE record in this one call -- pass persona, secret_agenda, knowledge, disposition and location together here rather than chaining npc_learns calls afterwards. Re-creating an existing name returns that record untouched (never a duplicate). Only major NPCs need this + speak_as_npc; voice trivial/one-line NPCs yourself inline instead of creating a record for every extra.",
  params: {
    name: param.string("The NPC's name (their id is derived from it, deduplicated per room)."),
    persona: param.string("Who they are -- voice, mannerisms, goals.").or(""),
    description: param.string("What players can openly see/know about them.").or(""),
    secret_agenda: param.string("The NPC's own private goal/secret (never auto-shown to players).").or(""),
    knowledge: param
      .string(
        "Comma- or newline-separated discrete facts this NPC currently knows -- their whole epistemic world; they will never be able to reveal anything outside this list.",
      )
      .or(""),
    disposition: param.string("Attitude toward the party.").or("neutral"),
    location: param.string("Where the NPC currently is.").or(""),
    major: param.boolean("Whether this NPC gets the AI actor (True) vs. is voiced inline by you (False).").or(true),
  },
  flags: {},
  suspends: null,
  run(context, args): ToolResult {
    return create(context, {
      name: args.name,
      persona: args.persona,
      publicDescription: args.description,
      secretAgenda: args.secret_agenda,
      knowledge: splitFacts(args.knowledge),
      disposition: args.disposition,
      location: args.location,
      // In the reference server a location was public NPC data.
      locationKnown: args.location.trim() !== "",
      major: args.major,
    });
  },
});

export const sketchNpcTool = defineTool({
  name: "sketch_npc",
  description:
    "Improvise an NPC on the spot in one line, so you can immediately speak_as_npc them. For the shopkeeper the players just walked up to. Use create_npc instead when you are writing a module-grade character with secrets and knowledge.",
  params: {
    name: param.string("The NPC's name."),
    one_line: param.string("Who they are in one line -- voice, manner, what they want."),
  },
  flags: {},
  suspends: null,
  run(context, args): ToolResult {
    // Not a convenience: without a record there is no knowledge-scoped actor, and what an
    // improvised NPC learns later would have no structural home (iron rule 3).
    return create(context, { name: args.name, persona: args.one_line, major: true });
  },
});

function changeNpc(context: RoomContext, reference: string, apply: (npc: Npc) => NpcChange, done: (npc: Npc) => string): ToolResult {
  const record = findNpc(context, reference);
  if (record === null) return notFound(reference);
  const change = apply(record.npc);
  if (!change.ok) return refusedChange(change);
  putDocument(context, NPC_TYPE, record.id, npcData(change.data), record.document);
  return { text: done(change.data) };
}

export const npcLearnsTool = defineTool({
  name: "npc_learns",
  description: "Have an NPC learn exactly one new fact during play (appended to their knowledge).",
  params: {
    npc: param.string("The NPC's name or id."),
    fact: param.string("The single fact they just learned."),
  },
  flags: {},
  suspends: null,
  run(context, args): ToolResult {
    return changeNpc(context, args.npc, (npc) => learn(npc, args.fact), (npc) => `${npc.name} learned: ${args.fact.trim()}`);
  },
});

export const setNpcDispositionTool = defineTool({
  name: "set_npc_disposition",
  description: "Set an NPC's attitude toward the party.",
  params: {
    npc: param.string("The NPC's name or id."),
    disposition: param.string("The new disposition (free text, e.g. \"hostile\", \"friendly but wary\")."),
  },
  flags: {},
  suspends: null,
  run(context, args): ToolResult {
    return changeNpc(context, args.npc, (npc) => setDisposition(npc, args.disposition), (npc) => `${npc.name}'s disposition is now: ${npc.disposition}`);
  },
});

export const moveNpcTool = defineTool({
  name: "move_npc",
  description: "Move an NPC to a new location.",
  params: {
    npc: param.string("The NPC's name or id."),
    location: param.string("The NPC's new location."),
  },
  flags: {},
  suspends: null,
  run(context, args): ToolResult {
    return changeNpc(context, args.npc, (npc) => moveNpc(npc, args.location, args.location.trim() !== ""), (npc) => `${npc.name} moved to: ${npc.location}`);
  },
});

function detail(record: NpcRecord): string {
  const npc = record.npc;
  const lines = [
    `NPC: ${npc.name} (id: ${record.id})`,
    `Persona: ${npc.persona || "(none)"}`,
    `Speech style: ${npc.style || "(none)"}`,
    `Public description: ${npc.publicDescription || "(none)"}`,
    `Secret agenda: ${npc.secretAgenda || "(none)"}`,
    `Disposition: ${npc.disposition || "(none)"}`,
    `Location: ${npc.location || "unknown"}${npc.location !== "" && !npc.locationKnown ? " (the table does not know it)" : ""}`,
    `Major (has AI actor): ${npc.major ? "yes" : "no"}`,
  ];
  if (npc.knowledge.length === 0) lines.push("Knowledge: (none yet)");
  else lines.push(`Knowledge (${npc.knowledge.length} facts):`, ...npc.knowledge.map((fact) => `  - ${fact}`));
  return lines.join("\n");
}

export const getNpcTool = defineTool({
  name: "get_npc",
  description:
    "Get an NPC's full record, INCLUDING secret_agenda and knowledge (KEEPER-ONLY -- for your own reasoning, never quote raw to players).",
  params: {
    npc: param.string("The NPC's name or id."),
  },
  flags: { keeperOnly: true, readOnly: true },
  suspends: null,
  run(context, args): ToolResult {
    const record = findNpc(context, args.npc);
    if (record === null) return notFound(args.npc);
    return { text: `${KEEPER_BANNER}\n\n${detail(record)}` };
  },
});

export const listNpcsTool = defineTool({
  name: "list_npcs",
  description: "List every NPC in this room, INCLUDING secrets (KEEPER-ONLY -- for your own reasoning, never quote raw to players).",
  params: {},
  flags: { keeperOnly: true, readOnly: true },
  suspends: null,
  run(context): ToolResult {
    const records = npcRecords(context);
    if (records.length === 0) return { text: `${KEEPER_BANNER}\n\nNo NPCs recorded yet. Use create_npc or sketch_npc.` };
    const lines = [`NPC roster (${records.length}):`];
    for (const { id, npc } of records) {
      lines.push(`- ${npc.name} [${id}] @ ${npc.location || "unknown"} — disposition: ${npc.disposition || "(none)"}, major: ${npc.major ? "yes" : "no"}`);
    }
    return { text: `${KEEPER_BANNER}\n\n${lines.join("\n")}` };
  },
});

const EFFORTS: ReadonlySet<string> = new Set<NpcEffort>(["low", "medium", "high"]);

export const speakAsNpcTool = defineTool({
  name: "speak_as_npc",
  description:
    "Delegate one NPC's in-character line to their knowledge-scoped AI sub-actor. The sub-actor sees ONLY this NPC's own persona/knowledge -- never the keeper pool or other NPCs' secrets -- so it structurally cannot leak or act on information this NPC doesn't have. Weave the returned line into your narration yourself: your narration is all you will remember of this scene next turn, even though the table also sees the line as the NPC's own message. The actor never rolls dice or invents world facts, so adjudicate any resulting mechanics via the normal dice/check tools.",
  params: {
    npc: param.string("The NPC's name or id."),
    situation: param.string("What is happening right now, from this NPC's point of view."),
    allowed_actions: param.string("Optional constraint on what the NPC may do right now.").or(""),
    tone: param.string("Optional tone hint (e.g. \"nervous\", \"defiant\").").or(""),
    target: param.string("Optional name of who the NPC is speaking/reacting to.").or(""),
    effort: param
      .string(
        "The line's dramatic weight, which sets the sub-actor's thinking depth -- \"low\" for routine/filler lines, \"medium\" (default) for normal beats, \"high\" for confessions, climaxes, and lines that must thread a secret.",
      )
      .or("medium"),
  },
  flags: { concurrentBy: "npc" },
  suspends: "model",
  async run(context, args, turn): Promise<ToolResult> {
    const voice = turn.deps.voiceNpc;
    if (voice === undefined) return refuse("npc_actor_unavailable", "NPC actors are not available on this server; voice the NPC yourself in your narration.");
    const record = findNpc(context, args.npc);
    if (record === null) return notFound(args.npc);
    const effort = args.effort.trim().toLowerCase();
    const voiced = await voice({
      room: context.room,
      locale: context.locale,
      npc: record.id,
      document: record.document,
      situation: args.situation,
      allowedActions: args.allowed_actions,
      tone: args.tone,
      target: args.target,
      effort: EFFORTS.has(effort) ? (effort as NpcEffort) : "medium",
    });
    if (!voiced.ok) return { status: "failed", code: voiced.code, text: `Failed to voice NPC ${record.npc.name} (${voiced.code}); voice them yourself this time.` };

    // Resumed: everything below is one synchronous stretch. The intent log is read now,
    // after the model call, never before it.
    const name = record.npc.name;
    const mood = voiced.mood.trim() === "" ? "neutral" : voiced.mood.trim();
    const line = voiced.line.trim();
    let intentNote = "";
    if (voiced.intent.trim() !== "") {
      const document = getDocument(context, NPC_INTENTS_TYPE, NPC_INTENTS_ID);
      const log = document === null || document.corrupt ? EMPTY_INTENTS : (readIntentLog(document.data) ?? EMPTY_INTENTS);
      const change = recordIntent(log, record.id, voiced.intent, clockText(context));
      if (change.ok) {
        putDocument(context, NPC_INTENTS_TYPE, NPC_INTENTS_ID, intentLogData(change.data), document);
        intentNote = "\n(Their private intent was filed to your npc_intents notes: kp_note('list', 'npc_intents').)";
      }
    }
    if (line === "") return { text: `${name} (${mood}) says nothing.${intentNote}` };
    return {
      text: `${name} (${mood}): "${line}"${intentNote}`,
      events: [{ kind: "narrative", data: { speaker: "npc", name, text: line, format: "plain" } }],
    };
  },
});
