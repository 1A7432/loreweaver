// The NPC actor lane: one model call that voices ONE non-player character, built from
// nothing but that character's own record and what the Keeper says about the moment.
//
// This is information isolation made structural (iron rule 3). The function is handed the
// STORED document and the document type, and projects it itself for the NPC as an actor
// (`actorViewer(document.id, …)`): the type gives an actor its own record whole and every
// other document at player grade, so there is no parameter through which a Keeper-grade
// view, another NPC, the Keeper's notes or any room state could reach the prompt. An NPC
// cannot leak what it was never told.
//
// Texts in a record imported from a card may hold macros or templates. This lane does not
// render them: the caller renders them first (the 2.6 server used the PLAYER view of the
// room's variables and discarded any template writes, `agent/card_text.py`) and passes the
// rendered texts in `rendered`. Without it the stored texts are used as they are.
//
// The actor only PERFORMS: a spoken line, an intent, a mood. It rolls no dice and decides
// no facts. The result is data; the CALLER commits it in its own synchronous stretch — the
// line becomes the NPC's narrative event, the intent a Keeper-only note (`npc_intents`),
// never part of the quotable line.
//
// The prompt is the 2.6 one, verbatim, from `server/locales/*/npc.json`.
import type { Document, DocumentType } from "../../core/documents/model.ts";
import { actorViewer } from "../../core/documents/model.ts";
import {
  MAX_DISPOSITION_CHARS,
  MAX_FACT_CHARS,
  MAX_PERSONA_CHARS,
  MAX_SECRET_AGENDA_CHARS,
  MAX_STYLE_CHARS,
  type NpcFullView,
  type NpcView,
} from "../../core/npcs/index.ts";
import { MAX_INTENT_CHARS } from "../../core/notes/index.ts";
import { translate } from "../../infra/i18n.ts";
import { type ChatMessage, type ChatResult, LLMError, type LLMErrorCode, withLane } from "../../infra/llm/index.ts";
import type { Services } from "../context.ts";
import { NPC_CATALOG } from "./npc_catalog.ts";

export const NPC_LANE = "npc";

export type NpcEffort = "low" | "medium" | "high";
export const NPC_EFFORTS: readonly NpcEffort[] = ["low", "medium", "high"];

/** What the Keeper may say about the moment, in code points. */
export const MAX_SITUATION_CHARS = 4_000;
/** Each of tone, target and allowed actions. */
export const MAX_HINT_CHARS = 500;
/** The spoken line the actor may return. */
export const MAX_LINE_CHARS = 4_000;
/** The mood the actor may return. */
export const MAX_MOOD_CHARS = 80;
/** The intent cap is the intent log's own, so a returned intent can always be recorded. */
export const MAX_ACTOR_INTENT_CHARS = MAX_INTENT_CHARS;

/**
 * The 2.6 prompt read `disposition or "neutral"`; a record's unset disposition is "". Text
 * for the model, so it is English and lives here.
 */
const DEFAULT_DISPOSITION = "neutral";

/**
 * Card texts the caller has already rendered (player view of variables, writes discarded).
 * A field left out uses the stored text. `knowledge`, when given, has one rendered fact for
 * each stored fact, in the same order.
 */
export interface RenderedNpcText {
  readonly persona?: string;
  readonly style?: string;
  readonly secretAgenda?: string;
  readonly disposition?: string;
  readonly knowledge?: readonly string[];
}

export interface NpcVoiceRequest {
  /** For the call's accounting only; the lane reads nothing of the room. */
  readonly room: string;
  /** The room's locale: the prompt is written in it, and the model answers in it. */
  readonly locale: string;
  /** The NPC's document as stored. Projected here, for the NPC itself. */
  readonly document: Document;
  /** The NPC document type (`npcDocument` from `core/npcs`). */
  readonly type: DocumentType<NpcView>;
  /** What is happening now, from this NPC's point of view. */
  readonly situation: string;
  readonly tone?: string;
  /** Who the NPC is speaking or reacting to. */
  readonly target?: string;
  /** What the NPC may do right now. */
  readonly allowedActions?: string;
  /** The line's dramatic weight, which sets the call's reasoning effort. Default `medium`. */
  readonly effort?: NpcEffort;
  readonly rendered?: RenderedNpcText;
  readonly signal?: AbortSignal;
}

export type NpcVoiceFailure =
  /** The document is not of the given type. */
  | "wrong_type"
  /** The document is corrupt, or its payload is not an NPC record. */
  | "unreadable"
  /** The type did not give the NPC its own whole record. */
  | "not_own_view"
  | "empty_situation"
  | "situation_too_long"
  | "hint_too_long"
  | "bad_effort"
  /** `rendered.knowledge` does not have one entry per stored fact. */
  | "rendered_mismatch"
  | "rendered_too_long"
  /** The call failed; `llm` holds the model error's code. */
  | "model_failed"
  | "aborted"
  /** The provider said the prompt does not fit the window. */
  | "context_overflow"
  /** The model or its provider refused to answer. */
  | "model_refused"
  /** The reply was cut off by the output cap before it was complete. */
  | "output_cap"
  /** The reply said nothing: no line, no intent, no mood. */
  | "empty_reply"
  /**
   * The reply looks like the expected JSON but could not be read, or is JSON of another
   * shape. Never spoken: a broken object may carry the private intent.
   */
  | "unparseable"
  /** A line, intent or mood over its cap. Refused, never cut. */
  | "reply_too_long";

export interface NpcVoice {
  readonly ok: true;
  /** The document id: the NPC the caller commits the line and the intent for. */
  readonly npc: string;
  readonly name: string;
  /** What the table hears. May be empty when the NPC only acts. */
  readonly line: string;
  /** Keeper-only: becomes an `npc_intents` note, never part of the line. "" when none. */
  readonly intent: string;
  readonly mood: string;
  /**
   * The reply was plain prose rather than the JSON asked for (as the 2.6 server did, it is
   * taken as the line, with no intent and no mood) — for the operator's log.
   */
  readonly degraded: boolean;
}

export type NpcVoiceResult =
  | NpcVoice
  | { readonly ok: false; readonly code: NpcVoiceFailure; readonly llm?: LLMErrorCode | "thrown" };

function codePoints(text: string): number {
  let count = 0;
  for (const _ of text) count++;
  return count;
}

function fits(text: string, max: number): boolean {
  return text.length <= max || codePoints(text) <= max;
}

function isFullView(view: NpcView): view is NpcFullView {
  const record = view as Partial<NpcFullView>;
  return (
    typeof record.persona === "string" &&
    typeof record.style === "string" &&
    typeof record.secretAgenda === "string" &&
    typeof record.disposition === "string" &&
    Array.isArray(record.knowledge)
  );
}

/** The record as the actor sees it, with any rendered texts in place of the stored ones. */
function actorRecord(
  view: NpcFullView,
  rendered: RenderedNpcText | undefined,
): { ok: true; npc: NpcFullView } | { ok: false; code: NpcVoiceFailure } {
  if (rendered === undefined) return { ok: true, npc: view };
  const knowledge = rendered.knowledge ?? view.knowledge;
  if (knowledge.length !== view.knowledge.length) return { ok: false, code: "rendered_mismatch" };
  const npc: NpcFullView = {
    ...view,
    persona: rendered.persona ?? view.persona,
    style: rendered.style ?? view.style,
    secretAgenda: rendered.secretAgenda ?? view.secretAgenda,
    disposition: rendered.disposition ?? view.disposition,
    knowledge: [...knowledge],
  };
  const caps: readonly (readonly [string, number])[] = [
    [npc.persona, MAX_PERSONA_CHARS],
    [npc.style, MAX_STYLE_CHARS],
    [npc.secretAgenda, MAX_SECRET_AGENDA_CHARS],
    [npc.disposition, MAX_DISPOSITION_CHARS],
    ...npc.knowledge.map((fact) => [fact, MAX_FACT_CHARS] as const),
  ];
  for (const [text, max] of caps) if (!fits(text, max)) return { ok: false, code: "rendered_too_long" };
  return { ok: true, npc };
}

function systemPrompt(locale: string, npc: NpcFullView, allowedActions: string): string {
  const t = (key: string, params: Readonly<Record<string, string | number>> = {}): string => translate(NPC_CATALOG, locale, key, params);
  const facts = npc.knowledge.map((fact) => fact.trim()).filter((fact) => fact !== "");
  return t("npc.actor_system", {
    name: npc.name,
    persona: npc.persona || t("npc.actor_system.no_persona"),
    style: npc.style || t("npc.actor_system.no_style"),
    secret_agenda: npc.secretAgenda || t("npc.actor_system.no_secret_agenda"),
    knowledge: facts.length === 0 ? t("npc.actor_system.no_knowledge") : facts.map((fact) => `- ${fact}`).join("\n"),
    disposition: npc.disposition || DEFAULT_DISPOSITION,
    allowed_actions_clause: allowedActions === "" ? "" : t("npc.actor_system.allowed_actions_clause", { allowed_actions: allowedActions }),
  });
}

function userMessage(locale: string, situation: string, tone: string, target: string): string {
  const parts = [situation];
  if (tone !== "") parts.push(translate(NPC_CATALOG, locale, "npc.actor_user.tone_line", { tone }));
  if (target !== "") parts.push(translate(NPC_CATALOG, locale, "npc.actor_user.target_line", { target }));
  return parts.join("\n");
}

const FENCE_OPEN = /^```[a-zA-Z]*\s*/u;
const FENCE_CLOSE = /\s*```$/u;
/** Any of these in a reply that did not parse means it tried to be the object asked for. */
const JSON_TRACES = /^\{|"(?:dialogue|action_intent|mood)"\s*:|\baction_intent\b/u;

function stripFence(content: string): string {
  return content.trim().replace(FENCE_OPEN, "").replace(FENCE_CLOSE, "").trim();
}

/** A JSON object in the reply, fenced or bare, with prose around it tolerated; else null. */
function extractObject(text: string): Readonly<Record<string, unknown>> | null {
  const candidates = [text];
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) candidates.push(text.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function field(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

type Parsed = { ok: true; line: string; intent: string; mood: string; degraded: boolean } | { ok: false; code: NpcVoiceFailure };

/** The reply read as the actor's performance. Never throws; never passes unexamined text on. */
export function parseNpcReply(result: Pick<ChatResult, "content" | "stopReason">): Parsed {
  if (result.stopReason === "context_window") return { ok: false, code: "context_overflow" };
  if (result.stopReason === "refused") return { ok: false, code: "model_refused" };
  const text = stripFence(result.content);
  const object = extractObject(text);
  let parsed: Parsed;
  if (object !== null) {
    if (!("dialogue" in object) && !("action_intent" in object) && !("mood" in object)) return { ok: false, code: "unparseable" };
    parsed = { ok: true, line: field(object.dialogue), intent: field(object.action_intent), mood: field(object.mood), degraded: false };
  } else {
    // A reply cut off by the output cap is incomplete whatever it looks like.
    if (result.stopReason === "output_cap") return { ok: false, code: "output_cap" };
    if (text === "") return { ok: false, code: "empty_reply" };
    if (JSON_TRACES.test(text)) return { ok: false, code: "unparseable" };
    // Plain prose: the 2.6 server took it as the line. It carries no intent to leak.
    parsed = { ok: true, line: text, intent: "", mood: "", degraded: true };
  }
  if (parsed.line === "" && parsed.intent === "" && parsed.mood === "") return { ok: false, code: "empty_reply" };
  if (!fits(parsed.line, MAX_LINE_CHARS) || !fits(parsed.intent, MAX_ACTOR_INTENT_CHARS) || !fits(parsed.mood, MAX_MOOD_CHARS)) {
    return { ok: false, code: "reply_too_long" };
  }
  return parsed;
}

/** Voice one NPC: one model call on the `npc` lane. Never throws; failures are codes. */
export async function voiceNpc(services: Pick<Services, "models">, request: NpcVoiceRequest): Promise<NpcVoiceResult> {
  const { document, type, locale } = request;
  if (document.type !== type.name) return { ok: false, code: "wrong_type" };
  if (document.corrupt) return { ok: false, code: "unreadable" };
  const view = type.project(document, actorViewer(document.id, locale));
  if (view === null) return { ok: false, code: "unreadable" };
  if (!isFullView(view)) return { ok: false, code: "not_own_view" };

  const situation = request.situation.trim();
  const tone = (request.tone ?? "").trim();
  const target = (request.target ?? "").trim();
  const allowedActions = (request.allowedActions ?? "").trim();
  if (situation === "") return { ok: false, code: "empty_situation" };
  if (!fits(situation, MAX_SITUATION_CHARS)) return { ok: false, code: "situation_too_long" };
  if (![tone, target, allowedActions].every((hint) => fits(hint, MAX_HINT_CHARS))) return { ok: false, code: "hint_too_long" };
  const effort = request.effort ?? "medium";
  if (!NPC_EFFORTS.includes(effort)) return { ok: false, code: "bad_effort" };

  const record = actorRecord(view, request.rendered);
  if (!record.ok) return record;

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt(locale, record.npc, allowedActions) },
    { role: "user", content: userMessage(locale, situation, tone, target) },
  ];
  let result: ChatResult;
  try {
    result = await withLane(
      NPC_LANE,
      () =>
        services.models.npc.chat(messages, {
          reasoningEffort: effort,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        }),
      { room: request.room, npc: document.id },
    );
  } catch (error) {
    if (request.signal?.aborted === true || (error instanceof LLMError && error.code === "aborted")) return { ok: false, code: "aborted" };
    if (error instanceof LLMError && error.code === "context_overflow") return { ok: false, code: "context_overflow", llm: error.code };
    return { ok: false, code: "model_failed", llm: error instanceof LLMError ? error.code : "thrown" };
  }

  const parsed = parseNpcReply(result);
  if (!parsed.ok) return parsed;
  return { ok: true, npc: document.id, name: view.name, line: parsed.line, intent: parsed.intent, mood: parsed.mood, degraded: parsed.degraded };
}
