import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Connection } from "../connection"
import { FakeServer, liveRender, waitFor, waitForScreen } from "../testkit"
import { themes } from "../themes"
import { ShareForm, soundTitle } from "./ShareForm"

const harnesses: Array<{ renderer: { destroy(): void } }> = []
const connections: Connection[] = []
afterEach(() => {
  for (const connection of connections.splice(0)) connection.stop()
  for (const harness of harnesses.splice(0)) harness.renderer.destroy()
})

async function form(server: FakeServer) {
  const connection = server.connect()
  connections.push(connection)
  await connection.start()
  await waitFor("the welcome", () => connection.session.status === "online")
  let closed = false
  const harness = await liveRender(<ShareForm connection={connection} theme={themes.lamplight} locale="en" purpose="audio" onClose={() => (closed = true)} />, { width: 120, height: 12 })
  harnesses.push(harness)
  const screen = (what: string, has: (frame: string) => boolean) => waitForScreen(harness, what, has)
  return { harness, screen, connection, closed: () => closed }
}

describe("ShareForm with purpose audio", () => {
  test("a sound is offered with purpose audio and sent; the form says how to play it and stays open", async () => {
    const server = new FakeServer({ role: "admin" })
    const dir = await mkdtemp(join(tmpdir(), "loreweaver-sound-"))
    await writeFile(join(dir, "rain on the quay.ogg"), new TextEncoder().encode("OggS not really"))
    await writeFile(join(dir, "map.png"), new Uint8Array([0x89, 0x50, 0x4e, 0x47]))
    const { harness, screen, connection, closed } = await form(server)
    await screen("the form", (text) => text.includes("Add a sound to the room's audio library"))

    // A picture is not a sound.
    await harness.mockInput.typeText(join(dir, "map.png"))
    harness.mockInput.pressEnter()
    await screen("the type refused", (text) => text.includes("Not a type that can be sent here"))
    expect(server.offered).toHaveLength(0)

    for (let i = 0; i < "map.png".length; i += 1) harness.mockInput.pressBackspace()
    await harness.mockInput.typeText("rain on the quay.ogg")
    harness.mockInput.pressEnter()
    await screen("the sound added", (text) => text.includes(".bgm play rain on the quay"))
    expect(server.offered[0]).toMatchObject({ name: "rain on the quay.ogg", mime: "audio/ogg", purpose: "audio" })
    expect([...server.files.values()][0]).toMatchObject({ name: "rain on the quay.ogg", purpose: "audio" })
    expect(closed()).toBe(false)
    expect(connection.getState().lines.at(-1)?.text).toContain("Added rain on the quay.ogg to the audio library")
  })

  test("the server's refusal is shown in its words (its limits are its own)", async () => {
    const server = new FakeServer({ role: "admin" })
    server.refuseOffer = { code: "audio_library_full", message: "The room's audio library is full (100 sounds)." }
    const dir = await mkdtemp(join(tmpdir(), "loreweaver-sound-"))
    await writeFile(join(dir, "bell.mp3"), new Uint8Array([0xff, 0xfb, 0x90, 0x00]))
    const { harness, screen } = await form(server)
    await harness.mockInput.typeText(join(dir, "bell.mp3"))
    harness.mockInput.pressEnter()
    await screen("the refusal", (text) => text.includes("The room's audio library is full (100 sounds)."))
    expect(server.offered[0]).toMatchObject({ mime: "audio/mpeg", purpose: "audio" })
  })

  test("the title a sound gets is its file name without the extension", () => {
    expect(soundTitle("rain.ogg")).toBe("rain")
    expect(soundTitle("a.b.mp3")).toBe("a.b")
    expect(soundTitle(".hidden")).toBe(".hidden")
    expect(soundTitle("plain")).toBe("plain")
  })
})
