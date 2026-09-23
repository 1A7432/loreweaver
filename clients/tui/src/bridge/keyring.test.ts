import { mkdtemp, readdir, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { FrameType, type ClientFrame, type ServerFrame } from "loreweaver-protocol"
import {
  Keyring,
  keyIdFromSecret,
  LastKeeperError,
  ObserverProtectedError,
  memberName,
  observerName,
  observerUserId,
} from "./keyring"

class FakeControl {
  sent: ClientFrame[] = []
  private readonly handlers = new Set<(frame: ServerFrame) => void>()
  send(frame: ClientFrame): void {
    this.sent.push(frame)
  }
  onMessage(cb: (frame: ServerFrame) => void): () => void {
    this.handlers.add(cb)
    return () => this.handlers.delete(cb)
  }
  push(frame: ServerFrame): void {
    for (const handler of this.handlers) handler(frame)
  }
}

function mintedKeys(name: string, key: string, role: "player" | "keeper", id = "kid-1", extra: ServerFrame["type"] extends never ? never : { keys?: AdminKey[] } = {}): ServerFrame {
  const keys = extra.keys ?? [
    {
      id,
      key_masked: `${key.slice(0, 4)}...${key.slice(-4)}`,
      room: "arkham",
      name,
      role,
      purpose: "join" as const,
      expires_at: null,
    },
  ]
  return {
    type: FrameType.AdminKeys,
    keys,
    minted: { key, room: "arkham", name, role, purpose: "join", expires_at: null },
  }
}

type AdminKey = {
  id: string
  key_masked: string
  room: string
  name: string
  role: "player" | "keeper"
  purpose: "join"
  expires_at: null
}

function keyRow(id: string, name: string, role: "player" | "keeper"): AdminKey {
  return { id, key_masked: "xxxx...yyyy", room: "arkham", name, role, purpose: "join", expires_at: null }
}

describe("keyring", () => {
  test("first message mints via admin_mint_key purpose join, persists 0600, and reloads", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lw-keyring-"))
    const path = join(dir, "g.keyring.json")
    const control = new FakeControl()
    const ring = await Keyring.load({
      path,
      groupId: "99",
      control,
      admins: () => [],
      keeperKey: "KEEP-SECRET",
    })
    const pending = ring.ensure("111")
    await Promise.resolve()
    expect(control.sent[0]).toEqual({
      type: FrameType.AdminMintKey,
      name: memberName("111"),
      role: "player",
      purpose: "join",
    })
    control.push(mintedKeys(memberName("111"), "player-key-aaaa", "player", "id-111"))
    const entry = await pending
    expect(entry.key).toBe("player-key-aaaa")
    expect(entry.role).toBe("player")
    expect(ring.get("111")?.key).not.toBe("KEEP-SECRET")
    expect(control.sent.every((frame) => frame.type !== FrameType.Join)).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 30))
    const info = await stat(path)
    expect(info.mode & 0o777).toBe(0o600)

    const reloaded = await Keyring.load({
      path,
      groupId: "99",
      control: new FakeControl(),
      admins: () => [],
      keeperKey: "KEEP-SECRET",
    })
    expect(reloaded.get("111")?.key).toBe("player-key-aaaa")
    expect(reloaded.get("111")?.key).not.toBe("KEEP-SECRET")
    ring.close()
    reloaded.close()
  })

  test("the keyring never sends join and never stores the bridge keeper key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lw-keyring-"))
    const control = new FakeControl()
    const ring = await Keyring.load({
      path: join(dir, "g.keyring.json"),
      groupId: "99",
      control,
      admins: () => [],
      keeperKey: "KEEP-SECRET",
    })
    const pending = ring.ensureObserver()
    await Promise.resolve()
    control.push(mintedKeys(observerName("99"), "obs-key", "player", "id-obs"))
    const observer = await pending
    expect(observer.key).not.toBe("KEEP-SECRET")
    expect(control.sent.some((frame) => frame.type === FrameType.Join)).toBe(false)
    expect([...control.sent.map((frame) => frame.type)]).toEqual([FrameType.AdminMintKey])
    expect(ring.list()).toEqual([])
    await expect(ring.kick(observerUserId("99"))).rejects.toBeInstanceOf(ObserverProtectedError)
    ring.close()
  })

  test("configured admins mint role keeper; displayName is not the key name", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lw-keyring-"))
    const control = new FakeControl()
    const ring = await Keyring.load({
      path: join(dir, "g.keyring.json"),
      groupId: "99",
      control,
      admins: () => ["42"],
      keeperKey: "KEEP-SECRET",
    })
    const pending = ring.ensure("42")
    await Promise.resolve()
    expect(control.sent[0]).toEqual({
      type: FrameType.AdminMintKey,
      name: memberName("42"),
      role: "keeper",
      purpose: "join",
    })
    control.push(mintedKeys(memberName("42"), "admin-key-bbbb", "keeper", "id-42"))
    const entry = await pending
    expect(entry.role).toBe("keeper")
    expect(entry.key).not.toBe("KEEP-SECRET")
    ring.close()
  })

  test("a last_keeper admin_error on kick is surfaced and the entry stays", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lw-keyring-"))
    const control = new FakeControl()
    const ring = await Keyring.load({
      path: join(dir, "g.keyring.json"),
      groupId: "99",
      control,
      admins: () => ["42"],
      keeperKey: "KEEP-SECRET",
    })
    const pending = ring.ensure("42")
    await Promise.resolve()
    control.push(mintedKeys(memberName("42"), "admin-key-bbbb", "keeper", "id-42"))
    await pending

    const kick = ring.kick("42")
    await Promise.resolve()
    expect(control.sent.at(-1)).toEqual({ type: FrameType.AdminDeleteKey, id: keyIdFromSecret("admin-key-bbbb") })
    control.push({ type: FrameType.AdminError, code: "last_keeper", message: "cannot delete the last keeper key" })
    await expect(kick).rejects.toBeInstanceOf(LastKeeperError)
    expect(ring.get("42")?.key_id).toBe(keyIdFromSecret("admin-key-bbbb"))
    ring.close()
  })

  test("concurrent kick + mint serialize; replies do not cross-resolve", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lw-keyring-"))
    const control = new FakeControl()
    const ring = await Keyring.load({
      path: join(dir, "g.keyring.json"),
      groupId: "99",
      control,
      admins: () => ["42"],
      keeperKey: "KEEP-SECRET",
    })
    const first = ring.ensure("42")
    await Promise.resolve()
    control.push(mintedKeys(memberName("42"), "admin-key-bbbb", "keeper", "id-42"))
    await first

    const kick = ring.kick("42")
    const mint = ring.ensure("111")
    await Promise.resolve()
    await Promise.resolve()
    expect(control.sent.filter((frame) => frame.type === FrameType.AdminDeleteKey)).toHaveLength(1)
    expect(control.sent.filter((frame) => frame.type === FrameType.AdminMintKey)).toHaveLength(1)

    control.push({ type: FrameType.AdminKeys, keys: [] })
    await kick
    await Promise.resolve()
    expect(control.sent.filter((frame) => frame.type === FrameType.AdminMintKey)).toHaveLength(2)
    control.push(mintedKeys(memberName("111"), "player-key-cccc", "player", "id-111"))
    const player = await mint
    expect(player.key).toBe("player-key-cccc")
    expect(ring.get("42")).toBeUndefined()
    ring.close()
  })

  test("a late mint reply with no pending is adopted; a late reply never blocks a subsequent mint", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lw-keyring-"))
    const control = new FakeControl()
    const ring = await Keyring.load({
      path: join(dir, "g.keyring.json"),
      groupId: "99",
      control,
      admins: () => [],
      keeperKey: "KEEP-SECRET",
      mintTimeoutMs: 20,
    })
    const first = ring.ensure("111")
    await expect(first).rejects.toThrow(/timed out/)
    expect(ring.get("111")).toBeUndefined()
    control.push(mintedKeys(memberName("111"), "adopted-key", "player", "id-adopt"))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(ring.get("111")?.key).toBe("adopted-key")
    ring.close()

    const control2 = new FakeControl()
    const ring2 = await Keyring.load({
      path: join(dir, "g2.keyring.json"),
      groupId: "99",
      control: control2,
      admins: () => [],
      keeperKey: "KEEP-SECRET",
      mintTimeoutMs: 20,
    })
    const timed = ring2.ensure("222")
    await expect(timed).rejects.toThrow(/timed out/)
    const second = ring2.ensure("222")
    await Promise.resolve()
    control2.push(mintedKeys(memberName("222"), "late-key", "player", "id-late"))
    const entry = await second
    expect(entry.key).toBe("late-key")
    expect(ring2.get("222")?.key).toBe("late-key")
    ring2.close()
  })

  test("a role change keeps the SAME key (and so the seat and its character): admin_update_key, no mint", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lw-keyring-"))
    const path = join(dir, "g.keyring.json")
    let admins = ["42"]
    const control = new FakeControl()
    const ring = await Keyring.load({ path, groupId: "99", control, admins: () => admins, keeperKey: "KEEP-SECRET" })
    const first = ring.ensure("42")
    await Promise.resolve()
    control.push(mintedKeys(memberName("42"), "keeper-old", "keeper", keyIdFromSecret("keeper-old")))
    await first
    const sentBefore = control.sent.length

    admins = []
    const demote = ring.ensure("42")
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(control.sent.slice(sentBefore)).toEqual([
      { type: FrameType.AdminUpdateKey, id: keyIdFromSecret("keeper-old"), role: "player" },
    ])
    control.push({ type: FrameType.AdminKeys, keys: [keyRow(keyIdFromSecret("keeper-old"), memberName("42"), "player")] })
    const demoted = await demote
    expect(demoted).toEqual({ key: "keeper-old", key_id: keyIdFromSecret("keeper-old"), role: "player", name: memberName("42") })

    admins = ["42"]
    const promote = ring.ensure("42")
    await new Promise((resolve) => setTimeout(resolve, 10))
    control.push({ type: FrameType.AdminKeys, keys: [keyRow(keyIdFromSecret("keeper-old"), memberName("42"), "keeper")] })
    expect((await promote).key).toBe("keeper-old")
    expect(control.sent.some((frame) => frame.type === FrameType.AdminMintKey && control.sent.indexOf(frame) >= sentBefore)).toBe(false)
    expect(control.sent.some((frame) => frame.type === FrameType.AdminDeleteKey)).toBe(false)
    const reloaded = await Keyring.load({ path, groupId: "99", control: new FakeControl(), admins: () => admins })
    expect(reloaded.get("42")?.role).toBe("keeper")
    ring.close()
  })

  test("a role change the server refuses as last_keeper keeps the old entry; a refusal it SENDS (an older server) falls back to a fresh key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lw-keyring-"))
    let admins = ["42", "43"]
    const control = new FakeControl()
    const ring = await Keyring.load({ path: join(dir, "g.keyring.json"), groupId: "99", control, admins: () => admins })
    const first = ring.ensure("42")
    await Promise.resolve()
    control.push(mintedKeys(memberName("42"), "keeper-42", "keeper", keyIdFromSecret("keeper-42")))
    await first

    admins = ["43"]
    const refused = ring.ensure("42")
    await new Promise((resolve) => setTimeout(resolve, 10))
    control.push({ type: FrameType.AdminError, code: "last_keeper", message: "cannot demote the last keeper key" })
    await expect(refused).rejects.toBeInstanceOf(LastKeeperError)
    expect(ring.get("42")?.role).toBe("keeper")

    // An older server (no role update): the old behavior — a fresh key, then the old one deleted.
    const fallback = ring.ensure("42")
    await new Promise((resolve) => setTimeout(resolve, 10))
    control.push({ type: FrameType.AdminError, code: "bad_request", message: "unknown admin frame" })
    await new Promise((resolve) => setTimeout(resolve, 10))
    control.push(mintedKeys(memberName("42"), "player-42", "player", keyIdFromSecret("player-42")))
    await new Promise((resolve) => setTimeout(resolve, 10))
    control.push({ type: FrameType.AdminKeys, keys: [keyRow(keyIdFromSecret("player-42"), memberName("42"), "player")] })
    expect((await fallback).key).toBe("player-42")
    expect(control.sent.some((frame) => frame.type === FrameType.AdminDeleteKey && "id" in frame && frame.id === keyIdFromSecret("keeper-42"))).toBe(true)
    ring.close()
  })

  test("a role change the server is slow to answer is sent once more, and the SAME key keeps the seat", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lw-keyring-"))
    let admins = ["42", "43"]
    const control = new FakeControl()
    const ring = await Keyring.load({ path: join(dir, "g.keyring.json"), groupId: "99", control, admins: () => admins, mintTimeoutMs: 20 })
    const first = ring.ensure("42")
    await Promise.resolve()
    control.push(mintedKeys(memberName("42"), "keeper-42", "keeper", keyIdFromSecret("keeper-42")))
    await first
    const sentBefore = control.sent.length

    admins = ["43"]
    const demote = ring.ensure("42")
    await new Promise((resolve) => setTimeout(resolve, 30)) // the first send timed out; the retry is out
    const update = { type: FrameType.AdminUpdateKey, id: keyIdFromSecret("keeper-42"), role: "player" }
    expect(control.sent.slice(sentBefore)).toEqual([update, update])
    control.push({ type: FrameType.AdminKeys, keys: [keyRow(keyIdFromSecret("keeper-42"), memberName("42"), "player")] })
    expect(await demote).toEqual({ key: "keeper-42", key_id: keyIdFromSecret("keeper-42"), role: "player", name: memberName("42") })
    expect(control.sent.slice(sentBefore).some((frame) => frame.type === FrameType.AdminMintKey || frame.type === FrameType.AdminDeleteKey)).toBe(false)
    ring.close()
  })

  test("a role change the server never answers fails the seat and keeps the entry — never a fresh key", async () => {
    // The update may have landed server-side: a mint followed by deleting the old key
    // would discard the seat and its character, which is exactly what a role change
    // must not do. The entry is left as it was; the next message tries again.
    const dir = await mkdtemp(join(tmpdir(), "lw-keyring-"))
    let admins = ["42", "43"]
    const control = new FakeControl()
    const ring = await Keyring.load({ path: join(dir, "g.keyring.json"), groupId: "99", control, admins: () => admins, mintTimeoutMs: 20 })
    const first = ring.ensure("42")
    await Promise.resolve()
    control.push(mintedKeys(memberName("42"), "keeper-42", "keeper", keyIdFromSecret("keeper-42")))
    await first
    const sentBefore = control.sent.length

    admins = ["43"]
    await expect(ring.ensure("42")).rejects.toThrow(/admin_update_key timed out/)
    const update = { type: FrameType.AdminUpdateKey, id: keyIdFromSecret("keeper-42"), role: "player" }
    expect(control.sent.slice(sentBefore)).toEqual([update, update])
    expect(control.sent.some((frame) => frame.type === FrameType.AdminDeleteKey)).toBe(false)
    expect(ring.get("42")).toEqual({ key: "keeper-42", key_id: keyIdFromSecret("keeper-42"), role: "keeper", name: memberName("42") })

    // The next message: the same frame again, answered this time — same key, new role.
    const again = ring.ensure("42")
    await new Promise((resolve) => setTimeout(resolve, 5))
    control.push({ type: FrameType.AdminKeys, keys: [keyRow(keyIdFromSecret("keeper-42"), memberName("42"), "player")] })
    expect((await again).key).toBe("keeper-42")
    expect(control.sent.some((frame) => frame.type === FrameType.AdminMintKey && control.sent.indexOf(frame) >= sentBefore)).toBe(false)
    ring.close()
  })

  test("a truncated keyring file is quarantined and load treats it as empty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lw-keyring-"))
    const path = join(dir, "g.keyring.json")
    await writeFile(path, "{not json")
    const ring = await Keyring.load({
      path,
      groupId: "99",
      control: new FakeControl(),
      admins: () => [],
    })
    expect(ring.get("111")).toBeUndefined()
    const names = await readdir(dir)
    expect(names.some((name) => name.startsWith("g.keyring.json.corrupt-"))).toBe(true)
    ring.close()
  })
})
