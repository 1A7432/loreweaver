import { join } from "node:path";

import type { ClientFrame, ServerFrame } from "loreweaver-protocol/v3";

import { selftestEnvironment, selftestServices, selftestTurn } from "../src/cli/selftest.ts";
import { CommandRegistry } from "../src/gateway/commands/index.ts";
import { Hub } from "../src/gateway/hub.ts";
import { LANES_OFF } from "../src/gateway/lanes.ts";
import { REVIEW_OFF } from "../src/gateway/review.ts";
import type { Clock } from "../src/infra/ids.ts";
import type { LLMClient } from "../src/infra/llm/index.ts";
import { openDatabase } from "../src/infra/runtime/sqlite.ts";
import { roomWorkerEntry, spawnWorker } from "../src/infra/runtime/worker.ts";
import { Store } from "../src/infra/store.ts";
import { Keystore } from "../src/net/keystore.ts";
import { Session, type SessionDeps } from "../src/net/session.ts";

export const WORKER_ENTRY = roomWorkerEntry();

export function fixtureModule(name: string): string {
  return join(import.meta.dir, "fixtures", "sample_modules", `${name}.ts`);
}

/** Ids `id-1`, `id-2`, … and a clock that advances one millisecond per reading. */
export function testClock(): Clock {
  let ids = 0;
  let now = 1_700_000_000_000;
  return { id: () => `id-${++ids}`, now: () => now++ };
}

export interface Bench {
  readonly hub: Hub;
  readonly store: Store;
  readonly deps: SessionDeps;
  readonly problems: string[];
}

export function bench(options: {
  llm: LLMClient;
  modules?: readonly string[];
  workerTimeoutMs?: number;
  dbPath?: string;
}): Bench {
  const store = new Store(openDatabase(options.dbPath ?? ":memory:"));
  const problems: string[] = [];
  // The self-test's thin turn: these tests are about transport, workers and the log.
  const hub = new Hub({
    services: selftestServices(store, options.llm, testClock(), (_room, text) => {
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
    spawnWorker: () => spawnWorker(WORKER_ENTRY),
    modulesFor: () => options.modules ?? [],
    workerTimeoutMs: options.workerTimeoutMs ?? 2000,
  });
  const keystore = new Keystore();
  keystore.add("player-key", { room: "table", name: "Ada", role: "player" });
  keystore.add("second-key", { room: "table", name: "Bao", role: "player" });
  keystore.add("watch-key", { room: "table", name: "Eve", role: "observer" });
  return { hub, store, problems, deps: { keystore, room: (id) => hub.room(id) } };
}

/** An in-memory connection: what the server sent, in order, and whether it hung up. */
export class Wire {
  readonly sent: ServerFrame[] = [];
  closed = false;
  readonly session: Session;
  #waiters: { want: (frame: ServerFrame) => boolean; resolve: (frame: ServerFrame) => void }[] = [];

  constructor(deps: SessionDeps) {
    this.session = new Session(deps, {
      send: (frame) => {
        this.sent.push(frame);
        this.#waiters = this.#waiters.filter((waiter) => {
          if (!waiter.want(frame)) return true;
          waiter.resolve(frame);
          return false;
        });
      },
      close: () => {
        this.closed = true;
      },
    });
  }

  receive(frame: ClientFrame | Record<string, unknown>): void {
    this.session.receive(frame);
  }

  hello(key: string, extra: Record<string, unknown> = {}): void {
    this.receive({ type: "hello", protocol: "3.0", key, locale: "en", client: { name: "test", version: "0" }, caps: [], ...extra });
  }

  /** The first frame, already sent or still to come, that `want` accepts. */
  until(want: (frame: ServerFrame) => boolean): Promise<ServerFrame> {
    const found = this.sent.find(want);
    if (found) return Promise.resolve(found);
    return new Promise((resolve) => this.#waiters.push({ want, resolve }));
  }

  kinds(): string[] {
    return this.sent.map((frame) =>
      frame.type === "event" || frame.type === "signal" ? `${frame.type}:${frame.kind}` : frame.type,
    );
  }
}

export function isIdle(frame: ServerFrame): boolean {
  return frame.type === "signal" && frame.kind === "turn" && frame.data.status === "idle";
}
