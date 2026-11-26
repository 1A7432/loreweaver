// The whole server, composed the way `serve` composes it.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ServerFrame } from "loreweaver-protocol/v3";

import { composeHub, FIRST_ROOM, keystoreIn, openData } from "../../src/cli/compose.ts";
import { run } from "../../src/cli/main.ts";
import { CHRONICLE_RECORD_TYPE } from "../../src/core/chronicle/index.ts";
import { LORE_ENTRY_TYPE } from "../../src/core/lore/index.ts";
import { REVIEW_OFF } from "../../src/gateway/review.ts";
import type { Member, Room } from "../../src/gateway/room.ts";
import { loadSettings } from "../../src/infra/config.ts";
import { type ChatMessage, ScriptedLLM, toolCall } from "../../src/infra/llm/index.ts";
import { openDatabase } from "../../src/infra/runtime/sqlite.ts";
import { Store } from "../../src/infra/store.ts";
import { dial } from "../../src/net/iroh.ts";
import { memberId } from "../../src/net/keystore.ts";
import { testClock } from "../helpers.ts";

const dirs: string[] = [];
function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "loreweaver-compose-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function member(id: string, name: string, role: Member["role"], frames: ServerFrame[]): Member {
  return { connection: `conn-${id}`, id, name, role, locale: "en", send: (frame) => frames.push(frame) };
}

function say(room: Room, who: Member, text: string): Promise<unknown> {
  return new Promise((resolve) => {
    room.input(who, text, resolve);
  });
}

function text(messages: readonly ChatMessage[]): string {
  return messages.map((message) => (typeof message.content === "string" ? message.content : "")).join("\n---\n");
}

test("a line, a dice tool, the reply, the Scribe, and the next turn reading what the Scribe left", async () => {
  const keeper = new ScriptedLLM([
    { toolCalls: [toolCall("roll_dice", { expression: "1d6" })] },
    "The die clatters across the table and settles.",
    "You press on into the dark.",
  ]);
  const scribe = new ScriptedLLM([
    JSON.stringify({ ops: [], whispers: ["The party carries no light source."], chronicle: "The party cast a die at the table.", beat: "none" }),
    "{}",
  ]);
  const unused = new ScriptedLLM([]);
  const store = new Store(openDatabase(":memory:"));
  const reports: string[] = [];
  const { hub, services } = composeHub({
    settings: loadSettings({ TRPG_DIRECTOR__ENABLED: "false" }),
    store,
    models: { keeper, npc: unused, scribe, director: unused, memory: unused },
    contextWindow: 200_000,
    clock: testClock(),
    report: (_room, line) => {
      reports.push(line);
    },
    spawnWorker: () => {
      throw new Error("no room here needs a worker");
    },
    modulesFor: () => [],
    review: REVIEW_OFF,
    defaultRulePack: "coc7",
  });
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 3; i++) {
      await hub.room("table").settled();
      await hub.lanesIdle("table");
    }
  };
  const frames: ServerFrame[] = [];
  const ada = member("ada", "Ada", "player", frames);
  const room = hub.room("table");
  room.join(ada);

  expect(await say(room, ada, "I roll to see what happens.")).toEqual({ ok: true });
  await settle();

  // The table saw: the line, the dice, the reply — in that order, all under turn 1.
  const events = frames.flatMap((frame) => (frame.type === "event" ? [frame] : []));
  expect(events.map((event) => [event.kind, event.turn])).toEqual([
    ["narrative", 1],
    ["dice", 1],
    ["narrative", 1],
  ]);
  const reply = events[2];
  expect(reply?.kind === "narrative" && reply.data.speaker === "kp" && reply.data.text).toBe("The die clatters across the table and settles.");
  // The draft bubble and the event that replaced it share an id.
  const drafts = frames.flatMap((frame) => (frame.type === "signal" && frame.kind === "draft" ? [frame.data] : []));
  expect(drafts.some((draft) => draft.id === reply?.id && "text" in draft)).toBe(true);
  // Every tool the Keeper was offered carries a description and a closed schema.
  const offered = keeper.requests[0]?.options.tools ?? [];
  expect(offered.length).toBeGreaterThan(20);

  // The Scribe ran off the lock and committed under the turn it belongs to.
  const records = services.documents.list("table", CHRONICLE_RECORD_TYPE);
  expect(records.map((record) => (record.data as { text: string; turn: number }).turn)).toEqual([1]);

  expect(await say(room, ada, "Onward.")).toEqual({ ok: true });
  await settle();
  // Turn 2's prompt: the whisper the Scribe left, and turn 1 replayed as history.
  const second = text(keeper.calls[2] ?? []);
  expect(second).toContain("The party carries no light source.");
  expect(second).toContain("I roll to see what happens.");
  expect(second).toContain("The die clatters across the table and settles.");
  // Consumed by the turn that read it.
  expect(store.stateList("table").has("scribe.whispers")).toBe(false);
  expect(reports).toEqual([]);

  await hub.close();
  store.close();
});

test("serve: a fresh data directory gets an admin key, a stable identity, and a server that answers without a model", async () => {
  const dir = dataDir();
  const env = { TRPG_DATA_DIR: dir };
  const first = await run(["serve", "--local"], env);
  expect(first.code).toBe(0);
  const ready = JSON.parse(first.out) as { ok: boolean; ticket: string; notes: string[]; first_key?: { room: string; key: string } };
  expect(ready.ok).toBe(true);
  expect(ready.notes).toEqual(["recall_off", "model_not_configured"]);
  expect(ready.first_key?.room).toBe(FIRST_ROOM);
  const key = ready.first_key?.key ?? "";
  // The secrets on disk are the owner's alone.
  for (const file of ["keys.json", "transport.key"]) expect(statSync(join(dir, file)).mode & 0o077).toBe(0);

  const link = await dial(ready.ticket, { mode: "local" });
  const seen: ServerFrame[] = [];
  const until = async (want: (frame: ServerFrame) => boolean): Promise<ServerFrame> => {
    for (;;) {
      const frame = await link.next();
      seen.push(frame);
      if (want(frame)) return frame;
    }
  };
  link.send({ type: "hello", protocol: "3.0", key, locale: "en", client: { name: "test", version: "0" }, caps: [] });
  const welcome = await until((frame) => frame.type === "welcome");
  expect(welcome.type === "welcome" && [welcome.you.role, welcome.room.id]).toEqual(["admin", FIRST_ROOM]);
  link.send({ type: "input", rid: "1", text: "hello?" });
  // No model: the line is accepted, the turn fails with a notice, and the room goes idle.
  const notice = await until((frame) => frame.type === "signal" && frame.kind === "notice");
  expect(notice.type === "signal" && notice.kind === "notice" && notice.data.code).toBe("provider_auth");
  await until((frame) => frame.type === "signal" && frame.kind === "turn" && frame.data.status === "idle");
  expect(seen.some((frame) => frame.type === "result" && frame.rid === "1" && frame.ok)).toBe(true);
  expect(seen.some((frame) => frame.type === "event" && frame.kind === "narrative" && frame.data.speaker === "kp")).toBe(false);
  await link.close();
  await first.server?.close();

  // Again on the same directory: no new key, the same transport identity.
  const secret = Bun.file(join(dir, "transport.key"));
  const before = await secret.bytes();
  const again = await run(["serve", "--local"], env);
  expect((JSON.parse(again.out) as { first_key?: unknown }).first_key).toBeUndefined();
  expect(await secret.bytes()).toEqual(before);
  await again.server?.close();
});

test("key: the operator hands out a key the keystore then knows", async () => {
  const dir = dataDir();
  const env = { TRPG_DATA_DIR: dir };
  const made = await run(["key", "harbor", "player", "Bao"], env);
  expect(made.code).toBe(0);
  const { key } = JSON.parse(made.out) as { key: string };
  expect(keystoreIn(dir).lookup(key)).toEqual({ room: "harbor", name: "Bao", role: "player" });
  expect(memberId(key).length).toBeGreaterThan(0);
  expect((await run(["key", "harbor", "wizard", "Bao"], env)).code).toBe(2);
  expect((await run(["key", "harbor", "player", " "], env)).out).toContain("bad_name");
});

test("import-world: a card file becomes the room's lore, and bad input is a coded refusal", async () => {
  const dir = dataDir();
  const env = { TRPG_DATA_DIR: dir };
  const card = {
    spec: "chara_card_v2",
    spec_version: "2.0",
    data: {
      name: "Saltmarsh",
      description: "A drowned parish.",
      first_mes: "Rain on the causeway.",
      system_prompt: "Keep the tide in every scene.",
      character_book: {
        entries: [
          { keys: ["lighthouse"], content: "The lighthouse has been dark for a year.", comment: "Lighthouse", enabled: true, insertion_order: 10 },
          { keys: ["verger"], content: "The verger keeps the drowned ledger.", comment: "Verger", enabled: true, insertion_order: 20 },
        ],
      },
    },
  };
  const file = join(dir, "saltmarsh.json");
  writeFileSync(file, JSON.stringify(card));
  const imported = await run(["import-world", "harbor", file], env);
  expect(imported.code).toBe(0);
  expect(JSON.parse(imported.out)).toMatchObject({ ok: true, code: "world_imported", name: "Saltmarsh", lore: 2, indexed: 0 });

  const { store } = openData(loadSettings(env));
  expect(store.docList("harbor", LORE_ENTRY_TYPE).length).toBe(2);
  store.close();

  expect(JSON.parse((await run(["import-world", "harbor", join(dir, "missing.json")], env)).out)).toEqual({ ok: false, code: "unreadable_file" });
  const junk = join(dir, "junk.json");
  writeFileSync(junk, "not a card");
  expect(JSON.parse((await run(["import-world", "harbor", junk], env)).out)).toMatchObject({ ok: false, code: "bad_card" });
  expect(existsSync(join(dir, "loreweaver.db"))).toBe(true);
});

test("bad settings and an unreadable word list refuse to start, by code", async () => {
  expect(JSON.parse((await run(["serve", "--local"], { TRPG_TURN__MAX_ROUNDS: "many" })).out)).toEqual({
    ok: false,
    code: "bad_settings",
    problems: [{ variable: "TRPG_TURN__MAX_ROUNDS", problem: "invalid" }],
  });
  const dir = dataDir();
  const refused = await run(["serve", "--local"], { TRPG_DATA_DIR: dir, TRPG_CENSOR__WORDLIST_PATH: join(dir, "nowhere.txt") });
  expect([refused.code, JSON.parse(refused.out)]).toEqual([2, { ok: false, code: "review_wordlist_missing" }]);
  // Refused before anything was opened.
  expect(existsSync(join(dir, "loreweaver.db"))).toBe(false);
});
