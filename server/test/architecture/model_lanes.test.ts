// Iron rule 5, made structural (the 2.6 `tests/architecture/test_model_call_lanes.py`):
// every model call site declares its LANE.
//
// - the Keeper's context has ONE assembler (`agent/prompt/`) and ONE caller, the turn
//   engine — nothing else builds or extends what the Keeper sees;
// - every other call site is a scoped actor (its own prompt from its own record — iron
//   rule 3), the chronicle fold, or plumbing that forwards a call unchanged;
// - `core/` makes no model call at all (iron rule 1).
//
// A new `.chat(` call site fails this test until it is listed here with its lane — the
// moment to ask whether it should exist. A listed file that stops calling the model fails
// too, so the table never rots.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SRC = join(import.meta.dir, "..", "..", "src");

type Lane = "keeper" | "scoped-actor" | "memory" | "plumbing";

const MODEL_CALL_LANES: ReadonlyMap<string, { readonly lane: Lane; readonly what: string }> = new Map([
  ["agent/turn/engine.ts", { lane: "keeper", what: "the Keeper's turn: tool rounds, check rounds, the finalizer" }],
  // The thin 3.0 placeholder the room still calls until it moves to the engine; delete both together.
  ["agent/turn.ts", { lane: "keeper", what: "the placeholder Keeper turn gateway/room.ts still uses" }],
  ["agent/lanes/npc_actor.ts", { lane: "scoped-actor", what: "one NPC, prompted from its own record" }],
  ["agent/lanes/scribe.ts", { lane: "scoped-actor", what: "the Scribe's bookkeeping pass" }],
  ["agent/lanes/director.ts", { lane: "scoped-actor", what: "the Stage Director" }],
  ["agent/lanes/fold.ts", { lane: "memory", what: "the chronicle fold" }],
  ["infra/llm/retry.ts", { lane: "plumbing", what: "the retry layer" }],
  ["infra/llm/index.ts", { lane: "plumbing", what: "the configured client" }],
]);

function files(directory: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) out.push(...files(path));
    else if (entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

/** The source without comments, so a `.chat(` in prose is not a call. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

function sources(): Map<string, string> {
  const map = new Map<string, string>();
  for (const path of files(SRC)) map.set(relative(SRC, path).split(sep).join("/"), code(readFileSync(path, "utf8")));
  return map;
}

test("every model call site declares its lane", () => {
  const sites = [...sources()].filter(([, text]) => /\.chat\(/.test(text)).map(([path]) => path).sort();
  const undeclared = sites.filter((path) => !MODEL_CALL_LANES.has(path));
  expect(undeclared).toEqual([]);
  const stale = [...MODEL_CALL_LANES.keys()].filter((path) => !sites.includes(path)).sort();
  expect(stale).toEqual([]);
});

test("core/ makes no model call", () => {
  const offenders = [...sources()].filter(([path, text]) => path.startsWith("core/") && /\.chat\(/.test(text)).map(([path]) => path);
  expect(offenders).toEqual([]);
});

test("the Keeper's prompt has one assembler and one caller", () => {
  const callers = [...sources()]
    .filter(([path, text]) => !path.startsWith("agent/prompt/") && /\b(assembleKeeperPrompt|keeperMessages)\b/.test(text))
    .map(([path]) => path)
    .sort();
  expect(callers).toEqual(["agent/turn/engine.ts"]);
  const keeperLanes = [...MODEL_CALL_LANES].filter(([, entry]) => entry.lane === "keeper").map(([path]) => path);
  // The placeholder sends its own one-message prompt; it goes when the room moves to the engine.
  expect(keeperLanes.sort()).toEqual(["agent/turn.ts", "agent/turn/engine.ts"]);
});
