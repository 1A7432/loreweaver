import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Connection } from "../connection"
import { FakeServer, liveRender, pump, waitFor, waitForScreen } from "../testkit"
import { themes } from "../themes"
import { CharacterScreen } from "./CharacterScreen"

const harnesses: Array<{ renderer: { destroy(): void } }> = []
const connections: Connection[] = []
afterEach(() => {
  for (const connection of connections.splice(0)) connection.stop()
  for (const harness of harnesses.splice(0)) harness.renderer.destroy()
})

const ME_NONE = { member: { id: "m1", name: "Ada", role: "player", roleLabel: "Investigator" }, character: null }
const SHEET = {
  id: "ch-1",
  name: "Ada Lovelace",
  pack: "coc7",
  status: [],
  resources: [{ id: "hp", label: "HP", value: 11, max: 13 }],
  attributes: [
    { key: "STR", label: "STR", value: 45 },
    { key: "APP", label: "外貌", value: 60 },
  ],
  skills: [{ key: "Spot Hidden", label: "Spot Hidden", value: 60 }],
}
const ME_SHEET = { ...ME_NONE, character: SHEET }
const SYSTEMS = { claimable: [], systems: [{ id: "dnd5e", label: "D&D 5e", active: false }, { id: "coc7", label: "Call of Cthulhu 7e", active: true }], mine: null }

async function open(server: FakeServer, onBack: () => void = () => {}) {
  const connection = server.connect()
  connections.push(connection)
  await connection.start()
  await waitFor("the views", () => connection.session.getSnapshot().views.has("me") && connection.session.getSnapshot().views.has("characters"))
  const harness = await liveRender(<CharacterScreen connection={connection} theme={themes.lamplight} themeName="lamplight" locale="en" onBack={onBack} />, { width: 110, height: 34 })
  harnesses.push(harness)
  const screen = (what: string, has: (frame: string) => boolean) => waitForScreen(harness, what, has)
  const calls = () => server.current.calls("command.run").map((call) => call.params)
  return { connection, harness, screen, calls }
}

describe("CharacterScreen", () => {
  test("no character: create with new_character and the chosen system's id, then land on the sheet", async () => {
    const server = new FakeServer()
    server.views.set("me", ME_NONE)
    server.views.set("characters", SYSTEMS)
    server.onCall = (method, params) => {
      if (method === "command.run" && params.id === "new_character") {
        server.view("me", ME_SHEET)
        return { ok: true, data: { id: "ch-1" } }
      }
      return { ok: true }
    }
    const { harness, screen, calls } = await open(server)
    const form = await screen("the create form", (text) => text.includes("Call of Cthulhu 7e"))
    // The room's own system is offered first.
    expect(form.indexOf("Call of Cthulhu 7e")).toBeLessThan(form.indexOf("D&D 5e"))
    harness.mockInput.pressEnter()
    await pump()
    await harness.mockInput.typeText("Ada Lovelace")
    harness.mockInput.pressEnter()
    await waitFor("the command", () => calls().length === 1)
    expect(calls()[0]).toEqual({ id: "new_character", args: { system: "coc7", name: "Ada Lovelace" } })
    const sheet = await screen("the sheet and its actions", (text) => text.includes("Edit the sheet") && text.includes("Ada Lovelace"))
    expect(sheet).toContain("外貌")
    expect(sheet).toContain("Spot Hidden")
  })

  test("a refused creation keeps the form and shows the server's reason", async () => {
    const server = new FakeServer()
    server.views.set("me", ME_NONE)
    server.views.set("characters", SYSTEMS)
    server.onCall = () => ({ ok: false, code: "name_taken", message: "Someone at this table is already called Ada." })
    const { harness, screen } = await open(server)
    await screen("the create form", (text) => text.includes("Call of Cthulhu 7e"))
    harness.mockInput.pressEnter()
    await pump()
    await harness.mockInput.typeText("Ada")
    harness.mockInput.pressEnter()
    const frame = await screen("the reason", (text) => text.includes("already called Ada."))
    expect(frame).toContain("Rule system")
  })

  test("edit the sheet: pick a stat, type a value, sheet set with a typed write; a derived attribute is not offered", async () => {
    const server = new FakeServer()
    // Max HP is derived: listed first, but the server would refuse to set it, so the editor starts at STR.
    server.views.set("me", { ...ME_NONE, character: { ...SHEET, attributes: [{ key: "HPMAX", label: "Max HP", value: 13, derived: true }, ...SHEET.attributes] } })
    server.views.set("characters", { ...SYSTEMS, mine: "ch-1" })
    server.onCall = () => ({ ok: true, text: "Ada Lovelace: STR 70" })
    const { harness, screen, calls } = await open(server)
    await screen("the actions", (text) => text.includes("Edit the sheet"))
    harness.mockInput.pressArrow("down")
    await pump()
    harness.mockInput.pressEnter()
    await screen("the editor", (text) => text.includes("Pick a value"))
    await pump()
    harness.mockInput.pressEnter()
    await pump()
    await harness.mockInput.typeText("70")
    await screen("the typed value", (text) => text.includes("70"))
    harness.mockInput.pressEnter()
    await waitFor("the write", () => calls().length === 1)
    expect(calls()[0]).toEqual({ id: "sheet", args: { op: "set", writes: [{ name: "STR", op: "=", value: "70" }] } })
    await screen("the answer", (text) => text.includes("Ada Lovelace: STR 70"))
  })

  test("rename, release and a confirmed delete are the rename, pc release and sheet clear commands", async () => {
    const server = new FakeServer()
    server.views.set("me", ME_SHEET)
    server.views.set("characters", { ...SYSTEMS, mine: "ch-1" })
    const { harness, screen, calls } = await open(server)
    await screen("the actions", (text) => text.includes("Rename"))
    const go = async (downs: number) => {
      for (let i = 0; i < downs; i += 1) {
        harness.mockInput.pressArrow("down")
        await pump()
      }
      harness.mockInput.pressEnter()
      await pump()
    }
    await go(2)
    await screen("the rename field", (text) => text.includes("Enter rename"))
    for (let i = 0; i < 12; i += 1) harness.mockInput.pressBackspace()
    await harness.mockInput.typeText("Ada King")
    harness.mockInput.pressEnter()
    await waitFor("the rename", () => calls().length === 1)
    expect(calls()[0]).toEqual({ id: "rename", args: { name: "Ada King" } })
    await screen("back on the actions", (text) => text.includes("Release my character"))
    await go(4)
    await waitFor("the release", () => calls().length === 2)
    expect(calls()[1]).toEqual({ id: "pc", args: { op: "release" } })
    await screen("back on the actions", (text) => text.includes("Delete my character"))
    await go(5)
    await screen("the confirmation", (text) => text.includes("Confirm delete character"))
    harness.mockInput.pressEnter()
    await waitFor("the delete", () => calls().length === 3)
    expect(calls()[2]).toEqual({ id: "sheet", args: { op: "clear" } })
  })

  test("from the actions: claim lists the characters on offer and runs pc claim", async () => {
    const server = new FakeServer()
    server.views.set("me", ME_SHEET)
    server.views.set("characters", { ...SYSTEMS, mine: "ch-1", claimable: [{ id: "pre-7", name: "Professor Armitage", blurb: "Head librarian.", source: { kind: "pack", id: "p" }, player: null }] })
    const { harness, screen, calls } = await open(server)
    await screen("the actions", (text) => text.includes("Claim a ready-made character"))
    harness.mockInput.pressArrow("down")
    await pump()
    harness.mockInput.pressEnter()
    await screen("the offer", (text) => text.includes("Professor Armitage") && text.includes("Head librarian."))
    harness.mockInput.pressEnter()
    await waitFor("the claim", () => calls().length === 1)
    expect(calls()[0]).toEqual({ id: "pc", args: { op: "claim", name: "pre-7" } })
  })

  test("import a character card: the file is uploaded for import, then import {file, as: character}; the answer shows here", async () => {
    const server = new FakeServer()
    server.views.set("me", ME_SHEET)
    server.views.set("characters", { ...SYSTEMS, mine: "ch-1" })
    const dir = await mkdtemp(join(tmpdir(), "lw-card-"))
    await writeFile(join(dir, "ada.json"), JSON.stringify({ spec: "chara_card_v2", data: { name: "Ada" } }))
    server.onCall = (method, params) => {
      if (method === "command.run" && params.id === "import") return { ok: true, text: "Imported Ada (Call of Cthulhu 7e). Left behind: hooks ×1" }
      return { ok: true }
    }
    const { harness, screen, calls } = await open(server)
    await screen("the actions", (text) => text.includes("Import a character card"))
    // New, Edit, Rename, Re-derive, Release, Delete, Import.
    for (let i = 0; i < 6; i += 1) {
      harness.mockInput.pressArrow("down")
      await pump()
    }
    harness.mockInput.pressEnter()
    await screen("the import form", (text) => text.includes("Card file"))
    await harness.mockInput.typeText(dir)
    harness.mockInput.pressEnter()
    await screen("a folder refused", (text) => text.includes("That is a folder, not a file"))
    await harness.mockInput.typeText("/ada.json")
    harness.mockInput.pressEnter()
    await screen("the answer", (text) => text.includes("Imported Ada (Call of Cthulhu 7e). Left behind: hooks ×1"))
    const offer = server.offered[0] as { sha256: string; purpose: string; mime: string }
    expect(offer).toMatchObject({ purpose: "import", mime: "application/json", name: "ada.json" })
    expect(calls().at(-1)).toEqual({ id: "import", args: { file: offer.sha256, as: "character" } })
  })
})
