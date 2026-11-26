/**
 * A first-come, first-served lock. `run` executes its body when every earlier body has
 * settled, so work on one room happens one piece at a time, in arrival order.
 */
export class Mutex {
  #tail: Promise<void> = Promise.resolve();

  run<T>(body: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(body);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
