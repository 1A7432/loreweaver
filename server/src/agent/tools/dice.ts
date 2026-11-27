// Dice tools: a free roll, a graded check, hit points, and the fight's turn order.
// Iron rules 1 and 2: the engine rolls (`core/dice`, `core/resolution`) and grades by the
// pack's ladder; the model only narrates what came back. Each roll is a table event.
import type { DiceData, Outcome } from "loreweaver-protocol/v3";

import { CHARACTER_TYPE } from "../../core/characters/index.ts";
import {
  actingCombatant,
  addCombatant,
  clearInitiative,
  type Initiative,
  initiativeData,
  INITIATIVE_ID,
  INITIATIVE_TYPE,
  NO_FIGHT,
  nextTurn,
  readInitiative,
  rollInitiative,
} from "../../core/clock/index.ts";
import { DiceError, keptFaces, naturalCritical, parseDice, primaryDice, renderRoll, rollExpression } from "../../core/dice/index.ts";
import {
  type CheckOutcome,
  effectiveTarget,
  favorModifiers,
  performCheck,
  type Resolution,
  ResolutionError,
  type RolledCheck,
} from "../../core/resolution/index.ts";
import { rankDisplay, type RulePack } from "../../core/rulepacks/index.ts";
import { checkValue, displayName, getHitPoints, hasCheckValue, resolveName, setHitPoints, sheetValue } from "../../core/sheets/index.ts";
import type { RoomContext } from "../context.ts";
import { type ArgObject, param } from "./params.ts";
import { activeCharacter, getDocument, type LoadedCharacter, listDocuments, loadCharacter, putDocument, refuse, saveSheet, violationNotice } from "./shared.ts";
import { tableLine } from "./tools_catalog.ts";
import { defineTool, type RecordedCheckState, type ToolResult, type TurnLedger } from "./types.ts";

/** The outcome as the table reads it: the label in the room's language, from the pack. */
export function outcomeData(pack: RulePack, outcome: CheckOutcome, locale: string): Outcome {
  const rank = outcome.rank;
  const data: Outcome = {
    id: rank.id,
    label: rankDisplay(pack, rank.id, locale),
    success: rank.success,
    critical: rank.critical,
    fumble: rank.fumble,
    tier: rank.tier,
  };
  return outcome.margin === null ? data : { ...data, margin: outcome.margin };
}

/** Who a roll is shown as: the actor named, else the acting character, else the member. */
function actorName(context: RoomContext, actor: string | undefined): string {
  const named = actor?.trim() ?? "";
  if (named !== "") return named;
  return context.who.character?.name ?? context.who.member?.name ?? "";
}

function diceEvent(data: DiceData): ToolResult["events"] {
  return [{ kind: "dice", data }];
}

// ---------------------------------------------------------------------------
// roll_dice
// ---------------------------------------------------------------------------

export const rollDiceTool = defineTool({
  name: "roll_dice",
  description: "Roll dice and return the result.",
  params: {
    expression: param.string("Dice expression, e.g. '1d100', '3d6+2', '2d6*5'."),
    actor: param.string("Set to the NPC/creature name when rolling for a non-player actor.").optional(),
  },
  flags: {},
  suspends: null,
  run(context, args): ToolResult {
    let roll;
    try {
      roll = rollExpression(parseDice(args.expression.trim()), context.random);
    } catch (error) {
      if (error instanceof DiceError) return refuse("invalid_expression", `Invalid dice expression: ${error.code}${error.position === undefined ? "" : ` at position ${error.position}`}.`);
      throw error;
    }
    const group = primaryDice(roll);
    const faces = group === null ? [] : keptFaces(group);
    const critical = group === null ? null : naturalCritical(group.sides, faces);
    const suffix = critical === "success" ? " Critical success!" : critical === "failure" ? " Critical failure!" : "";
    return {
      text: `Rolled ${renderRoll(roll)}.${suffix}`,
      events: diceEvent({
        actor: actorName(context, args.actor),
        kind: "roll",
        expr: roll.notation,
        rolls: faces,
        total: roll.total,
        text: renderRoll(roll),
        detail: { criticalSuccess: critical === "success", criticalFailure: critical === "failure" },
      }),
      bookkeeping: { dice: true },
    };
  },
});

// ---------------------------------------------------------------------------
// skill_check
// ---------------------------------------------------------------------------

/** A character of this room whose name is `name` (case-insensitive), if any. */
function characterNamed(context: RoomContext, name: string): LoadedCharacter | null {
  const wanted = name.trim().toLowerCase();
  if (wanted === "") return null;
  for (const document of listDocuments(context, CHARACTER_TYPE)) {
    const sheet = document.data.sheet;
    const sheetName = typeof sheet === "object" && sheet !== null && !Array.isArray(sheet) ? (sheet as { name?: unknown }).name : undefined;
    if (typeof sheetName === "string" && sheetName.trim().toLowerCase() === wanted) {
      const loaded = loadCharacter(context, document.id);
      return loaded.ok ? loaded.loaded : null;
    }
  }
  return null;
}

function poolCheck(context: RoomContext, params: ArgObject, actor: string | undefined): ToolResult {
  const pack = context.pack;
  const resolution = pack?.resolution ?? null;
  if (pack === null || resolution === null || resolution.params.size === 0) return refuse("not_parameterized", "This room's rule system takes no roll parameters; omit params.");
  const unknown = Object.keys(params).filter((key) => !resolution.params.has(key));
  if (unknown.length > 0) return refuse("unknown_param", `Unknown roll parameter: ${unknown.join(", ")}. This system's parameters: ${[...resolution.params.keys()].join(", ")}.`);
  const values = new Map<string, number>();
  for (const spec of resolution.params.values()) {
    const raw = Object.hasOwn(params, spec.id) ? params[spec.id] : spec.default;
    const value = typeof raw === "number" ? raw : typeof raw === "string" && /^\s*[+-]?\d+\s*$/.test(raw) ? Number(raw.trim()) : null;
    if (value === null || !Number.isSafeInteger(value)) return refuse("missing_param", `Missing roll parameter: ${spec.id} (a whole number).`);
    if (value < spec.min || value > spec.max) return refuse("param_out_of_range", `Roll parameter ${spec.id} must be between ${spec.min} and ${spec.max}.`);
    values.set(spec.id, value);
  }
  const performed = performCheck(resolution, context.random, { params: values, variant: context.variant });
  const rolled = performed.rolled;
  const outcome = performed.outcome;
  const lines = [`Pool check: ${rolled.notation}`, `Dice: [${rolled.dice.join(", ")}]`];
  if (rolled.successes !== null) lines.push(`Successes: ${rolled.successes}`);
  if (outcome !== null) lines.push(`Result: ${rankDisplay(pack, outcome.rank.id, "en")}`);
  const data: DiceData = {
    actor: actorName(context, actor),
    kind: "check",
    expr: rolled.notation,
    rolls: [...rolled.dice],
    total: rolled.total,
    detail: Object.fromEntries(values),
  };
  return {
    text: lines.join("\n"),
    events: diceEvent(outcome === null ? data : { ...data, outcome: outcomeData(pack, outcome, context.locale) }),
    bookkeeping: { dice: true },
  };
}

function rolledLines(rolled: RolledCheck, favorLabel: string, net: number): string[] {
  const percentile = rolled.percentile;
  if (percentile === null) return [`Roll: ${rolled.total}`];
  const lines = [`Raw roll: ${percentile.base}`];
  if (favorLabel !== "") lines.push(`${favorLabel} tens digits: ${JSON.stringify(percentile.extraTens)} → final tens digit: ${percentile.finalTens}`);
  lines.push(`Final result: ${rolled.total}${favorLabel === "" ? "" : ` (${favorLabel} x${Math.abs(net)})`}`);
  return lines;
}

export const skillCheckTool = defineTool({
  name: "skill_check",
  description: "Run a skill check for the active character (attribute names and bridged skills resolve too).",
  params: {
    skill_name: param.string("Skill or attribute name (CN/EN aliases supported)."),
    bonus: param.integer("Count of the system's favorable roll modifier (bonus dice / advantage).").or(0),
    penalty: param.integer("Count of the system's unfavorable roll modifier (penalty dice / disadvantage).").or(0),
    dc: param
      .integer(
        "Difficulty target, for systems whose checks roll against a declared DC; omit to use the system's default. Ignored by systems that roll against the sheet value.",
      )
      .optional(),
    proficient: param.boolean("Whether the sheet's proficiency bonus applies (systems that declare one).").or(false),
    actor: param
      .string(
        "ONLY for a non-player actor: copy the NPC/creature's exact stated name, without added titles or roles. For a player character's check OMIT actor entirely — never send actor=\"\" or the player's name.",
      )
      .optional(),
    npc_target: param
      .integer(
        "Required with actor: the NPC's real check number — its skill/target value or its total check modifier, whichever this system's checks use — as a real integer. Omit for player checks — never send 0.",
      )
      .optional(),
    params: param
      .object(
        "Roll parameters for rule systems whose check declares them (e.g. a dice-pool size and threshold), as an integer mapping. Omit for systems that don't.",
      )
      .optional(),
  },
  flags: {},
  suspends: null,
  run(context, args, turn): ToolResult {
    if (args.params !== undefined && Object.keys(args.params).length > 0) return poolCheck(context, args.params, args.actor);

    // Who rolls: a named actor that is one of the room's characters is that character;
    // any other name is a non-player actor, which needs its stated number.
    const named = args.actor?.trim() ?? "";
    let subject: LoadedCharacter | null = null;
    if (named === "") {
      const active = activeCharacter(context);
      if (!active.ok) return active.result;
      subject = active.loaded;
    } else {
      subject = characterNamed(context, named);
      if (subject === null && args.npc_target === undefined) return refuse("npc_target_required", "Omit actor for the active character, or supply npc_target for an NPC.");
    }

    const pack = subject?.pack ?? context.pack;
    if (pack === null || pack.resolution === null) return refuse("unknown_skill", `This room's rule system has no check to roll "${args.skill_name}" with.`);
    const resolution: Resolution = pack.resolution;
    const first = resolution.params.values().next();
    if (!first.done) return refuse("missing_param", `Missing roll parameter: ${first.value.id}. This system's checks take params.`);
    const spec = pack.sheet;
    const typed = args.skill_name.trim();
    const canonical = resolveName(spec, typed) ?? typed;

    let sheetCheckValue = 0;
    if (subject !== null) {
      const sheet = subject.character.sheet;
      // An unknown name is refused rather than rolled against 0, where a minimal roll
      // would read as a critical success.
      if (!hasCheckValue(spec, sheet, typed) && !hasCheckValue(spec, sheet, canonical)) {
        return refuse("unknown_skill", `Unknown skill or attribute "${args.skill_name}" — use a skill from the character sheet or an attribute name (e.g. 侦查, Spot Hidden, STR, 力量).`);
      }
      const read = checkValue(spec, sheet, canonical);
      if (read.kind === "text" || read.kind === "failed") return refuse("not_numeric", `"${args.skill_name}" is not a number on ${subject.character.sheet.name}'s sheet, so it cannot be checked.`);
      sheetCheckValue = read.kind === "value" ? read.value : 0;
    }

    const favor = favorModifiers(resolution.check, args.bonus, args.penalty);
    const net = args.bonus - args.penalty;
    const favorLabel = favor.applied === null ? "" : displayName(spec, favor.applied, "en");
    const npcValue = subject === null ? (args.npc_target as number) : null;
    let target: number;
    let modifier = 0;
    const proficientApplies = subject !== null && args.proficient && resolution.check.proficiency !== null;
    if (resolution.targetKind === "dc") {
      // No DC and no pack default: the engine does not invent a number (a check against 0
      // would nearly always succeed).
      const dc = args.dc ?? resolution.check.defaultTarget;
      if (dc === null) return refuse("dc_required", "This rule system declares no default difficulty: state the DC for this check (dc).");
      target = dc;
      modifier = npcValue ?? sheetCheckValue;
      if (proficientApplies && subject !== null) {
        const bonus = sheetValue(spec, subject.character.sheet, resolution.check.proficiency as string);
        if (bonus.kind === "value") modifier += bonus.value;
      }
    } else {
      target = npcValue ?? sheetCheckValue;
    }

    let performed;
    try {
      performed = performCheck(resolution, context.random, { modifiers: favor.modifiers, target, modifier, variant: context.variant });
    } catch (error) {
      if (error instanceof ResolutionError) return refuse("roll_failed", `The check could not be rolled (${error.code}).`);
      throw error;
    }
    const { rolled, total, outcome } = performed;
    if (outcome === null) return refuse("roll_failed", "The check could not be graded.");

    const displayActor = subject?.character.sheet.name ?? named;
    const skillLabel = displayName(spec, canonical, context.locale);
    const lines = [`${displayActor} makes a ${displayName(spec, canonical, "en")} check${proficientApplies ? " (proficient)" : ""}`];
    if (resolution.targetKind === "dc") {
      if (favorLabel !== "") lines.push(`${favorLabel} x${Math.abs(net)}`);
      lines.push(`Roll: ${rolled.total} + modifier ${modifier} = ${total} vs target ${target}`);
    } else {
      lines.push(`Target value: ${target}`);
      lines.push(...rolledLines(rolled, favorLabel, net));
    }
    lines.push(`${outcome.rank.success ? "Success" : "Failure"} — result: ${rankDisplay(pack, outcome.rank.id, "en")}`);

    const detail: Record<string, unknown> = { bonus: args.bonus, penalty: args.penalty, modifier, proficient: args.proficient, skill: canonical };
    if (rolled.percentile !== null) {
      detail.base = rolled.percentile.base;
      detail.extraTens = [...rolled.percentile.extraTens];
      detail.finalTens = rolled.percentile.finalTens;
    }
    if (subject !== null) {
      detail.character = subject.id;
      const recorded = recordCheck(turn.ledger, resolution, { character: subject.id, skill: canonical, target, roll: rolled.total, variant: context.variant });
      if (recorded !== null) detail.recordedCheck = recordedCheckDetail(recorded);
    }
    const effective = outcome.effectiveTarget ?? effectiveTarget(resolution, target, null);
    const data: DiceData = {
      actor: displayActor,
      kind: "check",
      // The notation rolled; what it was rolled FOR is `label` (a client shows both).
      expr: rolled.notation,
      rolls: [...rolled.dice],
      total,
      target,
      label: skillLabel,
      outcome: outcomeData(pack, outcome, context.locale),
      detail,
    };
    return {
      text: lines.join("\n"),
      events: diceEvent(effective === null ? data : { ...data, effectiveTarget: effective }),
      bookkeeping: { dice: true },
    };
  },
});

/**
 * Keep a player's roll-under check for a later spend of points on it (Luck): in the turn's
 * ledger, and in the dice event's detail, where a later turn finds it in the room's log.
 */
function recordCheck(
  ledger: TurnLedger,
  resolution: Resolution,
  check: { character: string; skill: string; target: number; roll: number; variant: string | null },
): RecordedCheckState | null {
  if (resolution.targetKind !== "skill") return null;
  const state: RecordedCheckState = { ...check, rawRoll: check.roll, spent: 0, difficulty: null };
  ledger.checks.set(check.character, state);
  return state;
}

/** A recorded check as a dice event's `detail.recordedCheck` carries it. */
export function recordedCheckDetail(check: RecordedCheckState): Record<string, unknown> {
  return { skill: check.skill, target: check.target, roll: check.roll, rawRoll: check.rawRoll, spent: check.spent, variant: check.variant, difficulty: check.difficulty };
}

// ---------------------------------------------------------------------------
// hp_manager
// ---------------------------------------------------------------------------

function hpStatus(hp: number, max: number): string {
  const ratio = max > 0 ? hp / max : 1;
  if (ratio >= 0.75) return "Healthy";
  if (ratio >= 0.5) return "Lightly Wounded";
  if (ratio >= 0.25) return "Heavily Wounded";
  if (hp > 0) return "Dying";
  return "Dead";
}

export const hpManagerTool = defineTool({
  name: "hp_manager",
  description: "Manage the active character's hit points.",
  params: {
    action: param.string("Operation type (show/add/sub/set)."),
    value: param.integer("The amount to add/subtract, or the value to set.").or(0),
  },
  flags: {},
  suspends: null,
  run(context, args): ToolResult {
    const action = args.action.trim().toLowerCase();
    if (!["show", "add", "sub", "set"].includes(action)) return refuse("unknown_action", `Unknown action: ${args.action}, supported: show/add/sub/set`);
    const active = activeCharacter(context);
    if (!active.ok) return active.result;
    const { pack, character } = active.loaded;
    const spec = pack.sheet;
    const before = getHitPoints(spec, character.sheet);
    if (!before.ok) return refuse("formula_failed", "This sheet's hit points could not be computed (a pack formula failed).");
    let sheet = character.sheet;
    let notice = "";
    if (action !== "show") {
      const update = action === "set" ? { current: args.value } : { delta: action === "add" ? args.value : -args.value };
      const write = setHitPoints(spec, sheet, update);
      if (!write.ok) return refuse(write.code, `The hit points could not be written (${write.code}).`);
      const saved = saveSheet(context, active.loaded, write.sheet);
      if (!saved.ok) return saved.result;
      sheet = saved.character.sheet;
      notice = violationNotice(saved.violations);
    }
    const after = getHitPoints(spec, sheet);
    const hp = after.ok ? after.current : before.current;
    const max = after.ok ? after.max : before.max;
    const line = `${sheet.name} HP: ${hp}/${max} ${hpStatus(hp, max)}`;
    return { text: notice === "" ? line : `${line}\n${notice}` };
  },
});

// ---------------------------------------------------------------------------
// initiative_tracker
// ---------------------------------------------------------------------------

function readFight(context: RoomContext): { readonly fight: Initiative; readonly document: ReturnType<typeof getDocument> } {
  const document = getDocument(context, INITIATIVE_TYPE, INITIATIVE_ID);
  const fight = document === null || document.corrupt ? NO_FIGHT : (readInitiative(document.data) ?? NO_FIGHT);
  return { fight, document };
}

function orderLines(fight: Initiative): string {
  const acting = actingCombatant(fight);
  const lines = ["Initiative order:", `Round ${fight.round} · current: ${acting?.name ?? "-"}`];
  fight.order.forEach((combatant, index) => lines.push(`${index + 1}. ${combatant.name}: ${combatant.value}`));
  return lines.join("\n");
}

const INITIATIVE_REFUSALS: Readonly<Record<string, string>> = {
  bad_name: "That combatant name is empty or too long.",
  bad_value: "The initiative value must be a whole number.",
  already_listed: "That combatant is already in the initiative order.",
  full: "The initiative order is full.",
  unknown_combatant: "No such combatant in the initiative order.",
  empty: "The initiative list is empty.",
};

export const initiativeTrackerTool = defineTool({
  name: "initiative_tracker",
  description: "Manage the combat initiative order.",
  params: {
    action: param.string("Operation (add/list/clear/next)."),
    name: param.string("Character/NPC name (defaults to the active character when adding).").optional(),
    initiative: param.integer("Initiative value (auto-rolled for the active character when adding, if omitted).").optional(),
  },
  flags: {},
  suspends: null,
  run(context, args): ToolResult {
    const action = args.action.trim().toLowerCase();
    const { fight, document } = readFight(context);
    switch (action) {
      case "add": {
        const seat = context.who.character;
        const named = args.name?.trim() ?? "";
        const isActive = seat !== null && (named === "" || named.toLowerCase() === seat.name.trim().toLowerCase());
        if (named === "" && seat === null) return refuse("no_character", "Name the combatant: the acting member plays no character to add by default.");
        let value = args.initiative;
        let rolls: number[] = [];
        let expr = named === "" ? (seat?.name ?? "") : named;
        let name = expr;
        if (value === undefined) {
          if (!isActive || seat === null) return refuse("initiative_required", `Give the initiative value for ${named}: only the active character's initiative is rolled automatically.`);
          const loaded = loadCharacter(context, seat.id);
          if (!loaded.ok) return loaded.result;
          name = loaded.loaded.character.sheet.name;
          const rolled = rollInitiative(loaded.loaded.pack.initiative, loaded.loaded.pack.sheet, loaded.loaded.character.sheet, context.random);
          if (!rolled.ok) {
            if (rolled.code === "no_initiative_roll") return refuse(rolled.code, "This rule system declares no initiative roll; give the initiative value.");
            if (rolled.code === "stat_unavailable") return refuse(rolled.code, `The initiative roll needs ${rolled.name ?? "a stat"}, which is not a number on this sheet; give the initiative value.`);
            return refuse(rolled.code, "The initiative roll failed; give the initiative value.");
          }
          value = rolled.value;
          expr = rolled.roll.notation;
          const group = primaryDice(rolled.roll);
          rolls = group === null ? [] : keptFaces(group);
        }
        const change = addCombatant(fight, name, value);
        if (!change.ok) return refuse(change.code, INITIATIVE_REFUSALS[change.code] ?? change.code);
        putDocument(context, INITIATIVE_TYPE, INITIATIVE_ID, initiativeData(change.data), document);
        return {
          text: `Added ${name}'s initiative: ${value}`,
          events: diceEvent({ actor: name, kind: "init", expr, rolls, total: value, label: tableLine(context, "dice.initiative") }),
        };
      }
      case "list":
      case "show":
        return { text: fight.order.length === 0 ? "The initiative list is empty." : orderLines(fight) };
      case "clear":
        putDocument(context, INITIATIVE_TYPE, INITIATIVE_ID, initiativeData(clearInitiative()), document);
        return { text: "Initiative list cleared." };
      case "next": {
        const change = nextTurn(fight);
        if (!change.ok) return refuse(change.code, INITIATIVE_REFUSALS[change.code] ?? change.code);
        putDocument(context, INITIATIVE_TYPE, INITIATIVE_ID, initiativeData(change.data), document);
        return { text: `Current turn: ${actingCombatant(change.data)?.name ?? "-"} (round ${change.data.round})` };
      }
      default:
        return refuse("unknown_action", `Unknown action: ${args.action}, supported: add/list/clear/next`);
    }
  },
});
