// A lore entry that is switched off does not exist for a player: not in their list, not in
// any player-grade projection. The switch is the admin's, kept in the keeper-side overlay;
// what a player may see follows it in the same commit.
import { expect, test } from "bun:test";

import { LORE_ENTRY_DEFAULTS, LORE_ENTRY_TYPE, loreEntryDocument, type LoreEntryView } from "../../../src/core/lore/index.ts";
import type { Viewer } from "../../../src/core/documents/index.ts";
import { ADA, ADMIN, bench, type Bench, ok, ROOM } from "./bench.ts";
import { SECRET, seedLore } from "./seed.ts";

const PLAYER: Viewer = { grade: "player", locale: "en" };
const OBSERVER: Viewer = { grade: "observer", locale: "en" };
const ADMIN_VIEWER: Viewer = { grade: "admin", locale: "en" };
const KEEPER: Viewer = { grade: "keeper", locale: "en" };

function titles(b: Bench, viewer: Viewer): string[] {
  return b.services.views.views(ROOM, LORE_ENTRY_TYPE, viewer).map((entry) => (entry.view as LoreEntryView).title).sort();
}

function put(b: Bench, id: string, entry: Parameters<typeof loreEntryDocument>[0]): void {
  const { data, meta } = loreEntryDocument(entry);
  b.services.documents.put(b.store.writer(ROOM), LORE_ENTRY_TYPE, id, data, meta);
}

async function listed(b: Bench, member: typeof ADA): Promise<string> {
  return ok(await b.run(member, "lore", { op: "list" })).text ?? "";
}

test("switched off by the admin, an entry disappears for players and observers and comes back when switched on", async () => {
  const b = bench();
  seedLore(b);
  expect(titles(b, PLAYER)).toEqual(["Arkham"]);
  expect(await listed(b, ADA)).toContain("Arkham");

  ok(await b.run(ADMIN, "lore", { op: "disable", title: "Arkham" }));
  for (const viewer of [PLAYER, OBSERVER]) expect(titles(b, viewer)).toEqual([]);
  // Neither its title nor its text: for a player it is not there.
  const text = await listed(b, ADA);
  expect([text.includes("Arkham"), text.includes("A town by the river.")]).toEqual([false, false]);
  expect(JSON.stringify(ok(await b.run(ADA, "lore", { op: "list" })).data)).not.toContain("Arkham");
  // The admin still has it, marked off; the Keeper's own view is whole.
  expect(titles(b, ADMIN_VIEWER)).toEqual(["Arkham", SECRET.loreTitle].sort());
  expect(await listed(b, ADMIN)).toContain("Arkham");
  expect(titles(b, KEEPER)).toContain("Arkham");

  ok(await b.run(ADMIN, "lore", { op: "enable", title: "Arkham" }));
  expect(titles(b, PLAYER)).toEqual(["Arkham"]);

  // `restore` drops the switch: the entry is as its file has it — on.
  ok(await b.run(ADMIN, "lore", { op: "disable", title: "Arkham" }));
  expect(titles(b, PLAYER)).toEqual([]);
  ok(await b.run(ADMIN, "lore", { op: "restore", title: "Arkham" }));
  expect(titles(b, PLAYER)).toEqual(["Arkham"]);
});

test("an entry its own file says is off is hidden from the start, and shown once the admin switches it on", async () => {
  const b = bench();
  put(b, "lore-route", { ...LORE_ENTRY_DEFAULTS, title: "Hard mode", content: "The tide comes twice a day.", enabled: false, source: "pack:demo" });
  put(b, "lore-open", { ...LORE_ENTRY_DEFAULTS, title: "Arkham", content: "A town by the river.", source: "pack:demo" });
  // Nothing has synced these documents yet: the file's own flag decides.
  expect(titles(b, PLAYER)).toEqual(["Arkham"]);
  expect(await listed(b, ADA)).not.toContain("Hard mode");
  ok(await b.run(ADMIN, "lore", { op: "enable", title: "Hard mode" }));
  expect(titles(b, PLAYER)).toEqual(["Arkham", "Hard mode"]);
  ok(await b.run(ADMIN, "lore", { op: "restore", title: "Hard mode" }));
  expect(titles(b, PLAYER)).toEqual(["Arkham"]);
});

test("two entries under one title share the switch; an entry added under a switched-off title is off at once", async () => {
  const b = bench();
  put(b, "lore-a", { ...LORE_ENTRY_DEFAULTS, title: "Route B", content: "first half", source: "pack:demo" });
  put(b, "lore-b", { ...LORE_ENTRY_DEFAULTS, title: "Route B", content: "second half", source: "pack:demo" });
  ok(await b.run(ADMIN, "lore", { op: "disable", title: "Route B" }));
  expect(titles(b, PLAYER)).toEqual([]);
  ok(await b.run(ADMIN, "lore", { op: "add", title: "Route B", content: "a third page" }));
  expect(titles(b, PLAYER)).toEqual([]);
  expect(titles(b, KEEPER)).toEqual(["Route B", "Route B", "Route B"]);
});

test("a secret entry stays hidden whatever its switch says", async () => {
  const b = bench();
  seedLore(b);
  ok(await b.run(ADMIN, "lore", { op: "enable", title: SECRET.loreTitle }));
  expect(titles(b, PLAYER)).toEqual(["Arkham"]);
  expect(JSON.stringify(b.services.views.views(ROOM, LORE_ENTRY_TYPE, PLAYER))).not.toContain(SECRET.lore);
});
