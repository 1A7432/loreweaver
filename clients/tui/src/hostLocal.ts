// "Host locally": start a 3.0 server on this machine and hand the shell its ticket and an admin
// key, so the person can play at once. Where the server comes from, in order:
//   1. a development checkout: `server/src/cli/main.ts`, found by walking up from this file,
//      run with Bun from the repository root (so the root `.env` configures the model, exactly
//      as `bun server/src/cli/main.ts serve` would);
//   2. a prebuilt binary named by `TRPG_LOCAL_SERVER_BIN`;
//   3. a prebuilt binary at `<local server folder>/server-bin/loreweaver`.
// Nothing is downloaded: there is no published 3.0 server to download yet. When none of these
// exists the bring-up fails and says so.
//
// The server runs `serve --local` (loopback only — the client dials it with a loopback endpoint,
// so this works with no network at all) with its data under the local server folder
// (`TRPG_DATA_DIR`). It prints ONE JSON line on stdout when ready: `{ok, version, ticket, notes,
// first_key?}`. `first_key` — an admin key — appears only on a fresh data directory, so the shell
// keeps it; when the data directory exists and no key was kept, a new admin key is minted with the
// server's own `key` command before it starts.
import { existsSync } from "node:fs"
import { chmod, mkdir } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import type { MessageKey } from "./i18n"
import { resolveLocalServerPaths } from "./localPaths"

const READY_TIMEOUT_MS = 60_000
/** The room the first admin key of a fresh data directory belongs to (the server's FIRST_ROOM). */
export const LOCAL_ROOM = "main"
const ADMIN_NAME = "Admin"

/** One line for the bring-up log: a step in our words (`key`), or a line the server printed (`text`). */
export interface BringUpLine {
  readonly kind: "step" | "out" | "ok" | "fail"
  readonly key?: MessageKey
  readonly vars?: Record<string, string | number>
  readonly text?: string
}
export type OnLog = (line: BringUpLine) => void

/** A failure the screen can say in the person's language. */
export class HostLocalError extends Error {
  readonly key: MessageKey
  readonly vars: Record<string, string | number>

  constructor(key: MessageKey, vars: Record<string, string | number> = {}) {
    super(key)
    this.name = "HostLocalError"
    this.key = key
    this.vars = vars
  }
}

export interface HostHandle {
  ticket: string
  key: string
  /** The key was handed out by this start (the first admin key, or a freshly minted one): keep it. */
  newKey: boolean
  /** Stop the server; resolves once its process has exited. */
  stop(): Promise<void>
}

export interface HostLocalOptions {
  localServerHome?: string
  /** The admin key kept from an earlier start of the server in this folder. */
  knownKey?: string
  env?: Record<string, string | undefined>
  /** Where to start looking for a development checkout (this file's directory by default). */
  searchFrom?: string
}

export type BringUp = (onLog: OnLog, signal: AbortSignal | undefined, options: HostLocalOptions) => Promise<HostHandle>

export interface ServerCommand {
  readonly kind: "checkout" | "binary"
  /** The program and its leading arguments; the subcommand goes after. */
  readonly argv: readonly string[]
  readonly cwd: string
}

/** `server/src/cli/main.ts` of the checkout this client lives in, or undefined. */
export function findCheckoutEntry(start: string = import.meta.dir): string | undefined {
  let dir = start
  for (let i = 0; i < 8; i++) {
    const entry = join(dir, "server", "src", "cli", "main.ts")
    if (existsSync(entry)) return entry
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

function bunExecutable(): string | undefined {
  const own = process.execPath
  if (own && /^bun(\.exe)?$/i.test(basename(own))) return own
  return Bun.which("bun") ?? undefined
}

/** How to run the server here, or undefined when there is none. */
export function resolveServerCommand(home: string | undefined, env: Record<string, string | undefined> = process.env, searchFrom?: string): ServerCommand | undefined {
  const paths = resolveLocalServerPaths(home)
  const entry = findCheckoutEntry(searchFrom)
  const bun = bunExecutable()
  if (entry && bun) return { kind: "checkout", argv: [bun, entry], cwd: dirname(dirname(dirname(dirname(entry)))) }
  const named = env.TRPG_LOCAL_SERVER_BIN?.trim()
  if (named && existsSync(named)) return { kind: "binary", argv: [named], cwd: paths.home }
  if (existsSync(paths.binary)) return { kind: "binary", argv: [paths.binary], cwd: paths.home }
  return undefined
}

/** The start-up notes the server prints as codes, in words. */
const NOTE_KEYS: ReadonlyMap<string, MessageKey> = new Map<string, MessageKey>([
  ["model_not_configured", "hostlocal.note.modelNotConfigured"],
  ["recall_off", "hostlocal.note.recallOff"],
  ["context_window_unknown", "hostlocal.note.contextWindowUnknown"],
])

export type ReadyLine = { ok: true; ticket: string; firstKey?: string; notes: string[] } | { ok: false; code: string }

/** The server's one JSON line, or null when `line` is not it. */
export function parseReadyLine(line: string): ReadyLine | null {
  let value: unknown
  try {
    value = JSON.parse(line.trim())
  } catch {
    return null
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (record.ok === false) return { ok: false, code: typeof record.code === "string" ? record.code : "unknown" }
  if (record.ok !== true || typeof record.ticket !== "string") return null
  const notes = Array.isArray(record.notes) ? record.notes.filter((note): note is string => typeof note === "string") : []
  const first = record.first_key
  const firstKey = typeof first === "object" && first !== null && typeof (first as { key?: unknown }).key === "string" ? (first as { key: string }).key : undefined
  return { ok: true, ticket: record.ticket, notes, ...(firstKey ? { firstKey } : {}) }
}

// The server's report lines may carry terminal colour codes; the log view draws plain text.
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g
function clean(line: string): string {
  return line.replace(ANSI, "").replace(/\r$/, "")
}

async function eachLine(stream: ReadableStream<Uint8Array> | null | undefined, onLine: (line: string) => void): Promise<void> {
  if (!stream) return
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newline: number
      while ((newline = buffer.indexOf("\n")) >= 0) {
        onLine(clean(buffer.slice(0, newline)))
        buffer = buffer.slice(newline + 1)
      }
    }
  } catch {
    // the process went away
  }
  if (buffer.trim()) onLine(clean(buffer))
}

function serverEnv(dataDir: string, env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(env)) if (typeof value === "string") out[name] = value
  out.TRPG_DATA_DIR = dataDir
  return out
}

/** Mint an admin key with the server's own `key` command (the server must not be running). */
async function mintAdminKey(command: ServerCommand, env: Record<string, string>, onLog: OnLog): Promise<string> {
  onLog({ kind: "step", key: "hostlocal.step.mint" })
  const proc = Bun.spawn([...command.argv, "key", LOCAL_ROOM, "admin", ADMIN_NAME], { cwd: command.cwd, env, stdout: "pipe", stderr: "pipe" })
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  for (const line of err.split("\n")) if (line.trim()) onLog({ kind: "out", text: clean(line) })
  try {
    const parsed = JSON.parse(out.trim()) as { ok?: unknown; key?: unknown; code?: unknown }
    if (code === 0 && parsed.ok === true && typeof parsed.key === "string") return parsed.key
    throw new HostLocalError("hostlocal.error.refused", { code: typeof parsed.code === "string" ? parsed.code : String(code) })
  } catch (error) {
    if (error instanceof HostLocalError) throw error
    throw new HostLocalError("hostlocal.error.refused", { code: String(code) })
  }
}

export const bringUpServer: BringUp = async (onLog, signal, options = {}) => {
  const env = options.env ?? process.env
  const paths = resolveLocalServerPaths(options.localServerHome)
  if (signal?.aborted) throw new HostLocalError("hostlocal.error.cancelled")
  const existed = existsSync(paths.home)
  await mkdir(paths.home, { recursive: true, mode: 0o700 })
  if (!existed && process.platform !== "win32") await chmod(paths.home, 0o700).catch(() => undefined)

  const command = resolveServerCommand(options.localServerHome, env, options.searchFrom)
  if (!command) throw new HostLocalError("hostlocal.error.noServer", { path: paths.binary })
  onLog({ kind: "ok", key: command.kind === "checkout" ? "hostlocal.step.checkout" : "hostlocal.step.binary", vars: { path: command.argv.at(-1) ?? "" } })

  const childEnv = serverEnv(paths.dataDir, env)
  const fresh = !existsSync(join(paths.dataDir, "keys.json"))
  let key = options.knownKey
  let newKey = false
  if (!fresh && !key) {
    key = await mintAdminKey(command, childEnv, onLog)
    newKey = true
  }
  if (signal?.aborted) throw new HostLocalError("hostlocal.error.cancelled")

  onLog({ kind: "step", key: "hostlocal.step.starting", vars: { dir: paths.dataDir } })
  const proc = Bun.spawn([...command.argv, "serve", "--local"], { cwd: command.cwd, env: childEnv, stdout: "pipe", stderr: "pipe" })
  const stop = async (): Promise<void> => {
    try {
      proc.kill()
    } catch {
      // already gone
    }
    await proc.exited.catch(() => undefined)
  }
  const onAbort = () => void stop()
  signal?.addEventListener("abort", onAbort, { once: true })
  // Once the server is up its output is still drained (a full pipe would stall it) but no longer shown.
  let live = true
  const show = (line: string) => {
    if (live && line.trim()) onLog({ kind: "out", text: line })
  }
  try {
    const ready = await new Promise<ReadyLine>((resolve, reject) => {
      let refusal: ReadyLine | null = null
      const timer = setTimeout(() => reject(new HostLocalError("hostlocal.error.timeout")), READY_TIMEOUT_MS)
      const settle = (outcome: ReadyLine) => {
        clearTimeout(timer)
        resolve(outcome)
      }
      void eachLine(proc.stdout, (line) => {
        const parsed = parseReadyLine(line)
        if (parsed) settle(parsed)
        else show(line)
      })
      void eachLine(proc.stderr, (line) => {
        const parsed = parseReadyLine(line)
        if (parsed && !parsed.ok) refusal = parsed
        else show(line)
      })
      void proc.exited.then((code) => {
        clearTimeout(timer)
        if (signal?.aborted) reject(new HostLocalError("hostlocal.error.cancelled"))
        else if (refusal) resolve(refusal)
        else reject(new HostLocalError("hostlocal.error.exited", { code }))
      })
    })
    if (!ready.ok) throw new HostLocalError("hostlocal.error.refused", { code: ready.code })
    if (ready.firstKey) {
      key = ready.firstKey
      newKey = true
    }
    if (!key) throw new HostLocalError("hostlocal.error.noKey")
    for (const note of ready.notes) {
      const known = NOTE_KEYS.get(note)
      onLog(known ? { kind: "step", key: known } : { kind: "out", text: note })
    }
    onLog({ kind: "ok", key: "hostlocal.step.ready" })
    live = false
    return { ticket: ready.ticket, key, newKey, stop }
  } catch (error) {
    live = false
    void stop()
    throw error
  } finally {
    signal?.removeEventListener("abort", onAbort)
  }
}
