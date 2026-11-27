// The Stage Director: on a beat the Scribe named, it dresses the scene for the players —
// declarative blocks (a letter, a clipping, a title card, a picture), audio cues, at most
// one picture. It runs after the turn, outside the room's turn lock, and the table never
// waits for it.
//
// It is a PLAYER-SIDE actor (iron rule 3): everything it emits lands on the players'
// screens, so it may read only what the table has already seen. That is structural here,
// not a habit. `computeDirector` takes no `Services`, no store, no stored documents: its
// input is the player's line and the Keeper's reply (both already broadcast), the room's
// `DocumentViews` together with the room's LANGUAGE — the viewer is built inside, at
// player grade, so there is no parameter through which a Keeper-grade view could arrive —
// the presentation kit, and the beat as an enum value. The Scribe has read Keeper-grade
// data, so nothing it WROTE ever reaches this file; only which kind of moment it saw.
// `test/agent/lanes/director.test.ts` plants markers in every Keeper-only field and checks
// the prompt.
//
// The pass is three steps, so the model call and the network sit outside the commit:
// 1. `computeDirector` — the model call (lane `director`), its reply validated against the
//    kit: blocks only in shapes the kit allows (at most `MAX_BLOCKS`), cues only ones it
//    declares (at most `MAX_AUDIO_CUES`), and an image PLAN (generate, serve a picture
//    made before, show the subject's reference, or nothing — with the reason).
// 2. `renderDirectorImage` — carries out a `generate` plan through injected functions (the
//    image client, the reference reader, the media store). Outbound network; the caller
//    may skip it.
// 3. `commitDirector` — one synchronous block through the writer of the turn the pass was
//    scheduled on: the `blocks` event (stamped with that turn), the image budget and the
//    picture larder, and each audio cue through `applyAudio` (the room's audio state moves
//    with the signal). It returns the event and the audio signals for the caller to
//    publish. A room rewound, reset or replaced since makes it return `stale`, writing
//    nothing.
//
// Pre-generation (warming pictures likely to be wanted soon) is returned as validated
// hints; running them is the caller's, and `commitWarmedImage` books one that finished.
import type { Block, SignalPayloads } from "loreweaver-protocol/v3";
import { charCount } from "loreweaver-protocol/v3";

import { playerViewer, type Viewer } from "../../core/documents/model.ts";
import type { DocumentViews } from "../../core/documents/views.ts";
import { SCENE_ID, SCENE_TYPE, type SceneView } from "../../core/notes/scene.ts";
import { MODULE_VARIABLES_ID, MODULE_VARIABLES_TYPE, type ModuleVariablesView, VARIABLE_TREE_ID, VARIABLE_TREE_TYPE, type VariableTreeView } from "../../core/variables/documents.ts";
import { applyAudio, cueSoundId, isStateful, readPlaying } from "../../core/audio/index.ts";
import type { Clock } from "../../infra/ids.ts";
import { defineStateKey, jsonStateKey } from "../../infra/lifecycle/declarations.ts";
import { StaleGeneration } from "../../infra/lifecycle/errors.ts";
import { type ChatResult, type LLMClient, LLMError, withLane } from "../../infra/llm/index.ts";
import type { StoredEvent, Store } from "../../infra/store.ts";
import type { RoomContext } from "../context.ts";
import {
  allowsTemplate,
  kitCue,
  kitGeneratesImages,
  kitHasContent,
  kitSubject,
  kitTextFor,
  type KitAsset,
  type RoomKit,
  type RoomKitCue,
  type RoomKitSubject,
  type TemplateKind,
} from "./presentation.ts";

export const DIRECTOR_LANE = "director";

/** The Scribe's vocabulary of moments worth staging. Most turns are none of them. */
export const BEATS = ["scene_change", "act_transition", "handout", "spike"] as const;
export type Beat = (typeof BEATS)[number];

export function isBeat(value: unknown): value is Beat {
  return typeof value === "string" && (BEATS as readonly string[]).includes(value);
}

export const MAX_BLOCKS = 6;
export const MAX_AUDIO_CUES = 2;
/** The player's line and the reply, as the 2.6 Director sliced them (here: code points). */
export const MAX_TURN_TEXT_CHARS = 4_000;
/** The Director's own description of a picture. */
export const MAX_IMAGE_PROMPT_CHARS = 600;
/** A block's long text (a letter's or clipping's body). */
export const MAX_BLOCK_BODY_CHARS = 2_000;
/** A block's short text (a title, a sender, a date, a caption line). */
export const MAX_BLOCK_LINE_CHARS = 200;
/** How many player-visible variables the prompt lists. */
export const MAX_PROMPT_VARIABLES = 64;
/** How many pictures the larder remembers. */
export const MAX_LARDER = 64;

// ---------------------------------------------------------------------------
// Prompt — the 2.6 text, verbatim (`agent/stage_director.py`). Text for the model:
// English, and it lives with the code that sends it. Fields are filled the way Python's
// `str.format` fills them (`{{`/`}}` are literal braces).
// ---------------------------------------------------------------------------

const PROMPT = `You are the Stage Director for a tabletop RPG table — the person who decides what the players SEE and HEAR, never what happens.

A beat just landed: {beat}. Dress it. Output ONLY a JSON object:
{{"blocks": [<block>...], "audio": [{{"cue": "<cue id>", "action": "play"|"stop"}}], "image": {{"subject": "<subject id>", "prompt": "<what this picture shows>"}} | null, "prepare": ["<subject id>"...]}}

Block templates (pick what the moment deserves; 0-{max_blocks} blocks, often 1):
{templates}

Rules:
- You never narrate, never roll, never decide outcomes, never speak as a character. You choose a FORM and fill it from what the table has already seen.
- Write in the language the turn is written in. Match the module's period and register; a 1925 newspaper does not sound like a modern one.
- Emit nothing rather than something generic. An empty "blocks" list is a fine answer for a beat that needs only music.
- "audio": only cue ids listed below. "image": at most one, subject id from the list below, and its prompt must describe ONLY what players have already seen or could plainly see now.
- "prepare": subject ids you expect to want a picture of within the next scene or two (0-{pregen} of them). They are generated quietly in advance; naming one costs nothing now.
{image_rule}
Style guide (every generated image inherits it): {style}
Palette (the colors this module dresses in): {palette}
Never depict: {banned}

Picturable subjects (id | kind | name):
{subjects}

Audio cues (id | layer | title):
{cues}

Player-visible trackers right now:
{trackers}
Scene: {scene}

--- THE TURN (everything below is what the players themselves saw) ---
Player: {player}
Keeper: {reply}
--- END ---

JSON only.`;

const BLOCK_TEMPLATES: readonly (readonly [Exclude<TemplateKind, "image">, string])[] = [
  ["title_card", '- {"kind": "title_card", "title": "...", "subtitle": "...", "act": "..."} — an act/day/chapter turning over.'],
  ["letter", '- {"kind": "letter", "body": "...", "from": "...", "to": "...", "date": "..."} — a letter, note or diary page the players now hold.'],
  ["clipping", '- {"kind": "clipping", "headline": "...", "body": "...", "source": "...", "date": "..."} — a newspaper or official document.'],
  ["text", '- {"kind": "text", "text": "...", "style": "quote"} — a caption line when nothing heavier fits.'],
];
const NO_TEMPLATES_NOTE = "(none — this module stages with audio and pictures only; leave blocks empty)";
const NO_REF_NOTE = " (no reference image — may be named, never generated)";
const RULE_NO_GENERATION = '- This module allows NO image generation (the author\'s choice): leave "image" null and "prepare" empty.';
const RULE_GENERATION = "- Ask for an image only when a picture genuinely says more than the words did. Most beats do not need one.";

function format(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{\{|\}\}|\{([a-z_]+)\}/g, (match, name: string | undefined) => {
    if (match === "{{") return "{";
    if (match === "}}") return "}";
    const value = name === undefined ? undefined : values[name];
    if (value === undefined) throw new Error(`director prompt: no value for ${match}`);
    return String(value);
  });
}

function slice(text: string, max: number): string {
  return charCount(text) <= max ? text : Array.from(text).slice(0, max).join("");
}

// ---------------------------------------------------------------------------
// Room state: the image budget and the picture larder
// ---------------------------------------------------------------------------

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** How many pictures this story has paid for. */
export const IMAGES_SPENT_KEY = defineStateKey<number>({
  name: "director.images_spent",
  // Owner verdict 2026-08-14 (2.6 `director_images` facet): "how many images did this
  // story cost" is a question about THIS story.
  lifecycle: { reset: "story" },
  encode: (value) => String(value),
  decode: (text) => {
    const value = /^\d{1,15}$/.test(text) ? Number(text) : Number.NaN;
    return isCount(value) ? value : null;
  },
});

export type LarderEntry = readonly [subject: string, asset: KitAsset];

function isAsset(value: unknown): value is KitAsset {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.hash === "string" && typeof record.mime === "string" && isCount(record.size);
}

function isLarder(value: unknown): value is LarderEntry[] {
  return Array.isArray(value) && value.length <= MAX_LARDER && value.every((entry) => Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string" && isAsset(entry[1]));
}

/**
 * Pictures already made, by subject id, oldest first — served again instead of generating.
 * Story lifecycle: keyed by subject id, so a new story reusing a name would otherwise
 * inherit the old story's portrait of it (2.6 owner verdict 2026-08-14).
 */
export const LARDER_KEY = jsonStateKey<LarderEntry[]>("director.larder", { reset: "story" }, isLarder);

/** The room's picture bookkeeping, as the caller reads it when it schedules the pass. */
export interface DirectorImageState {
  readonly spent: number;
  readonly larder: ReadonlyMap<string, KitAsset>;
}

export function readDirectorImageState(store: Store, room: string): DirectorImageState {
  return { spent: store.stateGet(room, IMAGES_SPENT_KEY) ?? 0, larder: new Map(store.stateGet(room, LARDER_KEY) ?? []) };
}

// ---------------------------------------------------------------------------
// Compute
// ---------------------------------------------------------------------------

export interface DirectorSettings {
  /** False when the deployment has image generation off or no image provider. */
  readonly imagesEnabled: boolean;
  /** Pictures one story may generate. */
  readonly maxImages: number;
  /** How many likely-next subjects one beat may ask to warm. */
  readonly pregenPerBeat: number;
}

/**
 * Everything the Director may know. Note what is NOT here: no services, no store, no
 * stored document, no viewer. `views` is projected inside, for a player of `locale`.
 */
export interface DirectorInput {
  readonly room: string;
  readonly locale: string;
  readonly beat: Beat;
  /** What the player said — already broadcast. */
  readonly player: string;
  /** The Keeper's reply — already broadcast. */
  readonly reply: string;
  readonly views: DocumentViews;
  readonly kit: RoomKit;
  readonly images: DirectorImageState;
  readonly settings: DirectorSettings;
}

/** Why a beat did or did not get a picture — for the operator's log. */
export type ImageOutcome =
  /** The Director asked for none. */
  | "none"
  /** The kit's allowed shapes exclude `image`. */
  | "template_denied"
  /** The subject is not one the kit declares. */
  | "unknown_subject"
  /** Images are off for this deployment (or no provider). */
  | "images_off"
  /** The author's `pack_only` veto. */
  | "pack_only"
  /** The subject has no reference picture. */
  | "ref_missing"
  /** The story's image budget is spent. */
  | "budget"
  /** Served from the larder. */
  | "larder"
  /** To be generated. */
  | "generate";

export type ImagePlan =
  | { readonly kind: "none"; readonly outcome: ImageOutcome }
  /** Show a stored picture: one made before, or the subject's own reference. */
  | { readonly kind: "show"; readonly subject: RoomKitSubject; readonly asset: KitAsset; readonly outcome: ImageOutcome }
  /** Generate; `reference` is what to show if generation fails. */
  | { readonly kind: "generate"; readonly subject: RoomKitSubject; readonly prompt: string; readonly reference: KitAsset };

export interface AudioCueRequest {
  readonly cue: RoomKitCue;
  readonly action: "play" | "stop";
}

export type DirectorStatus = "ok" | "no_kit" | "empty_reply" | "model_failed" | "aborted" | "unparsed";

export interface DirectorDropped {
  /** Blocks in a shape the kit does not allow, or malformed. */
  readonly blocks: number;
  /** Cues the kit does not declare, or malformed. */
  readonly audio: number;
  /** Warm hints that cannot be generated (unknown, no reference, already made, over budget). */
  readonly prepare: number;
}

export interface DirectorProposal {
  readonly status: DirectorStatus;
  readonly beat: Beat;
  readonly locale: string;
  /** Staging blocks other than the picture, validated. */
  readonly blocks: readonly Block[];
  readonly audio: readonly AudioCueRequest[];
  readonly image: ImagePlan;
  /** Subjects worth warming in the background, validated. */
  readonly prepare: readonly RoomKitSubject[];
  readonly dropped: DirectorDropped;
}

const NOTHING: DirectorDropped = { blocks: 0, audio: 0, prepare: 0 };

function quiet(input: DirectorInput, status: DirectorStatus): DirectorProposal {
  return { status, beat: input.beat, locale: input.locale, blocks: [], audio: [], image: { kind: "none", outcome: "none" }, prepare: [], dropped: NOTHING };
}

/** The player-visible state of the room, read through the PLAYER projection only. */
function playerContext(views: DocumentViews, room: string, viewer: Viewer): { trackers: string; scene: string } {
  const lines: string[] = [];
  const variables = views.view(room, MODULE_VARIABLES_TYPE, MODULE_VARIABLES_ID, viewer) as ModuleVariablesView | null;
  for (const variable of variables?.variables ?? []) lines.push(`- ${variable.label}: ${variable.valueLabel ?? String(variable.value)}`);
  const tree = views.view(room, VARIABLE_TREE_TYPE, VARIABLE_TREE_ID, viewer) as VariableTreeView | null;
  for (const leaf of tree?.leaves ?? []) lines.push(`- ${leaf.path}: ${JSON.stringify(leaf.value)}`);
  const scene = views.view(room, SCENE_TYPE, SCENE_ID, viewer) as SceneView | null;
  const sceneLine = [scene?.name ?? "", scene?.focus ?? ""].filter((part) => part !== "").join(" · ");
  return { trackers: lines.slice(0, MAX_PROMPT_VARIABLES).join("\n") || "(none)", scene: sceneLine || "(unset)" };
}

function buildPrompt(input: DirectorInput, viewer: Viewer): string {
  const { kit } = input;
  const generates = kitGeneratesImages(kit);
  const subjects = kit.subjects.map((subject) => `- ${subject.id} | ${subject.kind} | ${kitTextFor(subject.name, input.locale)}${subject.reference === null ? NO_REF_NOTE : ""}`);
  const cues = kit.cues.map((cue) => `- ${cue.id} | ${cue.layer} | ${cue.title || cue.id}`);
  const templates = BLOCK_TEMPLATES.filter(([kind]) => allowsTemplate(kit, kind)).map(([, line]) => line);
  const { trackers, scene } = playerContext(input.views, input.room, viewer);
  return format(PROMPT, {
    beat: input.beat,
    max_blocks: MAX_BLOCKS,
    // 2.6 passed MAX_AUDIO_CUES here (a slip); the setting is what the hints are capped by.
    pregen: generates ? Math.max(0, input.settings.pregenPerBeat) : 0,
    image_rule: generates ? RULE_GENERATION : RULE_NO_GENERATION,
    templates: templates.join("\n") || NO_TEMPLATES_NOTE,
    style: kit.style.join(" / ") || "(none declared)",
    palette: kit.palette.join(", ") || "(none declared)",
    banned: kit.banned.join(", ") || "(nothing declared)",
    subjects: subjects.join("\n") || "(none)",
    cues: cues.join("\n") || "(none)",
    trackers,
    scene,
    player: slice(input.player, MAX_TURN_TEXT_CHARS),
    reply: slice(input.reply, MAX_TURN_TEXT_CHARS),
  });
}

function extractJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function own(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** A required text field within `max`, or null. */
function required(record: Record<string, unknown>, key: string, max: number): string | null {
  const value = own(record, key);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed !== "" && charCount(trimmed) <= max ? trimmed : null;
}

/** An optional text field: absent/empty → undefined; present but invalid → null. */
function optional(record: Record<string, unknown>, key: string, max: number): string | undefined | null {
  const value = own(record, key);
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  return charCount(trimmed) <= max ? trimmed : null;
}

/** One block the model wrote, as a protocol `Block` in an allowed shape, or null. */
export function validateStageBlock(raw: unknown, kit: RoomKit): Block | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const kind = own(record, "kind");
  const extras = (keys: readonly string[]): { [key: string]: string } | null => {
    const out: { [key: string]: string } = {};
    for (const key of keys) {
      const value = optional(record, key, MAX_BLOCK_LINE_CHARS);
      if (value === null) return null;
      if (value !== undefined) out[key] = value;
    }
    return out;
  };
  switch (kind) {
    case "title_card": {
      if (!allowsTemplate(kit, kind)) return null;
      const title = required(record, "title", MAX_BLOCK_LINE_CHARS);
      const rest = extras(["subtitle", "act"]);
      return title === null || rest === null ? null : { kind, title, ...rest };
    }
    case "letter": {
      if (!allowsTemplate(kit, kind)) return null;
      const body = required(record, "body", MAX_BLOCK_BODY_CHARS);
      const rest = extras(["from", "to", "date"]);
      return body === null || rest === null ? null : { kind, body, ...rest };
    }
    case "clipping": {
      if (!allowsTemplate(kit, kind)) return null;
      const headline = required(record, "headline", MAX_BLOCK_LINE_CHARS);
      const body = required(record, "body", MAX_BLOCK_BODY_CHARS);
      const rest = extras(["source", "date"]);
      return headline === null || body === null || rest === null ? null : { kind, headline, body, ...rest };
    }
    case "text": {
      if (!allowsTemplate(kit, kind)) return null;
      const text = required(record, "text", MAX_BLOCK_BODY_CHARS);
      const style = own(record, "style");
      if (text === null || (style !== undefined && style !== null && style !== "quote" && style !== "warning")) return null;
      return style === "quote" || style === "warning" ? { kind, text, style } : { kind, text };
    }
    default:
      // Pictures come only through the image plan, never as a block the model wrote: a
      // hash the model invents names no stored file, or worse, someone else's.
      return null;
  }
}

function planImage(raw: unknown, input: DirectorInput): ImagePlan {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { kind: "none", outcome: "none" };
  const record = raw as Record<string, unknown>;
  const subjectId = own(record, "subject");
  if (typeof subjectId !== "string" || subjectId === "") return { kind: "none", outcome: "none" };
  const { kit, images, settings } = input;
  if (!allowsTemplate(kit, "image")) return { kind: "none", outcome: "template_denied" };
  const subject = kitSubject(kit, subjectId);
  if (subject === undefined) return { kind: "none", outcome: "unknown_subject" };
  const made = images.larder.get(subject.id);
  if (made !== undefined) return { kind: "show", subject, asset: made, outcome: "larder" };
  // Generation declined for any of these reasons still shows the author's own picture of
  // the subject when the kit ships one: it is the very image generation would follow.
  const decline = (outcome: ImageOutcome): ImagePlan =>
    subject.reference === null ? { kind: "none", outcome } : { kind: "show", subject, asset: subject.reference, outcome };
  if (!settings.imagesEnabled) return decline("images_off");
  if (!kit.generates) return decline("pack_only");
  if (subject.reference === null) return { kind: "none", outcome: "ref_missing" };
  if (images.spent >= Math.max(0, settings.maxImages)) return decline("budget");
  const described = own(record, "prompt");
  const words = typeof described === "string" ? slice(described.trim(), MAX_IMAGE_PROMPT_CHARS) : "";
  return { kind: "generate", subject, prompt: imagePrompt(subject, words, kit), reference: subject.reference };
}

/** The whole generation prompt: the subject, the Director's words, and the kit's style. */
export function imagePrompt(subject: RoomKitSubject, described: string, kit: RoomKit): string {
  return [
    subject.prompt,
    described,
    kit.style.join(" / "),
    kit.palette.length > 0 ? `palette: ${kit.palette.join(", ")}` : "",
    kit.banned.length > 0 ? `avoid: ${kit.banned.join(", ")}` : "",
  ]
    .filter((part) => part !== "")
    .join(". ");
}

/**
 * The model call and its validation. Never throws for the model's sake: a failed call, an
 * abort or an unreadable reply is a status with nothing to stage.
 */
export async function computeDirector(input: DirectorInput, llm: LLMClient, signal?: AbortSignal): Promise<DirectorProposal> {
  if (input.reply.trim() === "") return quiet(input, "empty_reply");
  if (!kitHasContent(input.kit)) return quiet(input, "no_kit");
  const viewer = playerViewer(input.locale);
  const prompt = buildPrompt(input, viewer);
  let result: ChatResult;
  try {
    result = await withLane(DIRECTOR_LANE, () => llm.chat([{ role: "user", content: prompt }], signal === undefined ? {} : { signal }), { room: input.room });
  } catch (error) {
    if (signal?.aborted === true || (error instanceof LLMError && error.code === "aborted")) return quiet(input, "aborted");
    return quiet(input, "model_failed");
  }
  const parsed = extractJson(result.content);
  if (parsed === null) return quiet(input, "unparsed");

  const { kit } = input;
  let droppedBlocks = 0;
  const blocks: Block[] = [];
  const rawBlocks = own(parsed, "blocks");
  for (const raw of Array.isArray(rawBlocks) ? rawBlocks : []) {
    const block = blocks.length < MAX_BLOCKS ? validateStageBlock(raw, kit) : null;
    if (block === null) droppedBlocks += 1;
    else blocks.push(block);
  }

  let droppedAudio = 0;
  const audio: AudioCueRequest[] = [];
  const rawAudio = own(parsed, "audio");
  for (const raw of Array.isArray(rawAudio) ? rawAudio : []) {
    const record = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
    const cueId = record === null ? undefined : own(record, "cue");
    const actionRaw = record === null ? undefined : own(record, "action");
    const action = actionRaw === undefined ? "play" : actionRaw;
    const cue = typeof cueId === "string" ? kitCue(kit, cueId) : undefined;
    if (audio.length >= MAX_AUDIO_CUES || cue === undefined || (action !== "play" && action !== "stop")) {
      droppedAudio += 1;
      continue;
    }
    audio.push({ cue, action });
  }

  const image = planImage(own(parsed, "image"), input);

  let droppedPrepare = 0;
  const prepare: RoomKitSubject[] = [];
  const rawPrepare = own(parsed, "prepare");
  const pending = image.kind === "generate" ? 1 : 0;
  for (const raw of Array.isArray(rawPrepare) ? rawPrepare : []) {
    const subject = typeof raw === "string" ? kitSubject(kit, raw) : undefined;
    const fits =
      subject !== undefined &&
      input.settings.imagesEnabled &&
      kitGeneratesImages(kit) &&
      subject.reference !== null &&
      !input.images.larder.has(subject.id) &&
      !prepare.includes(subject) &&
      !(image.kind === "generate" && image.subject.id === subject.id) &&
      prepare.length < Math.max(0, input.settings.pregenPerBeat) &&
      input.images.spent + pending + prepare.length < Math.max(0, input.settings.maxImages);
    if (fits) prepare.push(subject);
    else droppedPrepare += 1;
  }

  return {
    status: "ok",
    beat: input.beat,
    locale: input.locale,
    blocks,
    audio,
    image,
    prepare,
    dropped: { blocks: droppedBlocks, audio: droppedAudio, prepare: droppedPrepare },
  };
}

// ---------------------------------------------------------------------------
// Render (outbound network; outside the commit)
// ---------------------------------------------------------------------------

export interface DirectorImageDeps {
  /** The image client (`infra/imagegen`), already bound to its settings. */
  readonly generate: (request: { prompt: string; reference: { bytes: Uint8Array; mime: string } }, signal?: AbortSignal) => Promise<{ bytes: Uint8Array; mime: string }>;
  /** A stored asset's bytes, or null when they cannot be read. */
  readonly readAsset: (asset: KitAsset) => Promise<Uint8Array | null>;
  /** Put a generated picture into the room's media; null when the store refused it. */
  readonly storeImage: (bytes: Uint8Array, mime: string, name: string) => Promise<KitAsset | null>;
}

export type RenderedImage =
  | { readonly status: "generated"; readonly subject: RoomKitSubject; readonly asset: KitAsset }
  /** Generation failed; the subject's reference is shown instead. */
  | { readonly status: "fallback"; readonly subject: RoomKitSubject; readonly asset: KitAsset; readonly code: string };

/** Carry out a `generate` plan. Never throws: a dead provider costs the table nothing. */
export async function renderDirectorImage(plan: Extract<ImagePlan, { kind: "generate" }>, deps: DirectorImageDeps, signal?: AbortSignal): Promise<RenderedImage> {
  const fallback = (code: string): RenderedImage => ({ status: "fallback", subject: plan.subject, asset: plan.reference, code });
  try {
    const reference = await deps.readAsset(plan.reference);
    if (reference === null) return fallback("reference_unreadable");
    const image = await deps.generate({ prompt: plan.prompt, reference: { bytes: reference, mime: plan.reference.mime } }, signal);
    const stored = await deps.storeImage(image.bytes, image.mime, `${plan.subject.id}.${image.mime.slice("image/".length)}`);
    return stored === null ? fallback("store_refused") : { status: "generated", subject: plan.subject, asset: stored };
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "failed";
    return fallback(code);
  }
}

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

export interface DirectorCommitDeps {
  readonly clock: Clock;
}

export type DirectorCommit =
  | {
      readonly status: "committed";
      /** The `blocks` event, logged under the scheduled turn; null when nothing was staged. */
      readonly event: StoredEvent | null;
      /** Audio intents for the caller to send (signals are never logged). */
      readonly audio: readonly SignalPayloads["audio"][];
      /** Whether a newly generated picture was booked against the budget. */
      readonly spent: boolean;
    }
  | { readonly status: "stale" };

function imageBlock(subject: RoomKitSubject, asset: KitAsset, locale: string): Block {
  const caption = kitTextFor(subject.name, locale);
  return { kind: "image", hash: asset.hash, mime: asset.mime, size: asset.size, ...(caption === "" ? {} : { caption }) };
}

function bookImage(context: RoomContext, subject: string, asset: KitAsset): void {
  const { store } = context.services;
  const spent = store.stateGet(context.room, IMAGES_SPENT_KEY) ?? 0;
  context.writer.statePut(IMAGES_SPENT_KEY, spent + 1);
  const larder = (store.stateGet(context.room, LARDER_KEY) ?? []).filter(([known]) => known !== subject);
  larder.push([subject, asset]);
  context.writer.statePut(LARDER_KEY, larder.slice(Math.max(0, larder.length - MAX_LARDER)));
}

/**
 * Commit one staged beat through the context it was SCHEDULED with, in one synchronous
 * block. `image` is what `renderDirectorImage` produced for a `generate` plan (null when
 * the caller did not render it; a `show` plan needs nothing).
 */
export function commitDirector(context: RoomContext, proposal: DirectorProposal, image: RenderedImage | null, deps: DirectorCommitDeps): DirectorCommit {
  const blocks: Block[] = [];
  let spent = false;
  if (proposal.image.kind === "show") blocks.push(imageBlock(proposal.image.subject, proposal.image.asset, proposal.locale));
  else if (proposal.image.kind === "generate" && image !== null) blocks.push(imageBlock(image.subject, image.asset, proposal.locale));
  blocks.push(...proposal.blocks);
  try {
    return context.services.store.transaction(() => {
      if (!context.writer.current()) throw new StaleGeneration(context.room, context.writer.epoch, context.services.store.room(context.room).epoch);
      if (proposal.image.kind === "generate" && image?.status === "generated") {
        bookImage(context, image.subject.id, image.asset);
        spent = true;
      }
      const event =
        blocks.length === 0
          ? null
          : context.writer.appendEvent({ id: deps.clock.id(), ts: deps.clock.now(), kind: "blocks", turn: context.turn, data: { blocks } });
      // Through the one function every audio source uses: the room's state moves with the
      // signal, under this turn's writer, so the `audio` view shows what the Director put on.
      const audio: SignalPayloads["audio"][] = [];
      for (const { cue, action } of proposal.audio) {
        const sound = { id: cueSoundId(cue.packId, cue.id), hash: cue.asset.hash, mime: cue.asset.mime, size: cue.asset.size, title: cue.title === "" ? cue.id : cue.title };
        // A cue's `stop` stops that cue, never whatever else the layer plays now (the admin's music).
        if (action === "stop" && isStateful(cue.layer) && readPlaying(context.services.store, context.room)[cue.layer]?.sound.id !== sound.id) continue;
        const applied = applyAudio(context.writer, context.services.store, action === "play" ? { action, layer: cue.layer, sound } : { action, layer: cue.layer }, deps.clock.id());
        if (applied.ok) audio.push(applied.signal);
      }
      return { status: "committed" as const, event, audio, spent };
    });
  } catch (error) {
    if (error instanceof StaleGeneration) return { status: "stale" };
    throw error;
  }
}

/** Book a warmed picture: budget and larder, under the turn the warm was scheduled on. */
export function commitWarmedImage(context: RoomContext, subject: RoomKitSubject, asset: KitAsset): "committed" | "stale" {
  try {
    context.services.store.transaction(() => bookImage(context, subject.id, asset));
    return "committed";
  } catch (error) {
    if (error instanceof StaleGeneration) return "stale";
    throw error;
  }
}
