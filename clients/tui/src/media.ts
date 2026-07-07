import { mkdir, readFile, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { basename, extname, join } from "node:path"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
import { PNG } from "pngjs"
import jpeg from "jpeg-js"
import { stripControlChars, type MediaPayload, type MediaRef } from "@loreweaver/protocol"
import type { AppClient } from "./client"
import { tt } from "./i18n"

export interface HalfBlockLine {
  text: string
  cells: Array<{ char: string; fg: string; bg: string }>
}

export interface RgbaImage {
  width: number
  height: number
  data: Uint8Array
}

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

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

export async function readUpload(path: string): Promise<{ name: string; mime: string; bytes: Uint8Array; sha256: string }> {
  const bytes = new Uint8Array(await readFile(path))
  return { name: basename(path), mime: detectImageMime(path), bytes, sha256: sha256Hex(bytes) }
}

export async function readAudioUpload(path: string): Promise<{ name: string; mime: string; bytes: Uint8Array; sha256: string }> {
  const bytes = new Uint8Array(await readFile(path))
  return { name: basename(path), mime: detectAudioMime(path), bytes, sha256: sha256Hex(bytes) }
}

export async function readMediaUpload(path: string): Promise<{ name: string; mime: string; bytes: Uint8Array; sha256: string }> {
  const bytes = new Uint8Array(await readFile(path))
  return { name: basename(path), mime: detectMediaMime(path), bytes, sha256: sha256Hex(bytes) }
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

export async function getCachedMedia(client: AppClient, media: MediaRef): Promise<MediaPayload> {
  const path = cachePath(media.hash)
  if (existsSync(path)) {
    const bytes = new Uint8Array(await readFile(path))
    if (sha256Hex(bytes) === media.hash) {
      return { hash: media.hash, mime: media.mime, name: media.name ?? media.hash, bytes }
    }
  }
  const payload = await client.getMedia(media.hash)
  if (sha256Hex(payload.bytes) !== media.hash) throw new Error("media checksum mismatch")
  try {
    await mkdir(mediaCacheDir(), { recursive: true })
    await writeFile(path, payload.bytes)
  } catch {
    // A read-only home directory should not break viewing; it only disables the cache.
  }
  return payload
}

export async function openMedia(client: AppClient, media: MediaRef): Promise<void> {
  const payload = await getCachedMedia(client, media)
  const dir = join(tmpdir(), "loreweaver-media")
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${payload.hash}${extensionForMime(payload.mime)}`)
  await writeFile(path, payload.bytes)
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open"
  const args = process.platform === "win32" ? ["/c", "start", "", path] : [path]
  const child = spawn(command, args, { detached: true, stdio: "ignore" })
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

export function mediaPlaceholder(media: MediaRef, locale?: string): string {
  const name = stripControlChars(media.name ?? media.hash.slice(0, 12))
  if (media.mime === "image/gif" || media.mime === "image/webp") {
    return tt(locale, "media.placeholderNoPreview", { name })
  }
  return tt(locale, "media.placeholder", { name })
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

function cachePath(hash: string): string {
  return join(mediaCacheDir(), hash)
}

function mediaCacheDir(): string {
  return process.env.LOREWEAVER_MEDIA_CACHE_DIR || join(homedir(), ".loreweaver", "cache", "media")
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
