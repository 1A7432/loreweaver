import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { Block } from "./frames.js";
import {
  instantiate,
  MAX_REPEAT_INSTANCES,
  panelBlocks,
  panelResolver,
  panelViewNames,
  parsePath,
  type PanelEntry,
  type PanelTemplate,
} from "./panels.js";
import { matchesSchema } from "./schema.js";
import { PANELS_VIEW_SCHEMA } from "./views.js";

// The shared table: every client's `instantiate` must produce exactly these blocks.
const VECTORS = JSON.parse(readFileSync(fileURLToPath(new URL("./panels.vectors.json", import.meta.url)), "utf8")) as {
  cases: { id: string; why: string; template: PanelTemplate; views: Record<string, unknown>; expect: Block[] }[];
};

describe("panel instantiation vectors", () => {
  test("the table covers both halves of the contract", () => {
    expect(VECTORS.cases.length).toBeGreaterThanOrEqual(40);
    expect(VECTORS.cases.some((row) => row.expect.length === 0)).toBe(true);
    expect(VECTORS.cases.some((row) => row.expect.length > 1)).toBe(true);
    expect(VECTORS.cases.some((row) => row.expect.length === MAX_REPEAT_INSTANCES)).toBe(true);
  });

  for (const row of VECTORS.cases) {
    test(`${row.id} — ${row.why}`, () => {
      expect(instantiate(row.template, new Map(Object.entries(row.views)))).toEqual(row.expect);
    });
  }
});

describe("paths", () => {
  test("the grammar", () => {
    expect(parsePath("me.character.resources.0.value")).toEqual(["me", "character", "resources", "0", "value"]);
    expect(parsePath("vars.module.潮位")).toEqual(["vars", "module", "潮位"]);
    for (const bad of ["", "Me.x", "me..x", "me.01", "me.a-b", "1me", `me.${"a".repeat(200)}`, "a.b.c.d.e.f.g.h.i", 7]) expect(parsePath(bad)).toBeNull();
  });

  test("a condition sees scalars: lists and records as whether they hold anything", () => {
    const resolve = panelResolver([{ as: "t", view: "m/t" }], new Map([["m/t", { list: [{ hidden: true }], rec: {}, n: 2, s: "x" }]]));
    expect([resolve("t.list"), resolve("t.rec"), resolve("t.n"), resolve("t.s"), resolve("t.none"), resolve("u.n")]).toEqual([false, false, 2, "x", null, null]);
  });
});

describe("panel entries", () => {
  const values = new Map<string, unknown>([["harbor/tide", { level: 3 }]]);
  const template: PanelEntry = {
    id: "harbor/tide",
    title: "Tide",
    slot: "sidebar",
    kind: "template",
    views: [{ as: "tide", view: "harbor/tide" }, { as: "again", view: "harbor/tide" }, { as: "me", view: "me" }],
    source: { kind: "pack", id: "harbor" },
    blocks: [{ kind: "stat", label: "Level", value: { $view: "tide.level" } }],
  };

  test("a template's blocks; a page's fallback; null for a page without one", () => {
    expect(panelBlocks(template, values)).toEqual([{ kind: "stat", label: "Level", value: 3 }]);
    const page: PanelEntry = { ...template, kind: "page", blocks: undefined, page: { hash: "a".repeat(64), size: 10, mime: "text/html" }, fallback: [{ kind: "text", text: "Open in Studio." }] };
    expect(panelBlocks(page, values)).toEqual([{ kind: "text", text: "Open in Studio." }]);
    expect(panelBlocks({ ...page, fallback: null }, values)).toBeNull();
  });

  test("the views to subscribe to, once each", () => {
    expect(panelViewNames(template)).toEqual(["harbor/tide", "me"]);
  });

  test("the view's schema takes both kinds", () => {
    const { blocks: _blocks, ...rest } = template;
    const page = { ...rest, kind: "page", page: { hash: "a".repeat(64), size: 10, mime: "text/html" }, fallback: null };
    expect(matchesSchema({ panels: [template, page] }, PANELS_VIEW_SCHEMA)).toBe(true);
    expect(matchesSchema({ panels: [{ ...template, slot: "floor" }] }, PANELS_VIEW_SCHEMA)).toBe(false);
  });
});
