// The views of one room: what the room and the session call.
//
// `RoomViews` joins the subscriptions (who wants what, what each was last sent) to the
// computation. A refresh computes LAZILY: only the names some connection subscribed to,
// and each (view, viewer) once — connections of the same person with the same role,
// language and character share one computation. A view nobody subscribed to is never
// computed.
import type { ViewFrame, ViewListing } from "loreweaver-protocol/v3";

import { BUILT_IN_VIEWS, type BuiltInView, mayView, type ViewSource } from "./builtins.ts";
import { type ModuleViewSet, NO_MODULE_VIEWS } from "./modules.ts";
import { type Delivery, type ViewCatalog, type ViewCatalogEntry, type ViewProblem, ViewSubscriptions } from "./subscriptions.ts";
import { distinctViewers, type ViewerContext, viewerKey } from "./viewer.ts";

/** A view the engine computes: a built-in, or a test's stand-in for one. */
export type ComputedView = Pick<BuiltInView, "name" | "schema" | "admin" | "compute">;

/** The views of a room for one round of computation. */
export interface ViewInputs {
  readonly source: ViewSource;
  /** The module views of the last render; `NO_MODULE_VIEWS` without modules. */
  readonly modules: ModuleViewSet;
  /** The log head (`seq`) the values reflect. */
  readonly at: number;
}

/** The catalog of a room: its built-ins, then its module views. */
export function viewCatalog(builtIns: readonly ComputedView[], modules: ModuleViewSet = NO_MODULE_VIEWS): ViewCatalog {
  const catalog = new Map<string, ViewCatalogEntry>();
  for (const view of builtIns) catalog.set(view.name, { schema: view.schema, admin: view.admin });
  for (const listing of modules.listings) {
    if (!catalog.has(listing.name)) catalog.set(listing.name, { schema: listing.schema, admin: false, title: listing.title });
  }
  return catalog;
}

/** One round of computation: each (view, viewer) at most once. */
class Computation {
  readonly #inputs: ViewInputs;
  readonly #builtIns: ReadonlyMap<string, ComputedView>;
  readonly #memo = new Map<string, Promise<{ readonly value: unknown } | { readonly failed: true } | null>>();

  constructor(inputs: ViewInputs, builtIns: ReadonlyMap<string, ComputedView>) {
    this.#inputs = inputs;
    this.#builtIns = builtIns;
  }

  /** The value of `name` for `viewer`; null when there is none to send, `failed` when computing it threw. */
  value(name: string, viewer: ViewerContext): Promise<{ readonly value: unknown } | { readonly failed: true } | null> {
    const key = `${viewerKey(viewer)}\u0000${name}`;
    let pending = this.#memo.get(key);
    if (pending === undefined) {
      pending = this.#compute(name, viewer);
      this.#memo.set(key, pending);
    }
    return pending;
  }

  async #compute(name: string, viewer: ViewerContext): Promise<{ readonly value: unknown } | { readonly failed: true } | null> {
    const builtIn = this.#builtIns.get(name);
    if (builtIn !== undefined) {
      if (!mayView(builtIn, viewer.member.role)) return null;
      try {
        return { value: await builtIn.compute(this.#inputs.source, viewer) };
      } catch (error) {
        this.#inputs.source.services.report(this.#inputs.source.room, `view ${name} failed: ${error instanceof Error ? error.message : String(error)}`);
        return { failed: true };
      }
    }
    const values = this.#inputs.modules.values(viewer);
    return values?.has(name) === true ? { value: values.get(name) } : null;
  }

  /** The values of `names` for `viewer`, and the names whose computation failed. */
  async values(names: readonly string[], viewer: ViewerContext): Promise<{ values: Map<string, unknown>; failed: string[] }> {
    const values = new Map<string, unknown>();
    const failed: string[] = [];
    for (const name of names) {
      const result = await this.value(name, viewer);
      if (result === null) continue;
      if ("failed" in result) failed.push(name);
      else values.set(name, result.value);
    }
    return { values, failed };
  }
}

function withFailures(delivery: Delivery, failed: readonly string[]): Delivery {
  return { frames: delivery.frames, problems: [...delivery.problems, ...failed.map((name): ViewProblem => ({ name, code: "view_failed" }))] };
}

export class RoomViews {
  readonly subscriptions = new ViewSubscriptions();
  readonly #builtIns: ReadonlyMap<string, ComputedView>;

  /** `builtIns` replaces the engine's built-in views (a test counts computations with it). */
  constructor(options: { readonly builtIns?: readonly ComputedView[] } = {}) {
    this.#builtIns = new Map((options.builtIns ?? BUILT_IN_VIEWS).map((view) => [view.name, view]));
  }

  catalog(modules: ModuleViewSet = NO_MODULE_VIEWS): ViewCatalog {
    return viewCatalog([...this.#builtIns.values()], modules);
  }

  open(connection: string, viewer: ViewerContext): void {
    this.subscriptions.open(connection, viewer);
  }

  setViewer(connection: string, viewer: ViewerContext): void {
    this.subscriptions.setViewer(connection, viewer);
  }

  close(connection: string): void {
    this.subscriptions.close(connection);
  }

  /** `view.list`. */
  list(connection: string, modules: ModuleViewSet = NO_MODULE_VIEWS): ViewListing[] {
    return this.subscriptions.list(connection, this.catalog(modules));
  }

  /**
   * The distinct viewers subscribed to at least one module view: the room asks the worker
   * to render for these alone (`dispatchRender`), then merges with `mergeModuleViews`.
   * Empty when nobody subscribed to one — then no render is needed for views at all. The
   * listings for the catalog come from the load-time description (`moduleViewListings`),
   * so a subscription can be taken before any render.
   */
  moduleViewers(): ViewerContext[] {
    const viewers: ViewerContext[] = [];
    for (const connection of this.subscriptions.connections()) {
      const viewer = this.subscriptions.viewer(connection);
      // Every name that is not the engine's is a module's: subscriptions only take listed names.
      if (viewer !== null && this.subscriptions.subscribed(connection).some((name) => !this.#builtIns.has(name))) viewers.push(viewer);
    }
    return distinctViewers(viewers);
  }

  /** `view.subscribe`: the newly subscribed views' current values, as frames, and what was refused. */
  async subscribe(connection: string, names: readonly string[], inputs: ViewInputs): Promise<Delivery> {
    const { added, problems } = this.subscriptions.subscribe(connection, names, this.catalog(inputs.modules));
    const viewer = this.subscriptions.viewer(connection);
    if (viewer === null || added.length === 0) return { frames: [], problems };
    const { values, failed } = await new Computation(inputs, this.#builtIns).values(added, viewer);
    const delivery = this.subscriptions.refresh(connection, values, inputs.at);
    return withFailures({ frames: delivery.frames, problems: [...problems, ...delivery.problems] }, failed);
  }

  unsubscribe(connection: string, names: readonly string[]): string[] {
    return this.subscriptions.unsubscribe(connection, names);
  }

  /** `view.get`: the view recomputed now. */
  async get(connection: string, name: string, inputs: ViewInputs): Promise<ViewFrame | ViewProblem> {
    const viewer = this.subscriptions.viewer(connection);
    if (viewer === null) return { name, code: "not_open" };
    const catalog = this.catalog(inputs.modules);
    if (!catalog.has(name)) return { name, code: "unknown_view" };
    const result = await new Computation(inputs, this.#builtIns).value(name, viewer);
    if (result === null) return { name, code: "unknown_view" };
    if ("failed" in result) return { name, code: "view_failed" };
    return this.subscriptions.get(connection, name, result.value, inputs.at, catalog);
  }

  /**
   * After a turn or a command: the frames each connection is owed (only views whose value
   * changed for it). `connections` limits the refresh; all open connections by default.
   */
  async refresh(inputs: ViewInputs, connections?: readonly string[]): Promise<Map<string, Delivery>> {
    const computation = new Computation(inputs, this.#builtIns);
    const out = new Map<string, Delivery>();
    for (const connection of connections ?? this.subscriptions.connections()) {
      const viewer = this.subscriptions.viewer(connection);
      const names = this.subscriptions.subscribed(connection);
      if (viewer === null || names.length === 0) continue;
      const { values, failed } = await computation.values(names, viewer);
      const delivery = withFailures(this.subscriptions.refresh(connection, values, inputs.at), failed);
      if (delivery.frames.length > 0 || delivery.problems.length > 0) out.set(connection, delivery);
    }
    return out;
  }
}
