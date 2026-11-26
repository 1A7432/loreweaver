// The scene card: what the table is looking at. The one part of the Keeper's notebook
// written FOR the table — the scene's name, what the table is doing now, and the facts the
// Keeper has explicitly established for the table ("the mill burned down on the 3rd").
// Everything here is table-facing text by construction; the Keeper's own working notes
// live in `keeper_notes.ts` and never reach a player.
//
// Payload `{ name, focus, established: [{ text, at }] }`; `name` and `focus` are "" when
// unset, `at` is the game clock's text when the fact was established, or null.
//   - every viewer: the name, the focus and the established facts.
import type { Document, DocumentType, JsonObject, Viewer, WriteViolation } from "../documents/model.ts";
import { MAX_NOTE_AT_CHARS, noteViolations } from "./keeper_notes.ts";
import { cleanOptionalText, cleanText, isRecord, onlyKeys } from "./text.ts";

export const SCENE_TYPE = "scene";
export const SCENE_ID = "scene";

/** In code points, each. */
export const MAX_SCENE_NAME_CHARS = 120;
export const MAX_SCENE_FOCUS_CHARS = 280;
export const MAX_ESTABLISHED_FACTS = 64;
export const MAX_ESTABLISHED_FACT_CHARS = 280;

export type EstablishedFact = { readonly text: string; readonly at: string | null };
export type Scene = { readonly name: string; readonly focus: string; readonly established: readonly EstablishedFact[] };

export const EMPTY_SCENE: Scene = Object.freeze({ name: "", focus: "", established: Object.freeze([]) });

export type SceneRefusal = "bad_name" | "bad_focus" | "bad_fact" | "bad_at" | "facts_full" | "unknown_fact";

export type SceneChange = { readonly ok: true; readonly data: Scene } | { readonly ok: false; readonly code: SceneRefusal };

/** Name the scene; "" clears it. */
export function setSceneName(scene: Scene, name: string): SceneChange {
  const text = cleanOptionalText(name, MAX_SCENE_NAME_CHARS);
  if (text === null) return { ok: false, code: "bad_name" };
  return { ok: true, data: Object.freeze({ ...scene, name: text }) };
}

/** Say what the table is doing now; "" clears it. */
export function setSceneFocus(scene: Scene, focus: string): SceneChange {
  const text = cleanOptionalText(focus, MAX_SCENE_FOCUS_CHARS);
  if (text === null) return { ok: false, code: "bad_focus" };
  return { ok: true, data: Object.freeze({ ...scene, focus: text }) };
}

/** Establish a fact for the table; one already established leaves the scene as it was. */
export function establishFact(scene: Scene, text: string, at: string | null): SceneChange {
  const clean = cleanText(text, MAX_ESTABLISHED_FACT_CHARS);
  if (clean === null) return { ok: false, code: "bad_fact" };
  if (at !== null && cleanText(at, MAX_NOTE_AT_CHARS) !== at) return { ok: false, code: "bad_at" };
  if (scene.established.some((fact) => fact.text === clean)) return { ok: true, data: scene };
  if (scene.established.length >= MAX_ESTABLISHED_FACTS) return { ok: false, code: "facts_full" };
  return { ok: true, data: Object.freeze({ ...scene, established: Object.freeze([...scene.established, Object.freeze({ text: clean, at })]) }) };
}

/** Withdraw an established fact (by its text). */
export function retractFact(scene: Scene, text: string): SceneChange {
  const clean = text.trim();
  if (!scene.established.some((fact) => fact.text === clean)) return { ok: false, code: "unknown_fact" };
  return { ok: true, data: Object.freeze({ ...scene, established: Object.freeze(scene.established.filter((fact) => fact.text !== clean)) }) };
}

export function sceneData(scene: Scene): JsonObject {
  return { name: scene.name, focus: scene.focus, established: scene.established.map((fact) => ({ text: fact.text, at: fact.at })) };
}

/** A stored scene read back; null when malformed. */
export function readScene(data: JsonObject): Scene | null {
  const { name, focus, established } = data;
  if (typeof name !== "string" || typeof focus !== "string" || !Array.isArray(established)) return null;
  const facts: EstablishedFact[] = [];
  for (const item of established) {
    if (!isRecord(item) || typeof item.text !== "string" || (item.at !== null && typeof item.at !== "string")) return null;
    facts.push(Object.freeze({ text: item.text, at: item.at }));
  }
  return Object.freeze({ name, focus, established: Object.freeze(facts) });
}

export interface SceneView {
  readonly name: string;
  readonly focus: string;
  readonly established: readonly EstablishedFact[];
}

function projectScene(document: Document, _viewer: Viewer): SceneView | null {
  const scene = readScene(document.data);
  if (scene === null) return null;
  return { name: scene.name, focus: scene.focus, established: scene.established.map((fact) => ({ text: fact.text, at: fact.at })) };
}

function validateScene(data: JsonObject): WriteViolation[] {
  const extra = onlyKeys(data, ["name", "focus", "established"]);
  if (extra !== null) return [{ code: "unknown_field", path: extra }];
  const violations: WriteViolation[] = [];
  if (typeof data.name !== "string" || cleanOptionalText(data.name, MAX_SCENE_NAME_CHARS) !== data.name) violations.push({ code: "bad_name", path: "name" });
  if (typeof data.focus !== "string" || cleanOptionalText(data.focus, MAX_SCENE_FOCUS_CHARS) !== data.focus) violations.push({ code: "bad_focus", path: "focus" });
  if (!Array.isArray(data.established)) {
    violations.push({ code: "bad_established", path: "established" });
    return violations;
  }
  if (data.established.length > MAX_ESTABLISHED_FACTS) violations.push({ code: "facts_full", path: "established" });
  data.established.forEach((fact, index) => violations.push(...noteViolations(fact, `established.${index}`, MAX_ESTABLISHED_FACT_CHARS)));
  return violations;
}

export const sceneDocument: DocumentType<SceneView> = {
  name: SCENE_TYPE,
  lifecycle: { reset: "story" },
  version: 1,
  project: projectScene,
  validate: validateScene,
};
