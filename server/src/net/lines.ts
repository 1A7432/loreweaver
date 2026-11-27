// Newline-delimited JSON over a byte stream: one compact object per line.

const encoder = new TextEncoder();

export function encodeLine(value: unknown): Uint8Array {
  return encoder.encode(`${JSON.stringify(value)}\n`);
}

/**
 * Feed it chunks as they arrive; it calls back once per complete line, parsed.
 *
 * A line is bounded (`maxLineChars`, the protocol's `MAX_LINE_BYTES` for a connection): a peer
 * that keeps sending without ever ending the line would otherwise be buffered without end —
 * by a server, from a connection that has not even said hello. Past the bound the reader
 * calls `onOverflow` once, drops what it holds and ignores everything after.
 */
export class LineReader {
  readonly #decoder = new TextDecoder("utf-8");
  readonly #onValue: (value: unknown) => void;
  readonly #onGarbage: () => void;
  readonly #onOverflow: () => void;
  readonly #maxLineChars: number;
  #buffer = "";
  #overflowed = false;

  constructor(onValue: (value: unknown) => void, onGarbage: () => void, limit: { readonly maxLineChars: number; readonly onOverflow: () => void } = { maxLineChars: Number.POSITIVE_INFINITY, onOverflow: () => undefined }) {
    this.#onValue = onValue;
    this.#onGarbage = onGarbage;
    this.#maxLineChars = limit.maxLineChars;
    this.#onOverflow = limit.onOverflow;
  }

  push(chunk: Uint8Array): void {
    if (this.#overflowed) return;
    this.#buffer += this.#decoder.decode(chunk, { stream: true });
    for (;;) {
      const end = this.#buffer.indexOf("\n");
      if (end < 0) {
        // What is left is one unfinished line. (Counted in UTF-16 units, never more than its bytes.)
        if (this.#buffer.length > this.#maxLineChars) {
          this.#overflowed = true;
          this.#buffer = "";
          this.#onOverflow();
        }
        return;
      }
      if (end > this.#maxLineChars) {
        this.#overflowed = true;
        this.#buffer = "";
        this.#onOverflow();
        return;
      }
      const line = this.#buffer.slice(0, end);
      this.#buffer = this.#buffer.slice(end + 1);
      if (line.trim().length === 0) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        this.#onGarbage();
        continue;
      }
      this.#onValue(value);
    }
  }
}
