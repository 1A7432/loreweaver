import type { RgbaImage } from "./media"

export interface SixelImage {
  width: number
  height: number
  data: Uint8Array
}

const R_LEVELS = 6
const G_LEVELS = 7
const B_LEVELS = 6

export function paletteIndexForRgb(r: number, g: number, b: number): number {
  const ri = quantizeChannel(r, R_LEVELS)
  const gi = quantizeChannel(g, G_LEVELS)
  const bi = quantizeChannel(b, B_LEVELS)
  return ri * G_LEVELS * B_LEVELS + gi * B_LEVELS + bi
}

export function encodeSixel(image: SixelImage): string {
  const indexed = ditherToPalette(image)
  const chunks: string[] = ["\x1bPq", paletteDefinitions()]
  for (let bandY = 0; bandY < image.height; bandY += 6) {
    if (bandY > 0) chunks.push("-")
    for (let color = 0; color < R_LEVELS * G_LEVELS * B_LEVELS; color++) {
      const row = colorRow(indexed, image.width, image.height, bandY, color)
      if (!row.some((mask) => mask !== 0)) continue
      chunks.push(`#${color}`)
      chunks.push(rle(row.map((mask) => String.fromCharCode(0x3f + mask)).join("")))
      chunks.push("$")
    }
  }
  chunks.push("\x1b\\")
  return chunks.join("")
}

export function resizeRgbaArea(image: RgbaImage, width: number, height: number): SixelImage {
  const targetWidth = Math.max(1, Math.floor(width))
  const targetHeight = Math.max(1, Math.floor(height))
  const out = new Uint8Array(targetWidth * targetHeight * 4)
  for (let y = 0; y < targetHeight; y++) {
    for (let x = 0; x < targetWidth; x++) {
      const sx0 = Math.floor((x / targetWidth) * image.width)
      const sx1 = Math.max(sx0 + 1, Math.ceil(((x + 1) / targetWidth) * image.width))
      const sy0 = Math.floor((y / targetHeight) * image.height)
      const sy1 = Math.max(sy0 + 1, Math.ceil(((y + 1) / targetHeight) * image.height))
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let count = 0
      for (let sy = sy0; sy < Math.min(image.height, sy1); sy++) {
        for (let sx = sx0; sx < Math.min(image.width, sx1); sx++) {
          const index = (sy * image.width + sx) * 4
          r += image.data[index] ?? 0
          g += image.data[index + 1] ?? 0
          b += image.data[index + 2] ?? 0
          a += image.data[index + 3] ?? 255
          count += 1
        }
      }
      const offset = (y * targetWidth + x) * 4
      out[offset] = Math.round(r / count)
      out[offset + 1] = Math.round(g / count)
      out[offset + 2] = Math.round(b / count)
      out[offset + 3] = Math.round(a / count)
    }
  }
  return { width: targetWidth, height: targetHeight, data: out }
}

function ditherToPalette(image: SixelImage): Uint16Array {
  const pixels = new Float32Array(image.width * image.height * 3)
  for (let i = 0, p = 0; i < image.data.length; i += 4, p += 3) {
    pixels[p] = image.data[i] ?? 0
    pixels[p + 1] = image.data[i + 1] ?? 0
    pixels[p + 2] = image.data[i + 2] ?? 0
  }
  const out = new Uint16Array(image.width * image.height)
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const pixel = y * image.width + x
      const offset = pixel * 3
      const oldR = clamp255(pixels[offset])
      const oldG = clamp255(pixels[offset + 1])
      const oldB = clamp255(pixels[offset + 2])
      const index = paletteIndexForRgb(oldR, oldG, oldB)
      out[pixel] = index
      const [newR, newG, newB] = rgbForPaletteIndex(index)
      diffuse(pixels, image.width, image.height, x, y, oldR - newR, oldG - newG, oldB - newB)
    }
  }
  return out
}

function diffuse(pixels: Float32Array, width: number, height: number, x: number, y: number, er: number, eg: number, eb: number): void {
  addError(pixels, width, height, x + 1, y, er, eg, eb, 7 / 16)
  addError(pixels, width, height, x - 1, y + 1, er, eg, eb, 3 / 16)
  addError(pixels, width, height, x, y + 1, er, eg, eb, 5 / 16)
  addError(pixels, width, height, x + 1, y + 1, er, eg, eb, 1 / 16)
}

function addError(pixels: Float32Array, width: number, height: number, x: number, y: number, er: number, eg: number, eb: number, factor: number): void {
  if (x < 0 || y < 0 || x >= width || y >= height) return
  const offset = (y * width + x) * 3
  pixels[offset] += er * factor
  pixels[offset + 1] += eg * factor
  pixels[offset + 2] += eb * factor
}

function colorRow(indexed: Uint16Array, width: number, height: number, bandY: number, color: number): number[] {
  const row: number[] = []
  for (let x = 0; x < width; x++) {
    let mask = 0
    for (let bit = 0; bit < 6; bit++) {
      const y = bandY + bit
      if (y < height && indexed[y * width + x] === color) mask |= 1 << bit
    }
    row.push(mask)
  }
  return row
}

function paletteDefinitions(): string {
  const defs: string[] = []
  for (let index = 0; index < R_LEVELS * G_LEVELS * B_LEVELS; index++) {
    const [r, g, b] = rgbForPaletteIndex(index)
    defs.push(`#${index};2;${pct(r)};${pct(g)};${pct(b)}`)
  }
  return defs.join("")
}

function rgbForPaletteIndex(index: number): [number, number, number] {
  const ri = Math.floor(index / (G_LEVELS * B_LEVELS))
  const gi = Math.floor((index % (G_LEVELS * B_LEVELS)) / B_LEVELS)
  const bi = index % B_LEVELS
  return [
    Math.round((ri / (R_LEVELS - 1)) * 255),
    Math.round((gi / (G_LEVELS - 1)) * 255),
    Math.round((bi / (B_LEVELS - 1)) * 255),
  ]
}

function quantizeChannel(value: number, levels: number): number {
  return Math.max(0, Math.min(levels - 1, Math.round((clamp255(value) / 255) * (levels - 1))))
}

function pct(value: number): number {
  return Math.round((value / 255) * 100)
}

function clamp255(value: number): number {
  return Math.max(0, Math.min(255, Number.isFinite(value) ? value : 0))
}

function rle(text: string): string {
  let out = ""
  for (let index = 0; index < text.length; ) {
    const char = text[index]
    let count = 1
    while (index + count < text.length && text[index + count] === char) count += 1
    out += count > 3 ? `!${count}${char}` : char.repeat(count)
    index += count
  }
  return out
}
