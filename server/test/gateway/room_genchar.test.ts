// `genchar` and a player's character import at the room: the model call holds up nothing
// (the room goes on taking commands and speech while it is in flight), the character reaches
// the caller's `me` view, the table hears one line; a card import reads the persona through
// the same lane, with nothing of the card's world machinery in what the model is sent, and
// falls back to a plainly rolled sheet when there is no usable answer; the hourly cap is
// shared.
import { afterEach, describe, expect, test } from "bun:test";

import type { ResultFrame, ServerFrame } from "loreweaver-protocol/v3";

import { CHARACTER_TYPE } from "../../src/core/characters/index.ts";
import { tableGet } from "../../src/core/sheets/index.ts";
import { GENCHAR_PER_HOUR } from "../../src/gateway/commands/engine/genchar.ts";
import { ScriptedLLM } from "../../src/infra/llm/index.ts";
import { memberId } from "../../src/net/keystore.ts";
import type { Wire } from "../helpers.ts";
import { jsonFile, MK, sha256, upload, worldCard } from "./card_files.ts";
import { events, gate, KEYS, resultFor, ROOM, RoomBench, type BenchOptions, views } from "./room_bench.ts";

const CAPTAIN = JSON.stringify({ occupation: "Sea captain", attribute_emphasis: ["CON"], signature_skills: ["rifle"], backstory: "Thirty years at sea." });
const ADA = { id: memberId(KEYS.ada), role: "player" as const };

const benches: RoomBench[] = [];
afterEach(async () => {
  await Promise.all(benches.splice(0).map((b) => b.close()));
});

function setup(options: BenchOptions = {}): RoomBench {
  const b = new RoomBench({ media: true, ...options });
  benches.push(b);
  return b;
}

function isResult(rid: string): (frame: ServerFrame) => boolean {
  return (frame) => frame.type === "result" && frame.rid === rid;
}

async function send(wire: Wire, rid: string, text: string): Promise<ResultFrame> {
  wire.receive({ type: "input", rid, text });
  return (await wire.until(isResult(rid))) as ResultFrame;
}

function narratives(frames: readonly ServerFrame[]): string[] {
  return events(frames).flatMap((frame) => (frame.kind === "narrative" ? [frame.data.text] : []));
}

function storedSheet(b: RoomBench, id: string): { fields: [string, unknown][]; skills: [string, number][]; background: string } {
  const row = b.store.docGet(ROOM, CHARACTER_TYPE, id);
  if (row === null) throw new Error(`no character ${id}`);
  return (JSON.parse(row.data) as { sheet: { fields: [string, unknown][]; skills: [string, number][]; background: string } }).sheet;
}

describe("genchar", () => {
  test("a slow model holds up nothing; the character reaches `me`; the table hears one line", async () => {
    const slow = gate();
    const model = new ScriptedLLM(async () => {
      await slow.promise;
      return CAPTAIN;
    });
    const b = setup({ keeperModel: model });
    const ada = b.join(KEYS.ada);
    const bao = b.join(KEYS.bao);
    ada.receive({ type: "call", rid: "sub", method: "view.subscribe", params: { names: ["me"] } });
    await ada.until(isResult("sub"));
    const baoBefore = bao.sent.length;
    ada.receive({ type: "input", rid: "g", text: ".genchar Ada Lin | a retired sea captain, good with a rifle" });
    // A command and a line of speech, both answered while the model is still thinking.
    expect(await send(bao, "r", ".r 1d6")).toMatchObject({ ok: true });
    expect(await send(bao, "s", "I wait on the quay.")).toMatchObject({ ok: true });
    await b.settled();
    expect(b.keeper.calls).toHaveLength(1);
    expect(model.calls).toHaveLength(1);
    expect(resultFor(ada.sent, "g")).toBeUndefined();
    slow.open();
    const answer = await ada.until(isResult("g"));
    expect(answer).toMatchObject({ ok: true, data: { name: "Ada Lin", system: "coc7" } });
    await b.settled();
    const me = views(ada.sent, "me").at(-1)?.data as { character: { name: string; pack: string } | null };
    expect(me.character).toMatchObject({ name: "Ada Lin", pack: "coc7" });
    expect(narratives(bao.sent.slice(baoBefore)).filter((text) => text.includes("Ada Lin"))).toEqual(["Ada made a new character: Ada Lin (coc7)."]);
    // The sheet itself is not the table's.
    expect(JSON.stringify(bao.sent.slice(baoBefore))).not.toContain("Thirty years at sea");
  });
});

describe("a player's character import", () => {
  test("the persona read through the lane: the sheet biased, nothing of the card's machinery sent to the model", async () => {
    const model = new ScriptedLLM(() => CAPTAIN);
    const b = setup({ keeperModel: model });
    const ada = b.join(KEYS.ada);
    const card = jsonFile(worldCard("Mira"));
    await upload(b.uploads!, ROOM, ADA, card, "application/json");
    const answer = await send(ada, "imp", `.import character ${sha256(card)}`);
    expect(answer).toMatchObject({ ok: true, data: { code: "character_imported", name: "Mira", concept: "applied" } });
    expect(model.calls).toHaveLength(1);
    const sent = JSON.stringify(model.calls[0]);
    expect(sent).toContain("A city under the sea");
    for (const mark of Object.values(MK)) expect(sent).not.toContain(mark);
    const sheet = storedSheet(b, (answer as { data: { characterId: string } }).data.characterId);
    expect(tableGet(sheet.fields, "occupation")).toBe("Sea captain");
    expect(tableGet(sheet.skills, "步霰")).toBe(60);
    expect(sheet.background).toBe("Thirty years at sea.");
  });

  test("no usable answer: the sheet is rolled without the persona, and the caller is told", async () => {
    const b = setup({ keeperModel: new ScriptedLLM(() => "no JSON here") });
    const ada = b.join(KEYS.ada);
    const card = jsonFile(worldCard("Mira"));
    await upload(b.uploads!, ROOM, ADA, card, "application/json");
    const answer = await send(ada, "imp", `.import character ${sha256(card)}`);
    expect(answer).toMatchObject({ ok: true, data: { concept: "unusable" } });
    expect((answer as { text: string }).text).toContain("rolled without it");
    const sheet = storedSheet(b, (answer as { data: { characterId: string } }).data.characterId);
    expect(tableGet(sheet.fields, "occupation")).toBe("");
    expect(sheet.background).toContain("A city under the sea");
  });

  test("the hourly cap is shared with genchar: over it, the import still seats a rolled sheet without a call", async () => {
    const model = new ScriptedLLM(() => CAPTAIN);
    const b = setup({ keeperModel: model });
    const ada = b.join(KEYS.ada);
    for (let index = 0; index < GENCHAR_PER_HOUR; index++) expect(await send(ada, `g${index}`, `.genchar Ada ${index} | a sailor`)).toMatchObject({ ok: true });
    const card = jsonFile(worldCard("Mira"));
    await upload(b.uploads!, ROOM, ADA, card, "application/json");
    const answer = await send(ada, "imp", `.import character ${sha256(card)}`);
    expect(answer).toMatchObject({ ok: true, data: { name: "Mira", concept: "rate_limited" } });
    expect((answer as { text: string }).text).toContain("hourly limit");
    expect(model.calls).toHaveLength(GENCHAR_PER_HOUR);
  });
});
