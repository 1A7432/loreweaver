import { expect, test } from "bun:test";

import { defineModule, type ClockReading, type Json } from "./module.ts";

test("defineModule returns the definition it was given", () => {
  const definition = { id: "sample" };
  expect(defineModule(definition)).toBe(definition);
});

test("a clock reading can be returned inside a view's data as it is", () => {
  const reading: ClockReading = { time: "Day 3, dusk", round: 2 };
  // The assignment is the test: it must type-check without copying the fields out.
  const data: Json = { clock: reading };
  expect(data).toEqual({ clock: { time: "Day 3, dusk", round: 2 } });
});
