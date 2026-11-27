// Module views (`<module>/<name>`), merged in beside the built-ins.
//
// A module computes a view for each viewer who subscribed to it (or asked for it with
// `view.get`), and the engine forwards the value UNFILTERED to that viewer alone (decision
// 29: a module view is authorial output). The worker exchange and its validation are
// `dispatchRender`'s (`agent/modules.ts`); this file names what to compute (`viewRefs`),
// then takes the validated outcome and files each value under the viewer it was computed
// for, so that no value can be handed to another viewer.
import type { ViewRef } from "loreweaver/runner";
import { isAdminViewName, type ViewSchema } from "loreweaver-protocol/v3";

import { DEFAULT_CAPS, type ModuleInfo, type RenderOutcome } from "../../agent/modules.ts";
import { byteSize, stableStringify } from "./serialize.ts";
import { type ViewerContext, viewerKey } from "./viewer.ts";

/** The largest view value sent to a connection, in bytes (the module boundary's own cap). */
export const MAX_VIEW_BYTES = DEFAULT_CAPS.viewBytes;

/** One module view a connection may subscribe to. */
export interface ModuleViewListing {
  readonly name: string;
  readonly schema: ViewSchema;
  readonly title: string | null;
}

/** The module views of a room for a set of viewers, as one render computed them. */
export interface ModuleViewSet {
  /** Every module view the loaded modules declare. */
  readonly listings: readonly ModuleViewListing[];
  /** The values computed for `viewer`; undefined for a viewer the render did not include. */
  values(viewer: ViewerContext): ReadonlyMap<string, unknown> | undefined;
  /** Values dropped, and why: for the operator's log. */
  readonly problems: readonly string[];
}

export function moduleViewName(module: string, view: string): string {
  return `${module}/${view}`;
}

/** Module view names (`<module>/<name>`) as a render request names them; anything else is left out. */
export function viewRefs(names: readonly string[]): ViewRef[] {
  const refs: ViewRef[] = [];
  for (const name of names) {
    const at = name.indexOf("/");
    if (at <= 0 || at === name.length - 1) continue;
    refs.push({ module: name.slice(0, at), view: name.slice(at + 1) });
  }
  return refs;
}

/** The module views the loaded modules declare, without the names no module may take. */
export function moduleViewListings(modules: readonly ModuleInfo[]): { listings: ModuleViewListing[]; problems: string[] } {
  const listings: ModuleViewListing[] = [];
  const problems: string[] = [];
  for (const module of modules) {
    for (const view of module.views) {
      const name = moduleViewName(module.id, view.name);
      // `admin/*` names the engine's admin-only views: a module called `admin` must not
      // publish under it, or its views would be withheld from players for the wrong reason
      // and an engine view could be shadowed.
      if (isAdminViewName(name)) {
        problems.push(`module ${module.id}: view ${view.name} dropped, its name is reserved`);
        continue;
      }
      listings.push({ name, schema: view.schema, title: view.title });
    }
  }
  return { listings, problems };
}

/**
 * File a render's views under the viewers they were computed for. `viewers` is the list
 * the render was asked for, in the same order (`outcome.viewers[i]` is `viewers[i]`'s).
 * A value over `maxBytes` is dropped with a problem, never truncated.
 */
export function mergeModuleViews(
  outcome: RenderOutcome,
  viewers: readonly ViewerContext[],
  modules: readonly ModuleInfo[],
  maxBytes: number = MAX_VIEW_BYTES,
): ModuleViewSet {
  const { listings, problems } = moduleViewListings(modules);
  const listed = new Set(listings.map((listing) => listing.name));
  const byViewer = new Map<string, Map<string, unknown>>();
  viewers.forEach((viewer, index) => {
    const rendered = outcome.viewers[index];
    if (rendered === undefined) return;
    const values = new Map<string, unknown>();
    for (const view of rendered.views) {
      const name = moduleViewName(view.module, view.view);
      if (!listed.has(name)) continue;
      const size = byteSize(stableStringify(view.data));
      if (size > maxBytes) {
        problems.push(`module ${view.module}: view ${view.view} dropped, ${size} bytes is over ${maxBytes}`);
        continue;
      }
      values.set(name, view.data);
    }
    byViewer.set(viewerKey(viewer), values);
  });
  return {
    listings,
    values: (viewer) => byViewer.get(viewerKey(viewer)),
    problems,
  };
}

/** The module views the loaded modules declare, before any render: listed, with no values yet. */
export function listedModuleViews(modules: readonly ModuleInfo[]): ModuleViewSet {
  const { listings, problems } = moduleViewListings(modules);
  return { listings, values: () => undefined, problems };
}

/** A room with no modules. */
export const NO_MODULE_VIEWS: ModuleViewSet = { listings: [], values: () => undefined, problems: [] };
