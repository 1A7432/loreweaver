// A panel shows what its viewer's views hold and nothing else. A template that binds to EVERY
// path of the `variables` view — every field, every element by index and by key, as text and
// as a `visible_when` gate — instantiated for a player or an observer shows no keeper-only
// variable: the view they are sent does not hold one, and the panel has no other data path.
// For an admin, whose view holds the unexposed variables flagged `hidden`, the panel does not
// surface them either (a list is read without its hidden elements).
import { describe, expect, test } from "bun:test";

import { type Block, instantiate, MAX_PANEL_BLOCKS, parsePath, type TemplateBlock } from "loreweaver-protocol/v3";

import { BUILT_IN_VIEWS, type ViewerContext } from "../../../src/gateway/views/index.ts";
import { ADA, ADMIN, ADMIN_ALLOWED, EVE, leaks, type Room, seededRoom, TABLE_SECRETS } from "./fixture.ts";

const VIEWS = [{ as: "vars", view: "variables" }];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every path into `value` the binding grammar can spell: fields, list indices, list keys. */
function everyPath(value: unknown, path: string, out: string[]): string[] {
  if (parsePath(path) === null) return out;
  out.push(path);
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      everyPath(item, `${path}.${index}`, out);
      if (isRecord(item)) for (const field of ["id", "key", "path"]) if (typeof item[field] === "string") everyPath(item, `${path}.${item[field] as string}`, out);
    });
  } else if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) everyPath(item, `${path}.${key}`, out);
  }
  return out;
}

/** The variables view computed for `viewer`. */
async function variablesFor(room: Room, viewer: ViewerContext): Promise<unknown> {
  const view = BUILT_IN_VIEWS.find((candidate) => candidate.name === "variables");
  if (view === undefined) throw new Error("variables");
  return view.compute(room.source(), viewer);
}

/** Templates (each within the block cap) that bind to every path, and gate on each. */
function bindEverything(paths: readonly string[]): TemplateBlock[][] {
  const blocks: TemplateBlock[] = [];
  for (const path of paths) {
    blocks.push({ kind: "text", text: { $view: path } });
    blocks.push({ kind: "stat", label: "gate", value: { $view: path }, visible_when: path });
  }
  for (const list of ["vars.module", "vars.tree"]) {
    for (const field of ["id", "path", "label", "value", "valueLabel", "description", "kind", "min", "max", "value.0", "options.0"]) {
      blocks.push({ repeat: { each: list, as: "item", block: { kind: "stat", label: { $view: `item.${field}` }, value: { $view: `item.${field}` } } } });
    }
  }
  const templates: TemplateBlock[][] = [];
  for (let at = 0; at < blocks.length; at += MAX_PANEL_BLOCKS) templates.push(blocks.slice(at, at + MAX_PANEL_BLOCKS));
  return templates;
}

function shown(templates: readonly TemplateBlock[][], value: unknown): Block[] {
  return templates.flatMap((blocks) => instantiate({ views: VIEWS, blocks }, new Map([["variables", value]])));
}

/** A view an admin is sent, with the `hidden` flags taken off: what a broken view would leak. */
function unflagged(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value), (key, item) => (isRecord(item) ? Object.fromEntries(Object.entries(item).filter(([name]) => name !== "hidden")) : item));
}

describe("a panel bound to every path of the variables view", () => {
  test("control: bound to an admin's view stripped of its flags, it shows every unexposed variable", async () => {
    const room = seededRoom();
    const value = unflagged(await variablesFor(room, room.viewer(ADMIN)));
    const templates = bindEverything(everyPath(value, "vars", []));
    expect(leaks(shown(templates, value), ADMIN_ALLOWED).sort()).toEqual([...ADMIN_ALLOWED].sort());
  });

  for (const member of [ADA, EVE]) {
    test(`${member.name}: no keeper-only variable, whatever the template reads`, async () => {
      const room = seededRoom();
      // The template is written against the ADMIN's paths — it asks for the secrets by name.
      const templates = bindEverything(everyPath(unflagged(await variablesFor(room, room.viewer(ADMIN))), "vars", []));
      for (const locale of ["en", "zh"]) {
        const blocks = shown(templates, await variablesFor(room, room.viewer(member, locale)));
        expect(blocks.length).toBeGreaterThan(0);
        expect(leaks(blocks, [...TABLE_SECRETS, ...ADMIN_ALLOWED])).toEqual([]);
      }
    });
  }

  test("an admin: the flagged variables stay out of the panel too", async () => {
    const room = seededRoom();
    const value = await variablesFor(room, room.viewer(ADMIN));
    const blocks = shown(bindEverything(everyPath(unflagged(value), "vars", [])), value);
    expect(blocks.length).toBeGreaterThan(0);
    expect(leaks(blocks, ADMIN_ALLOWED)).toEqual([]);
  });
});
