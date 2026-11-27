// The server's entry point.
//
//   loreweaver serve [--local]                    run the server; prints the ticket to dial
//   loreweaver key <room> <role> <name>           hand out an access key (admin | player | observer)
//   loreweaver import-world <room> <card-file>    bring a SillyTavern card into a room as its world
//   loreweaver pack <source-dir> [--out <file>]   build a source tree into a .lwpack
//   loreweaver install <path|https-url|gh:owner/repo[@tag]> [--yes]
//                                                 show a pack's trust card; with --yes, install it
//   loreweaver packs                              list the installed packs
//   loreweaver uninstall <id>                     remove an installed pack
//   loreweaver selftest                           prove this build can run a turn end to end
//   loreweaver --version
//
// Output is one JSON object per command, so a script can read it; `serve` prints one when
// it is ready and then runs until interrupted. Installed packs are loaded when the server
// starts. `doctor` and `lint` arrive with the layers they drive.
import { ConfigError, loadSettings, type Settings } from "../infra/config.ts";
import { roomWorkerEntry } from "../infra/runtime/worker.ts";
import { runningServer } from "../infra/data_lock.ts";
import { SERVER_VERSION } from "../infra/version.ts";
import { openServer, type RunningServer, StartupError } from "./compose.ts";
import { importWorldCard, mintKey, ROLES } from "./operator.ts";
import { buildPack, installPack, listPacks, uninstallPack } from "./packs.ts";
import { selftest } from "./selftest.ts";

const USAGE =
  "usage: loreweaver serve [--local] [--until-stdin-closes] | key <room> <admin|player|observer> <name> | import-world <room> <card-file> | pack <source-dir> [--out <file>] | install <path|https-url|gh:owner/repo[@tag]> [--yes] | packs | uninstall <id> | selftest | --version";

export interface Outcome {
  readonly code: number;
  readonly out: string;
  /** Present when the command left a server running. */
  readonly server?: RunningServer;
  /** `serve --until-stdin-closes`: stop the server when standard input ends. */
  readonly untilStdinCloses?: true;
}

/**
 * `--until-stdin-closes`: for a program that HOSTS this server as a child. The parent keeps
 * the child's standard input open as a pipe; when the parent goes away — by any means, a
 * crash included — the pipe ends and the server stops as on SIGTERM. Without it a server
 * outlives a parent that was killed, holding its data directory.
 */
const STDIN_FLAG = "--until-stdin-closes";
const SERVE_FLAGS: readonly string[] = ["--local", STDIN_FLAG];

export type Environment = Readonly<Record<string, string | undefined>>;

function settingsFrom(env: Environment): Settings | Outcome {
  try {
    return loadSettings(env);
  } catch (error) {
    if (error instanceof ConfigError) return { code: 2, out: JSON.stringify({ ok: false, code: "bad_settings", problems: error.problems }) };
    throw error;
  }
}

/**
 * `key` and `import-world` write the key file and the database directly: with a server
 * running over the same directory they would write behind its back (it holds both in
 * memory). They are refused while one runs — a room's admin does the same from a client.
 */
function heldBy(settings: Settings): Outcome | null {
  const pid = runningServer(settings.dataDir);
  return pid === null ? null : { code: 1, out: JSON.stringify({ ok: false, code: "server_running", pid }) };
}

export async function run(argv: readonly string[], env: Environment = {}): Promise<Outcome> {
  const [command, ...rest] = argv;
  if (argv.length === 1 && command === "--version") return { code: 0, out: SERVER_VERSION };
  // Asked for anywhere on the line: `install --help` must not go looking for a pack named `--help`.
  if (argv.includes("--help") || argv.includes("-h")) return { code: 0, out: USAGE };
  if (argv.length === 1 && command === "selftest") {
    const report = await selftest(roomWorkerEntry());
    return { code: report.ok ? 0 : 1, out: JSON.stringify(report) };
  }
  if (command === "serve" && rest.every((flag) => SERVE_FLAGS.includes(flag)) && new Set(rest).size === rest.length) {
    const settings = settingsFrom(env);
    if ("code" in settings) return settings;
    try {
      const server = await openServer(settings, { mode: rest.includes("--local") ? "local" : "n0", workerEntry: roomWorkerEntry() });
      const ready = { ok: true, version: SERVER_VERSION, ticket: server.ticket, notes: server.notes, ...(server.firstKey === null ? {} : { first_key: server.firstKey }) };
      return { code: 0, out: JSON.stringify(ready), server, ...(rest.includes(STDIN_FLAG) ? { untilStdinCloses: true } : {}) };
    } catch (error) {
      if (error instanceof StartupError) return { code: 2, out: JSON.stringify({ ok: false, code: error.code }) };
      // Anything else that stops a server from starting (the address cannot be bound, the
      // database cannot be opened) is answered in the same shape, not as a stack trace: a
      // program that hosts this server reads one JSON object either way.
      return { code: 1, out: JSON.stringify({ ok: false, code: "startup_failed", detail: error instanceof Error ? error.message : String(error) }) };
    }
  }
  if (command === "key" && rest.length === 3) {
    const [room, role, name] = rest as [string, string, string];
    const known = ROLES.find((candidate) => candidate === role);
    if (known === undefined) return { code: 2, out: USAGE };
    const settings = settingsFrom(env);
    if ("code" in settings) return settings;
    const busy = heldBy(settings);
    if (busy !== null) return busy;
    const minted = mintKey(settings, room, known, name);
    return { code: minted.ok ? 0 : 1, out: JSON.stringify(minted) };
  }
  if (command === "import-world" && rest.length === 2) {
    const [room, file] = rest as [string, string];
    const settings = settingsFrom(env);
    if ("code" in settings) return settings;
    const busy = heldBy(settings);
    if (busy !== null) return busy;
    const imported = await importWorldCard(settings, room, file);
    return { code: imported.ok ? 0 : 1, out: JSON.stringify(imported) };
  }
  if (command === "pack" && (rest.length === 1 || (rest.length === 3 && rest[1] === "--out"))) {
    const built = await buildPack(rest[0] as string, rest.length === 3 ? { out: rest[2] as string } : {});
    return { code: built.ok ? 0 : 1, out: JSON.stringify(built) };
  }
  if (command === "install" && (rest.length === 1 || (rest.length === 2 && rest[1] === "--yes"))) {
    const settings = settingsFrom(env);
    if ("code" in settings) return settings;
    const installed = await installPack(settings.dataDir, rest[0] as string, { yes: rest.length === 2, fetch: (url, init) => fetch(url, init) });
    return { code: installed.ok ? 0 : 1, out: JSON.stringify(installed) };
  }
  if (command === "packs" && rest.length === 0) {
    const settings = settingsFrom(env);
    if ("code" in settings) return settings;
    const listed = listPacks(settings.dataDir);
    return { code: listed.ok ? 0 : 1, out: JSON.stringify(listed) };
  }
  if (command === "uninstall" && rest.length === 1) {
    const settings = settingsFrom(env);
    if ("code" in settings) return settings;
    const removed = uninstallPack(settings.dataDir, rest[0] as string);
    return { code: removed.ok ? 0 : 1, out: JSON.stringify(removed) };
  }
  return { code: 2, out: USAGE };
}

if (import.meta.main) {
  // The one place the process's own environment is read; everything below takes values.
  const outcome = await run(process.argv.slice(2), process.env);
  (outcome.code === 0 ? console.log : console.error)(outcome.out);
  const server = outcome.server;
  if (server === undefined) process.exit(outcome.code);
  let closing = false;
  const stop = (): void => {
    // A second signal while closing: the person means it. A close that hangs (a worker that
    // will not end, a peer that will not let go) must not make the process unkillable by Ctrl-C.
    if (closing) process.exit(130);
    closing = true;
    void server.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  if (outcome.untilStdinCloses === true) {
    // One stop however the pipe's end is reported (`end`, then `close`): a second call to
    // `stop` means "a second signal" and would cut the close short.
    const parentGone = (): void => {
      if (!closing) stop();
    };
    process.stdin.on("end", parentGone);
    process.stdin.on("close", parentGone);
    process.stdin.on("error", parentGone);
    process.stdin.resume();
  }
}
