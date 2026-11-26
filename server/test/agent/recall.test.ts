import { afterEach, expect, test } from "bun:test";

import { loreVariables, runLoreStep } from "../../src/agent/lore_step.ts";
import {
  forgetItems,
  indexChronicleRecords,
  indexLoreEntries,
  recall,
  recallStorages,
  retrievalText,
  type RecallDeps,
} from "../../src/agent/recall.ts";
import { type Embeddings, HashEmbeddings, RecallError, VectorIndex } from "../../src/infra/recall/index.ts";
import { RoomWorker } from "../../src/infra/room_worker.ts";
import { openDatabase } from "../../src/infra/runtime/sqlite.ts";
import { spawnWorker } from "../../src/infra/runtime/worker.ts";
import { WORKER_ENTRY } from "../helpers.ts";
import { addLore, contextFor, ROOM, setup } from "./room_fixture.ts";

const workers: RoomWorker[] = [];
afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
});

function deps(embeddings: Embeddings = new HashEmbeddings()): RecallDeps {
  return { embeddings, index: new VectorIndex(embeddings.dimensions, openDatabase(":memory:")) };
}

const failing: Embeddings = {
  dimensions: 64,
  embed: () => Promise.reject(new RecallError("provider", { status: 503 })),
};

function room() {
  const { store, services } = setup();
  const writer = store.beginTurn(ROOM);
  return { store, services, writer, context: contextFor(services, writer) };
}

test("recall finds lore and chronicle hits, each in its own collection", async () => {
  const { context } = room();
  const d = deps();
  await indexLoreEntries(d, context, [
    { id: "harbour", title: "Harbour", content: "fishing boats and nets at the harbour" },
    { id: "crypt", title: "Crypt", content: "bones under the chapel" },
  ]);
  await indexChronicleRecords(d, context, [{ id: "c000001", text: "the party reached the harbour at dawn" }]);
  const hits = await recall(d, ROOM, "boats in the harbour", { limit: 1 });
  expect(hits).toEqual({ lore: ["harbour"], chronicle: ["c000001"], problems: [] });
  // Another room sees nothing.
  expect(await recall(d, "other-room", "boats in the harbour")).toEqual({ lore: [], chronicle: [], problems: [] });
  forgetItems(d, ROOM, "lore", ["harbour"]);
  expect((await recall(d, ROOM, "boats in the harbour")).lore).not.toContain("harbour");
});

test("a failed recall degrades to lexical lore with a reported problem", async () => {
  const { services, writer, context } = room();
  addLore(services, writer, "far", { title: "Far shore", content: "A shore beyond the fog.", keys: ["fog"] });
  const hits = await recall(deps(failing), ROOM, "the fog rolls in");
  expect(hits).toEqual({ lore: [], chronicle: [], problems: [{ code: "recall_failed", detail: "provider" }] });
  const worker = new RoomWorker(() => spawnWorker(WORKER_ENTRY), [], { timeoutMs: 3000 });
  workers.push(worker);
  const outcome = await runLoreStep(
    context,
    { viewer: "keeper", transcript: ["the fog rolls in"], advanceTimers: true, variables: loreVariables(services, ROOM), nowMs: 0, semanticHits: hits.lore },
    { worker: () => worker },
  );
  expect(outcome.injected.map((entry) => entry.id)).toEqual(["far"]);
});

test("an index write whose room moved on in the meantime stores nothing", async () => {
  const { store, services } = room();
  const d = deps();
  const context = contextFor(services, store.beginTurn(ROOM));
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const slow: Embeddings = { dimensions: 64, embed: async (texts) => (await gate, new HashEmbeddings().embed(texts)) };
  const pending = indexLoreEntries({ embeddings: slow, index: d.index }, context, [{ id: "x", title: "X", content: "late" }]);
  store.undoTo(ROOM, 1);
  release();
  expect(await pending).toEqual({ indexed: 0, problems: [{ code: "stale_writer" }] });
  expect(d.index.count(ROOM)).toBe(0);
  expect((await indexLoreEntries(d, context, [{ id: "y", title: "Y", content: "z" }])).problems).toEqual([{ code: "stale_writer" }]);
  const failed = await indexLoreEntries({ embeddings: failing, index: d.index }, contextFor(services, store.writer(ROOM)), [{ id: "y", title: "Y", content: "z" }]);
  expect(failed).toEqual({ indexed: 0, problems: [{ code: "index_failed", detail: "provider" }] });
});

test("the two storages clear their own kind at their own scope", async () => {
  const { context } = room();
  const d = deps();
  await indexLoreEntries(d, context, [{ id: "a", title: "A", content: "alpha" }]);
  await indexChronicleRecords(d, context, [{ id: "c000001", text: "alpha happened" }]);
  const [lore, chronicle] = recallStorages(d.index);
  expect([lore?.lifecycle, chronicle?.lifecycle]).toEqual([{ reset: "all" }, { reset: "story" }]);
  chronicle?.clear(ROOM, { kind: "reset", scope: "story", epoch: 2 });
  expect(await recall(d, ROOM, "alpha")).toMatchObject({ lore: ["a"], chronicle: [] });
  lore?.clear(ROOM, { kind: "reset", scope: "all", epoch: 3 });
  expect(d.index.count(ROOM)).toBe(0);
});

test("the retrieval text is the newest end of the transcript", () => {
  expect(retrievalText(["first", "second"], 8)).toBe("t\nsecond");
  expect(retrievalText(["灯塔在雾里"], 2)).toBe("雾里");
});
