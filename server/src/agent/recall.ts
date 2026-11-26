// Semantic recall, the main-thread half (§12 3.2 step 5): embed the retrieval text once,
// query the room's vector index, and hand the lore hit ids to the lore exchange and the
// chronicle hit ids to the prompt assembler. Plus keeping the index current: lore entries
// when they are added or changed, chronicle records when they are folded.
//
// Collections are per room (the index's own partition) and per kind: every point carries
// `{ kind, ref }` in its payload, its id is `<kind>:<ref>`, and a search filters on `kind`.
// Secrecy is not decided here: a secret entry is indexed like any other, and the lore
// exchange's visibility step drops a hit a viewer may not see (a player-grade assembly
// never admits a secret entry, whatever recall found). Chronicle hits are record ids; the
// assembler reads the records through their projection.
//
// Recall is an improvement, never a dependency: a failed embedding or search degrades the
// turn to lexical lore only, with a reported problem. Index writes happen after a network
// wait, so they are guarded by the room generation of the context they were scheduled
// with: a lane whose room was undone, reset or replaced meanwhile writes nothing.
import type { RoomStorage } from "../infra/lifecycle/storages.ts";
import type { Embeddings, VectorIndex } from "../infra/recall/index.ts";
import type { RoomContext } from "./context.ts";

export type RecallKind = "lore" | "chronicle";
export const RECALL_KINDS: readonly RecallKind[] = ["lore", "chronicle"];

/** Hits per kind (the lore step's default entry count). */
export const DEFAULT_RECALL_LIMIT = 12;
export const MAX_RECALL_LIMIT = 100;
/** The retrieval text is the tail of the transcript, at most this many code points. */
export const MAX_RETRIEVAL_CHARS = 4_000;
/** Texts embedded per indexing call. */
export const MAX_INDEX_BATCH = 256;
/** One indexed text, in code points (an entry holds at most 16,000 plus its title). */
export const MAX_INDEX_TEXT_CHARS = 20_000;

export interface RecallDeps {
  readonly embeddings: Embeddings;
  readonly index: VectorIndex;
}

export type RecallProblemCode = "recall_failed" | "index_failed" | "stale_writer" | "too_many" | "too_long";

/** For the operator's log. */
export interface RecallProblem {
  readonly code: RecallProblemCode;
  /** The recall layer's error code, when it raised one. */
  readonly detail?: string;
}

export interface RecallHits {
  readonly lore: readonly string[];
  readonly chronicle: readonly string[];
  readonly problems: readonly RecallProblem[];
}

const NO_HITS: RecallHits = { lore: [], chronicle: [], problems: [] };

function errorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error && typeof (error as { code: unknown }).code === "string") {
    return (error as { code: string }).code;
  }
  return undefined;
}

function failed(code: RecallProblemCode, error: unknown): RecallProblem {
  const detail = errorCode(error);
  return detail === undefined ? { code } : { code, detail };
}

export function pointId(kind: RecallKind, ref: string): string {
  return `${kind}:${ref}`;
}

/** The newest end of the transcript, joined, cut to its last `maxChars` code points. */
export function retrievalText(transcript: readonly string[], maxChars: number = MAX_RETRIEVAL_CHARS): string {
  const chars = [...transcript.join("\n")];
  return chars.slice(Math.max(0, chars.length - maxChars)).join("");
}

/**
 * The lore entries and chronicle records nearest to `text`, best first, `limit` of each.
 * Only positive similarities count (the reference's rule). A failure returns no hits and a
 * problem; the caller goes on with lexical lore.
 */
export async function recall(
  deps: RecallDeps,
  room: string,
  text: string,
  options: { readonly limit?: number; readonly signal?: AbortSignal } = {},
): Promise<RecallHits> {
  if (text.trim() === "") return NO_HITS;
  const limit = Math.min(MAX_RECALL_LIMIT, Math.max(0, Math.trunc(options.limit ?? DEFAULT_RECALL_LIMIT)));
  if (limit === 0) return NO_HITS;
  let vector: Float64Array;
  try {
    const [embedded] = await deps.embeddings.embed([retrievalText([text])], options.signal === undefined ? {} : { signal: options.signal });
    if (embedded === undefined) return { ...NO_HITS, problems: [{ code: "recall_failed" }] };
    vector = embedded;
  } catch (error) {
    return { ...NO_HITS, problems: [failed("recall_failed", error)] };
  }
  try {
    const hits = (kind: RecallKind): string[] =>
      deps.index
        .search(room, vector, { limit, filter: { kind } })
        .filter((hit) => hit.score > 0 && typeof hit.payload.ref === "string")
        .map((hit) => hit.payload.ref as string);
    return { lore: hits("lore"), chronicle: hits("chronicle"), problems: [] };
  } catch (error) {
    return { ...NO_HITS, problems: [failed("recall_failed", error)] };
  }
}

export interface IndexItem {
  /** The lore entry id or chronicle record id. */
  readonly ref: string;
  readonly text: string;
}

export interface IndexOutcome {
  readonly indexed: number;
  readonly problems: readonly RecallProblem[];
}

function textLength(text: string): number {
  let count = 0;
  for (const _ of text) count++;
  return count;
}

/**
 * Embed and store `items` of one kind for the context's room. Guarded: if the room moved
 * to another generation while the embedding was out, nothing is stored. A failure stores
 * nothing and is reported; the entries still work lexically.
 */
export async function indexItems(deps: RecallDeps, context: Pick<RoomContext, "room" | "writer">, kind: RecallKind, items: readonly IndexItem[]): Promise<IndexOutcome> {
  if (items.length === 0) return { indexed: 0, problems: [] };
  if (items.length > MAX_INDEX_BATCH) return { indexed: 0, problems: [{ code: "too_many" }] };
  if (items.some((item) => textLength(item.text) > MAX_INDEX_TEXT_CHARS)) return { indexed: 0, problems: [{ code: "too_long" }] };
  let vectors: Float64Array[];
  try {
    vectors = await deps.embeddings.embed(items.map((item) => item.text));
  } catch (error) {
    return { indexed: 0, problems: [failed("index_failed", error)] };
  }
  if (!context.writer.current()) return { indexed: 0, problems: [{ code: "stale_writer" }] };
  try {
    deps.index.upsert(
      context.room,
      items.map((item, at) => ({ id: pointId(kind, item.ref), vector: vectors[at] ?? new Float64Array(0), payload: { kind, ref: item.ref } })),
    );
  } catch (error) {
    return { indexed: 0, problems: [failed("index_failed", error)] };
  }
  return { indexed: items.length, problems: [] };
}

/** Index lore entries that were added or changed: their title and content. */
export function indexLoreEntries(
  deps: RecallDeps,
  context: Pick<RoomContext, "room" | "writer">,
  entries: readonly { readonly id: string; readonly title: string; readonly content: string }[],
): Promise<IndexOutcome> {
  return indexItems(
    deps,
    context,
    "lore",
    entries.map((entry) => ({ ref: entry.id, text: `${entry.title}\n${entry.content}` })),
  );
}

/** Index chronicle records that were just folded into the summary (their public text). */
export function indexChronicleRecords(
  deps: RecallDeps,
  context: Pick<RoomContext, "room" | "writer">,
  records: readonly { readonly id: string; readonly text: string }[],
): Promise<IndexOutcome> {
  return indexItems(
    deps,
    context,
    "chronicle",
    records.map((record) => ({ ref: record.id, text: record.text })),
  );
}

/** Drop the vectors of removed items (a deleted lore entry). Synchronous. */
export function forgetItems(deps: Pick<RecallDeps, "index">, room: string, kind: RecallKind, refs: readonly string[]): void {
  if (refs.length > 0) deps.index.delete(room, refs.map((ref) => pointId(kind, ref)));
}

function clearKind(index: VectorIndex, room: string, kind: RecallKind): void {
  const ids = index.search(room, new Float64Array(index.dimensions), { limit: index.count(room), filter: { kind } }).map((hit) => hit.id);
  index.delete(room, ids);
}

/**
 * The index as two room storages, for the composition root to register with the store's
 * `RoomStorages`: lore vectors die with the imported world (`all`, like the entries), the
 * chronicle's with the story (`story`, like the records).
 */
export function recallStorages(index: VectorIndex): readonly RoomStorage[] {
  return [
    { name: "recall.lore", lifecycle: { reset: "all" }, clear: (room) => clearKind(index, room, "lore") },
    { name: "recall.chronicle", lifecycle: { reset: "story" }, clear: (room) => clearKind(index, room, "chronicle") },
  ];
}
