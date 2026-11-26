// The one argument decoder every tool goes through. It never throws: whatever the model
// sent comes back either as the handler's typed arguments or as an error sentence the
// model can act on (the caller wraps it as "Invalid arguments for tool <name>: ...").
//
// The rules are the 2.6 server's (`agent/tools.py` `_coerce_arguments` / `_coerce_*`):
//   - an argument name the tool does not have is refused, listing the accepted ones — a
//     misnamed argument is a mistake the model can fix, never a harmless extra (a
//     `kp_note(value=...)` aimed at `content` once set the player-visible scene to "");
//   - a missing required argument is reported by name; an absent optional one is
//     `undefined`, an absent defaulted one its default; `null` counts as absent;
//   - string: kept; a number or boolean is written out (`True`/`False`, as the reference
//     did); an array or object becomes its JSON text;
//   - integer: a boolean counts 1/0, a whole-valued number is taken, a string of decimal
//     digits (with sign, surrounding space allowed) is parsed;
//   - number: never a boolean; a number, or a decimal numeric string;
//   - boolean: `true/1/yes/y/on`, `false/0/no/n/off` (any case, trimmed), or a number
//     (non-zero is true);
//   - array: must be an array; each item is coerced by the item type;
//   - object: must be a JSON object (the reference passed anything through; an array or
//     a scalar here could only fail later, so it is refused now).
// Departures, all toward refusing: integers must be exact (`Number.isSafeInteger`), and the
// non-JSON spellings Python also accepted (`inf`, `1_000`, full-width digits) are refused.
import type { ToolInput } from "../../infra/llm/types.ts";
import type { AnyParam, ArgsOf, ItemType, ParamSet, ParamType } from "./params.ts";

export type Decoded<A> = { readonly ok: true; readonly args: A } | { readonly ok: false; readonly error: string };

/** How much of an unreadable argument text an error quotes back. */
export const MAX_QUOTED_INPUT_CHARS = 200;

class ArgumentError extends Error {}

function show(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function preview(text: string): string {
  const points = Array.from(text);
  return points.length <= MAX_QUOTED_INPUT_CHARS ? text : `${points.slice(0, MAX_QUOTED_INPUT_CHARS).join("")}…`;
}

export function coerceString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") return String(value);
  return show(value);
}

const INTEGER_TEXT = /^[+-]?\d+$/;
const NUMBER_TEXT = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const TRUE_WORDS = new Set(["true", "1", "yes", "y", "on"]);
const FALSE_WORDS = new Set(["false", "0", "no", "n", "off"]);

export function coerceInteger(value: unknown): number {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number" && Number.isSafeInteger(value)) return value + 0;
  if (typeof value === "string") {
    const text = value.trim();
    if (INTEGER_TEXT.test(text)) {
      const parsed = Number(text);
      if (Number.isSafeInteger(parsed)) return parsed + 0;
    }
  }
  throw new ArgumentError(`cannot coerce ${show(value)} to int`);
}

export function coerceNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const text = value.trim();
    if (NUMBER_TEXT.test(text)) {
      const parsed = Number(text);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  throw new ArgumentError(`cannot coerce ${show(value)} to float`);
}

export function coerceBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value !== 0;
  if (typeof value === "string") {
    const word = value.trim().toLowerCase();
    if (TRUE_WORDS.has(word)) return true;
    if (FALSE_WORDS.has(word)) return false;
  }
  throw new ArgumentError(`cannot coerce ${show(value)} to bool`);
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function coerceScalar(value: unknown, type: ItemType): unknown {
  switch (type) {
    case "string":
      return coerceString(value);
    case "integer":
      return coerceInteger(value);
    case "number":
      return coerceNumber(value);
    case "boolean":
      return coerceBoolean(value);
  }
}

function coerce(value: unknown, type: ParamType, items: ItemType | null): unknown {
  switch (type) {
    case "object":
      if (!isPlainObject(value)) throw new ArgumentError(`expected an object, got ${show(value)}`);
      return value;
    case "array": {
      if (!Array.isArray(value)) throw new ArgumentError(`expected a list, got ${show(value)}`);
      return Object.freeze(value.map((item) => (items === null ? item : coerceScalar(item, items))));
    }
    default:
      return coerceScalar(value, type);
  }
}

/** The value of `name` in what the model sent, own properties only (`__proto__` is a name like any other). */
function sent(values: Readonly<Record<string, unknown>>, name: string): unknown {
  return Object.hasOwn(values, name) ? values[name] : undefined;
}

/** Decode one call's arguments against a tool's parameters. */
export function decodeArgs<S extends ParamSet>(params: S, input: ToolInput): Decoded<ArgsOf<S>> {
  if (!input.valid) {
    return { ok: false, error: `the arguments were not a JSON object (received ${show(preview(input.raw))}); send the call again with a JSON object of named arguments` };
  }
  const values = input.value;
  const accepted = Object.keys(params);
  const unknown = Object.keys(values).filter((name) => !Object.hasOwn(params, name));
  if (unknown.length > 0) {
    const names = unknown.map((name) => `'${name}'`).join(", ");
    return { ok: false, error: `unknown argument${unknown.length > 1 ? "s" : ""} ${names}; accepted parameters: ${accepted.join(", ") || "(none)"}` };
  }
  const args: Record<string, unknown> = {};
  try {
    for (const name of accepted) {
      const spec = params[name] as AnyParam;
      const value = sent(values, name);
      if (value === undefined || value === null) {
        if (spec.presence === "required") throw new ArgumentError(`missing required argument '${name}'`);
        args[name] = spec.presence === "defaulted" ? spec.fallback : undefined;
        continue;
      }
      args[name] = coerce(value, spec.type, spec.items);
    }
  } catch (error) {
    if (error instanceof ArgumentError) return { ok: false, error: error.message };
    throw error;
  }
  return { ok: true, args: args as ArgsOf<S> };
}
