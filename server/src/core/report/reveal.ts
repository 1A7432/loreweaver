// The reveal edition's extra material: what was hidden from the players during play.
//
// Every item is obtained through the document projections, and WHAT counts as hidden is
// decided by comparing the Keeper's view of a document with a player's view of the same
// document — never by reading a secrecy flag off a stored payload. So a field a player can
// already see is never printed here as a secret, and a type that learns a new public field
// needs no change here.
import { CAMPAIGN_SUMMARY_TYPE, CHRONICLE_RECORD_TYPE } from "../chronicle/index.ts";
import { type DocumentViews, KEEPER, playerViewer } from "../documents/index.ts";
import { LORE_ENTRY_TYPE } from "../lore/index.ts";
import { NPC_TYPE } from "../npcs/index.ts";
import { MODULE_VARIABLES_TYPE, VARIABLE_TREE_TYPE } from "../variables/index.ts";

export interface RevealModel {
  /** The Keeper's annotation beside a chronicle record, with the public line it sits beside. */
  readonly margins: readonly { readonly turn: number; readonly keeper: string; readonly text: string }[];
  /** The Keeper's annotation beside the rolling summary. */
  readonly summaryMargin: string;
  /** Lore entries no player view holds. */
  readonly lore: readonly { readonly title: string; readonly content: string }[];
  /** What each NPC's record holds beyond what the table knows of them. */
  readonly npcs: readonly { readonly name: string; readonly secret: string; readonly knowledge: readonly string[] }[];
  /** Module variables no player view holds, final values. */
  readonly keeperVars: readonly { readonly label: string; readonly value: unknown }[];
  /** Card-variable leaves no player view holds, final values. */
  readonly hiddenLeaves: readonly { readonly path: string; readonly value: unknown }[];
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function own(record: unknown, key: string): unknown {
  return isRecord(record) && Object.hasOwn(record, key) ? record[key] : undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/** The reveal material of `room`, in `locale` (labels of variables are per language). */
export function buildReveal(views: DocumentViews, room: string, locale: string): RevealModel {
  const keeper = { ...KEEPER, locale };
  const player = playerViewer(locale);
  const seenByPlayer = (type: string): Map<string, unknown> => new Map(views.views(room, type, player).map((entry) => [entry.id, entry.view]));

  const margins: { turn: number; keeper: string; text: string }[] = [];
  for (const { view } of views.views(room, CHRONICLE_RECORD_TYPE, keeper)) {
    const note = text(own(view, "keeper"));
    const turn = own(view, "turn");
    if (note !== "") margins.push({ turn: typeof turn === "number" ? turn : 0, keeper: note, text: text(own(view, "text")) });
  }
  margins.sort((a, b) => a.turn - b.turn);

  let summaryMargin = "";
  for (const { view } of views.views(room, CAMPAIGN_SUMMARY_TYPE, keeper)) summaryMargin = text(own(view, "keeper")) || summaryMargin;

  const publicLore = seenByPlayer(LORE_ENTRY_TYPE);
  const lore: { title: string; content: string }[] = [];
  for (const { id, view } of views.views(room, LORE_ENTRY_TYPE, keeper)) {
    if (publicLore.has(id)) continue;
    const content = text(own(view, "content"));
    if (content !== "") lore.push({ title: text(own(view, "title")), content });
  }

  const publicNpcs = seenByPlayer(NPC_TYPE);
  const npcs: { name: string; secret: string; knowledge: string[] }[] = [];
  for (const { id, view } of views.views(room, NPC_TYPE, keeper)) {
    const shown = publicNpcs.get(id);
    // A field the table's view carries is not a secret, whatever it is called.
    const secret = own(shown, "secretAgenda") === undefined ? text(own(view, "secretAgenda")) : "";
    const knowledge = own(shown, "knowledge") === undefined ? list(own(view, "knowledge")).map(text).filter((fact) => fact !== "") : [];
    if (secret !== "" || knowledge.length > 0) npcs.push({ name: text(own(view, "name")), secret, knowledge });
  }

  const keeperVars: { label: string; value: unknown }[] = [];
  const publicVars = new Set<string>();
  for (const view of seenByPlayer(MODULE_VARIABLES_TYPE).values()) for (const variable of list(own(view, "variables"))) publicVars.add(text(own(variable, "id")));
  for (const { view } of views.views(room, MODULE_VARIABLES_TYPE, keeper)) {
    for (const variable of list(own(view, "variables"))) {
      const id = text(own(variable, "id"));
      if (id === "" || publicVars.has(id)) continue;
      keeperVars.push({ label: text(own(variable, "label")) || id, value: own(variable, "valueLabel") ?? own(variable, "value") });
    }
  }

  const hiddenLeaves: { path: string; value: unknown }[] = [];
  const publicLeaves = new Set<string>();
  for (const view of seenByPlayer(VARIABLE_TREE_TYPE).values()) for (const leaf of list(own(view, "leaves"))) publicLeaves.add(text(own(leaf, "path")));
  for (const { view } of views.views(room, VARIABLE_TREE_TYPE, keeper)) {
    for (const leaf of list(own(view, "leaves"))) {
      const path = text(own(leaf, "path"));
      if (path !== "" && !publicLeaves.has(path)) hiddenLeaves.push({ path, value: own(leaf, "value") });
    }
  }

  return { margins, summaryMargin, lore, npcs, keeperVars, hiddenLeaves };
}

/** Whether there is anything at all behind the screen. */
export function revealIsEmpty(reveal: RevealModel): boolean {
  return reveal.margins.length + reveal.lore.length + reveal.npcs.length + reveal.keeperVars.length + reveal.hiddenLeaves.length === 0 && reveal.summaryMargin === "";
}
