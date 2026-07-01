import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import ssh2 from "ssh2"
import { authorize, fingerprintOf, loadSshKeys, parsePublicKey } from "./keys"

const { utils } = ssh2

const tmp = mkdtempSync(join(tmpdir(), "trpg-ssh-keys-"))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

const nora = utils.generateKeyPairSync("ed25519")
const thane = utils.generateKeyPairSync("ed25519")
const stranger = utils.generateKeyPairSync("ed25519")

function writeKeysToml(): string {
  const path = join(tmp, "ssh_keys.toml")
  writeFileSync(
    path,
    [
      "[[user]]",
      `pubkey = ${JSON.stringify(nora.public.trim())}`,
      'room   = "blackmoor"',
      'ws_key = "GiAZWUeR-nora"',
      'name   = "Nora"',
      "",
      "[[user]]",
      `pubkey = ${JSON.stringify(thane.public.trim())}`,
      'room   = "blackmoor"',
      'ws_key = "XYZ789-thane"',
      'name   = "Thane"',
      "",
    ].join("\n"),
    "utf8",
  )
  return path
}

describe("loadSshKeys", () => {
  test("parses entries and keys them by fingerprint", () => {
    const keys = loadSshKeys(writeKeysToml())
    expect(keys.size).toBe(2)

    const noraFp = parsePublicKey(nora.public).fingerprint
    const thaneFp = parsePublicKey(thane.public).fingerprint

    expect(keys.has(noraFp)).toBe(true)
    expect(keys.has(thaneFp)).toBe(true)

    const noraEntry = keys.get(noraFp)!
    expect(noraEntry.room).toBe("blackmoor")
    expect(noraEntry.wsKey).toBe("GiAZWUeR-nora")
    expect(noraEntry.name).toBe("Nora")
    expect(noraEntry.fingerprint).toBe(noraFp)

    const thaneEntry = keys.get(thaneFp)!
    expect(thaneEntry.name).toBe("Thane")
    expect(thaneEntry.wsKey).toBe("XYZ789-thane")
  })

  test("fingerprintOf yields a stable SHA256:… string", () => {
    const { blob } = parsePublicKey(nora.public)
    const fp = fingerprintOf(blob)
    expect(fp.startsWith("SHA256:")).toBe(true)
    expect(fp).not.toContain("=")
    // deterministic
    expect(fingerprintOf(blob)).toBe(fp)
  })
})

describe("authorize", () => {
  test("accepts an authorized public key (ParsedKey and ctx.key shapes)", () => {
    const keys = loadSshKeys(writeKeysToml())

    // As a ParsedKey (has getPublicSSH()).
    const parsed = parsePublicKey(nora.public).parsed
    const viaParsed = authorize(keys, parsed)
    expect(viaParsed?.name).toBe("Nora")

    // As an ssh2 auth ctx.key shape ({ algo, data: Buffer }).
    const viaCtx = authorize(keys, { algo: "ssh-ed25519", data: parsed.getPublicSSH() })
    expect(viaCtx?.name).toBe("Nora")

    // As a raw string line.
    const viaString = authorize(keys, thane.public)
    expect(viaString?.name).toBe("Thane")
  })

  test("rejects an unknown key", () => {
    const keys = loadSshKeys(writeKeysToml())
    const strangerParsed = parsePublicKey(stranger.public).parsed
    expect(authorize(keys, strangerParsed)).toBeNull()
    expect(authorize(keys, { algo: "ssh-ed25519", data: strangerParsed.getPublicSSH() })).toBeNull()
    expect(authorize(keys, null)).toBeNull()
    expect(authorize(keys, "not-a-key")).toBeNull()
  })
})
