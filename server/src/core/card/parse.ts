// Card bytes in, one imported card out: a native bundle when the bytes declare one,
// otherwise a SillyTavern card (JSON or PNG).
import { parseStCardBytes, type CharacterCard } from "./card.ts";
import { looksLikeLorecard, parseLorecard, type Lorecard } from "./lorecard.ts";
import { countCardHooks } from "./split.ts";

export interface ImportedCard {
  readonly source: "sillytavern" | "lorecard";
  readonly card: CharacterCard;
  /** The native bundle's extras; null for a SillyTavern card. */
  readonly lorecard: Lorecard | null;
  /** Hook scripts the card carries. 3.0 runs none; they are counted, never kept. */
  readonly unsupportedHooks: number;
}

/** Parse card bytes; throws `CardError` when they are not a readable card. */
export function parseCard(bytes: Uint8Array, filename = ""): ImportedCard {
  if (looksLikeLorecard(bytes)) {
    const lorecard = parseLorecard(bytes, filename);
    return { source: "lorecard", card: lorecard.card, lorecard, unsupportedHooks: lorecard.unsupportedHooks };
  }
  const card = parseStCardBytes(bytes, filename);
  return { source: "sillytavern", card, lorecard: null, unsupportedHooks: countCardHooks(card.raw) };
}
