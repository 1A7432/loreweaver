// What NPC actors said they intend to do. When an NPC actor speaks it may also state an
// intent for the Keeper to stage ("slip out the back once they are distracted"). That is
// staging information: the Keeper reads it, the table never does, and it is not the NPC's
// line to quote. So the log exists for the Keeper alone — every other view, an NPC actor's
// included, is null.
//
// Payload `{ intents: [{ npc, intent, at }] }`, oldest first: `npc` the NPC's document id,
// `at` the game clock's text, or null.
//
// The log keeps the latest `MAX_INTENT_LOG` intents. Unlike every other list in these
// payloads it rolls instead of refusing: it is written automatically after each NPC line,
// and refusing once full would silently stop recording exactly the intents that matter —
// the newest. A single intent over its length cap is still refused.
import type { Document, DocumentType, JsonObject, Viewer, WriteViolation } from "../documents/model.ts";
import { MAX_NOTE_AT_CHARS } from "./keeper_notes.ts";
import { cleanText, isRecord, onlyKeys } from "./text.ts";

export const NPC_INTENTS_TYPE = "npc_intents";
export const NPC_INTENTS_ID = "intents";

/** Intents kept for the whole room (the newest ones). */
export const MAX_INTENT_LOG = 20;
/** One intent, in code points. */
export const MAX_INTENT_CHARS = 500;
/** An NPC document id. */
export const MAX_INTENT_NPC_ID_CHARS = 64;

export type NpcIntent = { readonly npc: string; readonly intent: string; readonly at: string | null };
export type IntentLog = { readonly intents: readonly NpcIntent[] };

export const EMPTY_INTENTS: IntentLog = Object.freeze({ intents: Object.freeze([]) });

export type IntentRefusal = "bad_npc" | "bad_intent" | "bad_at";

export type IntentChange = { readonly ok: true; readonly data: IntentLog } | { readonly ok: false; readonly code: IntentRefusal };

/** Record what `npc` intends; the oldest intent drops out once the log is full. */
export function recordIntent(log: IntentLog, npc: string, intent: string, at: string | null): IntentChange {
  if (cleanText(npc, MAX_INTENT_NPC_ID_CHARS) !== npc) return { ok: false, code: "bad_npc" };
  const text = cleanText(intent, MAX_INTENT_CHARS);
  if (text === null) return { ok: false, code: "bad_intent" };
  if (at !== null && cleanText(at, MAX_NOTE_AT_CHARS) !== at) return { ok: false, code: "bad_at" };
  const intents = [...log.intents, Object.freeze({ npc, intent: text, at })].slice(-MAX_INTENT_LOG);
  return { ok: true, data: Object.freeze({ intents: Object.freeze(intents) }) };
}

/** What `npc` said it intends, oldest first. */
export function intentsOf(log: IntentLog, npc: string): readonly NpcIntent[] {
  return log.intents.filter((item) => item.npc === npc);
}

export function intentLogData(log: IntentLog): JsonObject {
  return { intents: log.intents.map((item) => ({ npc: item.npc, intent: item.intent, at: item.at })) };
}

/** A stored log read back; null when malformed. */
export function readIntentLog(data: JsonObject): IntentLog | null {
  if (!Array.isArray(data.intents)) return null;
  const intents: NpcIntent[] = [];
  for (const item of data.intents) {
    if (!isRecord(item) || typeof item.npc !== "string" || typeof item.intent !== "string" || (item.at !== null && typeof item.at !== "string")) return null;
    intents.push(Object.freeze({ npc: item.npc, intent: item.intent, at: item.at }));
  }
  return Object.freeze({ intents: Object.freeze(intents) });
}

export type IntentLogView = IntentLog;

function projectIntents(document: Document, viewer: Viewer): IntentLogView | null {
  if (viewer.grade !== "keeper") return null;
  return readIntentLog(document.data);
}

function validateIntents(data: JsonObject): WriteViolation[] {
  const extra = onlyKeys(data, ["intents"]);
  if (extra !== null) return [{ code: "unknown_field", path: extra }];
  if (!Array.isArray(data.intents)) return [{ code: "bad_intents", path: "intents" }];
  const violations: WriteViolation[] = [];
  if (data.intents.length > MAX_INTENT_LOG) violations.push({ code: "too_many_intents", path: "intents" });
  data.intents.forEach((item, index) => {
    const path = `intents.${index}`;
    if (!isRecord(item) || onlyKeys(item, ["npc", "intent", "at"]) !== null) {
      violations.push({ code: "bad_entry", path });
      return;
    }
    if (typeof item.npc !== "string" || cleanText(item.npc, MAX_INTENT_NPC_ID_CHARS) !== item.npc) violations.push({ code: "bad_npc", path: `${path}.npc` });
    if (typeof item.intent !== "string" || cleanText(item.intent, MAX_INTENT_CHARS) !== item.intent) violations.push({ code: "bad_intent", path: `${path}.intent` });
    if (item.at !== null && (typeof item.at !== "string" || cleanText(item.at, MAX_NOTE_AT_CHARS) !== item.at)) violations.push({ code: "bad_at", path: `${path}.at` });
  });
  return violations;
}

export const npcIntentsDocument: DocumentType<IntentLogView> = {
  name: NPC_INTENTS_TYPE,
  lifecycle: { reset: "story" },
  version: 1,
  project: projectIntents,
  validate: validateIntents,
};
