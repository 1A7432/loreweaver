// What the server embeds text with: the interface, and the deterministic local embedder
// that needs no network and is the default for any provider without an embeddings
// endpoint (DeepSeek, Groq, a chat-only local model, …). A real endpoint is
// `OpenAIEmbeddings`; swapping it in improves recall quality and changes nothing else.
import { createHash } from "node:crypto";

import { RecallError, requirePositiveInteger } from "./errors.ts";

export interface EmbedOptions {
  readonly signal?: AbortSignal;
}

export interface Embeddings {
  /** Every vector this embedder returns has exactly this many components. */
  readonly dimensions: number;
  /** One vector per text, in order. An empty list makes no call and returns an empty list. */
  embed(texts: readonly string[], options?: EmbedOptions): Promise<Float64Array[]>;
}

export const DEFAULT_HASH_DIMENSIONS = 64;

// Runs of Han, Hiragana and Katakana (plus the katakana prolonged-sound mark, which Unicode
// files under Common). Korean is not here: Hangul is written with spaces, so whitespace
// tokens already separate its words.
const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]+/gu;

/**
 * The tokens a text votes with: its whitespace-separated words, plus every pair of
 * adjacent CJK characters.
 *
 * The bigrams are a deliberate addition to a plain whitespace split: Chinese and Japanese
 * have no spaces, so a whole sentence would be ONE token and two sentences about the same
 * thing would share nothing. With bigrams they share the character pairs they have in
 * common (a two-character word is both a word token and a bigram when it stands alone;
 * that doubles its vote, which is harmless). A text with no word at all (empty, or only
 * whitespace) votes with the single empty token rather than not at all.
 */
export function hashTokens(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens = lower.split(/\s+/u).filter((word) => word !== "");
  if (tokens.length === 0) return [""];
  for (const [run] of lower.matchAll(CJK_RUN)) {
    const characters = Array.from(run);
    for (let i = 0; i + 1 < characters.length; i++) tokens.push(`${characters[i]}${characters[i + 1]}`);
  }
  return tokens;
}

/**
 * Deterministic hashed bag-of-tokens vectors, so a vector is a plain, documented function of
 * its text: every token votes +1 or -1 on one of `dimensions` buckets, then the vector is
 * scaled to unit length.
 *
 * - bucket = the first four bytes of sha256(token as UTF-8), read big-endian, modulo `dimensions`;
 * - sign = + when byte 4 of the digest is even, - when odd;
 * - tokens: see `hashTokens` (text lower-cased with the locale-independent `toLowerCase`,
 *   split on Unicode whitespace, plus CJK bigrams);
 * - an all-zero result (the votes cancelled out) becomes the unit vector on axis 0, so
 *   every vector has length 1.
 *
 * Votes are integers, so the sums are exact and the same text gives bit-identical vectors on
 * every machine. Texts sharing more tokens have a higher cosine similarity than texts
 * sharing none: enough for retrieval without a model. Apart from the CJK bigrams this is the
 * scheme of the 2.6 Python embedder (`FakeEmbeddings`), vector for vector.
 */
export class HashEmbeddings implements Embeddings {
  readonly dimensions: number;

  constructor(dimensions: number = DEFAULT_HASH_DIMENSIONS) {
    this.dimensions = requirePositiveInteger("dimensions", dimensions);
  }

  async embed(texts: readonly string[], options: EmbedOptions = {}): Promise<Float64Array[]> {
    if (options.signal?.aborted) throw new RecallError("aborted", { cause: options.signal.reason });
    return texts.map((text) => this.#embedOne(text));
  }

  #embedOne(text: string): Float64Array {
    const votes = new Float64Array(this.dimensions);
    for (const token of hashTokens(text)) {
      const digest = createHash("sha256").update(token, "utf8").digest();
      const bucket = digest.readUInt32BE(0) % this.dimensions;
      votes[bucket] = (votes[bucket] ?? 0) + ((digest[4] ?? 0) % 2 === 0 ? 1 : -1);
    }
    let squares = 0;
    for (const vote of votes) squares += vote * vote;
    if (squares === 0) {
      votes[0] = 1;
      return votes;
    }
    const norm = Math.sqrt(squares);
    for (let i = 0; i < votes.length; i++) votes[i] = (votes[i] ?? 0) / norm;
    return votes;
  }
}
