import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import type { PackCardEntry, PregenEntry } from "loreweaver-protocol"
import type { AppClient } from "../client"
import { sidebarWidth } from "../layout"
import { themes } from "../themes"
import { PartyRoster, pregenBlurb, pregenClaimer } from "./PartyRoster"

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

describe("PartyRoster pregen labels (v2.5)", () => {
  const LABELLED: PregenEntry[] = [
    { name: "沈拾遗", claimed_by: "", blurb: "档案馆的抄写员 记性好得过分 什么都忘不掉" },
    { name: "关五", claimed_by: "tui:1a2b3c4d", claimed_by_name: "阿岚" },
    { name: "Mary", claimed_by: "p2" },
  ]

  test("pregenClaimer prefers the stored display name and falls back to the member id", () => {
    expect(pregenClaimer({ name: "x", claimed_by: "tui:1a2b3c4d", claimed_by_name: "Ada" })).toBe("Ada")
    expect(pregenClaimer({ name: "x", claimed_by: "tui:1a2b3c4d", claimed_by_name: "" })).toBe("tui:1a2b3c4d")
    expect(pregenClaimer({ name: "x", claimed_by: "tui:1a2b3c4d" })).toBe("tui:1a2b3c4d")
    expect(pregenClaimer({ name: "x", claimed_by: "p", claimed_by_name: "A\x1b[2Jda" })).toBe("A[2Jda")
  })

  test("pregenBlurb is one line, control-free, empty when absent", () => {
    expect(pregenBlurb({ name: "x", claimed_by: "", blurb: "a\n  b\x07" })).toBe("a b")
    expect(pregenBlurb({ name: "x", claimed_by: "" })).toBe("")
  })

  test("a claimed row names the claimer; an unclaimed row shows its blurb dim and truncated", async () => {
    const recorder = new ClaimRecorder()
    const { renderer, flush, captureCharFrame } = await renderRoster(recorder, LABELLED, { locale: "zh" })
    await flush()

    const frame = captureCharFrame()
    expect(frame).toContain("已被 阿岚 认领")
    expect(frame).not.toContain("tui:1a2b3c4d")
    expect(frame).toContain("已被 p2 认领") // a pre-2.5 entry still names its claimer by id
    const lines = frame.split("\n")
    const nameY = lines.findIndex((line) => line.includes("沈拾遗"))
    expect(lines[nameY + 1]).toContain("档案馆")
    // The sidebar never overflows: the blurb is truncated, never wrapped or spilled.
    expect(lines.every((line) => Bun.stringWidth(line) <= SIDEBAR_COLUMNS)).toBe(true)

    act(() => renderer.destroy())
  })

  // OpenTUI's own `truncate` miscounts CJK width and returns a line one cell wider than
  // its box, so PartyRoster cuts the blurb itself. These are long UNBROKEN runs, with and
  // without full-width commas — the fixture that used to be here dodged exactly that.
  const LONG_BLURBS = [
    "档案馆的抄写员记性好得过分什么都忘不掉连别人的秘密也是啊",
    "档案馆的抄写员，记性好得过分，什么都忘不掉，连别人的秘密也是啊",
    "A scribe of the archive who remembers far too much 档案馆的抄写员记性好得过分",
  ]

  for (const columns of [sidebarWidth(120), sidebarWidth(60)]) {
    test(`a long CJK blurb never overflows a ${columns}-column sidebar`, async () => {
      const recorder = new ClaimRecorder()
      const pregens: PregenEntry[] = [
        ...LONG_BLURBS.map((blurb, index) => ({ name: `沈拾遗${index}`, claimed_by: "", blurb })),
        { name: "关五", claimed_by: "tui:1a2b3c4d", claimed_by_name: "档案馆的抄写员记性好得过分什么都忘不掉" },
      ]
      const { renderer, flush, captureCharFrame } = await testRender(
        <PartyRoster
          party={[]}
          initiative={[]}
          theme={theme}
          locale="zh"
          client={asClient(recorder)}
          focused={false}
          onFocus={() => {}}
          pregens={pregens}
        />,
        { width: columns, height: 16 },
      )
      await flush()

      const lines = captureCharFrame().split("\n")
      expect(lines.some((line) => line.includes("档案馆"))).toBe(true)
      expect(lines.some((line) => line.includes("…"))).toBe(true)
      for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(columns)

      act(() => renderer.destroy())
    })
  }

  test("clicking an unclaimed pregen's blurb line claims it too", async () => {
    const recorder = new ClaimRecorder()
    const { renderer, flush, captureCharFrame, mockMouse } = await renderRoster(recorder, LABELLED, { locale: "zh" })
    await flush()

    const lines = captureCharFrame().split("\n")
    const blurbY = lines.findIndex((line) => line.includes("档案馆"))
    expect(blurbY).toBeGreaterThan(0)
    await act(async () => {
      await mockMouse.click(4, blurbY)
    })
    await flush()
    expect(recorder.sent).toEqual([".pc claim 沈拾遗"])

    act(() => renderer.destroy())
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
    expect(pilotLine).not.toContain("[A]")

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
    expect(lines[y]).toContain("[A] customs")
    expect(lines[y].indexOf("[A]")).toBeLessThan(lines[y].indexOf("customs"))
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
