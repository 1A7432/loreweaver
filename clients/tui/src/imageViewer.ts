import { PNG } from "pngjs"
import type { MediaRef } from "@loreweaver/protocol"
import { decodeImage, getCachedMedia, openMedia, renderHalfBlockPreview, type HalfBlockLine } from "./media"
import { encodeSixel, resizeRgbaArea } from "./sixel"
import type { AppClient } from "./client"
import { tt } from "./i18n"

export interface RendererLike {
  capabilities?: { kitty_graphics?: boolean; sixel?: boolean } | null
  suspend?: () => void
  resume?: () => void
}

export type ViewerMode = "kitty" | "iterm2" | "sixel" | "modal"

export interface TerminalPixelSize {
  width: number
  height: number
}

export interface ViewImageOptions {
  client: AppClient
  media: MediaRef
  renderer?: RendererLike
  locale?: string
  forceSystem?: boolean
  columns?: number
  rows?: number
  env?: Record<string, string | undefined>
  write?: (text: string) => void
  readKey?: () => Promise<void>
  queryWindowPixels?: (columns: number, rows: number, write: (text: string) => void) => Promise<TerminalPixelSize | undefined>
}

export function chooseViewerMode(
  capabilities?: { kitty_graphics?: boolean; sixel?: boolean } | null,
  env: Record<string, string | undefined> = process.env,
): ViewerMode {
  if (capabilities?.kitty_graphics) return "kitty"
  if (isIterm(env)) return "iterm2"
  if (capabilities?.sixel) return "sixel"
  return "modal"
}

export function kittyImageSequences(bytes: Uint8Array, columns: number, rows: number): string[] {
  const b64 = Buffer.from(bytes).toString("base64")
  const chunks: string[] = []
  for (let offset = 0; offset < b64.length; offset += 4096) {
    const chunk = b64.slice(offset, offset + 4096)
    const more = offset + 4096 < b64.length ? 1 : 0
    // Control keys ride ONLY the first chunk — the kitty protocol requires every
    // continuation chunk to carry nothing but the `m` key, or the image is rejected.
    chunks.push(
      offset === 0
        ? `\x1b_Ga=T,f=100,q=2,c=${columns},r=${rows},m=${more};${chunk}\x1b\\`
        : `\x1b_Gm=${more};${chunk}\x1b\\`,
    )
  }
  return chunks
}

// kitty's `f=100` transfer format is PNG-only — raw JPEG bytes would be rejected, so
// re-encode through the pure-JS decoders before handing bytes to the terminal.
export function toPngBytes(bytes: Uint8Array, mime: string): Uint8Array {
  if (mime === "image/png") return bytes
  const decoded = decodeImage(bytes, mime)
  const png = new PNG({ width: decoded.width, height: decoded.height })
  png.data = Buffer.from(decoded.data)
  return new Uint8Array(PNG.sync.write(png))
}

export function pngDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.byteLength < 24) return undefined
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(12) !== 0x49484452) return undefined // "IHDR"
  const width = view.getUint32(16)
  const height = view.getUint32(20)
  if (width <= 0 || height <= 0) return undefined
  return { width, height }
}

// The `c=,r=` box stretches the image to fill it, so derive a box that preserves the
// image's aspect ratio, treating a terminal cell as twice as tall as it is wide.
export function fitDisplayCells(
  imageWidth: number,
  imageHeight: number,
  columns: number,
  rows: number,
): { columns: number; rows: number } {
  const fitted = fitImageToArea(imageWidth, imageHeight, Math.max(1, columns), Math.max(1, rows) * 2)
  return { columns: Math.max(1, fitted.width), rows: Math.max(1, Math.ceil(fitted.height / 2)) }
}

export function kittyDeleteSequence(): string {
  return "\x1b_Ga=d,d=A\x1b\\"
}

export function iterm2ImageSequence(bytes: Uint8Array, columns: number): string {
  const b64 = Buffer.from(bytes).toString("base64")
  return `\x1b]1337;File=inline=1;size=${bytes.byteLength};width=${columns};preserveAspectRatio=1:${b64}\x07`
}

export function parseWindowPixelSize(reply: string): TerminalPixelSize | undefined {
  const match = reply.match(/\x1b\[4;(\d+);(\d+)t/)
  if (!match) return undefined
  const height = Number(match[1])
  const width = Number(match[2])
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined
  return { width, height }
}

export function fitImageToArea(imageWidth: number, imageHeight: number, areaWidth: number, areaHeight: number): TerminalPixelSize {
  const safeImageWidth = Math.max(1, imageWidth)
  const safeImageHeight = Math.max(1, imageHeight)
  const safeAreaWidth = Math.max(1, areaWidth)
  const safeAreaHeight = Math.max(1, areaHeight)
  const scale = Math.min(safeAreaWidth / safeImageWidth, safeAreaHeight / safeImageHeight)
  return {
    width: Math.max(1, Math.floor(safeImageWidth * scale)),
    height: Math.max(1, Math.floor(safeImageHeight * scale)),
  }
}

export async function viewImage(options: ViewImageOptions): Promise<HalfBlockLine[] | undefined> {
  if (options.forceSystem) {
    await openMedia(options.client, options.media)
    return undefined
  }

  const payload = await getCachedMedia(options.client, options.media)
  const columns = options.columns ?? Math.max(20, (process.stdout.columns || 80) - 4)
  const rows = options.rows ?? Math.max(10, (process.stdout.rows || 24) - 4)
  // No in-terminal decoder for these in ANY mode — hand off to the system viewer.
  if (payload.mime === "image/gif" || payload.mime === "image/webp") {
    await openMedia(options.client, options.media)
    return undefined
  }
  // SVG is never executed as browser content; its text-map preview is the only in-terminal
  // view, so it always takes the modal path regardless of graphics capabilities.
  const mode = payload.mime === "image/svg+xml" ? "modal" : chooseViewerMode(options.renderer?.capabilities, options.env)
  if (mode === "modal") {
    return renderHalfBlockPreview(payload.bytes, payload.mime, Math.min(56, columns), Math.min(28, rows))
  }

  const write = options.write ?? ((text: string) => process.stdout.write(text))
  const readKey = options.readKey ?? waitForAnyKey
  options.renderer?.suspend?.()
  try {
    const terminalPixels =
      mode === "sixel" ? await (options.queryWindowPixels ?? queryTerminalPixelSize)(columns, rows, write) : undefined
    write("\x1b[2J\x1b[H")
    if (mode === "kitty") {
      const png = toPngBytes(payload.bytes, payload.mime)
      const dims = pngDimensions(png)
      const box = dims ? fitDisplayCells(dims.width, dims.height, columns, rows - 1) : { columns, rows: rows - 1 }
      for (const sequence of kittyImageSequences(png, box.columns, box.rows)) write(sequence)
    } else if (mode === "iterm2") {
      write(iterm2ImageSequence(payload.bytes, columns))
    } else {
      const decoded = decodeImage(payload.bytes, payload.mime)
      const cellWidth = terminalPixels ? terminalPixels.width / Math.max(1, columns) : 10
      const cellHeight = terminalPixels ? terminalPixels.height / Math.max(1, rows) : 20
      const target = fitImageToArea(
        decoded.width,
        decoded.height,
        Math.floor(columns * cellWidth),
        Math.floor((rows - 1) * cellHeight),
      )
      const scaled = resizeRgbaArea(decoded, target.width, target.height)
      write(encodeSixel(scaled))
    }
    write(`\n${tt(options.locale, "viewer.close")}`)
    await readKey()
    write(mode === "kitty" ? kittyDeleteSequence() : "\x1b[2J\x1b[H")
  } finally {
    options.renderer?.resume?.()
  }
  return undefined
}

function isIterm(env: Record<string, string | undefined>): boolean {
  return /iterm/i.test(env.TERM_PROGRAM ?? "") || /iterm/i.test(env.LC_TERMINAL ?? "")
}

async function queryTerminalPixelSize(_columns: number, _rows: number, write: (text: string) => void): Promise<TerminalPixelSize | undefined> {
  const stdin = process.stdin
  const wasRaw = Boolean(stdin.isRaw)
  if (stdin.setRawMode) stdin.setRawMode(true)
  stdin.resume()
  try {
    return await new Promise<TerminalPixelSize | undefined>((resolve) => {
      const cleanup = (value: TerminalPixelSize | undefined) => {
        clearTimeout(timer)
        stdin.off("data", onData)
        resolve(value)
      }
      const onData = (chunk: Buffer) => {
        const parsed = parseWindowPixelSize(chunk.toString("utf8"))
        if (parsed) cleanup(parsed)
      }
      const timer = setTimeout(() => cleanup(undefined), 200)
      stdin.on("data", onData)
      write("\x1b[14t")
    })
  } finally {
    if (stdin.setRawMode) stdin.setRawMode(wasRaw)
    if (!wasRaw) stdin.pause()
  }
}

async function waitForAnyKey(): Promise<void> {
  const stdin = process.stdin
  const wasRaw = Boolean(stdin.isRaw)
  if (stdin.setRawMode) stdin.setRawMode(true)
  stdin.resume()
  await new Promise<void>((resolve) => {
    const done = () => {
      stdin.off("data", done)
      resolve()
    }
    stdin.once("data", done)
  })
  if (stdin.setRawMode) stdin.setRawMode(wasRaw)
  stdin.pause()
}
