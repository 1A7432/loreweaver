import { describe, expect, test } from "bun:test"
import { headerVisibility, sidebarCollapsed, sidebarWidth } from "./layout"

describe("responsive layout policy", () => {
  test("header metadata drops usage, cache, clock, then scene", () => {
    expect(headerVisibility(120)).toEqual({ usage: true, cache: true, clock: true, scene: true })
    expect(headerVisibility(110)).toEqual({ usage: false, cache: true, clock: true, scene: true })
    expect(headerVisibility(100)).toEqual({ usage: false, cache: false, clock: true, scene: true })
    expect(headerVisibility(90)).toEqual({ usage: false, cache: false, clock: false, scene: true })
    expect(headerVisibility(80)).toEqual({ usage: false, cache: false, clock: false, scene: false })
  })

  test("80-column screens collapse the sidebar and any visible sidebar stays bounded", () => {
    expect(sidebarCollapsed(80)).toBe(true)
    expect(sidebarCollapsed(110)).toBe(false)
    expect(sidebarWidth(80)).toBeLessThanOrEqual(32)
    expect(sidebarWidth(80)).toBeLessThanOrEqual(Math.floor(80 * 0.4))
  })
})
