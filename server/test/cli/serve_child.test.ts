// The server as a child process of a program that hosts it: it stops when the parent's pipe
// ends — however the parent went — and gives its data directory back.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "loreweaver-serve-child-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const MAIN = new URL("../../src/cli/main.ts", import.meta.url).pathname;

test("serve --until-stdin-closes stops when its standard input ends, cleanly", async () => {
  const dataDir = join(root, "data");
  // An empty working directory and a bare environment: nothing of the developer's own settings.
  const proc = Bun.spawn([process.execPath, MAIN, "serve", "--local", "--until-stdin-closes"], {
    cwd: root,
    env: { PATH: process.env.PATH ?? "", TRPG_DATA_DIR: dataDir },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const reader = proc.stdout.getReader();
    let text = "";
    while (!text.includes("\n")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += new TextDecoder().decode(chunk.value);
    }
    expect(JSON.parse(text.split("\n")[0] ?? "null")).toMatchObject({ ok: true, ticket: expect.any(String) });
    expect(existsSync(join(dataDir, "server.lock"))).toBe(true);

    // The parent lets go of the pipe — what the operating system does for it when it dies.
    proc.stdin.end();
    const code = await Promise.race([proc.exited, new Promise<string>((resolve) => setTimeout(() => resolve("still running"), 15_000))]);
    // A clean stop (0), not the "second signal" exit a double report of the pipe's end once caused.
    expect(code).toBe(0);
    expect(existsSync(join(dataDir, "server.lock"))).toBe(false);
  } finally {
    proc.kill();
  }
}, 40_000);
