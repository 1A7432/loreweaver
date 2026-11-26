// A non-player character's record, the changes the Keeper's tools make to it, and who
// sees what of it (iron rule 3).
//
// Payload `{ name, publicDescription, persona, style, secretAgenda, knowledge, disposition,
// location, locationKnown, major }`. `knowledge` is a list of discrete facts — exactly the
// epistemic world the NPC's actor is built from, kept atomic so that prompt stays
// auditable and learning one thing is one append.
//
// Views — built by naming fields, so a field added later stays private until a view names it:
//   - keeper: the whole record;
//   - the NPC ITSELF as an actor (`viewer.actorId` = the document id): the whole record —
//     its persona, agenda and knowledge are its own;
//   - everyone else — admin, player, observer, and every OTHER actor: the name, the public
//     description, and the location when the table knows it. Another NPC's agenda or
//     knowledge never reaches an actor: that is what keeps two NPCs from metagaming each
//     other. The admin is a player here; the Keeper's secrets are not management detail.
import type { Document, DocumentType, JsonObject, Viewer, WriteViolation } from "../documents/model.ts";
import { cleanOptionalText, cleanText, onlyKeys } from "./text.ts";

export const NPC_TYPE = "npc";

/** In code points, each. */
export const MAX_NPC_NAME_CHARS = 64;
export const MAX_NPC_ID_CHARS = 64;
export const MAX_PUBLIC_DESCRIPTION_CHARS = 500;
export const MAX_PERSONA_CHARS = 2000;
export const MAX_STYLE_CHARS = 500;
export const MAX_SECRET_AGENDA_CHARS = 2000;
/** Room for an attitude AND its reason: a live Keeper writes "hostile; they tore her map off the wall" (97 characters). */
export const MAX_DISPOSITION_CHARS = 200;
export const MAX_LOCATION_CHARS = 120;
/** Facts one NPC knows; each is one bullet of its actor's prompt. */
export const MAX_KNOWLEDGE_FACTS = 64;
/** One fact, with the circumstance it was learned in: a live Keeper's facts ran 137-294 characters, and two were refused at 280. */
export const MAX_FACT_CHARS = 400;

export type Npc = {
  readonly name: string;
  /** What anyone at the table can see of them. */
  readonly publicDescription: string;
  /** Who they are: voice, manner, goals. */
  readonly persona: string;
  /** How they speak. */
  readonly style: string;
  /** What they want and hide. */
  readonly secretAgenda: string;
  readonly knowledge: readonly string[];
  /** Their attitude toward the party, free text; "" when unset. */
  readonly disposition: string;
  readonly location: string;
  /** Whether the table knows where they are. */
  readonly locationKnown: boolean;
  /** A major NPC is played by its own actor; a minor one the Keeper voices inline. */
  readonly major: boolean;
};

export type NpcRefusal =
  | "bad_name"
  | "bad_public_description"
  | "bad_persona"
  | "bad_style"
  | "bad_secret_agenda"
  | "bad_fact"
  | "knowledge_full"
  | "bad_disposition"
  | "bad_location";

export type NpcChange = { readonly ok: true; readonly data: Npc } | { readonly ok: false; readonly code: NpcRefusal };

/** What creating an NPC takes: a name, and any of the rest. */
export type NpcDraft = Partial<Omit<Npc, "name">> & { readonly name: string };

/** The text fields with their caps and refusal codes (the name is required, these may be empty). */
const TEXT_FIELDS = [
  ["publicDescription", MAX_PUBLIC_DESCRIPTION_CHARS, "bad_public_description"],
  ["persona", MAX_PERSONA_CHARS, "bad_persona"],
  ["style", MAX_STYLE_CHARS, "bad_style"],
  ["secretAgenda", MAX_SECRET_AGENDA_CHARS, "bad_secret_agenda"],
  ["disposition", MAX_DISPOSITION_CHARS, "bad_disposition"],
  ["location", MAX_LOCATION_CHARS, "bad_location"],
] as const;

/** Every change goes through here, so each one enforces every cap. */
function build(fields: Npc): NpcChange {
  const name = cleanText(fields.name, MAX_NPC_NAME_CHARS);
  if (name === null) return { ok: false, code: "bad_name" };
  const texts: Record<(typeof TEXT_FIELDS)[number][0], string> = {
    publicDescription: "",
    persona: "",
    style: "",
    secretAgenda: "",
    disposition: "",
    location: "",
  };
  for (const [key, max, code] of TEXT_FIELDS) {
    const text = cleanOptionalText(fields[key], max);
    if (text === null) return { ok: false, code };
    texts[key] = text;
  }
  const knowledge: string[] = [];
  for (const fact of fields.knowledge) {
    const text = cleanText(fact, MAX_FACT_CHARS);
    if (text === null) return { ok: false, code: "bad_fact" };
    if (!knowledge.includes(text)) knowledge.push(text);
  }
  if (knowledge.length > MAX_KNOWLEDGE_FACTS) return { ok: false, code: "knowledge_full" };
  return {
    ok: true,
    data: Object.freeze({
      name,
      ...texts,
      knowledge: Object.freeze(knowledge),
      locationKnown: fields.locationKnown === true,
      major: fields.major === true,
    }),
  };
}

/**
 * A new NPC. Unset text is empty, the location unknown to the table, and the NPC major
 * unless said otherwise (an NPC worth a record is usually worth an actor).
 */
export function createNpc(draft: NpcDraft): NpcChange {
  return build({
    name: draft.name,
    publicDescription: draft.publicDescription ?? "",
    persona: draft.persona ?? "",
    style: draft.style ?? "",
    secretAgenda: draft.secretAgenda ?? "",
    knowledge: draft.knowledge ?? [],
    disposition: draft.disposition ?? "",
    location: draft.location ?? "",
    locationKnown: draft.locationKnown ?? false,
    major: draft.major ?? true,
  });
}

/**
 * An NPC improvised in one line ("a nervous shopkeeper who owes the docks money") so it
 * can speak at once. It still gets a record: without one its actor would have no scoped
 * home for what it later learns.
 */
export function sketchNpc(name: string, oneLine: string): NpcChange {
  return createNpc({ name, persona: oneLine, major: true });
}

/** Change any of the record's fields but its name (a renamed NPC is a new record). */
export function reviseNpc(npc: Npc, patch: Partial<Omit<Npc, "name">>): NpcChange {
  return build({ ...npc, ...patch, name: npc.name });
}

/** The NPC is now at `location`; `known` says whether the table knows it. */
export function moveNpc(npc: Npc, location: string, known: boolean): NpcChange {
  return build({ ...npc, location, locationKnown: known });
}

/** The NPC learns one fact; a fact it already knows leaves the record as it was. */
export function learn(npc: Npc, fact: string): NpcChange {
  const text = cleanText(fact, MAX_FACT_CHARS);
  if (text === null) return { ok: false, code: "bad_fact" };
  if (npc.knowledge.includes(text)) return { ok: true, data: npc };
  if (npc.knowledge.length >= MAX_KNOWLEDGE_FACTS) return { ok: false, code: "knowledge_full" };
  return build({ ...npc, knowledge: [...npc.knowledge, text] });
}

/** Replace everything the NPC knows (a module's seeded knowledge, a Keeper's rewrite). */
export function setKnowledge(npc: Npc, facts: readonly string[]): NpcChange {
  return build({ ...npc, knowledge: facts });
}

export function setDisposition(npc: Npc, disposition: string): NpcChange {
  return build({ ...npc, disposition });
}

/**
 * A document id for an NPC named `name`: lower case, runs of anything but letters and
 * digits (of any script) collapsed to `-`. Null when nothing is left. Two names that
 * differ only in case or punctuation share an id — the caller treats that as the same NPC.
 */
export function npcSlug(name: string): string | null {
  const slug = name
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return slug !== "" && cleanText(slug, MAX_NPC_ID_CHARS) === slug ? slug : null;
}

export function npcData(npc: Npc): JsonObject {
  return {
    name: npc.name,
    publicDescription: npc.publicDescription,
    persona: npc.persona,
    style: npc.style,
    secretAgenda: npc.secretAgenda,
    knowledge: [...npc.knowledge],
    disposition: npc.disposition,
    location: npc.location,
    locationKnown: npc.locationKnown,
    major: npc.major,
  };
}

const PAYLOAD_KEYS = [
  "name",
  "publicDescription",
  "persona",
  "style",
  "secretAgenda",
  "knowledge",
  "disposition",
  "location",
  "locationKnown",
  "major",
] as const;

/** A stored record read back; null when a field has the wrong type. */
export function readNpc(data: JsonObject): Npc | null {
  const { name, publicDescription, persona, style, secretAgenda, knowledge, disposition, location, locationKnown, major } = data;
  if (
    typeof name !== "string" ||
    typeof publicDescription !== "string" ||
    typeof persona !== "string" ||
    typeof style !== "string" ||
    typeof secretAgenda !== "string" ||
    typeof disposition !== "string" ||
    typeof location !== "string" ||
    typeof locationKnown !== "boolean" ||
    typeof major !== "boolean" ||
    !Array.isArray(knowledge) ||
    !knowledge.every((fact) => typeof fact === "string")
  ) {
    return null;
  }
  return Object.freeze({
    name,
    publicDescription,
    persona,
    style,
    secretAgenda,
    knowledge: Object.freeze([...(knowledge as readonly string[])]),
    disposition,
    location,
    locationKnown,
    major,
  });
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface NpcTableView {
  readonly name: string;
  readonly publicDescription: string;
  /** Null when the table does not know where they are. */
  readonly location: string | null;
}

export type NpcFullView = Npc;

export type NpcView = NpcTableView | NpcFullView;

function seesWhole(document: Document, viewer: Viewer): boolean {
  return viewer.grade === "keeper" || (viewer.actorId !== undefined && viewer.actorId === document.id);
}

function projectNpc(document: Document, viewer: Viewer): NpcView | null {
  const npc = readNpc(document.data);
  if (npc === null) return null;
  if (seesWhole(document, viewer)) {
    return { ...npc, knowledge: [...npc.knowledge] };
  }
  return {
    name: npc.name,
    publicDescription: npc.publicDescription,
    location: npc.locationKnown && npc.location !== "" ? npc.location : null,
  };
}

const REFUSAL_PATH: Readonly<Record<NpcRefusal, string>> = {
  bad_name: "name",
  bad_public_description: "publicDescription",
  bad_persona: "persona",
  bad_style: "style",
  bad_secret_agenda: "secretAgenda",
  bad_fact: "knowledge",
  knowledge_full: "knowledge",
  bad_disposition: "disposition",
  bad_location: "location",
};

function validateNpc(data: JsonObject): WriteViolation[] {
  const extra = onlyKeys(data, PAYLOAD_KEYS);
  if (extra !== null) return [{ code: "unknown_field", path: extra }];
  const npc = readNpc(data);
  if (npc === null) return [{ code: "malformed", path: "" }];
  const built = build(npc);
  if (!built.ok) return [{ code: built.code, path: REFUSAL_PATH[built.code] }];
  // A stored record is a built one: untrimmed text or a repeated fact was not written by
  // these functions.
  if (JSON.stringify(npcData(built.data)) !== JSON.stringify(npcData(npc))) return [{ code: "not_normalized", path: "" }];
  return [];
}

export const npcDocument: DocumentType<NpcView> = {
  name: NPC_TYPE,
  lifecycle: { reset: "story" },
  version: 1,
  project: projectNpc,
  validate: validateNpc,
};
