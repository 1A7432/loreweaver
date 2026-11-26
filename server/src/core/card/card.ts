// A SillyTavern character card (spec v1, v2 or v3; JSON or PNG) read into one shape.
//
// Field selection follows SillyTavern's own import (`importFromJson` and `readFromV2` in
// `src/endpoints/characters.js`): a document that has a `spec` key, whatever its value,
// reads its fields from `data`, falling back to the root for a field `data` lacks; a
// document without `spec` is a v1 card and reads the root. The v2 and v3 specs
// (github.com/malfoyslastname/character-card-spec-v2 `spec_v2.md`,
// github.com/kwaroran/character-card-spec-v3 `SPEC_V3.md`) define every prose field as a
// string; how a non-string is read is decided per field below.
import type { JsonObject } from "../documents/model.ts";
import { CardError } from "./errors.ts";
import { extractPngCardText, isPng } from "./png.ts";
import { Buffer } from "node:buffer";

/** A SillyTavern card file (a portrait plus JSON) is far smaller; this refuses an OOM feed. */
export const MAX_CARD_FILE_BYTES = 16 * 1024 * 1024;
/** JSON nesting the card layer reads; real cards nest well under ten levels. */
export const MAX_CARD_JSON_DEPTH = 64;
/** Character-book entries a card may carry. */
export const MAX_BOOK_ENTRIES = 1000;

/** One lorebook entry as the card carries it (SillyTavern's V2 entry shape, unvalidated). */
export type BookEntry = JsonObject;

export interface CharacterCard {
  readonly name: string;
  readonly description: string;
  readonly personality: string;
  readonly scenario: string;
  readonly firstMessage: string;
  readonly exampleMessages: string;
  readonly creatorNotes: string;
  /** V3 `creator_notes_multilingual`: notes by ISO 639-1 language code. */
  readonly creatorNotesMultilingual: Readonly<Record<string, string>>;
  /** The card's standing directives (V2 `system_prompt`, `post_history_instructions`). */
  readonly systemPrompt: string;
  readonly postHistoryInstructions: string;
  readonly tags: readonly string[];
  readonly alternateGreetings: readonly string[];
  readonly book: readonly BookEntry[];
  /** The document as read (the embedded one, for a PNG); null on a split's character half. */
  readonly raw: JsonObject | null;
}

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A prose field. A string is itself; a number or boolean is its JSON text (`42`, `true`
 * — what JavaScript, and so SillyTavern's templating, prints for it); null, an object or
 * an array is absent (`""`): the specs require a string, and the text of a structure
 * (`[object Object]`, or the old Python `{'a': 1}`) is not prose anyone wrote.
 */
export function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "true" : "false";
  return "";
}

/**
 * `tags`: a list keeps its non-empty strings (other items are not tags and are dropped);
 * a string is split on commas, trimmed, empties dropped — SillyTavern's own reading of a
 * string `tags` (`charaFormatData`).
 */
function tagList(value: unknown): string[] {
  if (typeof value === "string") return value.split(",").map((tag) => tag.trim()).filter((tag) => tag !== "");
  if (!Array.isArray(value)) return [];
  return value.filter((tag): tag is string => typeof tag === "string" && tag !== "");
}

/** `alternate_greetings`: a list keeps its strings; one string is one greeting (`getAlternateGreetings`). */
function greetingList(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((greeting): greeting is string => typeof greeting === "string");
}

/** V3 `creator_notes_multilingual`: string values only; anything else is not a note. */
function multilingual(value: unknown): Record<string, string> {
  if (!isObject(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function bookEntries(book: unknown): BookEntry[] {
  if (!isObject(book) || !Array.isArray(book.entries)) return [];
  if (book.entries.length > MAX_BOOK_ENTRIES) {
    throw new CardError("too_many_entries", `character book has ${book.entries.length} entries; at most ${MAX_BOOK_ENTRIES} are read`);
  }
  return book.entries.filter(isObject);
}

/** A parsed SillyTavern card document as a `CharacterCard`. */
export function normalizeStCard(raw: unknown): CharacterCard {
  if (!isObject(raw)) throw new CardError("not_an_object", "character card JSON must be an object");
  const versioned = raw.spec !== undefined;
  const data = versioned && isObject(raw.data) ? raw.data : null;
  // `readFromV2`: a mapped field comes from `data` when present there, else stays the root's.
  const mapped = (field: string): unknown => (data !== null && data[field] !== undefined ? data[field] : raw[field]);
  // Fields that exist only in the V2 body (`creator_notes`, `system_prompt`, ...).
  const body = (field: string): unknown => (versioned ? data?.[field] : raw[field]);
  const creatorNotes = versioned ? data?.creator_notes : (raw.creatorcomment ?? raw.creator_notes);
  return {
    name: text(mapped("name")),
    description: text(mapped("description")),
    personality: text(mapped("personality")),
    scenario: text(mapped("scenario")),
    firstMessage: text(mapped("first_mes")),
    exampleMessages: text(mapped("mes_example")),
    creatorNotes: text(creatorNotes),
    creatorNotesMultilingual: multilingual(body("creator_notes_multilingual")),
    systemPrompt: text(body("system_prompt")),
    postHistoryInstructions: text(body("post_history_instructions")),
    tags: tagList(mapped("tags")),
    alternateGreetings: greetingList(body("alternate_greetings")),
    book: bookEntries(body("character_book")),
    raw,
  };
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

const UTF8_STRICT = new TextDecoder("utf-8", { fatal: true });

/** Bytes as UTF-8 text (a leading byte-order mark dropped); null when not UTF-8. */
export function utf8(bytes: Uint8Array): string | null {
  try {
    return UTF8_STRICT.decode(bytes);
  } catch {
    return null;
  }
}

/** The nesting depth of JSON text, counted outside strings (stops early past `limit`). */
function jsonDepthExceeds(source: string, limit: number): boolean {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source.charCodeAt(i);
    if (inString) {
      if (ch === 0x5c) i += 1;
      else if (ch === 0x22) inString = false;
      continue;
    }
    if (ch === 0x22) inString = true;
    else if (ch === 0x7b || ch === 0x5b) {
      depth += 1;
      if (depth > limit) return true;
    } else if (ch === 0x7d || ch === 0x5d) depth -= 1;
  }
  return false;
}

/** JSON text parsed, bounded in depth; throws `CardError`. */
export function parseJsonText(source: string): unknown {
  if (jsonDepthExceeds(source, MAX_CARD_JSON_DEPTH)) throw new CardError("too_deep", `JSON nests deeper than ${MAX_CARD_JSON_DEPTH} levels`);
  try {
    return JSON.parse(source) as unknown;
  } catch (error) {
    throw new CardError("bad_json", error instanceof Error ? error.message : "invalid JSON");
  }
}

function looksLikeJson(bytes: Uint8Array, filename: string): boolean {
  if (filename.toLowerCase().endsWith(".json")) return true;
  for (const byte of bytes) {
    if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) continue;
    return byte === 0x7b || byte === 0x5b;
  }
  return false;
}

/**
 * The embedded card of a PNG: base64 decoded the way SillyTavern decodes it (Node's
 * `Buffer.from(text, 'base64')`, which skips whitespace and stray characters), then UTF-8
 * text (a byte-order mark tolerated) parsed as a JSON object.
 */
function decodeEmbedded(payload: string): JsonObject {
  const decoded = new TextDecoder("utf-8").decode(Buffer.from(payload, "base64"));
  let parsed: unknown;
  try {
    parsed = parseJsonText(decoded);
  } catch (error) {
    if (error instanceof CardError && error.code === "too_deep") throw error;
    throw new CardError("bad_embedded_payload", "invalid embedded character card payload");
  }
  if (!isObject(parsed)) throw new CardError("embedded_not_an_object", "embedded character card payload is not a JSON object");
  return parsed;
}

/**
 * A SillyTavern card from file bytes. A PNG is recognized by its signature whatever the
 * file is called (SillyTavern goes by the extension; the bytes are the better witness);
 * JSON by a `.json` name or a leading `{` / `[`; anything else is tried as JSON and
 * otherwise refused.
 */
export function parseStCardBytes(bytes: Uint8Array, filename = ""): CharacterCard {
  if (bytes.length > MAX_CARD_FILE_BYTES) throw new CardError("too_large", `character card exceeds ${MAX_CARD_FILE_BYTES} bytes`);
  if (isPng(bytes)) return normalizeStCard(decodeEmbedded(extractPngCardText(bytes)));
  const source = utf8(bytes);
  if (looksLikeJson(bytes, filename)) {
    if (source === null) throw new CardError("bad_json", "card JSON is not UTF-8 text");
    return normalizeStCard(parseJsonText(source));
  }
  if (source !== null) {
    let parsed: unknown;
    try {
      parsed = parseJsonText(source);
    } catch (error) {
      if (error instanceof CardError && error.code === "too_deep") throw error;
      throw new CardError("unsupported_format", "unsupported character card format");
    }
    return normalizeStCard(parsed);
  }
  throw new CardError("unsupported_format", "unsupported character card format");
}
