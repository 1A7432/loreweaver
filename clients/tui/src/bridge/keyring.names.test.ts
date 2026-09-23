import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { FrameType, type ClientFrame, type ServerFrame } from "loreweaver-protocol"
import { Keyring, MAX_KEY_NAME_CHARS, keyIdFromSecret, keyNameFromDisplay, memberName, type ControlLink } from "./keyring"

class FakeControl implements ControlLink {
  sent: ClientFrame[] = []
  private readonly handlers = new Set<(frame: ServerFrame) => void>()
  send(frame: ClientFrame): void {
    this.sent.push(frame)
  }
  onMessage(cb: (frame: ServerFrame) => void): () => void {
    this.handlers.add(cb)
    return () => {
      this.handlers.delete(cb)
    }
  }
  push(frame: ServerFrame): void {
    for (const handler of this.handlers) handler(frame)
  }
}

function minted(name: string, key: string, role: "player" | "keeper", keys: Array<{ id: string; name: string; role: "player" | "keeper" }> = []): ServerFrame {
  return {
    type: FrameType.AdminKeys,
    keys: keys.map((row) => ({ id: row.id, key_masked: "xxxx...yyyy", room: "arkham", name: row.name, role: row.role, purpose: "join", expires_at: null })),
    minted: { key, room: "arkham", name, role, purpose: "join", expires_at: null },
  } as ServerFrame
}

async function ring(control: FakeControl, extra: { admins?: string[]; mintTimeoutMs?: number } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "lw-keyring-names-"))
  return Keyring.load({
    path: join(dir, "g.keyring.json"),
    groupId: "99",
    control,
    admins: () => extra.admins ?? [],
    keeperKey: "KEEP-SECRET",
    mintTimeoutMs: extra.mintTimeoutMs,
  })
}

describe("Keyring — keys are named after the group card", () => {
  test("the display name is the key name; no name falls back to qq:<id>", async () => {
    const control = new FakeControl()
    const keyring = await ring(control)
    const pending = keyring.ensure("111", "阿绫")
    await Promise.resolve()
    expect(control.sent[0]).toEqual({ type: FrameType.AdminMintKey, name: "阿绫", role: "player", purpose: "join" })
    control.push(minted("阿绫", "key-aaaa", "player"))
    const entry = await pending
    expect(entry.name).toBe("阿绫")
    expect(entry.key_id).toBe(keyIdFromSecret("key-aaaa"))

    const nameless = keyring.ensure("222")
    await Promise.resolve()
    expect(control.sent[1]).toMatchObject({ type: FrameType.AdminMintKey, name: memberName("222") })
    control.push(minted(memberName("222"), "key-bbbb", "player"))
    expect((await nameless).name).toBe(memberName("222"))
    keyring.close()
  })

  test("a card change does not re-mint; the minted name is persisted and reloaded", async () => {
    const control = new FakeControl()
    const keyring = await ring(control)
    const first = keyring.ensure("111", "阿绫")
    await Promise.resolve()
    control.push(minted("阿绫", "key-aaaa", "player"))
    await first
    expect(await keyring.ensure("111", "绫绫")).toMatchObject({ key: "key-aaaa", name: "阿绫" })
    expect(control.sent).toHaveLength(1)
    await keyring.drainWrites()
    const path = (keyring as unknown as { options: { path: string } }).options.path
    const reloaded = await Keyring.load({ path, groupId: "99", control: new FakeControl(), admins: () => [], keeperKey: "KEEP-SECRET" })
    expect(reloaded.get("111")).toMatchObject({ key: "key-aaaa", name: "阿绫" })
    keyring.close()
  })

  test("a card that copies another seat's name (or the qq: shape) falls back to qq:<id>; key ids come from the secret", async () => {
    const control = new FakeControl()
    const keyring = await ring(control)
    const a = keyring.ensure("111", "路人")
    await Promise.resolve()
    control.push(minted("路人", "key-aaaa", "player", [{ id: keyIdFromSecret("key-aaaa"), name: "路人", role: "player" }]))
    await a
    const b = keyring.ensure("222", "路人")
    await Promise.resolve()
    // Nobody wears another seat's name: the second 路人 is minted as qq:222.
    expect(control.sent[1]).toMatchObject({ type: FrameType.AdminMintKey, name: memberName("222") })
    control.push(
      minted(memberName("222"), "key-bbbb", "player", [
        { id: keyIdFromSecret("key-aaaa"), name: "路人", role: "player" },
        { id: keyIdFromSecret("key-bbbb"), name: memberName("222"), role: "player" },
      ]),
    )
    const entry = await b
    expect(entry.name).toBe(memberName("222"))
    expect(entry.key_id).toBe(keyIdFromSecret("key-bbbb"))
    expect(keyring.get("111")!.key_id).toBe(keyIdFromSecret("key-aaaa"))
    const c = keyring.ensure("333", "qq:observer:99")
    await Promise.resolve()
    expect(control.sent[2]).toMatchObject({ type: FrameType.AdminMintKey, name: memberName("333") })
    control.push(minted(memberName("333"), "key-cccc", "player"))
    await c
    keyring.close()
  })

  test("a late mint for a user kicked meanwhile is deleted, not adopted", async () => {
    let admins: string[] = []
    const control = new FakeControl()
    const dir = await mkdtemp(join(tmpdir(), "lw-keyring-names-"))
    const keyring = await Keyring.load({
      path: join(dir, "g.keyring.json"),
      groupId: "99",
      control,
      admins: () => admins,
      keeperKey: "KEEP-SECRET",
      mintTimeoutMs: 15,
    })
    const first = keyring.ensure("111", "阿绫")
    await Promise.resolve()
    control.push(minted("阿绫", "key-player", "player"))
    await first
    admins = ["111"]
    // An older server refuses the role update, so the promotion falls back to a re-mint —
    // which times out client-side while the server is still working on it. (A TIMEOUT of
    // the role update itself never re-mints: the seat would be lost.)
    const promote = keyring.ensure("111", "阿绫")
    await new Promise((resolve) => setTimeout(resolve, 2))
    control.push({ type: FrameType.AdminError, code: "bad_request", message: "unknown admin frame" } as ServerFrame)
    await expect(promote).rejects.toThrow("admin_mint_key timed out")
    const kick = keyring.kick("111")
    await Promise.resolve()
    control.push({ type: FrameType.AdminKeys, keys: [] } as ServerFrame)
    await kick
    expect(keyring.get("111")).toBeUndefined()
    // The late keeper key lands: it must be deleted, never become a live seat for a kicked user.
    control.push(minted("阿绫", "key-late-keeper", "keeper"))
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(keyring.get("111")).toBeUndefined()
    expect(control.sent.at(-1)).toEqual({ type: FrameType.AdminDeleteKey, id: keyIdFromSecret("key-late-keeper") })
    keyring.close()
  })

  test("a mint that timed out is adopted when the reply finally lands, by remembered user", async () => {
    const control = new FakeControl()
    const keyring = await ring(control, { mintTimeoutMs: 15 })
    await expect(keyring.ensure("111", "阿绫")).rejects.toThrow("admin_mint_key timed out")
    expect(keyring.get("111")).toBeUndefined()
    control.push(minted("阿绫", "key-late", "player"))
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(keyring.get("111")).toMatchObject({ key: "key-late", name: "阿绫" })
    keyring.close()
  })

  test("remint always mints a new key named from the display, returning the previous", async () => {
    const control = new FakeControl()
    const keyring = await ring(control)
    const first = keyring.ensure("111", "阿绫")
    await Promise.resolve()
    control.push(minted("阿绫", "key-aaaa", "player"))
    await first
    const pending = keyring.remint("111", "绫绫")
    await Promise.resolve()
    expect(control.sent.at(-1)).toMatchObject({ type: FrameType.AdminMintKey, name: "绫绫", role: "player" })
    control.push(minted("绫绫", "key-bbbb", "player"))
    await new Promise((resolve) => setTimeout(resolve, 20))
    control.push({ type: FrameType.AdminKeys, keys: [] } as ServerFrame)
    const { previous, entry } = await pending
    expect(previous?.key).toBe("key-aaaa")
    expect(entry.key).toBe("key-bbbb")
    expect(entry.name).toBe("绫绫")
    keyring.close()
  })

  test("keyNameFromDisplay trims, collapses whitespace, strips control characters, and caps", () => {
    expect(keyNameFromDisplay("  阿  绫\t\n")).toBe("阿 绫")
    expect(keyNameFromDisplay("a\u0000b")).toBe("a b")
    expect(keyNameFromDisplay("")).toBe("")
    expect(keyNameFromDisplay(undefined)).toBe("")
    expect([...keyNameFromDisplay("x".repeat(100))]).toHaveLength(MAX_KEY_NAME_CHARS)
  })
})
