// Running the room: `undo`, `reset` (armed, then confirmed), `save` (export and import of
// the whole room), `language`, `rule` (the house-rule variant), `bot` (mute the Keeper),
// and `help` (the commands view as text).
//
// Undo, reset and import move the room's generation: the command's own writer is void
// afterwards, so they say so in their outcome (`lifecycle`) for the gateway, which
// publishes their event through a writer of the new generation and reloads the room's
// worker.
import { LifecycleError } from "../../../infra/lifecycle/errors.ts";
import { isResetScope, type ResetScope } from "../../../infra/lifecycle/declarations.ts";
import { translate } from "../../../infra/i18n.ts";
import { COMMANDS_CATALOG } from "../catalog.ts";
import { compact, integer, object, oneOf, type ObjectSchema, text, BOOLEAN } from "../schema.ts";
import { firstWord, parseInteger } from "../parse.ts";
import { KEEPER_MUTED, ROOM_LOCALE, ROOM_LOCALES, ROOM_RULE_VARIANT } from "../state.ts";
import { documentCatalogOf } from "../support.ts";
import { type CommandCall, type CommandSpec, type CommandViewEntry, type Done, refuse, type Refused } from "../types.ts";

/** How long an armed reset waits for its confirmation. */
export const RESET_CONFIRM_MS = 60_000;
/** The furthest an undo is asked to reach; the store refuses past its own window anyway. */
const MAX_UNDO_TURNS = 64;

interface ArmedReset {
  readonly member: string;
  readonly scope: ResetScope;
  readonly expires: number;
}

/**
 * Resets waiting for their confirmation, per room. In memory on purpose: an armed reset
 * that does not survive a restart is simply not armed any more, which is the safe side.
 */
export class ResetGate {
  readonly #armed = new Map<string, ArmedReset>();
  readonly #windowMs: number;

  constructor(windowMs = RESET_CONFIRM_MS) {
    this.#windowMs = windowMs;
  }

  get windowMs(): number {
    return this.#windowMs;
  }

  arm(room: string, member: string, scope: ResetScope, now: number): void {
    this.#armed.set(room, { member, scope, expires: now + this.#windowMs });
  }

  /** The reset `member` armed in `room`, if still waiting; it is disarmed either way. */
  take(room: string, member: string, now: number): ArmedReset | null {
    const armed = this.#armed.get(room);
    if (armed === undefined || armed.member !== member) return null;
    this.#armed.delete(room);
    return armed.expires >= now ? armed : null;
  }
}

function lifecycleRefusal(error: unknown, call: CommandCall): Refused {
  if (error instanceof LifecycleError) {
    if (error.code === "undo_beyond_depth") return refuse("undo_beyond_depth", { depth: call.context.services.store.undoDepth });
    if (error.code === "invalid_bundle") return refuse("bad_bundle", { path: error.path });
    return refuse(error.code);
  }
  throw error;
}

/** The newest event the room's log still holds after a lifecycle operation. */
function logHead(call: CommandCall): number {
  return call.context.services.store.eventsBefore(call.context.room, Number.MAX_SAFE_INTEGER, 1)[0]?.seq ?? 0;
}

export const undoCommand: CommandSpec = {
  id: "undo",
  source: "engine",
  key: "undo",
  params: object({ turns: integer(1, MAX_UNDO_TURNS) }),
  text: { en: ["undo"], zh: ["undo", "撤销", "撤銷"] },
  role: "admin",
  danger: true,
  lifecycle: true,
  parseText(rest) {
    if (rest.trim() === "") return {};
    const turns = parseInteger(rest);
    return turns === null ? refuse("usage") : { turns };
  },
  run(call, args): Done | Refused {
    const store = call.context.services.store;
    const turns = (args.turns as number | undefined) ?? 1;
    const to = store.room(call.context.room).turn - turns;
    if (to < 0) return refuse("undo_out_of_range");
    let result;
    try {
      result = store.undoTo(call.context.room, to);
    } catch (error) {
      return lifecycleRefusal(error, call);
    }
    return {
      text: call.say("undo.done", { turns, turn: result.turn }),
      data: { turn: result.turn, epoch: result.epoch, removedTurns: result.removedTurns },
      lifecycle: { kind: "rewind", epoch: result.epoch, turn: result.turn, modulesChanged: result.modulesChanged },
      events: [{ kind: "rewind", data: { to: logHead(call), epoch: result.epoch } }],
    };
  },
};

export function resetCommand(gate: ResetGate): CommandSpec {
  return {
    id: "reset",
    source: "engine",
    key: "reset",
    params: object({ scope: oneOf(["story", "chars", "all"]), confirm: BOOLEAN }),
    text: { en: ["reset"], zh: ["reset", "重置", "重开", "重開"] },
    role: "admin",
    danger: true,
    lifecycle: true,
    parseText(rest) {
      const words = rest.trim().toLowerCase().split(/\s+/u).filter((word) => word !== "");
      let scope: string | undefined;
      let confirm: boolean | undefined;
      for (const word of words) {
        if (word === "confirm") confirm = true;
        else if (isResetScope(word) && scope === undefined) scope = word;
        else return refuse("usage");
      }
      return compact({ scope, confirm });
    },
    run(call, args): Done | Refused {
      const member = call.context.who.member;
      if (member === null) return refuse("no_member");
      const room = call.context.room;
      const now = call.context.services.clock.now();
      const asked = args.scope as ResetScope | undefined;
      if (args.confirm !== true) {
        const scope = asked ?? "story";
        gate.arm(room, member.id, scope, now);
        return {
          text: call.say("reset.armed", { what: call.say(`reset.scope.${scope}`), seconds: Math.round(gate.windowMs / 1000) }),
          data: { armed: scope },
        };
      }
      const armed = gate.take(room, member.id, now);
      if (armed === null) return refuse("reset_not_armed");
      if (asked !== undefined && asked !== armed.scope) return refuse("reset_scope_mismatch", { scope: armed.scope });
      let result;
      try {
        result = call.context.services.store.reset(room, armed.scope, documentCatalogOf(call.context.services));
      } catch (error) {
        return lifecycleRefusal(error, call);
      }
      return {
        text: call.say("reset.done", { what: call.say(`reset.scope.${armed.scope}`) }),
        data: { scope: armed.scope, epoch: result.epoch },
        lifecycle: { kind: "reset", epoch: result.epoch, scope: armed.scope },
        events: [{ kind: "reset", data: { scope: armed.scope, epoch: result.epoch } }],
      };
    },
  };
}

const ANY_OBJECT: ObjectSchema = { type: "object", properties: {}, additionalProperties: true };

export const saveCommand: CommandSpec = {
  id: "save",
  source: "engine",
  key: "save",
  params: object({ op: oneOf(["export", "import"]), bundle: ANY_OBJECT }, ["op"]),
  text: { en: ["save"], zh: ["save", "存档", "存檔"] },
  role: "admin",
  danger: true,
  lifecycle: true,
  parseText(rest) {
    const [word, after] = firstWord(rest);
    if (word === "" || word === "export") return { op: "export" };
    if (word !== "import") return refuse("usage");
    if (after === "") return refuse("missing_arg", { path: "bundle" });
    try {
      return { op: "import", bundle: JSON.parse(after) as unknown };
    } catch {
      return refuse("bad_bundle", { path: "" });
    }
  },
  run(call, args): Done | Refused {
    const store = call.context.services.store;
    const room = call.context.room;
    if (args.op === "export") {
      const bundle = store.exportRoom(room);
      // The bundle is the caller's: it holds every secret of the room, so it is never an event.
      return { text: call.say("save.exported", { documents: bundle.documents.length, events: bundle.events.length }), data: bundle };
    }
    if (args.bundle === undefined) return refuse("missing_arg", { path: "bundle" });
    let result;
    try {
      result = store.importRoom(room, args.bundle, documentCatalogOf(call.context.services));
    } catch (error) {
      return lifecycleRefusal(error, call);
    }
    return {
      text: call.say("save.imported", { turn: result.turn }),
      data: { epoch: result.epoch, turn: result.turn },
      lifecycle: { kind: "import", epoch: result.epoch, turn: result.turn },
    };
  },
};

const LANGUAGE_WORDS: ReadonlyMap<string, string> = new Map([
  ["en", "en"],
  ["english", "en"],
  ["zh", "zh"],
  ["chinese", "zh"],
  ["中文", "zh"],
]);

export const languageCommand: CommandSpec = {
  id: "language",
  source: "engine",
  key: "language",
  params: object({ locale: oneOf(ROOM_LOCALES) }, ["locale"]),
  text: { en: ["language"], zh: ["language", "语言", "語言"] },
  role: "admin",
  parseText(rest) {
    const [word] = firstWord(rest);
    const locale = LANGUAGE_WORDS.get(word);
    return locale === undefined ? refuse("usage") : { locale };
  },
  run(call, args): Done {
    const locale = args.locale as string;
    call.context.writer.statePut(ROOM_LOCALE, locale);
    // Announced in the language the room now speaks.
    return {
      data: { locale },
      events: [{ kind: "narrative", data: { speaker: "system", text: translate(COMMANDS_CATALOG, locale, "language.event"), format: "plain" } }],
    };
  },
};

/** The community short form of a ladder variant (`rule2` reads `2`). */
function variantDisplay(variant: string | null, call: CommandCall): string {
  if (variant === null) return call.say("rule.default");
  const digits = /^rule(\d+)$/u.exec(variant);
  return digits === null ? variant : (digits[1] as string);
}

export const ruleCommand: CommandSpec = {
  id: "rule",
  source: "engine",
  key: "rule",
  params: object({ variant: { type: ["string", "null"], minLength: 1, maxLength: 64 } }),
  text: { en: ["rule"], zh: ["rule", "规则", "規則"] },
  role: "player",
  adminWhen: (args) => args.variant !== undefined,
  available: (context) => (context.pack?.resolution ? true : "no_rule_system"),
  parseText(rest) {
    const word = rest.trim().toLowerCase();
    if (word === "") return {};
    if (word === "0" || word === "default") return { variant: null };
    return { variant: /^\d+$/u.test(word) ? `rule${word}` : word };
  },
  run(call, args): Done | Refused {
    const resolution = call.context.pack?.resolution ?? null;
    if (resolution === null) return refuse("no_rule_system");
    const available = [...resolution.variants.keys()];
    const list = [call.say("rule.default"), ...available.map((variant) => variantDisplay(variant, call))].join(call.say("list.separator"));
    if (args.variant === undefined) {
      const stored = call.context.services.store.stateGet(call.context.room, ROOM_RULE_VARIANT);
      // A stored ladder the pack no longer declares grades by the default; say so.
      const stale = stored !== null && !resolution.variants.has(stored);
      const lines = [call.say("rule.current", { rule: variantDisplay(stale ? null : stored, call) }), call.say("rule.available", { rules: list })];
      if (stale) lines.push(call.say("rule.stale"));
      return { text: lines.join("\n"), data: { variant: stale ? null : stored, available } };
    }
    const variant = args.variant as string | null;
    if (variant === null) call.context.writer.stateDelete(ROOM_RULE_VARIANT);
    else {
      if (!resolution.variants.has(variant)) return refuse("unknown_variant", { rules: list });
      call.context.writer.statePut(ROOM_RULE_VARIANT, variant);
    }
    return {
      data: { variant },
      events: [{ kind: "narrative", data: { speaker: "system", text: call.tell("rule.event", { rule: variant === null ? call.tell("rule.default") : variantDisplay(variant, call) }), format: "plain" } }],
    };
  },
};

const ON_WORDS: ReadonlySet<string> = new Set(["on", "开", "開"]);
const OFF_WORDS: ReadonlySet<string> = new Set(["off", "关", "關"]);

export const botCommand: CommandSpec = {
  id: "bot",
  source: "engine",
  key: "bot",
  params: object({ on: BOOLEAN }),
  text: { en: ["bot"], zh: ["bot"] },
  role: "player",
  adminWhen: (args) => args.on !== undefined,
  parseText(rest) {
    const [word] = firstWord(rest);
    if (word === "") return {};
    if (ON_WORDS.has(word)) return { on: true };
    if (OFF_WORDS.has(word)) return { on: false };
    return refuse("usage");
  },
  run(call, args): Done {
    if (args.on === undefined) {
      const muted = call.context.services.store.stateGet(call.context.room, KEEPER_MUTED) ?? false;
      return { text: call.say(muted ? "bot.status_off" : "bot.status_on"), data: { on: !muted } };
    }
    const on = args.on as boolean;
    call.context.writer.statePut(KEEPER_MUTED, !on);
    return { data: { on }, events: [{ kind: "narrative", data: { speaker: "system", text: call.tell(on ? "bot.event_on" : "bot.event_off"), format: "plain" } }] };
  },
};

/** `help`: the commands view, as text. `entries` is the caller's view of the table. */
export function helpCommand(entries: (call: CommandCall) => Promise<readonly CommandViewEntry[]>): CommandSpec {
  return {
    id: "help",
    source: "engine",
    key: "help",
    params: object({ id: text(128, 1) }),
    text: { en: ["help", "h"], zh: ["help", "帮助"] },
    role: "player",
    observers: true,
    parseText: (rest) => compact({ id: rest === "" ? undefined : rest.trim() }),
    prepare: (call) => entries(call),
    run(call, args, prepared): Done | Refused {
      const view = (prepared ?? []) as readonly CommandViewEntry[];
      const wanted = args.id as string | undefined;
      if (wanted !== undefined) {
        const folded = wanted.toLowerCase().replace(/^[.。/]/u, "");
        const entry = view.find((item) => item.id === folded || item.text?.forms.includes(folded) === true);
        if (entry === undefined) return refuse("unknown_command", { id: wanted });
        const lines = [call.say("help.entry", { title: entry.title, description: entry.description })];
        if (entry.text !== undefined) lines.push(entry.text.usage);
        if (!entry.available) lines.push(call.say("help.unavailable", { reason: call.say(`reason.${entry.reason ?? "unavailable"}`) }));
        return { text: lines.join("\n"), data: entry };
      }
      const line = (entry: CommandViewEntry): string => {
        const form = entry.text?.forms[0];
        return call.say(entry.available ? "help.line" : "help.line_unavailable", { form: form === undefined ? entry.id : `.${form}`, title: entry.title });
      };
      const players = view.filter((entry) => entry.role === "player").map(line);
      const admins = view.filter((entry) => entry.role === "admin").map(line);
      const lines = [call.say("help.header"), ...players];
      if (admins.length > 0) lines.push(call.say("help.admin_header"), ...admins);
      else if (call.context.who.member?.role !== "admin") lines.push(call.say("help.player_hint"));
      return { text: lines.join("\n"), data: { commands: view } };
    },
  };
}
