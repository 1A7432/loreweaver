// `report`: the scoreboard in the result, the HTML page as an unlisted file of the room,
// and the reveal edition — an admin's, stored for admins, holding what a player's view of
// the same documents does not.
import { expect, test } from "bun:test";

import { MAX_REPORT_EVENTS, REPORT_PAGES } from "../../../src/gateway/commands/engine/report.ts";
import type { CommandOutcome } from "../../../src/gateway/commands/index.ts";
import { ADA, ADMIN, bench, type Bench, code, EVE, type Member, ok, ROOM } from "./bench.ts";
import { SECRET, seedChronicle, seedLore, seedNpc, seedVariables } from "./seed.ts";

async function typed(b: Bench, member: Member, line: string, locale = "en"): Promise<CommandOutcome> {
  const outcome = await b.input(member, line, locale);
  if (outcome.kind !== "command") throw new Error(`${line} was speech`);
  return outcome.outcome;
}

let serial = 0;
/** One event of the log; `newTurn` opens a turn for it first (a line of speech does). */
function log(b: Bench, kind: string, data: unknown, newTurn = false): void {
  serial += 1;
  const writer = newTurn ? b.store.beginTurn(ROOM) : b.store.writer(ROOM);
  writer.appendEvent({ id: `seed-${serial}`, ts: 1_764_240_000_000 + serial * 1000, kind, turn: writer.turn, data });
}

function play(b: Bench): void {
  log(b, "narrative", { speaker: "player", name: "Ada", member: ADA.id, text: "I search the cellar.", format: "plain" }, true);
  log(b, "dice", { actor: "Ada", kind: "check", expr: "1d100", rolls: [12], total: 12, target: 50, outcome: { id: "hard", label: "Hard success", success: true, critical: false, fumble: false, tier: 3 }, detail: { skill: "Spot Hidden" } });
  log(b, "narrative", { speaker: "kp", text: "Behind the shelf, a **door**.", format: "markdown" });
}

function seedSecrets(b: Bench): void {
  seedLore(b);
  seedNpc(b);
  seedVariables(b);
  seedChronicle(b);
}

interface PageData {
  readonly format: string;
  readonly edition: "player" | "reveal";
  readonly media: { readonly hash: string; readonly mime: string; readonly size: number; readonly name: string };
}

async function page(b: Bench, hash: string, role: Member["role"]): Promise<string | null> {
  const found = await b.uploads?.media.read(ROOM, hash, role);
  return found === undefined ? null : new TextDecoder().decode(found.bytes);
}

test("the scoreboard: in the caller's result, in their language, no event, nothing stored", async () => {
  const b = bench({ media: true });
  play(b);
  const out = ok(await typed(b, ADA, ".report"));
  expect(out.events).toEqual([]);
  expect(out.text).toContain("Ada");
  expect(out.text).toContain("Checks 1/1 passed");
  expect(out.text).not.toContain("cellar");
  expect(out.data).toMatchObject({ format: "text", turns: 1, lines: 2 });
  expect(ok(await typed(b, ADA, ".团报", "zh")).text).toContain("检定 1/1 成功");
  // An observer may read it; it is the table's own record.
  expect(ok(await typed(b, EVE, ".report")).text).toContain("Ada");
  expect(b.store.stateGet(ROOM, REPORT_PAGES)).toBeNull();
});

test("the HTML page: an unlisted file of the room, its reference in the caller's result alone", async () => {
  const b = bench({ media: true });
  play(b);
  seedSecrets(b);
  const out = ok(await typed(b, ADA, ".report html"));
  expect(out.events).toEqual([]);
  expect(out.signals).toEqual([]);
  const data = out.data as PageData;
  expect(data).toMatchObject({ format: "html", edition: "player", media: { mime: "text/html" } });
  expect(data.media.name.endsWith(".html")).toBe(true);
  expect(out.text).toContain(data.media.name);
  // Not room media anyone is shown; any member who has the reference may fetch it.
  expect(b.uploads?.media.list(ROOM)).toEqual([]);
  const html = await page(b, data.media.hash, "player");
  expect(html).not.toBeNull();
  expect(html?.includes("I search the cellar.")).toBe(true);
  expect(html?.includes("<strong>door</strong>")).toBe(true);
  expect(html?.includes("Hard success")).toBe(true);
  // The player edition reads no document: nothing of the seeded secrets is in it.
  for (const marker of Object.values(SECRET)) expect([marker, html?.includes(marker)]).toEqual([marker, false]);
  // The structured form is the same command.
  const again = ok(await b.registry.run(b.context(ADA), "report", { format: "html" }, "zh"));
  expect((again.data as PageData).edition).toBe("player");
  expect((await page(b, (again.data as PageData).media.hash, "player"))?.includes("玩家版")).toBe(true);
});

test("the reveal edition: an admin's alone, stored for admins, holding what a player's view does not", async () => {
  const b = bench({ media: true });
  play(b);
  seedSecrets(b);
  for (const line of [".report html reveal", ".report reveal", ".团报 复盘"]) expect([line, code(await typed(b, ADA, line))]).toEqual([line, "forbidden"]);
  expect(code(await b.registry.run(b.context(ADA), "report", { reveal: true }, "en"))).toBe("forbidden");
  expect(code(await typed(b, EVE, ".report reveal"))).toBe("forbidden");
  expect(b.store.stateGet(ROOM, REPORT_PAGES)).toBeNull();

  const out = ok(await typed(b, ADMIN, ".report html reveal"));
  const data = out.data as PageData;
  expect(data.edition).toBe("reveal");
  expect(out.events).toEqual([]);
  // The hash is of no use to a player: the file is stored for admins.
  expect(await page(b, data.media.hash, "player")).toBeNull();
  expect(await page(b, data.media.hash, "observer")).toBeNull();
  const html = (await page(b, data.media.hash, "admin")) ?? "";
  for (const marker of [SECRET.lore, SECRET.loreTitle, SECRET.npcAgenda, SECRET.npcFact, SECRET.variable, SECRET.recordKeeper, SECRET.summaryMargin]) {
    expect([marker, html.includes(marker)]).toEqual([marker, true]);
  }
  // What the table already sees is not printed as a secret: the open lore entry, the exposed leaf.
  expect(html.includes("A town by the river.")).toBe(false);
  expect(html.includes("stats.hp")).toBe(false);
  expect(html.includes("plot.ending")).toBe(true);
});

test("a new page replaces the last of its edition; the other edition's stays", async () => {
  const b = bench({ media: true });
  play(b);
  const first = (ok(await typed(b, ADA, ".report html")).data as PageData).media.hash;
  const reveal = (ok(await typed(b, ADMIN, ".report reveal")).data as PageData).media.hash;
  log(b, "narrative", { speaker: "player", name: "Ada", member: ADA.id, text: "I open the door.", format: "plain" }, true);
  const second = (ok(await typed(b, ADA, ".report html")).data as PageData).media.hash;
  expect(second).not.toBe(first);
  expect(await page(b, first, "player")).toBeNull();
  expect(await page(b, second, "player")).not.toBeNull();
  expect(await page(b, reveal, "admin")).not.toBeNull();
  expect(b.store.stateGet(ROOM, REPORT_PAGES)).toEqual({ player: second, reveal });
  // The same log printed again in the same minute is the same file: nothing is removed.
  expect((ok(await typed(b, ADA, ".report html")).data as PageData).media.hash).toBe(second);
  expect(await page(b, second, "player")).not.toBeNull();
});

test("refusals: an unknown word; a server that keeps no files still gives the scoreboard", async () => {
  const b = bench();
  play(b);
  expect(code(await typed(b, ADA, ".report pdf"))).toBe("usage");
  expect(code(await typed(b, ADA, ".report html"))).toBe("report_no_files");
  expect(ok(await typed(b, ADA, ".report")).text).toContain("Ada");
  expect(MAX_REPORT_EVENTS).toBeGreaterThan(1000);
});

test("a log longer than one page of the store is read whole", async () => {
  const b = bench({ media: true });
  for (let index = 0; index < 1205; index += 1) log(b, "narrative", { speaker: "player", name: "Ada", member: ADA.id, text: `line ${index}`, format: "plain" }, true);
  expect(ok(await typed(b, ADA, ".report")).data).toMatchObject({ lines: 1205, turns: 1205 });
});
