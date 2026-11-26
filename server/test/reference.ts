// The reference vectors (`test/fixtures/reference/`): examples of what the validated
// Python implementation did, exported once. Each file's row schema is in that
// directory's README. A test reads a file by its base name; whether it is stored
// compressed is this helper's business.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(import.meta.dir, "fixtures", "reference");

/** Every row of `<name>.jsonl` or `<name>.jsonl.gz`, parsed. */
export function readReference<Row = Record<string, unknown>>(name: string): Row[] {
  const plain = join(DIR, `${name}.jsonl`);
  const text = existsSync(plain)
    ? readFileSync(plain, "utf8")
    : new TextDecoder().decode(Bun.gunzipSync(readFileSync(`${plain}.gz`)));
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Row);
}
