// Documents as a viewer may see them. This is what the gateway and the transports use:
// every method takes the viewer and returns projections, never a stored payload.
import type { Store } from "../../infra/store.ts";
import type { DocumentTypes, Viewer } from "./model.ts";
import { RawDocuments } from "./raw.ts";

export interface DocumentView {
  readonly type: string;
  readonly id: string;
  readonly view: unknown;
}

export class DocumentViews {
  readonly #raw: RawDocuments;
  readonly #types: DocumentTypes;

  constructor(store: Store, types: DocumentTypes) {
    this.#raw = new RawDocuments(store, types);
    this.#types = types;
  }

  /** The viewer's view of one document; null when it is absent or invisible to them. */
  view(room: string, type: string, id: string, viewer: Viewer): unknown {
    const document = this.#raw.get(room, type, id);
    return document === null ? null : this.#types.project(document, viewer);
  }

  /** The viewer's views of a room's documents of one type, invisible ones left out. */
  views(room: string, type: string, viewer: Viewer): DocumentView[] {
    const visible: DocumentView[] = [];
    for (const document of this.#raw.list(room, type)) {
      const view = this.#types.project(document, viewer);
      if (view !== null) visible.push({ type: document.type, id: document.id, view });
    }
    return visible;
  }
}
