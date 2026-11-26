// The panels file format: every field, every refusal, the caps — and a panel as one viewer's
// `panels` view lists it.
import { describe, expect, test } from "bun:test";

import { instantiate, MAX_PANEL_BLOCKS, MAX_PANEL_VIEWS, MAX_PANELS_PER_PACK } from "loreweaver-protocol/v3";

import { MAX_PANELS_FILE_BYTES, panelEntry, panelListedTo, parsePanels, type PanelSpec } from "../../src/core/panels/index.ts";
import { PANELS_YAML } from "../packs/fixture.ts";

function ok(text: string): readonly PanelSpec[] {
  const parsed = parsePanels(text);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.problems));
  return parsed.panels;
}

function problems(text: string): string[] {
  const parsed = parsePanels(text);
  return parsed.ok ? [] : parsed.problems.map((item) => `${item.code}@${item.path}${item.detail === undefined ? "" : `:${item.detail}`}`);
}

/** One template panel around `blocks` (YAML flow), reading `views`. */
function one(blocks: string, views = "{ t: harbor/tide }", extra = ""): string {
  return `panels:\n  - { id: p, title: P, slot: sidebar, views: ${views}, blocks: ${blocks}${extra} }\n`;
}

describe("a valid file", () => {
  test("the fixture's panels: template, admin template, page with a fallback, admin page without one", () => {
    const [tide, ledger, chart] = ok(PANELS_YAML);
    expect(tide).toMatchObject({ id: "tide", title: { en: "The tide", zh: "潮汐" }, slot: "sidebar", audience: "all", kind: "template", entry: null, fallback: null, images: ["art/chart.png"] });
    expect(tide?.views).toEqual([{ as: "me", view: "me" }, { as: "tide", view: "tally/tide" }]);
    expect([...(tide?.reads ?? [])].sort()).toEqual(["me", "tide"]);
    expect(tide?.blocks[2]).toEqual({ repeat: { each: "me.character.resources", as: "r", block: { kind: "meter", label: { $view: "r.label" }, value: { $view: "r.value" }, min: 0, max: { $view: "r.max" } } } });
    expect(tide?.blocks[3]).toMatchObject({ kind: "choices", visible_when: "tide.level >= 5", options: [{ id: "ring", label: { en: "Ring it" }, command: "tally/ring", args: { times: 2 } }] });
    expect(ledger).toMatchObject({ audience: "admin", slot: "tray" });
    expect((ledger?.blocks[0] as { repeat: { as: string } }).repeat.as).toBe("item");
    expect(chart).toMatchObject({ kind: "page", entry: "ui/chart.html", blocks: [], fallback: [{ kind: "text", text: { $view: "tide.level" } }] });
  });

  test("every block kind, bound and written out", () => {
    const [panel] = ok(`panels:
  - id: all
    title: { zh: 全部 }
    slot: modal
    audience: player
    views: { t: harbor/tide, me: me }
    blocks:
      - { kind: divider }
      - { kind: meter, label: L, value: 1, min: 0, max: 2 }
      - { kind: stat, label: S, value: true }
      - { kind: stat, label: S, value: { en: yes, zh: 是 } }
      - { kind: stat, label: S, value: { $view: me.member.name } }
      - { kind: badge, label: B, tone: warn }
      - { kind: badge, label: B, tone: { $view: t.tone } }
      - { kind: text, text: T, style: warning }
      - { kind: image, src: a/b.png, caption: C, alt: A }
      - { kind: letter, body: B, from: F, to: T, date: D }
      - { kind: clipping, headline: H, body: B, source: S, date: D }
      - { kind: map_pin, src: a/map.png, label: L, x: { $view: t.x }, y: 0.5, note: N }
      - { kind: title_card, title: T, subtitle: S, act: A }
      - { kind: choices, options: [{ id: a, label: A, command: help }, { id: b, label: B, command: rules.sanity_check, args: { success: 1d4 } }] }
`);
    expect(panel?.blocks).toHaveLength(14);
    expect(panel?.images).toEqual(["a/b.png", "a/map.png"]);
    expect(panel?.audience).toBe("player");
  });

  test("a page whose fallback is an explicit null", () => {
    const [panel] = ok("panels:\n  - { id: p, title: P, slot: tray, views: { t: harbor/tide }, entry: ui/p.htm, fallback: null }\n");
    expect(panel).toMatchObject({ kind: "page", fallback: null, entry: "ui/p.htm" });
  });

  test("conditions read declared handles and, inside a repeat, its element", () => {
    expect(problems(one("[{ repeat: { each: t.boats, block: { kind: text, text: { $view: item.name }, visible_when: 'item.crew > 0 && t.level' } }, visible_when: '!t.storm' }]"))).toEqual([]);
  });
});

describe("refusals", () => {
  const cases: [string, string, string[]][] = [
    ["not a mapping", "- a\n", ["not_a_mapping@"]],
    ["unknown top-level key", "panels: []\nextra: 1\n", ["unknown_key@extra", "bad_field@panels"]],
    ["no panels", "other: 1\n", ["unknown_key@other", "missing_field@panels"]],
    ["bad id", "panels:\n  - { id: Bad, title: P, slot: sidebar, blocks: [{ kind: divider }] }\n", ["bad_id@panels.0.id"]],
    ["missing title and slot", "panels:\n  - { id: p, blocks: [{ kind: divider }] }\n", ["missing_field@panels.0.title", "missing_field@panels.0.slot"]],
    ["bad slot and audience", "panels:\n  - { id: p, title: P, slot: floor, audience: keeper, blocks: [{ kind: divider }] }\n", ["bad_field@panels.0.slot", "replaced_2x@panels.0.audience:keeper"]],
    ["title too long", `panels:\n  - { id: p, title: ${"x".repeat(121)}, slot: sidebar, blocks: [{ kind: divider }] }\n`, ["too_long@panels.0.title"]],
    ["unknown title locale", "panels:\n  - { id: p, title: { fr: P }, slot: sidebar, blocks: [{ kind: divider }] }\n", ["unknown_key@panels.0.title.fr", "missing_field@panels.0.title"]],
    ["unknown panel key", "panels:\n  - { id: p, title: P, slot: sidebar, tier: 1, blocks: [{ kind: divider }] }\n", ["unknown_key@panels.0.tier"]],
    ["duplicate id", "panels:\n  - { id: p, title: P, slot: sidebar, blocks: [{ kind: divider }] }\n  - { id: p, title: Q, slot: tray, blocks: [{ kind: divider }] }\n", ["duplicate@panels.1.id:p"]],
    ["no blocks", "panels:\n  - { id: p, title: P, slot: sidebar }\n", ["missing_field@panels.0.blocks"]],
    ["a 2.6 $var binding", one("[{ kind: stat, label: S, value: { $var: day } }]", "{}"), ["replaced_2x@panels.0.blocks.0.value:$var"]],
    ["a 2.6 $leaf binding", one("[{ kind: text, text: { $leaf: label } }]", "{}"), ["replaced_2x@panels.0.blocks.0.text:$leaf"]],
    ["a binding with extra keys", one("[{ kind: text, text: { $view: t.a, x: 1 } }]"), ["bad_binding@panels.0.blocks.0.text"]],
    ["an undeclared handle", one("[{ kind: text, text: { $view: tide.a } }]", "{}"), ["unknown_handle@panels.0.blocks.0.text.$view:tide"]],
    ["a path outside the grammar", one("[{ kind: text, text: { $view: t..a } }]"), ["bad_path_syntax@panels.0.blocks.0.text.$view"]],
    ["a path too deep", one("[{ kind: text, text: { $view: t.a.b.c.d.e.f.g.h } }]"), ["bad_path_syntax@panels.0.blocks.0.text.$view"]],
    ["a path too long", one(`[{ kind: text, text: { $view: t.${"a".repeat(199)} } }]`), ["bad_path_syntax@panels.0.blocks.0.text.$view"]],
    ["an unused view", one("[{ kind: text, text: { $view: t.a } }]", "{ t: harbor/tide, me: me }"), ["unused_view@panels.0.views.me"]],
    ["a bad view name", one("[{ kind: divider }]", "{ x: nothing, y: panels, Z: me }"), ["bad_view_name@panels.0.views.x:nothing", "bad_view_name@panels.0.views.y:panels", "bad_id@panels.0.views.Z"]],
    ["too many views", one("[{ kind: divider }]", `{ ${Array.from({ length: MAX_PANEL_VIEWS + 1 }, (_, i) => `v${i}: me`).join(", ")} }`), ["too_many@panels.0.views"]],
    ["an admin view with audience player", "panels:\n  - { id: p, title: P, slot: sidebar, audience: player, views: { k: admin/keys }, blocks: [{ kind: text, text: { $view: k.n } }] }\n", ["audience_conflict@panels.0.audience"]],
    ["a nested repeat", one("[{ repeat: { each: t.a, block: { repeat: { each: t.b, block: { kind: divider } } } } }]"), ["repeat_nested@panels.0.blocks.0.repeat.block.repeat"]],
    ["a shadowing as", one("[{ repeat: { each: t.a, as: t, block: { kind: divider } } }]"), ["handle_shadowed@panels.0.blocks.0.repeat.as:t"]],
    ["an element read outside its repeat", one("[{ kind: text, text: { $view: item.a } }, { repeat: { each: t.a, block: { kind: divider } }, visible_when: 'item.x' }]"), ["unknown_handle@panels.0.blocks.0.text.$view:item", "unknown_handle@panels.0.blocks.1.visible_when:item"]],
    ["an empty prefix", one("[{ repeat: { each: t.a, prefix: '', block: { kind: divider } } }]"), ["bad_field@panels.0.blocks.0.repeat.prefix"]],
    ["a condition outside the subset", one("[{ kind: text, text: T, visible_when: 't.a + 1 > 2' }]"), ["bad_condition@panels.0.blocks.0.visible_when:OUTSIDE_SUBSET"]],
    ["a condition that does not parse", one("[{ kind: text, text: T, visible_when: 't.a >' }]"), ["bad_condition@panels.0.blocks.0.visible_when:UNEXPECTED_END"]],
    ["an empty condition", one("[{ kind: text, text: T, visible_when: '' }]"), ["bad_condition@panels.0.blocks.0.visible_when:EMPTY"]],
    ["an unknown kind", one("[{ kind: hologram }]"), ["bad_field@panels.0.blocks.0.kind"]],
    ["an unknown block key", one("[{ kind: divider, colour: red }]"), ["unknown_key@panels.0.blocks.0.colour"]],
    ["a meter missing max, min over max", one("[{ kind: meter, label: L, value: 1, min: 3 }, { kind: meter, label: L, value: 1, min: 3, max: 2 }]", "{}"), ["missing_field@panels.0.blocks.0.max", "bad_field@panels.0.blocks.1.max"]],
    ["a bad tone and style", one("[{ kind: badge, label: B, tone: loud }, { kind: text, text: T, style: bold }]", "{}"), ["bad_field@panels.0.blocks.0.tone", "bad_field@panels.0.blocks.1.style"]],
    ["an image path that escapes", one("[{ kind: image, src: ../x.png }]", "{}"), ["bad_path@panels.0.blocks.0.src:dot_segment"]],
    ["a 2.6 choice", one("[{ kind: choices, options: [{ id: a, label: A, input: go north }] }]", "{}"), ["replaced_2x@panels.0.blocks.0.options.0.input:input"]],
    ["a choice with a bad command and args", one("[{ kind: choices, options: [{ id: a, label: A, command: 'Bad Cmd' }, { id: b, label: B, command: x, args: [1] }] }]", "{}"), ["bad_id@panels.0.blocks.0.options.0.command", "bad_field@panels.0.blocks.0.options.1.args"]],
    ["duplicate option ids, too many options", one(`[{ kind: choices, options: [{ id: a, label: A, command: x }, { id: a, label: B, command: x }] }, { kind: choices, options: [${Array.from({ length: 13 }, (_, i) => `{ id: o${i}, label: L, command: x }`).join(", ")}] }]`, "{}"), ["duplicate@panels.0.blocks.0.options.1.id", "too_many@panels.0.blocks.1.options"]],
    ["text over its cap", one(`[{ kind: text, text: ${"x".repeat(2001)} }]`, "{}"), ["too_long@panels.0.blocks.0.text"]],
    ["a page with blocks and assets, no fallback", "panels:\n  - { id: p, title: P, slot: tray, entry: ui/p.html, blocks: [{ kind: divider }], assets: [ui/p.js] }\n", ["replaced_2x@panels.0.assets:assets", "unknown_key@panels.0.blocks:page", "missing_field@panels.0.fallback"]],
    ["a page that is not html", "panels:\n  - { id: p, title: P, slot: tray, entry: ui/p.js, fallback: null }\n", ["bad_path@panels.0.entry:extension"]],
    ["a template with a fallback", "panels:\n  - { id: p, title: P, slot: tray, blocks: [{ kind: divider }], fallback: null }\n", ["unknown_key@panels.0.fallback:template"]],
    ["YAML aliases", "a: &x 1\npanels: *x\n", ["bad_yaml@line 1:alias"]],
  ];
  for (const [label, text, expected] of cases) {
    test(label, () => {
      expect(problems(text)).toEqual(expected);
    });
  }

  test("the caps: blocks per template, panels per file, file size", () => {
    expect(problems(one(`[${Array.from({ length: MAX_PANEL_BLOCKS + 1 }, () => "{ kind: divider }").join(", ")}]`, "{}"))).toEqual(["too_many@panels.0.blocks"]);
    expect(problems(one(`[${Array.from({ length: MAX_PANEL_BLOCKS }, () => "{ kind: divider }").join(", ")}]`, "{}"))).toEqual([]);
    const many = `panels:\n${Array.from({ length: MAX_PANELS_PER_PACK + 1 }, (_, i) => `  - { id: p${i}, title: P, slot: sidebar, blocks: [{ kind: divider }] }`).join("\n")}\n`;
    expect(problems(many)).toEqual(["too_many@panels"]);
    expect(problems(`# ${"x".repeat(MAX_PANELS_FILE_BYTES)}\n${one("[{ kind: divider }]", "{}")}`)).toEqual(["too_large@"]);
  });
});

describe("who is listed a panel", () => {
  test("audience and admin views", () => {
    const all = { audience: "all" as const, views: [{ as: "me", view: "me" }] };
    const admins = { audience: "admin" as const, views: [] };
    const players = { audience: "player" as const, views: [] };
    const adminView = { audience: "all" as const, views: [{ as: "k", view: "admin/keys" }] };
    expect((["player", "observer", "admin"] as const).map((role) => [panelListedTo(all, role), panelListedTo(admins, role), panelListedTo(players, role), panelListedTo(adminView, role)])).toEqual([
      [true, false, true, false],
      [true, false, true, false],
      [true, true, false, true],
    ]);
  });
});

describe("the wire form", () => {
  const image = new Map([["art/chart.png", { sha256: "c".repeat(64), size: 70, mime: "image/png" }]]);
  const page = { sha256: "d".repeat(64), size: 99, mime: "text/html" };

  test("text in the viewer's language, pictures by hash, bindings as authored", () => {
    const [tide, , chart] = ok(PANELS_YAML);
    const zh = panelEntry("harbor", tide as PanelSpec, "zh", image, null);
    expect(zh).toMatchObject({ id: "harbor/tide", title: "潮汐", slot: "sidebar", kind: "template", source: { kind: "pack", id: "harbor" }, views: [{ as: "me", view: "me" }, { as: "tide", view: "tally/tide" }] });
    expect(zh?.blocks?.[0]).toEqual({ kind: "meter", label: "潮位", value: { $view: "tide.level" }, min: 0, max: 10 });
    expect(zh?.blocks?.[1]).toEqual({ kind: "image", hash: "c".repeat(64), mime: "image/png", size: 70, caption: "Harbor chart" });
    expect(zh?.blocks?.[3]).toEqual({ kind: "choices", prompt: "Ring the bell?", options: [{ id: "ring", label: "Ring it", command: "tally/ring", args: { times: 2 } }], visible_when: "tide.level >= 5" });
    expect(panelEntry("harbor", tide as PanelSpec, "en", new Map(), null)).toBeNull();
    const wired = panelEntry("harbor", chart as PanelSpec, "en", image, page);
    expect(wired).toMatchObject({ kind: "page", page: { hash: "d".repeat(64), size: 99, mime: "text/html" }, fallback: [{ kind: "text", text: { $view: "tide.level" } }] });
    expect(wired?.blocks).toBeUndefined();
    expect(panelEntry("harbor", chart as PanelSpec, "en", image, null)).toBeNull();
  });

  test("what the server sends is what every client instantiates", () => {
    const [tide] = ok(PANELS_YAML);
    const entry = panelEntry("harbor", tide as PanelSpec, "en", image, null);
    const values = new Map<string, unknown>([
      ["tally/tide", { level: 6 }],
      ["me", { member: { id: "m", name: "Ada", role: "player", roleLabel: "Player" }, character: { id: "c", name: "Ada", pack: "coc7", status: [], resources: [{ id: "hp", label: "HP", value: 3, max: 9 }], attributes: [], skills: [] } }],
    ]);
    const blocks = instantiate({ views: entry?.views ?? [], blocks: entry?.blocks ?? [] }, values);
    expect(blocks.map((block) => block.kind)).toEqual(["meter", "image", "meter", "choices"]);
    expect(instantiate({ views: entry?.views ?? [], blocks: entry?.blocks ?? [] }, new Map()).map((block) => block.kind)).toEqual(["image"]);
  });
});

test("a missing required field is reported once", () => {
  expect(problems(one("[{ kind: letter, from: F }, { kind: stat, label: S }, { kind: image }]", "{}"))).toEqual(["missing_field@panels.0.blocks.0.body", "missing_field@panels.0.blocks.1.value", "missing_field@panels.0.blocks.2.src"]);
});
