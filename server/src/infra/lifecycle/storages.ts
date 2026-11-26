// The seam to room data that lives outside the store: media blobs (`infra/media`) and the
// vector index (`infra/recall`), and whatever comes next. Those stores have their own
// tables, files and in-memory caches, and the store must not import them (each is its own
// component, built by the composition root). Instead the code that BUILDS them registers a
// small adapter here — a name, a lifecycle, and a synchronous `clear` — and hands the
// registry to the `Store`. Each lifecycle operation then tells every registered storage
// what happened, by the same declarations that drive the store's own tables:
//
// - `reset(scope)`: the storages whose lifecycle the scope covers are cleared.
// - `deleteRoom`: every storage is cleared.
// - `importRoom`: every storage except the `never` ones is cleared. A bundle carries none
//   of these storages, and a storage the bundle does not carry must not keep the old
//   room's content (the reference's rule: an import that left its undo ring behind let
//   `.undo` walk back into the pre-import room). A `never` storage is not campaign
//   content — wiring or table-level data, like the reference's bearer keys — and a load
//   replaces the story, not the way in.
//
// Order and atomicity: the store's own change commits first, in one transaction; the
// storages are told after it, each in turn, and a storage that throws does not stop the
// others. They run after the commit because a storage may hold files, which no
// transaction can take back: a crash between the two leaves an orphan the storage's own
// sweep collects, never a room that names data already gone. The `epoch` in the event is
// the room's new generation, for a storage that guards its own late writers (the media
// store's upload generation).

import { checkLifecycle, covers, type Lifecycle, type ResetScope } from "./declarations.ts";
import { LifecycleError } from "./errors.ts";

export type RoomStorageEvent =
  | { readonly kind: "reset"; readonly scope: ResetScope; readonly epoch: number }
  | { readonly kind: "delete"; readonly epoch: number }
  | { readonly kind: "import"; readonly epoch: number };

export interface RoomStorage {
  readonly name: string;
  readonly lifecycle: Lifecycle;
  /** Remove everything of `room` this storage holds. Synchronous; may throw. */
  clear(room: string, event: RoomStorageEvent): void;
}

export interface StorageFailure {
  readonly name: string;
  readonly error: unknown;
}

/** What the storages did after an operation committed. */
export interface StorageReport {
  readonly cleared: readonly string[];
  readonly failed: readonly StorageFailure[];
}

export const NO_STORAGES: StorageReport = Object.freeze({ cleared: [], failed: [] });

export class RoomStorages {
  readonly #storages = new Map<string, RoomStorage>();

  register(storage: RoomStorage): this {
    checkLifecycle(storage.lifecycle, storage.name);
    if (this.#storages.has(storage.name)) throw new LifecycleError("storage_conflict", storage.name);
    this.#storages.set(storage.name, storage);
    return this;
  }

  names(): string[] {
    return [...this.#storages.keys()];
  }

  /** Whether `event` clears `storage`. */
  static clears(event: RoomStorageEvent, lifecycle: Lifecycle): boolean {
    switch (event.kind) {
      case "reset":
        return covers(event.scope, lifecycle);
      case "delete":
        return true;
      case "import":
        return lifecycle.reset !== "never";
    }
  }

  /** Tell every affected storage; every one is attempted, and failures are reported, not thrown. */
  notify(room: string, event: RoomStorageEvent): StorageReport {
    const cleared: string[] = [];
    const failed: StorageFailure[] = [];
    for (const storage of this.#storages.values()) {
      if (!RoomStorages.clears(event, storage.lifecycle)) continue;
      try {
        storage.clear(room, event);
        cleared.push(storage.name);
      } catch (error) {
        failed.push({ name: storage.name, error });
      }
    }
    return { cleared, failed };
  }
}
