// A small JSON Schema checker for the subset the built-in view schemas use (`views.ts`):
// `type` (one or a list), `properties` + `required`, `items`, `anyOf`, `enum`, `const`.
// `additionalProperties` is deliberately NOT enforced on the client: a newer server may add
// fields in a minor version, and unknown fields are ignored (§8.1).
import type { ViewSchema } from "./views.js";

/** Nesting a value may have before it is refused: a schema this deep is never written. */
export const MAX_SCHEMA_DEPTH = 32;

function typeMatches(value: unknown, type: string): boolean {
  switch (type) {
    case "null":
      return value === null;
    case "boolean":
      return typeof value === "boolean";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return Number.isSafeInteger(value);
    case "string":
      return typeof value === "string";
    case "array":
      return Array.isArray(value);
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    default:
      return false;
  }
}

function check(value: unknown, schema: ViewSchema, depth: number): boolean {
  if (depth > MAX_SCHEMA_DEPTH) return false;
  if ("const" in schema && value !== schema.const) return false;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false;
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((option) => check(value, option as ViewSchema, depth + 1))) return false;
  const type = schema.type;
  if (typeof type === "string" && !typeMatches(value, type)) return false;
  if (Array.isArray(type) && !type.some((option) => typeof option === "string" && typeMatches(value, option))) return false;
  if (Array.isArray(value) && typeof schema.items === "object" && schema.items !== null) {
    const items = schema.items as ViewSchema;
    if (!value.every((item) => check(item, items, depth + 1))) return false;
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (Array.isArray(schema.required) && !schema.required.every((name) => typeof name === "string" && Object.hasOwn(record, name))) return false;
    const properties = schema.properties;
    if (typeof properties === "object" && properties !== null) {
      for (const [name, sub] of Object.entries(properties as Record<string, ViewSchema>)) {
        if (Object.hasOwn(record, name) && !check(record[name], sub, depth + 1)) return false;
      }
    }
  }
  return true;
}

/** Whether `value` fits `schema` (the subset above; extra fields are allowed). */
export function matchesSchema(value: unknown, schema: ViewSchema): boolean {
  return check(value, schema, 0);
}
