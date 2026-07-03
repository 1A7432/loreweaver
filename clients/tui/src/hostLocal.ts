// One-click "host locally": detect this machine's environment and bring a loreweaver server up
// from whatever state it's in — locate a checkout, else fetch the server code; ensure `uv`
// (which installs Python + deps for us, so a machine with no Python still works); `uv sync`;
// then run the server on a local WebSocket. EVERY step streams its real terminal output through
// `onLog` so the TUI can show the whole bring-up, and the keeper key it auto-mints is returned
// so the shell can log straight in. Bare-metal — no Docker.

import { existsSync } from "node:fs"
import { dirname, join } from "node:path"

const HOME = process.env.HOME ?? process.env.USERPROFILE ?? "."
const SERVER_DIR = `${HOME}/.loreweaver/server`
const LOCAL_KEYS = `${HOME}/.loreweaver/local-keys.toml`
const LOCAL_SIDECAR = `${HOME}/.loreweaver/keeper-key.txt`
const PORT = 8787
const REPO = "https://github.com/1A7432/loreweaver"
const READY_TIMEOUT_MS = 45_000

export type LogKind = "step" | "out" | "err" | "ok" | "fail"
export type OnLog = (text: string, kind: LogKind) => void
export interface HostHandle {
  host: string
  key: string
  stop(): void
}

// Tools (uv/pip/git) emit ANSI colour codes; the log view renders plain text, so strip them
// (and a trailing CR) or they show up as literal escape gibberish.
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g
function clean(line: string): string {
  return line.replace(ANSI, "").replace(/\r$/, "")
}

function findCheckout(): string | undefined {
  let dir = import.meta.dir
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "app.py"))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

async function pipeLines(stream: ReadableStream<Uint8Array> | null, onLine: (line: string) => void): Promise<void> {
  if (!stream) return
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let nl: number
    while ((nl = buffer.indexOf("\n")) >= 0) {
      onLine(clean(buffer.slice(0, nl)))
      buffer = buffer.slice(nl + 1)
    }
  }
  if (buffer.trim()) onLine(clean(buffer))
}

// Run a command to completion, streaming stdout+stderr through `onLog`. Returns the exit code.
async function run(cmd: string[], cwd: string | undefined, onLog: OnLog): Promise<number> {
  onLog(`$ ${cmd.join(" ")}`, "step")
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: process.env as Record<string, string> })
  await Promise.all([
    pipeLines(proc.stdout, (line) => onLog(line, "out")),
    pipeLines(proc.stderr, (line) => onLog(line, "err")),
  ])
  return await proc.exited
}

async function ensureServerDir(onLog: OnLog): Promise<string> {
  const checkout = findCheckout()
  if (checkout) {
    onLog(`Found a checkout at ${checkout}`, "ok")
    return checkout
  }
  if (existsSync(join(SERVER_DIR, "app.py"))) {
    onLog(`Using the server fetched earlier at ${SERVER_DIR}`, "ok")
    return SERVER_DIR
  }
  onLog("No server on this machine — fetching the code…", "step")
  if (!Bun.which("git")) throw new Error("git is needed to fetch the server, and it isn't installed")
  if ((await run(["git", "clone", "--depth", "1", REPO, SERVER_DIR], undefined, onLog)) !== 0) {
    throw new Error("git clone failed — check your network (GitHub reachable?)")
  }
  return SERVER_DIR
}

async function ensureUv(onLog: OnLog): Promise<void> {
  if (Bun.which("uv")) {
    onLog("uv is already installed", "ok")
    return
  }
  onLog("uv not found — installing it (it manages Python + deps for us)…", "step")
  const installer =
    process.platform === "win32"
      ? ["powershell", "-NoProfile", "-Command", "irm https://astral.sh/uv/install.ps1 | iex"]
      : ["sh", "-c", "curl -LsSf https://astral.sh/uv/install.sh | sh"]
  if ((await run(installer, undefined, onLog)) !== 0) throw new Error("uv install failed — check your network")
  // uv drops its binary in one of these; make it visible to the steps that follow.
  process.env.PATH = `${HOME}/.local/bin:${HOME}/.cargo/bin:${process.env.PATH ?? ""}`
}

async function readSidecarKey(): Promise<string> {
  try {
    return (await Bun.file(LOCAL_SIDECAR).text()).match(/key=([A-Za-z0-9_-]{16,})/)?.[1] ?? ""
  } catch {
    return ""
  }
}

async function waitReady(proc: Bun.Subprocess, onLog: OnLog): Promise<string> {
  const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  let line = ""
  let all = ""
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("the server did not become ready in time")), READY_TIMEOUT_MS),
  )
  const ready = (async (): Promise<string> => {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) throw new Error("the server exited before it was ready")
      const chunk = decoder.decode(value, { stream: true })
      line += chunk
      all += chunk
      let nl: number
      while ((nl = line.indexOf("\n")) >= 0) {
        onLog(clean(line.slice(0, nl)), "out")
        line = line.slice(nl + 1)
      }
      // Locale-independent readiness: the WS URL prints once the listener binds; the keeper key
      // is in the sidecar (written during first-run bootstrap, before the listener starts).
      if (all.includes(`ws://127.0.0.1:${PORT}`)) {
        const key = await readSidecarKey()
        if (key) return key
      }
    }
  })()
  try {
    return await Promise.race([ready, timeout])
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // ignore
    }
  }
}

export async function bringUpServer(onLog: OnLog): Promise<HostHandle> {
  onLog(`OS: ${process.platform} / ${process.arch}`, "step")
  const serverDir = await ensureServerDir(onLog)
  await ensureUv(onLog)

  onLog("Installing Python + dependencies (uv sync) — this can take a minute the first time…", "step")
  if ((await run(["uv", "sync"], serverDir, onLog)) !== 0) throw new Error("uv sync failed")
  onLog("Dependencies ready", "ok")

  onLog("Starting the local server…", "step")
  const proc = Bun.spawn(
    ["uv", "run", "python", "-m", "app", "--serve", "--ws", "--no-iroh", "--host", "127.0.0.1", "--port", String(PORT), "--keys", LOCAL_KEYS],
    { cwd: serverDir, stdout: "pipe", stderr: "pipe", env: process.env as Record<string, string> },
  )
  const stop = () => {
    try {
      proc.kill()
    } catch {
      // already gone
    }
  }
  void pipeLines(proc.stdout, (l) => onLog(l, "out"))
  try {
    const key = await waitReady(proc, onLog)
    onLog(`Server ready at ws://127.0.0.1:${PORT} — logging you in as Keeper`, "ok")
    return { host: `ws://127.0.0.1:${PORT}`, key, stop }
  } catch (error) {
    stop()
    throw error
  }
}
