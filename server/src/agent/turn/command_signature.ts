// A module command's arguments as one short bracket in the Keeper's command list —
// `(target: string, times?: integer 1..5)` — so a command with few, plain arguments needs no
// `lookup_command` before it is run. Only a schema this file can say whole gets one: an
// object of at most `MAX_SIGNATURE_PARAMS` properties, each a string, number, integer or
// boolean, with nothing but an enum, bounds, a length, a default and prose about it. Any
// other schema has no bracket, and the Keeper looks it up as before — a bracket is never a
// shortened schema.
//
// The schema is content: names are read as own properties only, counted in code points.
import { charCount } from "loreweaver/runner";

/** The most properties a command may have and still be written out. */
export const MAX_SIGNATURE_PARAMS = 4;
/** The longest bracket, in code points; a longer one is not written. */
export const MAX_SIGNATURE_CHARS = 160;
/** The most values of an enum written out, and the longest of them in code points. */
export const MAX_SIGNATURE_ENUM = 8;
export const MAX_SIGNATURE_ENUM_CHARS = 24;

type Rec = Readonly<Record<string, unknown>>;

const NAME = /^[\p{L}\p{N}_]{1,32}$/u;
const SCALARS: ReadonlySet<string> = new Set(["string", "number", "integer", "boolean"]);
/** What the schema itself may say besides its properties. */
const TOP: ReadonlySet<string> = new Set(["type", "properties", "required", "additionalProperties", "title", "description"]);
/** What a property may say and still be written whole: these change no shape the bracket shows wrongly. */
const PLAIN: ReadonlySet<string> = new Set(["type", "enum", "minimum", "maximum", "minLength", "maxLength", "default", "title", "description"]);

function isRecord(value: unknown): value is Rec {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function get(value: Rec, key: string): unknown {
  return Object.hasOwn(value, key) ? value[key] : undefined;
}

function enumText(values: unknown): string | null {
  if (!Array.isArray(values) || values.length === 0 || values.length > MAX_SIGNATURE_ENUM) return null;
  const parts: string[] = [];
  for (const value of values as unknown[]) {
    if (typeof value === "string" ? charCount(value) > MAX_SIGNATURE_ENUM_CHARS : typeof value !== "boolean" && !(typeof value === "number" && Number.isFinite(value))) return null;
    parts.push(JSON.stringify(value));
  }
  return parts.join("|");
}

function propertyText(schema: unknown): string | null {
  if (!isRecord(schema)) return null;
  for (const key of Object.keys(schema)) if (!PLAIN.has(key)) return null;
  const type = get(schema, "type");
  if (typeof type !== "string" || !SCALARS.has(type)) return null;
  const choices = get(schema, "enum");
  if (choices !== undefined) return enumText(choices);
  const [min, max] = [get(schema, "minimum"), get(schema, "maximum")];
  const bounded = (type === "integer" || type === "number") && typeof min === "number" && typeof max === "number" && Number.isFinite(min) && Number.isFinite(max);
  return bounded ? `${type} ${min}..${max}` : type;
}

/** The bracket for a command's `params`, or null when the schema is not one this can say whole. */
export function commandSignature(params: unknown): string | null {
  if (!isRecord(params)) return null;
  for (const key of Object.keys(params)) if (!TOP.has(key)) return null;
  const type = get(params, "type");
  if (type !== undefined && type !== "object") return null;
  // Arguments beyond the listed ones, of a shape of their own, are more than a bracket says.
  const others = get(params, "additionalProperties");
  if (others !== undefined && typeof others !== "boolean") return null;
  const properties = get(params, "properties");
  if (properties !== undefined && !isRecord(properties)) return null;
  const names = properties === undefined ? [] : Object.keys(properties);
  if (names.length > MAX_SIGNATURE_PARAMS) return null;
  const required = get(params, "required");
  if (required !== undefined && !Array.isArray(required)) return null;
  const needed = new Set<unknown>(required === undefined ? [] : (required as unknown[]));
  const parts: string[] = [];
  for (const name of names) {
    const text = NAME.test(name) ? propertyText(get(properties as Rec, name)) : null;
    if (text === null) return null;
    parts.push(`${name}${needed.has(name) ? "" : "?"}: ${text}`);
    needed.delete(name);
  }
  // A required name the schema does not describe: nothing here could say what it is.
  if (needed.size > 0) return null;
  const signature = `(${parts.join(", ")})`;
  return charCount(signature) <= MAX_SIGNATURE_CHARS ? signature : null;
}
