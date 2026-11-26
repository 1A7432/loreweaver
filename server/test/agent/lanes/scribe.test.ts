import { describe, expect, test } from "bun:test";

import type { RoomContext, Services } from "../../../src/agent/context.ts";
import {
  allowAllScribeOps,
  allowedScribeOps,
  commitScribe,
  computeScribe,
  MAX_STORED_WHISPERS,
  MAX_WHISPERS,
  readScribeSnapshot,
  SCRIBE_LANE,
  scribeVetoCalls,
  type ScribeProposal,
  type ScribeSnapshot,
  type ScribeTurnFacts,
  WHISPERS_KEY,
} from "../../../src/agent/lanes/scribe.ts";
import { CHRONICLE_RECORD_TYPE, chronicleRecordDocumentType, readChronicleRecord } from "../../../src/core/chronicle/records.ts";
import { DocumentTypes } from "../../../src/core/documents/model.ts";
import { documentCatalog, RawDocuments } from "../../../src/core/documents/raw.ts";
import { DocumentViews } from "../../../src/core/documents/views.ts";
import { readTableHabits, TABLE_HABITS_ID, TABLE_HABITS_TYPE, tableHabitsDocumentType } from "../../../src/core/habits/index.ts";
import { createNpc, npcData, npcDocument, NPC_TYPE } from "../../../src/core/npcs/index.ts";
import { MODULE_VARIABLES_ID, MODULE_VARIABLES_TYPE, moduleVariablesDocument, moduleVariablesPayload } from "../../../src/core/variables/documents.ts";
import { buildSpec, defineVariable, EMPTY_MODULE_VARIABLES, normalizeModuleVariables, type ModuleVariables } from "../../../src/core/variables/modvars.ts";
import { currentLane, LLMError, type ScriptedReply, ScriptedLLM } from "../../../src/infra/llm/index.ts";
import { openDatabase } from "../../../src/infra/runtime/sqlite.ts";
import { type RoomWriter, Store } from "../../../src/infra/store.ts";

const ROOM = "scribe-room";
const PLAYER = "I grab the brass key from the desk and pocket it.";
const REPLY = "The drawer sticks, then gives.\nYou find the brass key and slip it into your coat. Night falls over the harbour.";

function variables(): ModuleVariables {
  let state = EMPTY_MODULE_VARIABLES;
  for (const input of [
    { id: "keys", kind: "number", labels: { en: "Keys found" }, minimum: 0, maximum: 5, default: 0 },
    { id: "day", kind: "number", labels: { en: "Day" }, minimum: 1, maximum: 9, default: 1 },
    { id: "alarm", kind: "number", labels: { en: "Alarm" }, minimum: 0, maximum: 10, default: 0, visibility: "keeper" },
  ]) {
    const spec = buildSpec(input);
    if (!spec.ok) throw new Error(spec.problem);
    state = defineVariable(state, spec.spec).state;
  }
  return state;
}

function setup(script: readonly ScriptedReply[] = []) {
  const store = new Store(openDatabase(":memory:"));
  const types = new DocumentTypes()
    .register(moduleVariablesDocument)
    .register(npcDocument)
    .register(tableHabitsDocumentType)
    .register(chronicleRecordDocumentType);
  const llm = new ScriptedLLM(script);
  const services: Services = {
    store,
    types,
    documents: new RawDocuments(store, types),
    views: new DocumentViews(store, types),
    packs: {} as never,
    models: { keeper: llm, npc: llm, scribe: llm, director: llm, memory: llm },
    clock: { id: () => "x", now: () => 0 },
    report: () => undefined,
  };
  services.documents.put(store.writer(ROOM), MODULE_VARIABLES_TYPE, MODULE_VARIABLES_ID, moduleVariablesPayload(variables()));
  return { store, types, llm, services };
}

function contextFor(services: Services, writer: RoomWriter): RoomContext {
  return {
    services,
    room: ROOM,
    turn: writer.turn,
    writer,
    locale: "en",
    pack: null,
    variant: null,
    who: { member: null, character: null },
    random: {} as never,
  };
}

function facts(overrides: Partial<ScribeTurnFacts> = {}): ScribeTurnFacts {
  return { player: PLAYER, reply: REPLY, toolsCalled: [], moduleWrites: new Set(), keeperRecordedChronicle: false, ...overrides };
}

function reply(body: Record<string, unknown>): string {
  return `Sure.\n${JSON.stringify(body)}\n`;
}

function valueOf(services: Services, id: string): unknown {
  const document = services.documents.get(ROOM, MODULE_VARIABLES_TYPE, MODULE_VARIABLES_ID);
  return normalizeModuleVariables(document?.data).variables.find((variable) => variable.spec.id === id)?.value;
}

function records(services: Services) {
  return services.documents.list(ROOM, CHRONICLE_RECORD_TYPE).map((document) => ({ id: document.id, record: readChronicleRecord(document.data) }));
}

async function pass(services: Services, snapshot: ScribeSnapshot): Promise<ScribeProposal> {
  return computeScribe(snapshot, services);
}

describe("the evidence rule", () => {
  test("an op stands only on a verbatim quotation of the reply", async () => {
    const { services, store, llm } = setup([
      reply({
        ops: [
          // Quoted from the reply, across its line break: kept.
          { op: "adjust", id: "keys", delta: 1, evidence: "You find the brass key   and slip it into your coat." },
          // Quoted from the PLAYER: what they attempted, not what happened.
          { op: "adjust", id: "keys", delta: 1, evidence: "I grab the brass key from the desk" },
          // A paraphrase: not in the reply.
          { op: "set", id: "day", value: 2, evidence: "a new day dawned" },
          // Too short to mean anything.
          { op: "set", id: "day", value: 2, evidence: "The" },
          // No such variable.
          { op: "set", id: "doom", value: 3, evidence: "Night falls over the harbour." },
        ],
      }),
    ]);
    const writer = store.beginTurn(ROOM);
    const snapshot = readScribeSnapshot(services, ROOM, "en", facts());
    const proposal = await pass(services, snapshot);
    expect(proposal.status).toBe("ok");
    expect(proposal.ops).toEqual([{ op: "adjust", id: "keys", delta: 1, evidence: "You find the brass key and slip it into your coat." }]);
    expect(proposal.dropped.noEvidence).toBe(3);
    expect(proposal.dropped.unknownVariable).toBe(1);

    // The model saw the reply, the player's line, and the keeper-grade variables.
    const prompt = llm.calls[0]?.[0]?.content ?? "";
    expect(prompt).toContain(REPLY);
    expect(prompt).toContain("- alarm | Alarm | 0 | 0..10");

    const commit = commitScribe(contextFor(services, writer), proposal, allowAllScribeOps(proposal));
    expect(commit.status).toBe("committed");
    if (commit.status !== "committed") return;
    expect(commit.variablesChanged).toBe(true);
    expect(commit.opsApplied).toBe(1);
    expect(valueOf(services, "keys")).toBe(1);
    expect(valueOf(services, "day")).toBe(1);
  });

  test("the unrolled-check observation needs the same evidence", async () => {
    const { services, store } = setup([
      reply({ unrolled_check: { skill: "Lockpicking", evidence: "The drawer sticks, then gives." } }),
      reply({ unrolled_check: { skill: "Lockpicking", evidence: "I grab the brass key" } }),
    ]);
    store.beginTurn(ROOM);
    const snapshot = readScribeSnapshot(services, ROOM, "en", facts());
    expect((await pass(services, snapshot)).whispers).toEqual([{ kind: "unrolled_check", skill: "Lockpicking", quote: "The drawer sticks, then gives." }]);
    expect((await pass(services, snapshot)).whispers).toEqual([]);
  });
});

describe("module-owned variables", () => {
  test("a variable a module wrote this turn is left alone", async () => {
    const { services, store } = setup([reply({ ops: [{ op: "set", id: "keys", value: 4, evidence: "You find the brass key" }] })]);
    const writer = store.beginTurn(ROOM);
    const snapshot = readScribeSnapshot(services, ROOM, "en", facts({ moduleWrites: new Set(["keys"]) }));
    const proposal = await pass(services, snapshot);
    expect(proposal.ops).toEqual([]);
    expect(proposal.dropped.moduleOwned).toBe(1);
    commitScribe(contextFor(services, writer), proposal, allowAllScribeOps(proposal));
    expect(valueOf(services, "keys")).toBe(0);
  });

  test("the modules' veto is asked as the tool call each op stands for, and binds the commit", async () => {
    const { services, store } = setup([
      reply({
        ops: [
          { op: "adjust", id: "keys", delta: 2, evidence: "You find the brass key" },
          { op: "set", id: "day", value: 2, evidence: "Night falls over the harbour." },
        ],
      }),
    ]);
    const writer = store.beginTurn(ROOM);
    const proposal = await pass(services, readScribeSnapshot(services, ROOM, "en", facts()));
    expect(scribeVetoCalls(proposal)).toEqual([
      { id: "scribe-0", name: "adjust_variable", args: { var_id: "keys", delta: 2 } },
      { id: "scribe-1", name: "set_variable", args: { var_id: "day", value: 2 } },
    ]);
    const allowed = allowedScribeOps(proposal, [{ allowed: false, denials: [{ module: "m", reason: "hook-owned" }] }, { allowed: true }]);
    expect(allowed.vetoed).toBe(1);
    commitScribe(contextFor(services, writer), proposal, allowed);
    expect(valueOf(services, "keys")).toBe(0);
    expect(valueOf(services, "day")).toBe(2);
  });
});

describe("the chronicle line", () => {
  test("none when the Keeper recorded one itself this turn", async () => {
    const line = { chronicle: "The brass key was found in the harbour office." };
    const { services, store } = setup([reply(line), reply(line)]);
    const writer = store.beginTurn(ROOM);
    const own = await pass(services, readScribeSnapshot(services, ROOM, "en", facts({ keeperRecordedChronicle: true })));
    expect(own.chronicle).toBeNull();
    const commit = commitScribe(contextFor(services, writer), own, allowAllScribeOps(own));
    expect(commit.status === "committed" && commit.chronicleRecord).toBeNull();
    expect(records(services)).toEqual([]);

    const auto = await pass(services, readScribeSnapshot(services, ROOM, "en", facts()));
    commitScribe(contextFor(services, writer), auto, allowAllScribeOps(auto));
    expect(records(services)).toEqual([
      { id: "c000001", record: { turn: 1, text: line.chronicle, characters: [], scene: "", keeper: "", folded: false } },
    ]);
  });

  test("a line over its cap is refused, not cut", async () => {
    const { services, store } = setup([reply({ chronicle: "x".repeat(401) })]);
    store.beginTurn(ROOM);
    const proposal = await pass(services, readScribeSnapshot(services, ROOM, "en", facts()));
    expect(proposal.chronicle).toBeNull();
    expect(proposal.dropped.tooLong).toBe(1);
  });
});

describe("whispers", () => {
  test("at most three per pass, at most five queued", async () => {
    const many = reply({ whispers: ["one", "two", "three", "four", "five"] });
    const { services, store } = setup([many, many]);
    const writer = store.beginTurn(ROOM);
    const first = await pass(services, readScribeSnapshot(services, ROOM, "en", facts()));
    expect(first.whispers).toHaveLength(MAX_WHISPERS);
    expect(first.dropped.overCap).toBe(2);
    commitScribe(contextFor(services, writer), first, allowAllScribeOps(first));
    const second = await pass(services, readScribeSnapshot(services, ROOM, "en", facts()));
    commitScribe(contextFor(services, writer), second, allowAllScribeOps(second));
    const queued = store.stateGet(ROOM, WHISPERS_KEY) ?? [];
    expect(queued).toHaveLength(MAX_STORED_WHISPERS);
    expect(queued.map((whisper) => (whisper.kind === "note" ? whisper.text : ""))).toEqual(["two", "three", "one", "two", "three"]);
  });

  test("an NPC overreach is watched only where NPCs have recorded knowledge", async () => {
    const overreach = { npc_overreach: { npc: "Martha", quote: "Night falls over the harbour.", fact: "the harbour's secret" } };
    const { services, store, llm } = setup([reply(overreach), reply(overreach)]);
    store.beginTurn(ROOM);
    const unwatched = await pass(services, readScribeSnapshot(services, ROOM, "en", facts()));
    expect(unwatched.whispers).toEqual([]);
    expect(llm.calls[0]?.[0]?.content).not.toContain("NPC knowledge boundaries");

    const martha = createNpc({ name: "Martha", knowledge: ["The cellar door sticks."] });
    if (!martha.ok) throw new Error(martha.code);
    services.documents.put(store.writer(ROOM), NPC_TYPE, "martha", npcData(martha.data));
    const watched = await pass(services, readScribeSnapshot(services, ROOM, "en", facts()));
    expect(llm.calls[1]?.[0]?.content).toContain("- Martha | The cellar door sticks.");
    expect(watched.whispers).toEqual([{ kind: "npc_overreach", npc: "Martha", fact: "the harbour's secret", quote: "Night falls over the harbour." }]);
  });
});

describe("habits and the beat", () => {
  test("a habit is observed; the beat crosses as an enum value only", async () => {
    const { services, store } = setup([
      reply({ habit: { summary: "They skip shopping scenes", detail: "Twice now." }, beat: "scene_change" }),
      reply({ beat: "scene_change: they fled to the docks with the key" }),
    ]);
    const writer = store.beginTurn(ROOM);
    const proposal = await pass(services, readScribeSnapshot(services, ROOM, "en", facts()));
    expect(proposal.beat).toBe("scene_change");
    const commit = commitScribe(contextFor(services, writer), proposal, allowAllScribeOps(proposal));
    expect(commit.status === "committed" && commit.habit).toBe("observed");
    expect(commit.status === "committed" && commit.beat).toBe("scene_change");
    const habits = services.documents.get(ROOM, TABLE_HABITS_TYPE, TABLE_HABITS_ID);
    expect(readTableHabits(habits?.data ?? {}).pending.map((habit) => habit.summary)).toEqual(["They skip shopping scenes"]);

    const prose = await pass(services, readScribeSnapshot(services, ROOM, "en", facts()));
    expect(prose.beat).toBeNull();
  });
});

describe("generations", () => {
  test("the commit lands under the scheduled turn even when later turns have begun", async () => {
    const { services, store } = setup([
      reply({ ops: [{ op: "adjust", id: "keys", delta: 1, evidence: "You find the brass key" }], chronicle: "The key was found.", whispers: ["late"] }),
    ]);
    const scheduled = contextFor(services, store.beginTurn(ROOM));
    const proposal = await pass(services, readScribeSnapshot(services, ROOM, "en", facts()));
    store.beginTurn(ROOM);
    store.beginTurn(ROOM);
    const commit = commitScribe(scheduled, proposal, allowAllScribeOps(proposal));
    expect(commit.status).toBe("committed");
    expect(records(services).map((entry) => entry.record?.turn)).toEqual([1]);

    // Undoing the later turns keeps the late writes: they belong to turn 1.
    store.undoTo(ROOM, 1);
    expect(valueOf(services, "keys")).toBe(1);
    expect(records(services)).toHaveLength(1);
    expect(store.stateGet(ROOM, WHISPERS_KEY)).toEqual([{ kind: "note", text: "late" }]);
  });

  const scripted = reply({ ops: [{ op: "adjust", id: "keys", delta: 1, evidence: "You find the brass key" }], chronicle: "The key was found.", whispers: ["w"], habit: { summary: "s" } });

  test("a commit after an undo is stale and writes nothing", async () => {
    const { services, store } = setup([scripted]);
    store.beginTurn(ROOM);
    const scheduled = contextFor(services, store.beginTurn(ROOM));
    const proposal = await pass(services, readScribeSnapshot(services, ROOM, "en", facts()));
    store.undoTo(ROOM, 1);
    const before = { docs: store.docList(ROOM), state: store.stateList(ROOM) };
    expect(commitScribe(scheduled, proposal, allowAllScribeOps(proposal))).toEqual({ status: "stale" });
    expect(store.docList(ROOM)).toEqual(before.docs);
    expect(store.stateList(ROOM)).toEqual(before.state);
  });

  test("a commit after a reset is stale and writes nothing", async () => {
    const { services, store, types } = setup([scripted]);
    const scheduled = contextFor(services, store.beginTurn(ROOM));
    const proposal = await pass(services, readScribeSnapshot(services, ROOM, "en", facts()));
    store.reset(ROOM, "story", documentCatalog(types));
    const before = { docs: store.docList(ROOM), state: store.stateList(ROOM) };
    expect(commitScribe(scheduled, proposal, allowAllScribeOps(proposal))).toEqual({ status: "stale" });
    expect(store.docList(ROOM)).toEqual(before.docs);
    expect(store.stateList(ROOM)).toEqual(before.state);
  });

  test("a whisper reaches the story-reset scope", () => {
    expect(WHISPERS_KEY.lifecycle).toEqual({ reset: "story" });
  });
});

describe("malformed output", () => {
  test("degrades to a status, never a throw", async () => {
    const { services, store } = setup([
      "I am not JSON at all",
      reply({ ops: "all of them", whispers: [1, null, { text: "x" }], unrolled_check: "yes", habit: 7, chronicle: 12, beat: ["spike"] }),
      reply({ ops: [null, 3, { op: "delete", id: "keys", evidence: "You find the brass key" }, { op: "adjust", id: "keys", delta: "lots", evidence: "You find the brass key" }] }),
      { error: new LLMError({ code: "transient", retryable: true }) },
    ]);
    const writer = store.beginTurn(ROOM);
    const snapshot = readScribeSnapshot(services, ROOM, "en", facts());
    const outcomes: ScribeProposal[] = [];
    for (let index = 0; index < 4; index++) outcomes.push(await pass(services, snapshot));
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["unparsed", "ok", "ok", "model_failed"]);
    for (const outcome of outcomes) {
      expect(outcome.ops).toEqual([]);
      expect(outcome.chronicle).toBeNull();
      expect(outcome.beat).toBeNull();
      const commit = commitScribe(contextFor(services, writer), outcome, allowAllScribeOps(outcome));
      expect(commit.status).toBe("committed");
    }
    expect(outcomes[2]?.dropped.malformed).toBe(4);
    expect(valueOf(services, "keys")).toBe(0);
  });

  test("an empty reply makes no call; an aborted call reports aborted", async () => {
    const { services, store, llm } = setup([]);
    store.beginTurn(ROOM);
    expect((await pass(services, readScribeSnapshot(services, ROOM, "en", facts({ reply: "  " })))).status).toBe("empty_reply");
    expect(llm.calls).toHaveLength(0);
    const controller = new AbortController();
    controller.abort();
    expect((await computeScribe(readScribeSnapshot(services, ROOM, "en", facts()), services, controller.signal)).status).toBe("aborted");
  });

  test("the call is attributed to the scribe lane", async () => {
    const { services, store } = setup(["{}"]);
    store.beginTurn(ROOM);
    let lane: string | undefined;
    const spy = new ScriptedLLM(() => {
      lane = currentLane()?.lane;
      return "{}";
    });
    await computeScribe(readScribeSnapshot(services, ROOM, "en", facts()), { ...services, models: { ...services.models, scribe: spy } });
    expect(lane).toBe(SCRIBE_LANE);
  });
});
