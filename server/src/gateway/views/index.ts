// Views (protocol 3.0 §8.4): named values computed per viewer, the only channel for panel
// data. The built-ins are computed here from projections; module views are merged in from
// a render; subscriptions decide what each connection is sent.
export { BUILT_IN_VIEWS, type BuiltInView, type CommandsSource, mayView, type OnlineMember, type ViewSource } from "./builtins.ts";
export { VIEWS_CATALOG } from "./catalog.ts";
export {
  listedModuleViews,
  MAX_VIEW_BYTES,
  mergeModuleViews,
  moduleViewListings,
  moduleViewName,
  type ModuleViewListing,
  type ModuleViewSet,
  NO_MODULE_VIEWS,
} from "./modules.ts";
export { type ComputedView, RoomViews, viewCatalog, type ViewInputs } from "./room_views.ts";
export { byteSize, stableStringify } from "./serialize.ts";
export {
  type Delivery,
  MAX_SUBSCRIPTIONS,
  MAX_VIEW_NAME_CHARS,
  type ViewCatalog,
  type ViewCatalogEntry,
  type ViewProblem,
  type ViewProblemCode,
  ViewSubscriptions,
} from "./subscriptions.ts";
export { LAST_TURN_USAGE, type LastTurnUsage, recordUsage } from "./usage.ts";
export { distinctViewers, projectionViewer, type ViewerContext, viewerContext, viewerKey, type ViewMemberInfo, whoOf } from "./viewer.ts";
