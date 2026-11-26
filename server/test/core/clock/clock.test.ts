import { describe, expect, test } from "bun:test";

import {
  actingCombatant,
  addCombatant,
  advanceClock,
  advanceTime,
  cancelEvent,
  clearInitiative,
  clockOwnerDocument,
  clockOwnershipData,
  type GameClock,
  gameClockData,
  gameClockDocument,
  type Initiative,
  initiativeData,
  initiativeDocument,
  isReadableClock,
  keeperMayAdvance,
  KEEPER_OWNS_CLOCK,
  MAX_COMBATANTS,
  MAX_SCHEDULED_EVENTS,
  mayChangeClock,
  moduleReleasesClock,
  moduleTakesClock,
  nextTurn,
  NO_FIGHT,
  parseDelta,
  readClockOwnership,
  readGameClock,
  readInitiative,
  removeCombatant,
  rollInitiative,
  scheduleEvent,
  setTime,
  UNSET_CLOCK,
} from "../../../src/core/clock/index.ts";
import { parseDice } from "../../../src/core/dice/index.ts";
import { actorViewer, KEEPER, playerViewer, type Document, type JsonObject, type Viewer } from "../../../src/core/documents/index.ts";
import { SeededRandom } from "../../../src/core/random.ts";
import { builtInPacks } from "../../../src/core/rulepacks/index.ts";
import { parseSheet } from "../../../src/core/sheets/index.ts";

function ok<T>(result: { ok: true; data: T } | { ok: false; code: string }): T {
  if (!result.ok) throw new Error(result.code);
  return result.data;
}

function doc(type: string, data: JsonObject): Document {
  return { type, id: "only", version: 1, data, meta: {}, corrupt: false };
}

const nonKeepers: readonly Viewer[] = [
  { grade: "admin", memberId: "m-admin", locale: "en" },
  playerViewer("en", "m1"),
  { grade: "observer", locale: "en" },
  actorViewer("hale", "en"),
];

describe("moving clock text", () => {
  test.each([
    ["D1 上午 09:30", "+2 hours", "D1 11:30"],
    ["d2 08:00", "+1d", "D3 08:00"],
    ["第3天 22:00", "+3小时", "第4天 01:00"],
    ["第3日 深夜 23:50", "+15分钟", "第4天 00:05"],
    ["1926-03-15 14:00", "+1 day", "1926-03-16 14:00"],
    ["1926-03-15T14:00", "+10min", "1926-03-15 14:10"],
    ["1926/12/31 23:30", "+1hour", "1927/01/01 00:30"],
    ["1926年3月15日", "+30分钟", "1926年03月15日 00:30"],
    ["1926年3月15日14:00", "-2 Hours", "1926年03月15日 12:00"],
    ["2024-02-28", "+1D", "2024-02-29 00:00"],
    ["2023-02-28 12:00", "+1 day", "2023-03-01 12:00"],
  ])("%s %s → %s", (now, delta, expected) => {
    const result = advanceTime(now, delta);
    expect(result).toMatchObject({ ok: true, now: expected, moved: true });
  });

  test("a clock the engine cannot read is kept as written, the advance still counted", () => {
    expect(advanceTime("澹洲三百年六月初二 午时", "+2 hours")).toEqual({ ok: true, now: "澹洲三百年六月初二 午时", minutes: 120, moved: false });
    expect(isReadableClock("2023-02-30 10:00")).toBe(false);
    expect(isReadableClock("D3 14:00")).toBe(true);
  });

  test("refusals", () => {
    expect(advanceTime("D1 01:00", "-2 hours")).toEqual({ ok: false, code: "before_start" });
    expect(advanceTime("D9999 23:00", "+2 hours")).toEqual({ ok: false, code: "out_of_range" });
    expect(advanceTime("0001-01-01 00:00", "-1min")).toEqual({ ok: false, code: "out_of_range" });
    expect(advanceTime("D1 01:00", "soon")).toEqual({ ok: false, code: "bad_delta" });
    expect(parseDelta("+36501 days")).toBeNull();
    expect(parseDelta("+2 Hours")).toBe(120);
    expect(parseDelta("-0min")).toBe(0);
    expect(Object.is(parseDelta("-0min"), -0)).toBe(false);
  });
});

describe("the game clock", () => {
  test("set, advance, schedule, cancel", () => {
    expect(advanceClock(UNSET_CLOCK, "+1 hour")).toEqual({ ok: false, code: "unset" });
    let clock: GameClock = ok(setTime(UNSET_CLOCK, " D1 08:00 "));
    expect(clock.now).toBe("D1 08:00");
    const advanced = advanceClock(clock, "+90min");
    if (!advanced.ok) throw new Error(advanced.code);
    expect(advanced.advance).toEqual({ from: "D1 08:00", to: "D1 09:30", minutes: 90, moved: true });
    expect(clock.now).toBe("D1 08:00");
    clock = ok(scheduleEvent(advanced.data, "D4 06:00", "the ship docks"));
    expect(ok(scheduleEvent(clock, "D4 06:00", "the ship docks"))).toBe(clock);
    expect(scheduleEvent(clock, "", "x")).toEqual({ ok: false, code: "bad_time" });
    expect(scheduleEvent(clock, "D5", "e".repeat(281))).toEqual({ ok: false, code: "bad_event" });
    expect(setTime(clock, "t".repeat(81))).toEqual({ ok: false, code: "bad_time" });
    expect(ok(cancelEvent(clock, 0)).events).toEqual([]);
    expect(cancelEvent(clock, 1)).toEqual({ ok: false, code: "unknown_event" });
    let full = clock;
    for (let i = 1; i < MAX_SCHEDULED_EVENTS; i++) full = ok(scheduleEvent(full, `D${i}`, "e"));
    expect(scheduleEvent(full, "D99", "late")).toEqual({ ok: false, code: "events_full" });
    expect(readGameClock(gameClockData(clock))).toEqual(clock);
  });

  test("scheduled events reach the Keeper only (sentinel)", () => {
    const clock = ok(scheduleEvent(ok(setTime(UNSET_CLOCK, "D1 08:00")), "EVENT-AT-SECRET-MARKER", "EVENT-SECRET-MARKER"));
    const document = doc("game_clock", gameClockData(clock));
    const keeperText = JSON.stringify(gameClockDocument.project(document, KEEPER));
    expect(keeperText).toContain("EVENT-SECRET-MARKER");
    expect(keeperText).toContain("EVENT-AT-SECRET-MARKER");
    for (const viewer of nonKeepers) {
      const view = gameClockDocument.project(document, viewer);
      expect(view).toEqual({ now: "D1 08:00" });
      expect(JSON.stringify(view)).not.toContain("SECRET-MARKER");
    }
    const codes = (data: JsonObject) => (gameClockDocument.validate?.(data) ?? []).map((v) => v.code);
    expect(codes(gameClockData(clock))).toEqual([]);
    expect(codes(gameClockData(UNSET_CLOCK))).toEqual([]);
    expect(codes({ now: "x", events: [{ at: "", what: "y" }] })).toEqual(["bad_time"]);
    expect(gameClockDocument.lifecycle).toEqual({ reset: "story" });
  });
});

describe("who owns the clock", () => {
  test("the Keeper by default; one module at a time", () => {
    expect(keeperMayAdvance(KEEPER_OWNS_CLOCK)).toBe(true);
    const taken = ok(moduleTakesClock(KEEPER_OWNS_CLOCK, "harbor"));
    expect(keeperMayAdvance(taken)).toBe(false);
    expect(mayChangeClock(taken, { kind: "module", id: "harbor" })).toBe(true);
    expect(mayChangeClock(taken, { kind: "keeper" })).toBe(false);
    expect(mayChangeClock(taken, { kind: "module", id: "other" })).toBe(false);
    expect(mayChangeClock(KEEPER_OWNS_CLOCK, { kind: "module", id: "harbor" })).toBe(false);
    expect(moduleTakesClock(taken, "other")).toEqual({ ok: false, code: "owned_by_other" });
    expect(ok(moduleTakesClock(taken, "harbor"))).toEqual(taken);
    expect(moduleTakesClock(KEEPER_OWNS_CLOCK, "")).toEqual({ ok: false, code: "bad_module" });
    expect(moduleReleasesClock(taken, "other")).toEqual({ ok: false, code: "not_owner" });
    expect(ok(moduleReleasesClock(taken, "harbor"))).toEqual(KEEPER_OWNS_CLOCK);
    expect(readClockOwnership(clockOwnershipData(taken))).toEqual(taken);
  });

  test("everyone sees the owner; it survives story and character resets", () => {
    const taken = ok(moduleTakesClock(KEEPER_OWNS_CLOCK, "harbor"));
    const document = doc("clock_owner", { ...clockOwnershipData(taken), note: "LATER-SECRET-MARKER" });
    for (const viewer of [KEEPER, ...nonKeepers]) expect(clockOwnerDocument.project(document, viewer)).toEqual({ owner: { kind: "module", id: "harbor" } });
    const codes = (data: JsonObject) => (clockOwnerDocument.validate?.(data) ?? []).map((v) => v.code);
    expect(codes(clockOwnershipData(taken))).toEqual([]);
    expect(codes(clockOwnershipData(KEEPER_OWNS_CLOCK))).toEqual([]);
    expect(codes({ owner: { kind: "keeper", id: "x" } })).toEqual(["bad_owner"]);
    expect(clockOwnerDocument.lifecycle).toEqual({ reset: "all" });
  });
});

describe("initiative", () => {
  const listed = (entries: readonly [string, number][]): Initiative => entries.reduce((init, [name, value]) => ok(addCombatant(init, name, value)), NO_FIGHT);

  test("highest first, ties in joining order, round 1 on the first add", () => {
    const init = listed([
      ["Ada", 12],
      ["Goblin", 18],
      ["Bob", 12],
      ["Cat", 5],
    ]);
    expect(init.order.map((c) => c.name)).toEqual(["Goblin", "Ada", "Bob", "Cat"]);
    expect([init.round, actingCombatant(init)?.name]).toEqual([1, "Ada"]);
  });

  test("next walks the order and wraps into a new round", () => {
    let init = listed([
      ["A", 3],
      ["B", 2],
    ]);
    expect(actingCombatant(init)?.name).toBe("A");
    init = ok(nextTurn(init));
    expect([init.round, actingCombatant(init)?.name]).toEqual([1, "B"]);
    init = ok(nextTurn(init));
    expect([init.round, actingCombatant(init)?.name]).toEqual([2, "A"]);
    expect(nextTurn(NO_FIGHT)).toEqual({ ok: false, code: "empty" });
  });

  test("joining ahead of the acting combatant keeps their turn", () => {
    let init = ok(nextTurn(listed([["A", 10], ["B", 5]])));
    expect(actingCombatant(init)?.name).toBe("B");
    init = ok(addCombatant(init, "Fast", 20));
    expect(actingCombatant(init)?.name).toBe("B");
    init = ok(addCombatant(init, "Slow", 1));
    expect(init.order.map((c) => c.name)).toEqual(["Fast", "A", "B", "Slow"]);
    expect(actingCombatant(init)?.name).toBe("B");
  });

  test("removing", () => {
    const init = ok(nextTurn(listed([["A", 3], ["B", 2], ["C", 1]])));
    expect(actingCombatant(ok(removeCombatant(init, "A")))?.name).toBe("B");
    expect(actingCombatant(ok(removeCombatant(init, "B")))?.name).toBe("C");
    const last = ok(nextTurn(init));
    const wrapped = ok(removeCombatant(last, "C"));
    expect([wrapped.round, actingCombatant(wrapped)?.name]).toEqual([2, "A"]);
    expect(ok(removeCombatant(listed([["A", 1]]), "A"))).toEqual(NO_FIGHT);
    expect(removeCombatant(init, "Z")).toEqual({ ok: false, code: "unknown_combatant" });
    expect(clearInitiative()).toEqual(NO_FIGHT);
  });

  test("refusals and hostile names", () => {
    const init = listed([["__proto__", 3], ["constructor", 2], ["10", 1]]);
    expect(readInitiative(initiativeData(init))?.order.map((c) => c.name)).toEqual(["__proto__", "constructor", "10"]);
    expect(addCombatant(init, "__proto__", 9)).toEqual({ ok: false, code: "already_listed" });
    expect(addCombatant(init, "", 9)).toEqual({ ok: false, code: "bad_name" });
    expect(addCombatant(init, "x", 1.5)).toEqual({ ok: false, code: "bad_value" });
    let full = NO_FIGHT;
    for (let i = 0; i < MAX_COMBATANTS; i++) full = ok(addCombatant(full, `c${i}`, i));
    expect(addCombatant(full, "late", 0)).toEqual({ ok: false, code: "full" });
  });

  test("everyone sees the whole order, picked field by field", () => {
    const init = listed([["A", 3], ["B", 2]]);
    const document = doc("initiative", { ...initiativeData(init), plan: "LATER-SECRET-MARKER" });
    const expected = { round: 1, acting: "A", order: [{ name: "A", value: 3 }, { name: "B", value: 2 }] };
    for (const viewer of [KEEPER, ...nonKeepers]) expect(initiativeDocument.project(document, viewer)).toEqual(expected);
    const codes = (data: JsonObject) => (initiativeDocument.validate?.(data) ?? []).map((v) => v.code);
    expect(codes(initiativeData(init))).toEqual([]);
    expect(codes(initiativeData(NO_FIGHT))).toEqual([]);
    expect(codes({ order: [{ name: "B", value: 2 }, { name: "A", value: 3 }], round: 1, current: 0 })).toEqual(["out_of_order"]);
    expect(codes({ order: [{ name: "A", value: 3 }], round: 1, current: 1 })).toEqual(["bad_current"]);
    expect(codes({ order: [], round: 2, current: 0 })).toEqual(["bad_round"]);
    expect(initiativeDocument.lifecycle).toEqual({ reset: "story" });
  });

  test("rolling a pack's initiative for a sheet", () => {
    const coc = builtInPacks().find((pack) => pack.id === "coc7");
    if (coc === undefined) throw new Error("coc7 is built in");
    const sheet = parseSheet(coc.sheet, { name: "Ada", system: "coc7", attributes: { DEX: 70 } }).sheet;
    const rolled = rollInitiative(coc.initiative, coc.sheet, sheet, new SeededRandom(7));
    if (!rolled.ok) throw new Error(rolled.code);
    expect(rolled.value).toBeGreaterThanOrEqual(71);
    expect(rolled.value).toBeLessThanOrEqual(170);
    expect(rollInitiative(coc.initiative, coc.sheet, sheet, new SeededRandom(7))).toEqual(rolled);
    expect(rollInitiative(null, coc.sheet, sheet, new SeededRandom(7))).toEqual({ ok: false, code: "no_initiative_roll" });
    expect(rollInitiative(parseDice("1d20 + {不存在}"), coc.sheet, sheet, new SeededRandom(7))).toEqual({ ok: false, code: "stat_unavailable", name: "不存在" });
  });
});
