// The card text inside a PNG portrait, read without an image library: walk the chunks,
// decode the textual ones, take the card payload.
//
// SillyTavern (`src/character-card-parser.js`, `read`) decodes only `tEXt` chunks and
// prefers a `ccv3` chunk over a `chara` chunk wherever each sits in the file, matching
// keywords case-insensitively. This reader keeps that precedence and also reads `zTXt`
// and compressed or plain `iTXt` chunks, which other card tools write.
import { inflateSync } from "node:zlib";

import { CardError } from "./errors.ts";

export const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
/** A compressed text chunk may inflate to at most this many bytes. */
export const MAX_INFLATED_TEXT_BYTES = 4 * 1024 * 1024;

export function isPng(bytes: Uint8Array): boolean {
  return PNG_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

interface TextChunk {
  readonly keyword: string;
  readonly text: string;
}

/** ISO-8859-1 (each byte is the code point), which the PNG specification gives tEXt. */
function latin1(bytes: Uint8Array): string {
  // WHATWG's "latin1" label is windows-1252, which remaps 0x80-0x9F; decode by hand.
  let out = "";
  for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return out;
}
// SillyTavern turns the payload into text with Node's lenient UTF-8 decoding (bad bytes
// become U+FFFD); an iTXt chunk is UTF-8 by the PNG specification.
const UTF8 = new TextDecoder("utf-8");

function indexOfZero(bytes: Uint8Array, from: number): number {
  for (let i = from; i < bytes.length; i++) if (bytes[i] === 0) return i;
  return -1;
}

function inflate(data: Uint8Array): Uint8Array | null {
  try {
    return inflateSync(data, { maxOutputLength: MAX_INFLATED_TEXT_BYTES });
  } catch (error) {
    if ((error as { code?: unknown }).code === "ERR_BUFFER_TOO_LARGE") {
      throw new CardError("compressed_text_too_large", `compressed character-card text inflates past ${MAX_INFLATED_TEXT_BYTES} bytes`);
    }
    // A corrupt stream is an unreadable chunk, skipped like any other unreadable chunk.
    return null;
  }
}

/** One textual chunk decoded; null when it is malformed (it is then skipped). */
function readTextChunk(type: string, data: Uint8Array): TextChunk | null {
  const separator = indexOfZero(data, 0);
  if (separator < 0) return null;
  const keyword = latin1(data.subarray(0, separator));
  const rest = data.subarray(separator + 1);
  if (type === "tEXt") return { keyword, text: latin1(rest) };
  if (type === "zTXt") {
    if (rest.length < 2 || rest[0] !== 0) return null;
    const inflated = inflate(rest.subarray(1));
    return inflated === null ? null : { keyword, text: UTF8.decode(inflated) };
  }
  // iTXt: compression flag, compression method, language tag\0, translated keyword\0, text.
  if (rest.length < 2 || rest[1] !== 0) return null;
  const compressed = rest[0] !== 0;
  const languageEnd = indexOfZero(rest, 2);
  if (languageEnd < 0) return null;
  const translatedEnd = indexOfZero(rest, languageEnd + 1);
  if (translatedEnd < 0) return null;
  const body = rest.subarray(translatedEnd + 1);
  const bytes = compressed ? inflate(body) : body;
  return bytes === null ? null : { keyword, text: UTF8.decode(bytes) };
}

/**
 * The card payload text of a PNG (still base64): the first `ccv3` chunk if there is one,
 * else the first `chara` chunk. A chunk whose declared length runs past the end of the
 * file ends the walk (a truncated file has nothing reliable after it).
 */
export function extractPngCardText(bytes: Uint8Array): string {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = PNG_SIGNATURE.length;
  let chara: string | null = null;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = latin1(bytes.subarray(offset + 4, offset + 8));
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) break;
    if (type === "tEXt" || type === "zTXt" || type === "iTXt") {
      const chunk = readTextChunk(type, bytes.subarray(dataStart, dataEnd));
      const keyword = chunk?.keyword.toLowerCase();
      if (chunk !== null && keyword === "ccv3") return chunk.text;
      if (chunk !== null && keyword === "chara" && chara === null) chara = chunk.text;
    }
    offset = dataEnd + 4;
  }
  if (chara !== null) return chara;
  throw new CardError("no_card_in_png", "PNG does not contain a SillyTavern character card");
}
