// Per-session bridge: spawn the existing OpenTUI client inside a Bun.Terminal
// (native PTY) and shuttle bytes between the ssh2 channel and the PTY.
//
//   ssh channel  --data-->        term.write   (client stdin / keystrokes)
//   term.data callback --> channel.write        (client stdout / TUI frames)
//   ssh window-change  -->  term.resize
//   client process exit -->  channel.exit/end + term.close
//   ssh channel close  -->  proc.kill + term.close
//
// `spawnFn` and `terminalFactory` are injectable so tests never spawn a real
// client process or allocate a real PTY.
import type { AuthorizedKey } from "./keys"

/** Minimal PTY surface we use from Bun.Terminal. */
export interface TerminalLike {
  write(data: string | Uint8Array): void
  resize(cols: number, rows: number): void
  close(): void
}

export interface TerminalInit {
  cols: number
  rows: number
  data: (term: TerminalLike, bytes: Uint8Array) => void
}

export type TerminalFactory = (init: TerminalInit) => TerminalLike

/** Minimal subprocess surface we use from Bun.spawn. */
export interface SpawnedProc {
  exited: Promise<number>
  kill(signal?: number | string): void
}

export type SpawnFn = (cmd: string[], options: { terminal: any }) => SpawnedProc

export interface PtyInfo {
  cols: number
  rows: number
  term?: string
}

export interface BridgeOpts {
  wsUrl: string
  /** Absolute path to clients/tui/src/index.tsx. */
  clientEntry: string
  /** Override the `bun` executable (defaults to "bun"). */
  bunPath?: string
}

/** Anything the bridge needs to emit/write/close — satisfied by an ssh2
 * ServerChannel and by the fake channel in tests. */
export interface ChannelLike {
  write(data: string | Uint8Array): void
  end(): void
  exit?(status: number): void
  on(event: string, listener: (...args: any[]) => void): void
}

export interface BridgeHandle {
  argv: string[]
  term: TerminalLike
  proc: SpawnedProc
  resize(cols: number, rows: number): void
  close(): void
}

const defaultTerminalFactory: TerminalFactory = (init) =>
  new (Bun as any).Terminal(init) as TerminalLike

const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24

export function bridgeSession(
  channel: ChannelLike,
  ptyInfo: PtyInfo,
  entry: AuthorizedKey,
  opts: BridgeOpts,
  spawnFn: SpawnFn = Bun.spawn as unknown as SpawnFn,
  terminalFactory: TerminalFactory = defaultTerminalFactory,
): BridgeHandle {
  const bunPath = opts.bunPath ?? "bun"
  const argv = [
    bunPath,
    "run",
    opts.clientEntry,
    "connect",
    "--host",
    opts.wsUrl,
    "--key",
    entry.wsKey,
    "--name",
    entry.name,
  ]

  const term = terminalFactory({
    cols: ptyInfo.cols || DEFAULT_COLS,
    rows: ptyInfo.rows || DEFAULT_ROWS,
    // PTY output -> ssh channel. Copy: Bun may recycle the callback's buffer.
    data: (_t, bytes) => {
      channel.write(Buffer.from(bytes))
    },
  })

  const proc = spawnFn(argv, { terminal: term })

  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    try {
      term.close()
    } catch {
      // ignore
    }
  }

  const resize = (cols: number, rows: number) => {
    if (closed) return
    try {
      term.resize(cols || DEFAULT_COLS, rows || DEFAULT_ROWS)
    } catch {
      // ignore
    }
  }

  // ssh keystrokes -> PTY input.
  channel.on("data", (data: Uint8Array) => {
    if (!closed) term.write(data)
  })

  // Terminal resize (forwarded onto the channel by the server).
  channel.on("window-change", (info: { cols: number; rows: number }) => {
    resize(info?.cols, info?.rows)
  })

  // Client exited -> tell the ssh peer and tear down the PTY.
  proc.exited.then((code) => {
    try {
      channel.exit?.(typeof code === "number" ? code : 0)
    } catch {
      // ignore
    }
    try {
      channel.end()
    } catch {
      // ignore
    }
    close()
  })

  // ssh peer hung up -> kill the client and tear down the PTY.
  channel.on("close", () => {
    try {
      proc.kill()
    } catch {
      // ignore
    }
    close()
  })

  return { argv, term, proc, resize, close }
}
