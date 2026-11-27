// What a host does from a client instead of the shell: `model` and `imagegen` (the model
// lanes and image generation at run time, server-wide — `gateway/model_settings.ts`) and
// `key` (this room's access keys).
//
// Who may do what, as 2.6's `.model` / `.imagegen` did ("mixed" in the design's table): the
// provider catalog (`model list` with no provider or lane) is anyone's — it names the presets
// this server knows and nothing of how the server is set up; everything else — what the
// server uses, asking a provider for its models, every change — is the room admin's.
// `imagegen` and `key` are the admin's entirely.
//
// Secrets. A key typed here (`model key …`, `model set … key=…`, `imagegen set … key=…`)
// travels in the caller's own input and nowhere else: these commands publish no event (so
// nothing reaches the table, the log, or the record of players' commands the Keeper's
// prompt reads, which keeps only commands with events — `room.ts`), their refusals carry
// codes and never the arguments, and their answers show a key masked. A minted access key is
// in the minting admin's answer once and nowhere else. A client should send these with
// `command.run`, never as a line that could be taken for speech (`docs/protocol.md` §6.9).
//
// None of the three waits for the room's lock (`unlocked`): `model list` waits on the
// network, and a switch or a revoke is the host acting on the server — it must not sit
// behind a five-minute turn. A turn in flight keeps the clients it started with (the room
// pins a snapshot per piece of work); a revoked member's connection ends at once.
import type { Role } from "loreweaver-protocol/v3";

import { PRESETS, type ReasoningEffort, type Wire } from "../../../infra/llm/index.ts";
import { EFFORTS, type LaneInput, MAX_BASE_URL_CHARS, MAX_PROVIDER_CHARS, MAX_SECRET_CHARS, MODEL_LANES, type ModelLane, type ModelSettings, type SettingsRefusal, WIRES } from "../../model_settings.ts";
import { firstWord } from "../parse.ts";
import { BOOLEAN, integer, object, oneOf, text } from "../schema.ts";
import { type Args, type CommandCall, type CommandSpec, type Done, refuse, type Refused } from "../types.ts";

/** A room's access key as its admin sees it (the keystore's `AdminKeyInfo`). */
export interface AdminKey {
  readonly id: string;
  readonly name: string;
  readonly role: Role;
  readonly masked: string;
  readonly member: string;
  readonly created?: number;
}

/**
 * The keystore as this layer reaches it (`net/keystore.ts` `Keystore` has this shape; the
 * gateway may not import the transport layer). Its refusals are thrown as an error named
 * `KeystoreError` with a `problem` code.
 */
export interface KeyBook {
  listForAdmin(room: string): readonly AdminKey[];
  mint(record: { readonly room: string; readonly name: string; readonly role: Role }, created?: number): { readonly key: string; readonly info: { readonly id: string; readonly name: string; readonly role: Role } };
  update(room: string, id: string, change: { name?: string; role?: Role }): { readonly id: string; readonly name: string; readonly role: Role };
  delete(room: string, id: string): void;
  memberOf(room: string, id: string): string | undefined;
}

/** The keys and who is connected (the hub knows the rooms' members). */
export interface KeyAdmin {
  readonly book: KeyBook;
  /** The member ids connected to `room` now. */
  online(room: string): ReadonlySet<string>;
}

const SHOW_WORDS: ReadonlySet<string> = new Set(["show", "status", "info", "查看", "状态", "狀態"]);
const LIST_WORDS: ReadonlySet<string> = new Set(["list", "ls", "providers", "列表", "列出"]);
const SET_WORDS: ReadonlySet<string> = new Set(["set", "use", "switch", "设置", "設置", "切换", "切換"]);
const KEY_WORDS: ReadonlySet<string> = new Set(["key", "apikey", "token", "密钥", "密鑰"]);
const RESET_WORDS: ReadonlySet<string> = new Set(["reset", "clear", "revert", "重置", "清除"]);
const OFF_WORDS: ReadonlySet<string> = new Set(["off", "disable", "关闭", "關閉", "停用"]);
const MINT_WORDS: ReadonlySet<string> = new Set(["mint", "new", "create", "add", "新建", "生成"]);
const RENAME_WORDS: ReadonlySet<string> = new Set(["rename", "name", "改名", "重命名"]);
const ROLE_WORDS: ReadonlySet<string> = new Set(["role", "角色", "身份"]);
const REVOKE_WORDS: ReadonlySet<string> = new Set(["revoke", "delete", "remove", "吊销", "吊銷", "删除", "刪除"]);

const ROLES: readonly Role[] = ["player", "admin", "observer"];
const ROLE_NAMES: ReadonlyMap<string, Role> = new Map([
  ["player", "player"],
  ["玩家", "player"],
  ["admin", "admin"],
  ["管理员", "admin"],
  ["管理員", "admin"],
  ["observer", "observer"],
  ["观察者", "observer"],
  ["觀察者", "observer"],
  ["旁观", "observer"],
  ["旁觀", "observer"],
]);
const LANE_NAMES: ReadonlyMap<string, ModelLane> = new Map([...MODEL_LANES.map((lane) => [lane, lane] as const), ["fold", "memory"]]);

/** A key id as the keystore makes them (`k:` and 12 hex digits). */
const KEY_ID = /^k:[0-9a-f]{12}$/u;
const MAX_MODEL_CHARS = 200;
const MAX_KEY_NAME_CHARS = 64;

/** Whitespace-separated tokens, with `name=value` ones apart (names case-folded). */
function tokens(rest: string): { readonly plain: string[]; readonly named: Map<string, string> } | null {
  const plain: string[] = [];
  const named = new Map<string, string>();
  for (const token of rest.split(/\s+/u).filter((each) => each !== "")) {
    const at = token.indexOf("=");
    if (at <= 0) {
      plain.push(token);
      continue;
    }
    const name = token.slice(0, at).toLowerCase();
    if (named.has(name)) return null;
    named.set(name, token.slice(at + 1));
  }
  return { plain, named };
}

/** A positive whole number in plain digits, as `config.ts` reads one. */
function digits(value: string): number | null {
  return /^[1-9]\d{0,9}$/u.test(value) ? Number(value) : null;
}

function laneOf(value: string | undefined): ModelLane | null | undefined {
  if (value === undefined) return undefined;
  return LANE_NAMES.get(value.toLowerCase()) ?? null;
}

/** The text form of `model`, as an argument object. */
function parseModel(rest: string): Args | Refused {
  const [word, after] = firstWord(rest);
  if (word === "" || SHOW_WORDS.has(word)) return after === "" ? { op: "show" } : refuse("usage");
  const split = tokens(after);
  if (split === null) return refuse("usage");
  const { plain, named } = split;
  const lane = laneOf(named.get("lane"));
  if (lane === null) return refuse("usage");
  const laneArg = lane === undefined ? {} : { lane };
  if (LIST_WORDS.has(word)) {
    if (plain.length > 1 || [...named.keys()].some((name) => name !== "lane")) return refuse("usage");
    return { op: "list", ...laneArg, ...(plain[0] === undefined ? {} : { provider: plain[0] }) };
  }
  if (KEY_WORDS.has(word)) {
    if (plain.length !== 1 || [...named.keys()].some((name) => name !== "lane")) return refuse("usage");
    return { op: "key", key: plain[0] as string, ...laneArg };
  }
  if (RESET_WORDS.has(word)) {
    // `reset scribe` or `reset lane=scribe`.
    const positional = laneOf(plain[0]);
    if (plain.length > 1 || positional === null || named.size > (lane === undefined ? 0 : 1)) return refuse("usage");
    const which = lane ?? positional;
    return { op: "reset", ...(which === undefined ? {} : { lane: which }) };
  }
  if (!SET_WORDS.has(word) || plain.length < 1 || plain.length > 2) return refuse("usage");
  const args: Record<string, unknown> = { op: "set", provider: plain[0], ...laneArg };
  if (plain[1] !== undefined) args.model = plain[1];
  for (const [name, value] of named) {
    if (name === "lane") continue;
    if (name === "key") args.key = value;
    else if (name === "base_url" || name === "baseurl" || name === "url") args.baseUrl = value;
    else if (name === "wire") args.wire = value;
    else if (name === "effort") args.effort = value;
    else if (name === "context" || name === "context_window") args.contextWindow = digits(value) ?? value;
    else if (name === "max_output" || name === "max_output_tokens") args.maxOutputTokens = digits(value) ?? value;
    else if (name === "timeout" || name === "timeout_ms") args.timeoutMs = digits(value) ?? value;
    else if (name === "cache" || name === "prompt_cache_key") {
      const on = value.toLowerCase();
      if (on !== "on" && on !== "off" && on !== "true" && on !== "false") return refuse("usage");
      args.promptCacheKey = on === "on" || on === "true";
    } else return refuse("usage");
  }
  return args;
}

const SIZE_TOKEN = /^(auto|\d+x\d+)$/iu;

/** The text form of `imagegen`, as an argument object. */
function parseImagegen(rest: string): Args | Refused {
  const [word, after] = firstWord(rest);
  if (word === "" || SHOW_WORDS.has(word)) return after === "" ? { op: "show" } : refuse("usage");
  if (OFF_WORDS.has(word)) return after === "" ? { op: "off" } : refuse("usage");
  if (!SET_WORDS.has(word)) return refuse("usage");
  const split = tokens(after);
  if (split === null || split.plain.length < 1) return refuse("usage");
  const args: Record<string, unknown> = { op: "set", provider: split.plain[0] };
  // As 2.6: after the provider, a size-shaped token is the size and the other is the model.
  for (const token of split.plain.slice(1)) {
    if (SIZE_TOKEN.test(token) && args.size === undefined) args.size = token.toLowerCase();
    else if (args.model === undefined) args.model = token;
    else return refuse("usage");
  }
  for (const [name, value] of split.named) {
    if (name === "key") args.key = value;
    else if (name === "base_url" || name === "baseurl" || name === "url") args.baseUrl = value;
    else if (name === "size") args.size = value;
    else if (name === "model") args.model = value;
    else return refuse("usage");
  }
  return args;
}

/** The text form of `key`, as an argument object. */
function parseKey(rest: string): Args | Refused {
  const [word, after] = firstWord(rest);
  if (word === "" || LIST_WORDS.has(word)) return after === "" ? { op: "list" } : refuse("usage");
  if (MINT_WORDS.has(word)) {
    const [first, more] = firstWord(after);
    const role = ROLE_NAMES.get(first);
    const name = role === undefined ? after : more;
    return name === "" ? refuse("usage") : { op: "mint", role: role ?? "player", name };
  }
  const [id, more] = firstWord(after);
  if (id === "") return refuse("usage");
  if (RENAME_WORDS.has(word)) return more === "" ? refuse("usage") : { op: "rename", id, name: more };
  if (ROLE_WORDS.has(word)) {
    const role = ROLE_NAMES.get(more.toLowerCase());
    return role === undefined ? refuse("usage") : { op: "role", id, role };
  }
  if (REVOKE_WORDS.has(word)) return more === "" ? { op: "revoke", id } : refuse("usage");
  return refuse("usage");
}

const MODEL_PARAMS = object(
  {
    op: oneOf(["show", "list", "set", "key", "reset"]),
    lane: oneOf(MODEL_LANES),
    provider: text(MAX_PROVIDER_CHARS, 1),
    model: text(MAX_MODEL_CHARS, 1),
    key: text(MAX_SECRET_CHARS, 1),
    baseUrl: text(MAX_BASE_URL_CHARS, 1),
    wire: oneOf(WIRES),
    effort: oneOf(EFFORTS),
    contextWindow: integer(1, 100_000_000),
    maxOutputTokens: integer(1, 10_000_000),
    timeoutMs: integer(1, 3_600_000),
    promptCacheKey: BOOLEAN,
  },
  ["op"],
);

const IMAGEGEN_PARAMS = object(
  {
    op: oneOf(["show", "set", "off"]),
    provider: text(MAX_PROVIDER_CHARS, 1),
    model: text(MAX_MODEL_CHARS, 1),
    size: text(16, 1),
    key: text(MAX_SECRET_CHARS, 1),
    baseUrl: text(MAX_BASE_URL_CHARS, 1),
  },
  ["op"],
);

const KEY_PARAMS = object({ op: oneOf(["list", "mint", "rename", "role", "revoke"]), id: text(32, 1), name: text(MAX_KEY_NAME_CHARS, 1), role: oneOf(ROLES) }, ["op"]);

function refused(outcome: SettingsRefusal): Refused {
  return refuse(outcome.code, outcome.params);
}

function laneLine(call: CommandCall, lane: ReturnType<ModelSettings["describeLane"]>): string {
  const none = call.say("model.none");
  const key = lane.key.masked ?? call.say("model.key_none");
  if (lane.provider === null && lane.model === null) return call.say("model.lane_unset", { lane: lane.lane });
  const source = call.say(lane.sameAsKeeper ? "model.source_keeper" : `model.source_${lane.source}`);
  return call.say("model.lane_line", { lane: lane.lane, provider: lane.provider ?? none, model: lane.model ?? none, base: lane.baseUrl ?? none, key, source });
}

/** `model`: show, list, set, key, reset. */
export function modelCommand(models: ModelSettings | null): CommandSpec {
  return {
    id: "model",
    source: "engine",
    key: "model",
    params: MODEL_PARAMS,
    text: { en: ["model", "models"], zh: ["model", "模型"] },
    role: "player",
    observers: true,
    // The catalog is anyone's; everything else is the admin's.
    adminWhen: (args) => !(args.op === "list" && args.provider === undefined && args.lane === undefined),
    unlocked: () => true,
    available: () => (models === null ? "settings_unavailable" : true),
    parseText: (rest) => parseModel(rest),
    async prepare(call, args) {
      if (models === null || args.op !== "list" || call.context.who.member?.role !== "admin") return undefined;
      return models.listModels({
        ...(args.lane === undefined ? {} : { lane: args.lane as ModelLane }),
        ...(args.provider === undefined ? {} : { provider: args.provider as string }),
      });
    },
    run(call, args, prepared): Done | Refused {
      if (models === null) return refuse("settings_unavailable");
      const lane = (args.lane as ModelLane | undefined) ?? "keeper";
      const catalog = Object.keys(PRESETS);
      const separator = call.say("list.separator");
      switch (args.op) {
        case "show": {
          const view = models.describe();
          const lines = [call.say("model.header"), ...view.lanes.map((each) => laneLine(call, each))];
          return { text: lines.join("\n"), data: view };
        }
        case "list": {
          const catalogLine = call.say("model.catalog", { list: catalog.join(separator) });
          if (call.context.who.member?.role !== "admin") return { text: catalogLine, data: { providers: catalog } };
          const listed = prepared as Awaited<ReturnType<ModelSettings["listModels"]>> | undefined;
          if (listed === undefined) return refuse("settings_unavailable");
          if (!listed.ok) return refused(listed);
          const lines = [call.say("model.listed", { provider: listed.provider ?? call.say("model.none"), count: listed.models.length }), listed.models.join("\n")];
          if (listed.truncated) lines.push(call.say("model.listed_truncated", { shown: listed.models.length, total: listed.total }));
          if (listed.skipped > 0) lines.push(call.say("model.listed_skipped", { count: listed.skipped }));
          lines.push(catalogLine);
          return { text: lines.filter((line) => line !== "").join("\n"), data: { providers: catalog, provider: listed.provider, models: listed.models, total: listed.total, truncated: listed.truncated, skipped: listed.skipped } };
        }
        case "set": {
          if (args.provider === undefined) return refuse("missing_arg", { path: "provider" });
          const input: { -readonly [K in keyof LaneInput]: LaneInput[K] } = { provider: args.provider as string };
          if (args.model !== undefined) input.model = args.model as string;
          if (args.baseUrl !== undefined) input.baseUrl = args.baseUrl as string;
          if (args.key !== undefined) input.key = args.key as string;
          if (args.wire !== undefined) input.wire = args.wire as Wire;
          if (args.effort !== undefined) input.effort = args.effort as ReasoningEffort;
          if (args.contextWindow !== undefined) input.contextWindow = args.contextWindow as number;
          if (args.maxOutputTokens !== undefined) input.maxOutputTokens = args.maxOutputTokens as number;
          if (args.timeoutMs !== undefined) input.timeoutMs = args.timeoutMs as number;
          if (args.promptCacheKey !== undefined) input.promptCacheKey = args.promptCacheKey as boolean;
          const outcome = models.set(lane, input);
          if (!outcome.ok) return refused(outcome);
          const done = outcome.lane;
          const lines = [call.say("model.set_done", { lane, provider: done.provider ?? "", model: done.model ?? "" })];
          lines.push(done.key.set ? call.say("model.key_line", { key: done.key.masked ?? "" }) : call.say("model.key_missing", { provider: done.provider ?? "" }));
          return { text: lines.join("\n"), data: { lane: done, keySaved: outcome.keySaved } };
        }
        case "key": {
          if (args.key === undefined) return refuse("missing_arg", { path: "key" });
          const outcome = models.setKey(lane, args.key as string);
          if (!outcome.ok) return refused(outcome);
          return { text: call.say("model.key_done", { lane, provider: outcome.provider, key: outcome.lane.key.masked ?? "" }), data: { lane: outcome.lane } };
        }
        default: {
          const outcome = models.reset(args.lane as ModelLane | undefined);
          const keeper = models.describeLane("keeper");
          const text = outcome.lanes.length === 0 ? call.say("model.reset_nothing") : call.say("model.reset_done", { lanes: outcome.lanes.join(separator), provider: keeper.provider ?? call.say("model.none"), model: keeper.model ?? call.say("model.none") });
          return { text, data: { reset: outcome.lanes, keeper } };
        }
      }
    },
  };
}

/** `imagegen`: show, set, off. */
export function imagegenCommand(models: ModelSettings | null): CommandSpec {
  return {
    id: "imagegen",
    source: "engine",
    key: "imagegen",
    params: IMAGEGEN_PARAMS,
    text: { en: ["imagegen"], zh: ["imagegen", "图片生成", "圖片生成"] },
    role: "admin",
    unlocked: () => true,
    available: () => (models === null ? "settings_unavailable" : true),
    parseText: (rest) => parseImagegen(rest),
    run(call, args): Done | Refused {
      if (models === null) return refuse("settings_unavailable");
      if (args.op === "show") {
        const image = models.describe().imagegen;
        const none = call.say("model.none");
        const text = image.enabled
          ? call.say("imagegen.show", { provider: image.provider ?? none, model: image.model ?? none, size: image.size ?? none, base: image.baseUrl ?? none, key: image.key.masked ?? call.say("model.key_none") })
          : call.say("imagegen.show_off");
        return { text, data: { imagegen: image } };
      }
      if (args.op === "off") {
        const outcome = models.imageOff();
        return { text: call.say("imagegen.off_done"), data: { changed: outcome.changed } };
      }
      if (args.provider === undefined) return refuse("missing_arg", { path: "provider" });
      const outcome = models.imageSet({
        provider: args.provider as string,
        ...(args.model === undefined ? {} : { model: args.model as string }),
        ...(args.size === undefined ? {} : { size: args.size as string }),
        ...(args.key === undefined ? {} : { key: args.key as string }),
        ...(args.baseUrl === undefined ? {} : { baseUrl: args.baseUrl as string }),
      });
      if (!outcome.ok) return refused(outcome);
      const image = outcome.imagegen;
      const lines = [call.say("imagegen.set_done", { provider: image.provider ?? "", model: image.model ?? "", size: image.size ?? "" })];
      lines.push(image.key.set ? call.say("model.key_line", { key: image.key.masked ?? "" }) : call.say("model.key_missing", { provider: image.provider ?? "" }));
      return { text: lines.join("\n"), data: { imagegen: image, keySaved: outcome.keySaved } };
    },
  };
}

function keystoreRefusal(error: unknown): Refused | null {
  if (!(error instanceof Error) || error.name !== "KeystoreError") return null;
  const problem = (error as Error & { problem?: unknown }).problem;
  if (problem === "unknown_key") return refuse("unknown_key_id");
  if (problem === "last_admin") return refuse("last_admin");
  if (problem === "bad_name") return refuse("bad_key_name");
  return refuse("command_failed");
}

/** `key`: this room's access keys — list, mint, rename, role, revoke. */
export function keyCommand(keys: KeyAdmin | null): CommandSpec {
  return {
    id: "key",
    source: "engine",
    key: "key",
    params: KEY_PARAMS,
    text: { en: ["key", "keys"], zh: ["key", "钥匙", "鑰匙"] },
    role: "admin",
    unlocked: () => true,
    available: () => (keys === null ? "settings_unavailable" : true),
    parseText: (rest) => parseKey(rest),
    run(call, args): Done | Refused {
      if (keys === null) return refuse("settings_unavailable");
      const { room, services } = call.context;
      const id = args.id as string | undefined;
      if (args.op !== "list" && args.op !== "mint") {
        if (id === undefined) return refuse("missing_arg", { path: "id" });
        if (!KEY_ID.test(id)) return refuse("unknown_key_id");
      }
      try {
        switch (args.op) {
          case "list": {
            const online = keys.online(room);
            const listed = keys.book.listForAdmin(room).map((key) => ({
              id: key.id,
              name: key.name,
              role: key.role,
              masked: key.masked,
              ...(key.created === undefined ? {} : { created: key.created }),
              online: online.has(key.member),
            }));
            const lines = [call.say("key.header"), ...listed.map((key) => call.say(key.online ? "key.line_online" : "key.line", { name: key.name, role: call.say(`key.role_${key.role}`), id: key.id, masked: key.masked }))];
            return { text: lines.join("\n"), data: { keys: listed } };
          }
          case "mint": {
            if (args.name === undefined) return refuse("missing_arg", { path: "name" });
            const role = (args.role as Role | undefined) ?? "player";
            const minted = keys.book.mint({ room, name: args.name as string, role }, services.clock.now());
            const info = minted.info;
            return {
              text: [call.say("key.minted", { name: info.name, role: call.say(`key.role_${info.role}`), id: info.id }), minted.key, call.say("key.minted_once")].join("\n"),
              data: { id: info.id, name: info.name, role: info.role, key: minted.key },
            };
          }
          case "rename": {
            if (args.name === undefined) return refuse("missing_arg", { path: "name" });
            const info = keys.book.update(room, id as string, { name: args.name as string });
            return { text: call.say("key.renamed", { id: info.id, name: info.name }), data: { id: info.id, name: info.name, role: info.role } };
          }
          case "role": {
            if (args.role === undefined) return refuse("missing_arg", { path: "role" });
            const before = keys.book.listForAdmin(room).find((key) => key.id === id);
            const info = keys.book.update(room, id as string, { role: args.role as Role });
            const changed = before !== undefined && before.role !== info.role;
            // The holder's live connections carry the role they joined with: they end, and the
            // client comes back with the new one.
            const member = changed ? keys.book.memberOf(room, info.id) : undefined;
            return {
              text: call.say(changed ? "key.role_changed" : "key.role_same", { id: info.id, name: info.name, role: call.say(`key.role_${info.role}`) }),
              data: { id: info.id, name: info.name, role: info.role, changed },
              ...(member === undefined ? {} : { disconnect: [member] }),
            };
          }
          default: {
            const member = keys.book.memberOf(room, id as string);
            const before = keys.book.listForAdmin(room).find((key) => key.id === id);
            keys.book.delete(room, id as string);
            return {
              text: call.say("key.revoked", { id: id as string, name: before?.name ?? "" }),
              data: { id, revoked: true },
              ...(member === undefined ? {} : { disconnect: [member] }),
            };
          }
        }
      } catch (error) {
        const refusal = keystoreRefusal(error);
        if (refusal !== null) return refusal;
        throw error;
      }
    },
  };
}
