import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { PNG } from "pngjs"
import {
  chooseViewerMode,
  fitDisplayCells,
  fitImageToArea,
  iterm2ImageSequence,
  kittyDeleteSequence,
  kittyImageSequences,
  parseWindowPixelSize,
  pngDimensions,
  toPngBytes,
  viewImage,
} from "./imageViewer"

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function clientFor(bytes: Uint8Array, mime = "image/png") {
  const digest = hash(bytes)
  return {
    getMedia: async () => ({ hash: digest, mime, name: "image.png", bytes }),
  } as never
}

describe("image viewer", () => {
  test("chooses graphics paths by priority", () => {
    expect(chooseViewerMode({ kitty_graphics: true, sixel: true })).toBe("kitty")
    expect(chooseViewerMode({ kitty_graphics: false, sixel: true }, { TERM_PROGRAM: "iTerm.app" })).toBe("iterm2")
    expect(chooseViewerMode({ kitty_graphics: false, sixel: true }, {})).toBe("sixel")
    expect(chooseViewerMode({ kitty_graphics: false, sixel: false }, {})).toBe("modal")
  })

  test("builds kitty and iTerm2 image sequences", () => {
    const bytes = new Uint8Array(5000).fill(7)
    const kitty = kittyImageSequences(bytes, 40, 20)
    expect(kitty.length).toBeGreaterThan(1)
    expect(kitty[0]).toContain("\x1b_Ga=T,f=100,q=2,c=40,r=20,m=1;")
    expect(kitty.at(-1)).toContain("m=0;")
    // The kitty protocol rejects images whose continuation chunks carry anything but `m`.
    for (const chunk of kitty.slice(1)) {
      expect(chunk).toMatch(/^\x1b_Gm=[01];/)
    }
    expect(kittyDeleteSequence()).toBe("\x1b_Ga=d,d=A\x1b\\")

    const iterm = iterm2ImageSequence(new Uint8Array([1, 2, 3]), 50)
    expect(iterm).toContain("\x1b]1337;File=inline=1;size=3;width=50;preserveAspectRatio=1:")
    expect(iterm.endsWith("\x07")).toBe(true)
  })

  test("kitty payloads are PNG-shaped with an aspect-preserving cell box", () => {
    const png = new PNG({ width: 4, height: 2 })
    const pngBytes = new Uint8Array(PNG.sync.write(png))
    expect(toPngBytes(pngBytes, "image/png")).toBe(pngBytes) // png passes through untouched
    expect(pngDimensions(pngBytes)).toEqual({ width: 4, height: 2 })
    expect(pngDimensions(new Uint8Array([1, 2, 3]))).toBeUndefined()
    // A 400x100 image in an 80x24 grid: width-bound, height derived via the 1:2 cell aspect.
    expect(fitDisplayCells(400, 100, 80, 24)).toEqual({ columns: 80, rows: 10 })
  })

  test("parses pixel-size replies and fits sixel images proportionally", () => {
    expect(parseWindowPixelSize("\x1b[4;720;1280t")).toEqual({ width: 1280, height: 720 })
    expect(parseWindowPixelSize("nope")).toBeUndefined()
    expect(fitImageToArea(400, 200, 120, 120)).toEqual({ width: 120, height: 60 })
  })

  test("svg always takes the modal text-map path even when kitty is available", async () => {
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><text x="1" y="5">Map</text></svg>')
    const events: string[] = []
    const lines = await viewImage({
      client: clientFor(svg, "image/svg+xml"),
      media: { hash: hash(svg), mime: "image/svg+xml", name: "map.svg", size: svg.byteLength },
      renderer: { capabilities: { kitty_graphics: true }, suspend: () => events.push("suspend"), resume: () => events.push("resume") },
      write: () => events.push("write"),
      columns: 20,
      rows: 10,
      env: {},
    })
    expect(lines?.length).toBeGreaterThan(0)
    expect(events).toEqual([]) // no suspend, no raw writes — the renderer stays in charge
  })

  test("kitty path suspends writes deletes and resumes", async () => {
    const bytes = new Uint8Array([1, 2, 3])
    const events: string[] = []
    await viewImage({
      client: clientFor(bytes),
      media: { hash: hash(bytes), mime: "image/png", name: "image.png", size: bytes.byteLength },
      renderer: { capabilities: { kitty_graphics: true }, suspend: () => events.push("suspend"), resume: () => events.push("resume") },
      write: (text) => events.push(text.includes("a=d") ? "delete" : "write"),
      readKey: async () => events.push("read"),
      columns: 20,
      rows: 10,
    })

    expect(events[0]).toBe("suspend")
    expect(events).toContain("delete")
    expect(events.at(-1)).toBe("resume")
  })

  test("sixel path uses suspend flow and modal path returns halfblock lines", async () => {
    const png = new PNG({ width: 1, height: 1 })
    png.data.set([255, 0, 0, 255], 0)
    const bytes = new Uint8Array(PNG.sync.write(png))
    const media = { hash: hash(bytes), mime: "image/png", name: "image.png", size: bytes.byteLength }
    const events: string[] = []

    await viewImage({
      client: clientFor(bytes),
      media,
      renderer: { capabilities: { sixel: true }, suspend: () => events.push("suspend"), resume: () => events.push("resume") },
      write: (text) => events.push(text.startsWith("\x1bPq") ? "sixel" : "write"),
      readKey: async () => events.push("read"),
      queryWindowPixels: async () => ({ width: 20, height: 40 }),
      columns: 2,
      rows: 2,
      env: {},
    })
    expect(events).toContain("sixel")
    expect(events.at(-1)).toBe("resume")

    const lines = await viewImage({
      client: clientFor(bytes),
      media,
      renderer: { capabilities: { sixel: false, kitty_graphics: false } },
      columns: 2,
      rows: 2,
      env: {},
    })
    expect(lines?.length).toBeGreaterThan(0)
  })
})
