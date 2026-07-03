// One-click "host locally & play": spawn a loreweaver server on this machine (local WebSocket,
// no relay), wait until it is listening, and hand back the ws:// address + the keeper key it
// auto-mints — so the connect screen can log the host straight in as Keeper.
//
// This shells out to the PYTHON server (`python -m app`), so it only works where that package
// is importable (a full checkout / install, not a bare client). Override the command with
// TRPG_SERVER_CMD (e.g. "uv run python -m app"). A local WS listener is instant and needs no
// domain/TLS/relay; sharing the table with remote friends is the separate `--serve` (Iroh) path.

import { existsSync } from "node:fs"
import { dirname, join } from "node:path"

// Where to run the server from: walk up from this file (a checkout has app.py at the repo
// root, a few levels above clients/tui/src) so `python -m app` resolves. Falls back to the
// current directory for an installed package on PATH.
function findRepoRoot(): string | undefined {
  let dir = import.meta.dir
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "app.py"))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

function serverCwd(): string {
  return findRepoRoot() ?? process.cwd()
}

// Whether "host locally" is even possible here: a bare client install (install.sh pulls only
// the Bun client — no Python, no `app.py`) can't spawn a server, so the connect screen hides
// the button entirely rather than offering one that can only fail. A checkout has app.py.
export function canHostLocally(): boolean {
  return findRepoRoot() !== undefined
}

// Prefer a checkout's virtualenv interpreter (it has the deps); fall back to a `python` on PATH
// (an installed package). Override the whole command with TRPG_SERVER_CMD.
function defaultServerCmd(cwd: string): string[] {
  const venv = join(cwd, ".venv", "bin", "python")
  return [existsSync(venv) ? venv : "python", "-m", "app"]
}

const HOME = process.env.HOME ?? "."
const LOCAL_KEYS = `${HOME}/.loreweaver/local-keys.toml`
const LOCAL_SIDECAR = `${HOME}/.loreweaver/keeper-key.txt` // written next to LOCAL_KEYS on first-run bootstrap
const PORT = 8787
const READY_TIMEOUT_MS = 25_000

export interface LocalServer {
  host: string
  key: string
  name: string
  stop(): void
}

export async function startLocalServer(): Promise<LocalServer> {
  const cwd = serverCwd()
  const cmd = process.env.TRPG_SERVER_CMD
    ? process.env.TRPG_SERVER_CMD.trim().split(/\s+/)
    : defaultServerCmd(cwd)
  let proc: Bun.Subprocess
  try {
    proc = Bun.spawn(
      [...cmd, "--serve", "--ws", "--no-iroh", "--host", "127.0.0.1", "--port", String(PORT), "--keys", LOCAL_KEYS],
      { cwd, stderr: "pipe", stdout: "ignore", env: process.env as Record<string, string> },
    )
  } catch {
    throw new Error("could not launch the server — is python + the loreweaver package installed? (set TRPG_SERVER_CMD)")
  }
  const stop = () => {
    try {
      proc.kill()
    } catch {
      // already gone
    }
  }
  try {
    const key = await waitForReady(proc)
    return { host: `ws://127.0.0.1:${PORT}`, key, name: "Keeper", stop }
  } catch (error) {
    stop()
    throw error
  }
}

async function waitForReady(proc: Bun.Subprocess): Promise<string> {
  const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("the local server did not become ready in time")), READY_TIMEOUT_MS),
  )

  const untilReady = (async (): Promise<string> => {
    while (true) {
      const { value, done } = await reader.read()
      if (done) {
        throw new Error(
          "the server exited before it was ready — is python + the loreweaver package on PATH? (set TRPG_SERVER_CMD to override)",
        )
      }
      buffer += decoder.decode(value, { stream: true })
      // Locale-independent readiness: the WS URL is printed once the listener binds. The keeper
      // key comes from the sidecar file (language-agnostic), written during first-run bootstrap
      // before the listener starts — so by the time we see the URL it is present.
      if (buffer.includes(`ws://127.0.0.1:${PORT}`)) {
        const key = await readSidecarKey()
        if (key) return key
      }
    }
  })()

  try {
    return await Promise.race([untilReady, timeout])
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // ignore
    }
  }
}

async function readSidecarKey(): Promise<string> {
  try {
    const text = await Bun.file(LOCAL_SIDECAR).text()
    return text.match(/key=([A-Za-z0-9_-]{16,})/)?.[1] ?? ""
  } catch {
    return ""
  }
}
