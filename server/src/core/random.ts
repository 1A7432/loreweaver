/**
 * Where the engine's randomness comes from.
 *
 * Everything in `core/` that rolls takes a `RandomSource` argument instead of reaching for
 * `Math.random`, so a test can script every draw and a room can replay one. The interface
 * is the smallest one the dice need: an inclusive integer range with a stride. The stride
 * exists for the percentile tens die (0, 10, ..., 90), which must be ONE draw so a recorded
 * sequence lines up draw for draw.
 */

export interface RandomSource {
  /**
   * A uniformly chosen integer from `lo` to `hi` inclusive, in steps of `step` (default 1).
   * `hi - lo` must be a non-negative multiple of `step`.
   */
  nextInt(lo: number, hi: number, step?: number): number;
}

const TWO_32 = 0x1_0000_0000;

/** How many values a request covers; throws on a request no correct caller makes. */
function rangeSize(lo: number, hi: number, step: number): number {
  if (!Number.isSafeInteger(lo) || !Number.isSafeInteger(hi) || !Number.isSafeInteger(step) || step < 1) {
    throw new RangeError(`random: bad range [${lo}, ${hi}] step ${step}`);
  }
  const span = hi - lo;
  if (span < 0 || span % step !== 0) throw new RangeError(`random: bad range [${lo}, ${hi}] step ${step}`);
  const size = span / step + 1;
  // One 32-bit output per attempt keeps the generator simple; no die needs more.
  if (size > TWO_32) throw new RangeError(`random: range of ${size} values is too wide`);
  return size;
}

/**
 * 32-bit string hash (cyrb128-style mixing) that spreads a seed of any length over the
 * generator's four state words. Iterates UTF-16 units on purpose: the result only has to
 * be stable, not to mean anything per character.
 */
function seedWords(seed: string): [number, number, number, number] {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < seed.length; i++) {
    const k = seed.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

/**
 * A seeded generator (sfc32: small, fast, passes PractRand, 128 bits of state) with
 * unbiased ranges by rejection sampling. The same seed always yields the same stream; a
 * number seed means the same as its decimal string. Production callers seed it from real
 * entropy themselves: `core/` reads no clock and no system randomness.
 */
export class SeededRandom implements RandomSource {
  #a: number;
  #b: number;
  #c: number;
  #d: number;

  constructor(seed: string | number) {
    if (typeof seed === "number" && !Number.isSafeInteger(seed)) throw new RangeError("random: a number seed must be a safe integer");
    [this.#a, this.#b, this.#c, this.#d] = seedWords(String(seed));
    // The first outputs of sfc32 still echo the seed; the reference implementation discards them.
    for (let i = 0; i < 12; i++) this.#next32();
  }

  #next32(): number {
    const t = (((this.#a + this.#b) | 0) + this.#d) | 0;
    this.#d = (this.#d + 1) | 0;
    this.#a = this.#b ^ (this.#b >>> 9);
    this.#b = (this.#c + (this.#c << 3)) | 0;
    this.#c = (this.#c << 21) | (this.#c >>> 11);
    this.#c = (this.#c + t) | 0;
    return t >>> 0;
  }

  nextInt(lo: number, hi: number, step = 1): number {
    const size = rangeSize(lo, hi, step);
    // Reject the top sliver of the 32-bit space so every value is equally likely.
    const limit = TWO_32 - (TWO_32 % size);
    let draw = this.#next32();
    while (draw >= limit) draw = this.#next32();
    return lo + step * (draw % size);
  }
}

/** One recorded draw: the bounds the caller must ask for, and the value to answer. */
export interface ScriptedDraw {
  readonly lo: number;
  readonly hi: number;
  readonly step: number;
  readonly value: number;
}

/**
 * Replays recorded draws in order, for tests. It fails loudly (a plain `Error`, never an
 * engine error, so a test cannot mistake it for an expected failure) when the caller asks
 * for different bounds or for more draws than were recorded.
 */
export class ScriptedRandom implements RandomSource {
  readonly #draws: readonly ScriptedDraw[];
  #next = 0;

  constructor(draws: readonly ScriptedDraw[]) {
    this.#draws = draws;
  }

  /** How many draws have been answered so far. */
  get consumed(): number {
    return this.#next;
  }

  /** How many recorded draws are left. */
  get remaining(): number {
    return this.#draws.length - this.#next;
  }

  nextInt(lo: number, hi: number, step = 1): number {
    const draw = this.#draws[this.#next];
    if (draw === undefined) {
      throw new Error(`scripted random: draw #${this.#next} [${lo}, ${hi}] step ${step} requested, but only ${this.#draws.length} were recorded`);
    }
    if (draw.lo !== lo || draw.hi !== hi || draw.step !== step) {
      throw new Error(
        `scripted random: draw #${this.#next} requested [${lo}, ${hi}] step ${step}, recorded [${draw.lo}, ${draw.hi}] step ${draw.step}`,
      );
    }
    this.#next++;
    return draw.value;
  }
}
