// The rule pack's subsystem tools: each subsystem a pack declares becomes a tool of that
// name in rooms on that pack, one generic body per template, no system vocabulary — every
// name, stat, table and label is the pack's (`core/subsystems` runs the rules; this file
// reads the sheet, stores what changed, and words the result for the model).
//
// Descriptions and parameters are the 2.6 server's (`agent/kp_tools_subsystems.py`),
// verbatim, with the subsystem's English name in `{label}`.
import type { DiceData } from "loreweaver-protocol/v3";

import {
  type ImprovementRefusal,
  type LossCheckRefusal,
  type OpposedRefusal,
  runSubsystem,
  type SpendRefusal,
  type SubsystemSpec,
  type TableDrawRefusal,
  findTable,
} from "../../core/subsystems/index.ts";
import { type RulePack, subsystemName, tableName } from "../../core/rulepacks/index.ts";
import { renderRoll } from "../../core/dice/index.ts";
import { displayName, resolveName, type SheetSpec } from "../../core/sheets/index.ts";
import type { RoomContext } from "../context.ts";
import { outcomeData, recordedCheckDetail } from "./dice.ts";
import { type ParamSet, param } from "./params.ts";
import { activeCharacter, type LoadedCharacter, refuse, saveSheet, violationNotice } from "./shared.ts";
import { tableLine } from "./tools_catalog.ts";
import { type AnyTool, defineTool, type RecordedCheckState, type ToolResult, type ToolTurn } from "./types.ts";

/** How far back in the room's log a spend looks for the check it adjusts. */
export const SPEND_LOOKBACK_EVENTS = 200;
/** A scene tag is a short word; longer text is cut to this (as the reference did). */
const MAX_TAG_CHARS = 40;

const SUMMARIES: Readonly<Record<SubsystemSpec["template"], string>> = {
  check_with_loss:
    "Roll this room's {label} check for the active character against their governing attribute and apply the outcome's loss dice to it. Give both loss expressions from the scene's stakes; the engine rolls, grades, deducts and reports.",
  improvement_check: "Run a {label} roll for the active character: the skill improves when the roll beats its current value, per this room's rule system.",
  resource_spend_adjust:
    "Spend the active character's {label} points to adjust their most recent eligible recorded check — the only correct way to apply such an adjustment: it deterministically lowers the existing roll, never rerolls.",
  opposed: "Run a {label}: both sides roll this room's check and the higher outcome tier wins (raw values break ties).",
  table_draw: "Draw one random {label} entry from this room's rule-system tables.",
};

const LOSS_PARAMS = {
  success_loss: param.string("Loss dice expression applied on a successful check, e.g. \"0\", \"1\", \"1d4\"."),
  // A failed loss check is the mechanic's entire point; "0" makes the roll decorative and
  // reads to players as a broken engine.
  failure_loss: param.string(
    "Loss dice expression applied on a FAILED check, e.g. \"1d6\", \"1d100\". This is what failing costs — \"0\" means the failure costs nothing at all, which is almost never what a scene with stakes wants.",
  ),
  tag: param.string("Optional scene tag classifying the loss source (e.g. \"fire\", \"revelation\"); the rule system may key conditional loss rules on it.").or(""),
} satisfies ParamSet;

const IMPROVE_PARAMS = {
  skill_name: param.string("The skill to attempt to improve."),
} satisfies ParamSet;

const SPEND_PARAMS = {
  points: param.integer("Positive number of points to spend on adjusting the most recent eligible check."),
} satisfies ParamSet;

const OPPOSED_PARAMS = {
  skill1: param.string("The active side's skill name."),
  skill2: param.string("The passive side's skill name."),
  skill1_value: param.integer("Override for the active side's skill value.").optional(),
  skill2_value: param.integer("Override for the passive side's skill value.").optional(),
} satisfies ParamSet;

const DRAW_PARAMS = {
  table: param.string("Which table to draw from (id or alias).").or(""),
} satisfies ParamSet;

/** The canonical name of a stat's storage key (`SAN` → `理智`), for showing it. */
function statLabel(spec: SheetSpec, key: string, locale: string): string {
  for (const [canonical, slot] of spec.shape?.attrKeys ?? []) if (slot === key) return displayName(spec, canonical, locale);
  return displayName(spec, resolveName(spec, key) ?? key, locale);
}

/** The acting character, on this pack. */
function subsystemCharacter(context: RoomContext, pack: RulePack, label: string): { ok: true; loaded: LoadedCharacter } | { ok: false; result: ToolResult } {
  const active = activeCharacter(context);
  if (!active.ok) return active;
  if (active.loaded.pack.id !== pack.id) return { ok: false, result: refuse("not_declared", `${label} is not part of this character's rule system (${active.loaded.pack.id}).`) };
  return active;
}

function subsystemEvent(context: RoomContext, pack: RulePack, spec: SubsystemSpec, data: Omit<DiceData, "kind" | "subsystem" | "subsystemLabel"> & { kind?: DiceData["kind"] }): ToolResult["events"] {
  return [{ kind: "dice", data: { ...data, kind: data.kind ?? "subsystem", subsystem: spec.id, subsystemLabel: subsystemName(spec, context.locale) } }];
}

/** One side of an opposed roll as the table reads it. */
interface SideLine {
  readonly skill: string;
  readonly total: number;
  readonly outcome: string | null;
}

function sideLine(context: RoomContext, side: SideLine): string {
  return side.outcome === null ? tableLine(context, "dice.side_plain", { skill: side.skill, total: side.total }) : tableLine(context, "dice.side", { skill: side.skill, total: side.total, outcome: side.outcome });
}

/** An opposed roll in one line for the table: both sides, and who won or that it tied. */
function opposedLine(context: RoomContext, a: SideLine, b: SideLine, winner: "active" | "passive" | "tie", decidedBy: string | null): string {
  let result: string;
  if (winner === "tie") result = tableLine(context, "dice.opposed_tie");
  else if (a.skill === b.skill) result = tableLine(context, winner === "active" ? "dice.opposed_won_first" : "dice.opposed_won_second");
  else result = tableLine(context, "dice.opposed_won", { side: winner === "active" ? a.skill : b.skill });
  if (winner !== "tie" && decidedBy === "value") result = tableLine(context, "dice.opposed_by_value", { won: result });
  return tableLine(context, "dice.opposed", { a: sideLine(context, a), b: sideLine(context, b), result });
}

function rollFailed(label: string, code: string): ToolResult {
  return refuse("roll_failed", `${label} could not be rolled (${code}).`);
}

// ---------------------------------------------------------------------------
// The five templates
// ---------------------------------------------------------------------------

function lossRefusal(label: string, refused: LossCheckRefusal): ToolResult {
  switch (refused.refusal) {
    case "bad_loss":
      return refuse("bad_loss", `The ${refused.which} loss expression "${refused.notation}" is not valid dice notation (${refused.errorCode}).`);
    case "stat_unset":
      return refuse("stat_unset", `This character has no ${refused.stat} value to roll ${label} against.`);
    case "roll_failed":
      return rollFailed(label, refused.errorCode);
  }
}

function lossTool(pack: RulePack, spec: Extract<SubsystemSpec, { template: "check_with_loss" }>, description: string): AnyTool {
  const label = subsystemName(spec, "en");
  return defineTool({
    name: spec.id,
    description,
    params: LOSS_PARAMS,
    flags: {},
    suspends: null,
    run(context, args): ToolResult {
      const found = subsystemCharacter(context, pack, label);
      if (!found.ok) return found.result;
      const loaded = found.loaded;
      const result = runSubsystem(
        pack,
        spec.id,
        { template: "check_with_loss", sheet: loaded.character.sheet, successLoss: args.success_loss, failureLoss: args.failure_loss, tag: Array.from(args.tag).slice(0, MAX_TAG_CHARS).join(""), variant: context.variant },
        context.random,
      );
      if (!result.ok) return lossRefusal(label, result as LossCheckRefusal);
      const r = result as Extract<typeof result, { lossFor: unknown }>;
      let notice = "";
      if (r.writeRefused === null) {
        const saved = saveSheet(context, loaded, r.sheet);
        if (!saved.ok) return saved.result;
        notice = violationNotice(saved.violations);
      }
      const name = loaded.character.sheet.name;
      const level = outcomeData(pack, r.outcome, "en").label;
      const lines = [
        `${name}'s ${label} check`,
        `Current ${label}: ${r.statBefore}  Rolled: ${r.check.total}`,
        `Result: ${level}`,
        // A FAILED check that costs nothing must not read like a success's line, and must
        // not blame the declared cost when the pack's ceiling is what zeroed it.
        r.lossFor === "failure" && r.loss === 0 && r.ceiling === null
          ? `Lost: 0 — the declared failure cost was 0, so this failed ${label} check took nothing.`
          : `Lost: ${r.loss} (roll: ${r.lossNotation} = ${r.lossRoll.total})`,
      ];
      if (r.fumbleRule !== null) lines.push(`A fumble: this rule system's fumble rule (${r.fumbleRule}) set the loss.`);
      if (r.ceiling !== null) lines.push(`Loss ceiling applied: this room's rule system capped the loss at ${r.ceiling} — the dice rolled higher.`);
      lines.push(`Remaining ${label}: ${r.statAfter}${r.statMax === null ? "" : `/${r.statMax}`}`);
      if (r.writeRefused !== null) lines.push(`The sheet refused the new value (${r.writeRefused}); it was not stored.`);
      if (notice !== "") lines.push(notice);
      const detail: Record<string, unknown> = { lossExpr: r.lossNotation, loss: r.loss, remaining: r.statAfter };
      if (r.ceiling !== null) detail.lossCeiling = r.ceiling;
      if (r.statMax !== null) detail.resourceMax = r.statMax;
      const effective = r.outcome.effectiveTarget;
      const stat = statLabel(pack.sheet, spec.stat, context.locale);
      const outcome = outcomeData(pack, r.outcome, context.locale);
      const table = tableLine(context, r.writeRefused === null ? "dice.loss" : "dice.loss_kept", {
        stat,
        total: r.check.total,
        target: r.statBefore,
        outcome: outcome.label,
        loss: r.loss,
        lossRoll: renderRoll(r.lossRoll),
        before: r.statBefore,
        after: r.statAfter,
      });
      return {
        text: lines.join("\n"),
        events: subsystemEvent(context, pack, spec, {
          actor: name,
          expr: stat,
          rolls: [r.check.total],
          total: r.check.total,
          target: r.statBefore,
          ...(effective === null ? {} : { effectiveTarget: effective }),
          outcome,
          label: stat,
          text: table,
          detail,
        }),
        bookkeeping: { dice: true },
      };
    },
  });
}

function improvementRefusal(refused: ImprovementRefusal): ToolResult {
  switch (refused.refusal) {
    case "unknown_skill":
      return refuse("unknown_skill", `Unknown skill "${refused.skill}" — use a skill from the character sheet.`);
    case "not_numeric":
      return refuse("not_numeric", `"${refused.skill}" is not a number on this sheet.`);
    case "at_cap":
      return refuse("at_cap", `${refused.skill} is already maxed (${refused.value}), no growth needed.`);
  }
}

function improvementTool(pack: RulePack, spec: Extract<SubsystemSpec, { template: "improvement_check" }>, description: string): AnyTool {
  const label = subsystemName(spec, "en");
  return defineTool({
    name: spec.id,
    description,
    params: IMPROVE_PARAMS,
    flags: {},
    suspends: null,
    run(context, args): ToolResult {
      const found = subsystemCharacter(context, pack, label);
      if (!found.ok) return found.result;
      const loaded = found.loaded;
      const result = runSubsystem(pack, spec.id, { template: "improvement_check", sheet: loaded.character.sheet, skill: args.skill_name }, context.random);
      if (!result.ok) return improvementRefusal(result as ImprovementRefusal);
      const r = result as Extract<typeof result, { grew: boolean }>;
      const name = loaded.character.sheet.name;
      const skill = displayName(pack.sheet, r.skill, "en");
      let text: string;
      if (r.grew) {
        if (r.writeRefused === null) {
          const saved = saveSheet(context, loaded, r.sheet);
          if (!saved.ok) return saved.result;
        }
        text = `${name}'s ${skill} ${label}\nRolled: ${r.roll.total} > ${r.before} → success!\n${skill}: ${r.before} → ${r.after} (+${r.after - r.before})`;
        if (r.writeRefused !== null) text += `\nThe sheet refused the new value (${r.writeRefused}); it was not stored.`;
      } else {
        text = `${name}'s ${skill} ${label}\nRolled: ${r.roll.total} ≤ ${r.before} → no growth`;
      }
      const shown = displayName(pack.sheet, r.skill, context.locale);
      const key = !r.grew ? "dice.no_growth" : r.writeRefused === null ? "dice.growth" : "dice.growth_kept";
      return {
        text,
        events: subsystemEvent(context, pack, spec, {
          actor: name,
          expr: shown,
          rolls: [r.roll.total],
          total: r.roll.total,
          target: r.before,
          label: shown,
          text: tableLine(context, key, { skill: shown, total: r.roll.total, before: r.before, after: r.after, gain: r.after - r.before }),
          detail: { grew: r.grew, before: r.before, after: r.after },
        }),
        bookkeeping: { dice: true },
      };
    },
  });
}

/** The newest recorded check of `character`: this turn's ledger, else the room's log. */
export function latestRecordedCheck(context: RoomContext, turn: ToolTurn, character: string): RecordedCheckState | null {
  const own = turn.ledger.checks.get(character);
  if (own !== undefined) return own;
  const store = context.services.store;
  const head = store.room(context.room).head;
  const events = store.eventsBefore(context.room, head + 1, SPEND_LOOKBACK_EVENTS);
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event === undefined || event.kind !== "dice") continue;
    const detail = (event.data as { detail?: unknown } | null)?.detail;
    if (typeof detail !== "object" || detail === null) continue;
    const fields = detail as Record<string, unknown>;
    if (fields.character !== character) continue;
    const recorded = fields.recordedCheck;
    if (typeof recorded !== "object" || recorded === null) continue;
    const check = recorded as Record<string, unknown>;
    const number = (key: string): number | null => (typeof check[key] === "number" && Number.isSafeInteger(check[key]) ? (check[key] as number) : null);
    const text = (key: string): string | null => (typeof check[key] === "string" ? (check[key] as string) : null);
    const skill = text("skill");
    const target = number("target");
    const roll = number("roll");
    if (skill === null || target === null || roll === null) continue;
    return { character, skill, target, roll, rawRoll: number("rawRoll") ?? roll, spent: number("spent") ?? 0, variant: text("variant"), difficulty: text("difficulty") };
  }
  return null;
}

function spendRefusal(label: string, refused: SpendRefusal): ToolResult {
  switch (refused.refusal) {
    case "invalid_points":
      return refuse("invalid_points", `${label} spend must be a positive whole number.`);
    case "stat_unset":
      return refuse("stat_unset", `This character has no ${refused.stat} value to spend.`);
    case "insufficient":
      return refuse("insufficient", `Cannot spend ${refused.points} ${label}; only ${refused.available} remains.`);
    case "no_check":
      return refuse("no_check", "This character has no recorded skill check to adjust.");
    case "ineligible":
      return refuse("ineligible", `${label} cannot adjust the most recent ${refused.skill} check.`);
    case "fumble":
      return refuse("fumble", `A fumble cannot be bought off with ${label}.`);
    case "exceeds_roll":
      return refuse("exceeds_roll", `Spending ${refused.points} ${label} would push the roll below 1 (current roll ${refused.roll}; maximum useful spend is ${refused.maxPoints}).`);
    case "roll_failed":
      return rollFailed(label, refused.errorCode);
  }
}

function spendTool(pack: RulePack, spec: Extract<SubsystemSpec, { template: "resource_spend_adjust" }>, description: string): AnyTool {
  const label = subsystemName(spec, "en");
  return defineTool({
    name: spec.id,
    description,
    params: SPEND_PARAMS,
    flags: {},
    suspends: null,
    run(context, args, turn): ToolResult {
      const found = subsystemCharacter(context, pack, label);
      if (!found.ok) return found.result;
      const loaded = found.loaded;
      const check = latestRecordedCheck(context, turn, loaded.id);
      const result = runSubsystem(pack, spec.id, { template: "resource_spend_adjust", sheet: loaded.character.sheet, points: args.points, check }, context.random);
      if (!result.ok) return spendRefusal(label, result as SpendRefusal);
      const r = result as Extract<typeof result, { spend: unknown }>;
      if (r.writeRefused !== null) return refuse(r.writeRefused, `The sheet refused the new ${label} value (${r.writeRefused}); nothing was spent.`);
      const saved = saveSheet(context, loaded, r.sheet);
      if (!saved.ok) return saved.result;
      const adjusted: RecordedCheckState = { ...(check as RecordedCheckState), roll: r.check.roll, rawRoll: r.check.rawRoll, spent: r.check.spent };
      turn.ledger.checks.set(loaded.id, adjusted);
      const name = loaded.character.sheet.name;
      const level = outcomeData(pack, r.outcome, "en").label;
      const stat = statLabel(pack.sheet, spec.stat, context.locale);
      const outcome = outcomeData(pack, r.outcome, context.locale);
      const skill = displayName(pack.sheet, adjusted.skill, context.locale);
      return {
        text: `${name} spent ${r.points} ${label} on ${adjusted.skill}: ${r.spend.beforeRoll} → ${r.spend.afterRoll} (${level}). Remaining ${label}: ${r.statAfter}`,
        events: subsystemEvent(context, pack, spec, {
          actor: name,
          expr: stat,
          rolls: [r.spend.afterRoll],
          total: r.spend.afterRoll,
          target: adjusted.target,
          outcome,
          label: skill,
          text: tableLine(context, "dice.spend", { stat, points: r.points, skill, before: r.spend.beforeRoll, after: r.spend.afterRoll, outcome: outcome.label, remaining: r.statAfter }),
          detail: { points: r.points, rawRoll: r.check.rawRoll, remaining: r.statAfter, character: loaded.id, recordedCheck: recordedCheckDetail(adjusted) },
        }),
        bookkeeping: { dice: true },
      };
    },
  });
}

function opposedRefusal(refused: OpposedRefusal, sides: { active: string; passive: string }): ToolResult {
  switch (refused.refusal) {
    case "unknown_skill":
    case "not_numeric":
      return refuse(refused.refusal, `The ${refused.side} side's skill "${sides[refused.side]}" has no number to roll against${refused.side === "passive" ? "; give skill2_value" : "; give skill1_value or use a skill on the sheet"}.`);
    case "invalid_value":
      return refuse("invalid_value", `The ${refused.side} side's value must be a whole number.`);
    case "invalid_modifier":
      return refuse("invalid_modifier", `Unknown roll modifier ${refused.modifier}.`);
    case "roll_failed":
      return refuse("roll_failed", `The opposed check could not be rolled (${refused.errorCode}).`);
  }
}

function opposedTool(pack: RulePack, spec: Extract<SubsystemSpec, { template: "opposed" }>, description: string): AnyTool {
  const label = subsystemName(spec, "en");
  return defineTool({
    name: spec.id,
    description,
    params: OPPOSED_PARAMS,
    flags: {},
    suspends: null,
    run(context, args): ToolResult {
      // The active side is the acting character, unless its value is stated; the passive
      // side (an NPC, a creature) has no sheet here, so its value is stated.
      let loaded: LoadedCharacter | null = null;
      if (args.skill1_value === undefined) {
        const found = subsystemCharacter(context, pack, label);
        if (!found.ok) return found.result;
        loaded = found.loaded;
      }
      const result = runSubsystem(
        pack,
        spec.id,
        {
          template: "opposed",
          active: { skill: args.skill1, sheet: loaded?.character.sheet ?? null, value: args.skill1_value ?? null },
          passive: { skill: args.skill2, sheet: null, value: args.skill2_value ?? null },
          variant: context.variant,
        },
        context.random,
      );
      if (!result.ok) return opposedRefusal(result as OpposedRefusal, { active: args.skill1, passive: args.skill2 });
      const r = result as Extract<typeof result, { winner: unknown }>;
      const level = (side: typeof r.active): string => (side.outcome === null ? `total ${side.total}` : outcomeData(pack, side.outcome, "en").label);
      const winner =
        r.winner === "tie"
          ? "Tie"
          : `${r.winner === "active" ? "Active" : "Passive"} side (${r.winner === "active" ? args.skill1 : args.skill2})${r.decidedBy === "value" ? " — higher skill value" : ""}`;
      const lines = [
        `${label}: ${args.skill1} vs ${args.skill2}`,
        `Active: ${args.skill1}=${r.active.value} rolled ${r.active.check.total} → ${level(r.active)}`,
        `Passive: ${args.skill2}=${r.passive.value} rolled ${r.passive.check.total} → ${level(r.passive)}`,
        `Result: ${winner}`,
      ];
      const side = (result: typeof r.active): Record<string, unknown> => ({
        skill: result.skill,
        value: result.value,
        roll: result.check.total,
        total: result.total,
        ...(result.outcome === null ? {} : { outcome: outcomeData(pack, result.outcome, context.locale) }),
      });
      const active = r.active;
      const shown = (typed: string, result: typeof r.active): SideLine => ({
        skill: displayName(pack.sheet, resolveName(pack.sheet, typed) ?? typed, context.locale),
        total: result.total,
        outcome: result.outcome === null ? null : outcomeData(pack, result.outcome, context.locale).label,
      });
      const first = shown(args.skill1, active);
      return {
        text: lines.join("\n"),
        events: subsystemEvent(context, pack, spec, {
          kind: "opposed",
          actor: loaded?.character.sheet.name ?? context.who.character?.name ?? "",
          expr: `${args.skill1} vs ${args.skill2}`,
          rolls: [active.check.total, r.passive.check.total],
          total: active.total,
          label: first.skill,
          text: opposedLine(context, first, shown(args.skill2, r.passive), r.winner, r.decidedBy),
          ...(active.outcome === null ? {} : { outcome: outcomeData(pack, active.outcome, context.locale) }),
          detail: { active: side(active), passive: side(r.passive), winner: r.winner },
        }),
        bookkeeping: { dice: true },
      };
    },
  });
}

function drawTool(pack: RulePack, spec: Extract<SubsystemSpec, { template: "table_draw" }>, description: string): AnyTool {
  const label = subsystemName(spec, "en");
  return defineTool({
    name: spec.id,
    description,
    params: DRAW_PARAMS,
    flags: {},
    suspends: null,
    run(context, args): ToolResult {
      const result = runSubsystem(pack, spec.id, { template: "table_draw", table: args.table }, context.random);
      if (!result.ok) {
        const refused = result as TableDrawRefusal;
        return refuse("unknown_table", `Unknown ${label} table — available: ${refused.known.join(", ")}`);
      }
      const r = result as Extract<typeof result, { entry: string }>;
      const table = findTable(spec, r.table);
      return { text: `${table === null ? r.table : tableName(table, "en")}:\n${r.entry}`, bookkeeping: { dice: true } };
    },
  });
}

/** The pack's subsystem tools, in declared order. */
export function subsystemTools(pack: RulePack): AnyTool[] {
  const tools: AnyTool[] = [];
  for (const spec of pack.subsystems.values()) {
    let description = SUMMARIES[spec.template].replace("{label}", subsystemName(spec, "en"));
    switch (spec.template) {
      case "check_with_loss":
        tools.push(lossTool(pack, spec, description));
        break;
      case "improvement_check":
        tools.push(improvementTool(pack, spec, description));
        break;
      case "resource_spend_adjust":
        tools.push(spendTool(pack, spec, description));
        break;
      case "opposed":
        tools.push(opposedTool(pack, spec, description));
        break;
      case "table_draw":
        if (spec.tables.size > 0) description += ` Tables: ${[...spec.tables.keys()].join(", ")}.`;
        tools.push(drawTool(pack, spec, description));
        break;
    }
  }
  return tools;
}
