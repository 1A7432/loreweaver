// `query_lore`: the Keeper browsing the room's lore. Keeper grade (secret entries
// included — the result is flagged Keeper-only), lexical activation over the stored
// entries with the admin's overlay applied, plus any semantic hits the recall lane found.
//
// A browse is not an injection: conditions do not hide entries here (injection-time
// gating is the prompt's), always-on entries do not select themselves (they are already
// in every prompt), and the per-entry chance, delay, timers and inclusion groups — all
// about which entries a TURN injects — do not apply, so the same query always finds the
// same entries and draws no randomness.
import { applyOverlay, LORE_ENTRY_TYPE, LORE_OVERLAY_ID, LORE_OVERLAY_TYPE, readLoreEntry, readOverlay } from "../../core/lore/index.ts";
import { activate, DEFAULT_MAX_ENTRIES, EMPTY_TIMERS, type LoreEntry } from "../../core/worldbook/index.ts";
import type { RoomContext } from "../context.ts";
import { param } from "./params.ts";
import { getDocument, listDocuments } from "./shared.ts";
import { defineTool, type ToolResult } from "./types.ts";

/** At most this many entries come back for one query (lexical first, then semantic). */
export const MAX_LORE_RESULTS = DEFAULT_MAX_ENTRIES;

/** The room's entries as the Keeper's browse sees them: stored order, overlay applied. */
function roomEntries(context: RoomContext): LoreEntry[] {
  const overlayDocument = getDocument(context, LORE_OVERLAY_TYPE, LORE_OVERLAY_ID);
  const overlay = overlayDocument === null || overlayDocument.corrupt ? null : readOverlay(overlayDocument.data);
  const entries: LoreEntry[] = [];
  for (const document of listDocuments(context, LORE_ENTRY_TYPE)) {
    const entry = readLoreEntry(document);
    if (entry !== null) entries.push(overlay === null ? entry : applyOverlay(entry, overlay));
  }
  return entries;
}

/**
 * The entries matching `query`, Keeper grade: lexical matches in activation order, then the
 * `semanticHits` ids (best first) not already found. Disabled entries never come back.
 */
export function queryLore(context: RoomContext, query: string, semanticHits: readonly string[] = []): LoreEntry[] {
  const entries = roomEntries(context);
  const browse = entries.map((entry) => ({ ...entry, probability: 100, delay: 0, sticky: 0, cooldown: 0, group: "" }));
  const lexical = activate({
    entries: browse,
    viewer: "keeper",
    transcript: [query],
    timers: EMPTY_TIMERS,
    advanceTimers: false,
    random: context.random,
    includeConstant: false,
    maxEntries: MAX_LORE_RESULTS,
    conditionHolds: () => true,
  }).selected;
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const found = lexical.map((entry) => byId.get(entry.id) as LoreEntry);
  const seen = new Set(found.map((entry) => entry.id));
  for (const id of semanticHits) {
    if (found.length >= MAX_LORE_RESULTS) break;
    const entry = byId.get(id);
    if (entry === undefined || !entry.enabled || seen.has(id)) continue;
    found.push(entry);
    seen.add(id);
  }
  return found;
}

export const queryLoreTool = defineTool({
  name: "query_lore",
  description:
    "Retrieve world lore relevant to `query` (KEEPER view -- may include secret entries; for your own reasoning, never quote secret lore to players). Matches by keyword + meaning.",
  params: {
    query: param.string("What you are looking for (a place, name, theme, or the current scene text)."),
  },
  flags: { keeperOnly: true, readOnly: true },
  suspends: "network",
  async run(context, args, turn): Promise<ToolResult> {
    const recall = turn.deps.recallLore;
    const hits = recall === undefined ? [] : await recall(context.room, args.query);
    // Resumed: the entries are read now, after the recall, never before it.
    const found = queryLore(context, args.query, hits);
    if (found.length === 0) return { text: `No lore matches "${args.query}".` };
    const lines = [
      "KEEPER-ONLY lore lookup (may include secret entries; never quote secret lore to players):",
      `Lore matching "${args.query}" (${found.length}):`,
      ...found.map((entry) => `- [${entry.category || "lore"}] ${entry.title}${entry.secret ? " (secret)" : ""}: ${entry.content}`),
    ];
    return { text: lines.join("\n") };
  },
});
