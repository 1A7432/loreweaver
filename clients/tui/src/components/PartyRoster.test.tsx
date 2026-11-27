import { afterEach, describe, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import type { PartyView } from "loreweaver-protocol/v3"
import { themes } from "../themes"
import { claimableBlurb, freeClaimables, PartyRoster } from "./PartyRoster"

const destroy: Array<() => void> = []
afterEach(() => {
  for (const done of destroy.splice(0)) act(done)
})

const PARTY: PartyView = {
  members: [
    { id: "m1", name: "Ada", role: "player", online: true, character: "ch-1" },
    { id: "m2", name: "Bao", role: null, online: false, character: "ch-2" },
    { id: "m3", name: "Cyd", role: "observer", online: true, character: null },
  ],
  characters: [
    { id: "ch-1", name: "Ada Lovelace", pack: "coc7", status: [], resources: [{ id: "hp", label: "HP", value: 11, max: 13 }], player: { id: "m1", name: "Ada" } },
    { id: "ch-2", name: "Reyes", pack: "coc7", status: [], resources: [{ id: "hp", label: "HP", value: 3, max: 12 }], player: { id: "m2", name: "Bao" } },
    { id: "ch-3", name: "Rex", pack: "coc7", status: [], resources: [], player: null },
  ],
  initiative: null,
}

const CLAIMABLE = {
  claimable: [
    { id: "p1", name: "Armitage", blurb: "Head\nlibrarian.", source: { kind: "pack" as const, id: "x" }, player: null },
    { id: "p2", name: "Wilmarth", blurb: "", source: { kind: "module" as const, id: "y" }, player: { id: "m2", name: "Bao" } },
  ],
  systems: [],
  mine: null,
}

describe("PartyRoster", () => {
  test("helpers: what is still on offer, a blurb on one line", () => {
    expect(freeClaimables(CLAIMABLE).map((entry) => entry.id)).toEqual(["p1"])
    expect(claimableBlurb(CLAIMABLE.claimable[0] as never)).toBe("Head librarian.")
  })

  test("other characters with their player and whether that member is online, a companion, a loose member, the offer", async () => {
    const claimed: string[] = []
    const { renderer, flush, captureCharFrame } = await testRender(
      <PartyRoster party={PARTY} characters={CLAIMABLE} theme={themes.lamplight} locale="en" focused={false} onFocus={() => {}} onClaim={(id) => claimed.push(id)} />,
      { width: 40, height: 20 },
    )
    destroy.push(() => renderer.destroy())
    await flush()
    const frame = captureCharFrame()
    expect(frame).toContain("No character yet")
    expect(frame).toContain("● Ada Lovelace · Ada")
    expect(frame).toContain("○ Reyes · Bao")
    expect(frame).toContain("Rex · companion")
    expect(frame).toContain("● Cyd")
    expect(frame).toContain("▸ Armitage")
    expect(frame).toContain("✓ Wilmarth · claimed by Bao")
  })

  test("a module's character: its module named, a resource with no maximum as its value, no sheet assumed; a module's free character is not offered to claim", async () => {
    const own = { id: "colony:ana", name: "Ana", pack: "", status: ["at the landing"], resources: [{ id: "food", label: "Food", value: 2 }], attributes: [], skills: [], module: "colony" }
    const cai = { id: "colony:cai", name: "Cai", pack: "", status: ["in the hall", "wounded"], resources: [], player: { id: "m2", name: "Bao" }, module: "colony" }
    const party: PartyView = { members: [{ id: "m1", name: "Ada", role: "player", online: true, character: "colony:ana" }], characters: [{ ...own, player: { id: "m1", name: "Ada" } }, cai], initiative: null }
    const offer = { claimable: [{ id: "colony:bo", name: "Bo", blurb: "", source: { kind: "module" as const, id: "colony" }, player: null }], systems: [], mine: "colony:ana" }
    expect(freeClaimables(offer)).toEqual([])
    const { renderer, flush, captureCharFrame } = await testRender(
      <PartyRoster character={own} party={party} characters={offer} theme={themes.lamplight} locale="en" focused={false} onFocus={() => {}} />,
      { width: 60, height: 16 },
    )
    destroy.push(() => renderer.destroy())
    await flush()
    const frame = captureCharFrame()
    expect(frame).toContain("Ana (you)")
    expect(frame).toContain("Food 2")
    // The module's own lines about each character, its own and another member's.
    expect(frame).toContain("· at the landing")
    expect(frame).toContain("· in the hall, wounded")
    expect(frame).toContain("Bo · kept by colony")
    expect(frame).not.toContain("▸ Bo")
  })
})
