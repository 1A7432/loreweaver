// One-click "host locally": detect this machine's environment and bring a loreweaver server up
// from whatever state it's in — locate a checkout, else fetch the server code (a source tarball
// by default, so a FRESH machine with no git works; git clone is only a fallback); ensure `uv`
// (which installs Python + deps for us, so a machine with no Python still works — its installer
// is fetched with Bun's own fetch(), so no curl is needed either); `uv sync`; then run the
// server. EVERY step streams its real terminal output through `onLog` so the TUI can show the
// whole bring-up, and the keeper key it auto-mints is returned so the shell can log straight in.
// The only assumed tools are the OS's own: `tar` (bundled on Windows 10+, macOS, and every
// mainstream Linux) and, on POSIX, `sh`.

import { existsSync } from "node:fs"
import { mkdir, rename, rm } from "node:fs/promises"
import { delimiter, dirname, join } from "node:path"

const HOME = process.env.HOME ?? process.env.USERPROFILE ?? "."
const SERVER_DIR = `${HOME}/.loreweaver/server`
const LOCAL_KEYS = `${HOME}/.loreweaver/local-keys.toml`
const LOCAL_SIDECAR = `${HOME}/.loreweaver/keeper-key.txt`
const REPO = "https://github.com/1A7432/loreweaver"
const TARBALL = `${REPO}/archive/refs/heads/main.tar.gz`
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

// Fetch the server source WITHOUT git: download the branch tarball and unpack it with the
// system `tar`. Extraction goes to a staging dir that is atomically renamed into place, so a
// half-finished download can never masquerade as a working server dir on the next run.
async function fetchServerSource(onLog: OnLog, signal?: AbortSignal): Promise<string> {
  onLog("Downloading the server source (a few MB — no git needed)…", "step")
  const response = await fetch(TARBALL, { signal })
  if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`)
  const tarball = join(HOME, ".loreweaver", "server-src.tar.gz")
  const staging = `${SERVER_DIR}.staging`
  await mkdir(dirname(tarball), { recursive: true })
  await Bun.write(tarball, response)
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
  // --strip-components=1 drops the `loreweaver-main/` wrapper folder GitHub puts in the tarball.
  if ((await run(["tar", "-xzf", tarball, "-C", staging, "--strip-components=1"], undefined, onLog, signal)) !== 0) {
    throw new Error("extracting the server source failed")
  }
  await rm(tarball, { force: true })
  await rm(SERVER_DIR, { recursive: true, force: true })
  await rename(staging, SERVER_DIR)
  return SERVER_DIR
}

async function ensureServerDir(onLog: OnLog, signal?: AbortSignal): Promise<string> {
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
  // Tarball FIRST: it works on a fresh machine with no git, and macOS's git shim would pop a
  // GUI "install developer tools?" dialog mid-bring-up. git is only the fallback for networks
  // where the tarball endpoint is blocked but git happens to get through.
  try {
    return await fetchServerSource(onLog, signal)
  } catch (error) {
    if (signal?.aborted) throw error instanceof Error ? error : new Error("cancelled")
    const detail = error instanceof Error ? error.message : String(error)
    onLog(`Tarball download didn't work (${detail}) — trying git…`, "err")
    if (!Bun.which("git")) {
      throw new Error("could not download the server source (and git isn't installed as a fallback) — check your network and retry")
    }
    if ((await run(["git", "clone", "--depth", "1", REPO, SERVER_DIR], undefined, onLog, signal)) !== 0) {
      throw new Error("git clone failed — check your network (GitHub reachable?)")
    }
    return SERVER_DIR
  }
}

async function ensureUv(onLog: OnLog, signal?: AbortSignal): Promise<void> {
  if (Bun.which("uv")) {
    onLog("uv is already installed", "ok")
    return
  }
  onLog("uv not found — installing it (it manages Python + deps for us)…", "step")
  if (process.platform === "win32") {
    const installer = ["powershell", "-NoProfile", "-Command", "irm https://astral.sh/uv/install.ps1 | iex"]
    if ((await run(installer, undefined, onLog, signal)) !== 0) throw new Error("uv install failed — check your network")
  } else {
    // Fetch the installer with Bun's own fetch() and run it with sh — fresh Linux images often
    // ship without curl, and this path must work on a factory-fresh machine.
    const response = await fetch("https://astral.sh/uv/install.sh", { signal })
    if (!response.ok) throw new Error(`uv installer download failed: HTTP ${response.status}`)
    const script = join(HOME, ".loreweaver", "uv-install.sh")
    await mkdir(dirname(script), { recursive: true })
    await Bun.write(script, response)
    const code = await run(["sh", script], undefined, onLog, signal)
    await rm(script, { force: true })
    if (code !== 0) throw new Error("uv install failed — check your network")
  }
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
  const serverDir = await ensureServerDir(onLog, signal)
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
