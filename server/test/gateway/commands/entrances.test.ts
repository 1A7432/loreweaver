// Every command: its text form and its structured form reach the same handler with the
// same typed arguments. Checked twice over — the text parses to exactly the argument
// object given to `command.run`, and two identical rooms (same seeds, same ids) running
// the line and the call end with identical outcomes.
import { describe, expect, test } from "bun:test";

import { jsonFile, plainCard, sha256, upload } from "../card_files.ts";
import { ADA, ADMIN, bench, type Bench, type Member, ok, ROOM } from "./bench.ts";
import { seedChronicle, seedHabits, seedLore, seedNpc, seedRoster, seedVariables } from "./seed.ts";

interface Case {
  readonly line: string;
  readonly id: string;
  readonly args: Record<string, unknown>;
  readonly member?: Member;
  readonly setup?: (bench: Bench) => Promise<void> | void;
  /** The bench keeps files (`uploads`, `import`). */
  readonly media?: boolean;
}

const CARD = jsonFile(plainCard("Mira"));

async function withCard(b: Bench): Promise<void> {
  if (typeof (await upload(b.uploads!, ROOM, ADA, CARD, "application/json")) === "string") throw new Error("card not uploaded");
}

async function withCharacter(b: Bench): Promise<void> {
  const made = await b.input(ADA, ".coc Alice");
  if (made.kind !== "command" || !made.outcome.ok) throw new Error("character not made");
}

const CASES: readonly Case[] = [
  { line: ".r 2#3d6 adv", id: "roll", args: { expr: "3d6", repeat: 2, mode: "adv" } },
  { line: ".rh 1d100", id: "hidden_roll", args: { expr: "1d100" } },
  { line: ".ra b 困难 侦查60", id: "check", args: { skill: "侦查", target: 60, difficulty: "hard", bonus: 1 }, setup: withCharacter },
  { line: ".rav 侦查,聆听", id: "opposed", args: { a: { skill: "侦查" }, b: { skill: "聆听" } }, setup: withCharacter },
  { line: ".ri roll", id: "init", args: { op: "roll" }, setup: withCharacter },
  { line: ".st 力量60 HP-2", id: "sheet", args: { op: "set", writes: [{ name: "力量", op: "=", value: "60" }, { name: "HP", op: "-=", value: "2" }] }, setup: withCharacter },
  { line: ".nn Alicia", id: "rename", args: { name: "Alicia" }, setup: withCharacter },
  { line: ".coc Alice", id: "new_character", args: { system: "coc7", name: "Alice" } },
  { line: ".pc claim Holmes", id: "pc", args: { op: "claim", name: "Holmes" }, setup: seedRoster },
  { line: ".recap", id: "recap", args: {}, setup: seedChronicle },
  { line: ".lore add Town | A quiet place", id: "lore", args: { op: "add", title: "Town", content: "A quiet place" }, member: ADMIN },
  { line: ".var set stats.hp 5", id: "var", args: { op: "set", path: "stats.hp", value: "5" }, member: ADMIN, setup: seedVariables },
  { line: ".npc show Mr Smith", id: "npc", args: { op: "show", name: "Mr Smith" }, member: ADMIN, setup: seedNpc },
  { line: ".chronicle note watch the cellar", id: "chronicle", args: { op: "note", text: "watch the cellar" }, member: ADMIN, setup: seedChronicle },
  { line: ".habits", id: "habits", args: { op: "show" }, member: ADMIN, setup: seedHabits },
  { line: ".rule 2", id: "rule", args: { variant: "rule2" }, member: ADMIN },
  { line: ".bot off", id: "bot", args: { on: false }, member: ADMIN },
  { line: ".language zh", id: "language", args: { locale: "zh" }, member: ADMIN },
  { line: ".undo 1", id: "undo", args: { turns: 1 }, member: ADMIN, setup: withCharacter },
  { line: ".reset chars", id: "reset", args: { scope: "chars" }, member: ADMIN },
  { line: ".save", id: "save", args: { op: "export" }, member: ADMIN, setup: withCharacter },
  { line: ".uploads off", id: "uploads", args: { on: false }, member: ADMIN, media: true },
  { line: `.import character ${sha256(CARD)} Mirabel`, id: "import", args: { file: sha256(CARD), as: "character", name: "Mirabel" }, media: true, setup: withCard },
  { line: ".pack", id: "pack", args: { op: "list" } },
  { line: ".面板", id: "panels", args: { op: "list" } },
  { line: ".skill enable mature-mode", id: "skill", args: { op: "enable", id: "mature-mode" }, member: ADMIN },
  { line: ".jrrp", id: "jrrp", args: {} },
  { line: ".draw", id: "draw", args: {} },
  { line: ".help r", id: "help", args: { id: "r" } },
  { line: ".sc 1/1d6", id: "rules.sanity_check", args: { success: "1", failure: "1d6" }, setup: withCharacter },
  { line: ".en 侦查", id: "rules.skill_growth", args: { skill: "侦查" }, setup: withCharacter },
  { line: ".li", id: "rules.random_madness", args: { table: "long" } },
];

describe("text form and structured form", () => {
  for (const item of CASES) {
    test(`${item.id}: ${item.line}`, async () => {
      const member = item.member ?? ADA;
      const text = bench({ seed: item.id, media: item.media === true });
      const call = bench({ seed: item.id, media: item.media === true });
      await item.setup?.(text);
      await item.setup?.(call);
      expect(text.registry.textCommand(text.context(member, { newTurn: false }), item.line, "en")).toEqual({ id: item.id, args: item.args });
      // Keep the twins in step: the probe above drew a seed from `text` only.
      call.context(member, { newTurn: false });
      const fromText = await text.input(member, item.line);
      const fromCall = await call.run(member, item.id, item.args);
      expect(fromText.kind).toBe("command");
      if (fromText.kind !== "command") return;
      expect(fromText.id).toBe(item.id);
      if (!fromText.outcome.ok) throw new Error(`${item.id} refused: ${fromText.outcome.message}`);
      expect(fromText.outcome).toEqual(ok(fromCall));
    });
  }

  test("the cases cover every command of a CoC room", () => {
    const b = bench();
    const ids = b.registry.specs(b.context(ADA)).map((spec) => spec.id).sort();
    expect([...new Set(CASES.map((item) => item.id))].sort()).toEqual(ids);
  });

  test("a check word in Chinese and in English reach the same command with the same arguments", () => {
    const b = bench();
    const context = b.context(ADA);
    expect(b.registry.textCommand(context, "。ra 侦查", "zh")).toEqual({ id: "check", args: { skill: "侦查" } });
    expect(b.registry.textCommand(context, "/check 侦查", "en")).toEqual({ id: "check", args: { skill: "侦查" } });
    expect(b.registry.textCommand(context, ".rd 1d6", "en")).toEqual({ id: "roll", args: { expr: "1d6" } });
    expect(b.registry.textCommand(context, ".R 1d6", "zh")).toEqual({ id: "roll", args: { expr: "1d6" } });
    expect(b.registry.textCommand(context, ".重置 all", "en")).toEqual({ id: "reset", args: { scope: "all" } });
  });
});
