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
  const spawnFn = (cmd: string[], _options: { terminal: any }): SpawnedProc => {
    capturedArgv = cmd
    resolveCalled()
    return { exited: new Promise<number>(() => {}), kill() {} }
  }
  const terminalFactory = () => ({ write() {}, resize() {}, close() {} })
  return { spawnFn, terminalFactory, calledPromise, argv: () => capturedArgv }
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
})
