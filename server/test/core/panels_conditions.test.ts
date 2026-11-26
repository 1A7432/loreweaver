// Panel `visible_when` conditions are evaluated by clients, against views, with the protocol
// package's resolver (`panelResolver`) and its client-side evaluator. The server decides at
// pack build time what a condition may contain (`compile(…, {portable: true})`), so its
// evaluator must agree with the client's on view-shaped values too: on every condition of
// the shared panel vectors, and on random conditions over random views. A condition sees
// scalars only (a list or a record reads as whether it holds anything), which keeps both
// evaluators inside the values they are meant to agree on.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { panelResolver, type PanelTemplate } from "loreweaver-protocol/v3";

import { compile, ExprError } from "../../src/core/condexpr.ts";

const CLIENT_EVALUATOR = new URL("../../../clients/protocol/src/condexpr.ts", import.meta.url).href;
const { isVisible } = (await import(CLIENT_EVALUATOR)) as { isVisible: (condition: string | undefined, resolve: (path: string) => unknown) => boolean };

const VECTORS = JSON.parse(readFileSync(join(import.meta.dir, "../../../clients/protocol/src/v3/panels.vectors.json"), "utf8")) as {
  cases: { id: string; template: PanelTemplate; views: Record<string, unknown> }[];
};

/** The server's verdict: the condition holds; an error hides, as on every client. */
function server(condition: string, resolve: (path: string) => unknown): boolean {
  try {
    return compile(condition, { portable: true }).test(resolve);
  } catch (error) {
    if (error instanceof ExprError) return false;
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A list inside the views, raw, for walking a repeat's elements (hidden ones removed, as clients do). */
function listAt(template: PanelTemplate, values: Record<string, unknown>, path: string): unknown[] {
  const [handle, ...rest] = path.split(".");
  const ref = template.views.find((item) => item.as === handle);
  let current: unknown = ref === undefined ? undefined : values[ref.view];
  for (const part of rest) current = isRecord(current) && Object.hasOwn(current, part) ? current[part] : undefined;
  return Array.isArray(current) ? current.filter((item) => !(isRecord(item) && item.hidden === true)) : [];
}

describe("the conditions of the shared panel vectors", () => {
  const rows: [string, string, (path: string) => unknown][] = [];
  for (const row of VECTORS.cases) {
    const values = new Map(Object.entries(row.views));
    for (const block of row.template.blocks as unknown as readonly Record<string, unknown>[]) {
      if (typeof block.visible_when === "string") rows.push([row.id, block.visible_when, panelResolver(row.template.views, values)]);
      const repeat = block.repeat;
      if (!isRecord(repeat) || !isRecord(repeat.block) || typeof repeat.block.visible_when !== "string" || typeof repeat.each !== "string") continue;
      for (const item of listAt(row.template, row.views, repeat.each)) {
        rows.push([`${row.id} (element)`, repeat.block.visible_when, panelResolver(row.template.views, values, new Map([[String(repeat.as), item]]))]);
      }
    }
  }

  test("there are enough of them, deciding both ways", () => {
    expect(rows.length).toBeGreaterThanOrEqual(12);
    expect(rows.some(([, condition, resolve]) => server(condition, resolve))).toBe(true);
    expect(rows.some(([, condition, resolve]) => !server(condition, resolve))).toBe(true);
  });

  test.each(rows)("%s: %s", (_id, condition, resolve) => {
    expect(server(condition, resolve)).toBe(isVisible(condition, resolve));
  });
});

describe("differential over random views", () => {
  // A fixed-seed xorshift: deterministic, so a failure reproduces.
  let seed = 0x1b873593;
  const next = (): number => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 0x1_0000_0000;
  };
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;

  const SCALARS: readonly unknown[] = [0, 1, 2, 46, -3, 2.5, "2", " 7 ", "", "abc", "b", true, false, null];
  const value = (depth: number): unknown => {
    const roll = next();
    if (depth <= 0 || roll < 0.55) return pick(SCALARS);
    if (roll < 0.75) return Array.from({ length: Math.floor(next() * 3) }, (_, index) => (next() < 0.5 ? { id: `k${index}`, v: pick(SCALARS), ...(next() < 0.2 ? { hidden: true } : {}) } : pick(SCALARS)));
    return next() < 0.15 ? {} : { v: value(depth - 1), w: pick(SCALARS) };
  };
  const PATHS = ["t.a", "t.b", "t.l", "t.l.0", "t.l.k1", "t.r", "t.r.v", "t.r.w", "t.none", "u.x", "m.a"];
  const LITERALS = ["0", "1", "2", "46", "2.5", "'2'", "'abc'", "''", "true", "false", "null"];
  const ORDERABLE_WITH_ONE = ["0", "1", "2", "46", "2.5", "'2'", "true", "false"];
  const comparison = (): string => {
    if (next() < 0.5) return `${pick(PATHS)} ${pick(["===", "!==", "==", "!="])} ${next() < 0.5 ? pick(PATHS) : pick(LITERALS)}`;
    const pair = [pick(PATHS), pick(ORDERABLE_WITH_ONE)];
    const [first, second] = next() < 0.5 ? pair : [pair[1], pair[0]];
    return `${first} ${pick([">=", "<=", ">", "<"])} ${second}`;
  };
  const expression = (depth: number): string => {
    const roll = next();
    if (depth <= 0 || roll < 0.3) return next() < 0.6 ? comparison() : pick(PATHS);
    if (roll < 0.45) return `!${expression(depth - 1)}`;
    if (roll < 0.55) return `(${expression(depth - 1)})`;
    return `${expression(depth - 1)} ${pick(["&&", "||", "and", "or"])} ${expression(depth - 1)}`;
  };

  test("2000 random conditions over random views agree", () => {
    let shown = 0;
    for (let index = 0; index < 2000; index += 1) {
      const condition = expression(3);
      const tide = { a: value(0), b: value(0), l: next() < 0.7 ? [{ id: "k1", v: pick(SCALARS) }, value(0)] : value(1), r: value(2) };
      const values = new Map<string, unknown>(next() < 0.9 ? [["mod/tide", tide], ["me", { a: value(0) }]] : []);
      const resolve = panelResolver([{ as: "t", view: "mod/tide" }, { as: "m", view: "me" }], values);
      const ours = server(condition, resolve);
      if (ours) shown += 1;
      expect({ condition, tide, ours }).toEqual({ condition, tide, ours: isVisible(condition, resolve) });
    }
    expect(shown).toBeGreaterThan(200);
    expect(shown).toBeLessThan(1800);
  });
});
