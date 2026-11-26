// `loreweaver selftest`: bring the whole line up inside this process and push one turn
// through it — the database on disk, a module loaded from a file into a room worker,
// a scripted model, and a client dialling in over iroh. It exists to prove a BUILT
// server works on the machine it was built for: the worker thread, the runtime loading
// of a module's TypeScript and the native transport are exactly the parts a compiled
// binary can lose.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ServerFrame } from "loreweaver-protocol/v3";

import { Hub } from "../gateway/hub.ts";
import { systemClock } from "../infra/ids.ts";
import { ScriptedLLM } from "../infra/llm.ts";
import { openDatabase } from "../infra/runtime/sqlite.ts";
import { spawnWorker } from "../infra/runtime/worker.ts";
import { Store } from "../infra/store.ts";
import { dial, IrohServer } from "../net/iroh.ts";
import { Keystore } from "../net/keystore.ts";

const MODULE_SOURCE = `
import { defineModule } from "loreweaver/module";
let turns: number = 0;
export default defineModule({
  id: "selftest",
  create() { turns = 0; },
  load(snapshot) { turns = (snapshot as { turns: number }).turns; },
  save() { return { turns }; },
  on: { turnStart(event, fx) { turns += 1; fx.inject("selftest module saw turn " + turns); } },
});
`;

export interface SelftestReport {
  readonly ok: boolean;
  readonly steps: Record<string, boolean>;
  readonly ms: number;
  readonly error?: string;
}

export async function selftest(workerEntry: string): Promise<SelftestReport> {
  const started = performance.now();
  const steps: Record<string, boolean> = {};
  const dir = mkdtempSync(join(tmpdir(), "loreweaver-selftest-"));
  const modulePath = join(dir, "module.ts");
  writeFileSync(modulePath, MODULE_SOURCE);
  const store = new Store(openDatabase(join(dir, "selftest.db")));
  const llm = new ScriptedLLM(["The self-test turn ran."]);
  const problems: string[] = [];
  const hub = new Hub({
    store,
    clock: systemClock,
    llm,
    systemPrompt: "selftest",
    spawnWorker: () => spawnWorker(workerEntry),
    modulesFor: () => [modulePath],
    workerTimeoutMs: 5000,
    onProblem: (_room, text) => {
      problems.push(text);
    },
  });
  const keystore = new Keystore();
  keystore.add("selftest-key", { room: "selftest", name: "Tester", role: "player" });
  const server = new IrohServer({ keystore, room: (id) => hub.room(id), roomLocale: "en" }, { mode: "local" });
  try {
    const ticket = await server.start();
    steps.transport_bound = true;
    const link = await dial(ticket, { mode: "local" });
    const frames: ServerFrame[] = [];
    const until = async (want: (frame: ServerFrame) => boolean): Promise<void> => {
      for (;;) {
        const frame = await link.next();
        frames.push(frame);
        if (want(frame)) return;
      }
    };
    link.send({ type: "hello", protocol: "3.0", key: "selftest-key", locale: "en", client: { name: "selftest", version: "0" }, caps: [] });
    await until((frame) => frame.type === "welcome");
    steps.welcomed = true;
    link.send({ type: "input", rid: "1", text: "ping" });
    await until((frame) => frame.type === "event" && frame.kind === "narrative" && frame.data.speaker === "kp");
    steps.turn_answered = true;
    steps.module_loaded_and_injected = llm.calls[0]?.[0]?.content === "selftest\n\nselftest module saw turn 1";
    steps.module_state_stored = JSON.stringify(store.moduleStates("selftest").get("selftest")) === '{"turns":1}';
    steps.log_stored = store.room("selftest").head === 2;
    steps.no_problems = problems.length === 0;
    await link.close();
    const ok = Object.values(steps).every(Boolean);
    const report = { ok, steps, ms: Math.round(performance.now() - started) };
    return problems.length > 0 ? { ...report, error: problems.join("; ") } : report;
  } catch (error) {
    return { ok: false, steps, ms: Math.round(performance.now() - started), error: error instanceof Error ? error.message : String(error) };
  } finally {
    await server.close();
    await hub.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
