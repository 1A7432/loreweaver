// Checks, shaped by the room's rule pack: `check` (and the pack's own check words),
// `opposed`, the pack's subsystem words (a sanity check, an experience roll, a madness
// table), `init`, and making a character with a pack's creation word (`.coc`, `.dnd`).
//
// A check reads the stat it rolls against from the caller's sheet; the roll and its grade
// are table events, labelled in the room's language.
import type { DiceData } from "loreweaver-protocol/v3";

import type { RoomContext } from "../../../agent/context.ts";
import { type Character, createCharacter, switchCharacter, type SheetWrite, updateSheet } from "../../../core/characters/index.ts";
import {
  actingCombatant,
  addCombatant,
  type Initiative,
  initiativeData,
  INITIATIVE_ID,
  INITIATIVE_TYPE,
  type InitiativeView,
  nextTurn,
  NO_FIGHT,
  readInitiative,
  removeCombatant,
  rollInitiative,
} from "../../../core/clock/index.ts";
import { renderRoll } from "../../../core/dice/index.ts";
import { type CheckOutcome, favorModifiers, type PerformedCheck, performCheck, type Resolution } from "../../../core/resolution/index.ts";
import { commandWord, type CommandBinding, type RulePack, subsystemName, tableName } from "../../../core/rulepacks/index.ts";
import { displayName, generateCharacter, resolveName, type Sheet, type SheetViolation } from "../../../core/sheets/index.ts";
import { foldCase, stripSpace } from "../../../core/sheets/text.ts";
import { findTable, lookupStat, runSubsystem, type SubsystemSpec, type TableDrawSpec } from "../../../core/subsystems/index.ts";
import { compact, integer, object, oneOf, type ObjectSchema, type Schema, text, BOOLEAN } from "../schema.ts";
import { firstWord, parseInteger } from "../parse.ts";
import {
  actorName,
  callerCharacter,
  callerViewer,
  memberIdOf,
  readDocument,
  saveCharacter,
  saveSeating,
  seating,
  type StoredCharacter,
  tableCharacterNames,
  wireOutcome,
  facesOf,
  putDocument,
} from "../support.ts";
import { ROOM_RULE_PACK } from "../state.ts";
import { type Args, type CommandCall, type CommandEvent, type CommandSpec, type Done, isRefused, refuse, type Refused, type TextForms } from "../types.ts";
import { DISFAVOR_WORDS, FAVOR_WORDS, splitRepeat } from "./dice.ts";

/** Words that mark a check as proficient (game vocabulary). */
const PROFICIENT_WORDS: ReadonlySet<string> = new Set(["prof", "proficient", "proficiency", "熟练", "熟練"]);
/** Bounds on a check's numbers: generous, but every number is bounded. */
const MAX_TARGET = 1_000_000;
const MAX_FAVOR = 10;
const MAX_REPEAT = 20;
const MAX_SKILL_CHARS = 100;
const MAX_ROLL_PARAMS = 16;

// ---------------------------------------------------------------------------
// Reading a check's text
// ---------------------------------------------------------------------------

/** One check's arguments as the text form gives them. */
export interface CheckText {
  skill?: string;
  target?: number;
  difficulty?: string;
  bonus?: number;
  penalty?: number;
  proficient?: boolean;
  params?: Record<string, number>;
}

const BONUS = /^([bp])(\d{0,2})$/u;
const TRAILING_NUMBER = /^([\s\S]+?)(\d{1,7})$/u;
const NUMBER_ONLY = /^\d{1,7}$/u;
const PARAM = /^([^=\s]+)=([+-]?\d{1,9})$/u;

function isAscii(character: string): boolean {
  return character.charCodeAt(0) < 0x80;
}

/** Leading `b`, `b2`, `p`, `p1` tokens (and a `b`/`p` glued to a CJK name) as counts. */
function consumeBonusPenalty(text: string, out: CheckText): string {
  let rest = text.trim();
  for (;;) {
    const [word, after] = firstWord(rest);
    if (word === "") return rest;
    const match = BONUS.exec(word);
    if (match !== null) {
      const count = match[2] === "" ? 1 : Number(match[2]);
      if (match[1] === "b") out.bonus = (out.bonus ?? 0) + count;
      else out.penalty = (out.penalty ?? 0) + count;
      rest = after;
      continue;
    }
    const head = word[0];
    const second = [...word][1];
    if ((head === "b" || head === "p") && second !== undefined && !isAscii(second)) {
      if (head === "b") out.bonus = (out.bonus ?? 0) + 1;
      else out.penalty = (out.penalty ?? 0) + 1;
      rest = rest.trimStart().slice(1);
      continue;
    }
    return rest;
  }
}

/** A leading difficulty word, in the pack's own vocabulary (the engine holds none). */
function consumeDifficulty(text: string, resolution: Resolution | null, out: CheckText): string {
  const rest = text.trim();
  if (resolution === null) return rest;
  const [word, after] = firstWord(rest);
  for (const difficulty of resolution.difficulties.values()) {
    for (const words of difficulty.prefixes.values()) {
      for (const prefix of words) {
        if (prefix === "") continue;
        if ([...prefix].every(isAscii)) {
          if (word === foldCase(prefix)) {
            out.difficulty = difficulty.id;
            return after;
          }
        } else if (rest.startsWith(prefix)) {
          out.difficulty = difficulty.id;
          return rest.slice(prefix.length).trim();
        }
      }
    }
  }
  return rest;
}

/**
 * A check's argument text, read against the room's rule pack: `b`/`p` counts, a difficulty
 * word the pack declares, advantage/disadvantage/proficiency words, `name=N` for a roll
 * parameter the pack declares, and a number glued to or after the skill name as the
 * target for this check (`侦查60`, `spot 60`). A number alone is a target with no skill.
 */
export function parseCheckText(text: string, pack: RulePack | null): CheckText {
  const out: CheckText = {};
  const resolution = pack?.resolution ?? null;
  let rest = consumeBonusPenalty(text, out);
  rest = consumeDifficulty(rest, resolution, out);
  rest = consumeBonusPenalty(rest, out);
  const kept: string[] = [];
  for (const token of rest.split(/\s+/u)) {
    if (token === "") continue;
    const word = foldCase(token);
    const param = PARAM.exec(token);
    if (FAVOR_WORDS.has(word)) out.bonus = (out.bonus ?? 0) + 1;
    else if (DISFAVOR_WORDS.has(word)) out.penalty = (out.penalty ?? 0) + 1;
    else if (PROFICIENT_WORDS.has(word)) out.proficient = true;
    else if (param !== null && resolution?.params.has(param[1] as string) === true) {
      out.params = { ...(out.params ?? {}), [param[1] as string]: Number(param[2]) };
    } else kept.push(token);
  }
  const name = kept.join(" ").trim();
  if (NUMBER_ONLY.test(name)) {
    out.target = Number(name);
    return out;
  }
  const match = TRAILING_NUMBER.exec(name);
  if (match !== null && !NUMBER_ONLY.test((match[1] as string).trim())) {
    out.skill = (match[1] as string).trim();
    out.target = Number(match[2]);
  } else if (name !== "") {
    out.skill = name;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The check command
// ---------------------------------------------------------------------------

const ROLL_PARAMS: ObjectSchema = { type: "object", properties: {}, additionalProperties: integer(-MAX_TARGET, MAX_TARGET), maxProperties: MAX_ROLL_PARAMS };

const CHECK_FIELDS: Readonly<Record<string, Schema>> = {
  skill: text(MAX_SKILL_CHARS, 1),
  target: integer(-MAX_TARGET, MAX_TARGET),
  difficulty: text(64, 1),
  bonus: integer(0, MAX_FAVOR),
  penalty: integer(0, MAX_FAVOR),
  mode: oneOf(["adv", "dis"]),
  proficient: BOOLEAN,
  params: ROLL_PARAMS,
};

/** The pack a caller's check is ruled by: their character's, else the room's. */
function checkPack(call: CommandCall, character: StoredCharacter | null): RulePack | null {
  return character?.pack ?? call.context.pack;
}

/** The caller's character, or null for a spectator (a refusal only when it cannot be read). */
function optionalCharacter(call: CommandCall): StoredCharacter | null | Refused {
  const found = callerCharacter(call);
  if (!isRefused(found)) return found;
  return found.refused === "no_character" ? null : found;
}

function pairs(map: ReadonlyMap<string, number>): [string, number][] {
  return [...map];
}

function checkEvent(call: CommandCall, pack: RulePack, performed: PerformedCheck, label: string | null, modifier: number, kind: "check" | "subsystem"): DiceData {
  const rolled = performed.rolled;
  const data: { -readonly [K in keyof DiceData]: DiceData[K] } = {
    actor: actorName(call.context),
    kind,
    expr: rolled.notation,
    rolls: rolled.percentile !== null ? [rolled.percentile.total] : rolled.roll !== null ? facesOf(rolled.roll) : [rolled.total],
    total: performed.total,
    detail: {
      ...(label === null ? {} : { skill: label }),
      modifier,
      modifiers: pairs(rolled.modifiers),
      params: pairs(rolled.params),
      ...(rolled.percentile === null ? {} : { tens: [rolled.percentile.tens, ...rolled.percentile.extraTens] }),
      ...(performed.outcome?.variant ? { variant: performed.outcome.variant } : {}),
    },
  };
  const outcome = performed.outcome;
  if (outcome !== null) {
    if (outcome.target !== null) data.target = outcome.target;
    if (outcome.effectiveTarget !== null) data.effectiveTarget = outcome.effectiveTarget;
    data.outcome = wireOutcome(pack, outcome, call.context.locale);
  }
  return data;
}

function favorCounts(args: Args): readonly [number, number] {
  const mode = args.mode as "adv" | "dis" | undefined;
  return [((args.bonus as number | undefined) ?? 0) + (mode === "adv" ? 1 : 0), ((args.penalty as number | undefined) ?? 0) + (mode === "dis" ? 1 : 0)];
}

function statLabel(pack: RulePack, name: string, locale: string): string {
  return displayName(pack.sheet, resolveName(pack.sheet, name) ?? stripSpace(name), locale);
}

/** A stat the caller's check rolls on, refused when nothing knows the name. */
function readStat(pack: RulePack, sheet: Sheet, name: string): number | Refused {
  const found = lookupStat(pack.sheet, sheet, name, true);
  if (found.ok) return found.value;
  return refuse(found.reason === "unknown" ? "unknown_skill" : "not_numeric", { skill: name });
}

function runCheck(call: CommandCall, args: Args): Done | Refused {
  const character = optionalCharacter(call);
  if (isRefused(character)) return character;
  const pack = checkPack(call, character);
  const resolution = pack?.resolution ?? null;
  if (pack === null || resolution === null) return refuse("no_rule_system");
  const explicit = args.target as number | undefined;
  const skill = (args.skill as string | undefined) ?? (explicit === undefined ? (resolution.check.defaultSkill ?? undefined) : undefined);
  const difficulty = args.difficulty as string | undefined;
  if (difficulty !== undefined && !resolution.difficulties.has(difficulty)) return refuse("unknown_difficulty", { difficulty });

  let target: number | null = null;
  let modifier = 0;
  if (resolution.targetKind === "skill") {
    if (explicit !== undefined) target = explicit;
    else {
      if (skill === undefined) return refuse("missing_arg", { path: "skill" });
      if (character === null) return refuse("no_character");
      const value = readStat(pack, character.character.sheet, skill);
      if (typeof value !== "number") return value;
      target = value;
    }
  } else if (resolution.targetKind === "dc") {
    target = explicit ?? null;
    if (skill !== undefined) {
      if (character === null) return refuse("no_character");
      const value = readStat(pack, character.character.sheet, skill);
      if (typeof value !== "number") return value;
      modifier = value;
      const proficiency = resolution.check.proficiency;
      if (args.proficient === true && proficiency !== null) {
        const bonus = readStat(pack, character.character.sheet, proficiency);
        if (typeof bonus !== "number") return bonus;
        modifier += bonus;
      }
    }
  }

  const [favorable, unfavorable] = favorCounts(args);
  const favor = favorModifiers(resolution.check, favorable, unfavorable);
  if (favorable !== unfavorable && favor.applied === null) return refuse("no_modifier");
  const label = skill === undefined ? null : statLabel(pack, skill, call.context.locale);
  const events: CommandEvent[] = [];
  const times = (args.repeat as number | undefined) ?? 1;
  for (let index = 0; index < times; index++) {
    const performed = performCheck(resolution, call.context.random, {
      modifiers: favor.modifiers,
      params: (args.params as Record<string, number> | undefined) ?? null,
      target,
      modifier,
      variant: call.context.variant,
      difficulty: difficulty ?? null,
    });
    events.push({ kind: "dice", data: checkEvent(call, pack, performed, label, modifier, "check") });
  }
  return { events };
}

/** The check words of the room's pack that the engine's own forms do not already hold. */
function packCheckWords(context: RoomContext): string[] {
  const pack = context.pack;
  if (pack === null) return [];
  return [...pack.commands].filter(([, binding]) => binding.kind === "action" && binding.action === "check").map(([word]) => word);
}

const CHECK_FORMS: TextForms = { en: ["check", "attack", "cast", "ra", "rc"], zh: ["ra", "rc"] };

export const checkCommand: CommandSpec = {
  id: "check",
  source: "engine",
  key: "check",
  params: object({ ...CHECK_FIELDS, repeat: integer(1, MAX_REPEAT) }),
  text(context) {
    const words = packCheckWords(context);
    const extend = (base: readonly string[]): string[] => [...base, ...words.filter((word) => !base.includes(word))];
    return { en: extend(CHECK_FORMS.en), zh: extend(CHECK_FORMS.zh) };
  },
  role: "player",
  available: (context) => (context.pack?.resolution ? true : "no_rule_system"),
  parseText(rest, call) {
    const [repeat, body] = splitRepeat(rest);
    return compact({ ...parseCheckText(body, call.context.pack), repeat: repeat ?? undefined });
  },
  run: runCheck,
};

// ---------------------------------------------------------------------------
// Opposed checks
// ---------------------------------------------------------------------------

const SIDE: ObjectSchema = object({ skill: text(MAX_SKILL_CHARS, 1), value: integer(-MAX_TARGET, MAX_TARGET), bonus: integer(0, MAX_FAVOR), penalty: integer(0, MAX_FAVOR) });

function opposedSubsystem(pack: RulePack | null): string | null {
  if (pack === null || pack.resolution === null) return null;
  for (const spec of pack.subsystems.values()) if (spec.template === "opposed") return spec.id;
  return null;
}

function sideArgs(text: string, pack: RulePack | null): Args {
  const parsed = parseCheckText(text, pack);
  return compact({ skill: parsed.skill, value: parsed.target, bonus: parsed.bonus, penalty: parsed.penalty });
}

function runOpposed(call: CommandCall, args: Args, subsystem: string | null): Done | Refused {
  const character = optionalCharacter(call);
  if (isRefused(character)) return character;
  const pack = checkPack(call, character);
  const id = subsystem ?? opposedSubsystem(pack);
  const resolution = pack?.resolution ?? null;
  if (pack === null || resolution === null || id === null || !pack.subsystems.has(id)) return refuse("not_in_system", { word: call.word ?? "opposed" });
  const a = args.a as Args;
  const b = (args.b as Args | undefined) ?? {};
  const fallback = resolution.check.defaultSkill ?? "";
  const aSkill = (a.skill as string | undefined) ?? fallback;
  const bSkill = (b.skill as string | undefined) ?? aSkill;
  const side = (given: Args, skill: string) => {
    const favor = favorModifiers(resolution.check, (given.bonus as number | undefined) ?? 0, (given.penalty as number | undefined) ?? 0);
    return {
      skill,
      sheet: character?.character.sheet ?? null,
      value: (given.value as number | undefined) ?? null,
      modifiers: favor.modifiers,
    };
  };
  const activeSide = side(a, aSkill);
  const passiveSide = side(b, bSkill);
  if (character === null && (activeSide.value === null || passiveSide.value === null)) return refuse("no_character");
  const result = runSubsystem(pack, id, { template: "opposed", active: activeSide, passive: passiveSide, variant: call.context.variant }, call.context.random);
  if (!result.ok) {
    if ("refusal" in result && (result.refusal === "unknown_skill" || result.refusal === "not_numeric")) {
      return refuse(result.refusal, { skill: "skill" in result ? result.skill : "" });
    }
    return refuse("roll_failed", { code: "refusal" in result ? result.refusal : "" });
  }
  if (!("settle" in result)) return refuse("roll_failed", { code: "template" });
  const locale = call.context.locale;
  const sideView = (entry: typeof result.active) => ({
    skill: statLabel(pack, entry.skill, locale),
    value: entry.value,
    total: entry.total,
    ...(entry.outcome === null ? {} : { outcome: wireOutcome(pack, entry.outcome, locale) }),
  });
  const winner = result.winner === "active" ? "a" : result.winner === "passive" ? "b" : "tie";
  const data: { -readonly [K in keyof DiceData]: DiceData[K] } = {
    actor: actorName(call.context),
    kind: "opposed",
    subsystem: id,
    subsystemLabel: subsystemName(pack.subsystems.get(id) as SubsystemSpec, locale),
    expr: result.active.check.notation,
    rolls: [result.active.check.total, result.passive.check.total],
    total: result.active.total,
    detail: { winner, decidedBy: result.decidedBy, settle: result.settle, a: sideView(result.active), b: sideView(result.passive) },
  };
  if (result.active.outcome !== null) data.outcome = wireOutcome(pack, result.active.outcome, locale);
  return { data: { winner }, events: [{ kind: "dice", data }] };
}

function splitSides(text: string): readonly [string, string] {
  const at = text.search(/[,，、]/u);
  if (at >= 0) return [text.slice(0, at).trim(), text.slice(at + 1).trim()];
  const [first, rest] = [text.trim().split(/\s+/u)[0] ?? "", text.trim().split(/\s+/u).slice(1).join(" ")];
  return [first, rest];
}

export const opposedCommand: CommandSpec = {
  id: "opposed",
  source: "engine",
  key: "opposed",
  params: object({ a: SIDE, b: SIDE }, ["a"]),
  text: { en: ["opposed", "rav", "rcv"], zh: ["rav", "rcv"] },
  role: "player",
  available: (context) => (opposedSubsystem(context.pack) !== null ? true : "not_in_system"),
  parseText(rest, call) {
    const [left, right] = splitSides(rest);
    return compact({ a: sideArgs(left, call.context.pack), b: right === "" ? undefined : sideArgs(right, call.context.pack) });
  },
  run: (call, args) => runOpposed(call, args, null),
};

// ---------------------------------------------------------------------------
// The pack's subsystem words
// ---------------------------------------------------------------------------

/** The templates a command word can run. `resource_spend_adjust` needs a recorded check to adjust and has no word form. */
const WORD_TEMPLATES: ReadonlySet<string> = new Set(["check_with_loss", "improvement_check", "table_draw", "opposed"]);

function lossArgs(rest: string): Args {
  const text = rest.trim();
  if (text === "") return {};
  const at = text.indexOf("/");
  if (at < 0) return { failure: text };
  const success = text.slice(0, at).trim();
  const failure = text.slice(at + 1).trim();
  return compact({ success: success === "" ? undefined : success, failure: failure === "" ? undefined : failure });
}

/** The arguments a word's binding presets (`ti: {tool: random_madness, args: {table: temp}}`). */
function presetArgs(binding: CommandBinding | undefined): Record<string, unknown> {
  if (binding === undefined || binding.kind !== "tool") return {};
  const table = binding.args.table;
  return typeof table === "string" ? { table } : {};
}

function subsystemEvent(call: CommandCall, pack: RulePack, spec: SubsystemSpec, data: Omit<DiceData, "actor" | "kind" | "subsystem" | "subsystemLabel">): CommandEvent {
  return {
    kind: "dice",
    data: { actor: actorName(call.context), kind: "subsystem", subsystem: spec.id, subsystemLabel: subsystemName(spec, call.context.locale), ...data },
  };
}

/** The caller's character for a subsystem of the room's pack: it must be of that system. */
function subsystemCharacter(call: CommandCall, pack: RulePack): StoredCharacter | Refused {
  const character = callerCharacter(call);
  if (isRefused(character)) return character;
  if (character.pack.id !== pack.id) return refuse("wrong_system", { system: character.pack.id });
  return character;
}

function saveSheet(call: CommandCall, character: StoredCharacter, sheet: Sheet): Refused | null {
  const write: SheetWrite = updateSheet(character.pack.sheet, character.character, sheet);
  if (!write.ok) return refuse("sheet_refused", { code: write.code });
  saveCharacter(call, character.id, write.data);
  return null;
}

function runLoss(call: CommandCall, pack: RulePack, spec: SubsystemSpec, args: Args): Done | Refused {
  const character = subsystemCharacter(call, pack);
  if (isRefused(character)) return character;
  const result = runSubsystem(
    pack,
    spec.id,
    {
      template: "check_with_loss",
      sheet: character.character.sheet,
      successLoss: (args.success as string | undefined) ?? "0",
      failureLoss: (args.failure as string | undefined) ?? "1",
      tag: (args.tag as string | undefined) ?? "",
      variant: call.context.variant,
    },
    call.context.random,
  );
  if (!result.ok) {
    if ("refusal" in result && result.refusal === "bad_loss") return refuse("bad_dice", { expr: result.notation, code: result.errorCode });
    if ("refusal" in result && result.refusal === "stat_unset") return refuse("not_numeric", { skill: result.stat });
    return refuse("roll_failed", { code: "refusal" in result ? result.refusal : "" });
  }
  if (!("lossRoll" in result)) return refuse("roll_failed", { code: "template" });
  const problem = saveSheet(call, character, result.sheet);
  if (problem !== null) return problem;
  const rolled = result.check;
  return {
    data: { loss: result.loss, before: result.statBefore, after: result.statAfter },
    events: [
      subsystemEvent(call, pack, spec, {
        expr: rolled.notation,
        rolls: rolled.percentile !== null ? [rolled.percentile.total] : [rolled.total],
        total: rolled.total,
        target: result.statBefore,
        outcome: wireOutcome(pack, result.outcome, call.context.locale),
        detail: {
          stat: result.stat,
          loss: result.loss,
          lossNotation: result.lossNotation,
          lossRoll: renderRoll(result.lossRoll),
          before: result.statBefore,
          after: result.statAfter,
          ...(result.statMax === null ? {} : { max: result.statMax }),
          ...(result.writeRefused === null ? {} : { writeRefused: result.writeRefused }),
        },
      }),
    ],
  };
}

function runGrowth(call: CommandCall, pack: RulePack, spec: SubsystemSpec, args: Args): Done | Refused {
  const character = subsystemCharacter(call, pack);
  if (isRefused(character)) return character;
  const result = runSubsystem(pack, spec.id, { template: "improvement_check", sheet: character.character.sheet, skill: args.skill as string }, call.context.random);
  if (!result.ok) {
    if ("refusal" in result && result.refusal === "at_cap") return refuse("at_cap", { skill: result.skill, cap: result.cap });
    return refuse("refusal" in result && result.refusal === "not_numeric" ? "not_numeric" : "unknown_skill", { skill: args.skill as string });
  }
  if (!("grew" in result)) return refuse("roll_failed", { code: "template" });
  if (result.grew) {
    const problem = saveSheet(call, character, result.sheet);
    if (problem !== null) return problem;
  }
  return {
    data: { before: result.before, after: result.after, grew: result.grew },
    events: [
      subsystemEvent(call, pack, spec, {
        expr: result.roll.notation,
        rolls: [result.roll.total],
        total: result.roll.total,
        target: result.before,
        detail: {
          skill: displayName(pack.sheet, result.skill, call.context.locale),
          before: result.before,
          after: result.after,
          grew: result.grew,
          ...(result.growthRoll === null ? {} : { growth: renderRoll(result.growthRoll) }),
        },
      }),
    ],
  };
}

function runDraw(call: CommandCall, pack: RulePack, spec: SubsystemSpec, args: Args): Done | Refused {
  const result = runSubsystem(pack, spec.id, { template: "table_draw", table: (args.table as string | undefined) ?? null }, call.context.random);
  if (!result.ok) return refuse("unknown_table", { table: (args.table as string | undefined) ?? "" });
  if (!("entry" in result)) return refuse("roll_failed", { code: "template" });
  const table = findTable(spec as TableDrawSpec, result.table);
  return {
    data: { table: result.table, index: result.index, entry: result.entry },
    events: [
      subsystemEvent(call, pack, spec, {
        expr: result.roll.notation,
        rolls: [result.roll.total],
        total: result.roll.total,
        detail: { table: result.table, tableLabel: table === null ? result.table : tableName(table, call.context.locale), index: result.index, entry: result.entry },
      }),
    ],
  };
}

function subsystemParams(spec: SubsystemSpec): ObjectSchema {
  switch (spec.template) {
    case "check_with_loss":
      return object({ success: text(100, 1), failure: text(100, 1), tag: text(64) });
    case "improvement_check":
      return object({ skill: text(MAX_SKILL_CHARS, 1) }, ["skill"]);
    case "table_draw":
      return object({ table: text(64, 1) });
    default:
      return object({ a: SIDE, b: SIDE }, ["a"]);
  }
}

/** The id of the command a subsystem's words run. */
export function subsystemCommandId(subsystem: string): string {
  return `rules.${subsystem}`;
}

/**
 * The commands of a room's rule pack: one per subsystem its command words bind, in pack
 * order, each answering to every word that binds it. (A word bound to `check` adds to the
 * engine's own check command instead; creation words to `new_character`.)
 */
export function packCommands(pack: RulePack): CommandSpec[] {
  const words = new Map<string, string[]>();
  for (const [word, binding] of pack.commands) {
    if (binding.kind !== "tool") continue;
    const list = words.get(binding.tool) ?? [];
    list.push(word);
    words.set(binding.tool, list);
  }
  const specs: CommandSpec[] = [];
  for (const [subsystem, forms] of words) {
    const spec = pack.subsystems.get(subsystem);
    if (spec === undefined || !WORD_TEMPLATES.has(spec.template)) continue;
    specs.push({
      id: subsystemCommandId(subsystem),
      source: "pack",
      key: `rules.${spec.template}`,
      keyParams: (locale) => ({ name: subsystemName(spec, locale), form: forms[0] ?? subsystem }),
      params: subsystemParams(spec),
      text: { en: forms, zh: forms },
      role: "player",
      parseText(rest, call) {
        const preset = presetArgs(call.word === null ? undefined : pack.commands.get(commandWord(call.word)));
        switch (spec.template) {
          case "check_with_loss":
            return lossArgs(rest);
          case "improvement_check":
            return compact({ skill: rest === "" ? undefined : rest });
          case "table_draw":
            return compact({ table: rest === "" ? undefined : rest, ...preset });
          default: {
            const [left, right] = splitSides(rest);
            return compact({ a: sideArgs(left, pack), b: right === "" ? undefined : sideArgs(right, pack) });
          }
        }
      },
      run(call, args) {
        // The words were bound by the room's pack when the table was built; a pack changed
        // since then answers through its own commands.
        const live = call.context.pack;
        const current = live?.subsystems.get(subsystem);
        if (live === null || current === undefined || current.template !== spec.template) return refuse("not_in_system", { word: call.word ?? subsystem });
        switch (current.template) {
          case "check_with_loss":
            return runLoss(call, live, current, args);
          case "improvement_check":
            return runGrowth(call, live, current, args);
          case "table_draw":
            return runDraw(call, live, current, args);
          default:
            return runOpposed(call, args, current.id);
        }
      },
    });
  }
  return specs;
}

// ---------------------------------------------------------------------------
// Initiative
// ---------------------------------------------------------------------------

function readFight(call: CommandCall): Initiative | Refused {
  const document = readDocument(call, INITIATIVE_TYPE, INITIATIVE_ID);
  if (document === null) return NO_FIGHT;
  if ("refused" in document) return document;
  return readInitiative(document.data) ?? refuse("document_unreadable");
}

function initiativeText(call: CommandCall): string {
  const view = call.context.services.views.view(call.context.room, INITIATIVE_TYPE, INITIATIVE_ID, callerViewer(call)) as InitiativeView | null;
  if (view === null || view.order.length === 0) return call.say("init.empty");
  const lines = [call.say("init.header", { round: view.round })];
  for (const combatant of view.order) {
    lines.push(call.say(combatant.name === view.acting ? "init.line_acting" : "init.line", { name: combatant.name, value: combatant.value }));
  }
  return lines.join("\n");
}

export const initCommand: CommandSpec = {
  id: "init",
  source: "engine",
  key: "init",
  params: object({ op: oneOf(["show", "roll", "next", "clear"]), value: integer(-MAX_TARGET, MAX_TARGET), name: text(64, 1) }, ["op"]),
  text: { en: ["init", "initiative", "ri"], zh: ["ri", "init"] },
  role: "player",
  // Listing someone else (an NPC) is the admin's.
  adminWhen: (args) => args.name !== undefined,
  parseText(rest) {
    const [word, after] = firstWord(rest);
    if (word === "" || word === "show" || word === "list") return { op: "show" };
    if (word === "next" || word === "clear") return { op: word };
    if (word === "roll") {
      const value = parseInteger(after);
      return compact({ op: "roll", value: value ?? undefined });
    }
    const value = parseInteger(rest);
    return value === null ? refuse("usage") : { op: "roll", value };
  },
  run(call, args): Done | Refused {
    const fight = readFight(call);
    if (isRefused(fight)) return fight;
    const op = args.op as string;
    if (op === "show") return { text: initiativeText(call), data: { round: fight.round, acting: actingCombatant(fight)?.name ?? null } };
    if (op === "clear") {
      putDocument(call, INITIATIVE_TYPE, INITIATIVE_ID, initiativeData(NO_FIGHT));
      return { events: [{ kind: "narrative", data: { speaker: "system", text: call.tell("init.cleared"), format: "plain" } }] };
    }
    if (op === "next") {
      const next = nextTurn(fight);
      if (!next.ok) return refuse("init_empty");
      putDocument(call, INITIATIVE_TYPE, INITIATIVE_ID, initiativeData(next.data));
      const acting = actingCombatant(next.data);
      return { events: [{ kind: "narrative", data: { speaker: "system", text: call.tell("init.next", { round: next.data.round, name: acting?.name ?? "" }), format: "plain" } }] };
    }
    // Roll: for a named combatant (admin), or for the caller's character.
    let name = args.name as string | undefined;
    let value = args.value as number | undefined;
    let notation: string | null = null;
    let rolls: number[] = [];
    if (name === undefined) {
      const character = callerCharacter(call);
      if (isRefused(character)) return character;
      name = character.character.sheet.name;
      if (value === undefined) {
        const rolled = rollInitiative(character.pack.initiative, character.pack.sheet, character.character.sheet, call.context.random);
        if (!rolled.ok) return refuse(rolled.code === "stat_unavailable" ? "not_numeric" : rolled.code, { skill: rolled.name ?? "" });
        value = rolled.value;
        notation = rolled.roll.notation;
        rolls = facesOf(rolled.roll);
      }
    } else if (value === undefined) {
      return refuse("missing_arg", { path: "value" });
    }
    const without = fight.order.some((item) => item.name === name) ? removeCombatant(fight, name) : { ok: true as const, data: fight };
    if (!without.ok) return refuse("init_refused", { code: without.code });
    const added = addCombatant(without.data, name, value);
    if (!added.ok) return refuse("init_refused", { code: added.code });
    putDocument(call, INITIATIVE_TYPE, INITIATIVE_ID, initiativeData(added.data));
    return {
      data: { name, value },
      events: [{ kind: "dice", data: { actor: actorName(call.context), kind: "init", expr: notation ?? String(value), rolls: notation === null ? [value] : rolls, total: value, detail: { name } } }],
    };
  },
};

// ---------------------------------------------------------------------------
// Making a character
// ---------------------------------------------------------------------------

/** Every creation word of every loaded pack: `.coc` makes a CoC character in any room. */
export function creationWords(context: RoomContext): string[] {
  const words: string[] = [];
  for (const pack of context.services.packs.packs()) {
    for (const [word, binding] of pack.commands) {
      if (binding.kind === "action" && binding.action === "make_char" && !words.includes(word)) words.push(word);
    }
  }
  return words;
}

/** A new character id: the server's id source, so a test can pin it. */
function newCharacterId(call: CommandCall): string {
  return `ch-${call.context.services.clock.id()}`;
}

/** A new character made and seated: what `seatNewCharacter` did. */
export interface NewCharacter {
  readonly id: string;
  readonly character: Character;
  readonly violations: readonly SheetViolation[];
  readonly events: CommandEvent[];
}

/**
 * Make `sheet` (a new sheet of `pack`'s system) the caller's character and seat it for them:
 * validated as a creation, owned by the caller, seated in place of whatever they played (that
 * character stays in the room, unseated). The table is told in one line; a room with no rule
 * system takes this one. The one path every new character of a member takes — `new_character`
 * and `genchar`.
 */
export function seatNewCharacter(call: CommandCall, pack: RulePack, sheet: Sheet, creationMethod: string): NewCharacter | Refused {
  const member = call.context.who.member;
  if (member === null || memberIdOf(call.context) === null) return refuse("no_member");
  if (tableCharacterNames(call, null).has(sheet.name.trim().toLowerCase())) return refuse("name_taken", { name: sheet.name.trim() });
  const created = createCharacter(pack.sheet, sheet, { owner: member.id, creationMethod });
  if (!created.ok) return refuse("sheet_refused", { code: created.code });
  const seats = seating(call);
  if (isRefused(seats)) return seats;
  const id = newCharacterId(call);
  const seated = switchCharacter(seats, member.id, id, member.name);
  if (!seated.ok) return refuse("seat_refused", { code: seated.code });
  saveCharacter(call, id, created.data);
  saveSeating(call, seated.data);
  const events: CommandEvent[] = [
    { kind: "narrative", data: { speaker: "system", text: call.tell("character.created", { member: member.name, name: created.data.sheet.name, system: pack.id }), format: "plain" } },
  ];
  // A room that has no rule system takes the one its first character was made for: a
  // table that rolled CoC investigators and then could not make a check (seen in the
  // first hands-on run of the terminal client) is not a state anyone chose. An admin
  // changes it with `rule system`; a room that already has one is left alone.
  if (call.context.pack === null) {
    call.context.writer.statePut(ROOM_RULE_PACK, pack.id);
    events.push({ kind: "narrative", data: { speaker: "system", text: call.tell("rule.system_event", { system: pack.id }), format: "plain" } });
  }
  return { id, character: created.data, violations: created.violations, events };
}

export const newCharacterCommand: CommandSpec = {
  id: "new_character",
  source: "engine",
  key: "new_character",
  params: object({ system: text(64, 1), name: text(64, 1) }, ["system"]),
  text(context) {
    const words = creationWords(context);
    return { en: words, zh: words };
  },
  role: "player",
  parseText(rest, call) {
    const pack = call.word === null ? null : call.context.services.packs.makeCharacterPack(call.word);
    if (pack === null) return refuse("unknown_system", { system: call.word ?? "" });
    return compact({ system: pack.id, name: rest === "" ? undefined : rest });
  },
  run(call, args): Done | Refused {
    const member = call.context.who.member;
    if (member === null || memberIdOf(call.context) === null) return refuse("no_member");
    const pack = call.context.services.packs.resolve(args.system as string);
    if (pack === null) return refuse("unknown_system", { system: args.system as string });
    const name = ((args.name as string | undefined) ?? call.say("character.default_name")).trim();
    if (tableCharacterNames(call, null).has(name.toLowerCase())) return refuse("name_taken", { name });
    const generated = generateCharacter(pack.sheet, call.context.random, { name, system: pack.id });
    const made = seatNewCharacter(call, pack, generated.sheet, "rolled");
    if (isRefused(made)) return made;
    return {
      data: { id: made.id, name: made.character.sheet.name, system: pack.id, violations: made.violations.map((violation) => violation.code) },
      events: made.events,
    };
  },
};
