// Threads. The main thread starts a worker and exchanges messages with it; the worker
// side reads and answers. Kept here because the two mainstream runtimes disagree on the
// API (a global `Worker` here, `node:worker_threads` there).

export interface WorkerHandle {
  post(message: unknown): void;
  onMessage(listener: (message: unknown) => void): void;
  /** Stop the thread now, even mid-loop. Resolves once it is gone. */
  terminate(): Promise<void>;
}

/**
 * Where the room worker's entry file is. From source it is a file beside this tree. In a
 * compiled binary every module is bundled, so this file's own URL is the binary's root
 * rather than its path, and the worker — built as a second entry point — sits under that
 * root by its path relative to `src/`. `bun run build` and the self-test it runs pin that
 * layout: build with other entry points and the self-test fails.
 */
export function roomWorkerEntry(): string {
  const bundled = !import.meta.url.endsWith("/infra/runtime/worker.ts");
  return bundled ? "./worker/main.ts" : new URL("../../worker/main.ts", import.meta.url).href;
}

export function spawnWorker(entry: string): WorkerHandle {
  const worker = new Worker(entry);
  return {
    post: (message) => {
      worker.postMessage(message);
    },
    onMessage: (listener) => {
      worker.onmessage = (event: MessageEvent) => {
        listener(event.data);
      };
    },
    terminate: () =>
      new Promise<void>((resolve) => {
        worker.addEventListener("close", () => resolve(), { once: true });
        worker.terminate();
      }),
  };
}

declare const self: {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown): void;
};

/** Worker side: receive the main thread's messages. */
export function onHostMessage(listener: (message: unknown) => void): void {
  self.onmessage = (event) => {
    listener(event.data);
  };
}

/** Worker side: answer the main thread. */
export function postToHost(message: unknown): void {
  self.postMessage(message);
}
