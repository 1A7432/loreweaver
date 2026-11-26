import { expect, test } from "bun:test";

import { ScriptedLLM } from "../../src/infra/llm/index.ts";
import { bench, fixtureModule } from "../helpers.ts";

const request = {
  entries: [],
  viewer: "keeper",
  transcript: [],
  timers: { turn: 0, entries: [] },
  advanceTimers: true,
  variables: { flat: {}, tree: {} },
  seed: "s",
  nowMs: 0,
};

test("a room without modules gets a worker only when its lore asks, and keeps the one it got", async () => {
  const { hub } = bench({ llm: new ScriptedLLM([]) });
  hub.room("table");
  const worker = hub.workerForLore("table");
  expect(worker.running).toBe(false);
  expect(hub.workerForLore("table")).toBe(worker);
  const answer = (await worker.assembleLore(request)) as { text: string; timers: { turn: number } };
  expect(answer).toMatchObject({ text: "", timers: { turn: 1 } });
  expect(worker.running).toBe(true);
  expect(await hub.evictIdle(-1)).toEqual(["table"]);
  await hub.close();
});

test("a room with modules shares its one worker with the lore exchange", async () => {
  const { hub } = bench({ llm: new ScriptedLLM([]), modules: [fixtureModule("counter")] });
  const early = hub.workerForLore("table");
  hub.room("table");
  expect(hub.workerForLore("table")).toBe(early);
  await hub.close();
});
