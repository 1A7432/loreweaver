import { expect, test } from "bun:test";

import manifest from "../package.json" with { type: "json" };
import { run } from "../src/cli/main.ts";
import { SERVER_VERSION } from "../src/infra/version.ts";

test("the version constant is the package version", () => {
  expect(SERVER_VERSION).toBe(manifest.version);
});

test("--version prints it and anything else is a usage error", async () => {
  expect(await run(["--version"])).toEqual({ code: 0, out: SERVER_VERSION });
  expect((await run([])).code).toBe(2);
});

test("--help anywhere on the line prints the usage and does nothing else", async () => {
  // `install --help` once went looking for a pack named `--help`.
  for (const argv of [["--help"], ["-h"], ["install", "--help"], ["uninstall", "-h"], ["key", "main", "--help"], ["serve", "--help"]]) {
    const outcome = await run(argv, {});
    expect([argv.join(" "), outcome.code, outcome.out.startsWith("usage: loreweaver "), outcome.server]).toEqual([argv.join(" "), 0, true, undefined]);
  }
});
