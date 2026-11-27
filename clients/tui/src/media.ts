import { mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { basename, extname, join, resolve } from "node:path"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import { PNG } from "pngjs"
import jpeg from "jpeg-js"
import { isContentHash, stripControlChars } from "loreweaver-protocol/v3"
import { defaultLoreweaverHome, expandHome } from "./localPaths"

// Media on the client side of the byte channel (protocol 3.0 §8.6): the content-addressed cache
// of fetched files, reading a file a person names for upload, decoding and terminal previews.
// Nothing here talks to the server; `connection.ts` does, through the transport.

/** A piece of media by content hash. */
export interface MediaRef {
  hash: string
  mime: string
  name?: string
  size?: number
}

/** Its bytes, as the byte channel hands them over. */
export interface MediaPayload {
  hash: string
  mime: string
  name: string
  bytes: Uint8Array
}

export interface HalfBlockLine {
  text: string
  cells: Array<{ char: string; fg: string; bg: string }>
}

export interface RgbaImage {
  width: number
  height: number
  data: Uint8Array
}

/**
 * The largest file this client offers. The server's default limit for pictures and card files
 * (both count against its image budget); the protocol package does not state it, so it is kept
 * here — a server configured lower still refuses with its own coded answer.
 */
export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024
/** The largest file read back from the cache (the largest the byte channel accepts). */
const MAX_CACHED_BYTES = 128 * 1024 * 1024
/**
 * The largest sound this client reads for upload: the largest file the byte channel carries.
 * The server's own (lower) audio limit is its to say, with a coded refusal.
 */
export const MAX_AUDIO_UPLOAD_BYTES = MAX_CACHED_BYTES

/** The picture types the server stores as room media. */
export const SHAREABLE_IMAGE_MIMES: readonly string[] = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"]

export function halfBlockPreviewSize(availableWidth: number, availableHeight = 28): { width: number; height: number } {
  return {
    width: Math.max(16, Math.min(56, Math.floor(availableWidth || 40))),
    height: Math.max(8, Math.min(28, Math.floor(availableHeight || 20))),
  }
}

export function detectImageMime(path: string): string {
  const ext = extname(path).toLowerCase()
  if (ext === ".png") return "image/png"
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg"
  if (ext === ".webp") return "image/webp"
  if (ext === ".gif") return "image/gif"
  if (ext === ".svg") return "image/svg+xml"
  return ""
}

export function detectAudioMime(path: string): string {
  const ext = extname(path).toLowerCase()
  if (ext === ".mp3") return "audio/mpeg"
  if (ext === ".ogg" || ext === ".oga") return "audio/ogg"
  if (ext === ".wav") return "audio/wav"
  if (ext === ".flac") return "audio/flac"
  if (ext === ".m4a" || ext === ".mp4") return "audio/mp4"
  if (ext === ".aac") return "audio/aac"
  return ""
}

export function detectMediaMime(path: string): string {
  return detectImageMime(path) || detectAudioMime(path)
}

/** A picture's type from its first bytes; "" when it is none this client previews. */
export function sniffImageMime(bytes: Uint8Array): string {
  const starts = (...sig: number[]) => sig.every((byte, index) => bytes[index] === byte)
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png"
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg"
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif"
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp"
  const head = new TextDecoder().decode(bytes.subarray(0, 512)).trimStart()
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "image/svg+xml"
  return ""
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

export function coerceDroppedFilePath(value: string): string {
  let text = String(value ?? "").trim()
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1)
  }
  if (text.startsWith("file://")) {
    try {
      return fileURLToPath(text)
    } catch {
      return text
    }
  }
  return text.replace(/\\ /g, " ")
}

export function droppedImagePath(value: string): string | undefined {
  const path = coerceDroppedFilePath(value)
  if (!path || !existsSync(path)) return undefined
  return detectImageMime(path) ? path : undefined
}

// --- a file a person names ---------------------------------------------------------------------

/** What an upload is made of. */
export interface LocalFile {
  name: string
  mime: string
  bytes: Uint8Array
}

/** Why a named file was not read: each code has words in both languages (`file.error.*`). */
export type LocalFileCode = "empty_path" | "not_found" | "is_directory" | "not_a_file" | "too_large" | "empty" | "bad_type" | "unreadable"

export class LocalFileError extends Error {
  readonly code: LocalFileCode
  readonly path: string

  constructor(code: LocalFileCode, path: string) {
    super(code)
    this.name = "LocalFileError"
    this.code = code
    this.path = path
  }
}

/**
 * What a person names a file for: a picture to share, a card to import, a sound for the audio
 * library, or a room save to restore (read here, sent as a command argument, never uploaded).
 */
export type UploadKind = "image" | "card" | "audio" | "save"

/**
 * The type a file is offered as, by its name: a picture to share (`image`), a card to import
 * (`card`: a PNG with the card inside, or the card as JSON), or a sound (`audio`). "" when it
 * is not one of those.
 */
export function uploadMime(path: string, kind: UploadKind): string {
  if (kind === "audio") return detectAudioMime(path)
  // A save is JSON whatever it is called; what is inside decides, not the extension.
  if (kind === "save") return "application/json"
  if (kind === "card") {
    const ext = extname(path).toLowerCase()
    return ext === ".png" ? "image/png" : ext === ".json" ? "application/json" : ""
  }
  const mime = detectImageMime(path)
  return SHAREABLE_IMAGE_MIMES.includes(mime) ? mime : ""
}

/**
 * Read the one file a person named, for upload. `~` is expanded; a directory, anything that is
 * not a regular file, a file of the wrong type and one over `maxBytes` are refused BEFORE any of
 * it is read — the size is checked on the opened file itself, and the read stops at the size it
 * reported (a file that grew meanwhile is refused, not cut).
 */
export async function readLocalFile(typed: string, kind: UploadKind, maxBytes: number = MAX_UPLOAD_BYTES): Promise<LocalFile> {
  const cleaned = coerceDroppedFilePath(typed)
  if (!cleaned) throw new LocalFileError("empty_path", typed)
  const path = resolve(expandHome(cleaned))
  let info
  try {
    info = await stat(path)
  } catch {
    throw new LocalFileError("not_found", path)
  }
  if (info.isDirectory()) throw new LocalFileError("is_directory", path)
  if (!info.isFile()) throw new LocalFileError("not_a_file", path)
  const mime = uploadMime(path, kind)
  if (!mime) throw new LocalFileError("bad_type", path)
  if (info.size > maxBytes) throw new LocalFileError("too_large", path)
  if (info.size === 0) throw new LocalFileError("empty", path)
  let handle
  try {
    handle = await open(path, "r")
  } catch {
    throw new LocalFileError("unreadable", path)
  }
  try {
    const opened = await handle.stat()
    if (!opened.isFile()) throw new LocalFileError("not_a_file", path)
    if (opened.size > maxBytes) throw new LocalFileError("too_large", path)
    if (opened.size === 0) throw new LocalFileError("empty", path)
    const bytes = new Uint8Array(opened.size + 1)
    let filled = 0
    while (filled < bytes.length) {
      const { bytesRead } = await handle.read(bytes, filled, bytes.length - filled, filled)
      if (bytesRead === 0) break
      filled += bytesRead
    }
    // One byte past the size it reported: the file is changing under us.
    if (filled !== opened.size) throw new LocalFileError(filled > opened.size ? "too_large" : "unreadable", path)
    return { name: basename(path), mime, bytes: bytes.subarray(0, filled) }
  } catch (error) {
    if (error instanceof LocalFileError) throw error
    throw new LocalFileError("unreadable", path)
  } finally {
    await handle.close().catch(() => {})
  }
}

// --- the cache -----------------------------------------------------------------------------------

/** Where fetched media is kept, by hash: the client's own folder. */
export function mediaCacheDir(): string {
  return process.env.LOREWEAVER_MEDIA_CACHE_DIR || join(defaultLoreweaverHome(), "cache", "media")
}

/** The cache file of `hash`; undefined for anything that is not a content hash (never a path). */
export function cachedMediaPath(hash: string, dir: string = mediaCacheDir()): string | undefined {
  return isContentHash(hash) ? join(dir, hash) : undefined
}

/** The cached bytes of `hash`, when the cache holds them intact; null otherwise. */
export async function readCachedMedia(hash: string, dir?: string): Promise<Uint8Array | null> {
  const path = cachedMediaPath(hash, dir)
  if (path === undefined) return null
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size > MAX_CACHED_BYTES) return null
    const bytes = new Uint8Array(await readFile(path))
    return sha256Hex(bytes) === hash ? bytes : null
  } catch {
    return null
  }
}

/** Keep `bytes` under their hash. Returns the file, or undefined when the cache cannot be written. */
export async function writeCachedMedia(hash: string, bytes: Uint8Array, dir?: string): Promise<string | undefined> {
  const path = cachedMediaPath(hash, dir)
  if (path === undefined || sha256Hex(bytes) !== hash) return undefined
  try {
    await mkdir(join(path, ".."), { recursive: true })
    // Written aside and renamed: a reader never sees half a file.
    const partial = `${path}.${process.pid}.part`
    await writeFile(partial, bytes)
    await rename(partial, path)
    return path
  } catch {
    // A read-only home directory should not break viewing; it only disables the cache.
    return undefined
  }
}

/** Show a file in the system's own viewer (for a type the terminal cannot draw). */
export function openInSystemViewer(path: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open"
  const args = process.platform === "win32" ? ["/c", "start", "", path] : [path]
  const child = spawn(command, args, { detached: true, stdio: "ignore" })
  child.on("error", () => {})
  child.unref()
}

export async function renderHalfBlockPreview(
  bytes: Uint8Array,
  mime: string,
  widthCells: number,
  heightCells: number,
): Promise<HalfBlockLine[]> {
  if (mime === "image/svg+xml") {
    return renderSvgPreview(bytes, widthCells, heightCells)
  }
  const image = decodeImage(bytes, mime)
  const pixelWidth = Math.max(1, widthCells)
  const pixelHeight = Math.max(1, heightCells * 2)
  const rows: HalfBlockLine[] = []
  for (let y = 0; y < pixelHeight; y += 2) {
    const cells: HalfBlockLine["cells"] = []
    let text = ""
    for (let x = 0; x < pixelWidth; x++) {
      const top = sampleRgb(image, x, y, pixelWidth, pixelHeight)
      const bottom = sampleRgb(image, x, Math.min(y + 1, pixelHeight - 1), pixelWidth, pixelHeight)
      cells.push({ char: "▀", fg: rgbHex(top), bg: rgbHex(bottom) })
      text += "▀"
    }
    rows.push({ text, cells })
  }
  return rows
}

export function decodeImage(bytes: Uint8Array, mime: string): RgbaImage {
  if (mime === "image/png") {
    const decoded = PNG.sync.read(Buffer.from(bytes))
    return { width: decoded.width, height: decoded.height, data: new Uint8Array(decoded.data) }
  }
  if (mime === "image/jpeg") {
    const decoded = jpeg.decode(Buffer.from(bytes), { useTArray: true })
    return { width: decoded.width, height: decoded.height, data: new Uint8Array(decoded.data) }
  }
  throw new Error("unsupported inline preview")
}

function renderSvgPreview(bytes: Uint8Array, widthCells: number, heightCells: number): HalfBlockLine[] {
  const text = new TextDecoder().decode(bytes)
  const viewBox = parseViewBox(text)
  const width = Math.max(1, widthCells)
  const height = Math.max(1, heightCells)
  const grid = Array.from({ length: height }, () => Array.from({ length: width }, () => " "))

  for (const match of text.matchAll(/<line\b([^>]*)>/gi)) {
    const attrs = parseAttrs(match[1] ?? "")
    drawLine(
      grid,
      mapX(num(attrs.x1), viewBox, width),
      mapY(num(attrs.y1), viewBox, height),
      mapX(num(attrs.x2), viewBox, width),
      mapY(num(attrs.y2), viewBox, height),
    )
  }
  for (const match of text.matchAll(/<polyline\b([^>]*)>/gi)) {
    const attrs = parseAttrs(match[1] ?? "")
    const points = String(attrs.points ?? "")
      .trim()
      .split(/\s+/)
      .map((pair) => pair.split(",").map((value) => Number(value)))
      .filter((pair) => pair.length === 2 && pair.every(Number.isFinite))
    for (let index = 1; index < points.length; index++) {
      drawLine(
        grid,
        mapX(points[index - 1][0], viewBox, width),
        mapY(points[index - 1][1], viewBox, height),
        mapX(points[index][0], viewBox, width),
        mapY(points[index][1], viewBox, height),
      )
    }
  }
  for (const match of text.matchAll(/<rect\b([^>]*)>/gi)) {
    const attrs = parseAttrs(match[1] ?? "")
    drawRect(
      grid,
      mapX(num(attrs.x), viewBox, width),
      mapY(num(attrs.y), viewBox, height),
      Math.max(2, Math.round((num(attrs.width) / viewBox.width) * width)),
      Math.max(2, Math.round((num(attrs.height) / viewBox.height) * height)),
    )
  }
  for (const match of text.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/gi)) {
    const attrs = parseAttrs(match[1] ?? "")
    const label = svgSimpleTextContent(match[2] ?? "")
    putText(grid, mapX(num(attrs.x), viewBox, width), mapY(num(attrs.y), viewBox, height), label)
  }

  return grid.map((chars) => ({
    text: chars.join(""),
    cells: chars.map((char) => ({ char, fg: "#d7dde8", bg: "#111318" })),
  }))
}

function parseViewBox(svg: string): { minX: number; minY: number; width: number; height: number } {
  const match = svg.match(/\bviewBox\s*=\s*["']([^"']+)["']/i)
  const values = match?.[1]?.trim().split(/[\s,]+/).map(Number) ?? []
  if (values.length === 4 && values.every(Number.isFinite) && values[2] > 0 && values[3] > 0) {
    return { minX: values[0], minY: values[1], width: values[2], height: values[3] }
  }
  const width = Number(svg.match(/\bwidth\s*=\s*["']([^"']+)["']/i)?.[1] ?? 960)
  const height = Number(svg.match(/\bheight\s*=\s*["']([^"']+)["']/i)?.[1] ?? 640)
  return { minX: 0, minY: 0, width: Number.isFinite(width) && width > 0 ? width : 960, height: Number.isFinite(height) && height > 0 ? height : 640 }
}

function parseAttrs(source: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  for (const match of source.matchAll(/([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*["']([^"']*)["']/g)) {
    attrs[match[1]] = match[2]
  }
  return attrs
}

function num(value: unknown): number {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}

function mapX(value: number, viewBox: { minX: number; width: number }, width: number): number {
  return Math.max(0, Math.min(width - 1, Math.round(((value - viewBox.minX) / viewBox.width) * (width - 1))))
}

function mapY(value: number, viewBox: { minY: number; height: number }, height: number): number {
  return Math.max(0, Math.min(height - 1, Math.round(((value - viewBox.minY) / viewBox.height) * (height - 1))))
}

function drawRect(grid: string[][], x: number, y: number, width: number, height: number): void {
  const x2 = Math.min(grid[0].length - 1, x + width)
  const y2 = Math.min(grid.length - 1, y + height)
  for (let col = x; col <= x2; col++) {
    setCell(grid, col, y, "-")
    setCell(grid, col, y2, "-")
  }
  for (let row = y; row <= y2; row++) {
    setCell(grid, x, row, "|")
    setCell(grid, x2, row, "|")
  }
  setCell(grid, x, y, "+")
  setCell(grid, x2, y, "+")
  setCell(grid, x, y2, "+")
  setCell(grid, x2, y2, "+")
}

function drawLine(grid: string[][], x1: number, y1: number, x2: number, y2: number): void {
  const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1), 1)
  for (let step = 0; step <= steps; step++) {
    const x = Math.round(x1 + ((x2 - x1) * step) / steps)
    const y = Math.round(y1 + ((y2 - y1) * step) / steps)
    setCell(grid, x, y, Math.abs(x2 - x1) >= Math.abs(y2 - y1) ? "-" : "|")
  }
}

function putText(grid: string[][], x: number, y: number, text: string): void {
  const safe = stripControlChars(text).slice(0, 48)
  const start = Math.max(0, Math.min(grid[0].length - safe.length, x - Math.floor(safe.length / 2)))
  for (let index = 0; index < safe.length; index++) {
    setCell(grid, start + index, y, safe[index])
  }
}

function setCell(grid: string[][], x: number, y: number, char: string): void {
  if (y < 0 || y >= grid.length || x < 0 || x >= grid[y].length) return
  grid[y][x] = char
}

function svgSimpleTextContent(value: string): string {
  if (value.includes("<") || value.includes(">")) return ""
  return decodeSvgTextEntities(value).trim()
}

function decodeSvgTextEntities(value: string): string {
  return value.replace(/&(lt|gt|amp|quot|apos);/g, (_, entity: string) => {
    switch (entity) {
      case "lt":
        return "<"
      case "gt":
        return ">"
      case "amp":
        return "&"
      case "quot":
        return '"'
      case "apos":
        return "'"
      default:
        return `&${entity};`
    }
  })
}

function sampleRgb(image: RgbaImage, x: number, y: number, width: number, height: number): [number, number, number] {
  const sx = Math.min(image.width - 1, Math.floor((x / width) * image.width))
  const sy = Math.min(image.height - 1, Math.floor((y / height) * image.height))
  const index = (sy * image.width + sx) * 4
  return [image.data[index] ?? 0, image.data[index + 1] ?? 0, image.data[index + 2] ?? 0]
}

function rgbHex([r, g, b]: [number, number, number]): string {
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

function toHex(value: number): string {
  return Math.max(0, Math.min(255, value)).toString(16).padStart(2, "0")
}

export function extensionForMime(mime: string): string {
  if (mime === "image/png") return ".png"
  if (mime === "image/jpeg") return ".jpg"
  if (mime === "image/webp") return ".webp"
  if (mime === "image/gif") return ".gif"
  if (mime === "image/svg+xml") return ".svg"
  if (mime === "audio/mpeg") return ".mp3"
  if (mime === "audio/ogg") return ".ogg"
  if (mime === "audio/wav") return ".wav"
  if (mime === "audio/flac") return ".flac"
  if (mime === "audio/mp4") return ".m4a"
  if (mime === "audio/aac") return ".aac"
  return ".bin"
}
