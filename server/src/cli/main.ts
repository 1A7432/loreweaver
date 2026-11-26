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
import { SERVER_VERSION } from "../infra/version.ts";
import { openServer, type RunningServer, StartupError } from "./compose.ts";
import { importWorldCard, mintKey, ROLES } from "./operator.ts";
import { buildPack, installPack, listPacks, uninstallPack } from "./packs.ts";
import { selftest } from "./selftest.ts";

const USAGE =
  "usage: loreweaver serve [--local] | key <room> <admin|player|observer> <name> | import-world <room> <card-file> | pack <source-dir> [--out <file>] | install <path|https-url|gh:owner/repo[@tag]> [--yes] | packs | uninstall <id> | selftest | --version";

export interface Outcome {
  readonly code: number;
  readonly out: string;
  /** Present when the command left a server running. */
  readonly server?: RunningServer;
}

export type Environment = Readonly<Record<string, string | undefined>>;

function settingsFrom(env: Environment): Settings | Outcome {
  try {
    return loadSettings(env);
  } catch (error) {
    if (error instanceof ConfigError) return { code: 2, out: JSON.stringify({ ok: false, code: "bad_settings", problems: error.problems }) };
    throw error;
  }
}

export async function run(argv: readonly string[], env: Environment = {}): Promise<Outcome> {
  const [command, ...rest] = argv;
  if (argv.length === 1 && command === "--version") return { code: 0, out: SERVER_VERSION };
  if (argv.length === 1 && command === "selftest") {
    const report = await selftest(roomWorkerEntry());
    return { code: report.ok ? 0 : 1, out: JSON.stringify(report) };
  }
  if (command === "serve" && (rest.length === 0 || (rest.length === 1 && rest[0] === "--local"))) {
    const settings = settingsFrom(env);
    if ("code" in settings) return settings;
    try {
      const server = await openServer(settings, { mode: rest.length === 1 ? "local" : "n0", workerEntry: roomWorkerEntry() });
      const ready = { ok: true, version: SERVER_VERSION, ticket: server.ticket, notes: server.notes, ...(server.firstKey === null ? {} : { first_key: server.firstKey }) };
      return { code: 0, out: JSON.stringify(ready), server };
    } catch (error) {
      if (error instanceof StartupError) return { code: 2, out: JSON.stringify({ ok: false, code: error.code }) };
      throw error;
    }
  }
  if (command === "key" && rest.length === 3) {
    const [room, role, name] = rest as [string, string, string];
    const known = ROLES.find((candidate) => candidate === role);
    if (known === undefined) return { code: 2, out: USAGE };
    const settings = settingsFrom(env);
    if ("code" in settings) return settings;
    const minted = mintKey(settings, room, known, name);
    return { code: minted.ok ? 0 : 1, out: JSON.stringify(minted) };
  }
  if (command === "import-world" && rest.length === 2) {
    const [room, file] = rest as [string, string];
    const settings = settingsFrom(env);
    if ("code" in settings) return settings;
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
    if (closing) return;
    closing = true;
    void server.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
