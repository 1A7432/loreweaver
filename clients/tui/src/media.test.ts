import { describe, expect, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { PNG } from "pngjs"
import { detectAudioMime, detectImageMime, droppedImagePath, halfBlockPreviewSize, LocalFileError, readLocalFile, renderHalfBlockPreview, sniffImageMime } from "./media"

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

describe("reading a file a person names", () => {
  test("reads the one file, by its name's type; ~ is expanded", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lw-file-"))
    await writeFile(join(dir, "card.json"), '{"name":"Ada"}')
    const file = await readLocalFile(join(dir, "card.json"), "card")
    expect(file).toMatchObject({ name: "card.json", mime: "application/json" })
    expect(new TextDecoder().decode(file.bytes)).toBe('{"name":"Ada"}')
    const home = process.env.HOME
    process.env.HOME = dir
    try {
      expect((await readLocalFile("~/card.json", "card")).name).toBe("card.json")
    } finally {
      process.env.HOME = home
    }
  })

  test("refuses a directory, a missing file, a wrong type, an empty file and one over the limit — before reading it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lw-file-"))
    await writeFile(join(dir, "big.png"), new Uint8Array(2048))
    await writeFile(join(dir, "notes.txt"), "hello")
    await writeFile(join(dir, "empty.png"), new Uint8Array(0))
    const code = (promise: Promise<unknown>) => promise.then(() => "read", (error: LocalFileError) => error.code)
    expect(await code(readLocalFile(dir, "image"))).toBe("is_directory")
    expect(await code(readLocalFile(join(dir, "nope.png"), "image"))).toBe("not_found")
    expect(await code(readLocalFile(join(dir, "notes.txt"), "image"))).toBe("bad_type")
    expect(await code(readLocalFile(join(dir, "empty.png"), "image"))).toBe("empty")
    expect(await code(readLocalFile(join(dir, "big.png"), "image", 1024))).toBe("too_large")
    expect(await code(readLocalFile("  ", "image"))).toBe("empty_path")
    expect(sniffImageMime(new Uint8Array([0xff, 0xd8, 0xff, 0]))).toBe("image/jpeg")
  })
})
