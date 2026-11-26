// The server's entry point. Only `--version` exists so far; serve, cli, doctor, pack,
// install and lint arrive with the layers they drive.
import { SERVER_VERSION } from "../infra/version.ts";

const USAGE = "usage: loreweaver --version";

export function run(argv: readonly string[]): { code: number; out: string } {
  if (argv.length === 1 && argv[0] === "--version") {
    return { code: 0, out: SERVER_VERSION };
  }
  return { code: 2, out: USAGE };
}

if (import.meta.main) {
  const { code, out } = run(process.argv.slice(2));
  (code === 0 ? console.log : console.error)(out);
  process.exit(code);
}
