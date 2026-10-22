import { describe, expect, test } from "bun:test"
import { testRender } from "@opentui/react/test-utils"
import { act } from "react"
import type { CharacterState } from "loreweaver-protocol"
import { sidebarWidth } from "../layout"
import { themes } from "../themes"
import { CharacterPanel } from "./CharacterPanel"

const LONG = "档案馆的抄写员记性好得过分什么都忘不掉连别人的秘密也是啊"

describe("CharacterPanel attribute rows (v2.5 labels)", () => {
  test("a long CJK attribute label never overflows the sidebar", async () => {
    const character: CharacterState = {
      name: "沈拾遗",
      system: "coc7",
      resources: [],
      attributes: { STR: 50, APP: 65 },
      attribute_labels: { APP: LONG, STR: "力量" },
      status_effects: [],
    }
    for (const columns of [sidebarWidth(120), sidebarWidth(60)]) {
      const { renderer, flush, captureCharFrame } = await testRender(
        <CharacterPanel character={character} theme={themes.lamplight} locale="zh" />,
        { width: columns, height: 10 },
      )
      await flush()
      const lines = captureCharFrame().split("\n")
      expect(lines.some((line) => line.includes("…"))).toBe(true)
      expect(lines.some((line) => line.includes("65"))).toBe(true) // the value survives the cut
      for (const line of lines) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(columns)
      act(() => renderer.destroy())
    }
  })
})
