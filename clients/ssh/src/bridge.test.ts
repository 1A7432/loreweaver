import { describe, expect, test } from "bun:test"
import { bridgeSession, type SpawnedProc, type TerminalInit, type TerminalLike } from "./bridge"
import type { AuthorizedKey } from "./keys"

// ---- fakes ---------------------------------------------------------------

class FakeChannel {
  writes: Buffer[] = []
  ended = false
  exitCode: number | null = null
  private listeners: Record<string, ((...args: any[]) => void)[]> = {}
  write(data: string | Uint8Array) {
    this.writes.push(Buffer.from(data as any))
  }
  end() {
    this.ended = true
  }
  exit(status: number) {
    this.exitCode = status
  }
  on(event: string, listener: (...args: any[]) => void) {
    ;(this.listeners[event] ??= []).push(listener)
  }
  emit(event: string, ...args: any[]) {
    for (const fn of this.listeners[event] ?? []) fn(...args)
  }
  get writtenText() {
    return Buffer.concat(this.writes).toString()
  }
}

class FakeTerminal implements TerminalLike {
  writes: Uint8Array[] = []
  resizes: Array<[number, number]> = []
  closed = false
  cols: number
  rows: number
  private dataCb: (t: TerminalLike, bytes: Uint8Array) => void
  constructor(init: TerminalInit) {
    this.cols = init.cols
    this.rows = init.rows
    this.dataCb = init.data
  }
  write(data: string | Uint8Array) {
    this.writes.push(typeof data === "string" ? new TextEncoder().encode(data) : data)
  }
  resize(cols: number, rows: number) {
    this.resizes.push([cols, rows])
  }
  close() {
    this.closed = true
  }
  /** Simulate PTY output flowing back to the ssh channel. */
  emitData(bytes: Uint8Array) {
    this.dataCb(this, bytes)
  }
  get writtenText() {
    return this.writes.map((b) => Buffer.from(b).toString()).join("")
  }
}

const entry: AuthorizedKey = {
  room: "blackmoor",
  wsKey: "WS-KEY-123",
  name: "Nora",
  fingerprint: "SHA256:test",
  parsed: {},
  blob: Buffer.alloc(0),
}

function makeSpawn() {
  let resolveExit!: (code: number) => void
  const proc: SpawnedProc & { killed: boolean } = {
    exited: new Promise<number>((r) => (resolveExit = r)),
    killed: false,
    kill() {
      this.killed = true
    },
  }
  const captured: { argv: string[] | null; terminal: any } = { argv: null, terminal: null }
  const spawnFn = (cmd: string[], options: { terminal: any }) => {
    captured.argv = cmd
    captured.terminal = options.terminal
    return proc
  }
  return { spawnFn, proc, captured, exit: (code = 0) => resolveExit(code) }
}

function makeTerminalFactory() {
  const holder: { term: FakeTerminal | null } = { term: null }
  const terminalFactory = (init: TerminalInit) => {
    const t = new FakeTerminal(init)
    holder.term = t
    return t
  }
  return { terminalFactory, holder }
}

// ---- tests ---------------------------------------------------------------

describe("bridgeSession", () => {
  test(
    "spawns the client with the exact argv contract",
    () => {
      const channel = new FakeChannel()
      const { spawnFn, captured } = makeSpawn()
      const { terminalFactory } = makeTerminalFactory()

      const handle = bridgeSession(
        channel as any,
        { cols: 100, rows: 40, term: "xterm-256color" },
        entry,
        { wsUrl: "ws://127.0.0.1:8787/", clientEntry: "/abs/clients/tui/src/index.tsx", bunPath: "bun" },
        spawnFn,
        terminalFactory,
      )

      const expected = [
        "bun",
        "run",
        "/abs/clients/tui/src/index.tsx",
        "connect",
        "--host",
        "ws://127.0.0.1:8787/",
        "--key",
        "WS-KEY-123",
        "--name",
        "Nora",
      ]
      expect(handle.argv).toEqual(expected)
      expect(captured.argv).toEqual(expected)
    },
    5000,
  )

  test(
    "channel data -> term.write",
    () => {
      const channel = new FakeChannel()
      const { spawnFn } = makeSpawn()
      const { terminalFactory, holder } = makeTerminalFactory()
      bridgeSession(channel as any, { cols: 80, rows: 24 }, entry, { wsUrl: "ws://x/", clientEntry: "/c" }, spawnFn, terminalFactory)

      channel.emit("data", Buffer.from("ping\r\n"))
      expect(holder.term!.writtenText).toBe("ping\r\n")
    },
    5000,
  )

  test(
    "term data bytes -> channel.write",
    () => {
      const channel = new FakeChannel()
      const { spawnFn } = makeSpawn()
      const { terminalFactory, holder } = makeTerminalFactory()
      bridgeSession(channel as any, { cols: 80, rows: 24 }, entry, { wsUrl: "ws://x/", clientEntry: "/c" }, spawnFn, terminalFactory)

      holder.term!.emitData(new TextEncoder().encode("frame\x1b[0m"))
      expect(channel.writtenText).toBe("frame\x1b[0m")
    },
    5000,
  )

  test(
    "window-change -> term.resize",
    () => {
      const channel = new FakeChannel()
      const { spawnFn } = makeSpawn()
      const { terminalFactory, holder } = makeTerminalFactory()
      bridgeSession(channel as any, { cols: 80, rows: 24 }, entry, { wsUrl: "ws://x/", clientEntry: "/c" }, spawnFn, terminalFactory)

      channel.emit("window-change", { cols: 120, rows: 50 })
      expect(holder.term!.resizes).toContainEqual([120, 50])
    },
    5000,
  )

  test(
    "proc exit -> channel.exit + channel.end + term.close",
    async () => {
      const channel = new FakeChannel()
      const { spawnFn, exit } = makeSpawn()
      const { terminalFactory, holder } = makeTerminalFactory()
      bridgeSession(channel as any, { cols: 80, rows: 24 }, entry, { wsUrl: "ws://x/", clientEntry: "/c" }, spawnFn, terminalFactory)

      expect(channel.ended).toBe(false)
      exit(0)
      // let the exited promise `.then` run
      await Promise.resolve()
      await Promise.resolve()
      expect(channel.ended).toBe(true)
      expect(channel.exitCode).toBe(0)
      expect(holder.term!.closed).toBe(true)
    },
    5000,
  )

  test(
    "channel close -> proc.kill + term.close",
    () => {
      const channel = new FakeChannel()
      const { spawnFn, proc } = makeSpawn()
      const { terminalFactory, holder } = makeTerminalFactory()
      bridgeSession(channel as any, { cols: 80, rows: 24 }, entry, { wsUrl: "ws://x/", clientEntry: "/c" }, spawnFn, terminalFactory)

      channel.emit("close")
      expect((proc as any).killed).toBe(true)
      expect(holder.term!.closed).toBe(true)
    },
    5000,
  )
})
