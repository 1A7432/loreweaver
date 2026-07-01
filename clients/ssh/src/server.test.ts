import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import ssh2 from "ssh2"
import { startSshServer } from "./server"
import type { SpawnedProc } from "./bridge"

const { Client, utils } = ssh2

const tmp = mkdtempSync(join(tmpdir(), "trpg-ssh-server-"))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

const hostKey = utils.generateKeyPairSync("ed25519").private
const authorized = utils.generateKeyPairSync("ed25519")
const stranger = utils.generateKeyPairSync("ed25519")

function writeKeysToml(): string {
  const path = join(tmp, "ssh_keys.toml")
  writeFileSync(
    path,
    [
      "[[user]]",
      `pubkey = ${JSON.stringify(authorized.public.trim())}`,
      'room   = "blackmoor"',
      'ws_key = "WS-KEY-abc"',
      'name   = "Nora"',
      "",
    ].join("\n"),
    "utf8",
  )
  return path
}

// A terminal factory / spawnFn that never touch a real PTY or process.
function makeMocks() {
  let resolveCalled!: () => void
  const calledPromise = new Promise<void>((r) => (resolveCalled = r))
  let capturedArgv: string[] | null = null
  let spawnCount = 0
  const spawnFn = (cmd: string[], _options: { terminal: any }): SpawnedProc => {
    capturedArgv = cmd
    spawnCount += 1
    resolveCalled()
    // A never-resolving `exited` keeps the (mock) session "active" for cap tests.
    return { exited: new Promise<number>(() => {}), kill() {} }
  }
  const terminalFactory = () => ({ write() {}, resize() {}, close() {} })
  return {
    spawnFn,
    terminalFactory,
    calledPromise,
    argv: () => capturedArgv,
    spawnCount: () => spawnCount,
  }
}

function openShell(conn: any): Promise<any> {
  return new Promise((resolve, reject) => {
    conn.shell({ cols: 80, rows: 24, term: "xterm-256color" } as any, (err: any, stream: any) => {
      if (err) return reject(err)
      stream.on("error", () => {})
      resolve(stream)
    })
  })
}

// Open a shell and resolve with the FIRST teardown event. Listeners are attached
// synchronously in the shell callback because a refused session emits its
// one-shot `exit` immediately — attaching after an `await` gap would miss it.
function openShellExpectingTeardown(conn: any): Promise<string> {
  return new Promise((resolve, reject) => {
    conn.shell({ cols: 80, rows: 24, term: "xterm-256color" } as any, (err: any, stream: any) => {
      if (err) return reject(err)
      stream.on("error", () => {})
      stream.on("exit", () => resolve("exit"))
      stream.on("close", () => resolve("close"))
      stream.on("end", () => resolve("end"))
    })
  })
}

function connectReady(conn: any, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    conn.on("ready", () => resolve())
    conn.on("error", reject)
    conn.connect({
      host: "127.0.0.1",
      port,
      username: "player",
      privateKey: authorized.private,
      readyTimeout: 5000,
    })
  })
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timeout: ${label}`)), ms)),
  ])
}

describe("startSshServer", () => {
  test(
    "authorized key opens a shell and spawns the client with the right argv",
    async () => {
      const mocks = makeMocks()
      const server = await startSshServer({
        port: 0,
        host: "127.0.0.1",
        wsUrl: "ws://127.0.0.1:8787/",
        clientEntry: "/abs/clients/tui/src/index.tsx",
        bunPath: "bun",
        sshKeysPath: writeKeysToml(),
        hostKey,
        spawnFn: mocks.spawnFn,
        terminalFactory: mocks.terminalFactory as any,
      })

      const conn = new Client()
      try {
        await withTimeout(
          new Promise<void>((resolve, reject) => {
            conn.on("ready", () => {
              conn.shell({ cols: 120, rows: 40, term: "xterm-256color" } as any, (err: any, stream: any) => {
                if (err) return reject(err)
                stream.on("error", () => {})
                resolve()
              })
            })
            conn.on("error", reject)
            conn.connect({
              host: "127.0.0.1",
              port: server.port,
              username: "player",
              privateKey: authorized.private,
              readyTimeout: 5000,
            })
          }),
          10000,
          "authorized shell",
        )

        await withTimeout(mocks.calledPromise, 8000, "spawnFn call")
        expect(mocks.argv()).toEqual([
          "bun",
          "run",
          "/abs/clients/tui/src/index.tsx",
          "connect",
          "--host",
          "ws://127.0.0.1:8787/",
          "--key",
          "WS-KEY-abc",
          "--name",
          "Nora",
        ])
      } finally {
        conn.end()
        await server.close()
      }
    },
    20000,
  )

  test(
    "unauthorized key fails authentication",
    async () => {
      const mocks = makeMocks()
      const server = await startSshServer({
        port: 0,
        host: "127.0.0.1",
        clientEntry: "/abs/clients/tui/src/index.tsx",
        sshKeysPath: writeKeysToml(),
        hostKey,
        spawnFn: mocks.spawnFn,
        terminalFactory: mocks.terminalFactory as any,
      })

      const conn = new Client()
      try {
        const result = await withTimeout(
          new Promise<string>((resolve) => {
            conn.on("ready", () => resolve("ready"))
            conn.on("error", (e: any) => resolve(`error:${e?.level ?? e?.message ?? "err"}`))
            conn.on("close", () => resolve("close"))
            conn.on("end", () => resolve("end"))
            conn.connect({
              host: "127.0.0.1",
              port: server.port,
              username: "player",
              privateKey: stranger.private,
              readyTimeout: 2000,
            })
          }),
          6000,
          "unauthorized auth",
        ).catch(() => "no-event")
        expect(result).not.toBe("ready")
        expect(mocks.argv()).toBeNull()
      } finally {
        conn.end()
        ;(conn as any).destroy?.()
        await server.close()
      }
    },
    20000,
  )

  test(
    "a second concurrent session on one connection is refused (session cap)",
    async () => {
      const mocks = makeMocks()
      const server = await startSshServer({
        port: 0,
        host: "127.0.0.1",
        wsUrl: "ws://127.0.0.1:8787/",
        clientEntry: "/abs/clients/tui/src/index.tsx",
        bunPath: "bun",
        sshKeysPath: writeKeysToml(),
        hostKey,
        spawnFn: mocks.spawnFn,
        terminalFactory: mocks.terminalFactory as any,
        maxSessionsPerConnection: 1,
      })

      const conn = new Client()
      try {
        await withTimeout(connectReady(conn, server.port), 10000, "authorized ready")

        // First session: authorized + under the cap, so it spawns the client.
        const stream1 = await openShell(conn)
        await withTimeout(mocks.calledPromise, 8000, "first spawn")
        expect(mocks.spawnCount()).toBe(1)
        expect(stream1).toBeDefined()

        // Second concurrent session on the SAME connection: over the cap, so the
        // server refuses it (exit status + channel end) and spawns nothing more.
        const how = await withTimeout(openShellExpectingTeardown(conn), 8000, "second session refused")
        expect(["exit", "close", "end"]).toContain(how)
        // The invariant that proves the refusal: no second client was spawned.
        expect(mocks.spawnCount()).toBe(1)
      } finally {
        conn.end()
        ;(conn as any).destroy?.()
        await server.close()
      }
    },
    20000,
  )

  test(
    "an idle connection with no activity is dropped after the idle timeout",
    async () => {
      const mocks = makeMocks()
      const server = await startSshServer({
        port: 0,
        host: "127.0.0.1",
        wsUrl: "ws://127.0.0.1:8787/",
        clientEntry: "/abs/clients/tui/src/index.tsx",
        bunPath: "bun",
        sshKeysPath: writeKeysToml(),
        hostKey,
        spawnFn: mocks.spawnFn,
        terminalFactory: mocks.terminalFactory as any,
        idleTimeoutMs: 300,
      })

      const conn = new Client()
      try {
        // Resolve when the connection is torn down by any means (a forced drop
        // may surface as end/close or as an ECONNRESET-style error first).
        const dropped = new Promise<string>((resolve) => {
          conn.on("close", () => resolve("close"))
          conn.on("end", () => resolve("end"))
          conn.on("error", () => resolve("error"))
        })
        await withTimeout(connectReady(conn, server.port), 10000, "authorized ready")
        // Send no traffic: the server's idle timer should fire and drop us.
        const how = await withTimeout(dropped, 5000, "idle drop")
        expect(["close", "end", "error"]).toContain(how)
      } finally {
        conn.end()
        ;(conn as any).destroy?.()
        await server.close()
      }
    },
    20000,
  )
})
