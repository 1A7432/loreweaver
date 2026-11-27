// Protocol 3.0 built-in views: the value of each view as a TypeScript type, and the JSON
// Schema `view.list` hands a client for it. The two are written side by side and must
// agree; the server's tests validate every value it computes against the schema.
//
// A view is computed per viewer. Names and labels in it are already in the VIEWER's
// language; ids are stable and never translated. Module views (`<module>/<name>`) carry
// the schema their module declared and are not described here.
import type { Role } from "./frames.js";
import type { PanelsView } from "./panels.js";

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
  /** Absent only on a module's character whose module gave this resource no maximum. */
  max?: number;
}

/** One attribute or skill: the pack's storage key, its label for the viewer, its value. */
export interface ViewStat {
  key: string;
  label: string;
  value: number | string;
  /** The rule system computes this value from others and the sheet stores none: do not offer to edit it. */
  derived?: true;
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
  /**
   * Null for a spectator. `attributes` and `skills` are empty unless the sheet is the viewer's
   * own. A module's character (`module`: the module's id) has the name and resources its module
   * gave, an empty `pack`, and no status, attributes or skills: the module keeps it, not a sheet.
   */
  character: {
    id: string;
    name: string;
    pack: string;
    status: string[];
    resources: ViewResource[];
    attributes: ViewStat[];
    skills: ViewStat[];
    module?: string;
  } | null;
}

/** `party`: who is at the table, what they play, and the fight's order. */
export interface PartyView {
  /** Members online, then seated members who are not. `role` is null for one who is offline. `character`: the id they play (a module's as `<module>:<id>`). */
  members: { id: string; name: string; role: Role | null; online: boolean; character: string | null }[];
  /**
   * Characters in play: every seated one, and any other the room keeps that is not on offer (a
   * companion). A seated module's character carries `module`, as in `me`.
   */
  characters: { id: string; name: string; pack: string; status: string[]; resources: ViewResource[]; player: ViewPerson | null; module?: string }[];
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

/**
 * `characters`: what can be played, and the systems that can make a new character. `claimable`
 * lists a pack's pregens (`source.kind: "pack"`, taken with `pc claim`) and every character the
 * room's modules offer (`source.kind: "module"`, id `<module>:<id>`): only its module seats a
 * member on one, by the module's own command.
 */
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
  /** Whether members may upload files to the room (the admin's upload switch). */
  uploads: boolean;
}

/**
 * `usage`: the token figures of the room's last Keeper turn, and the Keeper model's context
 * window. How full the Keeper's context is: `last.inputTokens / contextWindow`.
 */
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
  /** The context window of the model the Keeper's next turn uses, in tokens. */
  contextWindow?: number;
  /** Present (`false`) when the model is unknown to the server and `contextWindow` is its default. */
  contextWindowKnown?: false;
}

/**
 * `packs`: the content packs installed on the server and the card files they ship, by name.
 * An admin sees every installed pack, each with whether this room enabled it; anyone else
 * sees the packs this room enabled. A card is imported with `import {pack, card: file, as}`.
 */
export interface PacksView {
  packs: {
    id: string;
    version: string;
    /** In the viewer's language. */
    name: string;
    enabled: boolean;
    cards: { file: string; name: string; kind: "world" | "character" }[];
  }[];
}

/**
 * One sound of the room's audio library. Every viewer gets `hash`, `mime` and `size` — what
 * fetching it over the byte channel needs, to prefetch it. The rest names it and is an
 * admin's only: a pack's cue titles and an admin's uploads may give the story away before
 * the table hears them.
 */
export interface ViewAudioSound {
  hash: string;
  mime: string;
  /** Bytes. */
  size: number;
  /** Admin only: the library id (`<pack>/<cue>` for a pack's cue, the hash for an upload). */
  id?: string;
  /** Admin only. */
  title?: string;
  /** Admin only: the layer it is meant for; null when nobody said. */
  layer?: "bgm" | "ambience" | "sfx" | null;
  /** Admin only. */
  tags?: string[];
  /** Admin only: an upload, or a cue of the enabled pack `id`. */
  source?: { kind: "upload" | "pack"; id: string | null };
}

/** What one layer plays now. */
export interface ViewAudioLayer {
  /** The library id of the sound. */
  id: string;
  title: string;
  hash: string;
  mime: string;
  size: number;
  loop: boolean;
  /** 0..1. */
  volume: number;
  paused: boolean;
}

/**
 * `audio`: the room's audio library and what each looping layer plays. A layer with nothing
 * playing is absent; `sfx` is one-shot and never here. This view is the truth: on connect a
 * client starts what it says is playing, then follows the `audio` signals.
 */
export interface AudioView {
  library: ViewAudioSound[];
  playing: { bgm?: ViewAudioLayer; ambience?: ViewAudioLayer };
}

/** Where a model or image setting comes from: an admin's override, the operator's `TRPG_*` variables, or nothing set. */
export type SettingSource = "override" | "environment" | "default";

/** A secret as an admin view shows it: whether one is set, and its first and last few characters. Never the secret. */
export interface MaskedSecret {
  set: boolean;
  /** `sk-a...wxyz`, or stars for a short one; `null` when none is set. */
  masked: string | null;
}

/** One model lane of `admin/model`. */
export interface AdminModelLane {
  /** `keeper`, `npc`, `scribe`, `director`, or `memory` (the chronicle fold). */
  lane: "keeper" | "npc" | "scribe" | "director" | "memory";
  /** `default` on a lane other than the Keeper's: it uses the Keeper's client (`sameAsKeeper`). */
  source: SettingSource;
  sameAsKeeper: boolean;
  /** A preset id, an admin's label for an endpoint, or `null` (nothing configured, or an operator endpoint named by URL only). */
  provider: string | null;
  model: string | null;
  baseUrl: string | null;
  wire: "openai-compatible" | "anthropic" | "openai-responses" | null;
  effort: string | null;
  /** In tokens; `null` when neither the settings nor the server's table know it. */
  contextWindow: number | null;
  key: MaskedSecret;
}

/**
 * `admin/model` (admins only): what each model lane and image generation use now, and the
 * providers this server knows. Keys are masked; the view never carries one whole.
 */
export interface AdminModelView {
  lanes: AdminModelLane[];
  /** The presets, then any endpoint an admin saved under a name of their own. */
  providers: { id: string; preset: boolean; wire: "openai-compatible" | "anthropic" | "openai-responses" | null; baseUrl: string | null; credential: boolean }[];
  imagegen: {
    source: SettingSource;
    enabled: boolean;
    provider: string | null;
    model: string | null;
    size: string | null;
    baseUrl: string | null;
    key: MaskedSecret;
  };
  imageProviders: { id: string; credential: boolean }[];
}

/** `admin/keys` (admins only): this room's access keys. `id` is what the `key` command takes; the key itself is never here. */
export interface AdminKeysView {
  keys: {
    id: string;
    name: string;
    role: Role;
    masked: string;
    /** When it was minted (ms since the epoch); absent for a key from before this was recorded. */
    created?: number;
    /** Someone is connected with it now. */
    online: boolean;
  }[];
}

/** `admin/content` (admins only): the skills, rule systems and packs this room can use, and which are on. */
export interface AdminContentView {
  /** The Keeper's skills this room may enable: the built-in ones and those of its enabled packs. */
  skills: { id: string; title: string; enabled: boolean; source: AdminContentSource }[];
  /** The rule systems on this server; `enabled` marks the room's. */
  ruleSystems: { id: string; title: string; enabled: boolean; source: AdminContentSource }[];
  /** The packs installed on this server; `enabled` marks those this room enabled. */
  packs: { id: string; title: string; version: string; enabled: boolean }[];
}

/** Where a skill or rule system comes from: built into the server, or a pack (`id`). */
export interface AdminContentSource {
  kind: "builtin" | "pack";
  id: string | null;
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
  packs: PacksView;
  panels: PanelsView;
  audio: AudioView;
  "admin/model": AdminModelView;
  "admin/keys": AdminKeysView;
  "admin/content": AdminContentView;
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

const RESOURCE = record({ id: STRING, label: STRING, value: NUMBER, max: NUMBER }, ["max"]);
const STAT = record({ key: STRING, label: STRING, value: { type: ["number", "string"] }, derived: { const: true } }, ["derived"]);
const PERSON = record({ id: STRING, name: STRING });
const SCALAR = { type: ["null", "boolean", "number", "string"] } as const;

export const ME_VIEW_SCHEMA: ViewSchema = record({
  member: record({ id: STRING, name: STRING, role: ROLE, roleLabel: STRING }),
  character: nullable(
    record(
      { id: STRING, name: STRING, pack: STRING, status: list(STRING), resources: list(RESOURCE), attributes: list(STAT), skills: list(STAT), module: STRING },
      ["module"],
    ),
  ),
});

export const PARTY_VIEW_SCHEMA: ViewSchema = record({
  members: list(record({ id: STRING, name: STRING, role: { anyOf: [ROLE, { type: "null" }] }, online: BOOLEAN, character: NULLABLE_STRING })),
  characters: list(record({ id: STRING, name: STRING, pack: STRING, status: list(STRING), resources: list(RESOURCE), player: nullable(PERSON), module: STRING }, ["module"])),
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
  uploads: BOOLEAN,
});

export const USAGE_VIEW_SCHEMA: ViewSchema = record(
  {
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
    contextWindow: INTEGER,
    contextWindowKnown: { const: false },
  },
  ["contextWindow", "contextWindowKnown"],
);

export const PACKS_VIEW_SCHEMA: ViewSchema = record({
  packs: list(
    record({
      id: STRING,
      version: STRING,
      name: STRING,
      enabled: BOOLEAN,
      cards: list(record({ file: STRING, name: STRING, kind: { type: "string", enum: ["world", "character"] } })),
    }),
  ),
});

const BINDABLE_OBJECTS = list({ type: "object" });
const PANEL_VIEW_REF = record({ as: STRING, view: STRING });

/**
 * `panels` (§8.5). Template blocks are checked as objects only: `instantiate` reads them
 * defensively, block by block, and drops what it cannot use.
 */
export const PANELS_VIEW_SCHEMA: ViewSchema = record({
  panels: list(
    record(
      {
        id: STRING,
        title: STRING,
        slot: { type: "string", enum: ["sidebar", "tray", "modal"] },
        kind: { type: "string", enum: ["template", "page"] },
        views: list(PANEL_VIEW_REF),
        source: record({ kind: { type: "string", enum: ["pack", "room"] }, id: STRING }),
        blocks: BINDABLE_OBJECTS,
        page: record({ hash: STRING, size: INTEGER, mime: { const: "text/html" } }),
        fallback: { anyOf: [BINDABLE_OBJECTS, { type: "null" }] },
      },
      ["blocks", "page", "fallback"],
    ),
  ),
});

const AUDIO_LAYER = { type: "string", enum: ["bgm", "ambience", "sfx"] } as const;
const AUDIO_PLAYING_LAYER = record({ id: STRING, title: STRING, hash: STRING, mime: STRING, size: INTEGER, loop: BOOLEAN, volume: NUMBER, paused: BOOLEAN });

export const AUDIO_VIEW_SCHEMA: ViewSchema = record({
  library: list(
    record(
      {
        hash: STRING,
        mime: STRING,
        size: INTEGER,
        id: STRING,
        title: STRING,
        layer: { anyOf: [AUDIO_LAYER, { type: "null" }] },
        tags: list(STRING),
        source: record({ kind: { type: "string", enum: ["upload", "pack"] }, id: NULLABLE_STRING }),
      },
      ["id", "title", "layer", "tags", "source"],
    ),
  ),
  playing: record({ bgm: AUDIO_PLAYING_LAYER, ambience: AUDIO_PLAYING_LAYER }, ["bgm", "ambience"]),
});

const SOURCE = { type: "string", enum: ["override", "environment", "default"] } as const;
const WIRE = { anyOf: [{ type: "string", enum: ["openai-compatible", "anthropic", "openai-responses"] }, { type: "null" }] } as const;
const MASKED = record({ set: BOOLEAN, masked: NULLABLE_STRING });

export const ADMIN_MODEL_VIEW_SCHEMA: ViewSchema = record({
  lanes: list(
    record({
      lane: { type: "string", enum: ["keeper", "npc", "scribe", "director", "memory"] },
      source: SOURCE,
      sameAsKeeper: BOOLEAN,
      provider: NULLABLE_STRING,
      model: NULLABLE_STRING,
      baseUrl: NULLABLE_STRING,
      wire: WIRE,
      effort: NULLABLE_STRING,
      contextWindow: NULLABLE_INTEGER,
      key: MASKED,
    }),
  ),
  providers: list(record({ id: STRING, preset: BOOLEAN, wire: WIRE, baseUrl: NULLABLE_STRING, credential: BOOLEAN })),
  imagegen: record({ source: SOURCE, enabled: BOOLEAN, provider: NULLABLE_STRING, model: NULLABLE_STRING, size: NULLABLE_STRING, baseUrl: NULLABLE_STRING, key: MASKED }),
  imageProviders: list(record({ id: STRING, credential: BOOLEAN })),
});

export const ADMIN_KEYS_VIEW_SCHEMA: ViewSchema = record({
  keys: list(record({ id: STRING, name: STRING, role: ROLE, masked: STRING, created: INTEGER, online: BOOLEAN }, ["created"])),
});

const CONTENT_SOURCE = record({ kind: { type: "string", enum: ["builtin", "pack"] }, id: NULLABLE_STRING });

export const ADMIN_CONTENT_VIEW_SCHEMA: ViewSchema = record({
  skills: list(record({ id: STRING, title: STRING, enabled: BOOLEAN, source: CONTENT_SOURCE })),
  ruleSystems: list(record({ id: STRING, title: STRING, enabled: BOOLEAN, source: CONTENT_SOURCE })),
  packs: list(record({ id: STRING, title: STRING, version: STRING, enabled: BOOLEAN })),
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
  packs: PACKS_VIEW_SCHEMA,
  panels: PANELS_VIEW_SCHEMA,
  audio: AUDIO_VIEW_SCHEMA,
  "admin/model": ADMIN_MODEL_VIEW_SCHEMA,
  "admin/keys": ADMIN_KEYS_VIEW_SCHEMA,
  "admin/content": ADMIN_CONTENT_VIEW_SCHEMA,
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
