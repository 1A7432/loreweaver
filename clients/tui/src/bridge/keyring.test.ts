import { mkdtemp, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { FrameType, type ClientFrame, type ServerFrame } from "loreweaver-protocol"
import { Keyring, LastKeeperError, memberName } from "./keyring"

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

function mintedKeys(name: string, key: string, role: "player" | "keeper", id = "kid-1"): ServerFrame {
  return {
    type: FrameType.AdminKeys,
    keys: [
      {
        id,
        key_masked: `${key.slice(0, 4)}...${key.slice(-4)}`,
        room: "arkham",
        name,
        role,
        purpose: "join",
        expires_at: null,
      },
    ],
    minted: { key, room: "arkham", name, role, purpose: "join", expires_at: null },
  }
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
    expect(control.sent).toEqual([
      { type: FrameType.AdminMintKey, name: memberName("111"), role: "player", purpose: "join" },
    ])
    expect(control.sent.some((frame) => frame.type === FrameType.Join)).toBe(false)
    control.push(mintedKeys(memberName("111"), "player-key-aaaa", "player", "id-111"))
    const entry = await pending
    expect(entry).toEqual({ key: "player-key-aaaa", key_id: "id-111", role: "player" })
    expect(entry.key).not.toBe("KEEP-SECRET")
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
    ring.close()
    reloaded.close()
  })

  test("configured admins mint role keeper", async () => {
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

  test("the bridge keeper key never joins as a playing link", async () => {
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
    control.push(mintedKeys("qq:observer:99", "obs-key", "player", "id-obs"))
    const observer = await pending
    expect(observer.key).not.toBe("KEEP-SECRET")
    expect(control.sent.every((frame) => frame.type === FrameType.AdminMintKey)).toBe(true)
    expect(ring.isKeeperKey("KEEP-SECRET")).toBe(true)
    expect(ring.isKeeperKey(observer.key)).toBe(false)
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
    expect(control.sent.at(-1)).toEqual({ type: FrameType.AdminDeleteKey, id: "id-42" })
    control.push({ type: FrameType.AdminError, code: "last_keeper", message: "cannot delete the last keeper key" } as ServerFrame)
    await expect(kick).rejects.toBeInstanceOf(LastKeeperError)
    expect(ring.get("42")?.key_id).toBe("id-42")
    ring.close()
  })
})
