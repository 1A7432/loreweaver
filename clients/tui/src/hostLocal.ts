// One-click "host locally": detect this machine's environment and bring a loreweaver server up
// from whatever state it's in — locate a checkout, else fetch the server code; ensure `uv`
// (which installs Python + deps for us, so a machine with no Python still works); `uv sync`;
// then run the server on a local WebSocket. EVERY step streams its real terminal output through
// `onLog` so the TUI can show the whole bring-up, and the keeper key it auto-mints is returned
// so the shell can log straight in. Bare-metal — no Docker.

import { existsSync } from "node:fs"
import { delimiter, dirname, join } from "node:path"

const HOME = process.env.HOME ?? process.env.USERPROFILE ?? "."
const SERVER_DIR = `${HOME}/.loreweaver/server`
const LOCAL_KEYS = `${HOME}/.loreweaver/local-keys.toml`
const LOCAL_SIDECAR = `${HOME}/.loreweaver/keeper-key.txt`
const REPO = "https://github.com/1A7432/loreweaver"
const READY_TIMEOUT_MS = 60_000 // Iroh waits for a relay handshake, so allow longer than a local socket
const TICKET_RE = /(endpoint[a-z0-9]{20,})/ // the base32 ticket, printed once the endpoint is online (locale-independent)

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
// If `signal` aborts (the user backed out), the child is killed so a long `uv sync`/clone doesn't
// keep running after they've left the screen.
async function run(cmd: string[], cwd: string | undefined, onLog: OnLog, signal?: AbortSignal): Promise<number> {
  onLog(`$ ${cmd.join(" ")}`, "step")
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: process.env as Record<string, string> })
  const onAbort = () => {
    try {
      proc.kill()
    } catch {
      // already gone
    }
  }
  signal?.addEventListener("abort", onAbort, { once: true })
  try {
    await Promise.all([
      pipeLines(proc.stdout, (line) => onLog(line, "out")),
      pipeLines(proc.stderr, (line) => onLog(line, "err")),
    ])
    return await proc.exited
  } finally {
    signal?.removeEventListener("abort", onAbort)
  }
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

async function ensureUv(onLog: OnLog, signal?: AbortSignal): Promise<void> {
  if (Bun.which("uv")) {
    onLog("uv is already installed", "ok")
    return
  }
  onLog("uv not found — installing it (it manages Python + deps for us)…", "step")
  const installer =
    process.platform === "win32"
      ? ["powershell", "-NoProfile", "-Command", "irm https://astral.sh/uv/install.ps1 | iex"]
      : ["sh", "-c", "curl -LsSf https://astral.sh/uv/install.sh | sh"]
  if ((await run(installer, undefined, onLog, signal)) !== 0) throw new Error("uv install failed — check your network")
  // uv drops its binary in one of these; prepend both to PATH so the steps that follow can find it.
  // `delimiter` is `;` on Windows, `:` elsewhere — a hardcoded `:` would break the Windows lookup.
  const uvDirs = [join(HOME, ".local", "bin"), join(HOME, ".cargo", "bin")]
  process.env.PATH = [...uvDirs, process.env.PATH ?? ""].join(delimiter)
}

async function readSidecarKey(): Promise<string> {
  try {
    return (await Bun.file(LOCAL_SIDECAR).text()).match(/key=([A-Za-z0-9_-]{16,})/)?.[1] ?? ""
  } catch {
    return ""
  }
}

async function waitReady(
  proc: Bun.Subprocess,
  onLog: OnLog,
  signal?: AbortSignal,
): Promise<{ ticket: string; key: string }> {
  const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  let line = ""
  let all = ""
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("the server did not become ready in time")), READY_TIMEOUT_MS),
  )
  // Losing the race to an abort lets the caller tear the half-started server down promptly.
  const aborted = new Promise<never>((_, reject) => {
    if (signal?.aborted) reject(new Error("cancelled"))
    else signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })
  })
  const ready = (async (): Promise<{ ticket: string; key: string }> => {
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
      // Readiness = the Iroh ticket is printed (once the endpoint has a relay). Both are
      // locale-independent: the ticket is base32, the keeper key comes from the sidecar file.
      const match = all.match(TICKET_RE)
      if (match) {
        const key = await readSidecarKey()
        if (key) return { ticket: match[1], key }
      }
    }
  })()
  try {
    return await Promise.race([ready, timeout, aborted])
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // ignore
    }
  }
}

export async function bringUpServer(onLog: OnLog, signal?: AbortSignal): Promise<HostHandle> {
  const bailIfAborted = () => {
    if (signal?.aborted) throw new Error("cancelled")
  }
  bailIfAborted()
  onLog(`OS: ${process.platform} / ${process.arch}`, "step")
  const serverDir = await ensureServerDir(onLog)
  bailIfAborted()
  await ensureUv(onLog, signal)
  bailIfAborted()

  onLog("Installing Python + dependencies (uv sync) — this can take a minute the first time…", "step")
  if ((await run(["uv", "sync"], serverDir, onLog, signal)) !== 0) throw new Error("uv sync failed")
  bailIfAborted()
  onLog("Dependencies ready", "ok")

  onLog("Starting the local p2p server (Iroh) — waiting for a relay, ~10s…", "step")
  const proc = Bun.spawn(
    ["uv", "run", "python", "-m", "app", "--serve", "--keys", LOCAL_KEYS],
    { cwd: serverDir, stdout: "pipe", stderr: "pipe", env: process.env as Record<string, string> },
  )
  const stop = () => {
    try {
      proc.kill()
    } catch {
      // already gone
    }
  }
  // If the user backs out while we're still waiting for the relay, kill the server we just spawned.
  signal?.addEventListener("abort", stop, { once: true })
  void pipeLines(proc.stdout, (l) => onLog(l, "out"))
  try {
    const { ticket, key } = await waitReady(proc, onLog, signal)
    onLog("Server ready — dialing you in as Keeper over p2p", "ok")
    return { host: ticket, key, stop }
  } catch (error) {
    stop()
    throw error
  } finally {
    signal?.removeEventListener("abort", stop)
  }
}
