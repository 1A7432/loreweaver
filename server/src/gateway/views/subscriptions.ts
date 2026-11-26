// Who subscribed to which view, and what each connection was last sent.
//
// Synchronous and free of computation: the caller computes the values (see `RoomViews`)
// and hands them in; this class decides which of them become `view` frames. A value is
// sent when it differs from the last one sent to that connection under that name — the
// comparison is by a key-sorted serialization, so an unchanged view is never re-sent.
//
// `rev` counts per connection per view name and only ever grows: a rev never names two
// different values. It survives an unsubscribe, so a client that resubscribes cannot
// mistake a fresh value for one it already holds.
import { isAdminViewName, type Role, type ViewFrame, type ViewListing, type ViewSchema } from "loreweaver-protocol/v3";

import { MAX_VIEW_BYTES } from "./modules.ts";
import { byteSize, stableStringify } from "./serialize.ts";
import type { ViewerContext } from "./viewer.ts";

/** Views one connection may be subscribed to at once. */
export const MAX_SUBSCRIPTIONS = 64;
/** A view name, in code points: a module id (128), a slash, a view name. */
export const MAX_VIEW_NAME_CHARS = 200;

/** One view a room offers: its schema, and whether only an admin may see it. */
export interface ViewCatalogEntry {
  readonly schema: ViewSchema;
  readonly admin: boolean;
  readonly title?: string | null;
}

/** Every view a room offers now, by name, in listing order. */
export type ViewCatalog = ReadonlyMap<string, ViewCatalogEntry>;

export type ViewProblemCode =
  /** No such view — or one this connection may not know of (an admin view to a non-admin). */
  | "unknown_view"
  | "too_many_views"
  /** The value is over `MAX_VIEW_BYTES`; it was not sent (the last value sent stands). */
  | "too_large"
  /** Computing the value failed; nothing was sent. */
  | "view_failed"
  | "not_open";

export interface ViewProblem {
  readonly name: string;
  readonly code: ViewProblemCode;
}

interface Slot {
  rev: number;
  /** The serialization of the last value sent; null when the connection holds none. */
  last: string | null;
  subscribed: boolean;
}

interface Connection {
  viewer: ViewerContext;
  readonly slots: Map<string, Slot>;
}

export interface Delivery {
  readonly frames: ViewFrame[];
  readonly problems: ViewProblem[];
}

function visible(catalog: ViewCatalog, name: string, role: Role): boolean {
  const entry = catalog.get(name);
  if (entry === undefined) return false;
  return role === "admin" || (!entry.admin && !isAdminViewName(name));
}

export class ViewSubscriptions {
  readonly #connections = new Map<string, Connection>();

  /** A connection joined, as `viewer`. Opening one already open replaces its viewer. */
  open(connection: string, viewer: ViewerContext): void {
    const existing = this.#connections.get(connection);
    if (existing !== undefined) existing.viewer = viewer;
    else this.#connections.set(connection, { viewer, slots: new Map() });
  }

  /**
   * The connection's viewer changed (a seat taken, a role granted). Subscriptions stay;
   * the next refresh computes for the new viewer and sends what differs. A role that no
   * longer sees an admin view loses that subscription.
   */
  setViewer(connection: string, viewer: ViewerContext): void {
    const state = this.#connections.get(connection);
    if (state === undefined) return;
    state.viewer = viewer;
    if (viewer.member.role === "admin") return;
    for (const [name, slot] of state.slots) {
      if (isAdminViewName(name)) {
        slot.subscribed = false;
        slot.last = null;
      }
    }
  }

  close(connection: string): void {
    this.#connections.delete(connection);
  }

  viewer(connection: string): ViewerContext | null {
    return this.#connections.get(connection)?.viewer ?? null;
  }

  connections(): string[] {
    return [...this.#connections.keys()];
  }

  /** The names `connection` is subscribed to, in the order subscribed. */
  subscribed(connection: string): string[] {
    const state = this.#connections.get(connection);
    if (state === undefined) return [];
    return [...state.slots].filter(([, slot]) => slot.subscribed).map(([name]) => name);
  }

  /** `view.list`: what this connection may subscribe to. An `admin/*` view is listed to admins only. */
  list(connection: string, catalog: ViewCatalog): ViewListing[] {
    const state = this.#connections.get(connection);
    if (state === undefined) return [];
    const out: ViewListing[] = [];
    for (const [name, entry] of catalog) {
      if (!visible(catalog, name, state.viewer.member.role)) continue;
      const listing: ViewListing = { name, schema: entry.schema };
      if (typeof entry.title === "string") listing.title = entry.title;
      out.push(listing);
    }
    return out;
  }

  /**
   * `view.subscribe`: record the names. The caller then computes them and calls `refresh`,
   * which sends each newly subscribed view (the connection holds no value of it yet).
   * Names past `MAX_SUBSCRIPTIONS` are refused, not truncated silently.
   */
  subscribe(connection: string, names: readonly string[], catalog: ViewCatalog): { added: string[]; problems: ViewProblem[] } {
    const state = this.#connections.get(connection);
    if (state === undefined) return { added: [], problems: names.map((name) => ({ name, code: "not_open" as const })) };
    const added: string[] = [];
    const problems: ViewProblem[] = [];
    let count = this.subscribed(connection).length;
    for (const name of names) {
      if (typeof name !== "string" || [...name].length > MAX_VIEW_NAME_CHARS || !visible(catalog, name, state.viewer.member.role)) {
        problems.push({ name: String(name), code: "unknown_view" });
        continue;
      }
      const slot = state.slots.get(name);
      if (slot?.subscribed === true) continue;
      if (count >= MAX_SUBSCRIPTIONS) {
        problems.push({ name, code: "too_many_views" });
        continue;
      }
      count += 1;
      if (slot === undefined) state.slots.set(name, { rev: 0, last: null, subscribed: true });
      else {
        slot.subscribed = true;
        slot.last = null;
      }
      added.push(name);
    }
    return { added, problems };
  }

  /** `view.unsubscribe`: the names that were subscribed and no longer are. */
  unsubscribe(connection: string, names: readonly string[]): string[] {
    const state = this.#connections.get(connection);
    if (state === undefined) return [];
    const removed: string[] = [];
    for (const name of names) {
      const slot = state.slots.get(name);
      if (slot === undefined || !slot.subscribed) continue;
      slot.subscribed = false;
      slot.last = null;
      removed.push(name);
    }
    return removed;
  }

  /**
   * After a turn or a command: the frames for every subscribed view whose freshly computed
   * value (in `values`) differs from the last one sent. A name absent from `values` was
   * not computed (its source is gone, or it failed) and is left as it was. `at` is the log
   * head the values reflect.
   */
  refresh(connection: string, values: ReadonlyMap<string, unknown>, at: number): Delivery {
    const state = this.#connections.get(connection);
    const frames: ViewFrame[] = [];
    const problems: ViewProblem[] = [];
    if (state === undefined) return { frames, problems };
    for (const [name, slot] of state.slots) {
      if (!slot.subscribed || !values.has(name)) continue;
      const result = this.#offer(name, slot, values.get(name), at);
      if (result === null) continue;
      if ("code" in result) problems.push(result);
      else frames.push(result);
    }
    return { frames, problems };
  }

  /**
   * `view.get`: the view as just computed, as a frame — whether or not the connection is
   * subscribed. The rev moves only when the value differs from the last one sent under
   * this name; an unchanged value comes back under its old rev, so a client can tell it
   * already holds it.
   */
  get(connection: string, name: string, value: unknown, at: number, catalog: ViewCatalog): ViewFrame | ViewProblem {
    const state = this.#connections.get(connection);
    if (state === undefined) return { name, code: "not_open" };
    if (!visible(catalog, name, state.viewer.member.role)) return { name, code: "unknown_view" };
    let slot = state.slots.get(name);
    if (slot === undefined) {
      slot = { rev: 0, last: null, subscribed: false };
      state.slots.set(name, slot);
    }
    const text = stableStringify(value);
    if (slot.last === text) return { type: "view", name, rev: slot.rev, at, data: value };
    return this.#offer(name, slot, value, at) ?? { type: "view", name, rev: slot.rev, at, data: value };
  }

  /** A frame for a changed value, a problem, or null when it is unchanged. */
  #offer(name: string, slot: Slot, value: unknown, at: number): ViewFrame | ViewProblem | null {
    const text = stableStringify(value);
    if (slot.last === text) return null;
    if (byteSize(text) > MAX_VIEW_BYTES) return { name, code: "too_large" };
    slot.rev += 1;
    slot.last = text;
    return { type: "view", name, rev: slot.rev, at, data: value };
  }
}
