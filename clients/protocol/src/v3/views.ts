// Protocol 3.0 built-in views: the value of each view as a TypeScript type, and the JSON
// Schema `view.list` hands a client for it. The two are written side by side and must
// agree; the server's tests validate every value it computes against the schema.
//
// A view is computed per viewer. Names and labels in it are already in the VIEWER's
// language; ids are stable and never translated. Module views (`<module>/<name>`) carry
// the schema their module declared and are not described here.
import type { Role } from "./frames.js";

/** A JSON Schema, as plain data. */
export type ViewSchema = { readonly [key: string]: unknown };

// ---------------------------------------------------------------------------
// Shared parts
// ---------------------------------------------------------------------------

/** A meter on a character (HP, sanity…), labelled for the viewer. */
export interface ViewResource {
  id: string;
  label: string;
  value: number;
  max: number;
}

/** One attribute or skill: the pack's storage key, its label for the viewer, its value. */
export interface ViewStat {
  key: string;
  label: string;
  value: number | string;
}

/** A member, as named in another view. */
export interface ViewPerson {
  id: string;
  name: string;
}

// ---------------------------------------------------------------------------
// The views
// ---------------------------------------------------------------------------

/** `me`: the viewer, their role and the character they play. */
export interface MeView {
  member: { id: string; name: string; role: Role; roleLabel: string };
  /** Null for a spectator. `attributes` and `skills` are empty unless the sheet is the viewer's own. */
  character: {
    id: string;
    name: string;
    pack: string;
    status: string[];
    resources: ViewResource[];
    attributes: ViewStat[];
    skills: ViewStat[];
  } | null;
}

/** `party`: who is at the table, what they play, and the fight's order. */
export interface PartyView {
  /** Members online, then seated members who are not. `role` is null for one who is offline. */
  members: { id: string; name: string; role: Role | null; online: boolean; character: string | null }[];
  /** Characters in play: every seated one, and any other the room keeps that is not on offer (a companion). */
  characters: { id: string; name: string; pack: string; status: string[]; resources: ViewResource[]; player: ViewPerson | null }[];
  /** Null while no fight is on. */
  initiative: { round: number; acting: string | null; order: { name: string; value: number }[] } | null;
}

/** `scene`: what the table is looking at, and the time. */
export interface SceneView {
  name: string;
  focus: string;
  established: { text: string; at: string | null }[];
  /** The clock's text; null while unset. */
  time: string | null;
  /** The module that keeps the clock; null when the Keeper does. */
  clockModule: string | null;
  /** The combat round while a fight is on, else a module clock's round, else null. */
  round: number | null;
}

/** One module variable as the viewer may see it. `hidden`: admin only — players do not see it. */
export interface ViewModuleVariable {
  id: string;
  kind: "number" | "bool" | "text" | "enum";
  label: string;
  value: number | boolean | string;
  valueLabel?: string;
  min?: number;
  max?: number;
  options?: string[];
  hidden?: true;
}

export type ViewScalar = null | boolean | number | string;

/** One leaf of the variable tree as the viewer may see it. `hidden`: admin only — not exposed to players. */
export interface ViewTreeLeaf {
  path: string;
  value: ViewScalar | ViewScalar[];
  description?: string;
  hidden?: true;
}

/** `variables`: the room variables this viewer may see, both kinds. */
export interface VariablesView {
  module: ViewModuleVariable[];
  tree: ViewTreeLeaf[];
}

/** `characters`: what can be played, and the systems that can make a new character. */
export interface CharactersView {
  claimable: { id: string; name: string; blurb: string; source: { kind: "pack" | "module"; id: string }; player: ViewPerson | null }[];
  systems: { id: string; label: string; active: boolean }[];
  /** The character the viewer plays, or null. */
  mine: string | null;
}

/** One entry of the `commands` view (§8.3). */
export interface ViewCommand {
  id: string;
  source: "engine" | "pack" | "module";
  title: string;
  description: string;
  /** The arguments' JSON Schema. */
  params: unknown;
  text?: { forms: string[]; usage: string };
  role: "player" | "admin";
  danger?: boolean;
  available: boolean;
  reason?: string;
}

/** `commands`: the command table for this viewer. */
export interface CommandsViewData {
  commands: ViewCommand[];
}

/** `room`: the room's settings. */
export interface RoomView {
  locale: string;
  localeLabel: string;
  /** The active rule system; null when the room has none. */
  system: { id: string; label: string } | null;
  /** The house-rule variant within that system; null for its default. */
  variant: string | null;
  keeperMuted: boolean;
}

/** `usage`: the token figures of the room's last Keeper turn. */
export interface UsageView {
  last: {
    turn: number;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
    /** The prompt size was estimated by the engine: the provider reported none. */
    estimated: boolean;
  } | null;
}

/** Every built-in view by name. */
export interface BuiltInViews {
  me: MeView;
  party: PartyView;
  scene: SceneView;
  variables: VariablesView;
  characters: CharactersView;
  commands: CommandsViewData;
  room: RoomView;
  usage: UsageView;
}

export type BuiltInViewName = keyof BuiltInViews;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const STRING = { type: "string" } as const;
const INTEGER = { type: "integer" } as const;
const NUMBER = { type: "number" } as const;
const BOOLEAN = { type: "boolean" } as const;
const NULLABLE_STRING = { type: ["string", "null"] } as const;
const NULLABLE_INTEGER = { type: ["integer", "null"] } as const;
const ROLE = { type: "string", enum: ["player", "admin", "observer"] } as const;
const ANY = {} as const;

function list(items: ViewSchema): ViewSchema {
  return { type: "array", items };
}

/** An object with exactly these properties; all required unless listed as optional. */
function record(properties: Readonly<Record<string, ViewSchema>>, optional: readonly string[] = []): ViewSchema {
  return { type: "object", properties, required: Object.keys(properties).filter((name) => !optional.includes(name)), additionalProperties: false };
}

function nullable(schema: ViewSchema): ViewSchema {
  return { anyOf: [schema, { type: "null" }] };
}

const RESOURCE = record({ id: STRING, label: STRING, value: NUMBER, max: NUMBER });
const STAT = record({ key: STRING, label: STRING, value: { type: ["number", "string"] } });
const PERSON = record({ id: STRING, name: STRING });
const SCALAR = { type: ["null", "boolean", "number", "string"] } as const;

export const ME_VIEW_SCHEMA: ViewSchema = record({
  member: record({ id: STRING, name: STRING, role: ROLE, roleLabel: STRING }),
  character: nullable(
    record({ id: STRING, name: STRING, pack: STRING, status: list(STRING), resources: list(RESOURCE), attributes: list(STAT), skills: list(STAT) }),
  ),
});

export const PARTY_VIEW_SCHEMA: ViewSchema = record({
  members: list(record({ id: STRING, name: STRING, role: { anyOf: [ROLE, { type: "null" }] }, online: BOOLEAN, character: NULLABLE_STRING })),
  characters: list(record({ id: STRING, name: STRING, pack: STRING, status: list(STRING), resources: list(RESOURCE), player: nullable(PERSON) })),
  initiative: nullable(record({ round: INTEGER, acting: NULLABLE_STRING, order: list(record({ name: STRING, value: INTEGER })) })),
});

export const SCENE_VIEW_SCHEMA: ViewSchema = record({
  name: STRING,
  focus: STRING,
  established: list(record({ text: STRING, at: NULLABLE_STRING })),
  time: NULLABLE_STRING,
  clockModule: NULLABLE_STRING,
  round: NULLABLE_INTEGER,
});

export const VARIABLES_VIEW_SCHEMA: ViewSchema = record({
  module: list(
    record(
      {
        id: STRING,
        kind: { type: "string", enum: ["number", "bool", "text", "enum"] },
        label: STRING,
        value: { type: ["number", "boolean", "string"] },
        valueLabel: STRING,
        min: NUMBER,
        max: NUMBER,
        options: list(STRING),
        hidden: { const: true },
      },
      ["valueLabel", "min", "max", "options", "hidden"],
    ),
  ),
  tree: list(record({ path: STRING, value: { anyOf: [SCALAR, list(SCALAR)] }, description: STRING, hidden: { const: true } }, ["description", "hidden"])),
});

export const CHARACTERS_VIEW_SCHEMA: ViewSchema = record({
  claimable: list(
    record({
      id: STRING,
      name: STRING,
      blurb: STRING,
      source: record({ kind: { type: "string", enum: ["pack", "module"] }, id: STRING }),
      player: nullable(PERSON),
    }),
  ),
  systems: list(record({ id: STRING, label: STRING, active: BOOLEAN })),
  mine: NULLABLE_STRING,
});

export const COMMANDS_VIEW_SCHEMA: ViewSchema = record({
  commands: list(
    record(
      {
        id: STRING,
        source: { type: "string", enum: ["engine", "pack", "module"] },
        title: STRING,
        description: STRING,
        params: ANY,
        text: record({ forms: list(STRING), usage: STRING }),
        role: { type: "string", enum: ["player", "admin"] },
        danger: BOOLEAN,
        available: BOOLEAN,
        reason: STRING,
      },
      ["text", "danger", "reason"],
    ),
  ),
});

export const ROOM_VIEW_SCHEMA: ViewSchema = record({
  locale: STRING,
  localeLabel: STRING,
  system: nullable(record({ id: STRING, label: STRING })),
  variant: NULLABLE_STRING,
  keeperMuted: BOOLEAN,
});

export const USAGE_VIEW_SCHEMA: ViewSchema = record({
  last: nullable(
    record({
      turn: INTEGER,
      inputTokens: INTEGER,
      outputTokens: INTEGER,
      cachedInputTokens: INTEGER,
      cacheWriteTokens: INTEGER,
      reasoningTokens: INTEGER,
      estimated: BOOLEAN,
    }),
  ),
});

/** The schema of every built-in view, by name. */
export const BUILT_IN_VIEW_SCHEMAS: { readonly [K in BuiltInViewName]: ViewSchema } = {
  me: ME_VIEW_SCHEMA,
  party: PARTY_VIEW_SCHEMA,
  scene: SCENE_VIEW_SCHEMA,
  variables: VARIABLES_VIEW_SCHEMA,
  characters: CHARACTERS_VIEW_SCHEMA,
  commands: COMMANDS_VIEW_SCHEMA,
  room: ROOM_VIEW_SCHEMA,
  usage: USAGE_VIEW_SCHEMA,
};

/** One entry of `view.list`. */
export interface ViewListing {
  name: string;
  schema: ViewSchema;
  /** A module view's title as its module declared it. */
  title?: string;
}

/** A name only an admin may subscribe to (and see listed). */
export function isAdminViewName(name: string): boolean {
  return name.startsWith("admin/");
}
