// Applying what a module asked for. `agent/modules.ts` validates and caps a worker's
// answer; this file COMMITS a validated outcome to a room, in one synchronous block, and
// hands back the events the caller is to publish. It publishes nothing itself.
//
// What each effect becomes (§12 3.2 steps 2 and 13):
//   - a variable write: through `core/variables`, as a `_.set` on the room's variable tree,
//     or a typed write when the path names a declared module variable (the same order a
//     read resolves names: module variables first, then the tree). A refused write is
//     reported with its code, never thrown. Every applied write is also recorded in the
//     turn's "written by content" set (`CONTENT_WRITES`), which the Scribe reads so it never
//     credits machinery writes to the Keeper's narration;
//   - a fact: a `table` fact's text becomes a `system` narrative event, after the output
//     review the caller passes in (the gateway's `reviewFact`; this layer cannot import the
//     gateway, so the review arrives as a function). A `keeper` fact, and every fact's data,
//     go to the pending-facts list the Keeper's next prompt reads (`PENDING_FACTS`). A fact
//     marked `narrateNow` raises the narrate-now flag (see below);
//   - blocks: each block is checked against the protocol's `Block` union and rebuilt from
//     its named fields; an unknown kind or a malformed block is dropped and reported. A
//     block's free text passes the same review as a fact. An emission with an id becomes a
//     replacing `blocks` event under a stable event id;
//   - a roll: a `dice` event;
//   - prompt injections (turn start): written to the per-turn record `TURN_INJECTIONS`, so
//     what reached the model can be reconstructed.
//
// Narrate now (decision 35, and ruling 2 at the top of §12): a fact may ask the engine to
// open a Keeper turn over the pending facts. At most one such turn opens per player action
// (a line or a command); a fact marked INSIDE that turn waits for the next one, so it
// cannot recurse; a room setting switches it off. `markNarrateNow` and `decideNarrateNow`
// are the pure rule; `NARRATE_NOW` is its state and `NARRATE_NOW_SETTING` the room switch.
//
// A writer that is no longer current (the room was undone, reset or replaced while the
// exchange was out) applies nothing: the whole outcome is reported as stale.
import { type Block, type BlocksData, charCount, type DiceData, type NarrativeData } from "loreweaver-protocol/v3";
import type { Json } from "loreweaver/module";

import { DocumentRefused } from "../core/documents/raw.ts";
import {
  applyUpdates,
  MODULE_VARIABLES_ID,
  MODULE_VARIABLES_TYPE,
  moduleVariablesPayload,
  normalizeModuleVariables,
  normalizeVariableId,
  readVariableTree,
  setVariable,
  VARIABLE_TREE_ID,
  VARIABLE_TREE_TYPE,
  variableTreeData,
  type Json as VariableJson,
  type ModuleVariables,
  type VarMap,
  type WriteRefusalCode,
} from "../core/variables/index.ts";
import { jsonStateKey, type StateKey } from "../infra/lifecycle/declarations.ts";
import type { Store } from "../infra/store.ts";
import type { RoomContext } from "./context.ts";
import type { Applied, BlocksRequest, FactRequest } from "./modules.ts";

// ---------------------------------------------------------------- caps

/** Facts waiting for the Keeper's next prompt; past this a new one is refused and reported. */
export const MAX_PENDING_FACTS = 64;
/** Turns whose prompt injections are kept (at least the undo window). */
export const MAX_INJECTION_TURNS = 8;
/** Injections per turn in the record (the module caps allow 8). */
export const MAX_RECORDED_INJECTIONS = 32;
/** Writes recorded in one turn's "written by content" set. */
export const MAX_CONTENT_WRITES = 256;
export const MAX_WRITE_PATH_CHARS = 200;
export const MAX_WRITER_CHARS = 64;
export const MAX_ACTION_CHARS = 200;
/** Text fields of a block, in code points. */
export const MAX_BLOCK_TEXT_CHARS = 8_000;
/** Labels, captions, names, ids inside a block. */
export const MAX_BLOCK_LABEL_CHARS = 200;
export const MAX_BLOCK_CHOICES = 16;
export const MAX_BLOCKS_PER_EVENT = 32;
export const MAX_FACT_CHARS = 2_000;
export const MAX_INJECTION_CHARS = 4_000;

// ---------------------------------------------------------------- shapes

/** A request to write a room variable: by a module (its id) or by a template (`template`). */
export interface ContentWrite {
  readonly path: string;
  readonly value: Json;
  readonly by: string;
}

export type ContentWriteRefusal =
  | WriteRefusalCode
  /** The stored document is unreadable: writing over it would destroy it. */
  | "corrupt_document"
  /** The document type refused the result (e.g. the tree grew past its bound). */
  | "document_refused";

export interface AppliedWrite {
  readonly path: string;
  readonly by: string;
  readonly target: "tree" | "module_variable";
  readonly old: VariableJson;
  readonly value: VariableJson;
}

export interface RefusedWrite {
  readonly path: string;
  readonly by: string;
  readonly code: ContentWriteRefusal;
}

export interface WriteCommit {
  readonly applied: readonly AppliedWrite[];
  readonly refused: readonly RefusedWrite[];
}

export type EffectProblemCode =
  /** The writer is no longer current: nothing was applied. */
  | "stale_writer"
  | "write_refused"
  /** A block of an unknown kind. */
  | "block_unknown_kind"
  /** A block missing a field, with a field of the wrong type or over its cap. */
  | "block_malformed"
  /** An emission with more blocks than one event carries. */
  | "blocks_too_many"
  /** The output review blocked a fact's or a block's text. */
  | "review_blocked"
  /** The pending-facts list is full. */
  | "pending_full"
  /** The injection record refused an injection over its cap. */
  | "injection_dropped";

/** For the operator's log; never shown at the table. */
export interface EffectProblem {
  readonly code: EffectProblemCode;
  readonly module: string | null;
  /** A refusal code, a block kind or a field path. */
  readonly detail?: string;
}

/** An event for the caller to publish, in order. `id` is set when it replaces an earlier one. */
export type EffectEvent =
  | { readonly kind: "narrative"; readonly id: null; readonly data: NarrativeData }
  | { readonly kind: "dice"; readonly id: null; readonly data: DiceData }
  | { readonly kind: "blocks"; readonly id: string | null; readonly data: BlocksData };

/** The output review as the caller supplies it (the gateway's `reviewFact`). */
export type TextReview = (text: string) => { readonly text: string; readonly allowed: boolean };

export interface EffectOptions {
  readonly review: TextReview;
  /** The player action (a line's or a command's id) whose work this outcome belongs to. */
  readonly action: string;
  /** `facts_turn`: this is the narrate-now turn itself; its marks wait for the next turn. */
  readonly work: WorkKind;
}

export interface EffectsApplied {
  readonly stale: boolean;
  readonly writes: WriteCommit;
  /** Facts added to the pending list. */
  readonly pendingAdded: number;
  /** A fact asked to narrate now and the request was recorded for this action. */
  readonly narrateNow: boolean;
  readonly events: readonly EffectEvent[];
  readonly problems: readonly EffectProblem[];
}

// ---------------------------------------------------------------- state keys

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown, depth = 0): value is Json {
  if (depth > 64) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
  if (!isRecord(value)) return false;
  return Object.values(value).every((item) => isJsonValue(item, depth + 1));
}

function shortString(value: unknown, max: number): value is string {
  return typeof value === "string" && value !== "" && charCount(value) <= max;
}

/** A fact the Keeper's next prompt reads. Table facts carry their data only (their text was shown). */
export interface PendingFact {
  readonly module: string;
  readonly turn: number;
  readonly to: "table" | "keeper";
  readonly importance: "low" | "normal" | "high";
  readonly text: string | null;
  readonly data: Json | null;
}

function isPendingFact(value: unknown): value is PendingFact {
  if (!isRecord(value)) return false;
  return (
    shortString(value.module, MAX_WRITER_CHARS) &&
    typeof value.turn === "number" &&
    Number.isSafeInteger(value.turn) &&
    value.turn >= 0 &&
    (value.to === "table" || value.to === "keeper") &&
    (value.importance === "low" || value.importance === "normal" || value.importance === "high") &&
    (value.text === null || (typeof value.text === "string" && charCount(value.text) <= MAX_FACT_CHARS)) &&
    isJsonValue(value.data)
  );
}

/**
 * The facts waiting for the Keeper's next prompt, oldest first. `story`: play produced it.
 * The prompt assembler reads it and the turn that consumed it clears it (`takePendingFacts`).
 */
export const PENDING_FACTS: StateKey<PendingFact[]> = jsonStateKey(
  "keeper.pending_facts",
  { reset: "story" },
  (value): value is PendingFact[] => Array.isArray(value) && value.length <= MAX_PENDING_FACTS && value.every(isPendingFact),
);

export interface TurnInjections {
  readonly turn: number;
  readonly injections: readonly string[];
}

function isTurnInjections(value: unknown): value is TurnInjections {
  return (
    isRecord(value) &&
    typeof value.turn === "number" &&
    Number.isSafeInteger(value.turn) &&
    Array.isArray(value.injections) &&
    value.injections.length <= MAX_RECORDED_INJECTIONS &&
    value.injections.every((text) => typeof text === "string" && charCount(text) <= MAX_INJECTION_CHARS)
  );
}

/**
 * The module prompt injections of the last `MAX_INJECTION_TURNS` turns, by turn: with the
 * log and the stored documents, what reached the model can be rebuilt. `story`.
 */
export const TURN_INJECTIONS: StateKey<TurnInjections[]> = jsonStateKey(
  "keeper.turn_injections",
  { reset: "story" },
  (value): value is TurnInjections[] => Array.isArray(value) && value.length <= MAX_INJECTION_TURNS && value.every(isTurnInjections),
);

export interface ContentWrites {
  readonly turn: number;
  readonly writes: readonly { readonly path: string; readonly by: string }[];
}

function isContentWrites(value: unknown): value is ContentWrites {
  return (
    isRecord(value) &&
    typeof value.turn === "number" &&
    Number.isSafeInteger(value.turn) &&
    Array.isArray(value.writes) &&
    value.writes.length <= MAX_CONTENT_WRITES &&
    value.writes.every((write) => isRecord(write) && shortString(write.path, MAX_WRITE_PATH_CHARS) && shortString(write.by, MAX_WRITER_CHARS))
  );
}

/**
 * Which variables content (modules, templates) wrote in the room's latest turn, and who.
 * The Scribe reads it. Replaced, not grown, when a later turn first writes. `story`.
 */
export const CONTENT_WRITES: StateKey<ContentWrites> = jsonStateKey("keeper.content_writes", { reset: "story" }, isContentWrites);

export type WorkKind = "action" | "facts_turn";

/** The narrate-now request of the room's latest player action. */
export interface NarrateNowState {
  /** The player action the request belongs to. */
  readonly action: string;
  /** A fact asked for it and no turn has answered yet. */
  readonly requested: boolean;
  /** The one narrate-now turn for this action has opened. */
  readonly opened: boolean;
}

function isNarrateNowState(value: unknown): value is NarrateNowState {
  return isRecord(value) && shortString(value.action, MAX_ACTION_CHARS) && typeof value.requested === "boolean" && typeof value.opened === "boolean";
}

/** `story`: a request belongs to the play that made it. */
export const NARRATE_NOW: StateKey<NarrateNowState> = jsonStateKey("keeper.narrate_now", { reset: "story" }, isNarrateNowState);

/**
 * The room switch for narrate-now turns (absent: on). A room setting, like the enabled
 * skills: the table's agreement on pacing, not campaign content.
 */
export const NARRATE_NOW_SETTING: StateKey<boolean> = jsonStateKey(
  "room.narrate_now",
  { reset: "never", because: "a room setting (how the table wants module events paced), not campaign content" },
  (value): value is boolean => typeof value === "boolean",
);

// ---------------------------------------------------------------- narrate now (pure)

/**
 * A fact marked `narrateNow` during `work` for `action`. Inside the narrate-now turn
 * itself nothing is raised: the fact is already pending and joins the next turn.
 */
export function markNarrateNow(state: NarrateNowState | null, action: string, work: WorkKind): { readonly state: NarrateNowState | null; readonly raised: boolean } {
  if (work === "facts_turn") return { state, raised: false };
  if (state !== null && state.action === action && state.opened) return { state, raised: false };
  return { state: { action, requested: true, opened: false }, raised: true };
}

export type NarrateNowReason = "open" | "disabled" | "not_requested" | "other_action" | "already_opened";

/**
 * At the end of the work for `action` (§12 3.2 step 14): whether to open the narrate-now
 * turn. At most one per action; never for a request left from an earlier action; never
 * when the room switched it off. The returned state is what to store.
 */
export function decideNarrateNow(
  state: NarrateNowState | null,
  action: string,
  enabled: boolean,
): { readonly open: boolean; readonly reason: NarrateNowReason; readonly state: NarrateNowState | null } {
  if (state === null || !state.requested) return { open: false, reason: "not_requested", state };
  const cleared: NarrateNowState = { ...state, requested: false };
  if (!enabled) return { open: false, reason: "disabled", state: cleared };
  if (state.action !== action) return { open: false, reason: "other_action", state: cleared };
  if (state.opened) return { open: false, reason: "already_opened", state: cleared };
  return { open: true, reason: "open", state: { action, requested: false, opened: true } };
}

/** Whether the room allows narrate-now turns (default on). */
export function narrateNowEnabled(store: Store, room: string): boolean {
  return store.stateGet(room, NARRATE_NOW_SETTING) ?? true;
}

// ---------------------------------------------------------------- readers

export function readPendingFacts(store: Store, room: string): readonly PendingFact[] {
  return store.stateGet(room, PENDING_FACTS) ?? [];
}

/** The pending facts, cleared: the turn whose prompt reads them takes them. */
export function takePendingFacts(context: RoomContext): readonly PendingFact[] {
  const facts = readPendingFacts(context.services.store, context.room);
  if (facts.length > 0) context.writer.stateDelete(PENDING_FACTS);
  return facts;
}

/** The injections recorded for `turn`, or null when that turn has none on record. */
export function readTurnInjections(store: Store, room: string, turn: number): readonly string[] | null {
  return (store.stateGet(room, TURN_INJECTIONS) ?? []).find((entry) => entry.turn === turn)?.injections ?? null;
}

/** What content wrote in `turn` (empty when the record belongs to another turn). */
export function readContentWrites(store: Store, room: string, turn: number): readonly { readonly path: string; readonly by: string }[] {
  const record = store.stateGet(room, CONTENT_WRITES);
  return record !== null && record.turn === turn ? record.writes : [];
}

// ---------------------------------------------------------------- variable writes

const ROOT_PREFIX = /^(?:variables\.|stat_data\.)/u;

function refusedWrite(write: ContentWrite, path: string, code: ContentWriteRefusal): RefusedWrite {
  return { path, by: write.by, code };
}

/**
 * Commit content variable writes in order (module `setVar`s, template `setvar`s). One
 * document write per variable kind at the end. Synchronous; refusals are data.
 */
export function commitVariableWrites(context: RoomContext, writes: readonly ContentWrite[]): WriteCommit {
  if (writes.length === 0) return { applied: [], refused: [] };
  const { documents } = context.services;
  const treeDocument = documents.get(context.room, VARIABLE_TREE_TYPE, VARIABLE_TREE_ID);
  const treeBroken = treeDocument?.corrupt ?? false;
  const stored = treeDocument === null || treeBroken ? { tree: new Map() as VarMap, exposed: [] as readonly string[] } : readVariableTree(treeDocument.data);
  const variablesDocument = documents.get(context.room, MODULE_VARIABLES_TYPE, MODULE_VARIABLES_ID);
  const variablesBroken = variablesDocument?.corrupt ?? false;
  let variables: ModuleVariables = variablesDocument === null || variablesBroken ? { variables: [] } : normalizeModuleVariables(variablesDocument.data);

  let tree = stored.tree;
  let treeApplied: AppliedWrite[] = [];
  let variablesApplied: AppliedWrite[] = [];
  const refused: RefusedWrite[] = [];
  const order: AppliedWrite[] = [];

  for (const write of writes) {
    const path = write.path.replace(ROOT_PREFIX, "");
    if (path === "") {
      refused.push(refusedWrite(write, path, "root_path"));
      continue;
    }
    const slug = normalizeVariableId(path) ?? path;
    if (variables.variables.some((variable) => variable.spec.id === slug)) {
      if (variablesBroken) {
        refused.push(refusedWrite(write, path, "corrupt_document"));
        continue;
      }
      const result = setVariable(variables, slug, write.value);
      if (result.outcome.status === "refused") {
        refused.push(refusedWrite(write, path, result.outcome.code));
        continue;
      }
      variables = result.state;
      const done: AppliedWrite = { path, by: write.by, target: "module_variable", old: result.outcome.old, value: result.outcome.value };
      variablesApplied.push(done);
      order.push(done);
      continue;
    }
    if (treeBroken) {
      refused.push(refusedWrite(write, path, "corrupt_document"));
      continue;
    }
    const application = applyUpdates(tree, [{ op: "set", written: "set", path, args: [JSON.stringify(write.value)], reason: "" }]);
    const outcome = application.results[0]?.outcome;
    if (outcome === undefined || outcome.status === "refused") {
      refused.push(refusedWrite(write, path, outcome?.code ?? "bad_value"));
      continue;
    }
    tree = application.tree;
    const done: AppliedWrite = { path, by: write.by, target: "tree", old: outcome.old, value: outcome.value };
    treeApplied.push(done);
    order.push(done);
  }

  if (treeApplied.length > 0) {
    try {
      documents.put(context.writer, VARIABLE_TREE_TYPE, VARIABLE_TREE_ID, variableTreeData(tree, stored.exposed));
    } catch (error) {
      if (!(error instanceof DocumentRefused)) throw error;
      for (const done of treeApplied) refused.push({ path: done.path, by: done.by, code: "document_refused" });
      treeApplied = [];
    }
  }
  if (variablesApplied.length > 0) {
    try {
      documents.put(context.writer, MODULE_VARIABLES_TYPE, MODULE_VARIABLES_ID, moduleVariablesPayload(variables));
    } catch (error) {
      if (!(error instanceof DocumentRefused)) throw error;
      for (const done of variablesApplied) refused.push({ path: done.path, by: done.by, code: "document_refused" });
      variablesApplied = [];
    }
  }
  const kept = new Set([...treeApplied, ...variablesApplied]);
  const applied = order.filter((done) => kept.has(done));
  recordContentWrites(context, applied);
  return { applied, refused };
}

function recordContentWrites(context: RoomContext, applied: readonly AppliedWrite[]): void {
  if (applied.length === 0) return;
  const record = context.services.store.stateGet(context.room, CONTENT_WRITES);
  const writes = record !== null && record.turn === context.turn ? [...record.writes] : [];
  for (const write of applied) {
    if (writes.length >= MAX_CONTENT_WRITES) break;
    if (charCount(write.path) > MAX_WRITE_PATH_CHARS || !shortString(write.by, MAX_WRITER_CHARS)) continue;
    if (!writes.some((entry) => entry.path === write.path && entry.by === write.by)) writes.push({ path: write.path, by: write.by });
  }
  context.writer.statePut(CONTENT_WRITES, { turn: context.turn, writes });
}

// ---------------------------------------------------------------- blocks

type BlockCheck = { readonly ok: true; readonly block: Block } | { readonly ok: false; readonly code: "block_unknown_kind" | "block_malformed"; readonly detail: string };

const HASH = /^[0-9a-f]{64}$/u;

class Malformed extends Error {
  readonly path: string;

  constructor(path: string) {
    super(path);
    this.path = path;
  }
}

/** Builds one block from its named fields only; whatever else the input carries is not copied. */
class Picker {
  readonly #raw: Record<string, unknown>;
  readonly review: TextReview;
  blocked = false;

  constructor(raw: Record<string, unknown>, review: TextReview) {
    this.#raw = raw;
    this.review = review;
  }

  #get(key: string): unknown {
    return Object.hasOwn(this.#raw, key) ? this.#raw[key] : undefined;
  }

  text(key: string, max: number, reviewed = false): string {
    const value = this.#get(key);
    if (typeof value !== "string" || charCount(value) > max) throw new Malformed(key);
    return reviewed ? this.#reviewed(value) : value;
  }

  optionalText(key: string, max: number, reviewed = false): string | undefined {
    return this.#get(key) === undefined ? undefined : this.text(key, max, reviewed);
  }

  number(key: string): number {
    const value = this.#get(key);
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Malformed(key);
    return value;
  }

  optionalNumber(key: string): number | undefined {
    return this.#get(key) === undefined ? undefined : this.number(key);
  }

  hash(key: string): string {
    const value = this.#get(key);
    if (typeof value !== "string" || !HASH.test(value)) throw new Malformed(key);
    return value;
  }

  oneOf<T extends string>(key: string, options: readonly T[]): T | undefined {
    const value = this.#get(key);
    if (value === undefined) return undefined;
    if (typeof value !== "string" || !(options as readonly string[]).includes(value)) throw new Malformed(key);
    return value as T;
  }

  raw(key: string): unknown {
    return this.#get(key);
  }

  #reviewed(text: string): string {
    const result = this.review(text);
    if (!result.allowed) this.blocked = true;
    return result.text;
  }
}

/** Optional fields, left out when absent (exactOptionalPropertyTypes-safe). */
function present<T extends Record<string, unknown>>(fields: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) if (value !== undefined) out[key] = value;
  return out as { [K in keyof T]: Exclude<T[K], undefined> };
}

function buildBlock(kind: string, pick: Picker): Block | null {
  const L = MAX_BLOCK_LABEL_CHARS;
  const T = MAX_BLOCK_TEXT_CHARS;
  switch (kind) {
    case "meter":
      return { kind, label: pick.text("label", L, true), value: pick.number("value"), min: pick.number("min"), max: pick.number("max") };
    case "stat": {
      const value = pick.raw("value");
      if (typeof value === "string") return { kind, label: pick.text("label", L, true), value: pick.text("value", L, true) };
      if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return { kind, label: pick.text("label", L, true), value };
      throw new Malformed("value");
    }
    case "badge":
      return { kind, label: pick.text("label", L, true), ...present({ tone: pick.oneOf("tone", ["info", "warn", "danger"] as const) }) };
    case "text":
      return { kind, text: pick.text("text", T, true), ...present({ style: pick.oneOf("style", ["quote", "warning"] as const) }) };
    case "divider":
      return { kind };
    case "choices": {
      const options = pick.raw("options");
      if (!Array.isArray(options) || options.length === 0 || options.length > MAX_BLOCK_CHOICES) throw new Malformed("options");
      const built = options.map((option, index) => {
        if (!isRecord(option)) throw new Malformed(`options.${index}`);
        const inner = new Picker(option, pick.review);
        const args = inner.raw("args");
        if (args !== undefined && (!isRecord(args) || !isJsonValue(args))) throw new Malformed(`options.${index}.args`);
        const built = {
          id: inner.text("id", L),
          label: inner.text("label", L, true),
          command: inner.text("command", L),
          ...(args === undefined ? {} : { args: args as Record<string, unknown> }),
        };
        if (inner.blocked) pick.blocked = true;
        return built;
      });
      return { kind, options: built, ...present({ prompt: pick.optionalText("prompt", T, true) }) };
    }
    case "image":
      return {
        kind,
        hash: pick.hash("hash"),
        ...present({
          mime: pick.optionalText("mime", L),
          size: pick.optionalNumber("size"),
          caption: pick.optionalText("caption", T, true),
          alt: pick.optionalText("alt", T, true),
        }),
      };
    case "letter":
      return {
        kind,
        body: pick.text("body", T, true),
        ...present({ from: pick.optionalText("from", L, true), to: pick.optionalText("to", L, true), date: pick.optionalText("date", L, true) }),
      };
    case "clipping":
      return {
        kind,
        headline: pick.text("headline", L, true),
        body: pick.text("body", T, true),
        ...present({ source: pick.optionalText("source", L, true), date: pick.optionalText("date", L, true) }),
      };
    case "map_pin":
      return {
        kind,
        hash: pick.hash("hash"),
        label: pick.text("label", L, true),
        x: pick.number("x"),
        y: pick.number("y"),
        ...present({ mime: pick.optionalText("mime", L), size: pick.optionalNumber("size"), note: pick.optionalText("note", T, true) }),
      };
    case "title_card":
      return {
        kind,
        title: pick.text("title", L, true),
        ...present({ subtitle: pick.optionalText("subtitle", L, true), act: pick.optionalText("act", L, true) }),
      };
    default:
      return null;
  }
}

/**
 * One block checked against the protocol's `Block` union: a known kind, every required
 * field present with its type and within its cap. Free text is passed through `review`;
 * a block whose text the review blocks is refused as `review_blocked`.
 */
export function checkBlock(raw: unknown, review: TextReview): BlockCheck | { readonly ok: false; readonly code: "review_blocked"; readonly detail: string } {
  if (!isRecord(raw)) return { ok: false, code: "block_malformed", detail: "" };
  const kind = Object.hasOwn(raw, "kind") ? raw.kind : undefined;
  if (typeof kind !== "string") return { ok: false, code: "block_malformed", detail: "kind" };
  const pick = new Picker(raw, review);
  try {
    const block = buildBlock(kind, pick);
    if (block === null) return { ok: false, code: "block_unknown_kind", detail: charCount(kind) <= MAX_BLOCK_LABEL_CHARS ? kind : "" };
    if (pick.blocked) return { ok: false, code: "review_blocked", detail: kind };
    return { ok: true, block };
  } catch (error) {
    if (error instanceof Malformed) return { ok: false, code: "block_malformed", detail: `${kind}.${error.path}` };
    throw error;
  }
}

// ---------------------------------------------------------------- the applier

function blockEvents(requests: readonly BlocksRequest[], review: TextReview, problems: EffectProblem[]): EffectEvent[] {
  const events: EffectEvent[] = [];
  for (const request of requests) {
    if (request.blocks.length > MAX_BLOCKS_PER_EVENT) {
      problems.push({ code: "blocks_too_many", module: request.module });
      continue;
    }
    const blocks: Block[] = [];
    request.blocks.forEach((raw) => {
      const checked = checkBlock(raw, review);
      if (checked.ok) blocks.push(checked.block);
      else problems.push({ code: checked.code, module: request.module, detail: checked.detail });
    });
    if (blocks.length === 0) continue;
    events.push(
      request.id === null
        ? { kind: "blocks", id: null, data: { blocks } }
        : { kind: "blocks", id: `blocks:${request.module}:${request.id}`, data: { blocks, replace: true } },
    );
  }
  return events;
}

function factFor(fact: FactRequest, turn: number, text: string | null): PendingFact {
  return { module: fact.module, turn, to: fact.to, importance: fact.importance, text, data: fact.data };
}

/**
 * Record this turn's prompt injections (turn start). Keeps the last `MAX_INJECTION_TURNS`
 * turns; an injection over the cap is left out and reported.
 */
export function recordInjections(context: RoomContext, injections: readonly string[]): EffectProblem[] {
  if (injections.length === 0) return [];
  const problems: EffectProblem[] = [];
  const kept: string[] = [];
  for (const text of injections) {
    if (kept.length >= MAX_RECORDED_INJECTIONS || charCount(text) > MAX_INJECTION_CHARS) problems.push({ code: "injection_dropped", module: null });
    else kept.push(text);
  }
  const earlier = (context.services.store.stateGet(context.room, TURN_INJECTIONS) ?? []).filter((entry) => entry.turn !== context.turn);
  const next = [...earlier, { turn: context.turn, injections: kept }].sort((a, b) => a.turn - b.turn).slice(-MAX_INJECTION_TURNS);
  context.writer.statePut(TURN_INJECTIONS, next);
  return problems;
}

const NOTHING: WriteCommit = { applied: [], refused: [] };

/**
 * Commit a validated module outcome (turn start, reply phase or a command) to the room in
 * one synchronous block, and return the events to publish, in order: dice first (the
 * rolls happened while the handlers ran), then table facts, then blocks. `injections` are
 * the turn-start outcome's; other exchanges have none.
 */
export function applyModuleEffects(
  context: RoomContext,
  outcome: Applied & { readonly injections?: readonly string[] },
  options: EffectOptions,
): EffectsApplied {
  if (!context.writer.current()) {
    return { stale: true, writes: NOTHING, pendingAdded: 0, narrateNow: false, events: [], problems: [{ code: "stale_writer", module: null }] };
  }
  const problems: EffectProblem[] = [];
  const events: EffectEvent[] = [];

  const writes = commitVariableWrites(
    context,
    outcome.writes.map((write) => ({ path: write.path, value: write.value, by: write.module })),
  );
  for (const refusal of writes.refused) problems.push({ code: "write_refused", module: refusal.by, detail: refusal.code });

  for (const roll of outcome.rolls) {
    events.push({
      kind: "dice",
      id: null,
      data: {
        actor: roll.module,
        kind: "roll",
        expr: roll.notation,
        // The worker reports the rendered roll, not its faces: the text carries them.
        rolls: [],
        total: roll.total,
        ...(roll.label === null ? {} : { label: roll.label }),
        text: roll.text,
        detail: roll.label === null ? { text: roll.text } : { text: roll.text, label: roll.label },
      },
    });
  }

  const pending = [...readPendingFacts(context.services.store, context.room)];
  const before = pending.length;
  let marked = false;
  for (const fact of outcome.facts) {
    if (fact.narrateNow) marked = true;
    let keeperText: string | null = null;
    if (fact.to === "table" && fact.text !== null) {
      const reviewed = options.review(fact.text);
      if (!reviewed.allowed) problems.push({ code: "review_blocked", module: fact.module, detail: "fact" });
      else if (reviewed.text.trim() !== "") {
        events.push({ kind: "narrative", id: null, data: { speaker: "system", name: fact.module, text: reviewed.text, format: "plain" } });
      }
    } else if (fact.to === "keeper") {
      keeperText = fact.text;
    }
    if (keeperText === null && fact.data === null) continue;
    if (pending.length >= MAX_PENDING_FACTS) {
      problems.push({ code: "pending_full", module: fact.module });
      continue;
    }
    pending.push(factFor(fact, context.turn, keeperText));
  }
  if (pending.length > before) context.writer.statePut(PENDING_FACTS, pending);

  events.push(...blockEvents(outcome.blocks, options.review, problems));

  if (outcome.injections !== undefined) problems.push(...recordInjections(context, outcome.injections));

  let narrateNow = false;
  if (marked && shortString(options.action, MAX_ACTION_CHARS)) {
    const store = context.services.store;
    const marking = markNarrateNow(store.stateGet(context.room, NARRATE_NOW), options.action, options.work);
    if (marking.raised && marking.state !== null) {
      context.writer.statePut(NARRATE_NOW, marking.state);
      narrateNow = true;
    }
  }

  return { stale: false, writes, pendingAdded: pending.length - before, narrateNow, events, problems };
}
