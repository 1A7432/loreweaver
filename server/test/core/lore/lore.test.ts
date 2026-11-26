import { describe, expect, test } from "bun:test";

import { actorViewer, DocumentTypes, KEEPER, playerViewer, type Document, type JsonObject, type Viewer } from "../../../src/core/documents/index.ts";
import {
  applyOverlay,
  bindLore,
  checkCondition,
  dropTimers,
  editLoreEntry,
  EMPTY_OVERLAY,
  listLore,
  LORE_ENTRY_DEFAULTS,
  loreEntryDocument,
  loreEntryDocumentType,
  loreOverlayDocumentType,
  loreTargets,
  loreTimersDocumentType,
  markSetupDone,
  MAX_OVERLAY_ENTRIES,
  MAX_ROOM_LORE_ENTRIES,
  mergeSetupItems,
  newLoreEntry,
  overlayChanges,
  overlayData,
  pendingSetup,
  readLoreEntry,
  readOverlay,
  readOverlayFile,
  readTimerState,
  removeLore,
  restoreLore,
  setLoreEnabled,
  setOverlaySwitch,
  setupLabel,
  staleOverlayTitles,
  switchLore,
  timerStateData,
  unbindLore,
  validateLoreEntry,
  validateOverlay,
  validateTimerState,
  type LoreOverlay,
  type SetupItem,
} from "../../../src/core/lore/index.ts";
import { importLorebook, type ImportedEntry, type LoreEntry, type TimerState } from "../../../src/core/worldbook/index.ts";

const ADMIN: Viewer = { grade: "admin", locale: "en" };
const OBSERVER: Viewer = { grade: "observer", locale: "en" };
const PLAYER = playerViewer("en", "member-1");
const ACTOR = actorViewer("npc-1", "en");
const TABLE: readonly (readonly [string, Viewer])[] = [
  ["player", PLAYER],
  ["observer", OBSERVER],
  ["actor", ACTOR],
  ["admin acting as an actor", { grade: "admin", locale: "en", actorId: "npc-1" }],
];

function doc(type: string, id: string, data: JsonObject, meta: JsonObject = {}): Document {
  return { type, id, version: 1, data, meta, corrupt: false };
}

function entry(fields: Partial<ImportedEntry> & { title: string; content: string }): ImportedEntry {
  return { ...LORE_ENTRY_DEFAULTS, source: "", ...fields };
}

function stored(id: string, value: ImportedEntry): Document {
  const parts = loreEntryDocument(value);
  return doc(loreEntryDocumentType.name, id, parts.data, parts.meta);
}

function asLore(id: string, value: ImportedEntry): LoreEntry {
  const read = readLoreEntry(stored(id, value));
  if (read === null) throw new Error("test entry is not valid");
  return read;
}

const seen = (view: unknown): string => JSON.stringify(view) ?? "undefined";

describe("lore entries: the stored form", () => {
  test("every entry an import produces is a valid payload, and reads back with its id and provenance", () => {
    const book = {
      entries: [
        { comment: "Harbour", content: "Salt and tar.", key: ["harbour"], order: 7, secret: false },
        { comment: "The cult", content: "They meet below.", key: ["cult"], secret: true, constant: true, extensions: { group: "g", depth: 2 } },
        { comment: "", content: "@@if mvu.act >= 2\nAct two text", key: [] },
        { comment: "__proto__", content: "odd title", key: ["x"] },
      ],
    };
    const result = importLorebook(book, { trust: "keeper", source: "pack:harbour" });
    if (!result.ok) throw new Error("import failed");
    expect(result.entries.length).toBe(4);
    result.entries.forEach((imported, index) => {
      const document = stored(`e${index}`, imported);
      expect(validateLoreEntry(document.data)).toEqual([]);
      expect(document.data.source).toBeUndefined();
      expect(document.meta).toEqual({ source: "pack:harbour" });
      const read = readLoreEntry(document);
      expect(read).toEqual({ ...imported, id: `e${index}` });
    });
  });

  test("validation refuses wrong types, out-of-range numbers, unknown fields and over-long text", () => {
    const good = loreEntryDocument(entry({ title: "T", content: "C" })).data;
    expect(validateLoreEntry(good)).toEqual([]);
    const codes = (patch: JsonObject): string[] => validateLoreEntry({ ...good, ...patch }).map((v) => `${v.code}:${v.path}`);
    expect(codes({ probability: 101 })).toEqual(["bad_field:probability"]);
    expect(codes({ priority: 1.5 })).toEqual(["bad_field:priority"]);
    expect(codes({ placement: "sideways" })).toEqual(["bad_field:placement"]);
    expect(codes({ enabled: "yes" })).toEqual(["bad_field:enabled"]);
    expect(codes({ title: "" })).toEqual(["empty:title"]);
    expect(codes({ title: "字".repeat(201) })).toEqual(["too_long:title"]);
    expect(codes({ title: "字".repeat(200) })).toEqual([]);
    expect(codes({ keys: ["ok", " "] })).toEqual(["bad_field:keys.1"]);
    expect(codes({ keys: Array.from({ length: 65 }, (_, i) => `k${i}`) })).toEqual(["too_many:keys"]);
    expect(codes({ source: "smuggled" })).toEqual(["unknown_field:source"]);
    expect(codes({ content: "x".repeat(16_001) })).toEqual(["too_long:content"]);
  });

  test("an unreadable payload has no view for anyone", () => {
    const parts = loreEntryDocument(entry({ title: "T", content: "C" }));
    const broken = doc(loreEntryDocumentType.name, "e1", { ...parts.data, probability: "lots" }, parts.meta);
    expect(loreEntryDocumentType.project(broken, KEEPER)).toBeNull();
    expect(loreEntryDocumentType.project({ ...broken, data: parts.data, corrupt: true }, KEEPER)).toBeNull();
  });
});

describe("lore entries: who sees what (iron rule 3)", () => {
  const MARK = "LEAKMARK";
  const secret = stored(
    "s1",
    entry({
      title: "Cellar door",
      content: `${MARK} the mayor is the cultist`,
      keys: [`${MARK}-key`],
      secondaryKeys: [`${MARK}-second`],
      condition: `mvu.${MARK} == 1`,
      group: `${MARK}-group`,
      category: `${MARK}-category`,
      secret: true,
      source: "pack:harbour",
    }),
  );
  const open = stored(
    "o1",
    entry({
      title: "Harbour",
      content: "Salt and tar.",
      keys: [`${MARK}-key`],
      secondaryKeys: [`${MARK}-second`],
      condition: `mvu.${MARK} == 1`,
      group: `${MARK}-group`,
      category: `${MARK}-category`,
      source: `${MARK}-source`,
    }),
  );

  test("a secret entry does not exist for the table — not even its id", () => {
    for (const [, viewer] of TABLE) expect(loreEntryDocumentType.project(secret, viewer)).toBeNull();
  });

  test("the admin sees a secret entry's title and switches, never its text, keys or condition", () => {
    const view = loreEntryDocumentType.project(secret, ADMIN);
    expect(view).toEqual({ view: "secret_title", id: "s1", title: "Cellar door", secret: true, enabled: true, constant: false, source: "pack:harbour" });
    expect(seen(view)).not.toContain(MARK);
  });

  test("the Keeper sees every field of every entry", () => {
    expect(seen(loreEntryDocumentType.project(secret, KEEPER)).split(MARK).length - 1).toBe(6);
    expect(seen(loreEntryDocumentType.project(open, KEEPER)).split(MARK).length - 1).toBe(6);
  });

  test("the table sees a non-secret entry's title and content, nothing else", () => {
    for (const [, viewer] of TABLE) {
      const view = loreEntryDocumentType.project(open, viewer);
      expect(view).toEqual({ view: "table", id: "o1", title: "Harbour", content: "Salt and tar." });
      expect(seen(view)).not.toContain(MARK);
    }
  });

  test("the admin curates a non-secret entry in full", () => {
    const view = loreEntryDocumentType.project(open, ADMIN);
    expect(seen(view)).toContain(`${MARK}-key`);
    expect(seen(view)).toContain(`${MARK}-source`);
  });

  test("a field added to the payload later is never copied into any view", () => {
    const smuggled = doc(open.type, open.id, { ...open.data, keeperNotes: MARK }, open.meta);
    for (const viewer of [KEEPER, ADMIN, PLAYER, OBSERVER, ACTOR]) expect(seen(loreEntryDocumentType.project(smuggled, viewer))).not.toContain(MARK);
  });
});

describe("lore entries: the admin's editing commands", () => {
  test("a new entry is trimmed, defaulted, room-owned (no source) and refused when blank or the room is full", () => {
    const made = newLoreEntry({ title: "  Bell tower ", content: "It rings at dusk.", keys: ["bell"] }, 0);
    expect(made.ok && made.data).toEqual({ ...LORE_ENTRY_DEFAULTS, title: "Bell tower", content: "It rings at dusk.", keys: ["bell"], source: "" });
    expect(newLoreEntry({ title: " ", content: "x" }, 0)).toEqual({ ok: false, code: "empty", path: "title" });
    expect(newLoreEntry({ title: "x", content: " \n" }, 0)).toEqual({ ok: false, code: "empty", path: "content" });
    expect(newLoreEntry({ title: "x", content: "y" }, MAX_ROOM_LORE_ENTRIES)).toEqual({ ok: false, code: "limit_reached", path: "" });
    expect(newLoreEntry({ title: "x", content: "y", probability: 500 }, 0)).toEqual({ ok: false, code: "bad_field", path: "probability" });
  });

  test("an edit returns new data, keeps provenance and identity, and refuses an invalid result", () => {
    const original = asLore("e1", entry({ title: "Harbour", content: "Salt.", source: "pack:harbour" }));
    const edited = editLoreEntry(original, { content: "Salt and tar.", secret: true, ...({ source: "forged", id: "e9" } as object) });
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    expect(edited.data).toMatchObject({ id: "e1", source: "pack:harbour", content: "Salt and tar.", secret: true });
    expect(original.content).toBe("Salt.");
    expect(editLoreEntry(original, { title: "  " })).toEqual({ ok: false, code: "empty", path: "title" });
    expect(editLoreEntry(original, { sticky: 1000 })).toEqual({ ok: false, code: "bad_field", path: "sticky" });
  });

  test("enable/disable on the stored entry returns the same object when nothing changes", () => {
    const original = asLore("e1", entry({ title: "T", content: "C" }));
    expect(setLoreEnabled(original, true)).toBe(original);
    expect(setLoreEnabled(original, false)).toEqual({ ...original, enabled: false });
    expect(original.enabled).toBe(true);
  });

  test("a command addresses an id exactly, else every entry with exactly that title", () => {
    const entries = [
      asLore("e1", entry({ title: "Twin", content: "a" })),
      asLore("e2", entry({ title: "Twin", content: "b" })),
      asLore("e3", entry({ title: "e1", content: "an entry titled like an id" })),
      asLore("e4", entry({ title: "Twin room", content: "not a prefix match" })),
    ];
    expect(loreTargets(entries, "Twin")).toEqual({ ok: true, data: ["e1", "e2"] });
    expect(loreTargets(entries, "e1")).toEqual({ ok: true, data: ["e1"] });
    expect(loreTargets(entries, "Tw")).toEqual({ ok: false, code: "not_found", path: "" });
    const removed = removeLore(entries, "Twin");
    expect(removed.ok && removed.data.removed).toEqual(["e1", "e2"]);
    expect(removed.ok && removed.data.kept.map((item) => item.id)).toEqual(["e3", "e4"]);
    expect(entries.length).toBe(4);
  });

  test("a listing is per viewer: the table never learns of secrets or of the overlay", () => {
    const entries = [
      asLore("e1", entry({ title: "Harbour", content: "Salt." })),
      asLore("e2", entry({ title: "Cellar", content: "LEAKMARK", secret: true })),
      asLore("e3", entry({ title: "Reply template", content: "residue", enabled: false })),
    ];
    const overlay = switchLore(EMPTY_OVERLAY, "Harbour", false);
    if (!overlay.ok) throw new Error("overlay refused");
    const forPlayer = listLore(entries, PLAYER, { overlay: overlay.data, disabledOnly: true });
    expect(forPlayer.map((item) => item.entry.id)).toEqual(["e1", "e3"]);
    expect(seen(forPlayer)).not.toContain("LEAKMARK");
    expect(seen(forPlayer)).not.toContain("effectiveEnabled");
    expect(seen(forPlayer)).not.toContain("overlaid");

    const forAdmin = listLore(entries, ADMIN, { overlay: overlay.data });
    expect(forAdmin.map((item) => [item.entry.id, item.effectiveEnabled, item.overlaid])).toEqual([
      ["e1", false, true],
      ["e2", true, false],
      ["e3", false, false],
    ]);
    expect(seen(forAdmin)).not.toContain("LEAKMARK");
    expect(listLore(entries, KEEPER, { overlay: overlay.data, disabledOnly: true }).map((item) => item.entry.id)).toEqual(["e1", "e3"]);
  });
});

describe("the lore overlay", () => {
  function ok<T>(change: { ok: true; data: T } | { ok: false; code: string }): T {
    if (!change.ok) throw new Error(`refused: ${change.code}`);
    return change.data;
  }

  test("switches are keyed by exact title; hostile titles stay ordinary keys in written order", () => {
    let overlay: LoreOverlay = EMPTY_OVERLAY;
    for (const title of ["10", "__proto__", "constructor", "2"]) overlay = ok(switchLore(overlay, title, true));
    expect([...overlay.entries.keys()]).toEqual(["10", "__proto__", "constructor", "2"]);
    const data = overlayData(overlay);
    expect(validateOverlay(data)).toEqual([]);
    const back = readOverlay(JSON.parse(JSON.stringify(data)) as JsonObject);
    expect([...back.entries.keys()]).toEqual(["10", "__proto__", "constructor", "2"]);
    expect(({} as Record<string, unknown>).enabled).toBeUndefined();
  });

  test("bind implies enable; unbind keeps the switch; a switch saying nothing is removed", () => {
    let overlay = ok(bindLore(EMPTY_OVERLAY, "Act two", 'mvu.act >= 2 && getvar("route") == "north"'));
    expect(overlay.entries.get("Act two")).toEqual({ enabled: true, condition: 'mvu.act >= 2 && getvar("route") == "north"' });
    overlay = ok(unbindLore(overlay, "Act two"));
    expect(overlay.entries.get("Act two")).toEqual({ enabled: true, condition: "" });
    overlay = ok(setOverlaySwitch(overlay, "Act two", { enabled: null }));
    expect(overlay.entries.size).toBe(0);
    expect(bindLore(EMPTY_OVERLAY, "Act two", " ")).toEqual({ ok: false, code: "empty", path: "condition" });
  });

  test("a condition outside the closed grammar is refused — nothing reaches the JavaScript fallback", () => {
    expect(checkCondition("alert(document.cookie)").ok).toBe(false);
    expect(checkCondition("a = 1").ok).toBe(false);
    expect(checkCondition("x".repeat(501)).ok).toBe(false);
    expect(bindLore(EMPTY_OVERLAY, "T", "fetch('x')")).toEqual({ ok: false, code: "bad_condition", path: "condition" });
    expect(checkCondition('  配置.难度 == "残酷"  ')).toEqual({ ok: true, data: '配置.难度 == "残酷"' });
  });

  test("the overlay is bounded and refuses rather than truncates", () => {
    let overlay: LoreOverlay = EMPTY_OVERLAY;
    for (let index = 0; index < MAX_OVERLAY_ENTRIES; index++) overlay = ok(switchLore(overlay, `t${index}`, true));
    expect(switchLore(overlay, "one more", true)).toEqual({ ok: false, code: "limit_reached", path: "entries" });
    expect(switchLore(overlay, "t0", false).ok).toBe(true);
    expect(switchLore(EMPTY_OVERLAY, "字".repeat(201), true)).toEqual({ ok: false, code: "too_long", path: "title" });
  });

  test("applyOverlay changes only enabled and condition, never secret or content, and is identity when silent", () => {
    const secret = asLore("e1", entry({ title: "Cellar", content: "C", secret: true, enabled: false, condition: "a == 1" }));
    const untouched = asLore("e2", entry({ title: "Other", content: "D" }));
    const overlay = ok(bindLore(EMPTY_OVERLAY, "Cellar", "b == 2"));
    const effective = applyOverlay(secret, overlay);
    expect(effective).toEqual({ ...secret, enabled: true, condition: "b == 2" });
    expect(effective.secret).toBe(true);
    expect(applyOverlay(untouched, overlay)).toBe(untouched);
    expect(overlayChanges(secret, overlay)).toBe(true);
    expect(overlayChanges(untouched, overlay)).toBe(false);
    const agreeing = ok(switchLore(EMPTY_OVERLAY, "Other", true));
    expect(applyOverlay(untouched, agreeing)).toBe(untouched);
  });

  test("restore drops one title or all, keeps setup; stale titles are reported", () => {
    const item: SetupItem = { path: "config.difficulty", options: ["easy", "hard"], labels: [{ locale: "en", text: "Difficulty" }], done: false };
    let overlay = ok(mergeSetupItems(ok(switchLore(ok(switchLore(EMPTY_OVERLAY, "A", true)), "B", false)), [item]));
    expect(staleOverlayTitles(overlay, ["A"])).toEqual(["B"]);
    const one = restoreLore(overlay, "B");
    expect(one.removed).toBe(1);
    expect(restoreLore(one.overlay, "B")).toEqual({ overlay: one.overlay, removed: 0 });
    const all = restoreLore(overlay, "*");
    expect(all.removed).toBe(2);
    expect(all.overlay.setup).toEqual([item]);
    overlay = all.overlay;
    expect(overlay.entries.size).toBe(0);
  });

  test("setup items stay pending until written, and a re-import keeps the choice made", () => {
    const item: SetupItem = { path: "config.difficulty", options: ["easy", "hard"], labels: [{ locale: "zh", text: "难度" }, { locale: "en", text: "Difficulty" }], done: false };
    let overlay = ok(mergeSetupItems(EMPTY_OVERLAY, [item]));
    expect(pendingSetup(overlay).map((pending) => pending.path)).toEqual(["config.difficulty"]);
    const marked = markSetupDone(overlay, "config.difficulty");
    expect(marked.changed).toBe(true);
    expect(markSetupDone(marked.overlay, "config.difficulty").changed).toBe(false);
    overlay = ok(mergeSetupItems(marked.overlay, [{ ...item, options: ["easy", "normal", "hard"] }]));
    expect(overlay.setup).toEqual([{ ...item, options: ["easy", "normal", "hard"], done: true }]);
    expect(setupLabel(item, "zh-CN")).toBe("难度");
    expect(setupLabel(item, "fr")).toBe("Difficulty");
    expect(setupLabel({ ...item, labels: [] }, "en")).toBe("config.difficulty");
  });

  test("a stored condition is re-checked on read: one the closed grammar refuses is dropped, the switch kept", () => {
    const read = readOverlay({
      entries: [
        { title: "A", enabled: true, condition: "require('fs')" },
        { title: "B", condition: "process.exit()" },
        { title: "C", enabled: false, condition: "x == 1" },
        { title: "A", enabled: false, condition: "" },
        "garbage",
      ],
      setup: [{ path: "p", options: [], labels: [], done: "yes" }],
    });
    expect([...read.entries]).toEqual([
      ["A", { enabled: true, condition: "" }],
      ["C", { enabled: false, condition: "x == 1" }],
    ]);
    expect(read.setup).toEqual([]);
    expect(validateOverlay({ entries: [{ title: "A", enabled: true, condition: "require('fs')" }], setup: [] }).map((v) => v.code)).toEqual(["bad_condition"]);
    expect(validateOverlay({ entries: [], setup: [], extra: 1 }).map((v) => v.code)).toEqual(["unknown_field"]);
  });

  test("only the Keeper and the admin see the overlay", () => {
    const MARK = "LEAKMARK";
    const overlay = ok(mergeSetupItems(ok(bindLore(EMPTY_OVERLAY, `${MARK} ending`, `mvu.${MARK} == 1`)), [
      { path: `${MARK}.path`, options: [MARK], labels: [{ locale: "en", text: MARK }], done: false },
    ]));
    const document = doc(loreOverlayDocumentType.name, "overlay", overlayData(overlay));
    for (const [, viewer] of TABLE) expect(loreOverlayDocumentType.project(document, viewer)).toBeNull();
    for (const viewer of [KEEPER, ADMIN]) {
      const view = loreOverlayDocumentType.project(document, viewer);
      expect(view?.entries).toEqual([{ title: `${MARK} ending`, enabled: true, condition: `mvu.${MARK} == 1` }]);
      expect(view?.setup).toEqual([{ path: `${MARK}.path`, label: MARK, options: [MARK], done: false }]);
    }
  });

  test("a pack overlay file: closed, a condition implies the switch, and `*` is never exposed by a pack", () => {
    const file = readOverlayFile({
      format: "loreweaver.lore-overlay/1",
      entries: { "Difficulty: hard": { condition: 'config.difficulty == "hard"' }, "Reply template": { enabled: false } },
      setup: [{ path: " config.difficulty ", options: ["easy", 2, true], labels: { "en-US": "Difficulty", zh: "难度" } }],
      expose: ["config", "config", "party"],
    });
    expect(file.ok).toBe(true);
    if (!file.ok) return;
    expect([...file.data.overlay.entries]).toEqual([
      ["Difficulty: hard", { enabled: true, condition: 'config.difficulty == "hard"' }],
      ["Reply template", { enabled: false, condition: "" }],
    ]);
    expect(file.data.overlay.setup).toEqual([
      { path: "config.difficulty", options: ["easy", "2", "true"], labels: [{ locale: "en", text: "Difficulty" }, { locale: "zh", text: "难度" }], done: false },
    ]);
    expect(file.data.expose).toEqual(["config", "party"]);

    const base = { format: "loreweaver.lore-overlay/1" };
    expect(readOverlayFile({ ...base, expose: ["*"] })).toEqual({ ok: false, code: "expose_everything", path: "expose.0" });
    expect(readOverlayFile({ ...base, expose: "*.secrets" })).toEqual({ ok: false, code: "expose_everything", path: "expose.0" });
    expect(readOverlayFile({ format: "loreweaver.lore-overlay/2" })).toEqual({ ok: false, code: "bad_format", path: "format" });
    expect(readOverlayFile({ ...base, extra: 1 })).toEqual({ ok: false, code: "unknown_field", path: "extra" });
    expect(readOverlayFile({ ...base, entries: { T: { enabled: true, secret: false } } })).toEqual({ ok: false, code: "unknown_field", path: "entries.0.secret" });
    expect(readOverlayFile({ ...base, entries: { T: { condition: "eval('x')" } } })).toEqual({ ok: false, code: "bad_condition", path: "entries.0.condition" });
    expect(readOverlayFile({ ...base, setup: [{ path: "p", done: true }] })).toEqual({ ok: false, code: "unknown_field", path: "setup.0.done" });
    expect(readOverlayFile({ ...base, setup: [{ path: "p" }, { path: "p" }] })).toEqual({ ok: false, code: "duplicate", path: "setup.1.path" });
    expect(readOverlayFile({ ...base, setup: [{ path: "p", labels: { en: "x".repeat(51) } }] }).ok).toBe(false);
    expect(readOverlayFile({ ...base, expose: Array.from({ length: 33 }, (_, i) => `p${i}`) })).toEqual({ ok: false, code: "too_many", path: "expose" });
  });
});

describe("lore timers", () => {
  const state: TimerState = { turn: 12, entries: [{ id: "e1", openedAt: 10, stickyUntil: 13 }, { id: "e2", openedAt: 8, cooldownUntil: 15 }] };

  test("round trip, validation and pruning", () => {
    const data = timerStateData(state);
    expect(validateTimerState(data)).toEqual([]);
    expect(readTimerState(data)).toEqual(state);
    expect(validateTimerState({ turn: -1, entries: [] }).map((v) => v.code)).toEqual(["bad_field"]);
    expect(validateTimerState({ turn: 1, entries: [{ id: "a", openedAt: 1 }, { id: "a", openedAt: 1 }] }).map((v) => v.code)).toEqual(["duplicate"]);
    expect(readTimerState({ turn: "x", entries: [] })).toEqual({ turn: 0, entries: [] });
    expect(dropTimers(state, ["e1"])).toEqual({ turn: 12, entries: [{ id: "e2", openedAt: 8, cooldownUntil: 15 }] });
    expect(dropTimers(state, ["zz"])).toBe(state);
  });

  test("only the Keeper sees timers: they trace secret entries' activity", () => {
    const document = doc(loreTimersDocumentType.name, "timers", timerStateData({ turn: 3, entries: [{ id: "LEAKMARK", openedAt: 2 }] }));
    for (const viewer of [ADMIN, PLAYER, OBSERVER, ACTOR]) expect(loreTimersDocumentType.project(document, viewer)).toBeNull();
    expect(seen(loreTimersDocumentType.project(document, KEEPER))).toContain("LEAKMARK");
  });
});

test("lifecycles: the imported world goes with a full reset, timers with the story", () => {
  expect(loreEntryDocumentType.lifecycle).toEqual({ reset: "all" });
  expect(loreOverlayDocumentType.lifecycle).toEqual({ reset: "all" });
  expect(loreTimersDocumentType.lifecycle).toEqual({ reset: "story" });
  const types = new DocumentTypes().register(loreEntryDocumentType).register(loreOverlayDocumentType).register(loreTimersDocumentType);
  expect(types.names()).toEqual(["lore_entry", "lore_overlay", "lore_timers"]);
});
