import { describe, expect, test } from "bun:test"
import { encodeSixel, paletteIndexForRgb } from "./sixel"

describe("sixel", () => {
  test("quantizes RGB into the fixed palette", () => {
    expect(paletteIndexForRgb(0, 0, 0)).toBe(0)
    expect(paletteIndexForRgb(255, 255, 255)).toBe(251)
    expect(paletteIndexForRgb(255, 0, 0)).toBe(210)
  })

  test("encodes a small image with DCS header palette rows and ST", () => {
    const data = new Uint8Array(2 * 6 * 4)
    for (let y = 0; y < 6; y++) {
      for (let x = 0; x < 2; x++) {
        const offset = (y * 2 + x) * 4
        data[offset] = x === 0 ? 255 : 0
        data[offset + 1] = x === 0 ? 0 : 255
        data[offset + 2] = 0
        data[offset + 3] = 255
      }
    }

    const sixel = encodeSixel({ width: 2, height: 6, data })

    expect(sixel.startsWith("\x1bPq")).toBe(true)
    expect(sixel).toContain("#0;2;0;0;0")
    expect(sixel).toContain("#210")
    expect(sixel).toContain("~")
    expect(sixel.endsWith("\x1b\\")).toBe(true)
  })
})
