// The engine's side of the module contract: ask the room's worker, then validate and
// cap what came back. A module REQUESTS effects; this is the code that decides which of
// them may be applied. A module that fails or hangs loses its effects and the turn goes
// on without it.
//
// Every `validate*` function takes the worker's raw answer as `unknown`. It crossed a
// thread boundary, so it is plain data at best; nothing about its shape is assumed:
// every value is checked before use, and properties are read only when they are the
// value's own. What is over a cap is DROPPED, never shortened into something else, and
// every drop is reported in `problems` for the operator's log (never shown at the table).
import { charCount } from "loreweaver-protocol/v3";
import type { CommandOrigin, CommandRole, Json, JsonObject, ReplyPhaseEvent, RoomSnapshot, ToolUseEvent, TurnStartEvent, Who } from "loreweaver/module";
import { isValidName, mayRun, type ViewerRequest } from "loreweaver/runner";

import type { RoomWorker } from "../infra/room_worker.ts";
import { type ArgsProblem, checkModuleArgs } from "./module_args.ts";
import { parseForm, type TextForm } from "./module_forms.ts";

/** The most room members a module call carries; past it, the first ones and a problem for the operator. */
export const MAX_ROOM_MEMBERS = 256;

/**
 * Guard rails, not format rules, and fixed: nothing adjusts them, on purpose — a module is
 * written against the limits the README states. Characters are code points; sizes are
 * UTF-8 bytes of the JSON text.
 */
export interface ModuleCaps {
  /** Injections per turn, over all modules. */
  readonly injections: number;
  readonly injectChars: number;
  /** Per module, per call, from here on. */
  readonly facts: number;
  readonly factChars: number;
  readonly factDataBytes: number;
  readonly writes: number;
  readonly pathChars: number;
  readonly valueBytes: number;
  readonly blockEmissions: number;
  readonly blockBytes: number;
  readonly rolls: number;
  readonly logs: number;
  readonly logChars: number;
  readonly denyReasonChars: number;
  readonly commandTextChars: number;
  readonly commandDataBytes: number;
  readonly unavailableReasonChars: number;
  readonly argsBytes: number;
  /** The variables snapshot sent with every exchange: every module copies it for every call. */
  readonly variablesBytes: number;
  readonly viewBytes: number;
  /** Per module, at load. */
  readonly commands: number;
  readonly views: number;
  readonly titleChars: number;
  readonly descriptionChars: number;
  readonly textForms: number;
  readonly textFormChars: number;
  readonly schemaBytes: number;
  /** Per module, per render. */
  readonly characters: number;
  readonly characterTextChars: number;
  readonly blurbChars: number;
  readonly resources: number;
  readonly clockChars: number;
}

export const DEFAULT_CAPS: ModuleCaps = {
  injections: 8,
  injectChars: 4000,
  facts: 32,
  factChars: 2000,
  factDataBytes: 16 * 1024,
  writes: 32,
  pathChars: 200,
  valueBytes: 16 * 1024,
  blockEmissions: 8,
  blockBytes: 64 * 1024,
  rolls: 16,
  logs: 32,
  logChars: 2000,
  denyReasonChars: 500,
  commandTextChars: 4000,
  commandDataBytes: 256 * 1024,
  unavailableReasonChars: 500,
  argsBytes: 64 * 1024,
  variablesBytes: 1024 * 1024,
  viewBytes: 512 * 1024,
  commands: 64,
  views: 32,
  titleChars: 200,
  descriptionChars: 2000,
  textForms: 16,
  textFormChars: 200,
  schemaBytes: 64 * 1024,
  characters: 64,
  characterTextChars: 200,
  blurbChars: 2000,
  resources: 16,
  clockChars: 200,
};

// ---------------------------------------------------------------- validated shapes

export interface CommandInfo {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  /** JSON Schema object for the arguments; the arguments are checked against it before the module is called. */
  readonly params: JsonObject;
  /** The text forms that read (`module_forms.ts`), in declaration order; a form that did not is left out and reported. */
  readonly forms: readonly TextForm[];
  /** `keeper`: the Keeper's alone, never shown to a member; `admin`: never the Keeper's. */
  readonly role: CommandRole;
  /** False when the module declared `keeper: false`: a member's verb the Keeper never runs. */
  readonly keeper: boolean;
  /** The module marked it destructive: a client asks before running it. */
  readonly danger: boolean;
  /** Whether availability depends on more than the role. */
  readonly checksAvailability: boolean;
}

export interface ViewInfo {
  readonly name: string;
  readonly title: string | null;
  readonly schema: JsonObject;
}

/** What the engine knows about a loaded module, from its load-time description. */
export interface ModuleInfo {
  readonly id: string;
  readonly events: { readonly turnStart: boolean; readonly toolUse: boolean; readonly replyPhase: boolean };
  readonly commands: readonly CommandInfo[];
  readonly views: readonly ViewInfo[];
  readonly clock: boolean;
  readonly characters: boolean;
}

export interface FactRequest {
  readonly module: string;
  readonly text: string | null;
  readonly data: Json | null;
  readonly to: "table" | "keeper";
  readonly importance: "low" | "normal" | "high";
  readonly narrateNow: boolean;
}

export interface VariableWriteRequest {
  readonly module: string;
  readonly path: string;
  readonly value: Json;
}

export interface BlocksRequest {
  readonly module: string;
  readonly blocks: readonly Json[];
  readonly id: string | null;
}

export interface ModuleRoll {
  readonly module: string;
  readonly notation: string;
  readonly label: string | null;
  readonly total: number;
  readonly text: string;
}

export interface ModuleLog {
  readonly module: string;
  readonly text: string;
}

/** The effects a mutating exchange may apply, in module order. */
export interface Applied {
  readonly facts: readonly FactRequest[];
  readonly writes: readonly VariableWriteRequest[];
  readonly blocks: readonly BlocksRequest[];
  readonly rolls: readonly ModuleRoll[];
  readonly logs: readonly ModuleLog[];
}

export interface ClockInfo {
  readonly module: string;
  readonly time: string;
  readonly round: number | null;
}

export interface TurnStartOutcome extends Applied {
  /** Sections to add to this turn's Keeper prompt, in module order. */
  readonly injections: readonly string[];
  /** The clock reading the handlers were given, when a module claims the clock. */
  readonly clock: ClockInfo | null;
  /** What went wrong, for the operator's log. Never shown at the table. */
  readonly problems: readonly string[];
}

export type ToolVerdict = { readonly allowed: true } | { readonly allowed: false; readonly denials: readonly { readonly module: string; readonly reason: string }[] };

export interface ToolUseOutcome {
  /** One per tool call, in call order. */
  readonly verdicts: readonly ToolVerdict[];
  readonly logs: readonly ModuleLog[];
  readonly problems: readonly string[];
}

export interface ReplyPhaseOutcome extends Applied {
  readonly problems: readonly string[];
}

export type CommandOutcome =
  | (Applied & {
      readonly status: "ok";
      /** Answers whoever ran the command (the member, or the Keeper), and nobody else. */
      readonly result: { readonly text: string | null; readonly data: Json | null };
      readonly problems: readonly string[];
    })
  | {
      readonly status: "refused";
      /**
       * `invalid`: the arguments are not a JSON object within the size cap; `args`: they do not
       * fit the command's `params` (`problem` says how and where).
       */
      readonly reason: "unknown" | "role" | "invalid" | "args" | "unavailable";
      /** The module's reason, shown to that member, for `unavailable`. */
      readonly text: string | null;
      /** For `args`: the engine's refusal code and the argument's path. */
      readonly problem?: ArgsProblem;
      readonly problems: readonly string[];
    }
  | { readonly status: "failed"; readonly problems: readonly string[] };

export interface ViewerOutcome {
  /** The views asked for this viewer, as computed for them; a failed view is absent. */
  readonly views: readonly { readonly module: string; readonly view: string; readonly data: Json }[];
}

export interface Resource {
  readonly id: string;
  readonly label: string;
  readonly value: number;
  readonly max: number | null;
}

export interface CharacterInfo {
  readonly module: string;
  readonly id: string;
  readonly name: string;
  readonly blurb: string | null;
  readonly resources: readonly Resource[];
}

export interface RenderOutcome {
  /** One per requested viewer, in request order. */
  readonly viewers: readonly ViewerOutcome[];
  readonly characters: readonly CharacterInfo[];
  readonly clock: ClockInfo | null;
  readonly problems: readonly string[];
}

// ---------------------------------------------------------------- plain-data checks

type Rec = Record<string, unknown>;

/** A plain object: what a JSON object becomes after the worker boundary. */
function isRecord(value: unknown): value is Rec {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function get(value: Rec, key: string): unknown {
  return Object.hasOwn(value, key) ? value[key] : undefined;
}

function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

const MAX_DEPTH = 100;

function isJson(value: unknown, depth = 0): value is Json {
  if (depth > MAX_DEPTH) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) return false;
    for (let i = 0; i < value.length; i++) {
      if (!Object.hasOwn(value, i) || !isJson(value[i], depth + 1)) return false;
    }
    return true;
  }
  if (!isRecord(value)) return false;
  for (const key of Object.keys(value)) if (!isJson(value[key], depth + 1)) return false;
  return true;
}

const encoder = new TextEncoder();

function jsonBytes(value: Json): number {
  return encoder.encode(JSON.stringify(value)).length;
}

/** A string of 1 to `max` code points, or null. */
function shortText(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length > 0 && charCount(value) <= max ? value : null;
}

function moduleOf(value: Rec): string | null {
  const module = get(value, "module");
  return isValidName(module) ? module : null;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

// ---------------------------------------------------------------- the common parts

/** Failures, refusals and broken modules of any exchange's answer, as problems. */
function reportCall(raw: Rec, problems: string[]): void {
  for (const failure of list(get(raw, "failures"))) {
    if (!isRecord(failure)) continue;
    const error = get(failure, "error");
    problems.push(`module ${String(moduleOf(failure))}: ${typeof error === "string" ? error : "failed"}`);
  }
  for (const refusal of list(get(raw, "refused"))) {
    if (!isRecord(refusal)) continue;
    problems.push(`module ${String(moduleOf(refusal))}: fx.${String(get(refusal, "kind"))} dropped in the worker (${String(get(refusal, "reason"))})`);
  }
  for (const module of list(get(raw, "broken"))) {
    problems.push(`module ${String(module)}: its restore failed; the worker is restarted from the checkpoints`);
  }
}

type Kind = "fact" | "inject" | "setVar" | "blocks" | "roll" | "deny" | "log";

interface Sorted extends Applied {
  readonly injections: string[];
  readonly denials: { module: string; callId: string; reason: string }[];
}

const COUNTED = ["fact", "setVar", "blocks", "roll", "log"] as const;

/**
 * Sort a list of raw effects into validated requests, keeping only `accepted` kinds and
 * applying every cap. Counts are per module (per call), except injections (per turn).
 */
function sortEffects(raw: unknown, accepted: ReadonlySet<Kind>, caps: ModuleCaps, problems: string[]): Sorted {
  const out = {
    facts: [] as FactRequest[],
    writes: [] as VariableWriteRequest[],
    blocks: [] as BlocksRequest[],
    rolls: [] as ModuleRoll[],
    logs: [] as ModuleLog[],
    injections: [] as string[],
    denials: [] as { module: string; callId: string; reason: string }[],
  };
  const limits: Record<(typeof COUNTED)[number], number> = {
    fact: caps.facts,
    setVar: caps.writes,
    blocks: caps.blockEmissions,
    roll: caps.rolls,
    log: caps.logs,
  };
  const counts = new Map<string, Record<(typeof COUNTED)[number], number>>();
  for (const effect of list(raw)) {
    if (!isRecord(effect)) {
      problems.push("an effect that is not an object was dropped");
      continue;
    }
    const module = moduleOf(effect);
    const kind = get(effect, "kind");
    if (module === null) {
      problems.push("an effect naming no valid module was dropped");
      continue;
    }
    const drop = (why: string): void => {
      problems.push(`module ${module}: ${String(kind)} dropped, ${why}`);
    };
    if (typeof kind !== "string" || !accepted.has(kind as Kind)) {
      drop("not accepted in this exchange");
      continue;
    }
    if ((COUNTED as readonly string[]).includes(kind)) {
      const counted = kind as (typeof COUNTED)[number];
      const mine = counts.get(module) ?? { fact: 0, setVar: 0, blocks: 0, roll: 0, log: 0 };
      counts.set(module, mine);
      if (mine[counted] >= limits[counted]) {
        drop(`over ${limits[counted]} per call`);
        continue;
      }
      mine[counted] += 1;
    }
    switch (kind as Kind) {
      case "inject": {
        const text = get(effect, "text");
        if (typeof text !== "string") drop("its text is not a string");
        else if (out.injections.length >= caps.injections) drop(`the turn already has ${caps.injections} injections`);
        else if (charCount(text) > caps.injectChars) drop(`longer than ${caps.injectChars} characters`);
        else if (text.trim().length > 0) out.injections.push(text);
        break;
      }
      case "fact": {
        const text = get(effect, "text");
        const data = get(effect, "data");
        const to = get(effect, "to");
        const importance = get(effect, "importance");
        const narrateNow = get(effect, "narrateNow");
        if (text === undefined && data === undefined) drop("it has neither text nor data");
        else if (text !== undefined && typeof text !== "string") drop("its text is not a string");
        else if (typeof text === "string" && charCount(text) > caps.factChars) drop(`its text is longer than ${caps.factChars} characters`);
        else if (data !== undefined && !isJson(data)) drop("its data is not JSON");
        else if (data !== undefined && jsonBytes(data) > caps.factDataBytes) drop(`its data is over ${caps.factDataBytes} bytes`);
        else if ((to !== "table" && to !== "keeper") || (importance !== "low" && importance !== "normal" && importance !== "high")) drop("bad options");
        else if (typeof narrateNow !== "boolean") drop("bad options");
        else out.facts.push({ module, text: typeof text === "string" ? text : null, data: data === undefined ? null : (data as Json), to, importance, narrateNow });
        break;
      }
      case "setVar": {
        const path = shortText(get(effect, "path"), caps.pathChars);
        const value = get(effect, "value");
        if (path === null) drop(`its path is not a string of 1 to ${caps.pathChars} characters`);
        else if (!isJson(value)) drop("its value is not JSON");
        else if (jsonBytes(value) > caps.valueBytes) drop(`its value is over ${caps.valueBytes} bytes`);
        else out.writes.push({ module, path, value });
        break;
      }
      case "blocks": {
        const blocks = get(effect, "blocks");
        const id = get(effect, "id");
        if (!Array.isArray(blocks) || !isJson(blocks)) drop("its blocks are not a JSON list");
        else if (jsonBytes(blocks) > caps.blockBytes) drop(`over ${caps.blockBytes} bytes`);
        else if (id !== undefined && shortText(id, caps.pathChars) === null) drop("bad id");
        else out.blocks.push({ module, blocks, id: typeof id === "string" ? id : null });
        break;
      }
      case "roll": {
        const notation = shortText(get(effect, "notation"), caps.pathChars);
        const label = get(effect, "label");
        const total = get(effect, "total");
        const text = shortText(get(effect, "text"), caps.factChars);
        if (notation === null || text === null || !finite(total)) drop("malformed");
        else if (label !== undefined && shortText(label, caps.titleChars) === null) drop("bad label");
        else out.rolls.push({ module, notation, label: typeof label === "string" ? label : null, total, text });
        break;
      }
      case "deny": {
        const callId = get(effect, "callId");
        const reason = get(effect, "reason");
        if (typeof callId !== "string") drop("its call id is not a string");
        else if (typeof reason !== "string" || charCount(reason) > caps.denyReasonChars) drop(`its reason is not a string of up to ${caps.denyReasonChars} characters`);
        else out.denials.push({ module, callId, reason });
        break;
      }
      case "log": {
        const text = get(effect, "text");
        if (typeof text !== "string" || charCount(text) > caps.logChars) drop(`not a string of up to ${caps.logChars} characters`);
        else out.logs.push({ module, text });
        break;
      }
    }
  }
  return out;
}

function applied(sorted: Sorted): Applied {
  return { facts: sorted.facts, writes: sorted.writes, blocks: sorted.blocks, rolls: sorted.rolls, logs: sorted.logs };
}

const NO_EFFECTS: Applied = { facts: [], writes: [], blocks: [], rolls: [], logs: [] };

const TURN_START = new Set<Kind>(["fact", "inject", "setVar", "blocks", "roll", "log"]);
const TOOL_USE = new Set<Kind>(["deny", "log"]);
const PHASE = new Set<Kind>(["fact", "setVar", "blocks", "roll", "log"]);

function clockInfo(raw: unknown, caps: ModuleCaps, problems: string[], claimer: string | null): ClockInfo | null {
  if (!isRecord(raw)) return null;
  const module = moduleOf(raw);
  if (module === null) return null;
  if (claimer !== null && module !== claimer) {
    problems.push(`module ${module}: a clock reading from a module that does not claim the clock was dropped`);
    return null;
  }
  const error = get(raw, "error");
  if (typeof error === "string") {
    problems.push(`module ${module}: clock() failed — ${error}`);
    return null;
  }
  const reading = get(raw, "reading");
  const time = isRecord(reading) ? shortText(get(reading, "time"), caps.clockChars) : null;
  const round = isRecord(reading) ? get(reading, "round") : undefined;
  if (!isRecord(reading) || time === null || (round !== undefined && !finite(round))) {
    problems.push(`module ${module}: clock reading dropped, not { time: 1 to ${caps.clockChars} characters, round?: number }`);
    return null;
  }
  return { module, time, round: round === undefined ? null : round };
}

// ---------------------------------------------------------------- validation, per exchange

/** The modules' load-time descriptions. A module, command or view that fails a check is left out. */
export function validateLoad(raw: unknown, caps: ModuleCaps = DEFAULT_CAPS): { modules: ModuleInfo[]; problems: string[] } {
  const problems: string[] = [];
  const modules: ModuleInfo[] = [];
  const rawModules = isRecord(raw) ? list(get(raw, "modules")) : [];
  let clockOwner: string | null = null;
  for (const entry of rawModules) {
    if (!isRecord(entry)) continue;
    const id = get(entry, "id");
    if (!isValidName(id)) {
      problems.push(`a module with the unusable id ${JSON.stringify(String(id))} was left out`);
      continue;
    }
    if (modules.some((module) => module.id === id)) {
      problems.push(`module ${id}: a second module with this id was left out`);
      continue;
    }
    const events = get(entry, "events");
    const flag = (key: string): boolean => isRecord(events) && get(events, key) === true;
    let clock = get(entry, "clock") === true;
    if (clock && clockOwner !== null) {
      problems.push(`modules ${clockOwner} and ${id} both claim the room's clock; ${id}'s claim was dropped`);
      clock = false;
    } else if (clock) clockOwner = id;
    modules.push({
      id,
      events: { turnStart: flag("turnStart"), toolUse: flag("toolUse"), replyPhase: flag("replyPhase") },
      commands: validateCommands(id, get(entry, "commands"), caps, problems),
      views: validateViews(id, get(entry, "views"), caps, problems),
      clock,
      characters: get(entry, "characters") === true,
    });
  }
  return { modules, problems };
}

function schemaObject(value: unknown, caps: ModuleCaps): JsonObject | null {
  return isRecord(value) && isJson(value) && jsonBytes(value) <= caps.schemaBytes ? (value as JsonObject) : null;
}

function validateCommands(module: string, raw: unknown, caps: ModuleCaps, problems: string[]): CommandInfo[] {
  const commands: CommandInfo[] = [];
  for (const entry of list(raw)) {
    if (!isRecord(entry)) continue;
    const name = get(entry, "name");
    const drop = (why: string): void => {
      problems.push(`module ${module}: command ${JSON.stringify(String(name))} left out, ${why}`);
    };
    if (!isValidName(name)) {
      drop("not a usable name");
      continue;
    }
    if (commands.some((command) => command.name === name)) {
      drop("declared twice");
      continue;
    }
    if (commands.length >= caps.commands) {
      drop(`the module already has ${caps.commands} commands`);
      continue;
    }
    const title = shortText(get(entry, "title"), caps.titleChars);
    const description = get(entry, "description");
    const params = schemaObject(get(entry, "params"), caps);
    const text = get(entry, "text");
    const role = get(entry, "role");
    const keeper = get(entry, "keeper");
    if (title === null) drop(`its title is not 1 to ${caps.titleChars} characters`);
    else if (description !== null && description !== undefined && (typeof description !== "string" || charCount(description) > caps.descriptionChars)) {
      drop(`its description is not up to ${caps.descriptionChars} characters`);
    } else if (params === null || get(params, "type") !== "object") drop(`its params are not an object schema of up to ${caps.schemaBytes} bytes`);
    else if (
      !Array.isArray(text) ||
      text.length > caps.textForms ||
      !text.every((form) => shortText(form, caps.textFormChars) !== null)
    ) {
      drop(`its text forms are not up to ${caps.textForms} strings of 1 to ${caps.textFormChars} characters`);
    } else if (role !== "player" && role !== "admin" && role !== "keeper") drop("its role is not player, admin or keeper");
    else if (keeper !== true && keeper !== false) drop("its keeper flag is not true or false");
    else if (keeper === false && role === "keeper") drop("a keeper command cannot say keeper: false");
    else {
      const forms: TextForm[] = [];
      for (const source of text as string[]) {
        const read = parseForm(source, params);
        if (read.ok) forms.push(read.form);
        else problems.push(`module ${module}: command ${name}: text form ${JSON.stringify(source)} left out (${read.problem})`);
      }
      commands.push({
        name,
        title,
        description: typeof description === "string" ? description : "",
        params,
        forms,
        role,
        keeper,
        // Strictly `true`: anything else a module sent is not a flag.
        danger: get(entry, "danger") === true,
        checksAvailability: get(entry, "available") === true,
      });
    }
  }
  return commands;
}

function validateViews(module: string, raw: unknown, caps: ModuleCaps, problems: string[]): ViewInfo[] {
  const views: ViewInfo[] = [];
  for (const entry of list(raw)) {
    if (!isRecord(entry)) continue;
    const name = get(entry, "name");
    const drop = (why: string): void => {
      problems.push(`module ${module}: view ${JSON.stringify(String(name))} left out, ${why}`);
    };
    const title = get(entry, "title");
    const schema = schemaObject(get(entry, "schema"), caps);
    if (!isValidName(name)) drop("not a usable name");
    else if (views.some((view) => view.name === name)) drop("declared twice");
    else if (views.length >= caps.views) drop(`the module already has ${caps.views} views`);
    else if (title !== null && title !== undefined && shortText(title, caps.titleChars) === null) drop(`its title is not 1 to ${caps.titleChars} characters`);
    else if (schema === null) drop(`its schema is not a JSON object of up to ${caps.schemaBytes} bytes`);
    else views.push({ name, title: typeof title === "string" ? title : null, schema });
  }
  return views;
}

export function validateTurnStart(raw: unknown, caps: ModuleCaps = DEFAULT_CAPS, modules?: readonly ModuleInfo[]): TurnStartOutcome {
  const problems: string[] = [];
  if (!isRecord(raw)) return { ...NO_EFFECTS, injections: [], clock: null, problems: ["the worker's turn-start answer is not an object"] };
  reportCall(raw, problems);
  const sorted = sortEffects(get(raw, "effects"), TURN_START, caps, problems);
  const claimer = modules ? (modules.find((module) => module.clock)?.id ?? "") : null;
  return { ...applied(sorted), injections: sorted.injections, clock: clockInfo(get(raw, "clock"), caps, problems, claimer), problems };
}

/** The veto of one tool round: every call gets a verdict, in the order of `calls`. */
export function validateToolUse(raw: unknown, calls: readonly { readonly id: string }[], caps: ModuleCaps = DEFAULT_CAPS): ToolUseOutcome {
  const problems: string[] = [];
  const denials = new Map<string, { module: string; reason: string }[]>();
  let logs: ModuleLog[] = [];
  if (isRecord(raw)) {
    reportCall(raw, problems);
    const sorted = sortEffects(get(raw, "effects"), TOOL_USE, caps, problems);
    logs = sorted.logs as ModuleLog[];
    const ids = new Set(calls.map((call) => call.id));
    for (const denial of sorted.denials) {
      if (!ids.has(denial.callId)) {
        problems.push(`module ${denial.module}: a denial of the unknown call ${JSON.stringify(denial.callId)} was dropped`);
        continue;
      }
      const forCall = denials.get(denial.callId) ?? [];
      forCall.push({ module: denial.module, reason: denial.reason });
      denials.set(denial.callId, forCall);
    }
  } else {
    problems.push("the worker's tool-use answer is not an object");
  }
  const verdicts = calls.map((call): ToolVerdict => {
    const forCall = denials.get(call.id);
    return forCall ? { allowed: false, denials: forCall } : { allowed: true };
  });
  return { verdicts, logs, problems };
}

export function validateReplyPhase(raw: unknown, caps: ModuleCaps = DEFAULT_CAPS): ReplyPhaseOutcome {
  const problems: string[] = [];
  if (!isRecord(raw)) return { ...NO_EFFECTS, problems: ["the worker's reply-phase answer is not an object"] };
  reportCall(raw, problems);
  return { ...applied(sortEffects(get(raw, "effects"), PHASE, caps, problems)), problems };
}

export function validateCommand(raw: unknown, caps: ModuleCaps = DEFAULT_CAPS): CommandOutcome {
  const problems: string[] = [];
  if (!isRecord(raw)) return { status: "failed", problems: ["the worker's command answer is not an object"] };
  reportCall(raw, problems);
  const outcome = get(raw, "outcome");
  const status = isRecord(outcome) ? get(outcome, "status") : undefined;
  if (!isRecord(outcome) || status === "failed") {
    if (!isRecord(outcome)) problems.push("the worker's command answer has no outcome");
    return { status: "failed", problems };
  }
  if (status === "refused") {
    const reason = get(outcome, "reason");
    if (reason === "unknown" || reason === "role") return { status: "refused", reason, text: null, problems };
    if (reason === "unavailable") {
      const text = get(outcome, "text");
      const shown = shortText(text, caps.unavailableReasonChars);
      if (shown === null) problems.push(`a reason for unavailability that is not 1 to ${caps.unavailableReasonChars} characters was dropped`);
      return { status: "refused", reason, text: shown, problems };
    }
    problems.push("the worker's command answer has an unknown refusal");
    return { status: "failed", problems };
  }
  if (status !== "ok") {
    problems.push("the worker's command answer has an unknown status");
    return { status: "failed", problems };
  }
  const result = get(outcome, "result");
  let text: string | null = null;
  let data: Json | null = null;
  if (isRecord(result)) {
    const rawText = get(result, "text");
    const rawData = get(result, "data");
    if (rawText !== undefined) {
      if (typeof rawText === "string" && charCount(rawText) <= caps.commandTextChars) text = rawText;
      else problems.push(`the command's text was dropped, not a string of up to ${caps.commandTextChars} characters`);
    }
    if (rawData !== undefined) {
      if (isJson(rawData) && jsonBytes(rawData) <= caps.commandDataBytes) data = rawData;
      else problems.push(`the command's data was dropped, not JSON of up to ${caps.commandDataBytes} bytes`);
    }
  } else {
    problems.push("the command's result is not an object and was dropped");
  }
  const sorted = sortEffects(get(raw, "effects"), PHASE, caps, problems);
  return { status: "ok", result: { text, data }, ...applied(sorted), problems };
}

/**
 * The read-only outputs, for each viewer. `modules` (from `validateLoad`) decides what is
 * rendered at all: a view the engine left out at load is never shown, nor one the viewer
 * did not ask for.
 */
export function validateRender(raw: unknown, viewers: readonly ViewerRequest[], modules: readonly ModuleInfo[], caps: ModuleCaps = DEFAULT_CAPS): RenderOutcome {
  const problems: string[] = [];
  const answer = isRecord(raw) ? raw : {};
  if (!isRecord(raw)) problems.push("the worker's render answer is not an object");
  reportCall(answer, problems);
  for (const notice of list(get(answer, "notices"))) {
    if (!isRecord(notice) || get(notice, "code") !== "read_changed_state") continue;
    problems.push(`module ${String(moduleOf(notice))}: read_changed_state — reading its views changed its state (save() differed from its checkpoint); the render was used, and reads must not change state`);
  }
  const rawViewers = list(get(answer, "viewers"));
  if (rawViewers.length !== viewers.length) problems.push(`the worker rendered ${rawViewers.length} viewers, not ${viewers.length}`);

  const outcomes = viewers.map((viewer, index): ViewerOutcome => {
    const rendered = rawViewers[index];
    const rawViews = isRecord(rendered) ? list(get(rendered, "views")) : [];
    const find = (module: string, name: string): Rec | null => {
      for (const entry of rawViews) if (isRecord(entry) && get(entry, "module") === module && get(entry, "view") === name) return entry;
      return null;
    };
    const asked = (module: string, name: string): boolean => viewer.views.some((ref) => ref.module === module && ref.view === name);
    const views: { module: string; view: string; data: Json }[] = [];
    for (const module of modules) {
      for (const view of module.views) {
        if (!asked(module.id, view.name)) continue;
        const entry = find(module.id, view.name);
        if (entry === null) continue;
        const error = get(entry, "error");
        const data = get(entry, "data");
        if (typeof error === "string") problems.push(`module ${module.id}: view ${view.name} failed — ${error}`);
        else if (!isJson(data)) problems.push(`module ${module.id}: view ${view.name} dropped, not JSON`);
        else if (jsonBytes(data) > caps.viewBytes) problems.push(`module ${module.id}: view ${view.name} dropped, over ${caps.viewBytes} bytes`);
        else views.push({ module: module.id, view: view.name, data });
      }
    }
    return { views };
  });

  const characters: CharacterInfo[] = [];
  for (const module of modules) {
    if (!module.characters) continue;
    const entry = list(get(answer, "characters")).find((candidate) => isRecord(candidate) && get(candidate, "module") === module.id);
    if (!isRecord(entry)) continue;
    const error = get(entry, "error");
    if (typeof error === "string") {
      problems.push(`module ${module.id}: characters() failed — ${error}`);
      continue;
    }
    characters.push(...validateCharacters(module.id, get(entry, "characters"), caps, problems));
  }
  const claimer = modules.find((module) => module.clock)?.id ?? "";
  return { viewers: outcomes, characters, clock: clockInfo(get(answer, "clock"), caps, problems, claimer), problems };
}

function validateCharacters(module: string, raw: unknown, caps: ModuleCaps, problems: string[]): CharacterInfo[] {
  if (!Array.isArray(raw)) {
    problems.push(`module ${module}: characters() did not answer a list`);
    return [];
  }
  const out: CharacterInfo[] = [];
  for (const entry of raw as unknown[]) {
    if (out.length >= caps.characters) {
      problems.push(`module ${module}: characters past the first ${caps.characters} were dropped`);
      break;
    }
    const id = isRecord(entry) ? shortText(get(entry, "id"), caps.characterTextChars) : null;
    const name = isRecord(entry) ? shortText(get(entry, "name"), caps.characterTextChars) : null;
    if (!isRecord(entry) || id === null || name === null) {
      problems.push(`module ${module}: a character without an id and a name of 1 to ${caps.characterTextChars} characters was dropped`);
      continue;
    }
    if (out.some((character) => character.id === id)) {
      problems.push(`module ${module}: a second character with the id ${JSON.stringify(id)} was dropped`);
      continue;
    }
    const blurb = get(entry, "blurb");
    if (blurb !== undefined && (typeof blurb !== "string" || charCount(blurb) > caps.blurbChars)) {
      problems.push(`module ${module}: character ${id} dropped, its blurb is not up to ${caps.blurbChars} characters`);
      continue;
    }
    const resources: Resource[] = [];
    for (const resource of list(get(entry, "resources"))) {
      const rid = isRecord(resource) ? shortText(get(resource, "id"), caps.characterTextChars) : null;
      const label = isRecord(resource) ? shortText(get(resource, "label"), caps.characterTextChars) : null;
      const value = isRecord(resource) ? get(resource, "value") : undefined;
      const max = isRecord(resource) ? get(resource, "max") : undefined;
      if (resources.length >= caps.resources) problems.push(`module ${module}: character ${id}: resources past ${caps.resources} dropped`);
      else if (rid === null || label === null || !finite(value) || (max !== undefined && !finite(max))) {
        problems.push(`module ${module}: character ${id}: a malformed resource was dropped`);
      } else resources.push({ id: rid, label, value, max: max === undefined ? null : max });
    }
    out.push({ module, id, name, blurb: typeof blurb === "string" ? blurb : null, resources });
  }
  return out;
}

// ---------------------------------------------------------------- exchanges

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The snapshot as it may be sent. Variables that are not a JSON object, or are larger than
 * `caps.variablesBytes`, go out as `{}`: the worker copies the snapshot for every module
 * and every call, so its size must stay bounded whatever the room has grown into.
 */
export function boundedSnapshot<T extends RoomSnapshot>(room: T, caps: ModuleCaps, problems: string[]): T {
  let bounded = room;
  if (room.members.length > MAX_ROOM_MEMBERS) {
    problems.push(`the room has ${room.members.length} members; the modules were sent the first ${MAX_ROOM_MEMBERS}`);
    bounded = { ...bounded, members: room.members.slice(0, MAX_ROOM_MEMBERS) };
  }
  const variables: unknown = room.variables;
  if (isRecord(variables) && isJson(variables) && jsonBytes(variables) <= caps.variablesBytes) return bounded;
  problems.push(`the room's variables were not sent to the modules: not a JSON object of up to ${caps.variablesBytes} bytes`);
  return { ...bounded, variables: {} };
}

// The validated descriptions per worker, redone only when the worker reports new ones,
// so load-time problems reach the operator's log once, not on every exchange.
const accepted = new WeakMap<RoomWorker, { readonly source: unknown; readonly modules: ModuleInfo[] }>();

function acceptedModules(worker: RoomWorker, caps: ModuleCaps): { modules: ModuleInfo[]; problems: string[] } {
  const source = worker.descriptions;
  const cached = accepted.get(worker);
  if (cached && cached.source === source) return { modules: cached.modules, problems: [] };
  const validated = validateLoad({ modules: source ?? [] }, caps);
  if (source !== null) accepted.set(worker, { source, modules: validated.modules });
  // Reported with the load they belong to, once: a module that cannot be loaded stays
  // unloadable on every later turn, and saying so each time buries the operator's log.
  return { modules: validated.modules, problems: [...(worker.loadProblems ?? []).map((line) => `a module was not loaded — ${line}`), ...validated.problems] };
}

/**
 * The loaded modules as the engine accepts them when the worker has ever loaded them, without
 * waiting: null before the first load. `problems` as `describeModules`'.
 */
export function describedModules(worker: RoomWorker | null, caps: ModuleCaps = DEFAULT_CAPS): { modules: ModuleInfo[]; problems: string[] } | null {
  if (worker === null) return { modules: [], problems: [] };
  if (worker.descriptions === null) return null;
  return acceptedModules(worker, caps);
}

/**
 * The loaded modules as the engine accepts them, loading the modules if they never were.
 * `problems` lists what was left out, the first time only.
 */
export async function describeModules(worker: RoomWorker | null, caps: ModuleCaps = DEFAULT_CAPS): Promise<{ modules: ModuleInfo[]; problems: string[] }> {
  if (worker === null) return { modules: [], problems: [] };
  try {
    await worker.describe();
  } catch (error) {
    return { modules: [], problems: [message(error)] };
  }
  return acceptedModules(worker, caps);
}

export async function dispatchTurnStart(worker: RoomWorker | null, event: TurnStartEvent, caps: ModuleCaps = DEFAULT_CAPS): Promise<TurnStartOutcome> {
  if (worker === null) return { ...NO_EFFECTS, injections: [], clock: null, problems: [] };
  try {
    const sent: string[] = [];
    const raw = await worker.turnStart(boundedSnapshot(event, caps, sent));
    const described = acceptedModules(worker, caps);
    const outcome = validateTurnStart(raw, caps, described.modules);
    return { ...outcome, problems: [...sent, ...described.problems, ...outcome.problems] };
  } catch (error) {
    return { ...NO_EFFECTS, injections: [], clock: null, problems: [message(error)] };
  }
}

/** One tool round's veto. With no worker, or when the exchange fails, every call is allowed. */
export async function dispatchToolUse(worker: RoomWorker | null, event: ToolUseEvent, caps: ModuleCaps = DEFAULT_CAPS): Promise<ToolUseOutcome> {
  const allowAll: ToolVerdict[] = event.calls.map(() => ({ allowed: true }));
  if (worker === null) return { verdicts: allowAll, logs: [], problems: [] };
  try {
    const sent: string[] = [];
    const outcome = validateToolUse(await worker.toolUse(boundedSnapshot(event, caps, sent)), event.calls, caps);
    return { ...outcome, problems: [...sent, ...outcome.problems] };
  } catch (error) {
    return { verdicts: allowAll, logs: [], problems: [message(error)] };
  }
}

export async function dispatchReplyPhase(worker: RoomWorker | null, event: ReplyPhaseEvent, caps: ModuleCaps = DEFAULT_CAPS): Promise<ReplyPhaseOutcome> {
  if (worker === null) return { ...NO_EFFECTS, problems: [] };
  try {
    const sent: string[] = [];
    const outcome = validateReplyPhase(await worker.replyPhase(boundedSnapshot(event, caps, sent)), caps);
    return { ...outcome, problems: [...sent, ...outcome.problems] };
  } catch (error) {
    return { ...NO_EFFECTS, problems: [message(error)] };
  }
}

export interface CommandCall {
  readonly module: string;
  readonly command: string;
  /** Raw arguments: checked here to be a JSON object within `caps.argsBytes`. */
  readonly args: unknown;
  /** The member the action belongs to: when the Keeper runs it, the member who spoke this turn. */
  readonly who: Who;
  /** Who is running it: the Keeper (`run_command`) or the member in `who`. The role is checked against this. */
  readonly by: CommandOrigin["by"];
  readonly seed: string;
  /** The room when the command is used. */
  readonly room: RoomSnapshot;
}

/**
 * One command. Refused here, without a round trip, when the engine does not know the
 * command (including one left out at load), the role forbids it, the arguments are not a
 * JSON object, or they do not fit the command's `params`; the worker then checks `available`
 * at the moment of use. The role rule (`mayRun`): a member may run what their role allows,
 * never a `keeper` command but as an admin; the Keeper may run `player` and `keeper` commands
 * whoever spoke, never an `admin` one nor one that declared `keeper: false`.
 */
export async function dispatchCommand(worker: RoomWorker | null, call: CommandCall, caps: ModuleCaps = DEFAULT_CAPS): Promise<CommandOutcome> {
  const described = await describeModules(worker, caps);
  const problems = described.problems;
  const command = described.modules.find((module) => module.id === call.module)?.commands.find((candidate) => candidate.name === call.command);
  if (worker === null || command === undefined) return { status: "refused", reason: "unknown", text: null, problems };
  if (!mayRun(command.role, call.by, call.who, command.keeper)) return { status: "refused", reason: "role", text: null, problems };
  if (!isRecord(call.args) || !isJson(call.args) || jsonBytes(call.args) > caps.argsBytes) {
    return { status: "refused", reason: "invalid", text: null, problems };
  }
  const problem = checkModuleArgs(command.params, call.args);
  if (problem !== null) return { status: "refused", reason: "args", text: null, problem, problems };
  try {
    const room = boundedSnapshot(call.room, caps, problems);
    const raw = await worker.command({ module: call.module, command: call.command, args: call.args as JsonObject, who: call.who, by: call.by, seed: call.seed, room });
    const outcome = validateCommand(raw, caps);
    return { ...outcome, problems: [...problems, ...outcome.problems] };
  } catch (error) {
    return { status: "failed", problems: [...problems, message(error)] };
  }
}

/** The read-only outputs for these viewers (each with the views they asked for), all seeing the same `room`. */
export async function dispatchRender(
  worker: RoomWorker | null,
  viewers: readonly ViewerRequest[],
  room: RoomSnapshot,
  caps: ModuleCaps = DEFAULT_CAPS,
): Promise<RenderOutcome> {
  const empty = (problems: string[]): RenderOutcome => ({ viewers: viewers.map(() => ({ views: [] })), characters: [], clock: null, problems });
  if (worker === null) return empty([]);
  const described = await describeModules(worker, caps);
  try {
    const bounded = boundedSnapshot(room, caps, described.problems);
    const outcome = validateRender(await worker.render(viewers, bounded), viewers, described.modules, caps);
    return { ...outcome, problems: [...described.problems, ...outcome.problems] };
  } catch (error) {
    return empty([...described.problems, message(error)]);
  }
}
