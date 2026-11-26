// The presentation kit: what a module says its table should LOOK and SOUND like, once, as
// data — the whole creative brief the Stage Director works from (`director.ts`). Two
// shapes:
//
// - `PresentationKit`: one pack's kit as its author declared it, parsed by
//   `core/presentation/kit.ts` (re-exported here).
// - `RoomKit`: every enabled pack's kit merged for one room, each subject's reference
//   picture and each cue's sound resolved to a stored asset (`KitAsset`). This is what the
//   Director is handed.
//
// Three rules carry the image discipline, and two are structural:
// - Reference-mandatory: a subject with no reference picture can be named but never
//   generated, and the reference rides every generation request.
// - `generation: pack_only` is the author's veto: the room shows the pack's own art and
//   nothing generated. In a room with several packs one veto silences generation.
// - `templates:` lists the staging shapes the author allows (omitted or empty: all). Across
//   packs the lists INTERSECT — a second pack can only narrow a stricter author's choice.
import { kitTextFor, type AudioLayer, type KitText, type PresentationKit, type SubjectKind, type TemplateKind } from "../../core/presentation/kit.ts";

export * from "../../core/presentation/kit.ts";

/** How many enabled packs one room's kit merges. */
export const MAX_ROOM_KITS = 16;

// ---------------------------------------------------------------------------
// The room's merged kit
// ---------------------------------------------------------------------------

/** A stored pack file, addressed by content hash as every client fetches it. */
export interface KitAsset {
  readonly hash: string;
  readonly mime: string;
  readonly size: number;
}

export interface RoomKitSubject {
  readonly packId: string;
  readonly id: string;
  readonly kind: SubjectKind;
  readonly name: KitText;
  readonly prompt: string;
  /** The reference picture; null when the kit names none or the pack does not ship it. */
  readonly reference: KitAsset | null;
}

export interface RoomKitCue {
  readonly packId: string;
  readonly id: string;
  readonly layer: AudioLayer;
  readonly title: string;
  readonly asset: KitAsset;
}

export interface RoomKit {
  readonly subjects: readonly RoomKitSubject[];
  readonly cues: readonly RoomKitCue[];
  /** One style line per contributing pack, in the room's language. */
  readonly style: readonly string[];
  readonly banned: readonly string[];
  readonly palette: readonly string[];
  /** Null: no pack restricts; otherwise the intersection, which may honestly be empty. */
  readonly templates: readonly TemplateKind[] | null;
  /** False when any contributing pack said `pack_only`. */
  readonly generates: boolean;
}

export const EMPTY_ROOM_KIT: RoomKit = Object.freeze({
  subjects: Object.freeze([]),
  cues: Object.freeze([]),
  style: Object.freeze([]),
  banned: Object.freeze([]),
  palette: Object.freeze([]),
  templates: null,
  generates: true,
});

/** One enabled pack's kit and the pack files it can resolve, by pack-relative path. */
export interface InstalledKit {
  readonly packId: string;
  readonly kit: PresentationKit;
  readonly assets: ReadonlyMap<string, KitAsset>;
}

export type KitMergeProblem =
  | { readonly code: "too_many_kits"; readonly packId: string }
  /** A cue whose sound the pack does not ship: dropped. */
  | { readonly code: "cue_asset_missing"; readonly packId: string; readonly id: string }
  /** A subject or cue id an earlier pack already declared: the first one stands. */
  | { readonly code: "duplicate_id"; readonly packId: string; readonly id: string };

/** Every enabled pack's kit merged for one room, in the order the packs are given. */
export function mergeRoomKit(installed: readonly InstalledKit[], locale: string): { readonly kit: RoomKit; readonly problems: readonly KitMergeProblem[] } {
  const problems: KitMergeProblem[] = [];
  const subjects: RoomKitSubject[] = [];
  const cues: RoomKitCue[] = [];
  const style: string[] = [];
  const banned: string[] = [];
  const palette: string[] = [];
  let templates: TemplateKind[] | null = null;
  let generates = true;
  for (const [index, entry] of installed.entries()) {
    if (index >= MAX_ROOM_KITS) {
      problems.push({ code: "too_many_kits", packId: entry.packId });
      continue;
    }
    const { kit, packId, assets } = entry;
    generates = generates && kit.generation === "allow";
    if (kit.templates.length > 0) templates = templates === null ? [...kit.templates] : templates.filter((kind) => kit.templates.includes(kind));
    if (kit.style.keywords !== null) {
      const line = kitTextFor(kit.style.keywords, locale);
      if (line !== "") style.push(line);
    }
    for (const item of kit.style.banned) if (!banned.includes(item)) banned.push(item);
    for (const item of kit.style.palette) if (!palette.includes(item)) palette.push(item);
    for (const subject of kit.subjects) {
      if (subjects.some((known) => known.id === subject.id)) {
        problems.push({ code: "duplicate_id", packId, id: subject.id });
        continue;
      }
      const reference = subject.ref === null ? null : (assets.get(subject.ref) ?? null);
      subjects.push({ packId, id: subject.id, kind: subject.kind, name: subject.name, prompt: subject.prompt, reference });
    }
    for (const cue of kit.audio) {
      const asset = assets.get(cue.asset);
      if (asset === undefined) {
        problems.push({ code: "cue_asset_missing", packId, id: cue.id });
        continue;
      }
      if (cues.some((known) => known.id === cue.id)) {
        problems.push({ code: "duplicate_id", packId, id: cue.id });
        continue;
      }
      cues.push({ packId, id: cue.id, layer: cue.layer, title: cue.title, asset });
    }
  }
  return { kit: { subjects, cues, style, banned, palette, templates, generates }, problems };
}

/** Whether a room with this kit has anything authored to stage. */
export function kitHasContent(kit: RoomKit): boolean {
  return kit.subjects.length > 0 || kit.cues.length > 0 || kit.style.length > 0;
}

export function allowsTemplate(kit: RoomKit, kind: TemplateKind): boolean {
  return kit.templates === null || kit.templates.includes(kind);
}

/** Generation is licensed at all: no `pack_only` veto, and `image` is an allowed shape. */
export function kitGeneratesImages(kit: RoomKit): boolean {
  return kit.generates && allowsTemplate(kit, "image");
}

export function kitSubject(kit: RoomKit, id: string): RoomKitSubject | undefined {
  return kit.subjects.find((subject) => subject.id === id);
}

export function kitCue(kit: RoomKit, id: string): RoomKitCue | undefined {
  return kit.cues.find((cue) => cue.id === id);
}
