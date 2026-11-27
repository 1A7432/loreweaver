// The command table of a server, and the two entrances to it.
//
// A `CommandRegistry` is built once per server (no globals) and holds the engine's
// commands. A room's table is that, plus the commands of the room's rule pack (its
// subsystem words; its check and creation words join the engine's `check` and
// `new_character`), plus the module commands an injected dispatcher lists. Two entrances
// reach the same handler: `input` (a line a player typed: a text command, or speech with
// its inline rolls) and `run` (`command.run {id, args}`). Either way the caller's role is
// checked, the arguments are validated against the command's schema — a text form's
// arguments are parsed into the very object a structured call passes — and the handler
// runs in one store transaction: a refusal rolls back whatever it wrote, so a failure
// leaves the room as it was and is never an event.
import { DiceError } from "../../core/dice/index.ts";
import { ResolutionError } from "../../core/resolution/index.ts";
import { commandWord, type RulePack } from "../../core/rulepacks/index.ts";
import { foldCase } from "../../core/sheets/text.ts";
import type { RoomContext } from "../../agent/context.ts";
import type { RecallDeps } from "../../agent/recall.ts";
import { translate } from "../../infra/i18n.ts";
import { LifecycleError, StaleGeneration } from "../../infra/lifecycle/errors.ts";
import { COMMANDS_CATALOG } from "./catalog.ts";
import { checkCommand, initCommand, newCharacterCommand, opposedCommand, packCommands } from "./engine/checks.ts";
import { audioCommand, layerCommand } from "./engine/audio.ts";
import { importCommand, uploadsCommand } from "./engine/files.ts";
import { type AuthoringDeps, GENCHAR_PER_HOUR, gencharCommand } from "./engine/genchar.ts";
import { packCommand, panelsCommand, skillCommand } from "./engine/packs.ts";
import { reportCommand } from "./engine/report.ts";
import { imagegenCommand, type KeyAdmin, keyCommand, modelCommand } from "./engine/admin.ts";
import { drawCommand, hiddenRollCommand, jrrpCommand, rollCommand, rollInline } from "./engine/dice.ts";
import { botCommand, helpCommand, languageCommand, ResetGate, resetCommand, ruleCommand, saveCommand, undoCommand } from "./engine/room.ts";
import { pcCommand, renameCommand, sheetCommand } from "./engine/sheet.ts";
import { chronicleCommand, habitsCommand, loreCommand, npcCommand, recapCommand, varCommand } from "./engine/world.ts";
import { argumentTooLong, inlineRolls, MAX_COMMAND_ARG_CHARS, MAX_INLINE_ROLLS, splitCommand } from "./parse.ts";
import { compact, validateArgs } from "./schema.ts";
import type { ModelSettings } from "../model_settings.ts";
import { RoomPacks } from "../packs.ts";
import { HourlyQuota } from "../rate_limit.ts";
import { REVIEW_OFF, type ReviewFilter } from "../review.ts";
import type { Uploads } from "../uploads.ts";
import {
  type Args,
  type CommandCall,
  type CommandEvent,
  type CommandOutcome,
  type CommandRefusal,
  type CommandSignal,
  type CommandSpec,
  type CommandsView,
  type CommandViewEntry,
  type Done,
  isRefused,
  type LifecycleNotice,
  type ModuleCommands,
  refuse,
  type Refused,
  type TextForms,
} from "./types.ts";

export interface RegistryOptions {
  /** The module-command dispatcher; absent on a server without modules. */
  readonly modules?: ModuleCommands | null;
  /** How long an armed reset waits for its confirmation. */
  readonly resetConfirmMs?: number;
  /** Members' files (`uploads`, `import`); absent on a server without a media store. */
  readonly uploads?: Uploads | null;
  /** Recall by meaning, to index the lore a world import writes; absent when it is off. */
  readonly recall?: RecallDeps | null;
  /** The installed packs and the server's skills (`pack`, `skill`, `import` from a pack); default: none installed, built-in skills. */
  readonly packs?: RoomPacks | null;
  /** The model lanes and image generation at run time (`model`, `imagegen`); absent: those commands are unavailable. */
  readonly models?: ModelSettings | null;
  /** The access keys (`key`); absent: that command is unavailable. */
  readonly keys?: KeyAdmin | null;
  /** The operator's word filter, for what the authoring lane writes on a new sheet (`genchar`, a character import); default: off. */
  readonly review?: ReviewFilter;
}

/** What a line a player typed turned out to be. */
export type InputOutcome =
  | {
      readonly kind: "command";
      /** The command it reached; null when it was refused before reaching one. */
      readonly id: string | null;
      readonly outcome: CommandOutcome;
    }
  | {
      readonly kind: "speech";
      readonly text: string;
      /** The line's inline rolls, as dice events for the table (published after the line). */
      readonly rolls: readonly CommandEvent[];
      /** Why an inline roll did not roll, in the caller's language: for the caller alone. */
      readonly failures: readonly string[];
    };

class Rollback extends Error {
  readonly refusal: Refused;

  constructor(refusal: Refused) {
    super(refusal.refused);
    this.refusal = refusal;
  }
}

function isZh(locale: string): boolean {
  return locale.toLowerCase().startsWith("zh");
}

export class CommandRegistry {
  readonly #engine: readonly CommandSpec[];
  readonly #modules: ModuleCommands | null;
  readonly #packSpecs = new WeakMap<RulePack, readonly CommandSpec[]>();

  constructor(options: RegistryOptions = {}) {
    this.#modules = options.modules ?? null;
    const gate = new ResetGate(options.resetConfirmMs);
    const packs = options.packs ?? RoomPacks.none();
    // One quota for the server's concept calls: `genchar` and a character import share it.
    const authoring: AuthoringDeps = { models: options.models ?? null, quota: new HourlyQuota(GENCHAR_PER_HOUR), review: options.review ?? REVIEW_OFF, skills: packs.skillRegistry };
    this.#engine = Object.freeze([
      rollCommand,
      hiddenRollCommand,
      checkCommand,
      opposedCommand,
      initCommand,
      sheetCommand,
      renameCommand,
      newCharacterCommand,
      gencharCommand(authoring),
      pcCommand,
      recapCommand,
      loreCommand,
      varCommand,
      npcCommand,
      chronicleCommand,
      habitsCommand,
      ruleCommand,
      botCommand,
      languageCommand,
      undoCommand,
      resetCommand(gate),
      saveCommand,
      uploadsCommand(options.uploads ?? null),
      importCommand(options.uploads ?? null, options.recall ?? null, packs, authoring),
      packCommand(packs),
      skillCommand(packs),
      panelsCommand(packs),
      audioCommand(options.uploads ?? null, packs),
      layerCommand("bgm", options.uploads ?? null, packs),
      layerCommand("ambience", options.uploads ?? null, packs),
      layerCommand("sfx", options.uploads ?? null, packs),
      reportCommand(options.uploads ?? null),
      jrrpCommand,
      drawCommand,
      modelCommand(options.models ?? null),
      imagegenCommand(options.models ?? null),
      keyCommand(options.keys ?? null),
      helpCommand((call) => this.#entries(call.context, call.locale)),
    ]);
    const ids = new Set<string>();
    for (const spec of this.#engine) {
      if (ids.has(spec.id)) throw new Error(`command registered twice: ${spec.id}`);
      ids.add(spec.id);
    }
  }

  /** The engine's commands and the room's rule-pack commands, engine first. */
  specs(context: RoomContext): readonly CommandSpec[] {
    return [...this.#engine, ...this.#packOf(context.pack)];
  }

  /**
   * The command `id` in this room, or undefined. The gateway reads `lifecycle` here before
   * running one: a room-lifecycle command is given a writer of the room's current turn, not
   * a turn of its own.
   */
  spec(context: RoomContext, id: string): CommandSpec | undefined {
    return this.specs(context).find((candidate) => candidate.id === id);
  }

  /** A line a player typed: a text command, or speech. */
  async input(context: RoomContext, line: string, locale: string): Promise<InputOutcome> {
    const split = splitCommand(line);
    if (split !== null) {
      const spec = this.#lookup(context, split.word, locale);
      if (spec !== null) {
        if (argumentTooLong(split.rest)) return { kind: "command", id: spec.id, outcome: this.#refusal(locale, "too_long", { limit: MAX_COMMAND_ARG_CHARS }) };
        const outcome = await this.#execute(context, spec, locale, split.word, (call) => spec.parseText(split.rest, call));
        return { kind: "command", id: spec.id, outcome };
      }
      const module = await this.#moduleText(context, split.word, split.rest, locale);
      if (module !== null) return module;
      // A word some loaded pack declares but this room's system does not: a command in the
      // wrong room, not a line of speech.
      if (this.#packWord(context, split.word)) {
        return { kind: "command", id: null, outcome: this.#refusal(locale, "not_in_system", { word: split.word }) };
      }
    }
    return this.#speech(context, line, locale);
  }

  /**
   * What a typed line would run, without running it: the command and the argument object
   * its text form parses to (exactly what `command.run` would be given), a refusal of the
   * text, or null for speech. Engine and pack commands only; module text is the
   * dispatcher's.
   */
  textCommand(context: RoomContext, line: string, locale: string): { readonly id: string; readonly args: Args } | CommandRefusal | null {
    const split = splitCommand(line);
    if (split === null) return null;
    const spec = this.#lookup(context, split.word, locale);
    if (spec === null) return this.#packWord(context, split.word) ? this.#refusal(locale, "not_in_system", { word: split.word }) : null;
    if (argumentTooLong(split.rest)) return this.#refusal(locale, "too_long", { limit: MAX_COMMAND_ARG_CHARS });
    const call = this.#call(context, locale, split.word);
    const parsed = spec.parseText(split.rest, call);
    return isRefused(parsed) ? this.#refuse(call, spec, parsed) : { id: spec.id, args: compact(parsed) };
  }

  /** `command.run {id, args}`: the structured entrance. */
  async run(context: RoomContext, id: string, args: unknown, locale: string): Promise<CommandOutcome> {
    if (id.includes("/")) return this.#runModule(context, id, args, locale);
    const spec = this.specs(context).find((candidate) => candidate.id === id);
    if (spec === undefined) return this.#refusal(locale, "unknown_command", { id });
    return this.#execute(context, spec, locale, null, () => (typeof args === "object" && args !== null && !Array.isArray(args) ? (args as Args) : refuse("invalid_arg", { path: "" })));
  }

  /** The `commands` view: the commands this context's member may see, each with whether they can use it now. */
  async view(context: RoomContext, locale: string): Promise<CommandsView> {
    return { commands: await this.#entries(context, locale) };
  }

  // --- resolution --------------------------------------------------------------------

  #packOf(pack: RulePack | null): readonly CommandSpec[] {
    if (pack === null) return [];
    let specs = this.#packSpecs.get(pack);
    if (specs === undefined) {
      specs = Object.freeze(packCommands(pack));
      this.#packSpecs.set(pack, specs);
    }
    return specs;
  }

  #forms(spec: CommandSpec, context: RoomContext): TextForms {
    const forms = spec.text;
    if (forms === undefined) return { en: [], zh: [] };
    return typeof forms === "function" ? forms(context) : forms;
  }

  /**
   * The command a word names. Engine commands are searched before pack commands, so an
   * engine form wins a clash; within each, the caller's own alias table first.
   */
  #lookup(context: RoomContext, word: string, locale: string): CommandSpec | null {
    const tables: readonly (keyof TextForms)[] = isZh(locale) ? ["zh", "en"] : ["en", "zh"];
    for (const group of [this.#engine, this.#packOf(context.pack)]) {
      for (const table of tables) {
        for (const spec of group) {
          if (this.#forms(spec, context)[table].some((form) => foldCase(form) === word)) return spec;
        }
      }
    }
    return null;
  }

  #packWord(context: RoomContext, word: string): boolean {
    const key = commandWord(word);
    return context.services.packs.packs().some((pack) => pack.commands.has(key));
  }

  // --- execution ---------------------------------------------------------------------

  #call(context: RoomContext, locale: string, word: string | null): CommandCall {
    return {
      context,
      locale,
      word,
      say: (key, params = {}) => translate(COMMANDS_CATALOG, locale, key, params),
      tell: (key, params = {}) => translate(COMMANDS_CATALOG, context.locale, key, params),
    };
  }

  #refusal(locale: string, code: string, params: Readonly<Record<string, string | number>> = {}): CommandRefusal {
    // A code passed through from a lower layer may have no sentence of its own: it is then
    // stated with the generic one, never shown as a bare catalog key.
    const key = Object.hasOwn(COMMANDS_CATALOG.en ?? {}, `error.${code}`) ? `error.${code}` : "error.generic";
    return { ok: false, code, message: translate(COMMANDS_CATALOG, locale, key, { ...params, code }) };
  }

  async #execute(context: RoomContext, spec: CommandSpec, locale: string, word: string | null, argsOf: (call: CommandCall) => Args | Refused): Promise<CommandOutcome> {
    const call = this.#call(context, locale, word);
    const role = context.who.member?.role ?? null;
    if (role === null) return this.#refusal(locale, "no_member");
    if ((role === "observer" && spec.observers !== true) || (spec.role === "admin" && role !== "admin")) return this.#refusal(locale, "forbidden");
    const available = spec.available?.(context) ?? true;
    if (available !== true) return this.#refusal(locale, available, { word: word ?? spec.id });
    const parsed = argsOf(call);
    if (isRefused(parsed)) return this.#refuse(call, spec, parsed);
    const args = word === null ? parsed : compact(parsed);
    const problem = validateArgs(spec.params, args);
    if (problem !== null) return this.#refusal(locale, problem.code, { path: problem.path });
    if (spec.adminWhen?.(args) === true && role !== "admin") return this.#refusal(locale, "forbidden");
    // A writer of a generation that has since moved on can commit nothing, not even the
    // command's own events: the room was rewound, reset or replaced under the caller.
    if (spec.lifecycle !== true && !context.writer.current()) return this.#refusal(locale, "stale_generation");
    const prepared = spec.prepare === undefined ? undefined : await spec.prepare(call, args);
    return this.#perform(call, spec, args, prepared);
  }

  #perform(call: CommandCall, spec: CommandSpec, args: Args, prepared: unknown): CommandOutcome {
    const context = call.context;
    try {
      if (spec.lifecycle === true) {
        const done = spec.run(call, args, prepared);
        return isRefused(done) ? this.#refuse(call, spec, done) : this.#success(done);
      }
      return context.services.store.transaction(() => {
        const done = spec.run(call, args, prepared);
        // Thrown, so the transaction undoes whatever the handler wrote before refusing.
        if (isRefused(done)) throw new Rollback(done);
        return this.#success(done);
      });
    } catch (error) {
      if (error instanceof Rollback) return this.#refuse(call, spec, error.refusal);
      if (error instanceof StaleGeneration) return this.#refusal(call.locale, "stale_generation");
      if (error instanceof DiceError) return this.#refusal(call.locale, "bad_dice", { expr: "", code: error.code });
      if (error instanceof ResolutionError) return this.#refusal(call.locale, "roll_failed", { code: error.code });
      if (error instanceof LifecycleError) return this.#refusal(call.locale, error.code);
      // A payload a document type refused (`DocumentRefused`, which this layer may not import).
      if (error instanceof Error && error.name === "DocumentRefused") return this.#refusal(call.locale, "document_refused");
      context.services.report(context.room, `command ${spec.id} failed: ${error instanceof Error ? error.message : String(error)}`);
      return this.#refusal(call.locale, "command_failed");
    }
  }

  #refuse(call: CommandCall, spec: CommandSpec, refused: Refused): CommandRefusal {
    if (refused.refused === "usage") {
      const usage = translate(COMMANDS_CATALOG, call.locale, `${spec.key}.usage`, spec.keyParams?.(call.locale) ?? {});
      return { ok: false, code: "usage", message: translate(COMMANDS_CATALOG, call.locale, "error.usage", { usage }) };
    }
    return this.#refusal(call.locale, refused.refused, refused.params ?? {});
  }

  #success(done: Done): CommandOutcome {
    const outcome: {
      ok: true;
      text?: string;
      data?: unknown;
      events: readonly CommandEvent[];
      signals: readonly CommandSignal[];
      lifecycle?: LifecycleNotice;
      modulesChanged?: boolean;
      after?: () => Promise<readonly string[]>;
      disconnect?: readonly string[];
    } = {
      ok: true,
      events: done.events ?? [],
      signals: done.signals ?? [],
    };
    if (done.text !== undefined && done.text !== "") outcome.text = done.text;
    if (done.data !== undefined) outcome.data = done.data;
    if (done.lifecycle !== undefined) outcome.lifecycle = done.lifecycle;
    if (done.modulesChanged === true) outcome.modulesChanged = true;
    if (done.after !== undefined) outcome.after = done.after;
    if (done.disconnect !== undefined && done.disconnect.length > 0) outcome.disconnect = done.disconnect;
    return outcome;
  }

  // --- speech --------------------------------------------------------------------------

  #speech(context: RoomContext, line: string, locale: string): InputOutcome {
    const exprs = inlineRolls(line);
    const call = this.#call(context, locale, null);
    if (exprs.length > MAX_INLINE_ROLLS) {
      return { kind: "speech", text: line, rolls: [], failures: [call.say("error.too_many_inline_rolls", { limit: MAX_INLINE_ROLLS })] };
    }
    const rolls: CommandEvent[] = [];
    const failures: string[] = [];
    for (const expr of exprs) {
      const rolled = rollInline(call, expr);
      if (rolled.ok) rolls.push(rolled.event);
      else failures.push(call.say("inline.failed", { expr: rolled.expr, code: rolled.code }));
    }
    return { kind: "speech", text: line, rolls, failures };
  }

  // --- modules -------------------------------------------------------------------------

  async #moduleText(context: RoomContext, word: string, rest: string, locale: string): Promise<InputOutcome | null> {
    if (this.#modules === null || !word.includes("/")) return null;
    let args: unknown = {};
    if (rest !== "") {
      if (argumentTooLong(rest)) return { kind: "command", id: word, outcome: this.#refusal(locale, "too_long", { limit: MAX_COMMAND_ARG_CHARS }) };
      try {
        args = JSON.parse(rest) as unknown;
      } catch {
        return { kind: "command", id: word, outcome: this.#refusal(locale, "module_args") };
      }
    }
    return { kind: "command", id: word, outcome: await this.#runModule(context, word, args, locale) };
  }

  async #runModule(context: RoomContext, id: string, args: unknown, locale: string): Promise<CommandOutcome> {
    if (this.#modules === null) return this.#refusal(locale, "unknown_command", { id });
    if (typeof args !== "object" || args === null || Array.isArray(args)) return this.#refusal(locale, "module_args");
    const role = context.who.member?.role ?? null;
    if (role === null) return this.#refusal(locale, "no_member");
    if (role === "observer") return this.#refusal(locale, "forbidden");
    return this.#modules.run(context, id, args as Args, locale);
  }

  // --- the view ------------------------------------------------------------------------

  async #entries(context: RoomContext, locale: string): Promise<readonly CommandViewEntry[]> {
    const role = context.who.member?.role ?? "observer";
    const say = (key: string, params: Readonly<Record<string, string>> = {}): string => translate(COMMANDS_CATALOG, locale, key, params);
    const table: keyof TextForms = isZh(locale) ? "zh" : "en";
    const entries: CommandViewEntry[] = [];
    for (const spec of this.specs(context)) {
      // An admin command is not shown to a player at all: the table of a player is theirs.
      if (spec.role === "admin" && role !== "admin") continue;
      const params = spec.keyParams?.(locale) ?? {};
      const available = role === "observer" && spec.observers !== true ? "observer" : (spec.available?.(context) ?? true);
      const forms = this.#forms(spec, context);
      const own = forms[table].length > 0 ? forms[table] : forms[table === "en" ? "zh" : "en"];
      const entry: { -readonly [K in keyof CommandViewEntry]: CommandViewEntry[K] } = {
        id: spec.id,
        source: spec.source,
        title: say(`${spec.key}.title`, params),
        description: say(`${spec.key}.description`, params),
        params: spec.params,
        role: spec.role,
        available: available === true,
      };
      if (own.length > 0) entry.text = { forms: own, usage: say(`${spec.key}.usage`, params) };
      if (spec.danger === true) entry.danger = true;
      if (available !== true) entry.reason = available;
      entries.push(entry);
    }
    if (this.#modules !== null) {
      for (const module of await this.#modules.list(context)) {
        if (module.role === "admin" && role !== "admin") continue;
        const available = role === "observer" ? "observer" : module.available;
        const entry: { -readonly [K in keyof CommandViewEntry]: CommandViewEntry[K] } = {
          id: module.id,
          source: "module",
          title: module.title,
          description: module.description,
          params: module.params,
          role: module.role,
          available: available === true,
        };
        if (module.forms !== undefined && module.forms.length > 0) entry.text = { forms: module.forms, usage: module.forms.join(" | ") };
        if (module.danger === true) entry.danger = true;
        if (available !== true) entry.reason = available;
        entries.push(entry);
      }
    }
    return entries;
  }
}
