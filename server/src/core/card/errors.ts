/**
 * The one error type of the card layer: card bytes that cannot be read as a card at all.
 * Anything smaller — a malformed lore entry in a lorecard, an unusable variable spec —
 * is reported as a warning in the result instead, so one bad row never costs an author
 * the whole card. A card past a bound is refused with a code, never cut down to fit.
 *
 * The message is an English diagnostic; callers branch on `code`.
 */
export type CardErrorCode =
  /** The file is larger than the card size limit. */
  | "too_large"
  /** Neither JSON nor a PNG. */
  | "unsupported_format"
  /** JSON text that does not parse (or is not UTF-8). */
  | "bad_json"
  /** JSON nested deeper than the card layer reads. */
  | "too_deep"
  /** The top-level JSON value is not an object. */
  | "not_an_object"
  /** A PNG without a `chara` or `ccv3` text chunk. */
  | "no_card_in_png"
  /** The embedded payload is not base64 JSON. */
  | "bad_embedded_payload"
  /** The embedded payload is JSON but not an object. */
  | "embedded_not_an_object"
  /** A compressed text chunk inflates past the size limit (a zlib bomb). */
  | "compressed_text_too_large"
  /** A character book with more entries than the card layer reads. */
  | "too_many_entries"
  /** A lorecard `format_version` this build does not read (older or newer). */
  | "unsupported_version"
  /** A lorecard `format_version` that is not an integer. */
  | "bad_version"
  /** A lorecard declaring more variables than a room holds. */
  | "too_many_variables";

export class CardError extends Error {
  readonly code: CardErrorCode;

  constructor(code: CardErrorCode, detail: string) {
    super(detail);
    this.name = "CardError";
    this.code = code;
  }
}
