// The built-in views' content, per viewer grade, and their agreement with the schemas the
// protocol package ships.
import { describe, expect, test } from "bun:test";
import {
  BUILT_IN_VIEW_SCHEMAS,
  type BuiltInViewName,
  type BuiltInViews,
  type CharactersView,
  type CommandsViewData,
  type MeView,
  type PartyView,
  type RoomView,
  type SceneView,
  type UsageView,
  type VariablesView,
} from "loreweaver-protocol/v3";

import { KEEPER_MUTED, ROOM_LOCALE } from "../../../src/gateway/commands/index.ts";
import { BUILT_IN_VIEWS, LAST_TURN_USAGE, recordUsage, type ViewerContext } from "../../../src/gateway/views/index.ts";
import { ADA, ADMIN, BAO, EVE, ROOM, type Room, seededRoom } from "./fixture.ts";
import { schemaProblems } from "./schema_check.ts";

async function compute<N extends BuiltInViewName>(room: Room, name: N, viewer: ViewerContext): Promise<BuiltInViews[N]> {
  const view = BUILT_IN_VIEWS.find((candidate) => candidate.name === name);
  if (view === undefined) throw new Error(name);
  const value = (await view.compute(room.source(), viewer)) as BuiltInViews[N];
  expect(schemaProblems(BUILT_IN_VIEW_SCHEMAS[name], value)).toEqual([]);
  return value;
}


describe("me", () => {
  test("a player sees their character whole: resources, labelled attributes and skills, status", async () => {
    const room = seededRoom();
    const me: MeView = await compute(room, "me", room.viewer(ADA));
    expect(me.member).toEqual({ id: ADA.id, name: ADA.name, role: "player", roleLabel: "Player" });
    expect(me.character?.id).toBe("pc-ada");
    expect(me.character?.resources.map((meter) => meter.id)).toEqual(["hp", "san", "mp"]);
    expect(me.character?.attributes.find((stat) => stat.key === "STR")).toEqual({ key: "STR", label: "STR", value: 50 });
    expect(me.character?.attributes.find((stat) => stat.key === "HPMAX")?.label).toBe("Max HP");
    expect(me.character?.skills.length).toBeGreaterThan(0);
  });

  test("labels follow the viewer's language, not the room's", async () => {
    const room = seededRoom();
    const zh = await compute(room, "me", room.viewer(ADA, "zh"));
    expect(zh.member.roleLabel).toBe("玩家");
    expect(zh.character?.attributes.find((stat) => stat.key === "STR")?.label).toBe("力量");
    expect(zh.character?.attributes.find((stat) => stat.key === "HPMAX")?.label).toBe("生命值上限");
    // The room is English; the skills follow the viewer too.
    const en = await compute(room, "me", room.viewer(ADA, "en"));
    expect(zh.character?.skills.map((stat) => stat.label)).not.toEqual(en.character?.skills.map((stat) => stat.label));
  });

  test("an admin and an observer with no seat are spectators", async () => {
    const room = seededRoom();
    expect((await compute(room, "me", room.viewer(ADMIN))).character).toBeNull();
    const eve = await compute(room, "me", room.viewer(EVE));
    expect(eve).toEqual({ member: { id: EVE.id, name: EVE.name, role: "observer", roleLabel: "Observer" }, character: null });
  });
});

describe("party", () => {
  test("who is at the table, who plays whom, resources and status, the initiative", async () => {
    const room = seededRoom();
    const party: PartyView = await compute(room, "party", room.viewer(ADA));
    expect(party.members.map((member) => [member.id, member.online, member.character])).toEqual([
      [ADA.id, true, "pc-ada"],
      [BAO.id, true, "pc-bao"],
      [ADMIN.id, true, null],
      [EVE.id, true, null],
    ]);
    // The pregen on offer is the `characters` view's; the companion is in play.
    expect(party.characters.map((entry) => entry.id)).toEqual(["pc-ada", "pc-bao", "companion"]);
    const bao = party.characters.find((entry) => entry.id === "pc-bao");
    expect(bao?.player).toEqual({ id: BAO.id, name: BAO.name });
    expect(bao?.status).toEqual(["poisoned"]);
    expect(bao?.resources.length).toBe(3);
    expect(party.initiative).toEqual({ round: 1, acting: "Ada Lovelace", order: [{ name: "Ada Lovelace", value: 70 }, { name: "Cultist", value: 40 }] });
  });

  test("a seated member who is offline is still listed, by the name they sat down with", async () => {
    const room = seededRoom();
    room.online = [ADA];
    const party = await compute(room, "party", room.viewer(EVE));
    expect(party.members).toEqual([
      { id: ADA.id, name: ADA.name, role: "player", online: true, character: "pc-ada" },
      { id: BAO.id, name: BAO.name, role: null, online: false, character: "pc-bao" },
    ]);
  });
});

describe("scene", () => {
  test("name, focus, facts, the time and the combat round — same for every grade", async () => {
    const room = seededRoom();
    const scene: SceneView = await compute(room, "scene", room.viewer(BAO));
    expect(scene).toEqual({
      name: "The Farm",
      focus: "Searching the barn",
      established: [{ text: "The mill burned down", at: null }],
      time: "Day 1 08:00",
      clockModule: null,
      round: 1,
    });
    expect(await compute(room, "scene", room.viewer(ADMIN))).toEqual(scene);
    expect(await compute(room, "scene", room.viewer(EVE))).toEqual(scene);
  });
});

describe("variables", () => {
  test("a player and an observer see player-visible trackers and exposed leaves only", async () => {
    const room = seededRoom();
    for (const member of [ADA, EVE]) {
      const variables: VariablesView = await compute(room, "variables", room.viewer(member));
      expect(variables.module).toEqual([{ id: "morale", kind: "number", label: "Morale", value: 7, min: 0, max: 10 }]);
      expect(variables.tree).toEqual([{ path: "stats.hp", value: 10 }]);
    }
  });

  test("an admin sees every one, the hidden ones flagged", async () => {
    const room = seededRoom();
    const variables = await compute(room, "variables", room.viewer(ADMIN));
    expect(variables.module.map((variable) => [variable.id, variable.hidden ?? false])).toEqual([
      ["morale", false],
      ["doom", true],
    ]);
    expect(variables.tree.map((leaf) => [leaf.path, leaf.hidden ?? false])).toEqual([
      ["stats.hp", false],
      ["plot.ending", true],
    ]);
  });

  test("tracker labels follow the viewer's language", async () => {
    const room = seededRoom();
    expect((await compute(room, "variables", room.viewer(ADA, "zh"))).module[0]?.label).toBe("士气");
  });
});

describe("characters", () => {
  test("what is on offer, who holds it, and the systems that can make one", async () => {
    const room = seededRoom();
    const view: CharactersView = await compute(room, "characters", room.viewer(ADA));
    expect(view.claimable).toEqual([{ id: "pregen-holmes", name: "Holmes", blurb: "A detective.", source: { kind: "pack", id: "demo" }, player: null }]);
    expect(view.mine).toBe("pc-ada");
    expect(view.systems.map((system) => [system.id, system.active])).toEqual([
      ["coc7", true],
      ["dnd5e", false],
    ]);
  });
});

describe("commands", () => {
  test("delegates to the registry: an admin command is not in a player's table", async () => {
    const room = seededRoom();
    const player: CommandsViewData = await compute(room, "commands", room.viewer(ADA));
    const admin = await compute(room, "commands", room.viewer(ADMIN));
    expect(player.commands.some((entry) => entry.id === "roll")).toBe(true);
    expect(admin.commands.length).toBeGreaterThanOrEqual(player.commands.length);
    const observer = await compute(room, "commands", room.viewer(EVE));
    expect(observer.commands.find((entry) => entry.id === "roll")).toMatchObject({ available: false, reason: "observer" });
    const zh = await compute(room, "commands", room.viewer(ADA, "zh"));
    expect(zh.commands.find((entry) => entry.id === "roll")?.title).not.toBe(player.commands.find((entry) => entry.id === "roll")?.title);
  });
});

describe("room", () => {
  test("language, system, variant, muted — the language's name in the viewer's language", async () => {
    const room = seededRoom();
    const view: RoomView = await compute(room, "room", room.viewer(ADA));
    expect(view).toEqual({ locale: "en", localeLabel: "English", system: { id: "coc7", label: view.system?.label ?? "" }, variant: null, keeperMuted: false });
    const writer = room.b.store.writer(ROOM);
    writer.statePut(ROOM_LOCALE, "zh");
    writer.statePut(KEEPER_MUTED, true);
    const after = await compute(room, "room", room.viewer(ADA));
    expect(after).toMatchObject({ locale: "zh", localeLabel: "Chinese", keeperMuted: true });
    expect((await compute(room, "room", room.viewer(ADA, "zh"))).localeLabel).toBe("中文");
  });
});

describe("usage", () => {
  test("nothing until a turn records it; the writer stores the turn's figures", async () => {
    const room = seededRoom();
    expect(await compute(room, "usage", room.viewer(ADA))).toEqual({ last: null });
    const context = room.b.context(ADA);
    recordUsage(context, { inputTokens: 1200, outputTokens: 300, cachedInputTokens: 1000, estimated: false });
    const usage: UsageView = await compute(room, "usage", room.viewer(EVE));
    expect(usage.last).toEqual({ turn: context.turn, inputTokens: 1200, outputTokens: 300, cachedInputTokens: 1000, cacheWriteTokens: 0, reasoningTokens: 0, estimated: false });
    expect(LAST_TURN_USAGE.lifecycle).toEqual({ reset: "story" });
  });
});

describe("schemas", () => {
  test("every built-in has the protocol's schema, and the checker refuses a wrong shape", () => {
    for (const view of BUILT_IN_VIEWS) expect(view.schema).toBe(BUILT_IN_VIEW_SCHEMAS[view.name]);
    expect(schemaProblems(BUILT_IN_VIEW_SCHEMAS.usage, { last: null, extra: 1 })).not.toEqual([]);
    expect(schemaProblems(BUILT_IN_VIEW_SCHEMAS.scene, { name: "x" })).not.toEqual([]);
    expect(schemaProblems(BUILT_IN_VIEW_SCHEMAS.me, { member: { id: "a", name: "b", role: "keeper", roleLabel: "c" }, character: null })).not.toEqual([]);
  });
});
