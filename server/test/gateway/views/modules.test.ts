// Module views: each viewer gets the value computed for them, unfiltered, and nobody else's.
import { describe, expect, test } from "bun:test";

import type { ModuleInfo, RenderOutcome } from "../../../src/agent/modules.ts";
import { listedModuleViews, MAX_VIEW_BYTES, mergeModuleViews, RoomViews } from "../../../src/gateway/views/index.ts";
import { ADA, BAO, EVE, seededRoom } from "./fixture.ts";

function info(id: string, views: readonly string[]): ModuleInfo {
  return {
    id,
    events: { turnStart: false, toolUse: false, replyPhase: false },
    commands: [],
    views: views.map((name) => ({ name, title: `${name} title`, schema: { type: "object" } })),
    clock: false,
    characters: false,
  };
}

function outcome(perViewer: readonly (readonly { module: string; view: string; data: never }[])[]): RenderOutcome {
  return { viewers: perViewer.map((views) => ({ views, commands: [] })), characters: [], clock: null, problems: [] };
}

describe("mergeModuleViews", () => {
  test("files each value under the viewer it was computed for", () => {
    const room = seededRoom();
    const ada = room.viewer(ADA);
    const bao = room.viewer(BAO);
    const merged = mergeModuleViews(
      outcome([[{ module: "heist", view: "plan", data: { secret: "ADA-ONLY" } as never }], [{ module: "heist", view: "plan", data: { secret: "BAO-ONLY" } as never }]]),
      [ada, bao],
      [info("heist", ["plan"])],
    );
    expect(merged.listings).toEqual([{ name: "heist/plan", schema: { type: "object" }, title: "plan title" }]);
    expect(merged.values(ada)?.get("heist/plan")).toEqual({ secret: "ADA-ONLY" });
    expect(merged.values(bao)?.get("heist/plan")).toEqual({ secret: "BAO-ONLY" });
    expect(merged.values(room.viewer(EVE))).toBeUndefined();
    // The same member in another language is another viewer: not handed Ada's English value.
    expect(merged.values(room.viewer(ADA, "zh"))).toBeUndefined();
  });

  test("an over-large value is dropped with a problem, never truncated", () => {
    const room = seededRoom();
    const ada = room.viewer(ADA);
    const merged = mergeModuleViews(
      outcome([[{ module: "heist", view: "plan", data: { blob: "x".repeat(200) } as never }, { module: "heist", view: "small", data: 1 as never }]]),
      [ada],
      [info("heist", ["plan", "small"])],
      100,
    );
    expect(merged.values(ada)?.has("heist/plan")).toBe(false);
    expect(merged.values(ada)?.get("heist/small")).toBe(1);
    expect(merged.problems.length).toBe(1);
    expect(merged.problems[0]).toContain("over 100");
    expect(MAX_VIEW_BYTES).toBeGreaterThan(100);
  });

  test("a module named `admin` cannot publish under the admin-only names", () => {
    const merged = mergeModuleViews(outcome([]), [], [info("admin", ["model"])]);
    expect(merged.listings).toEqual([]);
    expect(merged.problems.length).toBe(1);
  });

  test("a view the module did not declare at load is not forwarded", () => {
    const room = seededRoom();
    const ada = room.viewer(ADA);
    const merged = mergeModuleViews(outcome([[{ module: "heist", view: "extra", data: 1 as never }]]), [ada], [info("heist", ["plan"])]);
    expect(merged.values(ada)?.size).toBe(0);
  });
});

describe("module views through RoomViews", () => {
  test("subscribable before a render, sent after it, to that viewer only; the render is asked only for subscribers", async () => {
    const room = seededRoom();
    const modules = [info("heist", ["plan"])];
    const views = new RoomViews();
    views.open("ada", room.viewer(ADA));
    views.open("bao", room.viewer(BAO));
    views.open("eve", room.viewer(EVE));
    expect(views.list("eve", listedModuleViews(modules)).map((listing) => listing.name)).toContain("heist/plan");

    const before = await views.subscribe("ada", ["heist/plan"], { ...room.inputs(1), modules: listedModuleViews(modules) });
    expect(before).toEqual({ frames: [], problems: [] });
    await views.subscribe("bao", ["heist/plan", "scene"], { ...room.inputs(1), modules: listedModuleViews(modules) });
    await views.subscribe("eve", ["scene"], room.inputs(1));

    const renderFor = views.moduleViewers();
    expect(renderFor.map((viewer) => viewer.member.id)).toEqual([ADA.id, BAO.id]);
    const merged = mergeModuleViews(
      outcome(renderFor.map((viewer) => [{ module: "heist", view: "plan", data: { for: viewer.member.id } as never }])),
      renderFor,
      modules,
    );
    const out = await views.refresh({ ...room.inputs(2), modules: merged });
    expect(out.get("ada")?.frames).toEqual([{ type: "view", name: "heist/plan", rev: 1, at: 2, data: { for: ADA.id } }]);
    expect(out.get("bao")?.frames.map((frame) => frame.data)).toEqual([{ for: BAO.id }]);
    expect(out.get("eve")).toBeUndefined();
  });
});
