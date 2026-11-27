// A module command's text forms: what a member types to run it (`.attack Bo`). A form is
// read once, at load, against the command's `params`; a typed line is matched against the
// forms that survived.
//
// The grammar of a form: words separated by single spaces.
//   - The first word is the command word: what follows the `.` prefix. Letters, digits and
//     `_`, 1 to `MAX_FORM_WORD_CHARS` code points, any script (`攻击` is a word); never `/`.
//     It is matched case-folded.
//   - Each later token is a literal word (matched case-folded), `{name}` (one
//     whitespace-delimited word of the input) or — as the LAST token only — `{name...}`
//     (the rest of the line, trimmed; absent when empty).
//   - Every `name` is a property of the command's `params`, used once.
// A typed argument is coerced by its property's declared `type`: an integer or a number is
// parsed strictly, a boolean is `true` or `false`, anything else stays the text typed. The
// result is checked against `params` like any other arguments.
//
// The engine reads and matches forms with this file, and the test host (`testing.ts`) runs
// the same code, so what an author's test sees is what a room does.
import { charCount, foldCase } from "./text.ts";

/** The longest command word, in code points. */
export const MAX_FORM_WORD_CHARS = 32;

const WORD = /^[\p{L}\p{N}_]+$/u;
const ONE = /^\{([^{}\s.]+)\}$/u;
const REST = /^\{([^{}\s.]+)\.\.\.\}$/u;
const LITERAL = /^[^{}\s]+$/u;
const INTEGER = /^[+-]?\d+$/u;
const NUMBER = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/u;

export type FormToken =
  | { readonly kind: "literal"; readonly text: string }
  | { readonly kind: "one"; readonly name: string }
  | { readonly kind: "rest"; readonly name: string };

export interface TextForm {
  /** As the module wrote it. */
  readonly source: string;
  /** The command word, case-folded. */
  readonly word: string;
  /** The tokens after the command word. */
  readonly tokens: readonly FormToken[];
  /** How many of them are literal words: of two matching forms, the one with more wins. */
  readonly literals: number;
}

/**
 * Why a form was dropped: `spacing` (not single-space separated), `bad_word` (the command word
 * breaks its rule), `bad_token`, `rest_not_last`, `unknown_param` (a name `params` does not
 * declare), `repeated_param`.
 */
export type FormProblem = "spacing" | "bad_word" | "bad_token" | "rest_not_last" | "unknown_param" | "repeated_param";

type Rec = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is Rec {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The property schemas `params` declares, by name (own properties only). */
function properties(params: unknown): Rec {
  const declared = isRecord(params) && Object.hasOwn(params, "properties") ? params.properties : undefined;
  return isRecord(declared) ? declared : {};
}

/** One form read against `params`: the form, or why it is dropped. */
export function parseForm(source: string, params: unknown): { readonly ok: true; readonly form: TextForm } | { readonly ok: false; readonly problem: FormProblem } {
  const parts = source.split(" ");
  if (parts.some((part) => part === "" || /\s/u.test(part))) return { ok: false, problem: "spacing" };
  const [first, ...rest] = parts as [string, ...string[]];
  if (!WORD.test(first) || charCount(first) > MAX_FORM_WORD_CHARS) return { ok: false, problem: "bad_word" };
  const declared = properties(params);
  const used = new Set<string>();
  const tokens: FormToken[] = [];
  for (const [index, part] of rest.entries()) {
    const restName = REST.exec(part)?.[1];
    const oneName = ONE.exec(part)?.[1];
    const name = restName ?? oneName;
    if (name !== undefined) {
      if (restName !== undefined && index !== rest.length - 1) return { ok: false, problem: "rest_not_last" };
      if (!Object.hasOwn(declared, name)) return { ok: false, problem: "unknown_param" };
      if (used.has(name)) return { ok: false, problem: "repeated_param" };
      used.add(name);
      tokens.push(restName !== undefined ? { kind: "rest", name } : { kind: "one", name });
    } else if (LITERAL.test(part)) {
      tokens.push({ kind: "literal", text: foldCase(part) });
    } else {
      return { ok: false, problem: "bad_token" };
    }
  }
  return { ok: true, form: { source, word: foldCase(first), tokens, literals: tokens.filter((token) => token.kind === "literal").length } };
}

/**
 * The words a form captures from a typed argument string (`rest`, after the command word),
 * as typed, by name; null when the line does not fit the form.
 */
export function matchForm(form: TextForm, rest: string): ReadonlyMap<string, string> | null {
  const words = [...rest.matchAll(/\S+/gu)];
  const captured = new Map<string, string>();
  let at = 0;
  for (const token of form.tokens) {
    if (token.kind === "rest") {
      const start = words[at]?.index;
      const text = start === undefined ? "" : rest.slice(start).trim();
      if (text !== "") captured.set(token.name, text);
      at = words.length;
      break;
    }
    const word = words[at]?.[0];
    if (word === undefined) return null;
    if (token.kind === "literal") {
      if (foldCase(word) !== token.text) return null;
    } else {
      captured.set(token.name, word);
    }
    at += 1;
  }
  return at === words.length ? captured : null;
}

/**
 * Of the forms one command word has, in declaration order, the one that fits `rest` with the
 * most literal words; of equal ones, the first declared. Null when none fits. The engine and
 * the test host both choose this way.
 */
export function pickForm<T extends { readonly form: TextForm }>(
  candidates: readonly T[],
  rest: string,
): { readonly candidate: T; readonly captured: ReadonlyMap<string, string> } | null {
  let best: { readonly candidate: T; readonly captured: ReadonlyMap<string, string> } | null = null;
  for (const candidate of candidates) {
    const captured = matchForm(candidate.form, rest);
    if (captured !== null && (best === null || candidate.form.literals > best.candidate.form.literals)) best = { candidate, captured };
  }
  return best;
}

/** The types a property schema declares, as a list. */
function typesOf(schema: unknown): readonly string[] {
  const type = isRecord(schema) && Object.hasOwn(schema, "type") ? schema.type : undefined;
  return (Array.isArray(type) ? type : [type]).filter((entry): entry is string => typeof entry === "string");
}

/** One typed word as its property's declared type takes it; the text itself when it does not parse. */
export function coerceWord(text: string, schema: unknown): string | number | boolean {
  const types = typesOf(schema);
  if (types.includes("integer") && INTEGER.test(text)) {
    const value = Number(text);
    if (Number.isSafeInteger(value)) return value;
  }
  if (types.includes("number") && NUMBER.test(text)) {
    const value = Number(text);
    if (Number.isFinite(value)) return value;
  }
  if (types.includes("boolean") && (text === "true" || text === "false")) return text === "true";
  return text;
}

/**
 * The argument object of a matched form: each captured word coerced by its property's type.
 * Built with `defineProperty`, so a name such as `__proto__` is a plain argument.
 */
export function formArgs(captured: ReadonlyMap<string, string>, params: unknown): Record<string, unknown> {
  const declared = properties(params);
  const args: Record<string, unknown> = {};
  for (const [name, text] of captured) {
    Object.defineProperty(args, name, { value: coerceWord(text, declared[name]), enumerable: true, writable: true, configurable: true });
  }
  return args;
}
