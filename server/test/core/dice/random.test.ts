import { describe, expect, test } from "bun:test";

import { ScriptedRandom, SeededRandom } from "../../../src/core/random.ts";

describe("SeededRandom", () => {
  test("the same seed gives the same stream; a number seed equals its decimal string", () => {
    const draw = (seed: string | number) => {
      const random = new SeededRandom(seed);
      return Array.from({ length: 50 }, () => random.nextInt(1, 1000));
    };
    expect(draw("room-1")).toEqual(draw("room-1"));
    expect(draw(42)).toEqual(draw("42"));
    expect(draw("room-1")).not.toEqual(draw("room-2"));
  });

  test("values stay in range, honour the step, and every value turns up", () => {
    const random = new SeededRandom("range");
    const seen = new Set<number>();
    for (let i = 0; i < 5000; i++) {
      const value = random.nextInt(0, 90, 10);
      expect(value % 10).toBe(0);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(90);
      seen.add(value);
    }
    expect(seen.size).toBe(10);
    expect(new SeededRandom(1).nextInt(-1, -1)).toBe(-1);
  });

  test("a d6 is close to uniform", () => {
    const random = new SeededRandom("uniform");
    const counts = new Array<number>(6).fill(0);
    const n = 60_000;
    for (let i = 0; i < n; i++) counts[random.nextInt(1, 6) - 1]! += 1;
    for (const count of counts) expect(Math.abs(count - n / 6)).toBeLessThan(n / 6 / 20);
  });

  test("a range no caller should ask for is refused", () => {
    const random = new SeededRandom(1);
    expect(() => random.nextInt(5, 1)).toThrow(RangeError);
    expect(() => random.nextInt(0, 95, 10)).toThrow(RangeError);
    expect(() => random.nextInt(0, 1.5)).toThrow(RangeError);
    expect(() => random.nextInt(0, 2 ** 40)).toThrow(RangeError);
    expect(() => new SeededRandom(0.5)).toThrow(RangeError);
  });
});

describe("ScriptedRandom", () => {
  test("answers recorded draws in order", () => {
    const random = new ScriptedRandom([
      { lo: 1, hi: 6, step: 1, value: 4 },
      { lo: 0, hi: 90, step: 10, value: 30 },
    ]);
    expect(random.nextInt(1, 6)).toBe(4);
    expect(random.nextInt(0, 90, 10)).toBe(30);
    expect(random.remaining).toBe(0);
    expect(random.consumed).toBe(2);
  });

  test("fails on different bounds and when it runs out", () => {
    const random = new ScriptedRandom([{ lo: 1, hi: 6, step: 1, value: 4 }]);
    expect(() => random.nextInt(1, 20)).toThrow(/recorded \[1, 6\]/);
    expect(random.nextInt(1, 6)).toBe(4);
    expect(() => random.nextInt(1, 6)).toThrow(/only 1 were recorded/);
  });
});
