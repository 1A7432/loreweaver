// A host's two jobs from a client, against a real room: switching the model (server-wide,
// taking effect for the next turn while a turn in flight finishes on the clients it started
// with) and handing out access keys (this room's only; a revoked key's connection ends and
// cannot come back). And the secrets they carry: a key typed in chat reaches no event, no
// log page, no view, no report, no record the Keeper reads, and comes back only masked.
import { afterEach, describe, expect, test } from "bun:test";

import type { ResultFrame, ServerFrame, ViewFrame } from "loreweaver-protocol/v3";

import { ModelSettings } from "../../src/gateway/model_settings.ts";
import { type LLMSettings, ScriptedLLM } from "../../src/infra/llm/index.ts";
import { openDatabase } from "../../src/infra/runtime/sqlite.ts";
import { maskSecret, ServerSettings } from "../../src/infra/server_settings.ts";
import { keyId } from "../../src/net/keystore.ts";
import type { Wire } from "../helpers.ts";
import { schemaProblems } from "./views/schema_check.ts";
import { BUILT_IN_VIEW_SCHEMAS } from "loreweaver-protocol/v3";
import { events, gate, KEYS, reply, resultFor, RoomBench, ROOM, views } from "./room_bench.ts";

const ENV_KEY = "sk-env-openai-0123456789";
/** A key no output may ever carry whole. */
const SENTINEL = "sk-SENTINEL-c0ffee-0123456789abcdef";
const SENTINEL_IMAGE = "sk-IMAGESENTINEL-0123456789abcdef";

const benches: RoomBench[] = [];
afterEach(async () => {
  await Promise.all(benches.splice(0).map((bench) => bench.close()));
});

/** A bench whose model clients are scripted per provider: each turn's call shows which one it reached. */
function setup(): { b: RoomBench; models: ModelSettings; clients: Map<string, ScriptedLLM> } {
  const clients = new Map<string, ScriptedLLM>();
  const llm = (settings: LLMSettings) => {
    const name = settings.preset ?? settings.baseUrl ?? "?";
    const client = new ScriptedLLM(() => `answer from ${name}`);
    clients.set(name, client);
    return { client, contextWindow: settings.model === "deepseek-v4-pro" ? 1_000_000 : 200_000 };
  };
  const models = new ModelSettings({ llm: { preset: "openai", apiKey: ENV_KEY, model: "gpt-5.5" }, lanes: {} }, new ServerSettings(openDatabase(":memory:")), { llm, image: () => ({ generate: () => Promise.reject(new Error("no")) }) });
  const b = new RoomBench({ models });
  b.keystore.add("elsewhere-admin-key", { room: "elsewhere", name: "Zed", role: "admin" });
  benches.push(b);
  return { b, models, clients };
}

function isResult(rid: string): (frame: ServerFrame) => boolean {
  return (frame) => frame.type === "result" && frame.rid === rid;
}

async function run(wire: Wire, rid: string, id: string, args: Record<string, unknown>): Promise<ResultFrame> {
  wire.receive({ type: "call", rid, method: "command.run", params: { id, args } });
  return (await wire.until(isResult(rid))) as ResultFrame;
}

async function send(wire: Wire, rid: string, text: string): Promise<ResultFrame> {
  wire.receive({ type: "input", rid, text });
  return (await wire.until(isResult(rid))) as ResultFrame;
}

async function subscribe(wire: Wire, rid: string, names: string[]): Promise<ResultFrame> {
  wire.receive({ type: "call", rid, method: "view.subscribe", params: { names } });
  return (await wire.until(isResult(rid))) as ResultFrame;
}

function lastView(wire: Wire, name: string): ViewFrame | undefined {
  return views(wire.sent, name).at(-1);
}

describe("switching the model", () => {
  test("the next turn talks to the new client; a turn in flight finishes on the one it started with; the switch does not wait for it", async () => {
    const { b, models } = setup();
    const root = b.join(KEYS.root);
    const ada = b.join(KEYS.ada);
    const held = gate();
    const answers: string[] = [];
    b.keeper.next(
      async (call) => {
        await held.promise;
        const answer = await call.context.services.models.keeper.chat([{ role: "user", content: "hi" }]);
        answers.push(`${answer.content} @${call.env.settings.contextWindow}`);
        return reply(call, answer.content);
      },
      async (call) => {
        const answer = await call.context.services.models.keeper.chat([{ role: "user", content: "again" }]);
        const npc = await call.context.services.models.npc.chat([{ role: "user", content: "npc" }]);
        answers.push(`${answer.content} @${call.env.settings.contextWindow}`, `npc: ${npc.content}`);
        return reply(call, answer.content);
      },
    );
    await send(ada, "a1", "I open the door.");
    await Bun.sleep(5);
    expect(b.keeper.calls).toHaveLength(1);
    // The turn is suspended; the switch answers at once.
    const switched = await run(root, "s", "model", { op: "set", provider: "deepseek", model: "deepseek-v4-pro", key: SENTINEL });
    expect(switched).toMatchObject({ ok: true, data: { lane: { provider: "deepseek", model: "deepseek-v4-pro", key: { masked: maskSecret(SENTINEL) } }, keySaved: true } });
    expect(models.snapshot().contextWindow).toBe(1_000_000);
    held.open();
    await b.settled();
    await send(ada, "a2", "And again.");
    await b.settled();
    expect(answers).toEqual(["answer from openai @200000", "answer from deepseek @1000000", "npc: answer from deepseek"]);
  });

  test("reset brings the environment's model back for the next turn; a player is shown the catalog and refused the rest", async () => {
    const { b } = setup();
    const root = b.join(KEYS.root);
    const ada = b.join(KEYS.ada);
    await run(root, "s", "model", { op: "set", provider: "deepseek", model: "deepseek-v4-pro" });
    expect(await run(root, "r", "model", { op: "reset" })).toMatchObject({ ok: true, data: { reset: ["keeper"], keeper: { source: "environment", provider: "openai" } } });
    const seen: string[] = [];
    b.keeper.next(async (call) => {
      seen.push((await call.context.services.models.keeper.chat([{ role: "user", content: "x" }])).content);
      return reply(call, "ok");
    });
    await send(ada, "a", "Hello.");
    await b.settled();
    expect(seen).toEqual(["answer from openai"]);

    expect(await run(ada, "c", "model", { op: "list" })).toMatchObject({ ok: true, data: { providers: ["openai", "anthropic", "deepseek", "openrouter", "moonshot"] } });
    for (const [rid, args] of [
      ["p1", { op: "show" }],
      ["p2", { op: "set", provider: "deepseek", model: "x" }],
      ["p3", { op: "list", provider: "openai" }],
      ["p4", { op: "reset" }],
    ] as const) {
      expect(await run(ada, rid, "model", args)).toMatchObject({ ok: false, error: { code: "forbidden" } });
    }
    expect(await run(ada, "p5", "imagegen", { op: "show" })).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });
});

describe("a key typed in chat", () => {
  test("is in no event, log page, view, report, recorded action or stored state; the answers show it masked", async () => {
    const { b } = setup();
    const root = b.join(KEYS.root);
    const ada = b.join(KEYS.ada);
    await subscribe(root, "v", ["admin/model", "party", "commands"]);
    await subscribe(ada, "v", ["party", "me"]);
    const typed = [
      await send(root, "t1", `.model key ${SENTINEL}`),
      await send(root, "t2", `.model set deepseek deepseek-v4-pro key=${SENTINEL} lane=scribe`),
      await send(root, "t3", `.模型 key ${SENTINEL} lane=npc`),
      await run(root, "t4", "imagegen", { op: "set", provider: "openai", model: "gpt-image-2", key: SENTINEL_IMAGE }),
      await send(root, "t5", `.imagegen set openai gpt-image-2 1536x1024 key=${SENTINEL_IMAGE}`),
      await send(root, "t6", ".model"),
      await send(root, "t7", ".imagegen"),
      // A player's attempt is refused and is not speech either.
      await send(ada, "t8", `.model key ${SENTINEL}`),
      // A malformed line is refused with its usage, not said at the table.
      await send(root, "t9", `.model key ${SENTINEL} extra`),
    ];
    await b.settled();
    expect(typed.slice(0, 7).every((frame) => frame.ok)).toBe(true);
    expect(typed[7]).toMatchObject({ ok: false, error: { code: "forbidden" } });
    expect(typed[8]).toMatchObject({ ok: false, error: { code: "usage" } });
    const shown = JSON.stringify(typed);
    expect(shown).toContain(maskSecret(SENTINEL));
    expect(shown).toContain(maskSecret(SENTINEL_IMAGE));

    const everywhere = JSON.stringify({
      results: typed,
      root: root.sent,
      ada: ada.sent,
      log: b.store.eventsAfter(ROOM, 0, 10_000),
      state: [...b.store.stateList(ROOM)],
      reports: b.reports,
      actions: b.actions,
    });
    for (const secret of [SENTINEL, SENTINEL_IMAGE]) expect(everywhere).not.toContain(secret);
    // Nothing reached the table: no event at all.
    expect(events(root.sent)).toEqual([]);
    expect(b.store.eventsAfter(ROOM, 0, 100)).toEqual([]);
    // log.page answers the same.
    root.receive({ type: "call", rid: "page", method: "log.page", params: { before: 1_000_000, limit: 100 } });
    const page = await root.until(isResult("page"));
    expect(JSON.stringify(page)).not.toContain(SENTINEL);
    // The admin's view follows, masked.
    const model = lastView(root, "admin/model");
    expect(model?.data).toMatchObject({ lanes: expect.arrayContaining([expect.objectContaining({ lane: "npc", source: "override", key: { set: true, masked: maskSecret(SENTINEL) } })]) });
  });
});

describe("access keys", () => {
  test("mint once to the caller, list, rename, change a role (ending the holder's connection), revoke (ending it for good)", async () => {
    const { b } = setup();
    const root = b.join(KEYS.root);
    const ada = b.join(KEYS.ada);
    await subscribe(root, "v", ["admin/keys"]);
    const minted = await run(root, "m", "key", { op: "mint", name: "Cleo", role: "player" });
    expect(minted.ok).toBe(true);
    const { key, id } = (minted.ok ? minted.data : {}) as { key: string; id: string };
    expect(typeof key).toBe("string");
    expect(id).toBe(keyId(key));
    // Only the caller ever sees it.
    expect(JSON.stringify(ada.sent)).not.toContain(key);
    expect(JSON.stringify(b.store.eventsAfter(ROOM, 0, 1000))).not.toContain(key);
    expect(JSON.stringify(views(root.sent))).not.toContain(key);

    const cleo = b.join(key);
    await cleo.until((frame) => frame.type === "welcome");
    await b.settled();
    const listed = lastView(root, "admin/keys")?.data as { keys: { id: string; name: string; role: string; masked: string; online: boolean; created?: number }[] };
    expect(listed.keys.map((each) => [each.name, each.role, each.online])).toEqual([
      ["Ada", "player", true],
      ["Bao", "player", false],
      ["Root", "admin", true],
      ["Eve", "observer", false],
      ["Cleo", "player", true],
    ]);
    expect(listed.keys.find((each) => each.name === "Cleo")).toMatchObject({ id, masked: maskSecret(key) });
    expect(typeof listed.keys.find((each) => each.name === "Cleo")?.created).toBe("number");
    expect(schemaProblems(BUILT_IN_VIEW_SCHEMAS["admin/keys"] as Record<string, unknown>, listed)).toEqual([]);
    // Zed's key is another room's: never listed here.
    expect(JSON.stringify(listed)).not.toContain("Zed");

    expect(await send(root, "rn", `.key rename ${id} Cleo the Bold`)).toMatchObject({ ok: true, data: { name: "Cleo the Bold" } });
    expect(await send(root, "rl", `.key role ${id} observer`)).toMatchObject({ ok: true, data: { role: "observer", changed: true } });
    expect(cleo.closed).toBe(true);
    // Back with the new role.
    const again = b.join(key);
    const welcome = await again.until((frame) => frame.type === "welcome");
    expect(welcome.type === "welcome" && welcome.you.role).toBe("observer");

    expect(await run(root, "rv", "key", { op: "revoke", id })).toMatchObject({ ok: true, data: { id, revoked: true } });
    expect(again.closed).toBe(true);
    await b.settled();
    expect((lastView(root, "admin/keys")?.data as { keys: { id: string }[] }).keys.map((each) => each.id)).not.toContain(id);
    const locked = b.join(key);
    const refused = await locked.until((frame) => frame.type === "error");
    expect(refused).toMatchObject({ type: "error", code: "bad_key", fatal: true });
  });

  test("the last admin key stays; another room's keys are untouchable; a player is refused and never sees admin views", async () => {
    const { b } = setup();
    const root = b.join(KEYS.root);
    const ada = b.join(KEYS.ada);
    const rootId = keyId(KEYS.root);
    expect(await run(root, "1", "key", { op: "revoke", id: rootId })).toMatchObject({ ok: false, error: { code: "last_admin" } });
    expect(await run(root, "2", "key", { op: "role", id: rootId, role: "player" })).toMatchObject({ ok: false, error: { code: "last_admin" } });
    expect(root.closed).toBe(false);
    const zed = keyId("elsewhere-admin-key");
    expect(await run(root, "3", "key", { op: "revoke", id: zed })).toMatchObject({ ok: false, error: { code: "unknown_key_id" } });
    expect(await run(root, "4", "key", { op: "rename", id: zed, name: "Mine" })).toMatchObject({ ok: false, error: { code: "unknown_key_id" } });
    expect(b.keystore.lookup("elsewhere-admin-key")).toEqual({ room: "elsewhere", name: "Zed", role: "admin" });
    expect(await run(root, "5", "key", { op: "list" })).toMatchObject({ ok: true });

    // With a second admin, the first may revoke their own key: answered, then disconnected.
    const second = await run(root, "6", "key", { op: "mint", name: "Root Two", role: "admin" });
    expect(second.ok).toBe(true);
    const self = await run(root, "7", "key", { op: "revoke", id: rootId });
    expect(self).toMatchObject({ ok: true });
    expect(root.closed).toBe(true);

    for (const [rid, args] of [
      ["p1", { op: "list" }],
      ["p2", { op: "mint", name: "Sneaky" }],
    ] as const) {
      expect(await run(ada, rid, "key", args)).toMatchObject({ ok: false, error: { code: "forbidden" } });
    }
    const subscribed = await subscribe(ada, "pv", ["admin/keys", "admin/model", "admin/content"]);
    expect(subscribed).toMatchObject({ ok: true, data: { problems: [{ name: "admin/keys", code: "unknown_view" }, { name: "admin/model", code: "unknown_view" }, { name: "admin/content", code: "unknown_view" }] } });
    ada.receive({ type: "call", rid: "pl", method: "view.list", params: {} });
    const listing = (await ada.until(isResult("pl"))) as ResultFrame;
    expect(JSON.stringify(listing)).not.toContain("admin/");
    ada.receive({ type: "call", rid: "pg", method: "view.get", params: { name: "admin/model" } });
    expect(await ada.until(isResult("pg"))).toMatchObject({ ok: false });
    await b.settled();
    expect(views(ada.sent).filter((frame) => frame.name.startsWith("admin/"))).toEqual([]);
  });
});

describe("admin views", () => {
  test("admin/model and admin/content fit their schemas; admin/model follows a change made in another room", async () => {
    const { b } = setup();
    const root = b.join(KEYS.root);
    await subscribe(root, "v", ["admin/model", "admin/content"]);
    const model = lastView(root, "admin/model");
    expect(schemaProblems(BUILT_IN_VIEW_SCHEMAS["admin/model"] as Record<string, unknown>, model?.data)).toEqual([]);
    const lanes = (model?.data as { lanes: unknown[] }).lanes;
    expect(lanes).toHaveLength(5);
    expect(lanes[0]).toMatchObject({ lane: "keeper", source: "environment", provider: "openai", key: { set: true, masked: maskSecret(ENV_KEY) } });
    expect(lanes[1]).toMatchObject({ lane: "npc", sameAsKeeper: true, source: "default" });
    expect(JSON.stringify(model)).not.toContain(ENV_KEY);
    const content = lastView(root, "admin/content");
    expect(schemaProblems(BUILT_IN_VIEW_SCHEMAS["admin/content"] as Record<string, unknown>, content?.data)).toEqual([]);
    expect((content?.data as { ruleSystems: { id: string; enabled: boolean; source: { kind: string } }[] }).ruleSystems.find((system) => system.id === "coc7")).toEqual(expect.objectContaining({ enabled: true, source: { kind: "builtin", id: null } }));

    const zed = b.join("elsewhere-admin-key");
    await zed.until((frame) => frame.type === "welcome");
    expect(await run(zed, "s", "model", { op: "set", provider: "deepseek", model: "deepseek-v4-pro", key: SENTINEL })).toMatchObject({ ok: true });
    await b.settled();
    await b.hub.room("elsewhere").settled();
    expect((lastView(root, "admin/model")?.data as { lanes: unknown[] }).lanes[0]).toMatchObject({ lane: "keeper", source: "override", provider: "deepseek", key: { masked: maskSecret(SENTINEL) } });
    expect(JSON.stringify(root.sent)).not.toContain(SENTINEL);
    expect(resultFor(root.sent, "s")).toBeUndefined();
  });
});
