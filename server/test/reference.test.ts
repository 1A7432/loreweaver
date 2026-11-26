import { expect, test } from "bun:test";

import { readReference } from "./reference.ts";

test("reference files read the same whether stored plain or compressed", () => {
  expect(readReference("dice_normalize").length).toBe(38);
  expect(readReference("dice_vectors").length).toBe(2150);
});
