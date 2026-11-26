// `Services` on one store: the document registry for the server's rule systems, whole
// documents and their projections over it. Here because only `core/` and `agent/` may hold
// whole stored documents (`RawDocuments`), and whoever composes a server — the `serve`
// command, the self-test — needs the bundle without reaching for them itself.
import { DocumentViews } from "../core/documents/index.ts";
import { RawDocuments } from "../core/documents/raw.ts";
import { allDocumentTypes } from "../core/registry.ts";
import type { RulePackRegistry } from "../core/rulepacks/index.ts";
import type { Clock } from "../infra/ids.ts";
import type { Store } from "../infra/store.ts";
import type { LaneModels, Services } from "./context.ts";

export interface ServiceParts {
  readonly store: Store;
  readonly packs: RulePackRegistry;
  readonly models: LaneModels;
  readonly clock: Clock;
  readonly report: (room: string, text: string) => void;
}

export function servicesOn(parts: ServiceParts): Services {
  const types = allDocumentTypes(parts.packs);
  return {
    store: parts.store,
    types,
    documents: new RawDocuments(parts.store, types),
    views: new DocumentViews(parts.store, types),
    packs: parts.packs,
    models: parts.models,
    clock: parts.clock,
    report: parts.report,
  };
}
