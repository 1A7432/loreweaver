// One-click "host locally": detect this machine's environment and bring a loreweaver server up
// from whatever state it's in, preferring the fastest path available:
//   1. a dev checkout on disk (found by walking up for app.py)
//   2. a prebuilt server binary fetched on an earlier run (~/.loreweaver/server-bin)
//   3. server SOURCE fetched on an earlier run (~/.loreweaver/server)
//   4. download a prebuilt server binary for this OS/arch from the GitHub release —
//      no Python/uv/git needed at all when one exists for this platform
//   5. fetch the server SOURCE (a tarball by default, so a FRESH machine with no git works;
//      git clone is only a fallback), then `uv` (which installs Python + deps for us — its
//      installer is fetched with Bun's own fetch(), so a machine with no Python/curl still
//      works) + `uv sync`
// When a binary is used, it is spawned directly — no uv involved. If that spawn fails or the
// server never becomes ready, we fall through to the source path ONCE (never loop back to the
// binary). EVERY step streams its real terminal output through `onLog` so the TUI can show the
// whole bring-up, and the keeper key it auto-mints is returned so the shell can log straight in.
// The only assumed tools are the OS's own: `tar` (bundled on Windows 10+, macOS, and every
// mainstream Linux — bsdtar handles the Windows .zip release asset too) and, on POSIX, `sh`.

import { existsSync } from "node:fs"
import { chmod, mkdir, mkdtemp, rename, rm } from "node:fs/promises"
import { createHash, randomUUID } from "node:crypto"
import { delimiter, dirname, join } from "node:path"
import { defaultUserHome, resolveLocalServerPaths, type LocalServerPaths } from "./localPaths"

const REPO = "https://github.com/1A7432/loreweaver"
const READY_TIMEOUT_MS = 60_000 // Iroh waits for a relay handshake, so allow longer than a local socket
const TICKET_RE = /(endpoint[a-z0-9]{20,})/ // the base32 ticket, printed once the endpoint is online (locale-independent)

export class IntegrityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "IntegrityError"
  }
}

export interface HostLocalOptions {
  localServerHome?: string
}

interface HostLocalContext {
  paths: LocalServerPaths
}

function makeContext(options: HostLocalOptions = {}): HostLocalContext {
  return { paths: resolveLocalServerPaths(options.localServerHome) }
}

function serverEnv(paths: LocalServerPaths): Record<string, string> {
  const env = { ...(process.env as Record<string, string>) }
  env.TRPG_LOCAL_SERVER_HOME = paths.home
  env.TRPG_DATA_DIR = paths.dataDir
  env.TRPG_ENV_FILE = paths.envFile
  env.TRPG_TUI_KEYS = paths.keysFile
  return env
}

// The packaged server archive's top-level folder + executable name (see scripts/package_server.py).
const BINARY_EXE_NAME = process.platform === "win32" ? "loreweaver-server.exe" : "loreweaver-server"
const BINARY_INTEGRITY_MANIFEST = ".loreweaver-integrity.json"
const BINARY_INTEGRITY_VERSION = 1
const SOURCE_CACHE_MANIFEST = ".loreweaver-source.json"
const SOURCE_CACHE_VERSION = 1

function binaryExePath(dir: string): string {
  return join(dir, "loreweaver-server", BINARY_EXE_NAME)
}

interface BinaryIntegrityManifest {
  version: typeof BINARY_INTEGRITY_VERSION
  asset: string
  source_url: string
  archive_sha256: string
  executable_sha256: string
}

interface SourceCacheManifest {
  version: typeof SOURCE_CACHE_VERSION
  source_url: string
}

// Maps this machine's (platform, arch) to a released server asset name, or undefined when no
// prebuilt binary is published for it (the caller then skips straight to the source tier).
export function assetNameFor(platform: string, arch: string): string | undefined {
  switch (`${platform}/${arch}`) {
    case "darwin/arm64":
      return "loreweaver-server-macos-arm64.tar.gz"
    case "linux/x64":
      return "loreweaver-server-linux-x64.tar.gz"
    case "linux/arm64":
      return "loreweaver-server-linux-arm64.tar.gz"
    case "win32/x64":
      return "loreweaver-server-windows-x64.zip"
    default:
      return undefined
  }
}

// GitHub Releases is deliberately the ONLY binary source: the 1a7432.site mirror carries just the
// tiny installers/client tarball — the owner's small VPS can't serve public ~50MB bundle traffic.
// Networks that can't fetch this fall through to the source tiers. Returned as a list so more
// sources can be added later without touching the caller's loop.
export function binaryUrlsFor(asset: string): string[] {
  const tag = process.env.TRPG_SERVER_RELEASE_TAG?.trim() || process.env.TRPG_RELEASE_TAG?.trim() || "latest"
  if (tag === "latest") return [`${REPO}/releases/latest/download/${asset}`]
  return [`${REPO}/releases/download/${encodeURIComponent(tag)}/${asset}`]
}

export function parseSha256Sidecar(text: string, asset: string): string | undefined {
  const [digest = "", filename = ""] = text.trim().split(/\s+/, 2)
  if (!/^[0-9a-f]{64}$/i.test(digest)) return undefined
  if (filename && filename.replace(/^\*/, "") !== asset) return undefined
  return digest.toLowerCase()
}

// `tar` implementations differ in how aggressively they protect the extraction
// destination. Reject dangerous names ourselves before any archive is unpacked,
// treating backslashes as separators as Windows' bsdtar does.
export function isSafeArchiveEntry(rawEntry: string): boolean {
  if (!rawEntry || /[\u0000-\u001f\u007f]/.test(rawEntry)) return false
  let entry = rawEntry.replaceAll("\\", "/")
  while (entry.startsWith("./")) entry = entry.slice(2)
  if (!entry || entry.startsWith("/") || entry.startsWith("//") || /^[A-Za-z]:/.test(entry)) return false
  return !entry.split("/").some((part) => part === "..")
}

export function isSafeArchiveTypeLine(line: string): boolean {
  return line.startsWith("-") || line.startsWith("d")
}

async function inspectArchive(archive: string, verbose: boolean, signal?: AbortSignal) {
  const proc = Bun.spawn(["tar", verbose ? "-tvf" : "-tf", archive], {
    stdout: "pipe",
    stderr: "pipe",
    env: process.env as Record<string, string>,
  })
  const onAbort = () => {
    try {
      proc.kill()
    } catch {
      // already gone
    }
  }
  signal?.addEventListener("abort", onAbort, { once: true })
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { stdout, stderr, code }
  } finally {
    signal?.removeEventListener("abort", onAbort)
  }
}

async function validateArchiveEntries(
  archive: string,
  onLog: OnLog,
  signal?: AbortSignal,
  integrityFailure = false,
  requiredRoot?: string,
): Promise<void> {
  onLog(`$ tar -tf ${archive}`, "step")
  const fail = (message: string): never => {
    throw integrityFailure ? new IntegrityError(message) : new Error(message)
  }
  const listing = await inspectArchive(archive, false, signal)
  for (const line of listing.stderr.split(/\r?\n/)) {
    if (line) onLog(clean(line), "err")
  }
  if (signal?.aborted) throw new Error("cancelled")
  if (listing.code !== 0) fail("could not inspect the downloaded archive")
  const entries = listing.stdout.split(/\r?\n/).filter(Boolean)
  if (entries.length === 0) fail("downloaded archive is empty")
  for (const entry of entries) {
    if (!isSafeArchiveEntry(entry)) fail(`unsafe archive entry: ${JSON.stringify(entry)}`)
    if (requiredRoot) {
      const normalized = entry.replaceAll("\\", "/").replace(/^(?:\.\/)+/, "").replace(/\/$/, "")
      if (normalized !== requiredRoot && !normalized.startsWith(`${requiredRoot}/`)) {
        fail(`archive entry is outside ${requiredRoot}/: ${JSON.stringify(entry)}`)
      }
    }
  }

  // A relative child can still escape when an earlier member creates a symlink
  // or hardlink. Release/source archives are deliberately restricted to regular
  // files and directories, so reject every other tar/zip member type up front.
  onLog(`$ tar -tvf ${archive}`, "step")
  const verbose = await inspectArchive(archive, true, signal)
  for (const line of verbose.stderr.split(/\r?\n/)) {
      if (line) onLog(clean(line), "err")
  }
  if (signal?.aborted) throw new Error("cancelled")
  if (verbose.code !== 0) fail("could not inspect downloaded archive member types")
  const typeLines = verbose.stdout.split(/\r?\n/).filter(Boolean)
  if (typeLines.length === 0 || typeLines.some((line) => !isSafeArchiveTypeLine(line))) {
    fail("downloaded archive contains a link or special entry")
  }
}

// Commit a fully prepared directory without deleting the working copy first.
// If the final rename fails, the previous directory is restored before the
// error is surfaced to the UI.
export async function replaceDirectory(staging: string, target: string): Promise<void> {
  const backup = `${target}.backup-${randomUUID()}`
  const hadTarget = existsSync(target)
  if (hadTarget) await rename(target, backup)
  try {
    await rename(staging, target)
  } catch (error) {
    if (hadTarget) {
      try {
        await rename(backup, target)
      } catch (restoreError) {
        const detail = restoreError instanceof Error ? restoreError.message : String(restoreError)
        throw new Error(`install failed and restoring the previous directory also failed (${detail})`, { cause: error })
      }
    }
    throw error
  }
  if (hadTarget) await rm(backup, { recursive: true, force: true })
}

async function sha256File(path: string): Promise<string> {
  const bytes = await Bun.file(path).arrayBuffer()
  return createHash("sha256").update(new Uint8Array(bytes)).digest("hex")
}

type FetchResponse = (url: string, init?: RequestInit) => Promise<Response>

// Once an archive response has been accepted, absence of its checksum is an integrity failure,
// not an ordinary mirror outage: silently switching to an unchecked source tarball would undo
// the release verification this path promises.
export async function fetchReleaseSha256(
  archiveUrl: string,
  asset: string,
  signal?: AbortSignal,
  fetchResponse: FetchResponse = fetch,
): Promise<string> {
  const checksumUrl = `${archiveUrl}.sha256`
  try {
    const response = await fetchResponse(checksumUrl, { signal })
    if (!response.ok) {
      throw new IntegrityError(`HTTP ${response.status} fetching SHA-256 metadata from ${checksumUrl}`)
    }
    const checksum = parseSha256Sidecar(await response.text(), asset)
    if (!checksum) throw new IntegrityError(`invalid SHA-256 metadata from ${checksumUrl}`)
    return checksum
  } catch (error) {
    if (signal?.aborted) throw error instanceof Error ? error : new Error("cancelled")
    if (error instanceof IntegrityError) throw error
    const detail = error instanceof Error ? error.message : String(error)
    throw new IntegrityError(`could not fetch SHA-256 metadata from ${checksumUrl} (${detail})`)
  }
}

function isBinaryIntegrityManifest(value: unknown): value is BinaryIntegrityManifest {
  if (!value || typeof value !== "object") return false
  const manifest = value as Record<string, unknown>
  return (
    manifest.version === BINARY_INTEGRITY_VERSION &&
    typeof manifest.asset === "string" &&
    typeof manifest.source_url === "string" &&
    typeof manifest.archive_sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(manifest.archive_sha256) &&
    typeof manifest.executable_sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(manifest.executable_sha256)
  )
}

// The manifest is written into the staging directory only after the release archive itself has
// matched its published sidecar. Renaming that directory therefore commits the executable and
// its trust record atomically; a half-extracted cache never gains a valid manifest.
export async function writeBinaryIntegrityManifest(
  binaryDir: string,
  asset: string,
  sourceUrl: string,
  archiveSha256: string,
): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(archiveSha256)) throw new IntegrityError("invalid verified archive SHA-256")
  const executableSha256 = await sha256File(binaryExePath(binaryDir))
  const manifest: BinaryIntegrityManifest = {
    version: BINARY_INTEGRITY_VERSION,
    asset,
    source_url: sourceUrl,
    archive_sha256: archiveSha256,
    executable_sha256: executableSha256,
  }
  await Bun.write(join(binaryDir, BINARY_INTEGRITY_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`)
}

// Never execute a cache on existence alone. Besides detecting changed bytes, binding the manifest
// to the currently selected release URL means an explicit release-tag pin cannot accidentally
// reuse a binary cached from another channel. Legacy caches have no manifest and are ignored.
export async function verifiedCachedBinary(
  binaryDir: string,
  asset: string,
  allowedSourceUrls: string[] = binaryUrlsFor(asset),
): Promise<string | undefined> {
  const exe = binaryExePath(binaryDir)
  if (!existsSync(exe)) return undefined
  try {
    const value: unknown = JSON.parse(await Bun.file(join(binaryDir, BINARY_INTEGRITY_MANIFEST)).text())
    if (!isBinaryIntegrityManifest(value)) return undefined
    if (value.asset !== asset || !allowedSourceUrls.includes(value.source_url)) return undefined
    return (await sha256File(exe)) === value.executable_sha256 ? exe : undefined
  } catch {
    return undefined
  }
}

function selectedSourceTag(): string {
  return process.env.TRPG_SERVER_RELEASE_TAG?.trim() || process.env.TRPG_RELEASE_TAG?.trim() || "latest"
}

export function sourceTarballUrl(): string {
  const tag = selectedSourceTag()
  if (tag !== "latest") return `${REPO}/archive/refs/tags/${encodeURIComponent(tag)}.tar.gz`
  return `${REPO}/archive/refs/heads/main.tar.gz`
}

export function sourceGitCloneArgs(destination: string): string[] {
  const tag = selectedSourceTag()
  const ref = tag === "latest" ? "main" : tag
  return ["git", "clone", "--depth", "1", "--branch", ref, "--single-branch", REPO, destination]
}

export async function writeSourceCacheManifest(serverDir: string, sourceUrl: string = sourceTarballUrl()): Promise<void> {
  const manifest: SourceCacheManifest = { version: SOURCE_CACHE_VERSION, source_url: sourceUrl }
  await Bun.write(join(serverDir, SOURCE_CACHE_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`)
}

export async function verifiedCachedSource(
  serverDir: string,
  expectedSourceUrl: string = sourceTarballUrl(),
): Promise<string | undefined> {
  if (!existsSync(join(serverDir, "app.py"))) return undefined
  try {
    const value: unknown = JSON.parse(await Bun.file(join(serverDir, SOURCE_CACHE_MANIFEST)).text())
    if (!value || typeof value !== "object") return undefined
    const manifest = value as Record<string, unknown>
    if (manifest.version !== SOURCE_CACHE_VERSION || manifest.source_url !== expectedSourceUrl) return undefined
    return serverDir
  } catch {
    return undefined
  }
}

export type LogKind = "step" | "out" | "err" | "ok" | "fail"
export type OnLog = (text: string, kind: LogKind) => void
export interface HostHandle {
  host: string
  key: string
  stop(): void
}

// Tools (uv/pip/git) emit ANSI colour codes; the log view renders plain text, so strip them
// (and a trailing CR) or they show up as literal escape gibberish.
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g
function clean(line: string): string {
  return line.replace(ANSI, "").replace(/\r$/, "")
}

function findCheckout(): string | undefined {
  let dir = import.meta.dir
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "app.py"))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

async function pipeLines(stream: ReadableStream<Uint8Array> | null, onLine: (line: string) => void): Promise<void> {
  if (!stream) return
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let nl: number
    while ((nl = buffer.indexOf("\n")) >= 0) {
      onLine(clean(buffer.slice(0, nl)))
      buffer = buffer.slice(nl + 1)
    }
  }
  if (buffer.trim()) onLine(clean(buffer))
}

// Run a command to completion, streaming stdout+stderr through `onLog`. Returns the exit code.
// If `signal` aborts (the user backed out), the child is killed so a long `uv sync`/clone doesn't
// keep running after they've left the screen.
async function run(cmd: string[], cwd: string | undefined, onLog: OnLog, signal?: AbortSignal): Promise<number> {
  onLog(`$ ${cmd.join(" ")}`, "step")
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: process.env as Record<string, string> })
  const onAbort = () => {
    try {
      proc.kill()
    } catch {
      // already gone
    }
  }
  signal?.addEventListener("abort", onAbort, { once: true })
  try {
    await Promise.all([
      pipeLines(proc.stdout, (line) => onLog(line, "out")),
      pipeLines(proc.stderr, (line) => onLog(line, "err")),
    ])
    return await proc.exited
  } finally {
    signal?.removeEventListener("abort", onAbort)
  }
}

// Fetch the server source WITHOUT git: download the branch tarball and unpack it with the
// system `tar`. Extraction goes to a staging dir that is atomically renamed into place, so a
// half-finished download can never masquerade as a working server dir on the next run.
async function fetchServerSource(ctx: HostLocalContext, onLog: OnLog, signal?: AbortSignal): Promise<string> {
  onLog("Downloading the server source (a few MB — no git needed)…", "step")
  const sourceUrl = sourceTarballUrl()
  const response = await fetch(sourceUrl, { signal })
  if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`)
  await mkdir(dirname(ctx.paths.sourceArchive), { recursive: true })
  await mkdir(dirname(ctx.paths.serverDir), { recursive: true })
  const tarball = `${ctx.paths.sourceArchive}.${randomUUID()}`
  const staging = await mkdtemp(`${ctx.paths.serverDir}.staging-`)
  try {
    await Bun.write(tarball, response)
    await validateArchiveEntries(tarball, onLog, signal)
    // --strip-components=1 drops the `loreweaver-main/` wrapper folder GitHub puts in the tarball.
    if ((await run(["tar", "-xzf", tarball, "-C", staging, "--strip-components=1"], undefined, onLog, signal)) !== 0) {
      throw new Error("extracting the server source failed")
    }
    if (!existsSync(join(staging, "app.py"))) throw new Error("downloaded server source has an unexpected layout")
    await writeSourceCacheManifest(staging, sourceUrl)
    await replaceDirectory(staging, ctx.paths.serverDir)
    return ctx.paths.serverDir
  } finally {
    await rm(tarball, { force: true })
    await rm(staging, { recursive: true, force: true })
  }
}

// Download a prebuilt server binary for this OS/arch (see the pinned contract in
// scripts/package_server.py) and unpack it with the system `tar`. Same staging + atomic-rename
// pattern as fetchServerSource. Returns undefined (not an error) when no binary is published for
// this platform, so the caller falls through to the source tier without treating it as a failure.
async function fetchServerBinary(ctx: HostLocalContext, onLog: OnLog, signal?: AbortSignal): Promise<string | undefined> {
  const asset = assetNameFor(process.platform, process.arch)
  if (!asset) {
    onLog(`No prebuilt server binary for ${process.platform}/${process.arch} — falling back to source`, "step")
    return undefined
  }
  onLog(`Downloading the prebuilt server (${asset})…`, "step")
  let response: Response | undefined
  let expectedSha256 = ""
  let sourceUrl = ""
  let lastError = "no mirrors reachable"
  for (const url of binaryUrlsFor(asset)) {
    try {
      const candidate = await fetch(url, { signal })
      if (candidate.ok) {
        try {
          expectedSha256 = await fetchReleaseSha256(url, asset, signal)
        } catch (error) {
          try {
            await candidate.body?.cancel()
          } catch {
            // The integrity error is authoritative; a failed best-effort body cancellation must
            // not replace it with an unrelated stream error.
          }
          throw error
        }
        response = candidate
        sourceUrl = url
        break
      }
      lastError = `HTTP ${candidate.status} from ${url}`
    } catch (error) {
      if (signal?.aborted) throw error instanceof Error ? error : new Error("cancelled")
      if (error instanceof IntegrityError) throw error
      lastError = error instanceof Error ? error.message : String(error)
    }
  }
  if (!response) throw new Error(`binary download failed (${lastError})`)

  await mkdir(ctx.paths.home, { recursive: true })
  await mkdir(dirname(ctx.paths.binaryDir), { recursive: true })
  const archive = join(ctx.paths.home, `${asset}.${randomUUID()}`)
  const staging = await mkdtemp(`${ctx.paths.binaryDir}.staging-`)
  try {
    await Bun.write(archive, response)
    const actualSha256 = await sha256File(archive)
    if (actualSha256 !== expectedSha256) throw new IntegrityError(`binary SHA-256 mismatch for ${asset}`)
    await validateArchiveEntries(archive, onLog, signal, true, "loreweaver-server")
    // No --strip-components here: unlike the source tarball, the release asset's top-level
    // `loreweaver-server/` folder IS the layout we want under the binary cache dir.
    if ((await run(["tar", "-xf", archive, "-C", staging], undefined, onLog, signal)) !== 0) {
      throw new IntegrityError("extracting the verified server binary failed")
    }
    const stagedExe = binaryExePath(staging)
    if (!existsSync(stagedExe)) throw new IntegrityError("verified server archive has an unexpected layout")
    if (process.platform !== "win32") {
      try {
        await chmod(stagedExe, 0o755)
      } catch {
        // best-effort — if this fails the spawn below will fail loudly anyway
      }
    }
    await writeBinaryIntegrityManifest(staging, asset, sourceUrl, actualSha256)
    await replaceDirectory(staging, ctx.paths.binaryDir)
    return binaryExePath(ctx.paths.binaryDir)
  } finally {
    await rm(archive, { force: true })
    await rm(staging, { recursive: true, force: true })
  }
}

async function ensureServerDir(ctx: HostLocalContext, onLog: OnLog, signal?: AbortSignal): Promise<string> {
  const checkout = findCheckout()
  if (checkout) {
    onLog(`Found a checkout at ${checkout}`, "ok")
    return checkout
  }
  const cachedSource = await verifiedCachedSource(ctx.paths.serverDir)
  if (cachedSource) {
    onLog(`Using the server fetched earlier at ${cachedSource}`, "ok")
    return cachedSource
  }
  if (existsSync(join(ctx.paths.serverDir, "app.py"))) {
    onLog("Ignoring a source cache from another release tag or without a manifest", "err")
  }
  onLog("No server on this machine — fetching the code…", "step")
  // Tarball FIRST: it works on a fresh machine with no git, and macOS's git shim would pop a
  // GUI "install developer tools?" dialog mid-bring-up. git is only the fallback for networks
  // where the tarball endpoint is blocked but git happens to get through.
  try {
    return await fetchServerSource(ctx, onLog, signal)
  } catch (error) {
    if (signal?.aborted) throw error instanceof Error ? error : new Error("cancelled")
    const detail = error instanceof Error ? error.message : String(error)
    onLog(`Tarball download didn't work (${detail}) — trying git…`, "err")
    if (!Bun.which("git")) {
      throw new Error("could not download the server source (and git isn't installed as a fallback) — check your network and retry")
    }
    await mkdir(dirname(ctx.paths.serverDir), { recursive: true })
    const stagingRoot = await mkdtemp(`${ctx.paths.serverDir}.git-staging-`)
    const checkoutDir = join(stagingRoot, "checkout")
    try {
      if ((await run(sourceGitCloneArgs(checkoutDir), undefined, onLog, signal)) !== 0) {
        throw new Error("git clone failed — check your network (GitHub reachable?)")
      }
      await writeSourceCacheManifest(checkoutDir)
      await replaceDirectory(checkoutDir, ctx.paths.serverDir)
      return ctx.paths.serverDir
    } finally {
      await rm(stagingRoot, { recursive: true, force: true })
    }
  }
}

type ServerLocation = { kind: "source"; dir: string } | { kind: "binary"; exe: string }

// The full acquisition chain, in priority order: dev checkout > binary fetched earlier > source
// fetched earlier > download a binary > (fall back to) fetch source. Only the last step can fail
// outright — everything before it is "use what's already here", and the binary-download step
// degrades to the source tier instead of throwing when unsupported or unreachable.
async function resolveServer(ctx: HostLocalContext, onLog: OnLog, signal?: AbortSignal): Promise<ServerLocation> {
  const checkout = findCheckout()
  if (checkout) {
    onLog(`Found a checkout at ${checkout}`, "ok")
    return { kind: "source", dir: checkout }
  }
  const existingExe = binaryExePath(ctx.paths.binaryDir)
  if (existsSync(existingExe)) {
    const asset = assetNameFor(process.platform, process.arch)
    const verifiedExe = asset ? await verifiedCachedBinary(ctx.paths.binaryDir, asset) : undefined
    if (verifiedExe) {
      onLog(`Using the verified prebuilt server fetched earlier at ${verifiedExe}`, "ok")
      return { kind: "binary", exe: verifiedExe }
    }
    onLog("Ignoring an unverified or changed prebuilt server cache", "err")
  }
  const cachedSource = await verifiedCachedSource(ctx.paths.serverDir)
  if (cachedSource) {
    onLog(`Using the server fetched earlier at ${cachedSource}`, "ok")
    return { kind: "source", dir: cachedSource }
  }
  if (existsSync(join(ctx.paths.serverDir, "app.py"))) {
    onLog("Ignoring a source cache from another release tag or without a manifest", "err")
  }
  onLog("No server on this machine — fetching it…", "step")
  try {
    const exe = await fetchServerBinary(ctx, onLog, signal)
    if (exe) {
      onLog("Prebuilt server downloaded", "ok")
      return { kind: "binary", exe }
    }
  } catch (error) {
    if (signal?.aborted) throw error instanceof Error ? error : new Error("cancelled")
    if (error instanceof IntegrityError) throw error
    const detail = error instanceof Error ? error.message : String(error)
    onLog(`Prebuilt binary download didn't work (${detail}) — falling back to source…`, "err")
  }
  return { kind: "source", dir: await ensureServerDir(ctx, onLog, signal) }
}

async function ensureUv(ctx: HostLocalContext, onLog: OnLog, signal?: AbortSignal): Promise<void> {
  if (Bun.which("uv")) {
    onLog("uv is already installed", "ok")
    return
  }
  onLog("uv not found — installing it (it manages Python + deps for us)…", "step")
  if (process.platform === "win32") {
    const installer = ["powershell", "-NoProfile", "-Command", "irm https://astral.sh/uv/install.ps1 | iex"]
    if ((await run(installer, undefined, onLog, signal)) !== 0) throw new Error("uv install failed — check your network")
  } else {
    // Fetch the installer with Bun's own fetch() and run it with sh — fresh Linux images often
    // ship without curl, and this path must work on a factory-fresh machine.
    const response = await fetch("https://astral.sh/uv/install.sh", { signal })
    if (!response.ok) throw new Error(`uv installer download failed: HTTP ${response.status}`)
    const script = ctx.paths.uvInstallScript
    await mkdir(dirname(script), { recursive: true })
    await Bun.write(script, response)
    const code = await run(["sh", script], undefined, onLog, signal)
    await rm(script, { force: true })
    if (code !== 0) throw new Error("uv install failed — check your network")
  }
  // uv drops its binary in one of these; prepend both to PATH so the steps that follow can find it.
  // `delimiter` is `;` on Windows, `:` elsewhere — a hardcoded `:` would break the Windows lookup.
  const home = defaultUserHome()
  const uvDirs = [join(home, ".local", "bin"), join(home, ".cargo", "bin")]
  process.env.PATH = [...uvDirs, process.env.PATH ?? ""].join(delimiter)
}

async function readSidecarKey(paths: LocalServerPaths): Promise<string> {
  try {
    return (await Bun.file(paths.keeperSidecar).text()).match(/key=([A-Za-z0-9_-]{16,})/)?.[1] ?? ""
  } catch {
    return ""
  }
}

async function waitReady(
  paths: LocalServerPaths,
  proc: Bun.Subprocess,
  onLog: OnLog,
  signal?: AbortSignal,
): Promise<{ ticket: string; key: string }> {
  const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  let line = ""
  let all = ""
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("the server did not become ready in time")), READY_TIMEOUT_MS),
  )
  // Losing the race to an abort lets the caller tear the half-started server down promptly.
  const aborted = new Promise<never>((_, reject) => {
    if (signal?.aborted) reject(new Error("cancelled"))
    else signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })
  })
  const ready = (async (): Promise<{ ticket: string; key: string }> => {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) throw new Error("the server exited before it was ready")
      const chunk = decoder.decode(value, { stream: true })
      line += chunk
      all += chunk
      let nl: number
      while ((nl = line.indexOf("\n")) >= 0) {
        onLog(clean(line.slice(0, nl)), "out")
        line = line.slice(nl + 1)
      }
      // Readiness = the Iroh ticket is printed (once the endpoint has a relay). Both are
      // locale-independent: the ticket is base32, the keeper key comes from the sidecar file.
      const match = all.match(TICKET_RE)
      if (match) {
        const key = await readSidecarKey(paths)
        if (key) return { ticket: match[1], key }
      }
    }
  })()
  try {
    return await Promise.race([ready, timeout, aborted])
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // ignore
    }
  }
}

// Shared tail for both run modes: spawn is already done by the caller, this just wires up the
// abort-kills-the-child plumbing, streams stdout, and waits for the readiness ticket.
async function runProcAndWait(
  paths: LocalServerPaths,
  proc: Bun.Subprocess,
  onLog: OnLog,
  signal?: AbortSignal,
): Promise<HostHandle> {
  const stop = () => {
    try {
      proc.kill()
    } catch {
      // already gone
    }
  }
  // If the user backs out while we're still waiting for the relay, kill the server we just spawned.
  signal?.addEventListener("abort", stop, { once: true })
  void pipeLines(proc.stdout, (l) => onLog(l, "out"))
  try {
    const { ticket, key } = await waitReady(paths, proc, onLog, signal)
    onLog("Server ready — dialing you in as Keeper over p2p", "ok")
    return { host: ticket, key, stop }
  } catch (error) {
    stop()
    throw error
  } finally {
    signal?.removeEventListener("abort", stop)
  }
}

// Today's path: ensure uv, `uv sync` the checkout/fetched source, then run it from Python.
async function runSource(ctx: HostLocalContext, serverDir: string, onLog: OnLog, signal?: AbortSignal): Promise<HostHandle> {
  await ensureUv(ctx, onLog, signal)
  if (signal?.aborted) throw new Error("cancelled")

  onLog("Installing Python + dependencies (uv sync) — this can take a minute the first time…", "step")
  if ((await run(["uv", "sync"], serverDir, onLog, signal)) !== 0) throw new Error("uv sync failed")
  if (signal?.aborted) throw new Error("cancelled")
  onLog("Dependencies ready", "ok")

  onLog("Starting the local p2p server (Iroh) — waiting for a relay, ~10s…", "step")
  const proc = Bun.spawn(
    ["uv", "run", "python", "-m", "app", "--serve", "--keys", ctx.paths.keysFile],
    { cwd: serverDir, stdout: "pipe", stderr: "pipe", env: serverEnv(ctx.paths) },
  )
  return runProcAndWait(ctx.paths, proc, onLog, signal)
}

// The binary path: no uv, no Python interpreter to find — just run the packaged executable
// directly. It prints the same readiness banner (ticket + sidecar key) as `python -m app --serve`.
async function runBinary(ctx: HostLocalContext, exe: string, onLog: OnLog, signal?: AbortSignal): Promise<HostHandle> {
  onLog("Starting the local p2p server (prebuilt binary) — waiting for a relay, ~10s…", "step")
  const proc = Bun.spawn([exe, "--serve", "--keys", ctx.paths.keysFile], {
    cwd: dirname(exe),
    stdout: "pipe",
    stderr: "pipe",
    env: serverEnv(ctx.paths),
  })
  return runProcAndWait(ctx.paths, proc, onLog, signal)
}

export async function bringUpServer(onLog: OnLog, signal?: AbortSignal, options: HostLocalOptions = {}): Promise<HostHandle> {
  const bailIfAborted = () => {
    if (signal?.aborted) throw new Error("cancelled")
  }
  bailIfAborted()
  const ctx = makeContext(options)
  const homeAlreadyExists = existsSync(ctx.paths.home)
  await mkdir(ctx.paths.home, { recursive: true, mode: 0o700 })
  if (!homeAlreadyExists && process.platform !== "win32") {
    try {
      await chmod(ctx.paths.home, 0o700)
    } catch {
      // Best effort on filesystems that do not expose POSIX modes. Do not chmod
      // an existing path: it may be a user-selected shared parent rather than a
      // directory Loreweaver created and owns.
    }
  }
  onLog(`OS: ${process.platform} / ${process.arch}`, "step")
  const location = await resolveServer(ctx, onLog, signal)
  bailIfAborted()

  if (location.kind === "source") return runSource(ctx, location.dir, onLog, signal)

  try {
    return await runBinary(ctx, location.exe, onLog, signal)
  } catch (error) {
    // Never loop back to the binary: one fallback to the source tier, then give up for real.
    if (signal?.aborted) throw error instanceof Error ? error : new Error("cancelled")
    const detail = error instanceof Error ? error.message : String(error)
    onLog(`Prebuilt server didn't start (${detail}) — falling back to source…`, "err")
    const serverDir = await ensureServerDir(ctx, onLog, signal)
    bailIfAborted()
    return runSource(ctx, serverDir, onLog, signal)
  }
}
