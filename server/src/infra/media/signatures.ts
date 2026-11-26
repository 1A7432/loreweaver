// File signatures. A client's declared MIME type decides which limits apply and how
// clients will treat the bytes, so the bytes must at least start the way files of that
// type start. This is not a decoder: a file that passes may still be broken, but it can
// no longer be one type wearing another's label (an SVG declared as PNG, say).
//
// Images have fixed signatures. For audio the checks are what each format makes
// practical: WAV, FLAC, Ogg and MP4 have fixed magic; MP3 and AAC are raw frame streams,
// so they are recognised by an ID3 tag or a frame-sync header whose layer bits match
// the format (MPEG audio layers 1–3 for MP3, layer 0 — the ADTS marker — for AAC).
import type { UploadMime } from "./policy.ts";
import { isSafeSvg, SVG_MIME } from "./svg.ts";

function startsWith(bytes: Uint8Array, offset: number, expected: readonly number[]): boolean {
  if (bytes.length < offset + expected.length) return false;
  return expected.every((byte, index) => bytes[offset + index] === byte);
}

function ascii(text: string): number[] {
  return Array.from(text, (char) => char.charCodeAt(0));
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];
const RIFF = ascii("RIFF");

function hasId3(bytes: Uint8Array): boolean {
  return startsWith(bytes, 0, ascii("ID3"));
}

/** An MPEG audio frame header: 11 sync bits, then the layer field (bits 1–2 of byte 1). */
function frameSync(bytes: Uint8Array): { layer: number } | undefined {
  const b0 = bytes[0];
  const b1 = bytes[1];
  if (b0 !== 0xff || b1 === undefined || (b1 & 0xe0) !== 0xe0) return undefined;
  return { layer: (b1 >> 1) & 0x03 };
}

/** Whether `bytes` match the signature of `mime`. SVG is checked by its validator instead. */
export function matchesSignature(mime: UploadMime, bytes: Uint8Array): boolean {
  switch (mime) {
    case "image/png":
      return startsWith(bytes, 0, PNG);
    case "image/jpeg":
      return startsWith(bytes, 0, JPEG);
    case "image/gif":
      return startsWith(bytes, 0, ascii("GIF87a")) || startsWith(bytes, 0, ascii("GIF89a"));
    case "image/webp":
      return startsWith(bytes, 0, RIFF) && startsWith(bytes, 8, ascii("WEBP"));
    case SVG_MIME:
      return isSafeSvg(bytes);
    case "audio/wav":
      return startsWith(bytes, 0, RIFF) && startsWith(bytes, 8, ascii("WAVE"));
    case "audio/flac":
      return startsWith(bytes, 0, ascii("fLaC"));
    case "audio/ogg":
      return startsWith(bytes, 0, ascii("OggS"));
    case "audio/mp4":
      return startsWith(bytes, 4, ascii("ftyp"));
    case "audio/mpeg": {
      if (hasId3(bytes)) return true;
      const sync = frameSync(bytes);
      return sync !== undefined && sync.layer !== 0;
    }
    case "audio/aac": {
      if (hasId3(bytes) || startsWith(bytes, 0, ascii("ADIF"))) return true;
      const sync = frameSync(bytes);
      return sync !== undefined && sync.layer === 0;
    }
  }
}
