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

  test("binaryUrlsFor yields ONLY the GitHub release (the small mirror VPS never carries bundles)", () => {
    const asset = "loreweaver-server-linux-x64.tar.gz"
    expect(binaryUrlsFor(asset)).toEqual([
      `https://github.com/1A7432/loreweaver/releases/download/latest/${asset}`,
    ])
  })

  test("binaryUrlsFor can pin a versioned release tag", () => {
    const oldRelease = process.env.TRPG_RELEASE_TAG
    const oldServerRelease = process.env.TRPG_SERVER_RELEASE_TAG
    process.env.TRPG_RELEASE_TAG = "release-0.5.1.dev29+g0cf542b"
    delete process.env.TRPG_SERVER_RELEASE_TAG
    try {
      expect(binaryUrlsFor("loreweaver-server-linux-x64.tar.gz")).toEqual([
        "https://github.com/1A7432/loreweaver/releases/download/release-0.5.1.dev29%2Bg0cf542b/loreweaver-server-linux-x64.tar.gz",
      ])
    } finally {
      if (oldRelease === undefined) delete process.env.TRPG_RELEASE_TAG
      else process.env.TRPG_RELEASE_TAG = oldRelease
      if (oldServerRelease === undefined) delete process.env.TRPG_SERVER_RELEASE_TAG
      else process.env.TRPG_SERVER_RELEASE_TAG = oldServerRelease
    }
  })

  test("binaryUrlsFor threads the asset name through unchanged for every platform", () => {
    for (const asset of [
      "loreweaver-server-macos-arm64.tar.gz",
      "loreweaver-server-linux-arm64.tar.gz",
      "loreweaver-server-windows-x64.zip",
    ]) {
      const urls = binaryUrlsFor(asset)
      expect(urls).toHaveLength(1)
      expect(urls[0]).toContain(asset)
      expect(urls[0]?.startsWith("https://github.com/")).toBe(true)
    }
  })
})
