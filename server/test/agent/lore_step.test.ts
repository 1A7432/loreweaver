import { afterEach, describe, expect, test } from "bun:test";

import { readContentWrites } from "../../src/agent/effects.ts";
import {
  buildLoreRequest,
  commitLore,
  type LoreExchangeRequest,
  type LoreStepInput,
  loreTimers,
  loreVariables,
  runLoreStep,
  validateLoreAnswer,
} from "../../src/agent/lore_step.ts";
import { LORE_ENTRY_TYPE, LORE_OVERLAY_ID, LORE_OVERLAY_TYPE, EMPTY_OVERLAY, overlayData, switchLore } from "../../src/core/lore/index.ts";
import { readVariableTree, toJson, VARIABLE_TREE_ID, VARIABLE_TREE_TYPE } from "../../src/core/variables/index.ts";
import { RoomWorker } from "../../src/infra/room_worker.ts";
import { spawnWorker } from "../../src/infra/runtime/worker.ts";
import type { LoreAssemblyRequest } from "../../src/worker/templates/index.ts";
import { WORKER_ENTRY } from "../helpers.ts";
import { addLore, contextFor, putTree, ROOM, setup } from "./room_fixture.ts";

// The request this side builds is the request the worker reads.
const sameShape = (request: LoreExchangeRequest): LoreAssemblyRequest => request;
void sameShape;

const workers: RoomWorker[] = [];
afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
});

function worker(timeoutMs = 3000): RoomWorker {
  const made = new RoomWorker(() => spawnWorker(WORKER_ENTRY), [], { timeoutMs });
  workers.push(made);
  return made;
}

function input(services: ReturnType<typeof setup>["services"], overrides: Partial<LoreStepInput> = {}): LoreStepInput {
  return {
    viewer: "keeper",
    transcript: ["We row toward the lighthouse."],
    advanceTimers: true,
    variables: loreVariables(services, ROOM),
    nowMs: 1_700_000_000_000,
    ...overrides,
  };
}

function lit() {
  const { store, services } = setup();
  const writer = store.beginTurn(ROOM);
  putTree(services, writer, { hp: 10 });
  addLore(services, writer, "beacon", { title: "Beacon", content: "<% setvar('hp', 5) %>The beacon is lit.", constant: true });
  addLore(services, writer, "light", { title: "Lighthouse", content: "An old lighthouse, hp <%= getvar('hp') %>.", keys: ["lighthouse"], cooldown: 2 });
  addLore(services, writer, "truth", { title: "Truth", content: "The keeper drowned his brother.", constant: true, secret: true });
  addLore(services, writer, "far", { title: "Far shore", content: "A shore beyond the fog.", keys: ["zzz"] });
  return { store, services, writer, context: contextFor(services, writer) };
}

describe("the exchange through a real worker", () => {
  test("lore comes back rendered; a template's write and the timers are committed by the caller", async () => {
    const { store, services, context } = lit();
    const outcome = await runLoreStep(context, input(services), { worker: () => worker() });
    expect(outcome.ran).toBe(true);
    expect(outcome.problems).toEqual([]);
    expect(outcome.injected.map((entry) => entry.title)).toEqual(["Beacon", "Lighthouse", "Truth"]);
    expect(outcome.text).toBe("The beacon is lit.\nAn old lighthouse, hp 5.\nThe keeper drowned his brother.");
    expect(outcome.writes).toEqual([{ path: "hp", value: 5, by: "template" }]);
    expect(outcome.timers?.turn).toBe(1);

    const commit = commitLore(context, outcome);
    expect(commit).toMatchObject({ stale: false, timersStored: true, writes: { refused: [] } });
    const tree = toJson(readVariableTree(services.documents.get(ROOM, VARIABLE_TREE_TYPE, VARIABLE_TREE_ID)?.data ?? {}).tree);
    expect(tree).toEqual({ hp: 5 });
    expect(loreTimers(services, ROOM)).toEqual({ turn: 1, entries: [{ id: "light", openedAt: 1, cooldownUntil: 3 }] });
    expect(readContentWrites(store, ROOM, context.turn)).toEqual([{ path: "hp", by: "template" }]);
  });

  test("a player-grade request never returns a secret entry, even as a semantic hit", async () => {
    const { services, context } = lit();
    const outcome = await runLoreStep(context, input(services, { viewer: "player", semanticHits: ["truth"] }), { worker: () => worker() });
    expect(outcome.injected.map((entry) => entry.id)).toEqual(["beacon", "light"]);
    expect(outcome.text).not.toContain("drowned");
    expect(outcome.activatedTitles).not.toContain("Truth");
  });

  test("semantic hits are merged into activation", async () => {
    const { services, context } = lit();
    const without = await runLoreStep(context, input(services, { advanceTimers: false }), { worker: () => worker() });
    expect(without.injected.map((entry) => entry.id)).not.toContain("far");
    const withHits = await runLoreStep(context, input(services, { advanceTimers: false, semanticHits: ["far"] }), { worker: () => worker() });
    expect(withHits.injected.map((entry) => entry.id)).toContain("far");
  });

  test("a retry does not advance the timers, and sees the turn as its first assembly did", async () => {
    const { services, context } = lit();
    const shared = worker();
    const first = await runLoreStep(context, input(services), { worker: () => shared });
    commitLore(context, first);
    const retry = await runLoreStep(context, input(services, { advanceTimers: false }), { worker: () => shared });
    expect(retry.timers).toBeNull();
    expect(retry.text).toBe(first.text);
    expect(retry.injected.map((entry) => entry.id)).toEqual(first.injected.map((entry) => entry.id));
    expect(commitLore(context, retry).timersStored).toBe(false);
    expect(loreTimers(services, ROOM).turn).toBe(1);
  });

  test("a looping template costs one timeout and yields no lore; the next exchange runs on a fresh worker", async () => {
    const { services, writer, context } = lit();
    addLore(services, writer, "loop", { title: "Loop", content: "<% while (true) {} %>", constant: true });
    const shared = worker(400);
    const limits = { perTemplateMs: 5000, perAssemblyMs: 5000 };
    const hung = await runLoreStep(context, input(services, { limits }), { worker: () => shared });
    expect(hung).toMatchObject({ ran: false, text: "", injected: [], timers: null, writes: [], problems: [{ code: "lore_timeout" }] });
    expect(shared.running).toBe(false);
    // The admin switches the entry off in the overlay: the overlay is applied on this path too.
    const switched = switchLore(EMPTY_OVERLAY, "Loop", false);
    if (!switched.ok) throw new Error(switched.code);
    services.documents.put(writer, LORE_OVERLAY_TYPE, LORE_OVERLAY_ID, overlayData(switched.data));
    const next = await runLoreStep(context, input(services, { limits }), { worker: () => shared });
    expect(next.ran).toBe(true);
    expect(next.injected.map((entry) => entry.id)).toEqual(["beacon", "light", "truth"]);
  });

  test("a template that hangs within the template limit costs only its own entry", async () => {
    const { services, writer, context } = lit();
    addLore(services, writer, "loop", { title: "Loop", content: "<% while (true) {} %>", constant: true });
    const outcome = await runLoreStep(context, input(services, { limits: { perTemplateMs: 50, perAssemblyMs: 500 } }), { worker: () => worker(3000) });
    expect(outcome.ran).toBe(true);
    expect(outcome.failures).toContainEqual({ kind: "render", code: "timeout", entryId: "loop" });
    expect(outcome.injected.map((entry) => entry.id)).toEqual(["beacon", "light", "truth"]);
  });
});

describe("without the worker", () => {
  test("a room with no enabled lore never asks for a worker; its timer turn still counts", async () => {
    const { store, services } = setup();
    const writer = store.beginTurn(ROOM);
    addLore(services, writer, "off", { title: "Off", content: "never", constant: true, enabled: false });
    const context = contextFor(services, writer);
    const outcome = await runLoreStep(context, input(services), {
      worker: () => {
        throw new Error("no worker should be started");
      },
    });
    expect(outcome).toEqual({ ran: false, text: "", injected: [], activatedTitles: [], timers: { turn: 1, entries: [] }, writes: [], failures: [], problems: [] });
  });

  test("a failing exchange yields no lore and a problem, never a failed turn", async () => {
    const { services, context } = lit();
    const broken = new RoomWorker(() => spawnWorker(WORKER_ENTRY), ["/no/such/module.ts"], { timeoutMs: 3000 });
    workers.push(broken);
    const outcome = await runLoreStep(context, input(services), { worker: () => broken });
    expect(outcome).toMatchObject({ ran: false, text: "", problems: [{ code: "lore_failed" }] });
  });

  test("the answer is checked as untrusted data", () => {
    const { services, context } = lit();
    const { request } = buildLoreRequest(context, input(services, { viewer: "player" }));
    const forged = {
      injected: [
        { id: "truth", text: "The keeper drowned his brother.", via: "match" },
        { id: "nobody", text: "made up", via: "match" },
        { id: "beacon", text: "ok", via: "teleport" },
        { id: "light", text: "An old lighthouse.", via: "match", placement: "before", depth: -9 },
      ],
      activatedTitles: ["Truth", "Lighthouse"],
      timers: { turn: 7, entries: [] },
      writes: [{ path: "hp", value: 1 }, { path: "", value: 2 }, { path: "x", value: () => 0 }],
      failures: [{ kind: "render", code: "runtime", entryId: "truth", detail: "secret text in an error" }],
    };
    const checked = validateLoreAnswer(forged, request);
    expect(checked.text).toBe("An old lighthouse.");
    expect(checked.injected[0]).toMatchObject({ id: "light", placement: "default", depth: 4 });
    expect(checked.activatedTitles).toEqual(["Lighthouse"]);
    expect(checked.timers).toBeNull();
    expect(checked.writes).toEqual([{ path: "hp", value: 1, by: "template" }]);
    expect(checked.failures).toEqual([{ kind: "render", code: "runtime", entryId: "truth" }]);
    expect(checked.problems.map((problem): string => problem.code).sort()).toEqual(
      ["bad_timers", "injected_dropped", "injected_dropped", "secret_dropped", "write_dropped", "write_dropped"].sort(),
    );
    expect(validateLoreAnswer("not an object", request)).toMatchObject({ ran: false, problems: [{ code: "bad_answer" }] });
  });

  test("a stale writer commits nothing", async () => {
    const { store, services } = lit();
    const writer = store.beginTurn(ROOM);
    const context = contextFor(services, writer);
    const outcome = await runLoreStep(context, input(services), { worker: () => worker() });
    store.undoTo(ROOM, 1);
    expect(commitLore(context, outcome)).toEqual({ stale: true, timersStored: false, writes: { applied: [], refused: [] } });
    expect(services.documents.list(ROOM, LORE_ENTRY_TYPE)).toHaveLength(4);
  });
});
