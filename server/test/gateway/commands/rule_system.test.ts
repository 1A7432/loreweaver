// `rule system`: the admin chooses the room's rule system; it lands in `room.rule_pack`,
// clears the ladder of the old system, and is announced to the table in the room's language.
import { expect, test } from "bun:test";

import { ROOM_RULE_PACK, ROOM_RULE_VARIANT } from "../../../src/gateway/commands/index.ts";
import { ADA, ADMIN, bench, code, ok, ROOM } from "./bench.ts";

function narration(outcome: ReturnType<typeof ok>): string[] {
  return outcome.events.flatMap((event) => (event.kind === "narrative" ? [event.data.text] : []));
}

test("the text form names a system by id or by one of its names, or goes back to the default", async () => {
  const b = bench();
  const probe = b.context(ADMIN, { newTurn: false });
  expect(b.registry.textCommand(probe, ".rule system dnd5e", "en")).toEqual({ id: "rule", args: { system: "dnd5e" } });
  expect(b.registry.textCommand(probe, ".rule 系统 默认", "zh")).toEqual({ id: "rule", args: { system: null } });
  expect(b.registry.textCommand(probe, ".rule system", "en")).toMatchObject({ ok: false, code: "usage" });
  expect(b.registry.textCommand(probe, ".rule 2", "en")).toEqual({ id: "rule", args: { variant: "rule2" } });
});

test("the admin sets the system; the ladder of the old one is cleared; the table is told", async () => {
  const b = bench();
  ok(await b.run(ADMIN, "rule", { variant: "rule3" }));
  const set = ok(await b.run(ADMIN, "rule", { system: "dnd" }));
  expect(set.data).toEqual({ system: "dnd5e" });
  expect(narration(set)).toEqual(["Rule system set to dnd5e."]);
  expect(b.store.stateGet(ROOM, ROOM_RULE_PACK)).toBe("dnd5e");
  expect(b.store.stateGet(ROOM, ROOM_RULE_VARIANT)).toBeNull();

  const back = ok(await b.run(ADMIN, "rule", { system: null }, "zh"));
  expect(back.data).toEqual({ system: null });
  expect(narration(back)).toEqual(["Rule system set to the server's default."]);
  expect(b.store.stateGet(ROOM, ROOM_RULE_PACK)).toBeNull();
});

test("a player may look and may not choose; an unknown system is refused", async () => {
  const b = bench();
  expect(code(await b.run(ADA, "rule", { system: "dnd5e" }))).toBe("forbidden");
  expect(code(await b.run(ADMIN, "rule", { system: "chess" }))).toBe("unknown_system");
  expect(b.store.stateGet(ROOM, ROOM_RULE_PACK)).toBeNull();
  const shown = ok(await b.run(ADA, "rule", {}));
  expect(shown.text).toContain("Rule system: coc7");
  expect(shown.data).toMatchObject({ system: "coc7", systems: ["coc7", "dnd5e", "wod"] });
  expect(shown.events).toEqual([]);
});

test("in a room with no system, the rule can be looked at and a system chosen", async () => {
  const b = bench({ system: null });
  const shown = ok(await b.run(ADA, "rule", {}));
  expect(shown.text).toContain("Rule system: none");
  expect(code(await b.run(ADMIN, "rule", { variant: "rule2" }))).toBe("no_rule_system");
  ok(await b.run(ADMIN, "rule", { system: "coc7" }));
  expect(b.store.stateGet(ROOM, ROOM_RULE_PACK)).toBe("coc7");
});
