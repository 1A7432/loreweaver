/** Where ids and the time come from, so a test can pin both. */
export interface Clock {
  now(): number;
  id(): string;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  id: () => crypto.randomUUID(),
};
