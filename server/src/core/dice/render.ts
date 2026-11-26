/**
 * Reading a `Roll`: its primary dice group, the natural critical of a single-die roll, and
 * a one-line rendering made only of notation and numbers (no words to translate).
 *
 * Rendering conventions: each dice group lists its dice in parentheses after its notation;
 * a dropped die or member is wrapped in `~~`; a die that exploded is followed by `!`; a
 * rerolled die shows its faces joined by ` -> `; a die moved by `mi`/`ma` shows
 * `rolled => counted`. Example: `4d6kh3 (5, 3, ~~1~~, 6) + 2 = 16`.
 */

import { formatNumber } from "./parse.ts";
import type { DiceRoll, Die, DieSides, Roll, RollNode } from "./types.ts";

/**
 * The first dice group in reading order (left to right, outside in), the one a roll's
 * natural result is read from: `3d6 + 2d4` -> `3d6`, `5 + 3d6` -> `3d6`. Null when the
 * notation has no dice.
 */
export function primaryDice(roll: Roll | RollNode): DiceRoll | null {
  const node = "root" in roll ? roll.root : roll;
  switch (node.kind) {
    case "dice":
      return node;
    case "number":
      return null;
    case "pool":
      return node.dice;
    case "group":
      return primaryDice(node.inner);
    case "unary":
      return primaryDice(node.operand);
    case "binary":
      return primaryDice(node.left) ?? primaryDice(node.right);
    case "set":
      for (const item of node.items) {
        const found = primaryDice(item);
        if (found !== null) return found;
      }
      return null;
  }
}

/** Faces of a group's kept dice, left to right. */
export function keptFaces(group: DiceRoll): number[] {
  return group.dice.filter((die) => die.kept).map((die) => die.face);
}

/**
 * The natural critical of a roll that kept exactly ONE die: the highest face is a success
 * and a 1 a failure, except on a d100, where 1 is the success and 100 the failure (the
 * bare roll-under reading; graded checks are the rule packs' business; `d%` is a d100).
 * Fate dice have no natural critical, and neither has a die that cannot vary (fewer
 * than two faces: a d1 would otherwise be a success and a failure at once). Whether
 * criticals apply at all is the caller's decision.
 */
export function naturalCritical(sides: DieSides, kept: readonly number[]): "success" | "failure" | null {
  if (kept.length !== 1 || typeof sides !== "number" || sides < 2) return null;
  const face = kept[0];
  if (sides === 100) return face === 1 ? "success" : face === 100 ? "failure" : null;
  if (face === sides) return "success";
  if (face === 1) return "failure";
  return null;
}

function renderDie(die: Die): string {
  let text = die.rolls.map(formatNumber).join(" -> ");
  const last = die.rolls[die.rolls.length - 1];
  if (last !== die.face) text += ` => ${formatNumber(die.face)}`;
  if (die.exploded) text += "!";
  return die.kept ? text : `~~${text}~~`;
}

function renderLabels(labels: readonly string[]): string {
  return labels.map((label) => ` [${label}]`).join("");
}

function sidesText(sides: DieSides): string {
  return typeof sides === "number" ? String(sides) : sides;
}

function renderDice(node: DiceRoll): string {
  return `${node.count}d${sidesText(node.sides)}${node.ops} (${node.dice.map(renderDie).join(", ")})${renderLabels(node.labels)}`;
}

function renderNode(node: RollNode, insideDropped: boolean): string {
  const dropped = !node.kept && !insideDropped;
  const inner = insideDropped || dropped;
  let text: string;
  switch (node.kind) {
    case "number":
      text = formatNumber(node.value) + renderLabels(node.labels);
      break;
    case "dice":
      text = renderDice(node);
      break;
    case "set": {
      const items = node.items.map((item) => renderNode(item, inner)).join(", ");
      text = `(${items}${node.items.length === 1 ? "," : ""})${node.ops}${renderLabels(node.labels)}`;
      break;
    }
    case "group":
      text = `(${renderNode(node.inner, inner)})${node.ops}${renderLabels(node.labels)}`;
      break;
    case "unary":
      text = node.op + renderNode(node.operand, inner);
      break;
    case "binary":
      text = `${renderNode(node.left, inner)} ${node.op} ${renderNode(node.right, inner)}`;
      break;
    case "pool":
      text = `${renderDice(node.dice)} ${node.comparison} ${formatNumber(node.threshold)}`;
      break;
  }
  return dropped ? `~~${text}~~` : text;
}

/** The roll as one line of notation and numbers, ending in `= total`. */
export function renderRoll(roll: Roll): string {
  return `${renderNode(roll.root, false)} = ${roll.total}`;
}
