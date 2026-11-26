import { expect, test } from "bun:test";

import { defineModule } from "./module.ts";

test("defineModule returns the definition it was given", () => {
  const definition = { id: "sample" };
  expect(defineModule(definition)).toBe(definition);
});
