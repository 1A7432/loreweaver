import { describe, expect, test } from "bun:test"
import { fitCells } from "./FitText"

describe("fitCells", () => {
  test("leaves text that already fits alone", () => {
    expect(fitCells("短文本", 6)).toBe("短文本")
    expect(fitCells("abc", 10)).toBe("abc")
  })

  test("cuts by terminal cells, never past the width, ending in an ellipsis", () => {
    const text = "档案馆的抄写员记性好得过分什么都忘不掉"
    for (let width = 1; width <= 30; width++) {
      const cut = fitCells(text, width)
      expect(Bun.stringWidth(cut)).toBeLessThanOrEqual(width)
      expect(cut.endsWith("…")).toBe(true)
    }
    expect(fitCells(text, 0)).toBe("")
  })

  test("middle mode keeps both ends", () => {
    const cut = fitCells("档案馆的抄写员记性好得过分什么都忘不掉 5/10", 20, "middle")
    expect(Bun.stringWidth(cut)).toBeLessThanOrEqual(20)
    expect(cut).toContain("档案")
    expect(cut).toContain("5/10")
    expect(cut).toContain("…")
  })
})
