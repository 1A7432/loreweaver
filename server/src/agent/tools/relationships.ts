// Relationship tracks (gated: a skill such as romance-relationships unlocks them).
// Iron rule 1: the values are `core/relationships`' — bounded and stored there; the model
// narrates around them.
import {
  adjustRelationship,
  changedRelationships,
  MAX_RELATIONSHIP_NAME_CHARS,
  MAX_RELATIONSHIP_ROWS,
  NO_RELATIONSHIPS,
  readRelationships,
  RELATIONSHIP_TRACKS,
  type RelationshipChange,
  relationshipsData,
  RELATIONSHIPS_ID,
  RELATIONSHIPS_TYPE,
  setRelationship,
} from "../../core/relationships/index.ts";
import type { RoomContext } from "../context.ts";
import { param } from "./params.ts";
import { getDocument, putDocument, refuse } from "./shared.ts";
import { defineTool, type ToolResult } from "./types.ts";

const TRACK_NAMES = [...RELATIONSHIP_TRACKS.keys()];

function readState(context: RoomContext): { readonly state: ReturnType<typeof readRelationships>; readonly document: ReturnType<typeof getDocument> } {
  const document = getDocument(context, RELATIONSHIPS_TYPE, RELATIONSHIPS_ID);
  return { state: document === null || document.corrupt ? NO_RELATIONSHIPS : readRelationships(document.data), document };
}

const RELATIONSHIP_REFUSALS: Readonly<Record<string, string>> = {
  unknown_track: `Unknown relationship track. Allowed tracks: ${TRACK_NAMES.join(", ")}.`,
  not_an_integer: "That value isn't a usable whole number.",
  empty: "The subject and target must both be named.",
  too_long: `A name must be at most ${MAX_RELATIONSHIP_NAME_CHARS} characters.`,
  limit_reached: `This room already tracks ${MAX_RELATIONSHIP_ROWS} relationships.`,
};

function store(context: RoomContext, document: ReturnType<typeof getDocument>, change: RelationshipChange): { ok: true; old: number; value: number } | { ok: false; result: ToolResult } {
  if (!change.ok) return { ok: false, result: refuse(change.code, RELATIONSHIP_REFUSALS[change.code] ?? change.code) };
  putDocument(context, RELATIONSHIPS_TYPE, RELATIONSHIPS_ID, relationshipsData(change.data), document);
  return { ok: true, old: change.old, value: change.value };
}

export const adjustRelationshipTool = defineTool({
  name: "adjust_relationship",
  description:
    "Nudge a deterministic relationship track `subject` feels toward `target` by a signed delta. Two tracks exist: \"affection\" (好感, clamps to -100..100) and \"desire\" (情欲, clamps to 0..100). Call this after a meaningful romantic/social beat actually happens in play (a kind gesture, a betrayal, a shared danger survived, a flirtation that lands) -- the number should inform your narration's tone, never the other way around; dice/checks still resolve what actually happens.",
  params: {
    // Carried over with one mention changed: AI companions are not in 3.0.
    subject: param.string("The entity whose feeling is being adjusted (a PC/NPC's name)."),
    target: param.string("The entity the feeling is directed toward."),
    track: param.string("Which track to adjust: \"affection\" or \"desire\"."),
    delta: param.integer("Signed integer change to apply (e.g. 5, -10)."),
    reason: param.string("Optional free-text note on why, for your own bookkeeping; not required.").or(""),
  },
  flags: { gated: true },
  suspends: null,
  run(context, args): ToolResult {
    const { state, document } = readState(context);
    const track = args.track.trim().toLowerCase();
    const stored = store(context, document, adjustRelationship(state, args.subject, args.target, track, args.delta));
    if (!stored.ok) return stored.result;
    return { text: `${args.subject.trim()} → ${args.target.trim()} ${track}: ${stored.old} → ${stored.value} (change: ${args.delta}).` };
  },
});

export const setRelationshipTool = defineTool({
  name: "set_relationship",
  description:
    "Set a deterministic relationship track to an exact value (rather than nudging it by a delta). Two tracks exist: \"affection\" (好感, clamps to -100..100) and \"desire\" (情欲, clamps to 0..100).",
  params: {
    subject: param.string("The entity whose feeling is being set (a PC/NPC's name)."),
    target: param.string("The entity the feeling is directed toward."),
    track: param.string("Which track to set: \"affection\" or \"desire\"."),
    value: param.integer("The exact value to store (clamped to the track's valid range)."),
  },
  flags: { gated: true },
  suspends: null,
  run(context, args): ToolResult {
    const { state, document } = readState(context);
    const track = args.track.trim().toLowerCase();
    const stored = store(context, document, setRelationship(state, args.subject, args.target, track, args.value));
    if (!stored.ok) return stored.result;
    return { text: `${args.subject.trim()} → ${args.target.trim()} ${track} set to ${stored.value}.` };
  },
});

export const getRelationshipsTool = defineTool({
  name: "get_relationships",
  // Carried over with one mention removed: the reference module path it cited.
  description:
    "Read back current deterministic relationship tracks, optionally filtered to one entity. This is the read-on-demand path (the KP's system prompt already shows the current state every turn, so this is for double-checking a specific entity or the full picture mid-conversation).",
  params: {
    entity: param
      .string(
        "Optional entity name; when given, only pairs where it appears (case- insensitively, substring match) as subject or target are returned. Empty returns every tracked pair.",
      )
      .or(""),
  },
  flags: { gated: true, readOnly: true },
  suspends: null,
  run(context, args): ToolResult {
    const needle = args.entity.trim().toLowerCase();
    const rows = changedRelationships(readState(context).state).filter(
      (row) => needle === "" || row.subject.toLowerCase().includes(needle) || row.target.toLowerCase().includes(needle),
    );
    if (rows.length === 0) return { text: "No relationship tracks recorded yet." };
    // One line per pair, its tracks together, in the sorted order the core gives.
    const pairs = new Map<string, { subject: string; target: string; tracks: string[] }>();
    for (const row of rows) {
      const key = JSON.stringify([row.subject, row.target]);
      const pair = pairs.get(key) ?? { subject: row.subject, target: row.target, tracks: [] };
      pair.tracks.push(`${row.track} ${row.value}`);
      pairs.set(key, pair);
    }
    return { text: ["Current relationships:", ...[...pairs.values()].map((pair) => `- ${pair.subject} → ${pair.target}: ${pair.tracks.join(", ")}`)].join("\n") };
  },
});
