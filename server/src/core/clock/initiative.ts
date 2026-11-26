// The initiative order of a fight.
//
// `initiative` (one per room): `{ order: [{ name, value }], round, current }`. `order` is
// highest value first; a tie keeps the order combatants joined in. `current` indexes the
// combatant whose turn it is; `round` counts from 1 while a fight is on and is 0 when no
// one is listed. The order is fixed and a pointer walks it (rather than rotating the list)
// so the table always sees the same order, with the acting combatant marked.
//   - every viewer: the whole order, the round and whose turn it is. Initiative is rolled
//     in the open.
//
// `rollInitiative` rolls a pack's declared initiative expression for a sheet: its `{name}`
// slots read the sheet's canonical values (`1d100 + {敏捷}`).
import { DiceError, type DiceExpression, type Expr, type IntTerm, rollExpression, type Roll } from "../dice/index.ts";
import type { Document, DocumentType, JsonObject, Viewer, WriteViolation } from "../documents/model.ts";
import type { RandomSource } from "../random.ts";
import { type Sheet, type SheetSpec, sheetValue } from "../sheets/index.ts";
import { cleanText, isRecord, onlyKeys } from "./text.ts";

export const INITIATIVE_TYPE = "initiative";
export const INITIATIVE_ID = "initiative";

export const MAX_COMBATANTS = 32;
/** A combatant's name, in code points. */
export const MAX_COMBATANT_NAME_CHARS = 64;

export type Combatant = { readonly name: string; readonly value: number };
export type Initiative = { readonly order: readonly Combatant[]; readonly round: number; readonly current: number };

export const NO_FIGHT: Initiative = Object.freeze({ order: Object.freeze([]), round: 0, current: 0 });

export type InitiativeRefusal = "bad_name" | "bad_value" | "already_listed" | "full" | "unknown_combatant" | "empty";

export type InitiativeChange = { readonly ok: true; readonly data: Initiative } | { readonly ok: false; readonly code: InitiativeRefusal };

function made(order: readonly Combatant[], round: number, current: number): InitiativeChange {
  return { ok: true, data: Object.freeze({ order: Object.freeze([...order]), round, current }) };
}

/**
 * List a combatant. The first one listed starts round 1. Joining mid-fight ahead of the
 * acting combatant does not take the turn from them: the pointer moves with them.
 */
export function addCombatant(initiative: Initiative, name: string, value: number): InitiativeChange {
  const clean = cleanText(name, MAX_COMBATANT_NAME_CHARS);
  if (clean === null) return { ok: false, code: "bad_name" };
  if (!Number.isSafeInteger(value)) return { ok: false, code: "bad_value" };
  if (initiative.order.some((item) => item.name === clean)) return { ok: false, code: "already_listed" };
  if (initiative.order.length >= MAX_COMBATANTS) return { ok: false, code: "full" };
  const combatant = Object.freeze({ name: clean, value: value + 0 });
  if (initiative.order.length === 0) return made([combatant], 1, 0);
  let at = initiative.order.findIndex((item) => item.value < value);
  if (at < 0) at = initiative.order.length;
  const order = [...initiative.order.slice(0, at), combatant, ...initiative.order.slice(at)];
  return made(order, initiative.round, at <= initiative.current ? initiative.current + 1 : initiative.current);
}

/**
 * Take a combatant out (fallen, fled). Removing the acting one passes the turn to whoever
 * came next — into the next round when they were last. Removing the last one ends the fight.
 */
export function removeCombatant(initiative: Initiative, name: string): InitiativeChange {
  const at = initiative.order.findIndex((item) => item.name === name.trim());
  if (at < 0) return { ok: false, code: "unknown_combatant" };
  const order = initiative.order.filter((_, index) => index !== at);
  if (order.length === 0) return { ok: true, data: NO_FIGHT };
  if (at < initiative.current) return made(order, initiative.round, initiative.current - 1);
  if (at === initiative.current && at >= order.length) return made(order, initiative.round + 1, 0);
  return made(order, initiative.round, initiative.current);
}

/** The turn passes to the next combatant; past the last one, a new round begins. */
export function nextTurn(initiative: Initiative): InitiativeChange {
  if (initiative.order.length === 0) return { ok: false, code: "empty" };
  const next = initiative.current + 1;
  return next >= initiative.order.length ? made(initiative.order, initiative.round + 1, 0) : made(initiative.order, initiative.round, next);
}

/** The fight is over. */
export function clearInitiative(): Initiative {
  return NO_FIGHT;
}

/** Whose turn it is, or null when no one is listed. */
export function actingCombatant(initiative: Initiative): Combatant | null {
  return initiative.order[initiative.current] ?? null;
}

export function initiativeData(initiative: Initiative): JsonObject {
  return {
    order: initiative.order.map((item) => ({ name: item.name, value: item.value })),
    round: initiative.round,
    current: initiative.current,
  };
}

/** A stored order read back; null when malformed or inconsistent. */
export function readInitiative(data: JsonObject): Initiative | null {
  const { order, round, current } = data;
  if (!Array.isArray(order) || typeof round !== "number" || typeof current !== "number") return null;
  const combatants: Combatant[] = [];
  for (const item of order) {
    if (!isRecord(item) || typeof item.name !== "string" || typeof item.value !== "number") return null;
    combatants.push(Object.freeze({ name: item.name, value: item.value }));
  }
  if (combatants.length === 0 ? round !== 0 || current !== 0 : current < 0 || current >= combatants.length) return null;
  return Object.freeze({ order: Object.freeze(combatants), round, current });
}

export interface InitiativeView {
  readonly round: number;
  /** The acting combatant's name, or null when no one is listed. */
  readonly acting: string | null;
  readonly order: readonly Combatant[];
}

function projectInitiative(document: Document, _viewer: Viewer): InitiativeView | null {
  const initiative = readInitiative(document.data);
  if (initiative === null) return null;
  return {
    round: initiative.round,
    acting: actingCombatant(initiative)?.name ?? null,
    order: initiative.order.map((item) => ({ name: item.name, value: item.value })),
  };
}

function validateInitiative(data: JsonObject): WriteViolation[] {
  const extra = onlyKeys(data, ["order", "round", "current"]);
  if (extra !== null) return [{ code: "unknown_field", path: extra }];
  const { order, round, current } = data;
  if (!Array.isArray(order)) return [{ code: "bad_order", path: "order" }];
  const violations: WriteViolation[] = [];
  if (order.length > MAX_COMBATANTS) violations.push({ code: "full", path: "order" });
  const names = new Set<string>();
  let previous = Number.POSITIVE_INFINITY;
  order.forEach((item, index) => {
    const path = `order.${index}`;
    if (!isRecord(item) || onlyKeys(item, ["name", "value"]) !== null) {
      violations.push({ code: "bad_combatant", path });
      return;
    }
    if (typeof item.name !== "string" || cleanText(item.name, MAX_COMBATANT_NAME_CHARS) !== item.name) violations.push({ code: "bad_name", path: `${path}.name` });
    else if (names.has(item.name)) violations.push({ code: "already_listed", path: `${path}.name` });
    else names.add(item.name);
    if (typeof item.value !== "number" || !Number.isSafeInteger(item.value)) violations.push({ code: "bad_value", path: `${path}.value` });
    else {
      if (item.value > previous) violations.push({ code: "out_of_order", path: `${path}.value` });
      previous = item.value;
    }
  });
  const fighting = order.length > 0;
  if (typeof round !== "number" || !Number.isSafeInteger(round) || (fighting ? round < 1 : round !== 0)) violations.push({ code: "bad_round", path: "round" });
  if (typeof current !== "number" || !Number.isSafeInteger(current) || (fighting ? current < 0 || current >= order.length : current !== 0)) {
    violations.push({ code: "bad_current", path: "current" });
  }
  return violations;
}

export const initiativeDocument: DocumentType<InitiativeView> = {
  name: INITIATIVE_TYPE,
  lifecycle: { reset: "story" },
  version: 1,
  project: projectInitiative,
  validate: validateInitiative,
};

// ---------------------------------------------------------------------------
// Rolling
// ---------------------------------------------------------------------------

export type InitiativeRoll =
  | { readonly ok: true; readonly value: number; readonly roll: Roll }
  | {
      readonly ok: false;
      /** `no_initiative_roll`: the pack declares none (the Keeper supplies a value);
       * `stat_unavailable`: a slot's stat is not a number on this sheet (`name` says which);
       * `roll_failed`: the dice engine refused the filled-in roll. */
      readonly code: "no_initiative_roll" | "stat_unavailable" | "roll_failed";
      readonly name?: string;
    };

function termSlots(term: IntTerm | { readonly kind: "fate" } | { readonly kind: "max" } | null, out: Set<string>): void {
  if (term !== null && term.kind === "slot") out.add(term.name);
}

function slotNames(expr: Expr, out: Set<string>): Set<string> {
  switch (expr.kind) {
    case "number":
      break;
    case "slot":
      out.add(expr.name);
      break;
    case "dice":
      termSlots(expr.count, out);
      termSlots(expr.sides, out);
      for (const op of expr.ops) for (const selector of op.selectors) termSlots(selector.count, out);
      break;
    case "set":
      for (const item of expr.items) slotNames(item, out);
      for (const op of expr.ops) for (const selector of op.selectors) termSlots(selector.count, out);
      break;
    case "group":
      slotNames(expr.inner, out);
      for (const op of expr.ops) for (const selector of op.selectors) termSlots(selector.count, out);
      break;
    case "unary":
      slotNames(expr.operand, out);
      break;
    case "binary":
      slotNames(expr.left, out);
      slotNames(expr.right, out);
      break;
    case "pool":
      slotNames(expr.dice, out);
      slotNames(expr.threshold, out);
      break;
  }
  return out;
}

/**
 * Roll `expression` (a pack's `initiative`, or null when it declares none) for `sheet`.
 * There is no engine fallback roll: a system without a declared initiative has no rule
 * here to guess at, so the value is the Keeper's to give.
 */
export function rollInitiative(expression: DiceExpression | null, spec: SheetSpec, sheet: Sheet, random: RandomSource): InitiativeRoll {
  if (expression === null) return { ok: false, code: "no_initiative_roll" };
  const params = new Map<string, number>();
  for (const name of slotNames(expression.root, new Set())) {
    const read = sheetValue(spec, sheet, name);
    if (read.kind !== "value") return { ok: false, code: "stat_unavailable", name };
    params.set(name, read.value);
  }
  try {
    const roll = rollExpression(expression, random, { params });
    return { ok: true, value: roll.total, roll };
  } catch (error) {
    if (error instanceof DiceError) return { ok: false, code: "roll_failed" };
    throw error;
  }
}
