// Variable tools: the declared module variables (`set_variable`, `adjust_variable`) and
// the imported card's variable tree (`set_stat`, `adjust_stat`, `get_stat`). Iron rule 1:
// every write is validated and clamped by `core/variables`; the stored value is the truth
// and the model narrates around it. Every applied write is recorded for the turn's
// bookkeeping (the room's variable hooks and the Scribe read it) and marks a pending
// "set before play" choice on that path as made.
import { LORE_OVERLAY_ID, LORE_OVERLAY_TYPE, markSetupDone, overlayData, readOverlay } from "../../core/lore/index.ts";
import {
  adjustVariable,
  applyUpdates,
  flattenLeaves,
  labelFor,
  type ModuleVariables,
  moduleVariablesPayload,
  MODULE_VARIABLES_ID,
  MODULE_VARIABLES_TYPE,
  normalizeModuleVariables,
  normalizeVariableId,
  parsePath,
  readPath,
  readVariableTree,
  setVariable,
  toJson,
  type UpdateCommand,
  type VarMap,
  variableTreeData,
  VARIABLE_TREE_ID,
  VARIABLE_TREE_TYPE,
  type WriteOutcome,
  type WriteRefusalCode,
} from "../../core/variables/index.ts";
import type { RoomContext } from "../context.ts";
import { param } from "./params.ts";
import { getDocument, putDocument, refuse, shown } from "./shared.ts";
import { defineTool, type ToolResult, type VariableWrite } from "./types.ts";

/** How many leaves `get_stat` lists for the whole tree. */
const LISTED_LEAVES = 100;

const WRITE_REFUSALS: Readonly<Record<WriteRefusalCode, string>> = {
  unknown_path: "nothing exists at that path",
  not_a_container: "a segment of the path lands inside a value that holds no children",
  missing_parent: "the parent of that path does not exist",
  root_path: "the whole tree cannot be written at once",
  bad_index: "that list index is not usable",
  not_a_number: "the value is not a number",
  delta_not_number: "the change is not a number",
  unsupported_target: "the value there is not a number",
  bad_value: "the value could not be read",
  not_found: "no such element",
  merge_mismatch: "the value's shape does not fit what is there",
  too_large: "the write would make the variables too large",
  not_an_option: "the value is not one of the variable's options",
  not_a_boolean: "the value is not true or false",
  not_text: "the value is not text",
  too_long: "the text is too long",
  wrong_kind: "only a number variable can be adjusted",
  limit_reached: "no more variables may be declared",
};

function refusedWrite(code: WriteRefusalCode): ToolResult {
  return refuse(code, `Not written: ${WRITE_REFUSALS[code]}.`);
}

/** A pending "set before play" choice on `path` is made by whoever writes it. */
function markSetup(context: RoomContext, path: string): void {
  const document = getDocument(context, LORE_OVERLAY_TYPE, LORE_OVERLAY_ID);
  if (document === null || document.corrupt) return;
  const marked = markSetupDone(readOverlay(document.data), path);
  if (marked.changed) putDocument(context, LORE_OVERLAY_TYPE, LORE_OVERLAY_ID, overlayData(marked.overlay), document);
}

// ---------------------------------------------------------------------------
// Module variables
// ---------------------------------------------------------------------------

type Located = { readonly ok: true; readonly id: string; readonly state: ModuleVariables; readonly document: ReturnType<typeof getDocument> } | { readonly ok: false; readonly result: ToolResult };

function locateVariable(context: RoomContext, varId: string): Located {
  const document = getDocument(context, MODULE_VARIABLES_TYPE, MODULE_VARIABLES_ID);
  const state = document === null || document.corrupt ? normalizeModuleVariables(null) : normalizeModuleVariables(document.data);
  if (state.variables.length === 0) return { ok: false, result: refuse("no_variables", "No module variables are declared in this room.") };
  const id = normalizeVariableId(varId);
  if (id === null || !state.variables.some((variable) => variable.spec.id === id)) {
    return { ok: false, result: refuse("unknown_variable", `Unknown variable "${varId}". Declared variables: ${state.variables.map((variable) => variable.spec.id).join(", ")}.`) };
  }
  return { ok: true, id, state, document };
}

function writeVariable(context: RoomContext, located: Extract<Located, { ok: true }>, write: { state: ModuleVariables; outcome: WriteOutcome }, op: VariableWrite["op"], delta?: number): ToolResult {
  if (write.outcome.status === "refused") return refusedWrite(write.outcome.code);
  putDocument(context, MODULE_VARIABLES_TYPE, MODULE_VARIABLES_ID, moduleVariablesPayload(write.state), located.document);
  markSetup(context, located.id);
  const spec = write.state.variables.find((variable) => variable.spec.id === located.id)?.spec;
  const label = spec === undefined ? located.id : labelFor(spec, "en");
  const change = delta === undefined ? "" : ` (change: ${delta})`;
  return {
    text: `${label} [${located.id}]: ${shown(write.outcome.old)} → ${shown(write.outcome.value)}${change}.`,
    bookkeeping: { variableWrites: [{ path: located.id, op }] },
  };
}

export const setVariableTool = defineTool({
  name: "set_variable",
  description:
    "Set a defined module variable to an exact value. The engine validates the value against the variable's declared kind (numbers clamp into their bounds, enums must match an option, bools accept true/false forms) — the stored result is authoritative; narrate around it.",
  params: {
    // Carried over with one mention changed: `define_variable` is not in 3.0 (variables are declared by the pack or the admin).
    var_id: param.string("The variable's id, as the module declares it."),
    value: param.string("The new value, as text (e.g. \"7\", \"true\", \"panicked\", \"the vault key\")."),
  },
  flags: {},
  suspends: null,
  run(context, args): ToolResult {
    const located = locateVariable(context, args.var_id);
    if (!located.ok) return located.result;
    return writeVariable(context, located, setVariable(located.state, located.id, args.value), "set");
  },
});

export const adjustVariableTool = defineTool({
  name: "adjust_variable",
  description:
    "Nudge a number-kind module variable by a signed delta (clamped into its bounds). Call this when play actually moves the tracker — a clue found, a night of terror, a rumor spreading — the number should inform your narration's tone, never the other way around.",
  params: {
    var_id: param.string("The variable's id, as the module declares it. Number kind only."),
    delta: param.integer("Signed integer change to apply (e.g. 1, -2)."),
    reason: param.string("Optional free-text note on why, for your own bookkeeping; not required.").or(""),
  },
  flags: {},
  suspends: null,
  run(context, args): ToolResult {
    const located = locateVariable(context, args.var_id);
    if (!located.ok) return located.result;
    return writeVariable(context, located, adjustVariable(located.state, located.id, args.delta), "add", args.delta);
  },
});

// ---------------------------------------------------------------------------
// The imported variable tree
// ---------------------------------------------------------------------------

const NO_TREE = refuse("no_variable_tree", "This room has no imported card variable tree (MVU stat data) yet.");

function readTree(context: RoomContext): { readonly tree: VarMap; readonly exposed: readonly string[]; readonly document: ReturnType<typeof getDocument> } | null {
  const document = getDocument(context, VARIABLE_TREE_TYPE, VARIABLE_TREE_ID);
  if (document === null || document.corrupt) return null;
  const stored = readVariableTree(document.data);
  return stored.tree.size === 0 ? null : { ...stored, document };
}

/** A path in bracket form, which names every segment exactly (keys may hold dots). */
function bracketPath(segments: readonly string[]): string {
  return segments.map((segment) => `["${segment.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`).join("");
}

function command(op: UpdateCommand["op"], path: string, args: readonly string[], reason: string): UpdateCommand {
  return { op, written: op, path, args, reason };
}

function applyTreeWrite(context: RoomContext, path: string, commands: readonly UpdateCommand[], op: VariableWrite["op"], delta?: number): ToolResult {
  const stored = readTree(context);
  if (stored === null) return NO_TREE;
  let application = applyUpdates(stored.tree, commands.slice(0, 1));
  const first = application.results[0]?.outcome;
  // `set` writes only an existing path (MagVarUpdate); the Keeper may also introduce a
  // leaf under an existing parent, as the reference tool allowed — that is an insert.
  if (first?.status === "refused" && first.code === "unknown_path" && commands.length > 1) {
    application = applyUpdates(stored.tree, commands.slice(1));
  }
  const outcome = application.results[0]?.outcome;
  if (outcome === undefined) return refusedWrite("bad_value");
  if (outcome.status === "refused") return refusedWrite(outcome.code);
  putDocument(context, VARIABLE_TREE_TYPE, VARIABLE_TREE_ID, variableTreeData(application.tree, stored.exposed), stored.document);
  markSetup(context, path);
  const now = readPath(application.tree, path);
  const change = delta === undefined ? "" : ` (change: ${delta})`;
  return {
    text: `${path}: ${shown(outcome.old)} → ${shown(now === undefined ? outcome.value : toJson(now))}${change}.`,
    bookkeeping: { variableWrites: [{ path, op }] },
  };
}

export const setStatTool = defineTool({
  name: "set_stat",
  description:
    "Set one value in the imported card's variable tree (MVU stat data) when play changes it — the deterministic bookkeeping behind the card's trackers. Numbers, true/false, and quoted JSON parse as themselves; anything else stores as text.",
  params: {
    path: param.string("Dot-separated variable path (e.g. \"理.情绪状态.pleasure\")."),
    value: param.string("The new value, as text (e.g. \"0.4\", \"true\", \"教堂\")."),
    reason: param.string("Optional note on why, for your own bookkeeping; not required.").or(""),
  },
  flags: {},
  suspends: null,
  run(context, args): ToolResult {
    const path = args.path.trim();
    const segments = parsePath(path);
    const commands = [command("set", path, [args.value], args.reason)];
    if (segments.length > 1) {
      const last = segments[segments.length - 1] as string;
      commands.push(command("insert", bracketPath(segments.slice(0, -1)), [JSON.stringify(last), args.value], args.reason));
    }
    return applyTreeWrite(context, path, commands, "set");
  },
});

export const adjustStatTool = defineTool({
  name: "adjust_stat",
  description: "Nudge a numeric value in the imported card's variable tree by a signed delta.",
  params: {
    path: param.string("Dot-separated variable path to a number (e.g. \"理.好感度\")."),
    delta: param.number("Signed change to apply (e.g. 2, -0.1)."),
    reason: param.string("Optional note on why, for your own bookkeeping; not required.").or(""),
  },
  flags: {},
  suspends: null,
  run(context, args): ToolResult {
    const path = args.path.trim();
    return applyTreeWrite(context, path, [command("add", path, [String(args.delta)], args.reason)], "add", args.delta);
  },
});

export const getStatTool = defineTool({
  name: "get_stat",
  description:
    "Read the imported card's variable tree (MVU stat data), either one value or the whole flattened tree. Prefer the always-on state in your context; this is the read-on-demand path for double-checking.",
  params: {
    path: param.string("Dot-separated variable path (e.g. \"理.好感度\"); empty returns every leaf.").or(""),
  },
  flags: { readOnly: true },
  suspends: null,
  run(context, args): ToolResult {
    const stored = readTree(context);
    if (stored === null) return NO_TREE;
    const path = args.path.trim();
    if (path !== "") {
      const value = readPath(stored.tree, path);
      return value === undefined ? { text: `No variable at path "${path}".` } : { text: `${path} = ${shown(toJson(value))}` };
    }
    const leaves = flattenLeaves(stored.tree, LISTED_LEAVES);
    return { text: ["Current card variables:", ...leaves.map((leaf) => `- ${leaf.path} = ${shown(leaf.value)}`)].join("\n") };
  },
});
