// The built-in views (protocol 3.0 §8.4): each a function of the room and one viewer.
//
// Every value is built from PROJECTIONS (`services.views`) made for the viewer, and from
// declared room-state keys — never from a whole stored document. A view picks named fields
// out of a projection, so a field a projection adds later stays out of every view until
// one names it; and a view cannot show what the projection withheld (iron rule 3).
import {
  type AudioView,
  BUILT_IN_VIEW_SCHEMAS,
  type BuiltInViewName,
  type BuiltInViews,
  type CharactersView,
  type CommandsViewData,
  type MeView,
  type PacksView,
  type PanelsView,
  type PartyView,
  type Role,
  type RoomView,
  type SceneView,
  type UsageView,
  type VariablesView,
  type ViewModuleVariable,
  type ViewPerson,
  type ViewResource,
  type ViewSchema,
  type ViewStat,
  type ViewTreeLeaf,
} from "loreweaver-protocol/v3";
import type { Who } from "loreweaver/module";

import type { RoomContext, Services } from "../../agent/context.ts";
import type { ClockInfo } from "../../agent/modules.ts";
import {
  CHARACTER_TYPE,
  type CharacterView,
  CLAIMABLE_ID,
  CLAIMABLE_TYPE,
  type ClaimableView,
  SEATING_ID,
  SEATING_TYPE,
  type SeatingView,
} from "../../core/characters/index.ts";
import { CLOCK_OWNER_ID, CLOCK_OWNER_TYPE, type ClockOwnerView, GAME_CLOCK_ID, GAME_CLOCK_TYPE, type GameClockView, INITIATIVE_ID, INITIATIVE_TYPE, type InitiativeView } from "../../core/clock/index.ts";
import type { Viewer } from "../../core/documents/index.ts";
import { SCENE_ID, SCENE_TYPE, type SceneView as SceneDocumentView } from "../../core/notes/index.ts";
import type { RulePack } from "../../core/rulepacks/index.ts";
import { displayName, type SheetSpec } from "../../core/sheets/index.ts";
import { MODULE_VARIABLES_ID, MODULE_VARIABLES_TYPE, type ModuleVariablesView, VARIABLE_TREE_ID, VARIABLE_TREE_TYPE, type VariableTreeView } from "../../core/variables/index.ts";
import { translate } from "../../infra/i18n.ts";
import type { CommandRegistry } from "../commands/index.ts";
import { localText } from "../../core/packs/index.ts";
import { readPlaying } from "../../core/audio/index.ts";
import type { MediaStore } from "../../infra/media/index.ts";
import { audioView, roomLibrary } from "../audio.ts";
import type { RoomPacks } from "../packs.ts";
import { KEEPER_MUTED, ROOM_LOCALE, ROOM_RULE_VARIANT } from "../commands/index.ts";
import { VIEWS_CATALOG } from "./catalog.ts";
import { LAST_TURN_USAGE } from "./usage.ts";
import { projectionViewer, type ViewerContext, type ViewMemberInfo, whoOf } from "./viewer.ts";

/** A member connected to the room now. Presence is connection state: the session knows it. */
export type OnlineMember = ViewMemberInfo;

/** How the `commands` view reaches the command table: the registry and a context per viewer. */
export interface CommandsSource {
  readonly registry: CommandRegistry;
  /** A read-only context for `who` in this room (the registry's view needs one). */
  contextFor(who: Who): RoomContext;
}

/** What the built-in views are computed from: the room as it is now. */
export interface ViewSource {
  readonly services: Services;
  readonly room: string;
  /** The room's language, when the room state has none stored. */
  readonly locale: string;
  /** The room's rule system, or null. */
  readonly pack: RulePack | null;
  /** The members connected now, in the order they joined. */
  readonly online: readonly OnlineMember[];
  /** Null on a room without a command table: the `commands` view is then empty. */
  readonly commands: CommandsSource | null;
  /** The clock a module keeps, from the last render, when one does. */
  readonly moduleClock?: ClockInfo | null;
  /** Whether members may upload to the room now; absent (a server without a media store): no. */
  readonly uploads?: boolean;
  /** The installed packs; absent: none. */
  readonly packs?: RoomPacks;
  /** The media store; absent or null (a server that keeps no files): the audio library is empty. */
  readonly media?: MediaStore | null;
}

export interface BuiltInView<N extends BuiltInViewName = BuiltInViewName> {
  readonly name: N;
  readonly schema: ViewSchema;
  /** Admin-only views are listed and computed for admins alone. */
  readonly admin: boolean;
  compute(source: ViewSource, viewer: ViewerContext): BuiltInViews[N] | Promise<BuiltInViews[N]>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function project<T>(source: ViewSource, viewer: Viewer, type: string, id: string): T | null {
  return source.services.views.view(source.room, type, id, viewer) as T | null;
}

function say(viewer: ViewerContext, key: string): string {
  return translate(VIEWS_CATALOG, viewer.locale, key);
}

function resources(view: CharacterView): ViewResource[] {
  return view.resources.map((meter) => ({ id: meter.id, label: meter.label, value: meter.value, max: meter.max }));
}

function seatsOf(source: ViewSource, viewer: Viewer): SeatingView["seats"] {
  return project<SeatingView>(source, viewer, SEATING_TYPE, SEATING_ID)?.seats ?? [];
}

function pairs(value: unknown): [string, number | string][] {
  if (!Array.isArray(value)) return [];
  const out: [string, number | string][] = [];
  for (const item of value) {
    if (Array.isArray(item) && typeof item[0] === "string" && (typeof item[1] === "number" || typeof item[1] === "string")) out.push([item[0], item[1]]);
  }
  return out;
}

/**
 * The stats of one sheet section, labelled for `locale`: the stored slots in sheet order,
 * then the derived slots the sheet does not store. A storage key's label is the pack's
 * display name of its canonical name.
 */
function stats(
  spec: SheetSpec | null,
  stored: unknown,
  keys: ReadonlyMap<string, string> | undefined,
  derivedSlots: ReadonlyMap<string, string> | undefined,
  derived: ReadonlyMap<string, number | string>,
  locale: string,
): ViewStat[] {
  const canonicalOf = new Map<string, string>();
  for (const [canonical, key] of keys ?? []) if (!canonicalOf.has(key)) canonicalOf.set(key, canonical);
  const label = (key: string, canonical: string | undefined): string => (spec === null ? key : displayName(spec, canonical ?? key, locale));
  const out: ViewStat[] = [];
  const seen = new Set<string>();
  for (const [key, value] of pairs(stored)) {
    seen.add(key);
    out.push({ key, label: label(key, canonicalOf.get(key)), value });
  }
  for (const [key, canonical] of derivedSlots ?? []) {
    const value = derived.get(canonical);
    if (seen.has(key) || value === undefined) continue;
    out.push({ key, label: label(key, canonical), value });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The views
// ---------------------------------------------------------------------------

function me(source: ViewSource, viewer: ViewerContext): MeView {
  const member = { id: viewer.member.id, name: viewer.member.name, role: viewer.member.role, roleLabel: say(viewer, `role.${viewer.member.role}`) };
  if (viewer.character === null) return { member, character: null };
  const view = project<CharacterView>(source, projectionViewer(viewer), CHARACTER_TYPE, viewer.character.id);
  if (view === null) return { member, character: null };
  const character: NonNullable<MeView["character"]> = {
    id: viewer.character.id,
    name: view.name,
    pack: view.pack,
    status: [...view.status],
    resources: resources(view),
    attributes: [],
    skills: [],
  };
  // The whole sheet is in the projection only when the sheet is the viewer's own.
  if ("sheet" in view) {
    const spec = source.services.packs.get(view.pack)?.sheet ?? null;
    const shape = spec?.shape ?? null;
    const derived = new Map(view.derived.map(([name, value]) => [name, value] as const));
    const sheet = view.sheet as { readonly attributes?: unknown; readonly skills?: unknown };
    character.attributes = stats(spec, sheet.attributes, shape?.attrKeys, shape?.derivedAttrs, derived, viewer.locale);
    character.skills = stats(spec, sheet.skills, shape?.skillKeys, shape?.derivedSkills, derived, viewer.locale);
  }
  return { member, character };
}

function party(source: ViewSource, viewer: ViewerContext): PartyView {
  const projection = projectionViewer(viewer);
  const seats = seatsOf(source, projection);
  const onOffer = new Set((project<ClaimableView>(source, projection, CLAIMABLE_TYPE, CLAIMABLE_ID)?.characters ?? []).map((entry) => entry.id));

  const members: PartyView["members"] = [];
  const listed = new Set<string>();
  for (const member of source.online) {
    if (listed.has(member.id)) continue;
    listed.add(member.id);
    const seat = seats.find((item) => item.member === member.id);
    members.push({ id: member.id, name: member.name, role: member.role, online: true, character: seat?.character ?? null });
  }
  for (const seat of seats) {
    if (listed.has(seat.member)) continue;
    listed.add(seat.member);
    members.push({ id: seat.member, name: seat.memberName, role: null, online: false, character: seat.character });
  }

  const characters: PartyView["characters"] = [];
  for (const entry of source.services.views.views(source.room, CHARACTER_TYPE, projection)) {
    const seat = seats.find((item) => item.character === entry.id);
    // A character on offer that nobody plays is the `characters` view's, not the party's.
    if (seat === undefined && onOffer.has(entry.id)) continue;
    const view = entry.view as CharacterView;
    const player: ViewPerson | null = seat === undefined ? null : { id: seat.member, name: seat.memberName };
    // Named fields only: the viewer's own character arrives whole from the projection,
    // and the party shows every character at table grade.
    characters.push({ id: entry.id, name: view.name, pack: view.pack, status: [...view.status], resources: resources(view), player });
  }

  const order = project<InitiativeView>(source, projection, INITIATIVE_TYPE, INITIATIVE_ID);
  const initiative =
    order === null || order.order.length === 0
      ? null
      : { round: order.round, acting: order.acting, order: order.order.map((item) => ({ name: item.name, value: item.value })) };
  return { members, characters, initiative };
}

function scene(source: ViewSource, viewer: ViewerContext): SceneView {
  const projection = projectionViewer(viewer);
  const card = project<SceneDocumentView>(source, projection, SCENE_TYPE, SCENE_ID);
  const clock = project<GameClockView>(source, projection, GAME_CLOCK_TYPE, GAME_CLOCK_ID);
  const owner = project<ClockOwnerView>(source, projection, CLOCK_OWNER_TYPE, CLOCK_OWNER_ID)?.owner ?? { kind: "keeper" as const };
  const fight = project<InitiativeView>(source, projection, INITIATIVE_TYPE, INITIATIVE_ID);
  // A module that keeps the room's clock says so by answering with a reading (the room
  // passes its latest): that is the authority. The ownership document is a fallback for a
  // room whose module has not been asked yet.
  const moduleClock = source.moduleClock ?? null;
  const clockModule = moduleClock?.module ?? (owner.kind === "module" ? owner.id : null);
  const kept = moduleClock?.time ?? clock?.now ?? "";
  const round = fight !== null && fight.order.length > 0 ? fight.round : (moduleClock?.round ?? null);
  return {
    name: card?.name ?? "",
    focus: card?.focus ?? "",
    established: (card?.established ?? []).map((fact) => ({ text: fact.text, at: fact.at })),
    time: kept === "" ? null : kept,
    clockModule,
    round,
  };
}

function variables(source: ViewSource, viewer: ViewerContext): VariablesView {
  const projection = projectionViewer(viewer);
  const declared = project<ModuleVariablesView>(source, projection, MODULE_VARIABLES_TYPE, MODULE_VARIABLES_ID)?.variables ?? [];
  const tree = project<VariableTreeView>(source, projection, VARIABLE_TREE_TYPE, VARIABLE_TREE_ID)?.leaves ?? [];
  // The projections already decide what each grade sees: a player gets player-visible
  // variables and exposed leaves only; an admin gets every one, the rest flagged `hidden`.
  // Here the flag is carried over, never set.
  const module = declared.map((variable): ViewModuleVariable => {
    const out: ViewModuleVariable = { id: variable.id, kind: variable.kind, label: variable.label, value: variable.value };
    if (variable.valueLabel !== undefined) out.valueLabel = variable.valueLabel;
    if (variable.min !== undefined) out.min = variable.min;
    if (variable.max !== undefined) out.max = variable.max;
    if (variable.options !== undefined) out.options = [...variable.options];
    if (variable.hidden === true) out.hidden = true;
    return out;
  });
  const leaves = tree.map((leaf): ViewTreeLeaf => {
    const out: ViewTreeLeaf = { path: leaf.path, value: Array.isArray(leaf.value) ? [...leaf.value] : (leaf.value as ViewTreeLeaf["value"]) };
    if (leaf.description !== undefined) out.description = leaf.description;
    if (leaf.hidden === true) out.hidden = true;
    return out;
  });
  return { module, tree: leaves };
}

function systemLabel(pack: RulePack): string {
  const label = pack.sheet.shape?.label ?? "";
  return label === "" ? pack.id : label;
}

function characters(source: ViewSource, viewer: ViewerContext): CharactersView {
  const projection = projectionViewer(viewer);
  const seats = seatsOf(source, projection);
  const offer = project<ClaimableView>(source, projection, CLAIMABLE_TYPE, CLAIMABLE_ID)?.characters ?? [];
  const claimable = offer.map((entry) => {
    const seat = seats.find((item) => item.character === entry.id);
    return {
      id: entry.id,
      name: entry.name,
      blurb: entry.blurb,
      source: { kind: entry.source.kind, id: entry.source.id },
      player: seat === undefined ? null : { id: seat.member, name: seat.memberName },
    };
  });
  // A system can make a character when its pack declares a sheet shape.
  const systems = source.services.packs
    .packs()
    .filter((pack) => pack.sheet.shape !== null)
    .map((pack) => ({ id: pack.id, label: systemLabel(pack), active: pack.id === source.pack?.id }));
  return { claimable, systems, mine: viewer.character?.id ?? null };
}

async function commands(source: ViewSource, viewer: ViewerContext): Promise<CommandsViewData> {
  if (source.commands === null) return { commands: [] };
  const view = await source.commands.registry.view(source.commands.contextFor(whoOf(viewer)), viewer.locale);
  return {
    commands: view.commands.map((entry) => {
      const out: CommandsViewData["commands"][number] = {
        id: entry.id,
        source: entry.source,
        title: entry.title,
        description: entry.description,
        params: entry.params,
        role: entry.role,
        available: entry.available,
      };
      if (entry.text !== undefined) out.text = { forms: [...entry.text.forms], usage: entry.text.usage };
      if (entry.danger === true) out.danger = true;
      if (entry.reason !== undefined) out.reason = entry.reason;
      return out;
    }),
  };
}

function room(source: ViewSource, viewer: ViewerContext): RoomView {
  const store = source.services.store;
  const locale = store.stateGet(source.room, ROOM_LOCALE) ?? source.locale;
  const stored = store.stateGet(source.room, ROOM_RULE_VARIANT);
  // A stored variant the pack no longer declares grades by the default, as `rule` says.
  const variant = stored !== null && source.pack?.resolution?.variants.has(stored) === true ? stored : null;
  return {
    locale,
    localeLabel: say(viewer, `language.${locale}`),
    system: source.pack === null ? null : { id: source.pack.id, label: systemLabel(source.pack) },
    variant,
    keeperMuted: store.stateGet(source.room, KEEPER_MUTED) ?? false,
    uploads: source.uploads ?? false,
  };
}

function usage(source: ViewSource, _viewer: ViewerContext): UsageView {
  const last = source.services.store.stateGet(source.room, LAST_TURN_USAGE);
  return { last: last === null ? null : { ...last } };
}

/** An admin sees every installed pack; anyone else, the packs this room enabled. Names only. */
function packs(source: ViewSource, viewer: ViewerContext): PacksView {
  const installed = source.packs;
  if (installed === undefined) return { packs: [] };
  const store = source.services.store;
  const enabled = new Set(installed.enabledIds(store, source.room));
  const shown = viewer.member.role === "admin" ? installed.installed() : installed.enabled(store, source.room);
  return {
    packs: shown.map(({ pack }) => ({
      id: pack.manifest.id,
      version: pack.manifest.version,
      name: localText(pack.manifest.name, viewer.locale) || pack.manifest.id,
      enabled: enabled.has(pack.manifest.id),
      cards: pack.cards.map((card) => ({ file: card.path, name: card.name, kind: card.kind })),
    })),
  };
}

/** The panels of the room's enabled packs that are on and listed to this viewer, in the viewer's language. */
function panels(source: ViewSource, viewer: ViewerContext): PanelsView {
  if (source.packs === undefined) return { panels: [] };
  return { panels: source.packs.panelsFor(source.services.store, source.room, viewer.member.role, viewer.locale) };
}

/** The room's audio library and what each looping layer plays (`gateway/audio.ts` decides what each role sees). */
function audio(source: ViewSource, viewer: ViewerContext): AudioView {
  const store = source.services.store;
  return audioView(roomLibrary(store, source.room, source.packs ?? null, source.media ?? null), readPlaying(store, source.room), viewer.member.role);
}

function builtIn<N extends BuiltInViewName>(name: N, compute: BuiltInView<N>["compute"]): BuiltInView<N> {
  return { name, schema: BUILT_IN_VIEW_SCHEMAS[name], admin: false, compute };
}

/** Every built-in view of the first release, in listing order. */
export const BUILT_IN_VIEWS: readonly BuiltInView[] = [
  builtIn("me", me),
  builtIn("party", party),
  builtIn("scene", scene),
  builtIn("variables", variables),
  builtIn("characters", characters),
  builtIn("commands", commands),
  builtIn("room", room),
  builtIn("usage", usage),
  builtIn("packs", packs),
  builtIn("panels", panels),
  builtIn("audio", audio),
] as readonly BuiltInView[];

/** Who may see a view listed and subscribe to it. */
export function mayView(view: { readonly admin: boolean }, role: Role): boolean {
  return !view.admin || role === "admin";
}
