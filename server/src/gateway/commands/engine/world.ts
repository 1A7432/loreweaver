// The world and the campaign's memory: room variables (`var`), lore (`lore`), the NPCs
// (`npc`), the recap for the table (`recap`), and the admin's console onto the Keeper's
// records (`chronicle`, `habits`).
//
// Two readers, kept apart. What a PLAYER asks for is read through the player's own
// projection, so a secret never reaches them by construction: the recap is built from the
// public views of the summary and the records, and a player's lore list from the table
// view of each entry. What the ADMIN reads through `npc`, `chronicle` and `habits` is the
// Keeper's own record, read at the Keeper's grade and answered to the admin alone — it is
// never an event. Lore and variables keep their admin grade: a secret lore entry shows the
// admin its title only, an unexposed variable shows flagged.
import {
  CAMPAIGN_SUMMARY_ID,
  CAMPAIGN_SUMMARY_TYPE,
  campaignSummaryData,
  type CampaignSummary,
  type CampaignSummaryPublicView,
  CHRONICLE_RECORD_TYPE,
  type ChronicleRecord,
  type ChronicleRecordPublicView,
  PLOT_THREAD_TYPE,
  type PlotThread,
  readCampaignSummary,
  setSummaryMargin,
  MAX_KEEPER_MARGIN_CHARS,
} from "../../../core/chronicle/index.ts";
import { forgetHabit, readTableHabits, TABLE_HABITS_ID, TABLE_HABITS_TYPE, tableHabitsData, type TableHabits } from "../../../core/habits/index.ts";
import {
  bindLore,
  EMPTY_OVERLAY,
  LORE_ENTRY_TYPE,
  LORE_OVERLAY_ID,
  LORE_OVERLAY_TYPE,
  loreEntryDocument,
  type LoreEntryView,
  type LoreOverlay,
  type LoreOverlayView,
  newLoreEntry,
  type OverlayChange,
  overlayData,
  readOverlay,
  restoreLore,
  switchLore,
  unbindLore,
} from "../../../core/lore/index.ts";
import { type Npc, NPC_TYPE, npcSlug, type NpcView } from "../../../core/npcs/index.ts";
import {
  adjustVariable,
  MODULE_VARIABLES_ID,
  MODULE_VARIABLES_TYPE,
  type ModuleVariablesView,
  moduleVariablesPayload,
  normalizeModuleVariables,
  parseCommandValue,
  readVariableTree,
  setVariable,
  type TreeLeafView,
  applyUpdates,
  exposePrefix,
  hidePrefix,
  VARIABLE_TREE_ID,
  VARIABLE_TREE_TYPE,
  type VariableTreeView,
  variableTreeData,
  type WriteOutcome,
} from "../../../core/variables/index.ts";
import { MAX_CONDITION_CHARS, MAX_ENTRY_CHARS, MAX_TITLE_CHARS } from "../../../core/worldbook/import.ts";
import { BOOLEAN, compact, integer, object, oneOf, text } from "../schema.ts";
import { firstWord, parseInteger, splitBar } from "../parse.ts";
import { callerViewer, keeperViewer, putDocument, readDocument } from "../support.ts";
import { type Args, type CommandCall, type CommandSpec, type Done, isRefused, refuse, type Refused } from "../types.ts";

/** Recent chronicle lines a recap shows after the summary. */
export const RECAP_RECENT = 8;
/** Lines of a listing before it says how many more there are. */
export const MAX_LISTED = 50;

function lines(call: CommandCall, header: string, items: readonly string[]): string {
  const shown = items.slice(0, MAX_LISTED);
  const out = [header, ...shown];
  if (items.length > shown.length) out.push(call.say("list.more", { count: items.length - shown.length }));
  return out.join("\n");
}

function show(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// var
// ---------------------------------------------------------------------------

function variableViews(call: CommandCall): { readonly tree: VariableTreeView | null; readonly modules: ModuleVariablesView | null } {
  const viewer = callerViewer(call);
  const views = call.context.services.views;
  return {
    tree: views.view(call.context.room, VARIABLE_TREE_TYPE, VARIABLE_TREE_ID, viewer) as VariableTreeView | null,
    modules: views.view(call.context.room, MODULE_VARIABLES_TYPE, MODULE_VARIABLES_ID, viewer) as ModuleVariablesView | null,
  };
}

function runVarList(call: CommandCall): Done {
  const { tree, modules } = variableViews(call);
  const items: string[] = [];
  for (const variable of modules?.variables ?? []) {
    items.push(call.say(variable.hidden === true ? "var.line_hidden" : "var.line", { path: variable.id, value: show(variable.valueLabel ?? variable.value) }));
  }
  for (const leaf of (tree?.leaves ?? []) as readonly TreeLeafView[]) {
    items.push(call.say(leaf.hidden === true ? "var.line_hidden" : "var.line", { path: leaf.path, value: show(leaf.value) }));
  }
  if (items.length === 0) return { text: call.say("var.empty"), data: { tree, modules } };
  return { text: lines(call, call.say("var.header", { count: items.length }), items), data: { tree, modules } };
}

function outcomeOf(outcome: WriteOutcome, path: string): Refused | null {
  return outcome.status === "refused" ? refuse("var_refused", { path, code: outcome.code }) : null;
}

function runVarWrite(call: CommandCall, op: "set" | "add", path: string, args: Args): Done | Refused {
  const modulesDocument = readDocument(call, MODULE_VARIABLES_TYPE, MODULE_VARIABLES_ID);
  if (isRefused(modulesDocument)) return modulesDocument;
  const modules = normalizeModuleVariables(modulesDocument?.data ?? {});
  const declared = modules.variables.some((variable) => variable.spec.id === path);
  if (op === "add" && args.delta === undefined) return refuse("missing_arg", { path: "delta" });
  if (op === "set" && args.value === undefined) return refuse("missing_arg", { path: "value" });
  const parsed = op === "set" ? parseCommandValue(args.value as string) : null;
  if (parsed !== null && !parsed.ok) return refuse("var_refused", { path, code: "bad_value" });
  if (declared) {
    const write = op === "set" ? setVariable(modules, path, parsed?.ok === true ? parsed.value : null) : adjustVariable(modules, path, args.delta);
    const problem = outcomeOf(write.outcome, path);
    if (problem !== null) return problem;
    putDocument(call, MODULE_VARIABLES_TYPE, MODULE_VARIABLES_ID, moduleVariablesPayload(write.state));
    return { text: call.say("var.written", { path, value: show(write.outcome.status === "applied" ? write.outcome.value : null) }) };
  }
  const treeDocument = readDocument(call, VARIABLE_TREE_TYPE, VARIABLE_TREE_ID);
  if (isRefused(treeDocument)) return treeDocument;
  if (treeDocument === null) return refuse("var_refused", { path, code: "unknown_path" });
  const stored = readVariableTree(treeDocument.data);
  const value = op === "set" ? (args.value as string) : String(args.delta as number);
  // `set` writes an existing leaf only: the tree's shape is the imported world's.
  const applied = applyUpdates(stored.tree, [{ op, written: op, path, args: [value], reason: "" }]);
  const result = applied.results[0];
  if (result === undefined) return refuse("var_refused", { path, code: "unknown_path" });
  const problem = outcomeOf(result.outcome, path);
  if (problem !== null) return problem;
  putDocument(call, VARIABLE_TREE_TYPE, VARIABLE_TREE_ID, variableTreeData(applied.tree, stored.exposed));
  return { text: call.say("var.written", { path, value: show(result.outcome.status === "applied" ? result.outcome.value : null) }) };
}

function runVarExposure(call: CommandCall, op: "expose" | "hide", path: string): Done | Refused {
  const document = readDocument(call, VARIABLE_TREE_TYPE, VARIABLE_TREE_ID);
  if (isRefused(document)) return document;
  if (document === null) return refuse("no_variables");
  const stored = readVariableTree(document.data);
  const result = op === "expose" ? exposePrefix(stored.exposed, path) : hidePrefix(stored.exposed, path);
  if (result.status === "invalid") return refuse("invalid_arg", { path: "path" });
  if (result.status === "limit_reached") return refuse("limit_reached");
  if (!("exposed" in result)) return { text: call.say(op === "expose" ? "var.already_exposed" : "var.already_hidden", { path }) };
  putDocument(call, VARIABLE_TREE_TYPE, VARIABLE_TREE_ID, variableTreeData(stored.tree, result.exposed));
  return { text: call.say(op === "expose" ? "var.exposed" : "var.hidden", { path }) };
}

export const varCommand: CommandSpec = {
  id: "var",
  source: "engine",
  key: "var",
  params: object({ op: oneOf(["list", "expose", "hide", "set", "add"]), path: text(200, 1), value: text(), delta: integer(-1_000_000_000, 1_000_000_000) }, ["op"]),
  text: { en: ["var", "vars"], zh: ["var", "变量", "變量"] },
  role: "admin",
  parseText(rest) {
    const [word, after] = firstWord(rest);
    if (word === "" || word === "list") return { op: "list" };
    if (word === "expose" || word === "hide") return compact({ op: word, path: after === "" ? undefined : after });
    if (word === "set" || word === "add") {
      const [path, value] = firstWord(after);
      // The path is matched as written: `firstWord` folds case, so take it back from the text.
      const written = after.trim().split(/\s+/u)[0] ?? path;
      if (word === "set") return compact({ op: "set", path: written === "" ? undefined : written, value: value === "" ? undefined : value });
      const delta = parseInteger(value);
      return delta === null ? refuse("usage") : compact({ op: "add", path: written === "" ? undefined : written, delta });
    }
    return refuse("usage");
  },
  run(call, args): Done | Refused {
    const op = args.op as string;
    if (op === "list") return runVarList(call);
    const path = args.path as string | undefined;
    if (path === undefined) return refuse("missing_arg", { path: "path" });
    if (op === "expose" || op === "hide") return runVarExposure(call, op, path);
    return runVarWrite(call, op as "set" | "add", path, args);
  },
};

// ---------------------------------------------------------------------------
// lore
// ---------------------------------------------------------------------------

interface LoreLine {
  readonly id: string;
  readonly title: string;
  readonly secret: boolean;
  readonly enabled: boolean;
  readonly annotated: boolean;
}

function loreLines(call: CommandCall): { readonly entries: readonly LoreEntryView[]; readonly lines: readonly LoreLine[] } {
  const viewer = callerViewer(call);
  const views = call.context.services.views;
  const entries = views.views(call.context.room, LORE_ENTRY_TYPE, viewer).map((entry) => entry.view as LoreEntryView);
  // The overlay is keeper-side: a player's projection of it is null, so their list carries no trace of it.
  const overlay = views.view(call.context.room, LORE_OVERLAY_TYPE, LORE_OVERLAY_ID, viewer) as LoreOverlayView | null;
  const switches = new Map((overlay?.entries ?? []).map((entry) => [entry.title, entry]));
  const out = entries.map((entry): LoreLine => {
    const own = entry.view === "table" ? true : entry.enabled;
    const annotation = entry.view === "table" ? undefined : switches.get(entry.title);
    return {
      id: entry.id,
      title: entry.title,
      secret: entry.view === "secret_title" || (entry.view === "full" && entry.secret),
      enabled: annotation?.enabled ?? own,
      annotated: annotation !== undefined,
    };
  });
  return { entries, lines: out };
}

function runLoreList(call: CommandCall, disabledOnly: boolean): Done {
  const { entries, lines: all } = loreLines(call);
  const listed = disabledOnly ? all.filter((line) => !line.enabled) : all;
  if (listed.length === 0) return { text: call.say("lore.empty"), data: { entries: [] } };
  const items = listed.map((line) => {
    const marks = [line.enabled ? "" : call.say("lore.mark_off"), line.secret ? call.say("lore.mark_secret") : "", line.annotated ? call.say("lore.mark_annotated") : ""].join("");
    return call.say("lore.line", { title: line.title, marks });
  });
  const shown = new Set(listed.map((line) => line.id));
  return { text: lines(call, call.say("lore.header", { count: listed.length }), items), data: { entries: entries.filter((entry) => shown.has(entry.id)) } };
}

function runLoreAdd(call: CommandCall, title: string | undefined, content: string | undefined): Done | Refused {
  if (title === undefined) return refuse("missing_arg", { path: "title" });
  if (content === undefined) return refuse("missing_arg", { path: "content" });
  const count = call.context.services.documents.list(call.context.room, LORE_ENTRY_TYPE).length;
  const entry = newLoreEntry({ title, content }, count);
  if (!entry.ok) return refuse(entry.code === "limit_reached" ? "limit_reached" : "invalid_arg", { path: entry.path });
  const { data, meta } = loreEntryDocument(entry.data);
  const id = `lore-${call.context.services.clock.id()}`;
  putDocument(call, LORE_ENTRY_TYPE, id, data, meta);
  return { text: call.say("lore.added", { title: entry.data.title }), data: { id } };
}

function readLoreOverlay(call: CommandCall): LoreOverlay | Refused {
  const document = readDocument(call, LORE_OVERLAY_TYPE, LORE_OVERLAY_ID);
  if (isRefused(document)) return document;
  return document === null ? EMPTY_OVERLAY : readOverlay(document.data);
}

function runLoreSwitch(call: CommandCall, op: string, title: string | undefined, condition: string | undefined): Done | Refused {
  if (title === undefined) return refuse("missing_arg", { path: "title" });
  const overlay = readLoreOverlay(call);
  if (isRefused(overlay)) return overlay;
  if (op === "restore") {
    const restored = restoreLore(overlay, title);
    if (restored.removed === 0) return refuse("not_found", { title });
    putDocument(call, LORE_OVERLAY_TYPE, LORE_OVERLAY_ID, overlayData(restored.overlay));
    return { text: call.say("lore.restored", { count: restored.removed }) };
  }
  // A switch names an entry the room holds; a typo must not become a dangling annotation.
  if (!loreLines(call).lines.some((line) => line.title === title.trim())) return refuse("not_found", { title });
  let change: OverlayChange<LoreOverlay>;
  if (op === "enable" || op === "disable") change = switchLore(overlay, title, op === "enable");
  else if (op === "bind") {
    if (condition === undefined) return refuse("missing_arg", { path: "condition" });
    change = bindLore(overlay, title, condition);
  } else change = unbindLore(overlay, title);
  if (!change.ok) return refuse(change.code === "bad_condition" ? "bad_condition" : "invalid_arg", { path: change.path });
  putDocument(call, LORE_OVERLAY_TYPE, LORE_OVERLAY_ID, overlayData(change.data));
  const done = op === "enable" ? "lore.enabled" : op === "disable" ? "lore.disabled" : op === "bind" ? "lore.bound" : "lore.unbound";
  return { text: call.say(done, { title: title.trim() }) };
}

export const loreCommand: CommandSpec = {
  id: "lore",
  source: "engine",
  key: "lore",
  params: object({
    op: oneOf(["list", "add", "enable", "disable", "bind", "unbind", "restore"]),
    title: text(MAX_TITLE_CHARS, 1),
    content: text(MAX_ENTRY_CHARS, 1),
    condition: text(MAX_CONDITION_CHARS, 1),
    disabled: BOOLEAN,
  }, ["op"]),
  text: { en: ["lore"], zh: ["lore", "设定", "設定"] },
  role: "player",
  // Reading the table's lore is everyone's; curating it, and asking what is switched off, the admin's.
  adminWhen: (args) => args.op !== "list" || args.disabled === true,
  parseText(rest) {
    const [word, after] = firstWord(rest);
    if (word === "" || word === "list") {
      const [flag] = firstWord(after);
      return flag === "disabled" ? { op: "list", disabled: true } : { op: "list" };
    }
    if (word === "add") {
      const parts = splitBar(after);
      if (parts === null) return refuse("usage");
      return compact({ op: "add", title: parts[0] === "" ? undefined : parts[0], content: parts[1] === "" ? undefined : parts[1] });
    }
    if (word === "bind") {
      const parts = splitBar(after);
      if (parts !== null) return compact({ op: "bind", title: parts[0] || undefined, condition: parts[1] || undefined });
      const [title, ...condition] = after.split(/\s+/u);
      return compact({ op: "bind", title: title || undefined, condition: condition.join(" ") || undefined });
    }
    if (word === "enable" || word === "disable" || word === "unbind" || word === "restore") return compact({ op: word, title: after === "" ? undefined : after });
    return refuse("usage");
  },
  run(call, args): Done | Refused {
    const op = args.op as string;
    if (op === "list") return runLoreList(call, args.disabled === true);
    if (op === "add") return runLoreAdd(call, args.title as string | undefined, args.content as string | undefined);
    return runLoreSwitch(call, op, args.title as string | undefined, args.condition as string | undefined);
  },
};

// ---------------------------------------------------------------------------
// npc
// ---------------------------------------------------------------------------

function npcByName(call: CommandCall, name: string): { readonly id: string; readonly npc: Npc } | null {
  const entries = call.context.services.views.views(call.context.room, NPC_TYPE, keeperViewer(call));
  const wanted = name.trim().toLowerCase();
  const slug = npcSlug(name);
  for (const entry of entries) {
    const npc = entry.view as Npc;
    if (entry.id === name.trim() || entry.id === slug || npc.name.toLowerCase() === wanted) return { id: entry.id, npc };
  }
  return null;
}

export const npcCommand: CommandSpec = {
  id: "npc",
  source: "engine",
  key: "npc",
  params: object({ op: oneOf(["list", "show", "delete"]), name: text(64, 1) }, ["op"]),
  text: { en: ["npc"], zh: ["npc", "角色"] },
  role: "admin",
  parseText(rest) {
    const [word, after] = firstWord(rest);
    const name = after === "" ? undefined : after;
    if (word === "" || word === "list") return { op: "list" };
    if (word === "show") return compact({ op: "show", name });
    if (word === "delete" || word === "del" || word === "rm") return compact({ op: "delete", name });
    return { op: "show", name: rest };
  },
  run(call, args): Done | Refused {
    const op = args.op as string;
    if (op === "list") {
      const entries = call.context.services.views.views(call.context.room, NPC_TYPE, keeperViewer(call));
      if (entries.length === 0) return { text: call.say("npc.empty"), data: { npcs: [] } };
      const items = entries.map((entry) => {
        const npc = entry.view as Npc;
        return call.say("npc.line", { name: npc.name, about: npc.publicDescription });
      });
      return { text: lines(call, call.say("npc.header", { count: entries.length }), items), data: { npcs: entries.map((entry) => ({ id: entry.id, ...(entry.view as NpcView) })) } };
    }
    const name = args.name as string | undefined;
    if (name === undefined) return refuse("missing_arg", { path: "name" });
    const found = npcByName(call, name);
    if (found === null) return refuse("unknown_npc", { name });
    if (op === "delete") {
      call.context.services.documents.delete(call.context.writer, NPC_TYPE, found.id);
      return { text: call.say("npc.deleted", { name: found.npc.name }), data: { id: found.id } };
    }
    const npc = found.npc;
    const body = [
      call.say("npc.show", { name: npc.name, about: npc.publicDescription }),
      call.say("npc.field.persona", { text: npc.persona }),
      call.say("npc.field.agenda", { text: npc.secretAgenda }),
      call.say("npc.field.disposition", { text: npc.disposition }),
      call.say("npc.field.location", { text: npc.location }),
      call.say("npc.field.knowledge", { count: npc.knowledge.length }),
      ...npc.knowledge.map((fact) => call.say("list.bullet", { text: fact })),
    ];
    return { text: body.join("\n"), data: { id: found.id, npc } };
  },
};

// ---------------------------------------------------------------------------
// recap, chronicle, habits
// ---------------------------------------------------------------------------

export const recapCommand: CommandSpec = {
  id: "recap",
  source: "engine",
  key: "recap",
  params: object({}),
  text: { en: ["recap"], zh: ["recap", "前情提要", "前情"] },
  role: "player",
  observers: true,
  parseText: () => ({}),
  run(call): Done {
    // Built from the caller's own projections only: the Keeper's margins and annotations
    // are not in what these return, so they cannot be in the recap.
    const viewer = callerViewer(call);
    const views = call.context.services.views;
    const summary = views.view(call.context.room, CAMPAIGN_SUMMARY_TYPE, CAMPAIGN_SUMMARY_ID, viewer) as CampaignSummaryPublicView | null;
    const through = summary?.throughTurn ?? 0;
    const records = views
      .views(call.context.room, CHRONICLE_RECORD_TYPE, viewer)
      .map((entry) => entry.view as ChronicleRecordPublicView)
      .filter((record) => record.turn > through)
      .sort((left, right) => left.turn - right.turn)
      .slice(-RECAP_RECENT);
    if ((summary === null || summary.text.trim() === "") && records.length === 0) return { text: call.say("recap.empty"), data: { summary: null, recent: [] } };
    const out = [call.say("recap.header")];
    if (summary !== null && summary.text.trim() !== "") out.push(call.say("recap.through", { turn: summary.throughTurn }), summary.text.trim());
    if (records.length > 0) {
      out.push(call.say("recap.recent"));
      for (const record of records) out.push(call.say("list.bullet", { text: record.text }));
    }
    return { text: out.join("\n"), data: { summary, recent: records } };
  },
};

function runChronicle(call: CommandCall, op: string, note: string | undefined): Done | Refused {
  const views = call.context.services.views;
  const viewer = keeperViewer(call);
  if (op === "list") {
    const records = views
      .views(call.context.room, CHRONICLE_RECORD_TYPE, viewer)
      .map((entry) => ({ id: entry.id, record: entry.view as ChronicleRecord }))
      .sort((left, right) => left.record.turn - right.record.turn || (left.id < right.id ? -1 : 1));
    if (records.length === 0) return { text: call.say("chronicle.empty"), data: { records: [] } };
    const items: string[] = [];
    for (const { record } of records) {
      items.push(call.say("chronicle.line", { turn: record.turn, text: record.text, folded: record.folded ? call.say("chronicle.folded") : "" }));
      if (record.keeper !== "") items.push(call.say("chronicle.margin_line", { text: record.keeper }));
    }
    return { text: lines(call, call.say("chronicle.header", { count: records.length }), items), data: { records } };
  }
  if (op === "summary") {
    const summary = views.view(call.context.room, CAMPAIGN_SUMMARY_TYPE, CAMPAIGN_SUMMARY_ID, viewer) as CampaignSummary | null;
    if (summary === null) return { text: call.say("chronicle.no_summary"), data: { summary: null } };
    const out = [call.say("chronicle.summary_header", { turn: summary.throughTurn, folds: summary.foldCount }), summary.text];
    if (summary.keeper !== "") out.push(call.say("chronicle.margin", { text: summary.keeper }));
    return { text: out.join("\n"), data: { summary } };
  }
  if (op === "threads") {
    const threads = views
      .views(call.context.room, PLOT_THREAD_TYPE, viewer)
      .map((entry) => entry.view as PlotThread)
      .filter((thread) => thread.status === "open");
    if (threads.length === 0) return { text: call.say("chronicle.threads_empty"), data: { threads: [] } };
    const items = threads.map((thread) => call.say(thread.notes === "" ? "chronicle.thread" : "chronicle.thread_notes", { label: thread.label, notes: thread.notes }));
    return { text: lines(call, call.say("chronicle.threads_header"), items), data: { threads } };
  }
  // note: the Keeper's margin on the summary.
  if (note === undefined) return refuse("missing_arg", { path: "text" });
  const document = readDocument(call, CAMPAIGN_SUMMARY_TYPE, CAMPAIGN_SUMMARY_ID);
  if (isRefused(document)) return document;
  const summary = document === null ? null : readCampaignSummary(document.data);
  if (summary === null) return refuse("no_summary");
  const margin = setSummaryMargin(summary, note);
  if (!margin.ok) return refuse("too_long", { limit: MAX_KEEPER_MARGIN_CHARS });
  putDocument(call, CAMPAIGN_SUMMARY_TYPE, CAMPAIGN_SUMMARY_ID, campaignSummaryData(margin.data));
  return { text: call.say("chronicle.noted") };
}

export const chronicleCommand: CommandSpec = {
  id: "chronicle",
  source: "engine",
  key: "chronicle",
  params: object({ op: oneOf(["list", "summary", "threads", "note"]), text: text(MAX_KEEPER_MARGIN_CHARS, 1) }, ["op"]),
  text: { en: ["chronicle"], zh: ["chronicle", "编年史", "年史"] },
  role: "admin",
  parseText(rest) {
    const [word, after] = firstWord(rest);
    if (word === "" || word === "list") return { op: "list" };
    if (word === "summary" || word === "threads") return { op: word };
    if (word === "note") return compact({ op: "note", text: after === "" ? undefined : after });
    return refuse("usage");
  },
  run: (call, args) => runChronicle(call, args.op as string, args.text as string | undefined),
};

export const habitsCommand: CommandSpec = {
  id: "habits",
  source: "engine",
  key: "habits",
  params: object({ op: oneOf(["show", "forget"]), text: text(200, 1) }, ["op"]),
  text: { en: ["habits"], zh: ["habits", "习惯", "習慣"] },
  role: "admin",
  parseText(rest) {
    const [word, after] = firstWord(rest);
    if (word === "" || word === "show") return { op: "show" };
    if (word === "forget") return compact({ op: "forget", text: after === "" ? undefined : after });
    return refuse("usage");
  },
  run(call, args): Done | Refused {
    if (args.op === "show") {
      const habits = call.context.services.views.view(call.context.room, TABLE_HABITS_TYPE, TABLE_HABITS_ID, keeperViewer(call)) as TableHabits | null;
      if (habits === null || (habits.habits.length === 0 && habits.pending.length === 0)) return { text: call.say("habits.empty"), data: { habits: [], pending: [] } };
      const out = [call.say("habits.header")];
      for (const habit of habits.habits) out.push(call.say(habit.detail === "" ? "list.bullet" : "habits.line_detail", { text: habit.summary, detail: habit.detail }));
      if (habits.pending.length > 0) {
        out.push(call.say("habits.pending"));
        for (const candidate of habits.pending) out.push(call.say("habits.line_seen", { text: candidate.summary, seen: candidate.seen }));
      }
      return { text: out.join("\n"), data: habits };
    }
    const summary = args.text as string | undefined;
    if (summary === undefined) return refuse("missing_arg", { path: "text" });
    const document = readDocument(call, TABLE_HABITS_TYPE, TABLE_HABITS_ID);
    if (isRefused(document)) return document;
    const forgotten = forgetHabit(readTableHabits(document?.data ?? {}), summary);
    if (!forgotten.ok) return refuse("not_found", { title: summary });
    putDocument(call, TABLE_HABITS_TYPE, TABLE_HABITS_ID, tableHabitsData(forgotten.data));
    return { text: call.say("habits.forgotten") };
  },
};

