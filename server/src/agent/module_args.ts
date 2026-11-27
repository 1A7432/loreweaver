// A module command's arguments, checked against the `params` its module declared, before
// the module is called — whoever runs the command (a member or the Keeper). A subset of
// JSON Schema, applied recursively: `type` (object, string, number, integer, boolean,
// array, null, or a list of them), `properties`, `required`, `additionalProperties: false`,
// `enum`, `const`, `minimum`/`maximum`, `minLength`/`maxLength` (in code points),
// `minItems`/`maxItems` and `items`. Every other keyword is ignored, as is a keyword that
// does not apply to the value's type. A refusal is the engine's own (`unknown_arg`,
// `missing_arg`, `invalid_arg`) with the argument's path, as for an engine command.
//
// The schema is content: names are read as own properties only, and the work is bounded
// (`MAX_ARGS_DEPTH` levels, `MAX_ARGS_NODES` checks); past either bound the arguments are
// refused as `invalid_arg` at the path reached, never accepted unchecked.
import { charCount } from "loreweaver-protocol/v3";

/** How deep the check follows a schema into the arguments. */
export const MAX_ARGS_DEPTH = 32;
/** How many (schema, value) checks one call's arguments may cost. */
export const MAX_ARGS_NODES = 20_000;

export interface ArgsProblem {
  readonly code: "unknown_arg" | "missing_arg" | "invalid_arg";
  /** Dotted: `target`, `a.skill`, `writes.0.value`; empty for the arguments as a whole. */
  readonly path: string;
}

type Rec = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is Rec {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function get(value: Rec, key: string): unknown {
  return Object.hasOwn(value, key) ? value[key] : undefined;
}

function join(path: string, key: string): string {
  return path === "" ? key : `${path}.${key}`;
}

const TYPES: ReadonlySet<string> = new Set(["object", "string", "number", "integer", "boolean", "array", "null"]);

function hasType(value: unknown, type: string): boolean {
  switch (type) {
    case "object":
      return isRecord(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return false;
  }
}

function equal(a: unknown, b: unknown, depth = 0): boolean {
  if (depth > MAX_ARGS_DEPTH) return false;
  if (a === b) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((item, index) => equal(item, b[index], depth + 1));
  if (isRecord(a)) {
    if (!isRecord(b)) return false;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && equal(a[key], b[key], depth + 1));
  }
  return false;
}

function bound(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

class Check {
  #nodes = 0;

  run(schema: unknown, value: unknown, path: string, depth: number): ArgsProblem | null {
    this.#nodes += 1;
    if (depth > MAX_ARGS_DEPTH || this.#nodes > MAX_ARGS_NODES) return { code: "invalid_arg", path };
    // A schema that is not an object says nothing (`true`, or a malformed part): anything fits.
    if (!isRecord(schema)) return null;
    const invalid: ArgsProblem = { code: "invalid_arg", path };

    const type = get(schema, "type");
    const named = (Array.isArray(type) ? type : [type]).filter((entry): entry is string => typeof entry === "string" && TYPES.has(entry));
    if (named.length > 0 && !named.some((entry) => hasType(value, entry))) return invalid;

    const options = get(schema, "enum");
    if (Array.isArray(options) && !options.some((option) => equal(option, value))) return invalid;
    if (Object.hasOwn(schema, "const") && !equal(get(schema, "const"), value)) return invalid;

    if (typeof value === "number") {
      const minimum = bound(get(schema, "minimum"));
      const maximum = bound(get(schema, "maximum"));
      if ((minimum !== null && value < minimum) || (maximum !== null && value > maximum)) return invalid;
    }
    if (typeof value === "string") {
      const minLength = bound(get(schema, "minLength"));
      const maxLength = bound(get(schema, "maxLength"));
      if (minLength !== null || maxLength !== null) {
        const length = charCount(value);
        if ((minLength !== null && length < minLength) || (maxLength !== null && length > maxLength)) return invalid;
      }
    }
    if (Array.isArray(value)) {
      const minItems = bound(get(schema, "minItems"));
      const maxItems = bound(get(schema, "maxItems"));
      if ((minItems !== null && value.length < minItems) || (maxItems !== null && value.length > maxItems)) return invalid;
      const items = get(schema, "items");
      if (isRecord(items)) {
        for (let index = 0; index < value.length; index++) {
          const problem = this.run(items, value[index], join(path, String(index)), depth + 1);
          if (problem !== null) return problem;
        }
      }
    }
    if (isRecord(value)) return this.#object(schema, value, path, depth);
    return null;
  }

  #object(schema: Rec, value: Rec, path: string, depth: number): ArgsProblem | null {
    const rawProperties = get(schema, "properties");
    const properties: Rec = isRecord(rawProperties) ? rawProperties : {};
    const closed = get(schema, "additionalProperties") === false;
    for (const name of Object.keys(value)) {
      if (Object.hasOwn(properties, name)) {
        const problem = this.run(properties[name], value[name], join(path, name), depth + 1);
        if (problem !== null) return problem;
      } else if (closed) {
        return { code: "unknown_arg", path: join(path, name) };
      }
    }
    const required = get(schema, "required");
    if (Array.isArray(required)) {
      for (const name of required) {
        if (typeof name === "string" && !Object.hasOwn(value, name)) return { code: "missing_arg", path: join(path, name) };
      }
    }
    return null;
  }
}

/** The first problem of `args` against a command's `params`, or null when they fit. */
export function checkModuleArgs(params: unknown, args: unknown): ArgsProblem | null {
  return new Check().run(params, args, "", 0);
}
