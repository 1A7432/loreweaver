import { expect, test } from "bun:test";

import { checkModuleArgs, MAX_ARGS_DEPTH, MAX_ARGS_NODES } from "./args.ts";

const closed = {
  type: "object",
  properties: {
    target: { type: "string", minLength: 2, maxLength: 4 },
    times: { type: "integer", minimum: 1, maximum: 3 },
    mode: { enum: ["fast", "slow"] },
    tags: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 2 },
    a: { type: "object", properties: { skill: { type: "string" } }, required: ["skill"], additionalProperties: false },
  },
  required: ["target"],
  additionalProperties: false,
};

test("arguments that fit are accepted, and so is anything under a schema that says nothing", () => {
  expect(checkModuleArgs(closed, { target: "Bo", times: 2, mode: "fast", tags: ["x"], a: { skill: "axe" } })).toBeNull();
  expect(checkModuleArgs({ type: "object" }, { anything: [1, { goes: null }] })).toBeNull();
  expect(checkModuleArgs(null, { x: 1 })).toBeNull();
  expect(checkModuleArgs(true, { x: 1 })).toBeNull();
});

test("a refusal names the engine's code and the argument's dotted path", () => {
  expect(checkModuleArgs(closed, { target: "Bo", extra: 1 })).toEqual({ code: "unknown_arg", path: "extra" });
  expect(checkModuleArgs(closed, {})).toEqual({ code: "missing_arg", path: "target" });
  expect(checkModuleArgs(closed, { target: "Bo", a: {} })).toEqual({ code: "missing_arg", path: "a.skill" });
  expect(checkModuleArgs(closed, { target: "Bo", a: { skill: "axe", extra: 1 } })).toEqual({ code: "unknown_arg", path: "a.extra" });
  expect(checkModuleArgs(closed, { target: 5 })).toEqual({ code: "invalid_arg", path: "target" });
  expect(checkModuleArgs(closed, { target: "B" })).toEqual({ code: "invalid_arg", path: "target" });
  expect(checkModuleArgs(closed, { target: "Bobby" })).toEqual({ code: "invalid_arg", path: "target" });
  expect(checkModuleArgs(closed, { target: "Bo", times: 0 })).toEqual({ code: "invalid_arg", path: "times" });
  expect(checkModuleArgs(closed, { target: "Bo", times: 1.5 })).toEqual({ code: "invalid_arg", path: "times" });
  expect(checkModuleArgs(closed, { target: "Bo", mode: "medium" })).toEqual({ code: "invalid_arg", path: "mode" });
  expect(checkModuleArgs(closed, { target: "Bo", tags: [] })).toEqual({ code: "invalid_arg", path: "tags" });
  expect(checkModuleArgs(closed, { target: "Bo", tags: ["x", 2] })).toEqual({ code: "invalid_arg", path: "tags.1" });
  expect(checkModuleArgs({ type: "object" }, [])).toEqual({ code: "invalid_arg", path: "" });
});

test("lengths count code points, and an open object keeps its extra arguments", () => {
  expect(checkModuleArgs(closed, { target: "𠮷𠮷𠮷𠮷" })).toBeNull();
  expect(checkModuleArgs(closed, { target: "𠮷𠮷𠮷𠮷𠮷" })).toEqual({ code: "invalid_arg", path: "target" });
  expect(checkModuleArgs(closed, { target: "刀客" })).toBeNull();
  expect(checkModuleArgs({ type: "object", properties: { x: { type: "string" } } }, { x: "a", y: 1 })).toBeNull();
});

test("names are own properties only; a schema keyword that does not apply is ignored", () => {
  // `constructor` is not a declared property of this schema, so a closed object refuses it.
  expect(checkModuleArgs({ type: "object", additionalProperties: false }, JSON.parse('{"constructor": 1}'))).toEqual({ code: "unknown_arg", path: "constructor" });
  expect(checkModuleArgs({ type: "object", required: ["constructor"] }, {})).toEqual({ code: "missing_arg", path: "constructor" });
  expect(checkModuleArgs({ type: "object", properties: { n: { type: "string", minimum: 5, items: { type: "integer" } } } }, { n: "x" })).toBeNull();
});

test("past its bounds the check refuses, never accepts unchecked", () => {
  let deep: unknown = { type: "string" };
  let value: unknown = "x";
  for (let level = 0; level <= MAX_ARGS_DEPTH + 1; level++) {
    deep = { type: "object", properties: { n: deep } };
    value = { n: value };
  }
  const problem = checkModuleArgs(deep, value);
  expect(problem?.code).toBe("invalid_arg");
  expect(problem?.path.split(".").length).toBeGreaterThan(MAX_ARGS_DEPTH);

  const wide = checkModuleArgs({ type: "object", properties: { list: { type: "array", items: { type: "integer" } } } }, { list: Array.from({ length: MAX_ARGS_NODES }, () => 1) });
  expect(wide?.code).toBe("invalid_arg");
  expect(wide?.path.startsWith("list.")).toBe(true);
});
