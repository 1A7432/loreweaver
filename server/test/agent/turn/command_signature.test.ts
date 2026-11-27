// The bracket a module command gets in the Keeper's command list: written only for a schema
// it says whole, and never a shortened one.
import { expect, test } from "bun:test";

import { commandSignature, MAX_SIGNATURE_CHARS, MAX_SIGNATURE_ENUM, MAX_SIGNATURE_PARAMS } from "../../../src/agent/turn/command_signature.ts";
import { commandLine } from "../../../src/agent/turn/reader.ts";

const object = (properties: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ type: "object", properties, ...extra });

test("few plain arguments are written out: required and optional, bounds, an enum", () => {
  expect(commandSignature({ type: "object" })).toBe("()");
  expect(commandSignature(object({}, { additionalProperties: false }))).toBe("()");
  expect(commandSignature(object({ target: { type: "string", description: "who" }, times: { type: "integer", minimum: 1, maximum: 5 } }, { required: ["target"] }))).toBe(
    "(target: string, times?: integer 1..5)",
  );
  expect(commandSignature(object({ 招式: { type: "string", enum: ["攻", "守"] }, quiet: { type: "boolean", default: false }, weight: { type: "number", minimum: 0 } }, { required: ["招式"] }))).toBe(
    '(招式: "攻"|"守", quiet?: boolean, weight?: number)',
  );
  expect(commandSignature(object({ level: { type: "integer", enum: [1, 2, 3] } }))).toBe("(level?: 1|2|3)");
});

test("a schema the bracket could not say whole gets none", () => {
  const plain = { type: "string" };
  // Too many arguments.
  expect(commandSignature(object(Object.fromEntries(Array.from({ length: MAX_SIGNATURE_PARAMS + 1 }, (_, i) => [`a${i}`, plain]))))).toBeNull();
  expect(commandSignature(object(Object.fromEntries(Array.from({ length: MAX_SIGNATURE_PARAMS }, (_, i) => [`a${i}`, plain]))))).not.toBeNull();
  // An argument that is not a single plain value, or says more than the bracket shows.
  for (const property of [{ type: "array", items: plain }, { type: "object" }, { type: ["string", "null"] }, { type: "string", pattern: "^a" }, { type: "string", const: "x" }, {}, "string", { oneOf: [plain] }]) {
    expect(commandSignature(object({ a: property }))).toBeNull();
  }
  // An enum too long, of a long value, or of something that is not a plain value.
  expect(commandSignature(object({ a: { type: "string", enum: Array.from({ length: MAX_SIGNATURE_ENUM + 1 }, (_, i) => `v${i}`) } }))).toBeNull();
  expect(commandSignature(object({ a: { type: "string", enum: ["x".repeat(25)] } }))).toBeNull();
  expect(commandSignature(object({ a: { type: "string", enum: [["x"]] } }))).toBeNull();
  expect(commandSignature(object({ a: { type: "string", enum: [] } }))).toBeNull();
  // A name that is not one word; a required name the schema does not describe; more than properties at the top.
  expect(commandSignature(object({ "a b": plain }))).toBeNull();
  expect(commandSignature(object({ a: plain }, { required: ["b"] }))).toBeNull();
  expect(commandSignature(object({ a: plain }, { oneOf: [{ required: ["a"] }] }))).toBeNull();
  expect(commandSignature(object({ a: plain }, { additionalProperties: { type: "number" } }))).toBeNull();
  expect(commandSignature({ type: "array" })).toBeNull();
  expect(commandSignature(null)).toBeNull();
  // Longer than a line should be: none, never a cut one.
  const long = object(Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`${"n".repeat(31)}${i}`, { type: "string", enum: Array.from({ length: 8 }, (_, j) => `value_${i}_${j}`) }])));
  expect(commandSignature(long)).toBeNull();
  expect(MAX_SIGNATURE_CHARS).toBe(160);
});

test("a name the object would treat specially is read as the property it is", () => {
  const params = JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"},"constructor":{"type":"boolean"}},"required":["__proto__"]}') as unknown;
  expect(commandSignature(params)).toBe("(__proto__: string, constructor?: boolean)");
});

test("the command's line carries the bracket beside the first line of its description", () => {
  expect(commandLine("camp/rest", "\nRest until dawn.\nLong text.", object({ hours: { type: "integer" } }))).toEqual({ id: "camp/rest", summary: "Rest until dawn.", signature: "(hours?: integer)" });
  expect(commandLine("camp/plan", "", object({ steps: { type: "array" } }))).toEqual({ id: "camp/plan", summary: "", signature: null });
});
