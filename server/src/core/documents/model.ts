// The document model: every piece of room content — lore, characters, variables,
// notes — is a document, and every document type says who sees what of it.
//
// `project(document, viewer)` is THE single place room content is turned into something
// that may leave the engine (iron rule 3: each viewer gets only their own part). A type
// registers its projection once; no caller filters fields by hand. A projection returns
// the view for that viewer, or null when the document does not exist for them.

/**
 * Who a view is made for.
 * - `keeper`: the AI Keeper — the whole truth, always (it cannot foreshadow what it has
 *   not read).
 * - `admin`: the human who holds the room's privileged key. A player like any other for
 *   story content; a type may show them management detail (an unexposed variable,
 *   flagged) but never the Keeper's secrets by default.
 * - `player`, `observer`: the table.
 * `actorId` marks an NPC actor as the viewer: it sees its OWN document in full — its
 * private knowledge is its own — and everything else at player grade.
 */
export interface Viewer {
  readonly grade: "keeper" | "admin" | "player" | "observer";
  readonly memberId?: string;
  readonly actorId?: string;
  readonly locale: string;
}

export const KEEPER: Viewer = { grade: "keeper", locale: "en" };

export function playerViewer(locale: string, memberId?: string): Viewer {
  return memberId === undefined ? { grade: "player", locale } : { grade: "player", locale, memberId };
}

/** A player-grade viewer that is one NPC actor. */
export function actorViewer(actorId: string, locale: string): Viewer {
  return { grade: "player", locale, actorId };
}

export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
export type JsonObject = { readonly [key: string]: Json };

export interface Document {
  readonly type: string;
  readonly id: string;
  /** The type's schema version this payload was written with. */
  readonly version: number;
  readonly data: JsonObject;
  /** Provenance and bookkeeping (`source`: which pack entry this came from). */
  readonly meta: JsonObject;
  /**
   * The stored payload could not be read. `data` is then empty — and a reader that
   * rewrites documents MUST check this first: saving over a corrupt character sheet
   * as if it were blank would destroy the real one.
   */
  readonly corrupt: boolean;
}

/** A refused write: a stable code and where in the payload it applies. */
export interface WriteViolation {
  readonly code: string;
  readonly path: string;
}

export interface DocumentType<View = Json> {
  readonly name: string;
  /** Current schema version; written on every document of this type. */
  readonly version: number;
  /** The view for this viewer, or null when the document is invisible to them. */
  project(document: Document, viewer: Viewer): View | null;
  /** Problems with a payload about to be stored; empty when it is acceptable. */
  validate?(data: JsonObject): readonly WriteViolation[];
  /**
   * Bring a payload written by an older version up to `version`. Absent while the type
   * has only ever had one version.
   */
  migrate?(data: JsonObject, from: number): JsonObject;
}

export class UnknownDocumentType extends Error {
  readonly type: string;

  constructor(type: string) {
    super(`unknown document type: ${type}`);
    this.name = "UnknownDocumentType";
    this.type = type;
  }
}

/** The document types a server knows. Built once at start-up and passed in; not global. */
export class DocumentTypes {
  readonly #types = new Map<string, DocumentType<unknown>>();

  register<View>(type: DocumentType<View>): this {
    if (this.#types.has(type.name)) throw new Error(`document type registered twice: ${type.name}`);
    this.#types.set(type.name, type as DocumentType<unknown>);
    return this;
  }

  get(name: string): DocumentType<unknown> {
    const type = this.#types.get(name);
    if (!type) throw new UnknownDocumentType(name);
    return type;
  }

  names(): string[] {
    return [...this.#types.keys()];
  }

  /**
   * What `viewer` may see of `document`. A corrupt document has no view: showing an
   * empty one would present damage as content.
   */
  project(document: Document, viewer: Viewer): unknown {
    if (document.corrupt) return null;
    return this.get(document.type).project(document, viewer);
  }
}
