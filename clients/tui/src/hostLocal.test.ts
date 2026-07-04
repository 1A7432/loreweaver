import { describe, expect, test } from "bun:test"
import { assetNameFor, binaryUrlsFor } from "./hostLocal"

describe("hostLocal — binary acquisition mapping (pure helpers only; no process spawning here)", () => {
  test("assetNameFor covers the four published (platform, arch) pairs", () => {
    expect(assetNameFor("darwin", "arm64")).toBe("loreweaver-server-macos-arm64.tar.gz")
    expect(assetNameFor("linux", "x64")).toBe("loreweaver-server-linux-x64.tar.gz")
    expect(assetNameFor("linux", "arm64")).toBe("loreweaver-server-linux-arm64.tar.gz")
    expect(assetNameFor("win32", "x64")).toBe("loreweaver-server-windows-x64.zip")
  })

  test("assetNameFor returns undefined for an unpublished pair (darwin/x64)", () => {
    expect(assetNameFor("darwin", "x64")).toBeUndefined()
  })

  test("assetNameFor returns undefined for an unknown platform/arch entirely", () => {
    expect(assetNameFor("freebsd", "x64")).toBeUndefined()
    expect(assetNameFor("darwin", "ia32")).toBeUndefined()
    expect(assetNameFor("", "")).toBeUndefined()
  })

  test("binaryUrlsFor yields the GitHub release first, then the site mirror, in order", () => {
    const asset = "loreweaver-server-linux-x64.tar.gz"
    expect(binaryUrlsFor(asset)).toEqual([
      `https://github.com/1A7432/loreweaver/releases/download/latest/${asset}`,
      `https://1a7432.site/trpg/${asset}`,
    ])
  })

  test("binaryUrlsFor threads the asset name through unchanged for every platform", () => {
    for (const asset of [
      "loreweaver-server-macos-arm64.tar.gz",
      "loreweaver-server-linux-arm64.tar.gz",
      "loreweaver-server-windows-x64.zip",
    ]) {
      const urls = binaryUrlsFor(asset)
      expect(urls).toHaveLength(2)
      expect(urls[0]).toContain(asset)
      expect(urls[1]).toContain(asset)
      expect(urls[0]?.startsWith("https://github.com/")).toBe(true)
      expect(urls[1]?.startsWith("https://1a7432.site/")).toBe(true)
    }
  })
})
