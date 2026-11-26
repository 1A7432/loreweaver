/**
 * Validating a sheet against its pack's creation constraints. Deterministic and
 * model-free: every path that writes stats (manual edits, Keeper tool writes, generation,
 * imports) runs this, so they all get the same enforcement.
 */

import { evaluateSheet } from "./evaluate.ts";
import { evaluateInteger, type FormulaIssue } from "./formulas.ts";
import { refreshSheet } from "./refresh.ts";
import { readDraft, type Sheet, type SheetDraft, type SheetViolation, settleDraft, violation } from "./sheet.ts";
import type { Range, SheetSpec } from "./spec.ts";
import { type Entry, tableGet } from "./table.ts";
import { coerceInt, foldCase, stripSpace } from "./text.ts";

export interface ValidateOptions {
  /** Creation (true) re-derives every current pool from its start; an edit (false, the
   * default) keeps current pools and only clamps them to their new maxima. */
  readonly initializeVitals?: boolean;
  /**
   * How the sheet was made. Only `point_buy` (spelled in any case, `-` or `_`) changes
   * anything: it adds the point-buy budget check. Rolled, standard-array, imported and
   * in-play sheets get the shared range checks without being guessed to be point-bought.
   */
  readonly creationMethod?: string | null;
}

export interface Validated {
  /** The sheet, clamped into the pack's ranges and refreshed. */
  readonly sheet: Sheet;
  /** In report order: structural findings, attribute clamps (pack order), skill clamps
   * (sheet order), values that could not be kept, budgets, point-buy. */
  readonly violations: readonly SheetViolation[];
  /** Formulas that failed while validating (a budget that failed is not checked). */
  readonly issues: readonly FormulaIssue[];
}

type ClampKind = "attribute" | "skill";

function clampEntries(entries: Entry<unknown>[], key: string, range: Range, kind: ClampKind, out: SheetViolation[]): void {
  const at = entries.findIndex(([name]) => name === key);
  const entry = entries[at];
  if (entry === undefined) return;
  const section = kind === "attribute" ? "attributes" : "skills";
  const limit = [range.min, range.max] as const;
  const value = coerceInt(entry[1]);
  if (value === null) {
    entries[at] = [key, range.min];
    out.push(violation(`${kind}_not_numeric`, section, key, entry[1], range.min, limit));
    return;
  }
  const corrected = Math.max(range.min, Math.min(range.max, value));
  entries[at] = [key, corrected];
  if (corrected !== value) {
    out.push(violation(value < range.min ? `${kind}_below_min` : `${kind}_above_max`, section, key, value, corrected, limit));
  }
}

function clampDraft(spec: SheetSpec, draft: SheetDraft, out: SheetViolation[]): void {
  for (const [key, range] of spec.constraints.attributes) clampEntries(draft.attributes, key, range, "attribute", out);
  const skillRange = spec.constraints.skills;
  if (skillRange === null) return;
  const derived = spec.shape?.derivedSkills;
  for (const [key] of [...draft.skills]) {
    // A derived slot is settled by the refresh below; clamping it first would make the
    // clamped copy look like a trained override.
    if (derived?.has(key)) continue;
    clampEntries(draft.skills, key, skillRange, "skill", out);
  }
}

/** Sum that saturates at the exact-integer limit instead of losing precision. */
function addSaturating(a: number, b: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, a + b);
}

function checkBudgets(spec: SheetSpec, sheet: Sheet, out: SheetViolation[], issues: FormulaIssue[]): void {
  const budgets = spec.constraints.budgets;
  if (budgets.length === 0) return;
  const shape = spec.shape;
  // Spent: what every non-derived skill sits above its fresh-sheet base (a custom
  // skill's base is 0).
  let spent = 0;
  for (const [skill, value] of sheet.skills) {
    if (shape?.derivedSkills.has(skill)) continue;
    const base = shape ? (tableGet(shape.skills, skill) ?? 0) : 0;
    spent = addSaturating(spent, Math.max(0, value - base));
  }
  const evaluation = evaluateSheet(spec, sheet);
  issues.push(...evaluation.issues);
  budgetLoop: for (const budget of budgets) {
    let total = 0;
    for (const part of budget.parts) {
      const exprs = part.kind === "formula" ? [part.expr] : part.exprs;
      let best: number | null = null;
      for (const expr of exprs) {
        const outcome = evaluateInteger("budget", budget.id, expr, evaluation.lookup);
        if (!outcome.ok) {
          issues.push(outcome.issue);
          continue budgetLoop;
        }
        best = best === null ? outcome.value : Math.max(best, outcome.value);
      }
      total += best ?? 0;
      if (!Number.isSafeInteger(total)) {
        issues.push(
          Object.freeze({ kind: "budget", name: budget.id, code: "out_of_range", exprCode: null, detail: "the budget total left the exact integer range" }),
        );
        continue budgetLoop;
      }
    }
    if (spent > total) out.push(Object.freeze({ ...violation("budget_exceeded", "skills", null, spent, null, total), budget: budget.id }));
  }
}

function checkPointBuy(spec: SheetSpec, sheet: Sheet, out: SheetViolation[]): void {
  const rule = spec.constraints.pointBuy;
  if (rule === null) return;
  const values: number[] = [];
  for (const key of spec.constraints.attributes.keys()) {
    const value = tableGet(sheet.attributes, key);
    // A sheet with an attribute outside the point-buy range was not point-bought by these
    // costs at all; the range violations already say what is wrong with it.
    if (value === undefined || value < rule.min || value > rule.max) return;
    values.push(value);
  }
  if (values.length === 0) return;
  const spent = values.reduce((sum, value) => sum + (rule.costs.get(value) ?? 0), 0);
  if (spent > rule.budget) out.push(violation("point_buy_budget_exceeded", "attributes", null, spent, null, rule.budget));
}

/** `point_buy` from `Point-Buy`, ` POINT_BUY `, … */
function normalizeMethod(method: string | null | undefined): string {
  return typeof method === "string" ? foldCase(stripSpace(method)).replaceAll("-", "_") : "";
}

/**
 * Validate `input` (a `Sheet`, or the same shape from loose input) against the pack:
 * clamp each constrained attribute and every non-derived skill into its range (a value
 * that is not a number becomes the minimum), settle all other values (see `parseSheet`),
 * refresh, then check the skill-point budgets and, for point-buy creation, the point-buy
 * budget. Returns the corrected sheet and every violation; never throws on content.
 */
export function validateSheet(spec: SheetSpec, input: unknown, options: ValidateOptions = {}): Validated {
  const out: SheetViolation[] = [];
  const draft = readDraft(spec, input, out);
  clampDraft(spec, draft, out);
  const settled = settleDraft(spec, draft, out);
  const refreshed = refreshSheet(spec, settled, { initializeVitals: options.initializeVitals ?? false });
  const issues: FormulaIssue[] = [...refreshed.issues];
  checkBudgets(spec, refreshed.sheet, out, issues);
  if (normalizeMethod(options.creationMethod) === "point_buy") checkPointBuy(spec, refreshed.sheet, out);
  // One formula can fail in several passes; report each failure once.
  const seen = new Set<string>();
  const unique = issues.filter((issue) => {
    const key = `${issue.kind}\u0000${issue.name}\u0000${issue.code}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { sheet: refreshed.sheet, violations: Object.freeze(out), issues: Object.freeze(unique) };
}
