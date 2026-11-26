// Plot threads: the open-loops tracker (`plot_thread`) — planted foreshadowing, unresolved
// hooks, armed consequences. `{ label, status: open | resolved, notes }`.
//
// Keeper-only, the whole document: an open loop may be a secret the players have not
// found yet, and even its label can say so. There is no partial view worth having.
// Only `status` is structured, so the engine can find stale loops; the rest is free text.
import type { Document, DocumentType, JsonObject, Viewer, WriteViolation } from "../documents/model.ts";

export const PLOT_THREAD_TYPE = "plot_thread";

export const MAX_THREAD_LABEL_CHARS = 200;
export const MAX_THREAD_NOTES_CHARS = 4_000;

export type ThreadStatus = "open" | "resolved";

export interface PlotThread {
  readonly label: string;
  readonly status: ThreadStatus;
  readonly notes: string;
}

export type ThreadRefusalCode = "empty" | "too_long" | "bad_field" | "unknown_field";

export type ThreadChange<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly code: ThreadRefusalCode; readonly path: string };

function codePoints(text: string): number {
  let count = 0;
  for (const _ of text) count++;
  return count;
}

const THREAD_FIELDS: ReadonlySet<string> = new Set(["label", "status", "notes"]);

export function validatePlotThread(data: JsonObject): WriteViolation[] {
  const violations: WriteViolation[] = [];
  for (const key of Object.keys(data)) if (!THREAD_FIELDS.has(key)) violations.push({ code: "unknown_field", path: key });
  const label = data.label;
  if (typeof label !== "string") violations.push({ code: "bad_field", path: "label" });
  else if (label.trim() === "") violations.push({ code: "empty", path: "label" });
  else if (codePoints(label) > MAX_THREAD_LABEL_CHARS) violations.push({ code: "too_long", path: "label" });
  if (data.status !== "open" && data.status !== "resolved") violations.push({ code: "bad_field", path: "status" });
  if (typeof data.notes !== "string") violations.push({ code: "bad_field", path: "notes" });
  else if (codePoints(data.notes) > MAX_THREAD_NOTES_CHARS) violations.push({ code: "too_long", path: "notes" });
  return violations;
}

export function plotThreadData(thread: PlotThread): JsonObject {
  return { label: thread.label, status: thread.status, notes: thread.notes };
}

export function readPlotThread(data: JsonObject): PlotThread | null {
  if (validatePlotThread(data).length > 0) return null;
  return { label: data.label as string, status: data.status as ThreadStatus, notes: data.notes as string };
}

function checked(thread: PlotThread): ThreadChange<PlotThread> {
  const first = validatePlotThread(plotThreadData(thread))[0];
  return first === undefined ? { ok: true, data: thread } : { ok: false, code: first.code as ThreadRefusalCode, path: first.path };
}

/** A new open thread. */
export function newPlotThread(label: string, notes = ""): ThreadChange<PlotThread> {
  return checked({ label: label.trim(), status: "open", notes: notes.trim() });
}

/** The thread with a new status and/or notes; the label is its identity and does not change. */
export function updatePlotThread(thread: PlotThread, change: { readonly status?: ThreadStatus; readonly notes?: string }): ThreadChange<PlotThread> {
  return checked({ label: thread.label, status: change.status ?? thread.status, notes: change.notes === undefined ? thread.notes : change.notes.trim() });
}

/**
 * A thread's document id, derived from its label (trimmed, lower-cased) so re-stating a
 * loop updates it instead of duplicating it, with no scan. FNV-1a 64 over the UTF-8 bytes:
 * deterministic everywhere, and the id carries no label text.
 */
export function plotThreadId(label: string): string {
  const bytes = new TextEncoder().encode(label.trim().toLowerCase());
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return `t-${hash.toString(16).padStart(16, "0")}`;
}

function projectThread(document: Document, viewer: Viewer): PlotThread | null {
  if (viewer.grade !== "keeper") return null;
  return readPlotThread(document.data);
}

export const plotThreadDocumentType: DocumentType<PlotThread> = {
  name: PLOT_THREAD_TYPE,
  // The story's open loops: a story reset closes them all.
  lifecycle: { reset: "story" },
  version: 1,
  project: projectThread,
  validate: validatePlotThread,
};
