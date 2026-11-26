// A stat a pack derives, and the label it displays a stat under, are names of that stat.
// Found live: a CoC Keeper asked for a Dodge check and was told the skill does not exist —
// the pack derives Dodge from DEX and shows it as "Dodge", and listed neither as an alias.
import { expect, test } from "bun:test";

import { builtInPacks } from "../../../src/core/rulepacks/index.ts";
import { checkValue, hasCheckValue, newSheet, resolveName, setSheetValue } from "../../../src/core/sheets/index.ts";

const coc7 = builtInPacks().find((pack) => pack.id === "coc7");
if (coc7 === undefined) throw new Error("coc7 is a built-in pack");
const spec = coc7.sheet;

test("a derived stat resolves by its own name and by its display label, in any case", () => {
  const canonical = resolveName(spec, "闪避");
  expect(canonical).not.toBeNull();
  for (const typed of ["Dodge", "dodge", " DODGE "]) expect([typed, resolveName(spec, typed)]).toEqual([typed, canonical]);
  // An alias row still wins, and a name nobody declares is still nobody's.
  expect(resolveName(spec, "Spot Hidden")).toBe(resolveName(spec, "侦查"));
  expect(resolveName(spec, "Underwater Basket Weaving")).toBeNull();
});

test("a check on Dodge rolls against half of DEX", () => {
  const { sheet } = newSheet(spec, "Ada", "coc7");
  const dex = resolveName(spec, "DEX") ?? "DEX";
  const set = setSheetValue(spec, sheet, dex, 61);
  if (!set.ok) throw new Error(`could not set DEX: ${set.code}`);
  const dodge = resolveName(spec, "Dodge") ?? "";
  expect(hasCheckValue(spec, set.sheet, "Dodge")).toBe(true);
  expect(checkValue(spec, set.sheet, dodge)).toMatchObject({ kind: "value", value: 30, from: "derived" });
});
