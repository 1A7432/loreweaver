// What a command's events become in the Keeper's record of what players did.
import { expect, test } from "bun:test";

import { tableText } from "../../src/gateway/room.ts";

test("a roll is recorded with what it was for, what it was against and how it came out", () => {
  expect(
    tableText([
      { kind: "dice", data: { actor: "Ada", kind: "check", expr: "1d100", rolls: [19], total: 19, target: 25, label: "Spot Hidden", outcome: { id: "regular", label: "Success", success: true, critical: false, fumble: false, tier: 2 } } },
    ]),
  ).toBe("Ada: Spot Hidden 1d100 = 19 vs 25 (Success)");
  // A line that states the roll completely is used as it is: a contest's winner, a loss.
  expect(tableText([{ kind: "dice", data: { actor: "Ada", kind: "opposed", expr: "1d100", rolls: [28, 53], total: 28, label: "Fighting (Brawl)", text: "Fighting (Brawl) 28 (Failure) vs Dodge 53 (Failure): Dodge wins (higher value)" } }])).toBe(
    "Ada: Fighting (Brawl) 28 (Failure) vs Dodge 53 (Failure): Dodge wins (higher value)",
  );
  // A bare roll, and one with nothing but numbers.
  expect(tableText([{ kind: "dice", data: { actor: "Ada", kind: "roll", expr: "2d6", rolls: [5, 5], total: 10, text: "2d6 (5, 5) = 10" } }])).toBe("Ada: 2d6 (5, 5) = 10");
  expect(tableText([{ kind: "dice", data: { actor: "Ada", kind: "roll", expr: "1d6", rolls: [3], total: 3 } }])).toBe("Ada: 1d6 = 3");
  // The effective target is what the roll was really against.
  expect(tableText([{ kind: "dice", data: { actor: "Ada", kind: "check", expr: "1d100", rolls: [40], total: 40, target: 50, effectiveTarget: 25, label: "Stealth" } }])).toBe("Ada: Stealth 1d100 = 40 vs 25");
});

test("narrative and media lines pass through", () => {
  expect(tableText([{ kind: "narrative", data: { speaker: "system", text: "An hour passes.", format: "plain" } }, { kind: "media", data: { hash: "a".repeat(64), mime: "image/png", size: 1, name: "map.png", from: "Ada" } }])).toBe("An hour passes.\nmap.png");
});
