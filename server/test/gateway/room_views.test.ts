// Views through the session: subscribe, get, list, unsubscribe; values pushed after a command
// to the connections subscribed and to nobody else; a seat change reaching `me`.
import { afterEach, expect, test } from "bun:test";

import type { MeView, PartyView } from "loreweaver-protocol/v3";

import { KEYS, resultFor, RoomBench, views } from "./room_bench.ts";

const benches: RoomBench[] = [];
afterEach(async () => {
  await Promise.all(benches.splice(0).map((bench) => bench.close()));
});

function setup(): RoomBench {
  const bench = new RoomBench();
  benches.push(bench);
  return bench;
}

test("subscribe answers first, then the current values follow; get recomputes; list and unsubscribe", async () => {
  const b = setup();
  const ada = b.join(KEYS.ada);
  ada.receive({ type: "call", rid: "s", method: "view.subscribe", params: { names: ["me", "room"] } });
  await b.settled();
  const at = ada.sent.findIndex((frame) => frame.type === "result" && frame.rid === "s");
  expect(ada.sent[at]).toEqual({ type: "result", rid: "s", ok: true, data: { problems: [] } });
  expect(ada.sent.slice(at + 1).map((frame) => (frame.type === "view" ? frame.name : frame.type))).toEqual(["me", "room"]);
  expect((views(ada.sent, "me")[0]?.data as MeView).member).toMatchObject({ name: "Ada", role: "player" });

  ada.receive({ type: "call", rid: "g", method: "view.get", params: { name: "room" } });
  ada.receive({ type: "call", rid: "l", method: "view.list", params: {} });
  ada.receive({ type: "call", rid: "u", method: "view.unsubscribe", params: { names: ["room", "party"] } });
  await b.settled();
  // Unchanged since it was sent: the same rev comes back.
  expect(resultFor(ada.sent, "g")).toMatchObject({ ok: true, data: { name: "room", rev: 1 } });
  const listed = resultFor(ada.sent, "l");
  expect(listed?.ok === true ? (listed.data as { views: { name: string }[] }).views.map((view) => view.name) : []).toContain("party");
  expect(resultFor(ada.sent, "u")).toEqual({ type: "result", rid: "u", ok: true, data: { removed: ["room"] } });
});

test("a command that changes a sheet pushes `me` to its subscriber, and nothing to a connection not subscribed", async () => {
  const b = setup();
  const ada = b.join(KEYS.ada);
  const bao = b.join(KEYS.bao);
  ada.receive({ type: "call", rid: "s", method: "view.subscribe", params: { names: ["me"] } });
  await b.settled();
  // Taking a seat changes who Ada is: her `me` now carries the character.
  ada.receive({ type: "input", rid: "c", text: ".coc Alice" });
  await b.settled();
  expect(resultFor(ada.sent, "c")?.ok).toBe(true);
  const seated = views(ada.sent, "me").at(-1)?.data as MeView;
  expect(seated.character?.name).toBe("Alice");
  const hp = seated.character?.resources.find((resource) => resource.id === "hp" || resource.label === "HP");
  const count = views(ada.sent, "me").length;

  ada.receive({ type: "input", rid: "st", text: ".st HP-2" });
  await b.settled();
  expect(resultFor(ada.sent, "st")?.ok).toBe(true);
  expect(views(ada.sent, "me").length).toBe(count + 1);
  const after = (views(ada.sent, "me").at(-1)?.data as MeView).character?.resources.find((resource) => resource.id === hp?.id);
  expect(after?.value).toBe((hp?.value ?? 0) - 2);
  expect(views(bao.sent)).toEqual([]);
});

test("`party` knows who is online", async () => {
  const b = setup();
  const bao = b.join(KEYS.bao);
  bao.receive({ type: "call", rid: "s", method: "view.subscribe", params: { names: ["party"] } });
  await b.settled();
  expect((views(bao.sent, "party").at(-1)?.data as PartyView).members.map((member) => member.name)).toEqual(["Bao"]);
  const ada = b.join(KEYS.ada);
  await b.settled();
  expect((views(bao.sent, "party").at(-1)?.data as PartyView).members.map((member) => member.name)).toEqual(["Bao", "Ada"]);
  ada.session.closed();
  await b.settled();
  expect((views(bao.sent, "party").at(-1)?.data as PartyView).members.map((member) => member.name)).toEqual(["Bao"]);
});

test("an admin-only view name is refused to a player", async () => {
  const b = setup();
  const ada = b.join(KEYS.ada);
  ada.receive({ type: "call", rid: "s", method: "view.subscribe", params: { names: ["admin/model"] } });
  ada.receive({ type: "call", rid: "g", method: "view.get", params: { name: "admin/model" } });
  ada.receive({ type: "call", rid: "bad", method: "view.subscribe", params: { names: "me" } });
  await b.settled();
  expect(resultFor(ada.sent, "s")).toEqual({ type: "result", rid: "s", ok: true, data: { problems: [{ name: "admin/model", code: "unknown_view" }] } });
  expect(resultFor(ada.sent, "g")).toEqual({ type: "result", rid: "g", ok: false, error: { code: "unknown_view", message: "No such view." } });
  expect(resultFor(ada.sent, "bad")).toMatchObject({ ok: false, error: { code: "invalid_params" } });
  expect(views(ada.sent)).toEqual([]);
});
