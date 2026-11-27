import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { bringUpServer, findCheckoutEntry, HostLocalError, parseReadyLine, resolveServerCommand, siblingServer, type BringUpLine, type HostHandle } from "./hostLocal"

const dirs: string[] = []
const handles: HostHandle[] = []
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.stop()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "loreweaver-host-"))
  dirs.push(dir)
  return dir
}

// A stand-in for `server/src/cli/main.ts`: the same command line, the same one JSON line on stdout,
// a report line on stderr, and the first admin key only on a fresh data directory.
const FAKE_MAIN = `
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
const dir = process.env.TRPG_DATA_DIR
const [command] = process.argv.slice(2)
if (command === "key") {
  console.log(JSON.stringify({ ok: true, key: "minted-key", id: "k2" }))
  process.exit(0)
}
if (process.env.FAKE_REFUSE) {
  console.error(JSON.stringify({ ok: false, code: "bad_settings" }))
  process.exit(2)
}
mkdirSync(dir, { recursive: true })
const fresh = !existsSync(join(dir, "keys.json"))
if (fresh) writeFileSync(join(dir, "keys.json"), "{}")
writeFileSync(join(dir, "argv.json"), JSON.stringify(process.argv.slice(2)))
console.error("[main] opening the data directory")
console.log(JSON.stringify({ ok: true, version: "3.0.0-test", ticket: "endpointfaketicketfaketicketfake", notes: ["model_not_configured"], ...(fresh ? { first_key: { room: "main", key: "first-admin-key" } } : {}) }))
setInterval(() => {}, 1000)
`

/** A directory that looks like a checkout: `server/src/cli/main.ts` is the fake server. */
function checkout(): string {
  const root = tempDir()
  mkdirSync(join(root, "server", "src", "cli"), { recursive: true })
  writeFileSync(join(root, "server", "src", "cli", "main.ts"), FAKE_MAIN)
  mkdirSync(join(root, "clients", "tui", "src"), { recursive: true })
  return root
}

describe("finding a server", () => {
  test("this client's own checkout is found by walking up, and run with Bun from the repository root", () => {
    const command = resolveServerCommand(tempDir(), {})
    expect(command?.kind).toBe("checkout")
    expect(command?.argv[1]).toMatch(/server[/\\]src[/\\]cli[/\\]main\.ts$/)
    expect(existsSync(join(command?.cwd ?? "", "server", "src", "cli", "main.ts"))).toBe(true)
  })

  test("outside a checkout: TRPG_LOCAL_SERVER_BIN, then the folder's server-bin, else nothing", () => {
    const nowhere = tempDir()
    const home = tempDir()
    expect(findCheckoutEntry(nowhere)).toBeUndefined()
    expect(resolveServerCommand(home, {}, nowhere)).toBeUndefined()
    const named = join(tempDir(), "lw-server")
    writeFileSync(named, "")
    expect(resolveServerCommand(home, { TRPG_LOCAL_SERVER_BIN: named }, nowhere)).toEqual({ kind: "binary", argv: [named], cwd: home })
    mkdirSync(join(home, "server-bin"), { recursive: true })
    const bundled = join(home, "server-bin", process.platform === "win32" ? "loreweaver.exe" : "loreweaver")
    writeFileSync(bundled, "")
    chmodSync(bundled, 0o755)
    expect(resolveServerCommand(home, {}, nowhere)).toEqual({ kind: "binary", argv: [bundled], cwd: home })
  })

  test("a compiled client: the server binary beside it is found, through a link too, and never beside bun", () => {
    const nowhere = tempDir()
    const home = tempDir()
    const folder = tempDir()
    const exe = process.platform === "win32" ? ".exe" : ""
    const client = join(folder, `loreweaver-tui${exe}`)
    writeFileSync(client, "")
    expect(siblingServer(client)).toBeUndefined()
    const server = join(folder, `loreweaver${exe}`)
    writeFileSync(server, "")
    expect(siblingServer(client)).toBe(realpathSync(server))
    expect(resolveServerCommand(home, {}, nowhere, client)).toEqual({ kind: "binary", argv: [realpathSync(server)], cwd: home })
    // The environment's choice still comes first.
    const named = join(tempDir(), "lw-server")
    writeFileSync(named, "")
    expect(resolveServerCommand(home, { TRPG_LOCAL_SERVER_BIN: named }, nowhere, client)?.argv).toEqual([named])
    // What sits beside `bun` is not this client's server; a file that is not there has no neighbour.
    const bun = join(folder, `bun${exe}`)
    writeFileSync(bun, "")
    expect(siblingServer(bun)).toBeUndefined()
    expect(siblingServer(join(folder, "gone"))).toBeUndefined()
    if (process.platform !== "win32") {
      const linked = join(tempDir(), "loreweaver-tui")
      symlinkSync(client, linked)
      expect(siblingServer(linked)).toBe(realpathSync(server))
    }
  })

  test("the ready line: a ticket and the first key; a refusal by code; anything else is not it", () => {
    expect(parseReadyLine(`{"ok":true,"version":"3","ticket":"endpointx","notes":["recall_off"],"first_key":{"room":"main","key":"K"}}`)).toEqual({ ok: true, ticket: "endpointx", notes: ["recall_off"], firstKey: "K" })
    expect(parseReadyLine(`{"ok":true,"ticket":"endpointx","notes":[]}`)).toEqual({ ok: true, ticket: "endpointx", notes: [] })
    expect(parseReadyLine(`{"ok":false,"code":"bad_settings","problems":[]}`)).toEqual({ ok: false, code: "bad_settings" })
    expect(parseReadyLine("[main] opening")).toBeNull()
    expect(parseReadyLine(`{"ok":true}`)).toBeNull()
  })
})

describe("bringing a server up", () => {
  test("a test without a network may ask for loopback only; the handle says how to dial", async () => {
    const root = checkout()
    const home = join(tempDir(), "lw")
    const handle = await bringUpServer(() => {}, undefined, { localServerHome: home, env: {}, searchFrom: join(root, "clients", "tui", "src"), network: "local" })
    handles.push(handle)
    expect(handle.network).toBe("local")
    expect(JSON.parse(readFileSync(join(home, "data", "argv.json"), "utf8"))).toEqual(["serve", "--local", "--until-stdin-closes"])
  })

  test("a fresh folder: the server's first admin key is handed back to keep; again, the kept key is used", async () => {
    const root = checkout()
    const home = join(tempDir(), "lw")
    const lines: BringUpLine[] = []
    const first = await bringUpServer((line) => lines.push(line), undefined, { localServerHome: home, env: {}, searchFrom: join(root, "clients", "tui", "src") })
    handles.push(first)
    expect(first).toMatchObject({ ticket: "endpointfaketicketfaketicketfake", key: "first-admin-key", newKey: true, network: "n0" })
    // Run as an operator would run it — reachable by the people invited — never loopback-only.
    expect(JSON.parse(readFileSync(join(home, "data", "argv.json"), "utf8"))).toEqual(["serve", "--until-stdin-closes"])
    expect(existsSync(join(home, "data", "keys.json"))).toBe(true)
    expect(lines.map((line) => line.key ?? line.text)).toEqual([
      "hostlocal.step.checkout",
      "hostlocal.step.starting",
      "[main] opening the data directory",
      "hostlocal.note.modelNotConfigured",
      "hostlocal.step.ready",
    ])
    await first.stop()

    const again = await bringUpServer(() => {}, undefined, { localServerHome: home, knownKey: "first-admin-key", env: {}, searchFrom: join(root, "clients", "tui", "src") })
    handles.push(again)
    expect(again).toMatchObject({ key: "first-admin-key", newKey: false })
  })

  test("a used folder with no key kept: one is minted with the server's own key command before it starts", async () => {
    const root = checkout()
    const home = tempDir()
    mkdirSync(join(home, "data"), { recursive: true })
    writeFileSync(join(home, "data", "keys.json"), "{}")
    const lines: BringUpLine[] = []
    const handle = await bringUpServer((line) => lines.push(line), undefined, { localServerHome: home, env: {}, searchFrom: root })
    handles.push(handle)
    expect(handle).toMatchObject({ key: "minted-key", newKey: true })
    expect(lines.some((line) => line.key === "hostlocal.step.mint")).toBe(true)
  })

  test("a server that refuses to start, and a machine with no server, fail with a reason", async () => {
    const root = checkout()
    const refused = await bringUpServer(() => {}, undefined, { localServerHome: tempDir(), env: { FAKE_REFUSE: "1" }, searchFrom: root }).catch((error: unknown) => error)
    expect(refused).toBeInstanceOf(HostLocalError)
    expect(refused).toMatchObject({ key: "hostlocal.error.refused", vars: { code: "bad_settings" } })

    const none = await bringUpServer(() => {}, undefined, { localServerHome: tempDir(), env: {}, searchFrom: tempDir() }).catch((error: unknown) => error)
    expect(none).toMatchObject({ key: "hostlocal.error.noServer" })
  })
})
