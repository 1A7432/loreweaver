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

import type { Services } from "../agent/context.ts";
import { dispatchTurnStart } from "../agent/modules.ts";
import { servicesOn } from "../agent/services.ts";
import type { TurnEnvironment } from "../agent/turn/types.ts";
import { DEFAULT_FOLD_SETTINGS } from "../core/chronicle/index.ts";
import { builtInPacks, RulePackRegistry } from "../core/rulepacks/index.ts";
import { builtInSkillRegistry, builtInSkills } from "../core/skills/index.ts";
import { CommandRegistry } from "../gateway/commands/index.ts";
import { Hub } from "../gateway/hub.ts";
import type { RunKeeperTurn } from "../gateway/keeper.ts";
import { LANES_OFF } from "../gateway/lanes.ts";
import { REVIEW_OFF } from "../gateway/review.ts";
import { type Clock, systemClock } from "../infra/ids.ts";
import { type LLMClient, ScriptedLLM } from "../infra/llm/index.ts";
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

/** The services of a server on one store whose every model lane is `llm`. */
export function selftestServices(store: Store, llm: LLMClient, clock: Clock, report: (room: string, text: string) => void): Services {
  return servicesOn({ store, packs: new RulePackRegistry(builtInPacks()), models: { keeper: llm, npc: llm, scribe: llm, director: llm, memory: llm }, clock, report });
}

/** A Keeper turn's environment with the built-in skills and the default settings. */
export function selftestEnvironment(): TurnEnvironment {
  return {
    skills: builtInSkillRegistry(),
    settings: { maxRounds: 12, contextWindow: 200_000, foldEnabled: false, fold: DEFAULT_FOLD_SETTINGS },
  };
}

/**
 * A stand-in for the Keeper turn that calls no model: it tells the modules a turn started
 * and publishes what they injected as the reply. The self-test proves the transport, the
 * worker and the store of a built binary, not the Keeper (and iron rule 5 keeps the
 * Keeper's model calls in the engine alone).
 */
export function selftestTurn(): RunKeeperTurn {
  return async (context, input, ports) => {
    const started = await dispatchTurnStart(ports.moduleWorker(), {
      turn: context.turn,
      seed: `${context.room}:${context.turn}:turnStart`,
      text: input.text,
      who: context.who,
      variables: {},
      clock: null,
    });
    const reply = started.injections.length > 0 ? started.injections.join("\n") : `[${input.speaker}] ${input.text}`;
    const replyId = context.services.clock.id();
    ports.signal("draft", { id: replyId, text: reply });
    ports.publish("narrative", replyId, { speaker: "kp", text: reply, format: "markdown" });
    return {
      status: "replied",
      reply,
      replyId,
      usage: { inputTokens: 0, outputTokens: 0 },
      usageEstimated: true,
      toolsCalled: [],
      contentWrites: new Set(),
      keeperRecordedChronicle: false,
      narrateNowRequested: false,
      problems: started.problems,
    };
  };
}

export interface SelftestReport {
  readonly ok: boolean;
  readonly steps: Record<string, boolean>;
  readonly ms: number;
  readonly error?: string;
}

export async function selftest(workerEntry: string): Promise<SelftestReport> {
  const started = performance.now();
  const steps: Record<string, boolean> = {};
  // The built-in rule packs are text embedded at build time; compiling them here is what
  // shows a binary still carries them.
  try {
    steps.rule_packs_embedded = builtInPacks().length >= 3;
  } catch {
    steps.rule_packs_embedded = false;
  }
  // The built-in skills are `.md` text embedded the same way; parsing them proves the text
  // loader kept them (a bundler that dropped the attribute would hand over something else).
  try {
    steps.skills_embedded = builtInSkills().every((skill) => skill.body.length > 0) && builtInSkills().length === 3;
  } catch {
    steps.skills_embedded = false;
  }
  const dir = mkdtempSync(join(tmpdir(), "loreweaver-selftest-"));
  const modulePath = join(dir, "module.ts");
  writeFileSync(modulePath, MODULE_SOURCE);
  const store = new Store(openDatabase(join(dir, "selftest.db")));
  // No lane calls a model in the self-test; a scripted client stands behind every lane.
  const llm = new ScriptedLLM([]);
  const problems: string[] = [];
  const hub = new Hub({
    services: selftestServices(store, llm, systemClock, (_room, text) => {
      problems.push(text);
    }),
    env: selftestEnvironment(),
    commands: (modules) => new CommandRegistry({ modules }),
    runTurn: selftestTurn(),
    recordPlayerAction: () => ({ ok: true }),
    defaultLocale: "en",
    review: REVIEW_OFF,
    lanes: LANES_OFF,
    kitFor: () => null,
    spawnWorker: () => spawnWorker(workerEntry),
    modulesFor: () => [modulePath],
    workerTimeoutMs: 5000,
  });
  const keystore = new Keystore();
  keystore.add("selftest-key", { room: "selftest", name: "Tester", role: "player" });
  const server = new IrohServer({ keystore, room: (id) => hub.room(id) }, { mode: "local" });
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
    const reply = frames.find((frame) => frame.type === "event" && frame.kind === "narrative" && frame.data.speaker === "kp");
    steps.module_loaded_and_injected = reply?.type === "event" && reply.kind === "narrative" && reply.data.text === "selftest module saw turn 1";
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
