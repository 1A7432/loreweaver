import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import type { PackCardEntry, PregenEntry } from "loreweaver-protocol"
import type { AppClient } from "../client"
import { sidebarWidth } from "../layout"
import { themes } from "../themes"
import { PartyRoster } from "./PartyRoster"

const theme = themes.lamplight

// Only `sendInput` is exercised: no avatars in these fixtures, so the media
// methods are never reached.
class ClaimRecorder {
  sent: string[] = []
  sendInput(text: string): void {
    this.sent.push(text)
  }
}

function asClient(recorder: ClaimRecorder): AppClient {
  return recorder as unknown as AppClient
}

const PREGENS: PregenEntry[] = [
  { name: "Harvey", claimed_by: "" },
  { name: "Mary", claimed_by: "p2" },
]

// The REAL width this panel gets in GameView: the sidebar is clamped to 32 columns
// at every terminal size (`layout.sidebarWidth`), so rendering wider than that would
// hide row truncation — exactly the bug that let a world-card marker fall off the end.
const SIDEBAR_COLUMNS = sidebarWidth(120)

function renderRoster(
  recorder: ClaimRecorder,
  pregens?: PregenEntry[],
  options: { focused?: boolean; locale?: string; packCards?: PackCardEntry[]; isKeeper?: boolean } = {},
) {
  return testRender(
    <PartyRoster
      party={[]}
      initiative={[]}
      theme={theme}
      locale={options.locale ?? "en"}
      client={asClient(recorder)}
      focused={options.focused ?? false}
      onFocus={() => {}}
      pregens={pregens}
      packCards={options.packCards}
      isKeeper={options.isKeeper}
    />,
    { width: SIDEBAR_COLUMNS, height: 14 },
  )
}

describe("PartyRoster pregen section (v1.9)", () => {
  test("unclaimed entries render interactive; claimed ones dim with the claimer", async () => {
    const recorder = new ClaimRecorder()
    const { renderer, flush, captureCharFrame } = await renderRoster(recorder, PREGENS)
    await flush()

    const frame = captureCharFrame()
    expect(frame).toContain("PREGENS")
    expect(frame).toContain("▸ Harvey")
    expect(frame).toContain("✓ Mary")
    expect(frame).toContain("claimed by p2")

    act(() => renderer.destroy())
  })

  test("renders the zh section header", async () => {
    const recorder = new ClaimRecorder()
    const { renderer, flush, captureCharFrame } = await renderRoster(recorder, PREGENS, { locale: "zh" })
    await flush()
    expect(captureCharFrame()).toContain("预设角色")
    act(() => renderer.destroy())
  })

  test("clicking an unclaimed row sends .pc claim; a claimed row is inert", async () => {
    const recorder = new ClaimRecorder()
    const { renderer, flush, captureCharFrame, mockMouse } = await renderRoster(recorder, PREGENS)
    await flush()

    const lines = captureCharFrame().split("\n")
    const harveyY = lines.findIndex((line) => line.includes("Harvey"))
    expect(harveyY).toBeGreaterThan(0)
    await act(async () => {
      await mockMouse.click(lines[harveyY].indexOf("Harvey"), harveyY)
    })
    await flush()
    expect(recorder.sent).toEqual([".pc claim Harvey"])

    const maryY = lines.findIndex((line) => line.includes("Mary"))
    expect(maryY).toBeGreaterThan(0)
    await act(async () => {
      await mockMouse.click(lines[maryY].indexOf("Mary"), maryY)
    })
    await flush()
    expect(recorder.sent).toEqual([".pc claim Harvey"])

    act(() => renderer.destroy())
  })

  test("Enter while the panel is focused claims the first unclaimed pregen", async () => {
    const recorder = new ClaimRecorder()
    const { renderer, flush, mockInput } = await renderRoster(recorder, PREGENS, { focused: true })
    await flush()

    await act(async () => {
      mockInput.pressEnter()
    })
    await flush()
    expect(recorder.sent).toEqual([".pc claim Harvey"])

    act(() => renderer.destroy())
  })

  test("absent or empty pregens render no section at all", async () => {
    const recorder = new ClaimRecorder()
    const absent = await renderRoster(recorder, undefined)
    await absent.flush()
    expect(absent.captureCharFrame()).not.toContain("PREGENS")
    act(() => absent.renderer.destroy())

    const empty = await renderRoster(recorder, [])
    await empty.flush()
    expect(empty.captureCharFrame()).not.toContain("PREGENS")
    act(() => empty.renderer.destroy())

    expect(recorder.sent).toEqual([])
  })
})

const PACK_CARDS: PackCardEntry[] = [
  { ref: "harbour/cards/pilot.json", pack: "harbour", name: "pilot" },
  { ref: "harbour/cards/medic.png", pack: "harbour", name: "medic" },
]

describe("PartyRoster pack-card import section (v2.2)", () => {
  test("renders each card's name and pack id under the section header", async () => {
    const recorder = new ClaimRecorder()
    const { renderer, flush, captureCharFrame } = await renderRoster(recorder, undefined, { packCards: PACK_CARDS })
    await flush()

    const frame = captureCharFrame()
    expect(frame).toContain("PACK CARDS")
    expect(frame).toContain("▸ pilot · harbour")
    expect(frame).toContain("▸ medic · harbour")
    // A character card carries no kind marker at all.
    const pilotLine = frame.split("\n").find((line) => line.includes("pilot")) ?? ""
    expect(pilotLine).not.toContain("[W]")
    expect(pilotLine).not.toContain("[K]")

    act(() => renderer.destroy())
  })

  test("renders the zh section header", async () => {
    const recorder = new ClaimRecorder()
    const { renderer, flush, captureCharFrame } = await renderRoster(recorder, undefined, {
      packCards: PACK_CARDS,
      locale: "zh",
    })
    await flush()
    expect(captureCharFrame()).toContain("扩展包卡片")
    act(() => renderer.destroy())
  })

  test("clicking a row sends `.import <ref> pc`", async () => {
    const recorder = new ClaimRecorder()
    const { renderer, flush, captureCharFrame, mockMouse } = await renderRoster(recorder, undefined, {
      packCards: PACK_CARDS,
    })
    await flush()

    const lines = captureCharFrame().split("\n")
    const medicY = lines.findIndex((line) => line.includes("medic"))
    expect(medicY).toBeGreaterThan(0)
    await act(async () => {
      await mockMouse.click(lines[medicY].indexOf("medic"), medicY)
    })
    await flush()
    expect(recorder.sent).toEqual([".import harbour/cards/medic.png pc"])

    act(() => renderer.destroy())
  })

  test("a world card imports with the WORLD verb for a keeper, not `pc`", async () => {
    // The bug this pins: every client hard-coded `pc`, so a keeper clicking the
    // module's own world card asked the server to build a PC out of a module.
    const recorder = new ClaimRecorder()
    const { renderer, flush, captureCharFrame, mockMouse } = await renderRoster(recorder, undefined, {
      packCards: [{ ref: "mistwharf/cards/customs.json", pack: "mistwharf", name: "customs", kind: "world" }],
      isKeeper: true,
    })
    await flush()

    const lines = captureCharFrame().split("\n")
    const y = lines.findIndex((line) => line.includes("customs"))
    expect(y).toBeGreaterThan(0)
    // The marker LEADS the row: at the real sidebar width a trailing one is the
    // first thing `truncate` eats, which is why it used to be invisible in play.
    expect(lines[y]).toContain("[W] customs")
    expect(lines[y].indexOf("[W]")).toBeLessThan(lines[y].indexOf("customs"))
    await act(async () => {
      await mockMouse.click(lines[y].indexOf("customs"), y)
    })
    await flush()
    expect(recorder.sent).toEqual([".import mistwharf/cards/customs.json world"])

    act(() => renderer.destroy())
  })

  test("a player's world-card row is inert and says so", async () => {
    const recorder = new ClaimRecorder()
    const { renderer, flush, captureCharFrame, mockMouse } = await renderRoster(recorder, undefined, {
      packCards: [{ ref: "mistwharf/cards/customs.json", pack: "mistwharf", name: "customs", kind: "world" }],
      isKeeper: false,
    })
    await flush()

    const lines = captureCharFrame().split("\n")
    const y = lines.findIndex((line) => line.includes("customs"))
    expect(lines[y]).toContain("[K] customs")
    expect(lines[y].indexOf("[K]")).toBeLessThan(lines[y].indexOf("customs"))
    await act(async () => {
      await mockMouse.click(lines[y].indexOf("customs"), y)
    })
    await flush()
    // The server would refuse it anyway; the picker simply stops offering the click.
    expect(recorder.sent).toEqual([])

    act(() => renderer.destroy())
  })

  test("a card with no kind still imports as `pc` (a pre-2.3 server)", async () => {
    const recorder = new ClaimRecorder()
    const { renderer, flush, captureCharFrame, mockMouse } = await renderRoster(recorder, undefined, {
      packCards: [{ ref: "harbour/cards/pilot.json", pack: "harbour", name: "pilot" }],
    })
    await flush()

    const lines = captureCharFrame().split("\n")
    const y = lines.findIndex((line) => line.includes("pilot"))
    await act(async () => {
      await mockMouse.click(lines[y].indexOf("pilot"), y)
    })
    await flush()
    expect(recorder.sent).toEqual([".import harbour/cards/pilot.json pc"])

    act(() => renderer.destroy())
  })

  test("Enter never imports: the section is click-only even while the panel is focused", async () => {
    const recorder = new ClaimRecorder()
    const { renderer, flush, mockInput } = await renderRoster(recorder, undefined, {
      packCards: PACK_CARDS,
      focused: true,
    })
    await flush()

    await act(async () => {
      mockInput.pressEnter()
    })
    await flush()
    expect(recorder.sent).toEqual([])

    act(() => renderer.destroy())
  })

  test("absent or empty cards render no section at all", async () => {
    const recorder = new ClaimRecorder()
    const absent = await renderRoster(recorder, undefined)
    await absent.flush()
    expect(absent.captureCharFrame()).not.toContain("PACK CARDS")
    act(() => absent.renderer.destroy())

    const empty = await renderRoster(recorder, undefined, { packCards: [] })
    await empty.flush()
    expect(empty.captureCharFrame()).not.toContain("PACK CARDS")
    act(() => empty.renderer.destroy())

    expect(recorder.sent).toEqual([])
  })
})
