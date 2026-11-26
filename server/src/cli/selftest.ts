// `loreweaver selftest`: bring the whole line up inside this process and push one turn
// through it — the database on disk, a module loaded from a file into a room worker,
// the real turn engine over a scripted model, and a client dialling in over iroh — then a
// small picture up and back down the byte channel. It exists to prove a BUILT
// server works on the machine it was built for: the worker thread, the runtime loading
// of a module's TypeScript and the native transport are exactly the parts a compiled
// binary can lose.
import { createHash } from "node:crypto";
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
import type { RunKeeperTurn } from "../gateway/keeper.ts";
import { REVIEW_OFF } from "../gateway/review.ts";
import { loadSettings } from "../infra/config.ts";
import { type Clock, systemClock } from "../infra/ids.ts";
import { type LLMClient, ScriptedLLM } from "../infra/llm/index.ts";
import { MediaStore } from "../infra/media/index.ts";
import { openDatabase } from "../infra/runtime/sqlite.ts";
import { spawnWorker } from "../infra/runtime/worker.ts";
import { Store } from "../infra/store.ts";
import { dial, IrohServer } from "../net/iroh.ts";
import { Keystore } from "../net/keystore.ts";
import { composeHub } from "./compose.ts";

/** What the self-test's module injects, as the scripted model looks for it. */
const INJECTION = /selftest module saw turn \d+/u;

/** A small PNG for the byte channel's round trip: the signature and a few bytes are all the store checks. */
const PICTURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array.from({ length: 200 }, (_, i) => (i * 7) % 256)]);

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
  const db = openDatabase(join(dir, "selftest.db"));
  const store = new Store(db);
  const media = new MediaStore(dir, db, { clock: systemClock });
  // The REAL turn engine, composed as `serve` composes it, over a scripted model that
  // answers with the module's injection when it finds it in the prompt: the reply proves
  // the module ran in a worker and that what it injected reached the model.
  const llm = new ScriptedLLM((messages) => {
    for (const message of messages) {
      const found = typeof message.content === "string" ? INJECTION.exec(message.content) : null;
      if (found !== null) return found[0];
    }
    return "no module injection reached the prompt";
  });
  const problems: string[] = [];
  const { hub } = composeHub({
    // The after-turn lanes and the fold would each need answers of their own from the script.
    settings: loadSettings({ TRPG_SCRIBE__ENABLED: "false", TRPG_DIRECTOR__ENABLED: "false", TRPG_CHRONICLE__ENABLED: "false" }),
    store,
    models: { keeper: llm, npc: llm, scribe: llm, director: llm, memory: llm },
    contextWindow: 200_000,
    clock: systemClock,
    report: (_room, text) => {
      problems.push(text);
    },
    spawnWorker: () => spawnWorker(workerEntry),
    modulesFor: () => [modulePath],
    review: REVIEW_OFF,
    media,
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
    // The byte channel: offer on the control stream, the bytes on a stream of their own, the
    // table told, and the same bytes fetched back.
    const sha256 = createHash("sha256").update(PICTURE).digest("hex");
    link.send({ type: "call", rid: "offer", method: "media.offer", params: { name: "selftest.png", mime: "image/png", size: PICTURE.length, sha256 } });
    await until((frame) => frame.type === "result" && frame.rid === "offer");
    const offered = frames.at(-1);
    const uploadId = offered?.type === "result" && offered.ok ? (offered.data as { upload_id?: unknown }).upload_id : undefined;
    if (typeof uploadId === "string") {
      const put = await link.put(uploadId, PICTURE);
      await until((frame) => frame.type === "event" && frame.kind === "media");
      steps.media_uploaded = put.ok && put.file.hash === sha256;
    } else {
      steps.media_uploaded = false;
    }
    const fetched = await link.get(sha256);
    steps.media_fetched = fetched.ok && fetched.bytes.length === PICTURE.length && fetched.bytes.every((byte, at) => byte === PICTURE[at]);
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
