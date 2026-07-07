import { describe, expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { PNG } from "pngjs"
import { detectAudioMime, detectImageMime, droppedImagePath, halfBlockPreviewSize, renderHalfBlockPreview } from "./media"

describe("media preview", () => {
  test("renders two vertical pixels as one half-block cell", async () => {
    const png = new PNG({ width: 1, height: 2 })
    png.data.set([255, 0, 0, 255], 0)
    png.data.set([0, 0, 255, 255], 4)
    const bytes = new Uint8Array(PNG.sync.write(png))

    const lines = await renderHalfBlockPreview(bytes, "image/png", 1, 1)

    expect(lines).toHaveLength(1)
    expect(lines[0].text).toBe("▀")
    expect(lines[0].cells[0]).toEqual({ char: "▀", fg: "#ff0000", bg: "#0000ff" })
  })

  test("recognizes dropped image paths and audio extensions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lw-media-"))
    const path = join(dir, "handout.png")
    await writeFile(path, new Uint8Array([1, 2, 3]))

    expect(droppedImagePath(pathToFileURL(path).toString())).toBe(path)
    expect(detectImageMime("map.svg")).toBe("image/svg+xml")
    expect(detectAudioMime("theme.flac")).toBe("audio/flac")
  })

  test("renders a simple SVG map as terminal text", async () => {
    const svg = new TextEncoder().encode(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 60">
        <rect x="10" y="10" width="40" height="30" />
        <text x="30" y="25">Library</text>
      </svg>
    `)

    const lines = await renderHalfBlockPreview(svg, "image/svg+xml", 40, 10)
    const text = lines.map((line) => line.text).join("\n")

    expect(text).toContain("Library")
    expect(text).toContain("+")
  })

  test("renders SVG text conservatively", async () => {
    const svg = new TextEncoder().encode(`
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 60">
        <text x="30" y="20">A &amp; B</text>
        <text x="30" y="30"><tspan>Hidden</tspan></text>
        <text x="30" y="40">&amp;lt;not-tag&amp;gt;</text>
      </svg>
    `)

    const lines = await renderHalfBlockPreview(svg, "image/svg+xml", 60, 12)
    const text = lines.map((line) => line.text).join("\n")

    expect(text).toContain("A & B")
    expect(text).not.toContain("Hidden")
    expect(text).toContain("&lt;not-tag&gt;")
  })

  test("caps adaptive half-block preview size", () => {
    expect(halfBlockPreviewSize(120, 80)).toEqual({ width: 56, height: 28 })
    expect(halfBlockPreviewSize(10, 4)).toEqual({ width: 16, height: 8 })
  })
})
