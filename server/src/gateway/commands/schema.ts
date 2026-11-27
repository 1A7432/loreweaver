// The parameter schemas of commands: a small subset of JSON Schema, written as plain
// objects so the `commands` view can hand them to a client as they are, and checked here
// strictly — an argument the schema does not name is refused, an integer must be a whole
// number and a number a JSON number (never the text "5"), every text is capped in code points.
import { charCount } from "loreweaver-protocol/v3";

/** The longest text any argument may carry, unless its schema sets a lower cap. */
export const MAX_ARG_CHARS = 4000;
/** The most items any list argument may carry, unless its schema sets a lower cap. */
export const MAX_ARG_ITEMS = 64;
/** How deep an argument object may nest. */
const MAX_DEPTH = 8;

export interface StringSchema {
  readonly type: "string" | readonly ["string", "null"];
  readonly enum?: readonly string[];
  readonly minLength?: number;
  readonly maxLength?: number;
}

export interface IntegerSchema {
  readonly type: "integer";
  readonly minimum?: number;
  readonly maximum?: number;
}

/** A JSON number (a fraction allowed, never the text "0.5"); finite. */
export interface NumberSchema {
  readonly type: "number";
  readonly minimum?: number;
  readonly maximum?: number;
}

export interface BooleanSchema {
  readonly type: "boolean";
}

export interface ArraySchema {
  readonly type: "array";
  readonly items: Schema;
  readonly maxItems?: number;
}

export interface ObjectSchema {
  readonly type: "object";
  readonly properties: Readonly<Record<string, Schema>>;
  readonly required?: readonly string[];
  /** `false`: no other names. A schema: every other name's value. `true`: any JSON object (checked by its consumer). */
  readonly additionalProperties: false | true | Schema;
  readonly maxProperties?: number;
}

export type Schema = StringSchema | IntegerSchema | NumberSchema | BooleanSchema | ArraySchema | ObjectSchema;

export const NO_PARAMS: ObjectSchema = { type: "object", properties: {}, additionalProperties: false };

export function object(properties: Readonly<Record<string, Schema>>, required: readonly string[] = []): ObjectSchema {
  return required.length === 0 ? { type: "object", properties, additionalProperties: false } : { type: "object", properties, required, additionalProperties: false };
}

export function text(maxLength = MAX_ARG_CHARS, minLength = 0): StringSchema {
  return minLength === 0 ? { type: "string", maxLength } : { type: "string", minLength, maxLength };
}

export function oneOf(values: readonly string[]): StringSchema {
  return { type: "string", enum: values };
}

export function integer(minimum?: number, maximum?: number): IntegerSchema {
  const schema: { type: "integer"; minimum?: number; maximum?: number } = { type: "integer" };
  if (minimum !== undefined) schema.minimum = minimum;
  if (maximum !== undefined) schema.maximum = maximum;
  return schema;
}

export function number(minimum?: number, maximum?: number): NumberSchema {
  const schema: { type: "number"; minimum?: number; maximum?: number } = { type: "number" };
  if (minimum !== undefined) schema.minimum = minimum;
  if (maximum !== undefined) schema.maximum = maximum;
  return schema;
}

export const BOOLEAN: BooleanSchema = { type: "boolean" };

/** Why a value did not fit: a stable code and the argument path. */
export interface SchemaProblem {
  readonly code: "unknown_arg" | "missing_arg" | "invalid_arg";
  readonly path: string;
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function join(path: string, name: string): string {
  return path === "" ? name : `${path}.${name}`;
}

function check(schema: Schema, value: unknown, path: string, depth: number): SchemaProblem | null {
  if (depth > MAX_DEPTH) return { code: "invalid_arg", path };
  switch (schema.type) {
    case "integer": {
      if (typeof value !== "number" || !Number.isSafeInteger(value)) return { code: "invalid_arg", path };
      if (schema.minimum !== undefined && value < schema.minimum) return { code: "invalid_arg", path };
      if (schema.maximum !== undefined && value > schema.maximum) return { code: "invalid_arg", path };
      return null;
    }
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) return { code: "invalid_arg", path };
      if (schema.minimum !== undefined && value < schema.minimum) return { code: "invalid_arg", path };
      if (schema.maximum !== undefined && value > schema.maximum) return { code: "invalid_arg", path };
      return null;
    }
    case "boolean":
      return typeof value === "boolean" ? null : { code: "invalid_arg", path };
    case "array": {
      if (!Array.isArray(value) || value.length > (schema.maxItems ?? MAX_ARG_ITEMS)) return { code: "invalid_arg", path };
      for (let index = 0; index < value.length; index++) {
        const problem = check(schema.items, value[index], join(path, String(index)), depth + 1);
        if (problem !== null) return problem;
      }
      return null;
    }
    case "object":
      return checkObject(schema, value, path, depth);
    default: {
      // A string schema, possibly nullable.
      if (value === null && Array.isArray(schema.type)) return null;
      if (typeof value !== "string") return { code: "invalid_arg", path };
      const length = charCount(value);
      if (length > (schema.maxLength ?? MAX_ARG_CHARS) || length < (schema.minLength ?? 0)) return { code: "invalid_arg", path };
      if (schema.enum !== undefined && !schema.enum.includes(value)) return { code: "invalid_arg", path };
      return null;
    }
  }
}

function checkObject(schema: ObjectSchema, value: unknown, path: string, depth: number): SchemaProblem | null {
  if (!isPlainObject(value)) return { code: "invalid_arg", path };
  const names = Object.keys(value);
  if (names.length > (schema.maxProperties ?? MAX_ARG_ITEMS)) return { code: "invalid_arg", path };
  if (schema.additionalProperties === true) return null;
  for (const name of names) {
    const property = Object.hasOwn(schema.properties, name) ? schema.properties[name] : undefined;
    const member = value[name];
    if (property !== undefined) {
      // An argument given as `undefined` is an argument not given.
      if (member === undefined) continue;
      const problem = check(property, member, join(path, name), depth + 1);
      if (problem !== null) return problem;
      continue;
    }
    if (schema.additionalProperties === false) return { code: "unknown_arg", path: join(path, name) };
    const problem = check(schema.additionalProperties, member, join(path, name), depth + 1);
    if (problem !== null) return problem;
  }
  for (const name of schema.required ?? []) {
    if (value[name] === undefined) return { code: "missing_arg", path: join(path, name) };
  }
  return null;
}

/** The first problem with `value` against `schema`, or null when it fits. */
export function validateArgs(schema: ObjectSchema, value: unknown): SchemaProblem | null {
  return checkObject(schema, value, "", 0);
}

/**
 * An argument object without the names whose value is `undefined`: a text parser builds
 * its object with optional fields, and what it did not set must not look given.
 */
export function compact(args: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(args)) {
    // `defineProperty`, not assignment: a name from content may be `__proto__`.
    if (value !== undefined) Object.defineProperty(out, name, { value, enumerable: true, writable: true, configurable: true });
  }
  return out;
}
