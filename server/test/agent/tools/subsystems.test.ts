import { describe, expect, test } from "bun:test";

import { TurnLedger } from "../../../src/agent/tools/index.ts";
import { CHARACTER_TYPE } from "../../../src/core/characters/index.ts";
import { NOBODY, bench, stored } from "./bench.ts";

function attribute(room: ReturnType<typeof bench>, key: string): number | undefined {
  const sheet = stored(room, CHARACTER_TYPE, "ada")?.sheet as { attributes?: [string, number][] } | undefined;
  return sheet?.attributes?.find(([name]) => name === key)?.[1];
}

describe("the coc7 subsystem tools", () => {
  test("sanity_check rolls, grades, deducts the failure loss and shows the table", async () => {
    const room = bench();
    room.addCharacter("ada", "Ada");
    room.random.push(80, 4);
    const outcome = await room.call(room.catalog(), "sanity_check", { success_loss: "0", failure_loss: "1d6" }, { context: room.context({ locale: "zh" }) });
    expect(outcome.status).toBe("ok");
    expect(outcome.text).toContain("Current Sanity: 60  Rolled: 80");
    expect(outcome.text).toContain("Lost: 4 (roll: 1d6 = 4)");
    expect(outcome.text).toContain("Remaining Sanity: 56/99");
    expect(attribute(room, "SAN")).toBe(56);
    const event = outcome.events[0];
    if (event?.kind !== "dice") throw new Error("expected a dice event");
    expect([event.data.kind, event.data.subsystem, event.data.subsystemLabel, event.data.expr]).toEqual(["subsystem", "sanity_check", "理智", "理智"]);
    expect(event.data.outcome?.success).toBe(false);
    expect(outcome.bookkeeping.dice).toBe(true);
  });

  test("a failure that costs nothing says so; bad loss notation is refused before rolling", async () => {
    const room = bench();
    room.addCharacter("ada", "Ada");
    room.random.push(90, 0);
    const free = await room.call(room.catalog(), "sanity_check", { success_loss: "0", failure_loss: "0" });
    expect(free.text).toContain("the declared failure cost was 0");
    const bad = await room.call(room.catalog(), "sanity_check", { success_loss: "0", failure_loss: "lots" });
    expect([bad.code, bad.events]).toEqual(["bad_loss", []]);
    expect((await room.call(room.catalog(), "sanity_check", { success_loss: "0", failure_loss: "1" }, { context: room.context({ who: NOBODY }) })).code).toBe("no_character");
  });

  test("skill_growth grows a skill when the roll beats it", async () => {
    const room = bench();
    room.addCharacter("ada", "Ada");
    room.random.push(75, 6);
    const grown = await room.call(room.catalog(), "skill_growth", { skill_name: "Spot Hidden" });
    expect(grown.text).toContain("Spot Hidden: 60 → 66 (+6)");
    room.random.push(10);
    expect((await room.call(room.catalog(), "skill_growth", { skill_name: "侦查" })).text).toContain("no growth");
    expect((await room.call(room.catalog(), "skill_growth", { skill_name: "Underwater Basket Weaving" })).code).toBe("unknown_skill");
  });

  test("spend_luck lowers the turn's last check, re-graded, and pays from Luck", async () => {
    const room = bench();
    room.addCharacter("ada", "Ada");
    const ledger = new TurnLedger();
    room.random.push(65);
    const check = await room.call(room.catalog(), "skill_check", { skill_name: "侦查" }, { ledger });
    expect(check.text).toContain("Failure");
    const spent = await room.call(room.catalog(), "spend_luck", { points: 6 }, { ledger });
    expect(spent.status).toBe("ok");
    expect(spent.text).toContain("Ada spent 6 Luck on 侦查: 65 → 59");
    expect(attribute(room, "LUC")).toBe(44);
    expect(ledger.checks.get("ada")).toMatchObject({ roll: 59, rawRoll: 65, spent: 6 });
    expect((await room.call(room.catalog(), "spend_luck", { points: 100 }, { ledger })).code).toBe("insufficient");
    expect((await room.call(room.catalog(), "spend_luck", { points: 0 }, { ledger })).code).toBe("invalid_points");
  });

  test("a later turn finds the check in the room's log", async () => {
    const room = bench();
    room.addCharacter("ada", "Ada");
    room.random.push(65);
    const writer = room.writer();
    const check = await room.call(room.catalog(), "skill_check", { skill_name: "侦查" }, { context: room.context({ writer }) });
    const event = check.events[0];
    if (event?.kind !== "dice") throw new Error("expected a dice event");
    writer.appendEvent({ id: "e-1", ts: 1, kind: "dice", turn: writer.turn, data: event.data });
    const next = room.context({ writer: room.writer() });
    const spent = await room.call(room.catalog(), "spend_luck", { points: 5 }, { context: next, ledger: new TurnLedger() });
    expect(spent.text).toContain("65 → 60");
    const empty = bench();
    empty.addCharacter("ada", "Ada");
    expect((await empty.call(empty.catalog(), "spend_luck", { points: 1 })).code).toBe("no_check");
  });

  test("opposed_check rolls both sides; the passive side's value is stated", async () => {
    const room = bench();
    room.addCharacter("ada", "Ada");
    room.random.push(20, 90);
    const contest = await room.call(room.catalog(), "opposed_check", { skill1: "侦查", skill2: "潜行", skill2_value: 50 });
    expect(contest.text).toContain("Result: Active side (侦查)");
    const event = contest.events[0];
    expect(event?.kind === "dice" && event.data.kind).toBe("opposed");
    const missing = await room.call(room.catalog(), "opposed_check", { skill1: "侦查", skill2: "潜行" });
    expect(missing.code).toBe("unknown_skill");
    expect(missing.text).toContain("give skill2_value");
  });

  test("random_madness draws from the pack's table; an unknown table is refused", async () => {
    const room = bench();
    room.random.push(1);
    const drawn = await room.call(room.catalog(), "random_madness", {}, { context: room.context({ who: NOBODY }) });
    expect(drawn.text).toStartWith("Temporary madness:\n失忆");
    expect((await room.call(room.catalog(), "random_madness", { table: "long" })).text).toStartWith("Long-term madness:");
    expect((await room.call(room.catalog(), "random_madness", { table: "nope" })).code).toBe("unknown_table");
  });
});

describe("dnd5e", () => {
  test("opposed_check settles by totals", async () => {
    const room = bench();
    room.addCharacter("ada", "Ada", { pack: "dnd5e", sheet: { name: "Ada", attributes: { STR: 14, DEX: 16, CON: 12, INT: 10, WIS: 13, CHA: 8 } } });
    room.random.push(10, 10);
    const contest = await room.call(room.catalog({ pack: room.pack("dnd5e") }), "opposed_check", { skill1: "STR", skill2: "Athletics", skill1_value: 4, skill2_value: 1 }, { context: room.context({ pack: "dnd5e" }) });
    expect(contest.text).toContain("Result: Active side (STR)");
  });

  test("a coc7 character cannot use a subsystem of another pack", async () => {
    const room = bench();
    room.addCharacter("ada", "Ada");
    const outcome = await room.call(room.catalog({ pack: room.pack("dnd5e") }), "opposed_check", { skill1: "STR", skill2: "x", skill2_value: 3 }, { context: room.context({ pack: "dnd5e" }) });
    expect(outcome.code).toBe("not_declared");
  });
});
