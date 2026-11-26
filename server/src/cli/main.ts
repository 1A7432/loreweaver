// The server's entry point. `--version` and `selftest` exist so far; serve, cli, doctor,
// pack, install and lint arrive with the layers they drive.
import { roomWorkerEntry } from "../infra/runtime/worker.ts";
import { SERVER_VERSION } from "../infra/version.ts";
import { selftest } from "./selftest.ts";

const USAGE = "usage: loreweaver --version | selftest";

export async function run(argv: readonly string[]): Promise<{ code: number; out: string }> {
  if (argv.length === 1 && argv[0] === "--version") {
    return { code: 0, out: SERVER_VERSION };
  }
  if (argv.length === 1 && argv[0] === "selftest") {
    const report = await selftest(roomWorkerEntry());
    return { code: report.ok ? 0 : 1, out: JSON.stringify(report) };
  }
  return { code: 2, out: USAGE };
}

if (import.meta.main) {
  const { code, out } = await run(process.argv.slice(2));
  (code === 0 ? console.log : console.error)(out);
  process.exit(code);
}
