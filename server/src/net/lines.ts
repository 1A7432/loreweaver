// Newline-delimited JSON over a byte stream: one compact object per line.

const encoder = new TextEncoder();

export function encodeLine(value: unknown): Uint8Array {
  return encoder.encode(`${JSON.stringify(value)}\n`);
}

/** Feed it chunks as they arrive; it calls back once per complete line, parsed. */
export class LineReader {
  readonly #decoder = new TextDecoder("utf-8");
  readonly #onValue: (value: unknown) => void;
  readonly #onGarbage: () => void;
  #buffer = "";

  constructor(onValue: (value: unknown) => void, onGarbage: () => void) {
    this.#onValue = onValue;
    this.#onGarbage = onGarbage;
  }

  push(chunk: Uint8Array): void {
    this.#buffer += this.#decoder.decode(chunk, { stream: true });
    for (;;) {
      const end = this.#buffer.indexOf("\n");
      if (end < 0) return;
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
