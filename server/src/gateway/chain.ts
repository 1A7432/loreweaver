// The work that follows a turn off the lock: at most one pass running per room, passes
// landing in the order they were scheduled, and nothing ever waiting for the chain
// (docs/defensive-patterns.md 7: ordering is not waiting). A destructive operation does
// not cancel or drain it either: every pass commits through the writer of the turn it was
// scheduled on, and a writer of a past generation refuses (§11.5).

export class OrderedChains {
  readonly #tails = new Map<string, Promise<void>>();
  readonly #onError: (room: string, error: unknown) => void;

  constructor(onError: (room: string, error: unknown) => void) {
    this.#onError = onError;
  }

  /**
   * Run `job` after every job scheduled before it for `room`. Returns at once; the promise
   * settles when this job has (it never rejects: a failure goes to `onError`).
   */
  schedule(room: string, job: () => Promise<void>): Promise<void> {
    const previous = this.#tails.get(room) ?? Promise.resolve();
    const done = previous.then(job).then(
      () => undefined,
      (error: unknown) => {
        this.#onError(room, error);
      },
    );
    this.#tails.set(room, done);
    void done.then(() => {
      if (this.#tails.get(room) === done) this.#tails.delete(room);
    });
    return done;
  }

  /** Settles when every job scheduled for `room` so far has: for tests and shutdown. */
  idle(room: string): Promise<void> {
    return this.#tails.get(room) ?? Promise.resolve();
  }

  /** Settles when every room's chain has drained. */
  async idleAll(): Promise<void> {
    await Promise.all([...this.#tails.values()]);
  }
}
