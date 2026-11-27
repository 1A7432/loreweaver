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

/** Start `serve` as a host would and wait for its ready line. */
async function hosted(dataDir: string, flags: readonly string[] = ["--until-stdin-closes"]) {
  const proc = Bun.spawn([process.execPath, MAIN, "serve", "--local", ...flags], {
    cwd: root,
    env: { PATH: process.env.PATH ?? "", TRPG_DATA_DIR: dataDir },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = proc.stdout.getReader();
  let text = "";
  while (!text.includes("\n")) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += new TextDecoder().decode(chunk.value);
  }
  expect(JSON.parse(text.split("\n")[0] ?? "null")).toMatchObject({ ok: true });
  return proc;
}

function ended(proc: { exited: Promise<number> }): Promise<number | string> {
  return Promise.race([proc.exited, new Promise<string>((resolve) => setTimeout(() => resolve("still running"), 15_000))]);
}

// POSIX signals: on Windows a console's closing is reported another way.
test.skipIf(process.platform === "win32")("a terminal that goes away stops the server cleanly: a hang-up alone, and one that follows the host's own stop", async () => {
  // The terminal window is closed under a server run by hand.
  const alone = join(root, "hangup");
  const first = await hosted(alone, []);
  try {
    first.kill("SIGHUP");
    expect(await ended(first)).toBe(0);
    expect(existsSync(join(alone, "server.lock"))).toBe(false);
  } finally {
    first.kill("SIGKILL");
  }
  // A terminal client that hosts the server quits: its pipe ends, then its terminal closes. The
  // hang-up must not cut the stop short (it once ended the process at once, lock left behind).
  const after = join(root, "hangup-after");
  const second = await hosted(after);
  try {
    second.stdin.end();
    second.kill("SIGHUP");
    second.kill("SIGHUP");
    expect(await ended(second)).toBe(0);
    expect(existsSync(join(after, "server.lock"))).toBe(false);
  } finally {
    second.kill("SIGKILL");
  }
}, 60_000);

test.skipIf(process.platform === "win32")("a host that stops the server the moment it is ready still gets a clean stop", async () => {
  const dataDir = join(root, "at-once");
  const proc = await hosted(dataDir);
  try {
    proc.kill("SIGTERM");
    expect(await ended(proc)).toBe(0);
    expect(existsSync(join(dataDir, "server.lock"))).toBe(false);
  } finally {
    proc.kill("SIGKILL");
  }
}, 40_000);
