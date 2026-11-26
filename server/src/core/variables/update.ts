// `<UpdateVariable>` blocks in a model's reply: finding them, reading the `_.op(...)`
// commands inside, applying them to the room's tree, and handing back the reply with the
// blocks removed.
//
// The command grammar and each operation's meaning follow MagVarUpdate, read at
// github.com/MagicalAstrogy/MagVarUpdate (branch `beta`):
//   - `extractCommands`, `findMatchingCloseParen`, `parseParameters`, `parseCommandValue`,
//     `trimQuotesAndBackslashes`, `pathFix` and the `set` / `insert` / `delete` / `add`
//     branches of `updateVariables` in `src/function/update_variables.ts`;
//   - the tag names and the reasoning regions it ignores in
//     `src/function/update/structured_update.ts`.
// Where this file departs from MagVarUpdate it says so at the spot. Everything here is
// deterministic: the model proposes text, this code decides what changes (iron rule 1).
import { loadYaml } from "../yaml.ts";
import { readJson5 } from "./json5.ts";
import { applied, refused, type WriteOutcome } from "./results.ts";
import {
  cloneValue,
  fromPlain,
  isContainer,
  isList,
  isMap,
  leafValue,
  toJson,
  treeProblem,
  valuesEqual,
  type Json,
  type VarMap,
  type VarValue,
} from "./tree.ts";

/** A longer reply is not scanned (its blocks stay in the text and nothing applies). */
export const MAX_UPDATE_TEXT_CHARS = 500_000;
/** Commands past this many in one reply are refused (`too_large`), not dropped unseen. */
export const MAX_UPDATE_COMMANDS = 512;

export type UpdateOp = "set" | "insert" | "delete" | "add";

export interface UpdateCommand {
  /** The operation, aliases resolved (`assign` -> insert; `remove`, `unset` -> delete). */
  readonly op: UpdateOp;
  /** The name as written. */
  readonly written: string;
  /** The path argument with its quotes trimmed. */
  readonly path: string;
  /** The remaining arguments as written (each is read by `parseCommandValue` when used). */
  readonly args: readonly string[];
  /** The `//` comment after the command, trimmed. */
  readonly reason: string;
}

export interface CommandResult {
  readonly command: UpdateCommand;
  readonly outcome: WriteOutcome;
}

export interface ExtractedUpdates {
  readonly commands: readonly UpdateCommand[];
  /** The reply with every block removed; byte-identical when there was none. */
  readonly text: string;
  /** Closed blocks found. */
  readonly blocks: number;
  /** The reply was longer than `MAX_UPDATE_TEXT_CHARS` and was not scanned. */
  readonly overflow: boolean;
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

// MagVarUpdate accepts three tag names (`updatevariable|variableupdate|update`). The
// backreference pairs an opening tag with its own closing tag; `\b` keeps
// `<UpdateVariables>` from counting.
const TAGS = "updatevariable|variableupdate|update";
const BLOCK = new RegExp(`<(${TAGS})\\b[^>]*>([\\s\\S]*?)</\\1\\s*>`, "gi");
// A block fenced in triple backticks is unwrapped first so no empty fence is left behind.
const FENCED_BLOCK = new RegExp("```[A-Za-z0-9_-]*\\s*(<(" + TAGS + ")\\b[^>]*>[\\s\\S]*?</\\2\\s*>)\\s*```", "gi");
// Reasoning regions inside a block are not commands (MagVarUpdate masks the same names).
const REASONING = /<(think|thinking|reasoning|analysis|analyze)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const COMMAND = /_\.(set|insert|assign|remove|unset|delete|add)\(/;

/**
 * The update commands in a reply, and the reply without its blocks. Only commands inside
 * closed blocks are read. MagVarUpdate reads `_.op(...);` anywhere in a message, because
 * in SillyTavern the card's own display regex hides the machinery; here the cleaned text
 * is exactly what the table sees, so a command left in the prose would be applied AND
 * shown. Reading blocks only keeps "applied" and "removed from view" the same set.
 */
export function extractUpdates(text: string): ExtractedUpdates {
  if (text.length > MAX_UPDATE_TEXT_CHARS) return { commands: [], text, blocks: 0, overflow: true };
  const unfenced = text.replace(FENCED_BLOCK, (_match, block: string) => block);
  const commands: UpdateCommand[] = [];
  let blocks = 0;
  for (const match of unfenced.matchAll(BLOCK)) {
    blocks += 1;
    const body = (match[2] as string).replace(REASONING, (region) => " ".repeat(region.length));
    commands.push(...scanCommands(body));
  }
  if (blocks === 0) return { commands: [], text, blocks: 0, overflow: false };
  const cleaned = unfenced
    .replace(BLOCK, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { commands, text: cleaned, blocks, overflow: false };
}

/**
 * MagVarUpdate's command scan: every `_.op(` in the text (several may share a line), the
 * matching `)` found with quotes respected, then a REQUIRED `;` — a call without it is not
 * a command ("prevents misreading look-alike text", in MagVarUpdate's words) — and an
 * optional `// reason` up to the end of that line.
 */
function scanCommands(text: string): UpdateCommand[] {
  const out: UpdateCommand[] = [];
  let i = 0;
  while (i < text.length) {
    const match = COMMAND.exec(text.slice(i));
    if (match === null) break;
    const written = match[1] as string;
    const start = i + match.index;
    const open = start + match[0].length;
    const close = matchingParen(text, open);
    if (close < 0) {
      i = open;
      continue;
    }
    let end = close + 1;
    if (text[end] !== ";") {
      i = close + 1;
      continue;
    }
    end += 1;
    let reason = "";
    const comment = /^\s*\/\/(.*)/.exec(text.slice(end));
    if (comment !== null) {
      reason = (comment[1] as string).trim();
      end += comment[0].length;
    }
    const params = splitParameters(text.slice(open, close));
    const op = resolveOp(written);
    const enough = op === "add" ? params.length === 2 : op === "delete" ? params.length >= 1 : params.length >= 2;
    if (enough) {
      out.push({ op, written, path: trimQuotesAndBackslashes(params[0] as string), args: params.slice(1), reason });
    }
    i = end;
  }
  return out;
}

function resolveOp(written: string): UpdateOp {
  if (written === "assign" || written === "insert") return "insert";
  if (written === "remove" || written === "unset" || written === "delete") return "delete";
  return written === "add" ? "add" : "set";
}

function isQuote(ch: string | undefined): boolean {
  return ch === '"' || ch === "'" || ch === "`";
}

/** `findMatchingCloseParen`: parentheses counted outside quotes; -1 when unbalanced. */
function matchingParen(text: string, from: number): number {
  let depth = 1;
  let quote = "";
  for (let i = from; i < text.length; i++) {
    const ch = text[i] as string;
    if (isQuote(ch) && text[i - 1] !== "\\") {
      if (quote === "") quote = ch;
      else if (ch === quote) quote = "";
    }
    if (quote !== "") continue;
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** `parseParameters`: split on commas outside quotes and outside any bracket pair. */
function splitParameters(text: string): string[] {
  const params: string[] = [];
  let current = "";
  let quote = "";
  let parens = 0;
  let brackets = 0;
  let braces = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (isQuote(ch) && (i === 0 || text[i - 1] !== "\\")) {
      if (quote === "") quote = ch;
      else if (ch === quote) quote = "";
    }
    if (quote === "") {
      if (ch === "(") parens += 1;
      if (ch === ")") parens -= 1;
      if (ch === "[") brackets += 1;
      if (ch === "]") brackets -= 1;
      if (ch === "{") braces += 1;
      if (ch === "}") braces -= 1;
    }
    if (ch === "," && quote === "" && parens === 0 && brackets === 0 && braces === 0) {
      params.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim() !== "") params.push(current.trim());
  return params;
}

/**
 * `trimQuotesAndBackslashes`, kept exact: quotes, backticks, backslashes and spaces come
 * off both ends; the pattern has no `s` flag, so text containing a line break is left as
 * it is.
 */
export function trimQuotesAndBackslashes(text: string): string {
  return text.replace(/^[\\"'` ]*(.*?)[\\"'` ]*$/, "$1");
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

// lodash's `stringToPath` pattern (MagVarUpdate addresses the tree with lodash paths):
// a plain segment, a bracketed segment (bare or quoted), or the empty segment between
// two separators.
const PATH_PART = /[^.[\]]+|\[(?:([^"'][^[]*)|(["'])((?:(?!\2)[^\\]|\\.)*?)\2)\]|(?=(?:\.|\[\])(?:\.|\[\]|$))/g;

/**
 * A command path as segments: dots and brackets as in lodash (`a.b.0`, `a.b[0]`,
 * `a["x.y"]`), with MagVarUpdate's `pathFix` touches (a bare bracket segment is trimmed;
 * a dotted segment wholly in quotes loses them). Segments are NOT trimmed: `' 世界 . day '`
 * names the key `"世界 "`, as it does in MagVarUpdate. The empty path is the root.
 */
export function parsePath(path: string): string[] {
  if (path === "") return [];
  const out: string[] = [];
  if (path.startsWith(".")) out.push("");
  PATH_PART.lastIndex = 0;
  for (let match = PATH_PART.exec(path); match !== null; match = PATH_PART.exec(path)) {
    if (match[0] === "") {
      out.push("");
      PATH_PART.lastIndex += 1;
      continue;
    }
    if (match[2] !== undefined) out.push((match[3] as string).replace(/\\(\\)?/g, "$1"));
    else if (match[1] !== undefined) out.push(match[1].trim());
    else {
      const quoted = /^(["'])(.*)\1$/.exec(match[0]);
      out.push(quoted === null ? match[0] : (quoted[2] as string));
    }
  }
  return out;
}

const INDEX = /^(0|[1-9]\d*)$/;

/** The child of a container at one segment; undefined when absent. */
function child(node: VarValue, segment: string): VarValue | undefined {
  if (isMap(node)) return node.get(segment);
  if (isList(node) && INDEX.test(segment)) return node[Number(segment)];
  return undefined;
}

type Located =
  | { readonly ok: true; readonly parent: VarMap | VarValue[]; readonly key: string; readonly node: VarValue | undefined }
  | { readonly ok: false; readonly code: "unknown_path" | "not_a_container" | "root_path" };

/** The parent container of the last segment (which must exist) and the node there, if any. */
function locate(tree: VarMap, segments: readonly string[]): Located {
  if (segments.length === 0) return { ok: false, code: "root_path" };
  let node: VarValue = tree;
  for (const segment of segments.slice(0, -1)) {
    const next = child(node, segment);
    if (next === undefined) return { ok: false, code: "unknown_path" };
    node = next;
  }
  if (!isContainer(node)) return { ok: false, code: "not_a_container" };
  const key = segments[segments.length - 1] as string;
  return { ok: true, parent: node, key, node: child(node, key) };
}

function put(parent: VarMap | VarValue[], key: string, value: VarValue): void {
  if (isMap(parent)) parent.set(key, value);
  else parent[Number(key)] = value;
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

export type CommandValue = { readonly ok: true; readonly value: VarValue } | { readonly ok: false };

/**
 * One argument's value, in `parseCommandValue`'s order: the words `true` / `false` /
 * `null`; strict JSON; a bracketed JSON5 literal; a single-quoted YAML scalar (so `''`
 * is a quote and a backslash is literal); arithmetic; any YAML; and last the text with
 * its quotes trimmed. Two departures: `undefined` is not a value a stored tree can hold,
 * so a command carrying it is refused; and arithmetic is the four operations, `^`,
 * parentheses and unary signs over numbers, rounded to 12 significant digits as
 * MagVarUpdate rounds — not the whole math.js language it evaluates (functions such as
 * `sqrt(16)` and `%` read as text here).
 */
export function parseCommandValue(raw: string): CommandValue {
  const text = raw.trim();
  if (text === "true") return { ok: true, value: true };
  if (text === "false") return { ok: true, value: false };
  if (text === "null") return { ok: true, value: null };
  if (text === "undefined") return { ok: false };
  const strict = readJson5(text, { strict: true });
  if (strict.ok) return strict;
  if ((text.startsWith("{") && text.endsWith("}")) || (text.startsWith("[") && text.endsWith("]"))) {
    const loose = readJson5(text);
    if (loose.ok && isContainer(loose.value)) return loose;
  }
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    const quoted = yamlValue(text);
    if (quoted !== undefined) return { ok: true, value: quoted };
  }
  const arithmetic = evaluateArithmetic(text);
  if (arithmetic !== null) return { ok: true, value: arithmetic };
  const yaml = yamlValue(text);
  if (yaml !== undefined) return { ok: true, value: yaml };
  return { ok: true, value: trimQuotesAndBackslashes(raw) };
}

function yamlValue(text: string): VarValue | undefined {
  try {
    return fromPlain(loadYaml(text));
  } catch {
    return undefined;
  }
}

const MAX_ARITHMETIC_CHARS = 1000;
const MAX_ARITHMETIC_DEPTH = 64;

/** A number from `+ - * / ^ ( )` arithmetic over number literals; null when not that. */
export function evaluateArithmetic(text: string): number | null {
  if (text.length > MAX_ARITHMETIC_CHARS || !/^[\d.eE+\-*/^()\s]+$/.test(text) || !/\d/.test(text)) return null;
  const tokens = text.match(/(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|[+\-*/^()]|\S/g) ?? [];
  let pos = 0;
  const peek = (): string | undefined => tokens[pos];
  const fail = (): never => {
    throw new RangeError("arithmetic");
  };
  const expression = (depth: number): number => {
    let value = term(depth);
    while (peek() === "+" || peek() === "-") {
      const operator = tokens[pos++];
      const right = term(depth);
      value = operator === "+" ? value + right : value - right;
    }
    return value;
  };
  const term = (depth: number): number => {
    let value = unary(depth);
    while (peek() === "*" || peek() === "/") {
      const operator = tokens[pos++];
      const right = unary(depth);
      value = operator === "*" ? value * right : value / right;
    }
    return value;
  };
  // As in math.js, a unary sign binds looser than `^` (-2^2 is -4) and `^` is right-associative.
  const unary = (depth: number): number => {
    if (depth > MAX_ARITHMETIC_DEPTH) fail();
    if (peek() === "-") {
      pos += 1;
      return -unary(depth + 1);
    }
    if (peek() === "+") {
      pos += 1;
      return unary(depth + 1);
    }
    const base = primary(depth);
    if (peek() === "^") {
      pos += 1;
      return base ** unary(depth + 1);
    }
    return base;
  };
  const primary = (depth: number): number => {
    const token = tokens[pos++];
    if (token === "(") {
      const value = expression(depth + 1);
      if (tokens[pos++] !== ")") fail();
      return value;
    }
    if (token === undefined || !/^(?:\d|\.\d)/.test(token)) return fail();
    return Number(token);
  };
  try {
    const value = expression(0);
    if (pos !== tokens.length || !Number.isFinite(value)) return null;
    return Number.parseFloat(value.toPrecision(12));
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
}

/** JavaScript `Number(x)` for the scalars MagVarUpdate coerces; NaN for containers. */
function jsNumber(value: VarValue): number {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") return Number(value);
  return Number.NaN;
}

function report(value: VarValue | undefined): Json {
  return value === undefined ? null : toJson(value);
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/**
 * `_.set(path, [old,] new)`: the LAST argument is the new value (an expected old value is
 * an annotation and never checked). The path must already exist — MagVarUpdate refuses a
 * set on a missing path (`setPathMissing`); only `insert` creates. On a
 * `[value, "description"]` pair whose value is not a list, the value is replaced and the
 * description kept, a number staying a number; a number target written with text becomes
 * that text as a number. A write whose number would be NaN or infinite is refused
 * (MagVarUpdate stores the NaN; a stored tree is JSON and cannot hold it).
 */
function opSet(tree: VarMap, command: UpdateCommand): WriteOutcome {
  const at = locate(tree, parsePath(command.path));
  if (!at.ok) return refused(at.code);
  if (at.node === undefined) return refused(isList(at.parent) ? "bad_index" : "unknown_path");
  const parsed = parseCommandValue(command.args[command.args.length - 1] as string);
  if (!parsed.ok) return refused("bad_value");
  const old = at.node;
  let value = parsed.value;
  if (isList(old) && old.length === 2 && typeof old[1] === "string" && !isList(old[0])) {
    let inner = value;
    if (typeof old[0] === "number" && value !== null) {
      inner = jsNumber(value);
      if (!Number.isFinite(inner)) return refused("not_a_number");
    }
    put(at.parent, at.key, [inner, old[1]]);
    return applied(report(old[0]), report(inner));
  }
  if (typeof old === "number" && typeof value === "string") {
    value = jsNumber(value);
    if (!Number.isFinite(value)) return refused("not_a_number");
  }
  put(at.parent, at.key, cloneValue(value));
  return applied(report(old), report(value));
}

/**
 * `_.insert(path, value)` / `_.insert(path, key, value)` (alias `assign`). Two arguments:
 * append to a list, or deep-merge a mapping into a mapping (lodash `merge`). Three: insert
 * into a list at a numeric index (`-` appends; negative counts from the end; past the end
 * appends — JavaScript `splice`), or set a mapping's key. A missing target is created when
 * its parent exists (a list when the value is a list, else a mapping); a target holding a
 * scalar is refused. One departure: a non-numeric key on a list is refused — in
 * MagVarUpdate it becomes a JavaScript array property (`"0"` overwrites an element, any
 * other name vanishes on save), which no author means.
 */
function opInsert(tree: VarMap, command: UpdateCommand): WriteOutcome {
  const at = locate(tree, parsePath(command.path));
  if (!at.ok) return refused(at.code === "unknown_path" ? "missing_parent" : at.code);
  const existing = at.node;
  if (existing !== undefined && existing !== null && !isContainer(existing)) return refused("not_a_container");
  const keyed = command.args.length >= 2;
  const parsedValue = parseCommandValue(command.args[keyed ? 1 : 0] as string);
  if (!parsedValue.ok) return refused("bad_value");
  const value = cloneValue(parsedValue.value);
  const before = report(existing);
  const create = (container: VarMap | VarValue[]): VarMap | VarValue[] | null => {
    if (isList(at.parent) && !INDEX.test(at.key)) return null;
    if (isList(at.parent) && Number(at.key) >= at.parent.length) return null;
    put(at.parent, at.key, container);
    return container;
  };
  if (!keyed) {
    if (isList(existing)) {
      existing.push(value);
    } else if (isMap(existing)) {
      if (!isMap(value)) return refused("merge_mismatch");
      mergeInto(existing, value);
    } else {
      if (!isList(value) && !isMap(value)) return refused("merge_mismatch");
      const made = create(isList(value) ? [value] : (cloneValue(value) as VarMap));
      if (made === null) return refused("bad_index");
    }
    return applied(before, report(child(at.parent, at.key)));
  }
  const parsedKey = parseCommandValue(command.args[0] as string);
  if (!parsedKey.ok) return refused("bad_value");
  const key = parsedKey.value;
  if (isList(existing)) {
    if (typeof key !== "number" && key !== "-") return refused("bad_index");
    const length = existing.length;
    let index = key === "-" ? length : Math.trunc(key);
    if (index < 0) index = Math.max(length + index, 0);
    existing.splice(Math.min(index, length), 0, value);
  } else {
    if (isContainer(key)) return refused("bad_value");
    const name = String(key);
    if (isMap(existing)) existing.set(name, value);
    else if (create(new Map([[name, value]])) === null) return refused("bad_index");
  }
  return applied(before, report(child(at.parent, at.key)));
}

/** lodash `merge` of one mapping into another: mappings recurse, lists merge by index. */
function mergeInto(target: VarMap, source: VarMap): void {
  for (const [key, value] of source) {
    const existing = target.get(key);
    if (isMap(existing) && isMap(value)) mergeInto(existing, value);
    else if (isList(existing) && isList(value)) mergeLists(existing, value);
    else target.set(key, cloneValue(value));
  }
}

function mergeLists(target: VarValue[], source: VarValue[]): void {
  source.forEach((value, index) => {
    const existing = target[index];
    if (isMap(existing) && isMap(value)) mergeInto(existing, value);
    else if (isList(existing) && isList(value)) mergeLists(existing, value);
    else target[index] = cloneValue(value);
  });
}

/**
 * `_.delete(path)` removes the node (a trailing digit segment on a list removes that
 * element); `_.delete(path, target)` removes FROM the container at `path`: from a list the
 * element at a numeric index or else the first element equal to the target; from a
 * mapping the key named by the target (a number names the n-th key, in written order).
 * Aliases `remove`, `unset`.
 */
function opDelete(tree: VarMap, command: UpdateCommand): WriteOutcome {
  const segments = parsePath(command.path);
  if (segments.length === 0) return refused("root_path");
  const last = segments[segments.length - 1] as string;
  if (command.args.length === 0 && /^\d+$/.test(last)) {
    const container = navigate(tree, segments.slice(0, -1));
    const index = Number.parseInt(last, 10);
    if (isList(container) && index < container.length) {
      const before = report(container);
      container.splice(index, 1);
      return applied(before, report(container));
    }
  }
  const at = locate(tree, segments);
  if (!at.ok) return refused(at.code);
  const node = at.node;
  if (node === undefined) return refused("unknown_path");
  if (command.args.length === 0) {
    if (isMap(at.parent)) at.parent.delete(at.key);
    else at.parent.splice(Number(at.key), 1);
    return applied(report(node), null);
  }
  const parsed = parseCommandValue(command.args[0] as string);
  if (!parsed.ok) return refused("bad_value");
  const target = parsed.value;
  if (!isContainer(node)) return refused("not_a_container");
  const before = report(node);
  if (isList(node)) {
    const index = typeof target === "number" ? Math.trunc(target) : node.findIndex((item) => valuesEqual(item, target));
    if (!(index >= 0 && index < node.length)) return refused("not_found");
    node.splice(index, 1);
  } else if (typeof target === "number") {
    const keys = [...node.keys()];
    const index = Math.trunc(target);
    if (!(index >= 0 && index < keys.length)) return refused("not_found");
    node.delete(keys[index] as string);
  } else {
    if (isContainer(target)) return refused("not_found");
    const name = String(target);
    if (!node.has(name)) return refused("not_found");
    node.delete(name);
  }
  return applied(before, report(node));
}

function navigate(tree: VarMap, segments: readonly string[]): VarValue | undefined {
  let node: VarValue | undefined = tree;
  for (const segment of segments) {
    if (node === undefined) return undefined;
    node = child(node, segment);
  }
  return node;
}

/**
 * `_.add(path, delta)`: a number plus a number, rounded to 12 significant digits as
 * MagVarUpdate rounds; a `[number, "description"]` pair keeps its description. Anything
 * else is refused: a boolean target (MagVarUpdate's `add` does not toggle) and a boolean
 * delta (it is not a number — the number is never turned into a boolean). Departure:
 * MagVarUpdate also adds milliseconds to a date string; JavaScript reads a date without a
 * zone in the host's local time, which would make the result depend on the server, so a
 * date target is refused here.
 */
function opAdd(tree: VarMap, command: UpdateCommand): WriteOutcome {
  const at = locate(tree, parsePath(command.path));
  if (!at.ok) return refused(at.code);
  const node = at.node;
  if (node === undefined) return refused(isList(at.parent) ? "bad_index" : "unknown_path");
  // MagVarUpdate: a pair counts as described here only when `typeof value !== 'object'`.
  const described = isList(node) && node.length === 2 && typeof node[1] === "string" && node[0] !== null && !isContainer(node[0]);
  const current = described ? (node as VarValue[])[0] : node;
  const parsed = parseCommandValue(command.args[0] as string);
  if (!parsed.ok) return refused("bad_value");
  if (typeof current !== "number") return refused("unsupported_target");
  const delta = parsed.value;
  if (typeof delta !== "number") return refused("delta_not_number");
  const sum = Number.parseFloat((current + delta).toPrecision(12));
  if (!Number.isFinite(sum)) return refused("not_a_number");
  put(at.parent, at.key, described ? [sum, (node as VarValue[])[1] as string] : sum);
  return applied(current, sum);
}

const OPERATIONS: Record<UpdateOp, (tree: VarMap, command: UpdateCommand) => WriteOutcome> = {
  set: opSet,
  insert: opInsert,
  delete: opDelete,
  add: opAdd,
};

export interface UpdateApplication {
  readonly tree: VarMap;
  /** Whether any command applied (a caller saves only then). */
  readonly changed: boolean;
  readonly results: readonly CommandResult[];
}

/**
 * Apply commands in order. Each runs on a copy that replaces the tree only when the
 * command applies, so a refused command changes nothing (not even half of itself) and
 * never stops the ones after it. The input tree is not modified.
 */
export function applyUpdates(tree: VarMap, commands: readonly UpdateCommand[]): UpdateApplication {
  let current = cloneValue(tree) as VarMap;
  let changed = false;
  const results: CommandResult[] = [];
  commands.forEach((command, index) => {
    if (index >= MAX_UPDATE_COMMANDS) {
      results.push({ command, outcome: refused("too_large") });
      return;
    }
    const working = cloneValue(current) as VarMap;
    let outcome = OPERATIONS[command.op](working, command);
    if (outcome.status === "applied" && treeProblem(working) !== null) outcome = refused("too_large");
    if (outcome.status === "applied") {
      current = working;
      changed = true;
    }
    results.push({ command, outcome });
  });
  return { tree: current, changed, results };
}

export interface ReplyUpdate extends UpdateApplication {
  /** The reply with its blocks removed (byte-identical when it had none). */
  readonly text: string;
  readonly overflow: boolean;
}

/** One reply through the whole protocol: extract, apply, and the cleaned text. */
export function applyReplyUpdates(tree: VarMap, reply: string): ReplyUpdate {
  const extracted = extractUpdates(reply);
  const application = applyUpdates(tree, extracted.commands);
  return { ...application, text: extracted.text, overflow: extracted.overflow };
}

/** The value at a dotted path, a described leaf unwrapped; undefined when absent. */
export function readPath(tree: VarMap, path: string): VarValue | undefined {
  const node = navigate(tree, parsePath(path));
  return node === undefined ? undefined : leafValue(node);
}
