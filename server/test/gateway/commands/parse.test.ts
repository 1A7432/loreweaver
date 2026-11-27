// Reading a typed line: the prefixes, exact tokens, aliases in both languages, the argument
// cap, speech versus command, and inline rolls.
import { describe, expect, test } from "bun:test";

import { parseAssignments, parseCheckText, splitCommand } from "../../../src/gateway/commands/index.ts";
import { builtInPacks } from "../../../src/core/rulepacks/index.ts";
import { ADA, bench, code, ok } from "./bench.ts";

const coc = builtInPacks().find((pack) => pack.id === "coc7") ?? null;

describe("splitting a line", () => {
  test("the three prefixes are equivalent and whitespace may follow one", () => {
    for (const line of [".r 1d6", "。r 1d6", "/r 1d6", ". r 1d6", "  /r   1d6  "]) {
      expect(splitCommand(line)).toEqual({ word: "r", rest: "1d6" });
    }
  });

  test("no prefix, or nothing after one, is not a command", () => {
    expect(splitCommand("r 1d6")).toBeNull();
    expect(splitCommand(".")).toBeNull();
    expect(splitCommand("。  ")).toBeNull();
  });

  test("the word is case-folded and taken whole", () => {
    expect(splitCommand(".RA 侦查")).toEqual({ word: "ra", rest: "侦查" });
    expect(splitCommand(".r3d6")).toEqual({ word: "r3d6", rest: "" });
  });
});

describe("command or speech", () => {
  test("an unknown token is speech, said as written", async () => {
    const b = bench();
    for (const line of [".r3d6", ".nonsense here", "...", "just talking"]) {
      const result = await b.input(ADA, line);
      expect(result).toEqual({ kind: "speech", text: line, rolls: [], failures: [] });
    }
  });

  test("aliases resolve in both languages whatever the caller's language", async () => {
    const b = bench();
    for (const [line, locale] of [
      [".r 1d6", "en"],
      [".rd 1d6", "en"],
      [".roll 1d6", "zh"],
      ["。r 1d6", "zh"],
    ] as const) {
      const result = await b.input(ADA, line, locale);
      expect(result.kind === "command" ? result.id : null).toBe("roll");
    }
    const chinese = await b.input(ADA, ".前情", "en");
    expect(chinese.kind === "command" ? chinese.id : null).toBe("recap");
  });

  test("a word another rule system declares is refused in this room, not said aloud", async () => {
    const b = bench({ system: "dnd5e" });
    const result = await b.input(ADA, ".sc 1/1d6");
    expect(result.kind).toBe("command");
    if (result.kind === "command") expect(code(result.outcome)).toBe("not_in_system");
  });

  test("an argument string over 4000 code points is refused; one at the cap is read", async () => {
    const b = bench();
    const over = await b.input(ADA, `.r ${"测".repeat(4001)}`);
    expect(over.kind === "command" && !over.outcome.ok ? over.outcome.code : null).toBe("too_long");
    // 4000 CJK characters are 4000 code points: under the cap, so the dice engine sees them.
    const at = await b.input(ADA, `.r ${"测".repeat(4000)}`);
    expect(at.kind === "command" && !at.outcome.ok ? at.outcome.code : null).toBe("invalid_arg");
  });
});

describe("inline rolls", () => {
  test("[[expr]] in speech rolls each expression as a public dice event", async () => {
    const b = bench();
    const result = await b.input(ADA, "I swing [[1d6+1]] and dodge [[d%]]");
    if (result.kind !== "speech") throw new Error("expected speech");
    expect(result.rolls.map((roll) => (roll.kind === "dice" ? roll.data.expr : ""))).toEqual(["1d6 + 1", "d100"]);
    expect(result.failures).toEqual([]);
    for (const roll of result.rolls) if (roll.kind === "dice") expect(roll.data.detail).toMatchObject({ inline: true });
  });

  test("a bad inline expression is reported to the speaker, the rest still rolls", async () => {
    const b = bench();
    const result = await b.input(ADA, "[[侦查]] and [[2d4]]");
    if (result.kind !== "speech") throw new Error("expected speech");
    expect(result.rolls).toHaveLength(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("侦查");
  });

  test("too many inline rolls roll none, and say so", async () => {
    const b = bench();
    const result = await b.input(ADA, "[[1d4]] ".repeat(9));
    if (result.kind !== "speech") throw new Error("expected speech");
    expect(result.rolls).toEqual([]);
    expect(result.failures).toHaveLength(1);
  });
});

describe("argument parsers", () => {
  test("check text: counts, difficulty words, a glued target, a lone number", () => {
    expect(parseCheckText("b2 困难 侦查60", coc)).toEqual({ bonus: 2, difficulty: "hard", skill: "侦查", target: 60 });
    expect(parseCheckText("p侦查", coc)).toEqual({ penalty: 1, skill: "侦查" });
    expect(parseCheckText("hard spot hidden 45 adv", coc)).toEqual({ difficulty: "hard", bonus: 1, skill: "spot hidden", target: 45 });
    expect(parseCheckText("55", coc)).toEqual({ target: 55 });
  });

  test("sheet assignments: explicit and dice-bot forms, never mixed", () => {
    expect(parseAssignments("STR=16 mod=-3 HP+=1d6")).toEqual([
      { name: "STR", op: "=", value: "16" },
      { name: "mod", op: "=", value: "-3" },
      { name: "HP", op: "+=", value: "1d6" },
    ]);
    expect(parseAssignments("力量50，敏捷60 HP-4")).toEqual([
      { name: "力量", op: "=", value: "50" },
      { name: "敏捷", op: "=", value: "60" },
      { name: "HP", op: "-=", value: "4" },
    ]);
    expect(parseAssignments("STR=16 DEX14")).toBeNull();
    expect(parseAssignments("x==5")).toBeNull();
  });

  test("a garbled argument string is refused with the command's usage", async () => {
    const b = bench();
    const outcome = await b.input(ADA, ".pc juggle");
    if (outcome.kind !== "command" || outcome.outcome.ok) throw new Error("expected a refusal");
    expect(outcome.outcome.code).toBe("usage");
    expect(outcome.outcome.message).toContain(".pc");
  });

  test("a roll may say what it is for: the words after the notation, as the dice-bot habit has it", async () => {
    const b = bench();
    const typed = async (line: string) => {
      const result = await b.input(ADA, line);
      if (result.kind !== "command") throw new Error(`not a command: ${line}`);
      return result.outcome;
    };
    const dice = (outcome: Awaited<ReturnType<typeof typed>>) => {
      const event = ok(outcome).events[0];
      if (event?.kind !== "dice") throw new Error("expected a dice event");
      return event.data;
    };
    // The reason is the event's label and leads its line; the roll alone stays in `detail.text`.
    const door = dice(await typed(".r 1d8+2 砍门"));
    expect([door.expr, door.label]).toEqual(["1d8 + 2", "砍门"]);
    expect(door.text).toBe(`砍门: ${(door.detail as { text: string }).text}`);
    // Notation written with spaces is still the notation; the reason is what follows it.
    const spaced = dice(await typed(".r 2d6 + 1 kick the door in"));
    expect([spaced.expr, spaced.label]).toEqual(["2d6 + 1", "kick the door in"]);
    // A favour word may sit between the two, and N# still repeats.
    const favoured = ok(await typed(".r 2#1d20 adv to hit"));
    expect(favoured.events).toHaveLength(2);
    expect(favoured.events.map((event) => (event.kind === "dice" ? [event.data.label, (event.data.detail as { mode?: string }).mode] : null))).toEqual([["to hit", "adv"], ["to hit", "adv"]]);
    // No reason, no label: a bare roll is as it was.
    const bare = dice(await typed(".r 3d6"));
    expect(bare.label).toBeUndefined();
    expect(bare.text).toBe((bare.detail as { text: string }).text);
    // A mistyped expression is refused, never rolled as the default die with the typo for a reason.
    expect(code(await typed(".r 2dd6 砍门"))).toBe("bad_dice");
    expect(code(await typed(".r 砍门"))).toBe("bad_dice");
    // The structured call takes the same argument, capped.
    expect(dice(await b.run(ADA, "roll", { expr: "1d4", reason: "sneak attack" })).label).toBe("sneak attack");
    expect(code(await b.run(ADA, "roll", { expr: "1d4", reason: "x".repeat(101) }))).toBe("invalid_arg");
  });

  test("dice help keeps the engine's notation: comparisons count dice, d% is a d100", async () => {
    const b = bench();
    const pool = ok(await b.run(ADA, "roll", { expr: "5d10>=7" }));
    const event = pool.events[0];
    expect(event?.kind === "dice" ? event.data.total : -1).toBeLessThanOrEqual(5);
    const percent = ok(await b.run(ADA, "roll", { expr: "d%" }));
    expect(percent.events[0]?.kind === "dice" ? percent.events[0].data.expr : "").toBe("d100");
  });
});
