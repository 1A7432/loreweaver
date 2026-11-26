// Subscriptions: what each connection is sent, when, under which rev — and what is never
// computed at all.
import { describe, expect, test } from "bun:test";
import type { ViewFrame } from "loreweaver-protocol/v3";

import { SCENE_ID, SCENE_TYPE, sceneData, EMPTY_SCENE } from "../../../src/core/notes/index.ts";
import {
  type ComputedView,
  MAX_SUBSCRIPTIONS,
  MAX_VIEW_BYTES,
  RoomViews,
  viewCatalog,
  type ViewerContext,
  ViewSubscriptions,
} from "../../../src/gateway/views/index.ts";
import { ADA, ADMIN, BAO, EVE, ROOM, seededRoom } from "./fixture.ts";

function frames(delivery: { frames: ViewFrame[] } | undefined): [string, number, number][] {
  return (delivery?.frames ?? []).map((frame) => [frame.name, frame.rev, frame.at]);
}

/** Stand-in views that count how often each is computed, per viewer. */
function counting(values: Record<string, (viewer: ViewerContext) => unknown>, admin: readonly string[] = []): { views: ComputedView[]; calls: Map<string, number> } {
  const calls = new Map<string, number>();
  const views = Object.entries(values).map(([name, compute]): ComputedView => ({
    name: name as ComputedView["name"],
    schema: { type: "object" },
    admin: admin.includes(name),
    compute: (_source, viewer) => {
      const key = `${name}:${viewer.member.id}`;
      calls.set(key, (calls.get(key) ?? 0) + 1);
      return compute(viewer) as never;
    },
  }));
  return { views, calls };
}

describe("RoomViews over the real built-ins", () => {
  test("subscribe sends the current values; an unchanged view is not re-sent; a change bumps rev with the new `at`", async () => {
    const room = seededRoom();
    const views = new RoomViews();
    views.open("c1", room.viewer(ADA));
    const first = await views.subscribe("c1", ["scene", "me"], room.inputs(5));
    expect(frames(first)).toEqual([
      ["scene", 1, 5],
      ["me", 1, 5],
    ]);
    expect(first.problems).toEqual([]);

    expect((await views.refresh(room.inputs(6))).get("c1")).toBeUndefined();

    room.b.services.documents.put(room.b.store.writer(ROOM), SCENE_TYPE, SCENE_ID, sceneData({ ...EMPTY_SCENE, name: "The Cellar" }));
    const after = (await views.refresh(room.inputs(7))).get("c1");
    expect(frames(after)).toEqual([["scene", 2, 7]]);
    expect((after?.frames[0]?.data as { name: string }).name).toBe("The Cellar");
  });

  test("view.list hides nothing a player may have and lists module views too", () => {
    const room = seededRoom();
    const views = new RoomViews();
    views.open("c1", room.viewer(EVE));
    expect(views.list("c1").map((listing) => listing.name)).toEqual(["me", "party", "scene", "variables", "characters", "commands", "room", "usage", "packs", "panels"]);
    expect(views.list("c1").every((listing) => typeof listing.schema === "object")).toBe(true);
  });

  test("an unknown name is refused, not subscribed", async () => {
    const room = seededRoom();
    const views = new RoomViews();
    views.open("c1", room.viewer(BAO));
    const result = await views.subscribe("c1", ["nope", "room"], room.inputs());
    expect(result.problems).toEqual([{ name: "nope", code: "unknown_view" }]);
    expect(views.subscriptions.subscribed("c1")).toEqual(["room"]);
  });
});

describe("laziness", () => {
  test("a view nobody subscribed to is never computed; one viewer's connections share one computation", async () => {
    const room = seededRoom();
    const { views: stubs, calls } = counting({ alpha: () => ({ n: 1 }), beta: () => ({ n: 2 }) });
    const views = new RoomViews({ builtIns: stubs });
    views.open("ada-1", room.viewer(ADA));
    views.open("ada-2", room.viewer(ADA));
    views.open("bao", room.viewer(BAO));
    views.open("eve", room.viewer(EVE));
    await views.subscribe("ada-1", ["alpha"], room.inputs());
    await views.subscribe("ada-2", ["alpha"], room.inputs());
    await views.subscribe("bao", ["alpha"], room.inputs());
    calls.clear();
    const out = await views.refresh(room.inputs(2));
    expect(calls.get("alpha:m-ada")).toBe(1);
    expect(calls.get("alpha:m-bao")).toBe(1);
    expect([...calls.keys()].some((key) => key.startsWith("beta"))).toBe(false);
    expect(calls.has("alpha:m-eve")).toBe(false);
    expect(out.size).toBe(0);
  });
});

describe("admin views", () => {
  test("an admin/* name is never listed to, nor subscribable by, a non-admin", async () => {
    const room = seededRoom();
    const { views: stubs, calls } = counting({ me: () => ({}), "admin/model": () => ({ key: "sk-…1234" }) }, ["admin/model"]);
    const views = new RoomViews({ builtIns: stubs });
    views.open("p", room.viewer(ADA));
    views.open("a", room.viewer(ADMIN));
    expect(views.list("p").map((listing) => listing.name)).toEqual(["me"]);
    expect(views.list("a").map((listing) => listing.name)).toEqual(["me", "admin/model"]);
    expect((await views.subscribe("p", ["admin/model"], room.inputs())).problems).toEqual([{ name: "admin/model", code: "unknown_view" }]);
    expect(await views.get("p", "admin/model", room.inputs())).toEqual({ name: "admin/model", code: "unknown_view" });
    expect(calls.has("admin/model:m-ada")).toBe(false);
    expect(frames(await views.subscribe("a", ["admin/model"], room.inputs(3)))).toEqual([["admin/model", 1, 3]]);
  });

  test("a demoted connection loses its admin subscription", () => {
    const room = seededRoom();
    const subs = new ViewSubscriptions();
    const catalog = viewCatalog([{ name: "admin/keys" as never, schema: {}, admin: true, compute: () => ({}) as never }]);
    subs.open("a", room.viewer(ADMIN));
    expect(subs.subscribe("a", ["admin/keys"], catalog).added).toEqual(["admin/keys"]);
    subs.setViewer("a", { ...room.viewer(ADMIN), member: { ...ADMIN, role: "player" } });
    expect(subs.subscribed("a")).toEqual([]);
  });
});

describe("ViewSubscriptions", () => {
  const catalog = viewCatalog(Array.from({ length: MAX_SUBSCRIPTIONS + 2 }, (_, index) => ({ name: `v${index}` as never, schema: {}, admin: false, compute: () => ({}) as never })));

  test("subscriptions past the cap are refused by name", () => {
    const subs = new ViewSubscriptions();
    subs.open("c", seededRoom().viewer(ADA));
    const names = [...catalog.keys()];
    const result = subs.subscribe("c", names, catalog);
    expect(result.added.length).toBe(MAX_SUBSCRIPTIONS);
    expect(result.problems).toEqual(names.slice(MAX_SUBSCRIPTIONS).map((name) => ({ name, code: "too_many_views" })));
  });

  test("an over-large value is not sent and is reported; the last value sent stands", () => {
    const subs = new ViewSubscriptions();
    subs.open("c", seededRoom().viewer(ADA));
    subs.subscribe("c", ["v0"], catalog);
    expect(frames(subs.refresh("c", new Map([["v0", { a: 1 }]]), 1))).toEqual([["v0", 1, 1]]);
    const big = subs.refresh("c", new Map([["v0", { a: "x".repeat(MAX_VIEW_BYTES) }]]), 2);
    expect(big).toEqual({ frames: [], problems: [{ name: "v0", code: "too_large" }] });
    expect(subs.refresh("c", new Map([["v0", { a: 1 }]]), 3).frames).toEqual([]);
  });

  test("key order does not make a value new; an unsubscribed view is not sent; rev keeps growing across a resubscribe", () => {
    const subs = new ViewSubscriptions();
    subs.open("c", seededRoom().viewer(ADA));
    subs.subscribe("c", ["v0", "v1"], catalog);
    expect(frames(subs.refresh("c", new Map<string, unknown>([["v0", { a: 1, b: 2 }], ["v1", 1]]), 1)).length).toBe(2);
    expect(subs.refresh("c", new Map([["v0", { b: 2, a: 1 }]]), 2).frames).toEqual([]);
    expect(subs.unsubscribe("c", ["v1", "v9"])).toEqual(["v1"]);
    expect(subs.refresh("c", new Map([["v1", 2]]), 3).frames).toEqual([]);
    subs.subscribe("c", ["v1"], catalog);
    expect(frames(subs.refresh("c", new Map([["v1", 2]]), 4))).toEqual([["v1", 2, 4]]);
  });

  test("view.get: an unchanged value keeps its rev, a changed one gets the next; it works unsubscribed", () => {
    const subs = new ViewSubscriptions();
    subs.open("c", seededRoom().viewer(ADA));
    expect(subs.get("c", "v3", { x: 1 }, 1, catalog)).toEqual({ type: "view", name: "v3", rev: 1, at: 1, data: { x: 1 } });
    expect(subs.get("c", "v3", { x: 1 }, 2, catalog)).toEqual({ type: "view", name: "v3", rev: 1, at: 2, data: { x: 1 } });
    expect(subs.get("c", "v3", { x: 2 }, 3, catalog)).toEqual({ type: "view", name: "v3", rev: 2, at: 3, data: { x: 2 } });
    expect(subs.subscribed("c")).toEqual([]);
    expect(subs.get("gone", "v3", 1, 1, catalog)).toEqual({ name: "v3", code: "not_open" });
  });

  test("rev counts per connection", () => {
    const subs = new ViewSubscriptions();
    const room = seededRoom();
    subs.open("a", room.viewer(ADA));
    subs.open("b", room.viewer(ADA));
    subs.subscribe("a", ["v0"], catalog);
    subs.subscribe("b", ["v0"], catalog);
    subs.refresh("a", new Map([["v0", 1]]), 1);
    subs.refresh("a", new Map([["v0", 2]]), 2);
    expect(frames(subs.refresh("b", new Map([["v0", 2]]), 2))).toEqual([["v0", 1, 2]]);
  });
});
