import { describe, expect, test } from "bun:test";

import { DocumentTypes, KEEPER, playerViewer, actorViewer, DocumentViews, type Viewer } from "../../../src/core/documents/index.ts";
import { DocumentRefused, RawDocuments } from "../../../src/core/documents/raw.ts";
import {
  adjustVariable,
  applyReplyUpdates,
  applyUpdates,
  buildSpec,
  checkValue,
  decodeTree,
  defineVariable,
  encodeTree,
  evaluateArithmetic,
  exposePrefix,
  extractUpdates,
  flattenLeaves,
  fromPlain,
  hidePrefix,
  initVarBody,
  labelFor,
  MAX_TREE_DEPTH,
  MAX_TREE_NODES,
  MAX_UPDATE_COMMANDS,
  MAX_UPDATE_TEXT_CHARS,
  MAX_VARIABLES,
  mergeDeclarations,
  moduleVariablesDocument,
  moduleVariablesPayload,
  normalizeModuleVariables,
  normalizeVariableId,
  optionLabelFor,
  parseCommandValue,
  parseInitVar,
  parsePath,
  readJson5,
  readPath,
  removeVariable,
  seedTree,
  setVariable,
  toJson,
  variableTreeData,
  variableTreeDocument,
  type ModuleVariables,
  type VariableSpec,
  type VarMap,
} from "../../../src/core/variables/index.ts";
import { openDatabase } from "../../../src/infra/runtime/sqlite.ts";
import { Store } from "../../../src/infra/store.ts";

function tree(json: string): VarMap {
  const read = readJson5(json);
  if (!read.ok || !(read.value instanceof Map)) throw new Error(`bad test tree: ${json}`);
  return read.value;
}

function outcomes(text: string, start: VarMap): string[] {
  return applyReplyUpdates(start, text).results.map((result) => (result.outcome.status === "applied" ? "applied" : result.outcome.code));
}

describe("the tree keeps hostile keys ordinary and in written order", () => {
  test("number-like keys, __proto__ and constructor survive a round trip in order", () => {
    const source = '{"2": "two", "1": "one", "__proto__": {"polluted": true}, "constructor": 3, "10": [1, "d"]}';
    const read = tree(source);
    expect([...read.keys()]).toEqual(["2", "1", "__proto__", "constructor", "10"]);
    const encoded = encodeTree(read);
    expect(encoded).toBe('{"2":"two","1":"one","__proto__":{"polluted":true},"constructor":3,"10":[1,"d"]}');
    expect([...(decodeTree(encoded) as VarMap).keys()]).toEqual(["2", "1", "__proto__", "constructor", "10"]);
    expect(flattenLeaves(read).map((leaf) => leaf.path)).toEqual(["2", "1", "__proto__.polluted", "constructor", "10"]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test("a __proto__ path is an ordinary key for every operation", () => {
    const start = tree('{"__proto__": {"hp": 1}}');
    const out = applyReplyUpdates(start, "<UpdateVariable>_.add('__proto__.hp', 2);_.insert('__proto__', 'x', 5);</UpdateVariable>");
    expect(encodeTree(out.tree)).toBe('{"__proto__":{"hp":3,"x":5}}');
  });

  test("decodeTree refuses what is not a bounded mapping", () => {
    expect(decodeTree("[1]")).toBeNull();
    expect(decodeTree("{'a': 1}")).toBeNull();
    expect(decodeTree('{"a": NaN}')).toBeNull();
  });
});

describe("JSON5", () => {
  test("reads the JSON5 grammar MagVarUpdate's parser accepts", () => {
    const read = readJson5("// c\n{好感度: 5, hex: 0x1F, plus: +1, half: .5, tail: 5., 'q': 'it\\'s', s: 'a\\\nb', list: [1, 2,], /* x */}");
    expect(read.ok).toBe(true);
    if (read.ok) expect(toJson(read.value)).toEqual({ 好感度: 5, hex: 31, plus: 1, half: 0.5, tail: 5, q: "it's", s: "ab", list: [1, 2] });
  });

  test("strict mode is JSON only", () => {
    expect(readJson5("{'a': 1}", { strict: true }).ok).toBe(false);
    expect(readJson5("[1,]", { strict: true }).ok).toBe(false);
    expect(readJson5('{"a": [1, 2]}', { strict: true }).ok).toBe(true);
  });

  test("hostile nesting and length are refused, not recursed into", () => {
    expect(readJson5("[".repeat(100_000)).ok).toBe(false);
    expect(readJson5(`"${"x".repeat(2_000_001)}"`).ok).toBe(false);
  });
});

describe("[InitVar] declarations", () => {
  test("an <initvar> wrapper and a code fence are unwrapped (MagVarUpdate loadInitVarData)", () => {
    expect(initVarBody("<initvar>\n```yaml\na: 1\n```\n</initvar>")).toBe("a: 1");
    const parsed = parseInitVar(initVarBody("```json\n{\"a\": [1, \"d\"]}\n```"));
    expect(parsed.ok && toJson(parsed.tree)).toEqual({ a: [1, "d"] });
  });

  test("a tree past a bound is refused with a code, never cut down", () => {
    const deep = `${'{"a":'.repeat(MAX_TREE_DEPTH + 1)}1${"}".repeat(MAX_TREE_DEPTH + 1)}`;
    expect(parseInitVar(`${'{"a":'.repeat(MAX_TREE_DEPTH)}1${"}".repeat(MAX_TREE_DEPTH)}`).ok).toBe(true);
    expect(parseInitVar(deep)).toEqual({ ok: false, code: "too_deep" });
    const wide = `{${Array.from({ length: MAX_TREE_NODES + 1 }, (_, index) => `"k${index}": 0`).join(",")}}`;
    expect(parseInitVar(wide)).toEqual({ ok: false, code: "too_many_nodes" });
    expect(parseInitVar(`{"${"键".repeat(300)}": 1}`)).toEqual({ ok: false, code: "key_too_long" });
  });

  test("YAML anchors are refused (a bound on hostile content)", () => {
    expect(parseInitVar("a: &x [1]\nb: *x\n").ok).toBe(false);
  });

  test("several declarations merge with lists replaced (correctlyMerge); a room's top-level keys win (stat_data spread)", () => {
    const merged = mergeDeclarations(tree('{"a": {"x": 1, "l": [1, 2, 3]}}'), tree('{"a": {"y": 2, "l": [9]}, "b": 1}'));
    expect(toJson(merged)).toEqual({ a: { x: 1, y: 2, l: [9] }, b: 1 });
    const seeded = seedTree(tree('{"a": {"x": 5}, "own": null}'), merged);
    expect(encodeTree(seeded.tree)).toBe('{"a":{"x":5},"b":1,"own":null}');
    expect(seeded.changed).toBe(true);
    expect(seedTree(seeded.tree, merged).changed).toBe(false);
  });
});

describe("<UpdateVariable> commands (MagVarUpdate semantics)", () => {
  const start = (): VarMap => tree('{"hp": 10, "好感度": [33, "对主角的好感"], "flag": true, "pair": [["x"], "d"], "tags": ["a"], "info": {"k": 1, "2": 2, "1": 1}, "day": "2026-08-04"}');

  test("a call without its `;` is not a command (MagVarUpdate tests: 处理缺少分号的 _.set 调用)", () => {
    expect(extractUpdates("<UpdateVariable>_.set('hp', 1)</UpdateVariable>").commands).toEqual([]);
  });

  test("several commands on one line all apply, in order", () => {
    expect(outcomes("<UpdateVariable>_.set('hp', 1);_.add('hp', 2);//r\n</UpdateVariable>", start())).toEqual(["applied", "applied"]);
    expect(readPath(applyReplyUpdates(start(), "<UpdateVariable>_.set('hp', 1);_.add('hp', 2);</UpdateVariable>").tree, "hp")).toBe(3);
  });

  test("reasoning inside a block is ignored; the three tag names and aliases are read", () => {
    const text = "<VariableUpdate><think>_.set('hp', 0);</think>_.assign('tags', 'b');_.remove('tags', 'a');</VariableUpdate>";
    const out = applyReplyUpdates(start(), text);
    expect(out.results.map((result) => [result.command.written, result.command.op])).toEqual([["assign", "insert"], ["remove", "delete"]]);
    expect(readPath(out.tree, "tags")).toEqual(["b"]);
    expect(readPath(out.tree, "hp")).toBe(10);
    expect(out.text).toBe("");
  });

  test("set keeps a description, makes number text a number, and is only for existing paths", () => {
    const out = applyReplyUpdates(start(), "<UpdateVariable>_.set('好感度', 33, '40');_.set('hp', '7');_.set('new', 1);</UpdateVariable>");
    expect(out.results.map((result) => result.outcome)).toEqual([
      { status: "applied", old: 33, value: 40 },
      { status: "applied", old: 10, value: 7 },
      { status: "refused", code: "unknown_path" },
    ]);
    expect(toJson(out.tree)).toMatchObject({ 好感度: [40, "对主角的好感"], hp: 7 });
  });

  test("a pair whose value is a list is not a described value for set: it is replaced whole", () => {
    expect(toJson(applyReplyUpdates(start(), "<UpdateVariable>_.set('pair', 3);</UpdateVariable>").tree)).toMatchObject({ pair: 3 });
  });

  test("add: numbers only — a boolean delta never turns a number into a boolean; a date is refused", () => {
    expect(outcomes("<UpdateVariable>_.add('hp', true);_.add('flag', 1);_.add('day', 1000);_.add('好感度', -3);</UpdateVariable>", start())).toEqual([
      "delta_not_number",
      "unsupported_target",
      "unsupported_target",
      "applied",
    ]);
  });

  test("insert creates a missing child of an existing parent, and refuses a missing parent", () => {
    const out = applyReplyUpdates(start(), "<UpdateVariable>_.insert('info.new', 'a', 1);_.insert('nope.deeper', 1);_.insert('list', [1]);</UpdateVariable>");
    expect(out.results.map((result) => (result.outcome.status === "applied" ? "applied" : result.outcome.code))).toEqual(["applied", "missing_parent", "applied"]);
    expect(toJson(out.tree)).toMatchObject({ info: { new: { a: 1 } }, list: [[1]] });
  });

  test("delete by number on a mapping removes the n-th key in WRITTEN order", () => {
    const out = applyReplyUpdates(start(), "<UpdateVariable>_.delete('info', 1);</UpdateVariable>");
    expect([...(out.tree.get("info") as VarMap).keys()]).toEqual(["k", "1"]);
  });

  test("the root cannot be replaced, and a refused command leaves no trace", () => {
    const before = start();
    const out = applyReplyUpdates(before, "<UpdateVariable>_.set('', 1);_.delete('');_.insert('tags', 'nope', 1);</UpdateVariable>");
    expect(out.results.map((result) => (result.outcome.status === "refused" ? result.outcome.code : "applied"))).toEqual(["root_path", "root_path", "bad_index"]);
    expect(out.changed).toBe(false);
    expect(encodeTree(out.tree)).toBe(encodeTree(before));
  });

  test("the input tree is never modified", () => {
    const before = start();
    const snapshot = encodeTree(before);
    applyReplyUpdates(before, "<UpdateVariable>_.set('hp', 1);_.insert('tags', 'z');_.delete('info');</UpdateVariable>");
    expect(encodeTree(before)).toBe(snapshot);
  });

  test("a write that would break a bound is refused (too_large)", () => {
    const huge = `'${"x".repeat(20_001)}'`;
    expect(outcomes(`<UpdateVariable>_.insert('tags', ${huge});</UpdateVariable>`, start())).toEqual(["too_large"]);
  });

  test("commands past the cap are refused, and an over-long reply is not scanned", () => {
    const many = Array.from({ length: MAX_UPDATE_COMMANDS + 2 }, () => "_.add('hp', 1);").join("\n");
    const out = applyReplyUpdates(start(), `<UpdateVariable>${many}</UpdateVariable>`);
    expect(out.results.slice(-2).map((result) => result.outcome)).toEqual([
      { status: "refused", code: "too_large" },
      { status: "refused", code: "too_large" },
    ]);
    const long = `${"x".repeat(MAX_UPDATE_TEXT_CHARS)}<UpdateVariable>_.add('hp', 1);</UpdateVariable>`;
    const skipped = applyReplyUpdates(start(), long);
    expect(skipped.overflow).toBe(true);
    expect(skipped.changed).toBe(false);
    expect(skipped.text).toBe(long);
  });

  test("lodash paths: brackets, quoted keys, and segments kept as written", () => {
    expect(parsePath('a.b[0]["x.y"]')).toEqual(["a", "b", "0", "x.y"]);
    expect(parsePath("a..b")).toEqual(["a", "", "b"]);
    expect(parsePath(' 世界 . day ')).toEqual([" 世界 ", " day "]);
  });

  test("values: MagVarUpdate's parse order, minus code evaluation", () => {
    expect(parseCommandValue("'it''s \\n'")).toEqual({ ok: true, value: "it's \\n" });
    expect(parseCommandValue("TRUE")).toEqual({ ok: true, value: true });
    expect(parseCommandValue("undefined")).toEqual({ ok: false });
    expect(parseCommandValue("-1d3")).toEqual({ ok: true, value: "-1d3" });
    expect(evaluateArithmetic("10 + 2 * (3 - 1)")).toBe(14);
    expect(evaluateArithmetic("-2^2")).toBe(-4);
    expect(evaluateArithmetic("0.1 + 0.2")).toBe(0.3);
    expect(evaluateArithmetic("1/0")).toBeNull();
    expect(evaluateArithmetic("2 % 3")).toBeNull();
  });
});

describe("exposure lists", () => {
  test("expose and hide are idempotent and bounded", () => {
    const added = exposePrefix([], " 悟空. ");
    expect(added).toEqual({ status: "added", exposed: ["悟空"] });
    expect(exposePrefix(["悟空"], "悟空")).toEqual({ status: "unchanged" });
    expect(exposePrefix([], "  ")).toEqual({ status: "invalid" });
    expect(exposePrefix(Array.from({ length: 64 }, (_, index) => `p${index}`), "x")).toEqual({ status: "limit_reached" });
    expect(hidePrefix(["悟空"], "悟空")).toEqual({ status: "removed", exposed: [] });
  });
});

describe("module variables", () => {
  const spec = (input: Parameters<typeof buildSpec>[0]): VariableSpec => {
    const built = buildSpec(input);
    if (!built.ok) throw new Error(built.problem);
    return built.spec;
  };

  test("ids: CJK first-class, ASCII slug-strict, separators and controls refused", () => {
    expect(normalizeVariableId(" Truth-Level ")).toBe("truth_level");
    expect(normalizeVariableId("理智")).toBe("理智");
    expect(normalizeVariableId("a.b")).toBeNull();
    expect(normalizeVariableId("理​智")).toBeNull();
    expect(normalizeVariableId("x".repeat(65))).toBeNull();
  });

  test("writes are validated, clamped and reported in the shared vocabulary", () => {
    let state: ModuleVariables = { variables: [] };
    state = defineVariable(state, spec({ id: "san", kind: "number", minimum: 0, maximum: 99, default: 50 })).state;
    state = defineVariable(state, spec({ id: "note", kind: "text" })).state;
    expect(setVariable(state, "san", "120").outcome).toEqual({ status: "applied", old: 50, value: 99 });
    expect(adjustVariable(state, "san", -60).outcome).toEqual({ status: "applied", old: 50, value: 0 });
    expect(adjustVariable(state, "san", true).outcome).toEqual({ status: "refused", code: "delta_not_number" });
    expect(adjustVariable(state, "note", 1).outcome).toEqual({ status: "refused", code: "wrong_kind" });
    expect(setVariable(state, "note", 42).outcome).toEqual({ status: "applied", old: "", value: "42" });
    expect(setVariable(state, "note", "x".repeat(201)).outcome).toEqual({ status: "refused", code: "too_long" });
    expect(setVariable(state, "note", { a: 1 }).outcome).toEqual({ status: "refused", code: "not_text" });
    expect(setVariable(state, "ghost", 1).outcome).toEqual({ status: "refused", code: "unknown_path" });
    expect(removeVariable(state, "note").state.variables.map((variable) => variable.spec.id)).toEqual(["san"]);
  });

  test("redefinition keeps position and a still-valid value (re-clamped); the cap refuses", () => {
    let state = defineVariable({ variables: [] }, spec({ id: "a", kind: "number", default: 80 })).state;
    state = defineVariable(state, spec({ id: "b", kind: "bool" })).state;
    state = defineVariable(state, spec({ id: "a", kind: "number", maximum: 10 })).state;
    expect(state.variables.map((variable) => [variable.spec.id, variable.value])).toEqual([["a", 10], ["b", false]]);
    let full: ModuleVariables = { variables: [] };
    for (let index = 0; index < MAX_VARIABLES; index++) full = defineVariable(full, spec({ id: `v${index}`, kind: "bool" })).state;
    expect(defineVariable(full, spec({ id: "extra", kind: "bool" })).outcome).toEqual({ status: "refused", code: "limit_reached" });
  });

  test("enum options match case-insensitively; labels resolve by locale; option names may be any text", () => {
    const culprit = spec({ id: "culprit", kind: "enum", options: ["Butler", "__proto__"], labels: { en: "Culprit", "zh-CN": "凶手" }, optionLabels: { zh: { butler: "管家", ["__proto__"]: "原型" } } });
    expect(checkValue(culprit, "BUTLER")).toEqual({ ok: true, value: "Butler" });
    expect(checkValue(culprit, "heir")).toEqual({ ok: false, code: "not_an_option" });
    expect(labelFor(culprit, "zh-TW")).toBe("凶手");
    expect(labelFor(culprit, "fr")).toBe("Culprit");
    expect(optionLabelFor(culprit, "Butler", "zh")).toBe("管家");
    expect(optionLabelFor(culprit, "__proto__", "zh")).toBe("原型");
    expect(buildSpec({ id: "x", kind: "text", labels: { en: "y".repeat(51) } })).toEqual({ ok: false, problem: "too_long" });
  });

  test("stored state is normalized: junk dropped, first id wins, bad values fall back to the default", () => {
    const state = normalizeModuleVariables({
      variables: [
        { spec: { id: "a", kind: "number", default: 1 }, value: "x" },
        { spec: { id: "a", kind: "bool" }, value: true },
        { spec: { id: "b", kind: "colour" }, value: 1 },
        "junk",
      ],
    });
    expect(state.variables).toEqual([{ spec: { id: "a", kind: "number", visibility: "player", labels: {}, default: 1 }, value: 1 }]);
  });
});

describe("documents: who sees which variables", () => {
  function setup() {
    const store = new Store(openDatabase(":memory:"));
    const types = new DocumentTypes().register(variableTreeDocument).register(moduleVariablesDocument);
    return { raw: new RawDocuments(store, types), views: new DocumentViews(store, types), w: store.writer("r") };
  }
  const ADMIN: Viewer = { grade: "admin", locale: "zh" };
  const PLAYER = playerViewer("zh", "m1");
  const OBSERVER: Viewer = { grade: "observer", locale: "en" };
  const SECRET = "真凶是管家";

  test("variable_tree: keeper sees all, admin sees hidden leaves flagged, players see only exposed leaves", () => {
    const { raw, views, w } = setup();
    const declared = tree(`{"悟空": {"好感度": [50, "d"]}, "悟空二号": {"秘密": "${SECRET}"}, "1": 1}`);
    raw.put(w, "variable_tree", "tree", variableTreeData(declared, ["悟空"]));

    const keeper = views.view("r", "variable_tree", "tree", KEEPER) as Record<string, any>;
    expect(keeper.leaves).toEqual([
      { path: "悟空.好感度", value: 50, description: "d", exposed: true },
      { path: "悟空二号.秘密", value: SECRET, exposed: false },
      { path: "1", value: 1, exposed: false },
    ]);
    expect(keeper.treeJson).toBe(encodeTree(declared));

    const admin = views.view("r", "variable_tree", "tree", ADMIN) as Record<string, any>;
    expect(admin.leaves.map((leaf: Record<string, unknown>) => [leaf.path, leaf.hidden === true])).toEqual([["悟空.好感度", false], ["悟空二号.秘密", true], ["1", true]]);
    expect(admin.treeJson).toBe('{"悟空":{"好感度":[50,"d"]}}');

    for (const viewer of [PLAYER, OBSERVER, actorViewer("npc1", "en")]) {
      const view = views.view("r", "variable_tree", "tree", viewer);
      expect(view).toEqual({ leaves: [{ path: "悟空.好感度", value: 50, description: "d" }], treeJson: '{"悟空":{"好感度":[50,"d"]}}' });
      expect(JSON.stringify(view)).not.toContain(SECRET);
    }
  });

  test("variable_tree: nothing exposed means nothing at all for a player", () => {
    const { raw, views, w } = setup();
    raw.put(w, "variable_tree", "tree", variableTreeData(tree(`{"a": "${SECRET}"}`), []));
    expect(views.view("r", "variable_tree", "tree", PLAYER)).toEqual({ leaves: [], treeJson: "{}" });
  });

  test("variable_tree: an unreadable payload is refused at write", () => {
    const { raw, w } = setup();
    expect(() => raw.put(w, "variable_tree", "tree", { tree: "{'a': 1}", exposed: [] })).toThrow(DocumentRefused);
    expect(() => raw.put(w, "variable_tree", "tree", { tree: "{}", exposed: [3] })).toThrow(DocumentRefused);
  });

  test("module_variables: a keeper-only tracker leaves no trace in a player view", () => {
    const { raw, views, w } = setup();
    let state: ModuleVariables = { variables: [] };
    for (const input of [
      { id: "理智", kind: "number", minimum: 0, maximum: 99, default: 80, labels: { en: "Sanity", zh: "理智值" } },
      { id: "culprit_secret", kind: "enum", visibility: "keeper", options: ["butler", "heir"], optionLabels: { en: { butler: SECRET } } },
    ] as const) {
      const built = buildSpec(input);
      if (!built.ok) throw new Error(built.problem);
      state = defineVariable(state, built.spec).state;
    }
    raw.put(w, "module_variables", "variables", moduleVariablesPayload(state));

    const keeper = views.view("r", "module_variables", "variables", { grade: "keeper", locale: "en" }) as Record<string, any>;
    expect(keeper.variables).toEqual([
      { id: "理智", kind: "number", label: "Sanity", value: 80, min: 0, max: 99, visibility: "player" },
      { id: "culprit_secret", kind: "enum", label: "culprit_secret", value: "butler", valueLabel: SECRET, options: ["butler", "heir"], visibility: "keeper" },
    ]);
    const admin = views.view("r", "module_variables", "variables", ADMIN) as Record<string, any>;
    expect(admin.variables.map((variable: Record<string, unknown>) => [variable.id, variable.hidden === true, variable.label])).toEqual([["理智", false, "理智值"], ["culprit_secret", true, "culprit_secret"]]);
    const player = views.view("r", "module_variables", "variables", PLAYER);
    expect(player).toEqual({ variables: [{ id: "理智", kind: "number", label: "理智值", value: 80, min: 0, max: 99 }] });
    expect(JSON.stringify(player)).not.toContain("culprit");
    expect(JSON.stringify(views.view("r", "module_variables", "variables", OBSERVER))).not.toContain(SECRET);
  });

  test("module_variables: a payload with an invalid spec, a repeated id or an unfit value is refused", () => {
    const { raw, w } = setup();
    expect(() => raw.put(w, "module_variables", "variables", { variables: [{ spec: { id: "a", kind: "colour" }, value: 1 }] })).toThrow(DocumentRefused);
    const a = { spec: { id: "a", kind: "bool", visibility: "player", labels: {}, default: false }, value: false };
    expect(() => raw.put(w, "module_variables", "variables", { variables: [a, a] })).toThrow(DocumentRefused);
    expect(() => raw.put(w, "module_variables", "variables", { variables: [{ ...a, value: "maybe" }] })).toThrow(DocumentRefused);
    expect(raw.put(w, "module_variables", "variables", { variables: [a] }).data).toEqual({ variables: [a] });
  });
});

test("fromPlain refuses what is not JSON data", () => {
  expect(fromPlain(new Date(0))).toBeUndefined();
  expect(fromPlain({ a: [1, { b: null }] }) instanceof Map).toBe(true);
});

test("applyUpdates on parsed commands reports each result with its command", () => {
  const { commands } = extractUpdates("<UpdateVariable>_.add('n', 1);//why\n</UpdateVariable>");
  const result = applyUpdates(tree('{"n": 1}'), commands);
  expect(result.results).toEqual([{ command: { op: "add", written: "add", path: "n", args: ["1"], reason: "why" }, outcome: { status: "applied", old: 1, value: 2 } }]);
});
