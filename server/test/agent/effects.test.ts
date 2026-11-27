import { describe, expect, test } from "bun:test";

import {
  applyModuleEffects,
  checkBlock,
  commitVariableWrites,
  CONTENT_WRITES,
  decideNarrateNow,
  type EffectOptions,
  MAX_PENDING_FACTS,
  markNarrateNow,
  NARRATE_NOW,
  NARRATE_NOW_SETTING,
  narrateNowEnabled,
  readContentWrites,
  readPendingFacts,
  readTurnInjections,
  takePendingFacts,
  type TextReview,
} from "../../src/agent/effects.ts";
import type { Applied, FactRequest } from "../../src/agent/modules.ts";
import { renderPendingFacts } from "../../src/agent/turn/reader.ts";
import {
  MODULE_VARIABLES_ID,
  MODULE_VARIABLES_TYPE,
  normalizeModuleVariables,
  readVariableTree,
  toJson,
  VARIABLE_TREE_ID,
  VARIABLE_TREE_TYPE,
} from "../../src/core/variables/index.ts";
import { contextFor, putModuleVariable, putTree, ROOM, setup } from "./room_fixture.ts";

const pass: TextReview = (text) => ({ text, allowed: true });
const options = (overrides: Partial<EffectOptions> = {}): EffectOptions => ({ review: pass, action: "line-1", work: "action", members: [], ...overrides });

const NONE: Applied = { facts: [], writes: [], blocks: [], rolls: [], seats: [], logs: [] };

function fact(overrides: Partial<FactRequest> = {}): FactRequest {
  return { module: "clock", text: "The bell tolls.", data: null, to: "table", importance: "normal", narrateNow: false, ...overrides };
}

function room() {
  const { store, services } = setup();
  const writer = store.beginTurn(ROOM);
  putTree(services, writer, { hp: 10, stats: { str: [5, "strength"] } });
  putModuleVariable(services, writer, "alarm", 5);
  return { store, services, writer, context: contextFor(services, writer) };
}

function tree(services: ReturnType<typeof setup>["services"]) {
  const document = services.documents.get(ROOM, VARIABLE_TREE_TYPE, VARIABLE_TREE_ID);
  return toJson(readVariableTree(document?.data ?? {}).tree);
}

describe("variable writes", () => {
  test("a write applies to the tree, a declared module variable takes the typed path, a refusal is data", () => {
    const { services, context } = room();
    const result = applyModuleEffects(
      context,
      {
        ...NONE,
        writes: [
          { module: "clock", path: "hp", value: 7 },
          { module: "clock", path: "stat_data.stats.str", value: 9 },
          { module: "clock", path: "alarm", value: 99 },
          { module: "clock", path: "missing.leaf", value: 1 },
          { module: "clock", path: "alarm", value: "loud" },
        ],
      },
      options(),
    );
    expect(result.writes.applied.map((write) => [write.path, write.target, write.value])).toEqual([
      ["hp", "tree", 7],
      ["stats.str", "tree", 9],
      ["alarm", "module_variable", 5],
    ]);
    expect(result.writes.refused).toEqual([
      { path: "missing.leaf", by: "clock", code: "unknown_path" },
      { path: "alarm", by: "clock", code: "not_a_number" },
    ]);
    expect(result.problems.filter((problem) => problem.code === "write_refused")).toHaveLength(2);
    // The described leaf keeps its description.
    expect(tree(services)).toEqual({ hp: 7, stats: { str: [9, "strength"] } });
    const variables = normalizeModuleVariables(services.documents.get(ROOM, MODULE_VARIABLES_TYPE, MODULE_VARIABLES_ID)?.data);
    expect(variables.variables[0]?.value).toBe(5);
  });

  test("the turn's content-written set accumulates over exchanges and starts over in a new turn", () => {
    const { store, services, context } = room();
    applyModuleEffects(context, { ...NONE, writes: [{ module: "clock", path: "hp", value: 1 }] }, options());
    commitVariableWrites(context, [{ path: "hp", value: 2, by: "template" }, { path: "nope", value: 1, by: "template" }]);
    applyModuleEffects(context, { ...NONE, writes: [{ module: "clock", path: "hp", value: 3 }] }, options());
    expect(readContentWrites(store, ROOM, context.turn)).toEqual([
      { path: "hp", by: "clock" },
      { path: "hp", by: "template" },
    ]);
    const next = contextFor(services, store.beginTurn(ROOM));
    applyModuleEffects(next, { ...NONE, writes: [{ module: "weather", path: "hp", value: 4 }] }, options());
    expect(store.stateGet(ROOM, CONTENT_WRITES)).toEqual({ turn: next.turn, writes: [{ path: "hp", by: "weather" }] });
    expect(readContentWrites(store, ROOM, context.turn)).toEqual([]);
  });

  test("a corrupt tree is never written over", () => {
    const { store, services } = setup();
    const writer = store.beginTurn(ROOM);
    writer.docPut(VARIABLE_TREE_TYPE, VARIABLE_TREE_ID, 1, "{not json", "{}");
    const commit = commitVariableWrites(contextFor(services, writer), [{ path: "hp", value: 1, by: "clock" }]);
    expect(commit).toEqual({ applied: [], refused: [{ path: "hp", by: "clock", code: "corrupt_document" }] });
    expect(store.docGet(ROOM, VARIABLE_TREE_TYPE, VARIABLE_TREE_ID)?.data).toBe("{not json");
  });
});

describe("facts", () => {
  test("a table fact's text becomes a reviewed system narrative; keeper facts and data go to the pending list", () => {
    const { store, context } = room();
    const review: TextReview = (text) => ({ text: text.replace("bell", "[x]"), allowed: true });
    const result = applyModuleEffects(
      context,
      {
        ...NONE,
        facts: [
          fact(),
          fact({ text: "The vault code is 0451.", to: "keeper", importance: "high" }),
          fact({ text: "Hidden roll noted.", data: { roll: 17 } }),
          fact({ text: null, data: { quiet: true } }),
        ],
      },
      options({ review }),
    );
    expect(result.events).toEqual([
      { kind: "narrative", id: null, data: { speaker: "system", name: "clock", text: "The [x] tolls.", format: "plain" } },
      { kind: "narrative", id: null, data: { speaker: "system", name: "clock", text: "Hidden roll noted.", format: "plain" } },
    ]);
    expect(result.pendingAdded).toBe(3);
    expect(readPendingFacts(store, ROOM)).toEqual([
      { module: "clock", turn: 1, to: "keeper", importance: "high", text: "The vault code is 0451.", data: null },
      { module: "clock", turn: 1, to: "table", importance: "normal", text: null, data: { roll: 17 } },
      { module: "clock", turn: 1, to: "table", importance: "normal", text: null, data: { quiet: true } },
    ]);
    expect(takePendingFacts(context)).toHaveLength(3);
    expect(readPendingFacts(store, ROOM)).toEqual([]);
  });

  test("a blocked fact is not published; a full pending list refuses, it does not drop silently", () => {
    const { store, context } = room();
    const blocked = applyModuleEffects(context, { ...NONE, facts: [fact()] }, options({ review: (text) => ({ text, allowed: false }) }));
    expect(blocked.events).toEqual([]);
    expect(blocked.problems).toEqual([{ code: "review_blocked", module: "clock", detail: "fact" }]);
    const many = Array.from({ length: MAX_PENDING_FACTS + 2 }, () => fact({ to: "keeper" }));
    const result = applyModuleEffects(context, { ...NONE, facts: many }, options());
    expect(result.pendingAdded).toBe(MAX_PENDING_FACTS);
    expect(result.problems.filter((problem) => problem.code === "pending_full")).toHaveLength(2);
    expect(readPendingFacts(store, ROOM)).toHaveLength(MAX_PENDING_FACTS);
  });

  test("a full pending list: a new fact displaces the oldest of a strictly lower importance, else it is dropped", () => {
    const { store, context } = room();
    const filler = Array.from({ length: MAX_PENDING_FACTS - 2 }, (_, i) => fact({ to: "keeper", text: `normal ${i}` }));
    applyModuleEffects(context, { ...NONE, facts: [fact({ to: "keeper", text: "old normal" }), fact({ to: "keeper", text: "old low", importance: "low" }), ...filler] }, options());
    expect(readPendingFacts(store, ROOM)).toHaveLength(MAX_PENDING_FACTS);
    // A high fact takes the oldest place of anything lower: "old normal" (older than "old low").
    const high = applyModuleEffects(context, { ...NONE, facts: [fact({ to: "keeper", text: "urgent", importance: "high" })] }, options());
    expect(high.pendingAdded).toBe(1);
    expect(high.problems).toEqual([{ code: "pending_displaced", module: "clock", detail: "clock normal" }]);
    let texts = readPendingFacts(store, ROOM).map((pending) => pending.text);
    expect(texts).not.toContain("old normal");
    expect(texts.at(-1)).toBe("urgent");
    // A normal fact can only displace a low one.
    const normal = applyModuleEffects(context, { ...NONE, facts: [fact({ to: "keeper", text: "news" })] }, options());
    expect(normal.problems).toEqual([{ code: "pending_displaced", module: "clock", detail: "clock low" }]);
    texts = readPendingFacts(store, ROOM).map((pending) => pending.text);
    expect(texts).not.toContain("old low");
    // Nothing lower left for a normal or a low fact: dropped as before.
    const dropped = applyModuleEffects(context, { ...NONE, facts: [fact({ to: "keeper", text: "more" }), fact({ to: "keeper", text: "less", importance: "low" })] }, options());
    expect(dropped.pendingAdded).toBe(0);
    expect(dropped.problems.map((problem) => problem.code)).toEqual(["pending_full", "pending_full"]);
    expect(readPendingFacts(store, ROOM)).toHaveLength(MAX_PENDING_FACTS);
  });

  test("pending facts reach the prompt high first, then normal, then low, in arrival order within a level", () => {
    const at = (text: string, importance: "low" | "normal" | "high") => ({ module: "m", turn: 1, to: "keeper" as const, importance, text, data: null });
    expect(renderPendingFacts([at("a", "low"), at("b", "normal"), at("c", "high"), at("d", "normal"), at("e", "high"), at("f", "low")])).toEqual([
      "- [m] c",
      "- [m] e",
      "- [m] b",
      "- [m] d",
      "- [m] a",
      "- [m] f",
    ]);
  });
});

describe("blocks, dice and injections", () => {
  test("valid blocks are rebuilt from their named fields; unknown and malformed ones are dropped and reported", () => {
    const { context } = room();
    const hash = "a".repeat(64);
    const result = applyModuleEffects(
      context,
      {
        ...NONE,
        blocks: [
          {
            module: "hud",
            id: "status",
            blocks: [
              { kind: "meter", label: "Sanity", value: 40, min: 0, max: 99, extra: "not copied" },
              { kind: "choices", options: [{ id: "a", label: "Run", command: "hud/run", args: { fast: true } }] },
              { kind: "image", hash },
              { kind: "hologram", text: "?" },
              { kind: "meter", label: "Broken" },
              { kind: "image", hash: "../etc/passwd" },
            ],
          },
          { module: "hud", id: null, blocks: [{ kind: "divider" }] },
        ],
      },
      options(),
    );
    expect(result.events).toEqual([
      {
        kind: "blocks",
        id: "blocks:hud:status",
        data: {
          blocks: [
            { kind: "meter", label: "Sanity", value: 40, min: 0, max: 99 },
            { kind: "choices", options: [{ id: "a", label: "Run", command: "hud/run", args: { fast: true } }] },
            { kind: "image", hash },
          ],
          replace: true,
        },
      },
      { kind: "blocks", id: null, data: { blocks: [{ kind: "divider" }] } },
    ]);
    expect(result.problems).toEqual([
      { code: "block_unknown_kind", module: "hud", detail: "hologram" },
      { code: "block_malformed", module: "hud", detail: "meter.value" },
      { code: "block_malformed", module: "hud", detail: "image.hash" },
    ]);
  });

  test("a block's free text passes the review", () => {
    const masked = checkBlock({ kind: "letter", body: "a bad word", from: "bad" }, (text) => ({ text: text.replaceAll("bad", "***"), allowed: true }));
    expect(masked).toEqual({ ok: true, block: { kind: "letter", body: "a *** word", from: "***" } });
    const blocked = checkBlock({ kind: "choices", options: [{ id: "a", label: "worse", command: "x" }] }, (text) => ({ text, allowed: text !== "worse" }));
    expect(blocked).toEqual({ ok: false, code: "review_blocked", detail: "choices" });
  });

  test("rolls become dice events, first; injections are recorded by turn", () => {
    const { store, services, context } = room();
    const result = applyModuleEffects(
      context,
      { ...NONE, facts: [fact()], rolls: [{ module: "dice", notation: "1d20", label: "Luck", total: 14, text: "1d20 [14] = 14" }], injections: ["Mind the clock."] },
      options(),
    );
    expect(result.events.map((event) => event.kind)).toEqual(["dice", "narrative"]);
    expect(result.events[0]?.data).toEqual({ actor: "dice", kind: "roll", expr: "1d20", rolls: [], total: 14, label: "Luck", text: "1d20 [14] = 14", detail: { text: "1d20 [14] = 14", label: "Luck" } });
    expect(readTurnInjections(store, ROOM, 1)).toEqual(["Mind the clock."]);
    const later = contextFor(services, store.beginTurn(ROOM));
    applyModuleEffects(later, { ...NONE, injections: ["Second."] }, options());
    expect(readTurnInjections(store, ROOM, 1)).toEqual(["Mind the clock."]);
    expect(readTurnInjections(store, ROOM, 2)).toEqual(["Second."]);
  });
});

describe("narrate now", () => {
  test("the pure rule: one turn per action, none from inside it, none when switched off", () => {
    const raised = markNarrateNow(null, "line-1", "action");
    expect(raised).toEqual({ state: { action: "line-1", requested: true, opened: false }, raised: true });
    const opened = decideNarrateNow(raised.state, "line-1", true);
    expect(opened).toEqual({ open: true, reason: "open", state: { action: "line-1", requested: false, opened: true } });
    // Marked inside the narrate-now turn: waits for the next turn.
    expect(markNarrateNow(opened.state, "line-1", "facts_turn")).toEqual({ state: opened.state, raised: false });
    // Marked again by the same action after its turn opened (a late command phase): no second turn.
    expect(markNarrateNow(opened.state, "line-1", "action").raised).toBe(false);
    expect(decideNarrateNow(opened.state, "line-1", true).reason).toBe("not_requested");
    // A new action may open its own.
    const next = markNarrateNow(opened.state, "line-2", "action");
    expect(decideNarrateNow(next.state, "line-2", true).open).toBe(true);
    // A request left by an earlier action never opens a turn for a later one.
    expect(decideNarrateNow(next.state, "line-3", true)).toMatchObject({ open: false, reason: "other_action", state: { requested: false } });
    expect(decideNarrateNow(next.state, "line-2", false)).toMatchObject({ open: false, reason: "disabled", state: { requested: false } });
    expect(decideNarrateNow(null, "line-2", true).reason).toBe("not_requested");
  });

  test("the applier raises the flag once and stores the request; the room switch reads", () => {
    const { store, context } = room();
    const result = applyModuleEffects(context, { ...NONE, facts: [fact({ narrateNow: true }), fact({ narrateNow: true, to: "keeper" })] }, options());
    expect(result.narrateNow).toBe(true);
    expect(store.stateGet(ROOM, NARRATE_NOW)).toEqual({ action: "line-1", requested: true, opened: false });
    const inside = applyModuleEffects(context, { ...NONE, facts: [fact({ narrateNow: true })] }, options({ work: "facts_turn" }));
    expect(inside.narrateNow).toBe(false);
    expect(narrateNowEnabled(store, ROOM)).toBe(true);
    context.writer.statePut(NARRATE_NOW_SETTING, false);
    expect(narrateNowEnabled(store, ROOM)).toBe(false);
  });
});

test("a stale writer applies nothing", () => {
  const { store, services } = setup();
  const first = store.beginTurn(ROOM);
  putTree(services, first, { hp: 10 });
  const writer = store.beginTurn(ROOM);
  const context = contextFor(services, writer);
  store.undoTo(ROOM, 1);
  const result = applyModuleEffects(context, { ...NONE, facts: [fact(), fact({ to: "keeper" })], writes: [{ module: "clock", path: "hp", value: 1 }] }, options());
  expect(result).toEqual({
    stale: true,
    writes: { applied: [], refused: [] },
    pendingAdded: 0,
    narrateNow: false,
    events: [],
    problems: [{ code: "stale_writer", module: null }],
  });
  expect(tree(services)).toEqual({ hp: 10 });
  expect(readPendingFacts(store, ROOM)).toEqual([]);
});
