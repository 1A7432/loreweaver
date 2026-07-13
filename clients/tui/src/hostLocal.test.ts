import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  IntegrityError,
  assetNameFor,
  binaryUrlsFor,
  fetchReleaseSha256,
  isSafeArchiveEntry,
  isSafeArchiveTypeLine,
  parseSha256Sidecar,
  replaceDirectory,
  sourceGitCloneArgs,
  sourceTarballUrl,
  verifiedCachedBinary,
  verifiedCachedSource,
  writeBinaryIntegrityManifest,
  writeSourceCacheManifest,
} from "./hostLocal"

const BINARY_EXE_NAME = process.platform === "win32" ? "loreweaver-server.exe" : "loreweaver-server"

async function makeBinaryCache(): Promise<{ root: string; binaryDir: string; exe: string }> {
  const root = await mkdtemp(join(tmpdir(), "loreweaver-host-local-"))
  const binaryDir = join(root, "server-bin")
  const exe = join(binaryDir, "loreweaver-server", BINARY_EXE_NAME)
  await mkdir(join(binaryDir, "loreweaver-server"), { recursive: true })
  await Bun.write(exe, "verified executable")
  return { root, binaryDir, exe }
}

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
    const oldRelease = process.env.TRPG_RELEASE_TAG
    const oldServerRelease = process.env.TRPG_SERVER_RELEASE_TAG
    delete process.env.TRPG_RELEASE_TAG
    delete process.env.TRPG_SERVER_RELEASE_TAG
    try {
      expect(binaryUrlsFor(asset)).toEqual([
        `https://github.com/1A7432/loreweaver/releases/latest/download/${asset}`,
      ])
    } finally {
      if (oldRelease === undefined) delete process.env.TRPG_RELEASE_TAG
      else process.env.TRPG_RELEASE_TAG = oldRelease
      if (oldServerRelease === undefined) delete process.env.TRPG_SERVER_RELEASE_TAG
      else process.env.TRPG_SERVER_RELEASE_TAG = oldServerRelease
    }
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

  test("source tarball and git fallback select the same pinned ref; latest selects main", () => {
    const oldRelease = process.env.TRPG_RELEASE_TAG
    const oldServerRelease = process.env.TRPG_SERVER_RELEASE_TAG
    try {
      process.env.TRPG_RELEASE_TAG = "v1.2.3"
      delete process.env.TRPG_SERVER_RELEASE_TAG
      expect(sourceTarballUrl()).toBe("https://github.com/1A7432/loreweaver/archive/refs/tags/v1.2.3.tar.gz")
      expect(sourceGitCloneArgs("/tmp/checkout")).toEqual([
        "git",
        "clone",
        "--depth",
        "1",
        "--branch",
        "v1.2.3",
        "--single-branch",
        "https://github.com/1A7432/loreweaver",
        "/tmp/checkout",
      ])

      process.env.TRPG_SERVER_RELEASE_TAG = "latest"
      expect(sourceTarballUrl()).toBe("https://github.com/1A7432/loreweaver/archive/refs/heads/main.tar.gz")
      expect(sourceGitCloneArgs("checkout")).toContain("main")
    } finally {
      if (oldRelease === undefined) delete process.env.TRPG_RELEASE_TAG
      else process.env.TRPG_RELEASE_TAG = oldRelease
      if (oldServerRelease === undefined) delete process.env.TRPG_SERVER_RELEASE_TAG
      else process.env.TRPG_SERVER_RELEASE_TAG = oldServerRelease
    }
  })

  test("parseSha256Sidecar accepts the release sidecar format", () => {
    const digest = "a".repeat(64)
    expect(parseSha256Sidecar(`${digest}  loreweaver-server-linux-x64.tar.gz\n`, "loreweaver-server-linux-x64.tar.gz")).toBe(
      digest,
    )
  })

  test("parseSha256Sidecar rejects malformed digests and a mismatched asset name", () => {
    expect(parseSha256Sidecar("not-a-digest  loreweaver-server-linux-x64.tar.gz", "loreweaver-server-linux-x64.tar.gz")).toBeUndefined()
    expect(parseSha256Sidecar(`${"b".repeat(64)}  another.tar.gz`, "loreweaver-server-linux-x64.tar.gz")).toBeUndefined()
  })

  test("archive entry validation rejects POSIX, Windows, and backslash traversal", () => {
    expect(isSafeArchiveEntry("loreweaver-server/app.py")).toBe(true)
    expect(isSafeArchiveEntry("./loreweaver-server/data/rules.yaml")).toBe(true)
    for (const entry of [
      "../outside",
      "loreweaver-server/../../outside",
      "loreweaver-server\\..\\outside",
      "/tmp/outside",
      "C:\\tmp\\outside",
      "\\\\server\\share\\outside",
      "loreweaver-server/evil\n../outside",
    ]) {
      expect(isSafeArchiveEntry(entry)).toBe(false)
    }
  })

  test("archive member type validation permits only regular files and directories", () => {
    expect(isSafeArchiveTypeLine("-rw-r--r-- user/group 10 Jan 1 00:00 loreweaver-server/app.py")).toBe(true)
    expect(isSafeArchiveTypeLine("drwxr-xr-x user/group 0 Jan 1 00:00 loreweaver-server/")).toBe(true)
    expect(isSafeArchiveTypeLine("lrwxrwxrwx user/group 0 Jan 1 00:00 safe -> ../outside")).toBe(false)
    expect(isSafeArchiveTypeLine("hrw-r--r-- user/group 0 Jan 1 00:00 safe link to outside")).toBe(false)
    expect(isSafeArchiveTypeLine("prw-r--r-- user/group 0 Jan 1 00:00 pipe")).toBe(false)
  })

  test("directory replacement restores the previous copy when commit rename fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "loreweaver-directory-swap-"))
    const target = join(root, "target")
    try {
      await mkdir(target)
      await Bun.write(join(target, "previous.txt"), "previous")
      await expect(replaceDirectory(join(root, "missing-staging"), target)).rejects.toThrow()
      expect(await Bun.file(join(target, "previous.txt")).text()).toBe("previous")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("a rejected checksum request is an IntegrityError instead of a source-fallback error", async () => {
    const failedFetch = async (): Promise<Response> => {
      throw new TypeError("network unavailable")
    }
    let thrown: unknown
    try {
      await fetchReleaseSha256(
        "https://github.com/1A7432/loreweaver/releases/latest/download/server.tar.gz",
        "server.tar.gz",
        undefined,
        failedFetch,
      )
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(IntegrityError)
    expect((thrown as Error).message).toContain("could not fetch SHA-256 metadata")
  })

  test("legacy binary cache without a trusted manifest is never accepted", async () => {
    const { root, binaryDir } = await makeBinaryCache()
    try {
      expect(await verifiedCachedBinary(binaryDir, "server.tar.gz", ["https://releases.test/server.tar.gz"])).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("source cache manifest is bound to the selected source URL/tag", async () => {
    const root = await mkdtemp(join(tmpdir(), "loreweaver-source-cache-"))
    const serverDir = join(root, "server-src")
    const v1 = "https://github.com/1A7432/loreweaver/archive/refs/tags/v1.0.0.tar.gz"
    const v2 = "https://github.com/1A7432/loreweaver/archive/refs/tags/v2.0.0.tar.gz"
    try {
      await mkdir(serverDir)
      await Bun.write(join(serverDir, "app.py"), "# cached source")
      expect(await verifiedCachedSource(serverDir, v1)).toBeUndefined()

      await writeSourceCacheManifest(serverDir, v1)
      expect(await verifiedCachedSource(serverDir, v1)).toBe(serverDir)
      expect(await verifiedCachedSource(serverDir, v2)).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("verified cache is accepted, then rejected when executable bytes change", async () => {
    const { root, binaryDir, exe } = await makeBinaryCache()
    const asset = "server.tar.gz"
    const sourceUrl = "https://releases.test/server.tar.gz"
    try {
      await writeBinaryIntegrityManifest(binaryDir, asset, sourceUrl, "a".repeat(64))
      expect(await verifiedCachedBinary(binaryDir, asset, [sourceUrl])).toBe(exe)

      await Bun.write(exe, "tampered executable")
      expect(await verifiedCachedBinary(binaryDir, asset, [sourceUrl])).toBeUndefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
