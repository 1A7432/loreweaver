// The line reader's bound: an unfinished line is not buffered without end.
import { expect, test } from "bun:test";

import { encodeLine, LineReader } from "../../src/net/lines.ts";

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

test("lines within the bound are read; one past it stops the reader for good", () => {
  const values: unknown[] = [];
  let overflows = 0;
  const reader = new LineReader(
    (value) => values.push(value),
    () => values.push("garbage"),
    { maxLineChars: 32, onOverflow: () => (overflows += 1) },
  );
  reader.push(encodeLine({ a: 1 }));
  reader.push(text('{"b":'));
  reader.push(text("2}\n\n not json \n"));
  expect(values).toEqual([{ a: 1 }, { b: 2 }, "garbage"]);
  // An unfinished line grows past the bound across chunks: reported once, then nothing more is read.
  reader.push(text(`{"c":"${"x".repeat(20)}`));
  expect(overflows).toBe(0);
  reader.push(text("y".repeat(20)));
  expect(overflows).toBe(1);
  reader.push(text('"}\n'));
  reader.push(encodeLine({ d: 4 }));
  expect(overflows).toBe(1);
  expect(values).toHaveLength(3);
});

test("a finished line over the bound is refused too, even when it arrives whole", () => {
  const values: unknown[] = [];
  let overflows = 0;
  const reader = new LineReader((value) => values.push(value), () => undefined, { maxLineChars: 16, onOverflow: () => (overflows += 1) });
  reader.push(text(`${JSON.stringify({ long: "x".repeat(40) })}\n${JSON.stringify({ ok: true })}\n`));
  expect([values, overflows]).toEqual([[], 1]);
});

test("without a bound it reads as before (a test's own reader)", () => {
  const values: unknown[] = [];
  new LineReader((value) => values.push(value), () => undefined).push(text(`${JSON.stringify({ big: "x".repeat(100_000) })}\n`));
  expect(values).toHaveLength(1);
});
