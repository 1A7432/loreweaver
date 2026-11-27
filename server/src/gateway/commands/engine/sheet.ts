// The caller's own character: `sheet` (show, set, clear, finalize), `rename`, and the
// claimable roster `pc` (list, claim, release). Who plays whom is the engine's seating
// (decision 33): claiming a character seats the member on it.
import {
  type CharacterFullView,
  type CharacterView,
  CHARACTER_TYPE,
  CLAIMABLE_ID,
  CLAIMABLE_TYPE,
  type ClaimableView,
  createCharacter,
  memberOf,
  releaseCharacter,
  SEATING_ID,
  SEATING_TYPE,
  type SeatingView,
  setOwner,
  switchCharacter,
  updateSheet,
} from "../../../core/characters/index.ts";
import { DiceError, rollDice } from "../../../core/dice/index.ts";
import {
  displayName,
  type FieldValue,
  newSheet,
  parseSheet,
  resolveName,
  type Sheet,
  setSheetValue,
  sheetValue,
  validateSheet,
} from "../../../core/sheets/index.ts";
import type { RulePack } from "../../../core/rulepacks/index.ts";
import { foldCase } from "../../../core/sheets/text.ts";
import { compact, object, oneOf, text } from "../schema.ts";
import { firstWord } from "../parse.ts";
import {
  callerCharacter,
  callerViewer,
  isAdmin,
  saveCharacter,
  saveSeating,
  seating,
  type StoredCharacter,
  storedCharacter,
  tableCharacterNames,
} from "../support.ts";
import { type Args, type CommandCall, type CommandSpec, type Done, isRefused, refuse, type Refused } from "../types.ts";

/** Assignments one `sheet` command may carry. */
export const MAX_SHEET_WRITES = 32;
const MAX_NAME_CHARS = 64;
/** Stats a sheet shows in its text form. */
const MAX_SHOWN = 24;

// ---------------------------------------------------------------------------
// The assignment text: `STR=60 HP-=2`, or the dice-bot form `力量60 敏捷50 HP-2`
// ---------------------------------------------------------------------------

export interface SheetWriteArg {
  readonly name: string;
  readonly op: "=" | "+=" | "-=";
  readonly value: string;
}

// Both scans anchor on the VALUE and take what precedes it as the name, so they are linear
// in the input (the reference's `(.+?)(value)` backtracked quadratically).
const VALUE = String.raw`[+-]?(?:\d+d\d+(?:[+\-*/]\d+)?|\d+)`;
const ASSIGN = new RegExp(String.raw`(\+=|-=|=)\s*(${VALUE})`, "giu");
const BARE_VALUE = new RegExp(VALUE, "giu");

function cleanName(raw: string): string {
  return raw.trim().replace(/^[,，\s]+|[,，\s]+$/gu, "");
}

/**
 * Assignments in one of two forms, never mixed: explicit (`STR=16`, `HP+=1d6`, `mod=-3`:
 * `=` is absolute, the sign belongs to the number) or the dice-bot form (`STR16 DEX14`,
 * `HP-4`: a leading sign is relative). Null when the text is garbled or mixes the forms.
 */
export function parseAssignments(input: string): SheetWriteArg[] | null {
  const explicit = new RegExp(ASSIGN.source, "iu").test(input);
  const pattern = explicit ? ASSIGN : BARE_VALUE;
  pattern.lastIndex = 0;
  const writes: SheetWriteArg[] = [];
  let last = 0;
  for (const match of input.matchAll(pattern)) {
    const name = cleanName(input.slice(last, match.index));
    last = match.index + match[0].length;
    let op: SheetWriteArg["op"];
    let value: string;
    if (explicit) {
      op = match[1] as SheetWriteArg["op"];
      value = (match[2] as string).trim();
      if (name.includes("=")) return null;
    } else {
      const raw = match[0].trim();
      const sign = raw[0] === "+" || raw[0] === "-" ? raw[0] : "";
      op = sign === "+" ? "+=" : sign === "-" ? "-=" : "=";
      value = raw.slice(sign.length);
    }
    if (name !== "" && value !== "") writes.push({ name, op, value });
  }
  if (explicit && cleanName(input.slice(last)) !== "") return null;
  return writes.length === 0 ? null : writes;
}

const CLEAR_WORDS: ReadonlySet<string> = new Set(["clr", "clear", "del", "delete"]);
const FINALIZE_WORDS: ReadonlySet<string> = new Set(["finalize", "定稿", "初始化"]);

const DICE_VALUE = /d/iu;
const INTEGER_VALUE = /^[+-]?\d+$/u;

/** An assignment's value: a whole number, a dice roll's total, or (for `=`) text. */
function writeValue(call: CommandCall, write: SheetWriteArg): number | string | Refused {
  const value = write.value.trim();
  if (INTEGER_VALUE.test(value)) {
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : refuse("invalid_arg", { path: "writes" });
  }
  if (DICE_VALUE.test(value) && /^[+-]?[\dd+\-*/()\s]+$/iu.test(value)) {
    try {
      return rollDice(value, call.context.random).total;
    } catch (error) {
      if (error instanceof DiceError) return refuse("bad_dice", { expr: value, code: error.code });
      throw error;
    }
  }
  return write.op === "=" ? value : refuse("invalid_arg", { path: "writes" });
}

/** The caller's own character, refused when they play someone else's. */
function ownCharacter(call: CommandCall): StoredCharacter | Refused {
  const character = callerCharacter(call);
  if (isRefused(character)) return character;
  if (character.character.owner !== call.context.who.member?.id) return refuse("not_your_character");
  return character;
}

/** A blank character of the room's system for a caller who has none yet (the dice-bot habit of `.st` on a fresh table). */
function blankCharacter(call: CommandCall): StoredCharacter | Refused {
  const member = call.context.who.member;
  const pack = call.context.pack;
  if (member === null) return refuse("no_member");
  if (pack === null) return refuse("no_rule_system");
  if (tableCharacterNames(call, null).has(member.name.trim().toLowerCase())) return refuse("name_taken", { name: member.name });
  const created = createCharacter(pack.sheet, newSheet(pack.sheet, member.name, pack.id).sheet, { owner: member.id });
  if (!created.ok) return refuse("sheet_refused", { code: created.code });
  const seats = seating(call);
  if (isRefused(seats)) return seats;
  const id = `ch-${call.context.services.clock.id()}`;
  const seated = switchCharacter(seats, member.id, id, member.name);
  if (!seated.ok) return refuse("seat_refused", { code: seated.code });
  saveSeating(call, seated.data);
  return { id, character: created.data, pack };
}

function current(stored: StoredCharacter, sheet: Sheet, name: string): number | null {
  const read = sheetValue(stored.pack.sheet, sheet, name);
  if (read.kind === "value") return read.value;
  return read.kind === "unset" ? 0 : null;
}

function runSet(call: CommandCall, writes: readonly SheetWriteArg[]): Done | Refused {
  let stored = ownCharacter(call);
  if (isRefused(stored) && stored.refused === "no_character") stored = blankCharacter(call);
  if (isRefused(stored)) return stored;
  const spec = stored.pack.sheet;
  let sheet = stored.character.sheet;
  const changed: string[] = [];
  for (const write of writes) {
    const typed = write.name.trim();
    const canonical = resolveName(spec, typed);
    // A name with a space that nothing declares is a mis-parse (`.st Bob STR 60`), never a
    // house skill: refused, so a ghost entry is never written and echoed back as done.
    if (canonical === null && /\s/u.test(typed)) return refuse("key_has_space", { key: typed });
    const name = canonical ?? typed;
    const value = writeValue(call, write);
    if (isRefused(value)) return value;
    let next: FieldValue = value;
    if (write.op !== "=") {
      const before = current(stored, sheet, name);
      if (before === null || typeof value !== "number") return refuse("not_numeric", { skill: typed });
      next = write.op === "+=" ? before + value : before - value;
      if (!Number.isSafeInteger(next)) return refuse("invalid_arg", { path: "writes" });
    }
    const written = setSheetValue(spec, sheet, name, next);
    if (!written.ok) return refuse("sheet_write", { name: typed, code: written.code });
    sheet = written.sheet;
    changed.push(name);
  }
  const updated = updateSheet(spec, stored.character, sheet);
  if (!updated.ok) return refuse("sheet_refused", { code: updated.code });
  saveCharacter(call, stored.id, updated.data);
  const items = changed.map((name) => {
    const read = sheetValue(spec, updated.data.sheet, name);
    const value = read.kind === "value" ? String(read.value) : read.kind === "text" ? read.text : "";
    return call.say("sheet.item", { name: displayName(spec, name, call.locale), value });
  });
  const lines = [call.say("sheet.updated", { name: updated.data.sheet.name, items: items.join(call.say("list.separator")) })];
  if (updated.violations.length > 0) lines.push(call.say("sheet.corrected", { count: updated.violations.length }));
  return { text: lines.join("\n"), data: { id: stored.id, changed, violations: updated.violations.map((violation) => violation.code) } };
}

function shownNames(pack: RulePack, sheet: Sheet): string[] {
  const show = pack.stShow;
  if (typeof show === "object" && show !== null && !Array.isArray(show)) {
    const top = (show as { readonly top?: unknown }).top;
    if (Array.isArray(top) && top.every((name) => typeof name === "string")) return (top as string[]).slice(0, MAX_SHOWN);
  }
  return [...sheet.attributes.map(([name]) => name), ...sheet.skills.map(([name]) => name)].slice(0, MAX_SHOWN);
}

/** The stats a sheet shows in its text form (the pack's `st_show` top, else the first), in the caller's language. */
export function sheetItems(call: CommandCall, pack: RulePack, sheet: Sheet): string {
  const items: string[] = [];
  for (const name of shownNames(pack, sheet)) {
    const read = sheetValue(pack.sheet, sheet, name);
    const value = read.kind === "value" ? String(read.value) : read.kind === "text" ? read.text : null;
    if (value !== null) items.push(call.say("sheet.item", { name: displayName(pack.sheet, name, call.locale), value }));
  }
  return items.join(call.say("list.separator"));
}

function runShow(call: CommandCall): Done | Refused {
  const seat = call.context.who.character;
  if (seat === null) return refuse("no_character");
  const view = call.context.services.views.view(call.context.room, CHARACTER_TYPE, seat.id, callerViewer(call)) as CharacterView | null;
  if (view === null) return refuse("no_character");
  const stored = storedCharacter(call, seat.id);
  if (stored === null) return refuse("no_character");
  if (isRefused(stored)) return stored;
  if (!("sheet" in view)) {
    // Someone else's character (a module's): what the table sees of it.
    const meters = view.resources.map((meter) => call.say("sheet.item", { name: meter.label, value: `${meter.value}/${meter.max}` }));
    return { text: call.say("sheet.show", { name: view.name, items: meters.join(call.say("list.separator")) }), data: view };
  }
  const full = view as CharacterFullView;
  const sheet = parseSheet(stored.pack.sheet, full.sheet).sheet;
  return { text: call.say("sheet.show", { name: full.name, items: sheetItems(call, stored.pack, sheet) }), data: full };
}

function claimableIds(call: CommandCall): Set<string> {
  const view = call.context.services.views.view(call.context.room, CLAIMABLE_TYPE, CLAIMABLE_ID, callerViewer(call)) as ClaimableView | null;
  return new Set((view?.characters ?? []).map((entry) => entry.id));
}

function runClear(call: CommandCall): Done | Refused {
  const stored = ownCharacter(call);
  if (isRefused(stored)) return stored;
  // A character on the room's roster is released, not destroyed: it is the world's offer.
  if (claimableIds(call).has(stored.id)) return refuse("use_release");
  const seats = seating(call);
  if (isRefused(seats)) return seats;
  call.context.services.documents.delete(call.context.writer, CHARACTER_TYPE, stored.id);
  const freed = releaseCharacter(seats, stored.id);
  if (freed.ok) saveSeating(call, freed.data);
  return { text: call.say("sheet.cleared", { name: stored.character.sheet.name }), data: { id: stored.id } };
}

function runFinalize(call: CommandCall): Done | Refused {
  const stored = ownCharacter(call);
  if (isRefused(stored)) return stored;
  // Creation semantics on purpose: current pools are set back to their starts for the
  // sheet's final characteristics, as a freshly made character's are.
  const validated = validateSheet(stored.pack.sheet, stored.character.sheet, { initializeVitals: true });
  const remade = createCharacter(stored.pack.sheet, validated.sheet, { owner: stored.character.owner, avatar: stored.character.avatar });
  if (!remade.ok) return refuse("sheet_refused", { code: remade.code });
  saveCharacter(call, stored.id, { ...remade.data, status: stored.character.status });
  const lines = [call.say("sheet.finalized", { name: remade.data.sheet.name })];
  if (remade.violations.length > 0) lines.push(call.say("sheet.corrected", { count: remade.violations.length }));
  return { text: lines.join("\n"), data: { id: stored.id, violations: remade.violations.map((violation) => violation.code) } };
}

const WRITE = object({ name: text(MAX_NAME_CHARS, 1), op: oneOf(["=", "+=", "-="]), value: text(MAX_NAME_CHARS, 1) }, ["name", "op", "value"]);

export const sheetCommand: CommandSpec = {
  id: "sheet",
  source: "engine",
  key: "sheet",
  params: object({ op: oneOf(["show", "set", "clear", "finalize"]), writes: { type: "array", items: WRITE, maxItems: MAX_SHEET_WRITES } }, ["op"]),
  text: { en: ["sheet", "st"], zh: ["st"] },
  role: "player",
  parseText(rest) {
    const word = foldCase(rest.trim());
    if (word === "" || word === "show") return { op: "show" };
    if (CLEAR_WORDS.has(word)) return { op: "clear" };
    if (FINALIZE_WORDS.has(word)) return { op: "finalize" };
    const writes = parseAssignments(rest);
    if (writes === null) return refuse("usage");
    if (writes.length > MAX_SHEET_WRITES) return refuse("too_many_writes", { limit: MAX_SHEET_WRITES });
    return { op: "set", writes };
  },
  run(call, args): Done | Refused {
    switch (args.op as string) {
      case "show":
        return runShow(call);
      case "clear":
        return runClear(call);
      case "finalize":
        return runFinalize(call);
      default: {
        const writes = args.writes as readonly SheetWriteArg[] | undefined;
        if (writes === undefined || writes.length === 0) return refuse("missing_arg", { path: "writes" });
        return runSet(call, writes);
      }
    }
  },
};

export const renameCommand: CommandSpec = {
  id: "rename",
  source: "engine",
  key: "rename",
  params: object({ name: text(MAX_NAME_CHARS, 1) }, ["name"]),
  text: { en: ["rename", "nn"], zh: ["nn"] },
  role: "player",
  parseText: (rest) => compact({ name: rest === "" ? undefined : rest }),
  run(call, args): Done | Refused {
    const stored = ownCharacter(call);
    if (isRefused(stored)) return stored;
    const name = (args.name as string).trim();
    const old = stored.character.sheet.name;
    if (tableCharacterNames(call, stored.id).has(name.toLowerCase())) return refuse("name_taken", { name });
    const renamed = updateSheet(stored.pack.sheet, stored.character, { ...stored.character.sheet, name });
    if (!renamed.ok) return refuse("bad_name", { name });
    saveCharacter(call, stored.id, renamed.data);
    return {
      data: { id: stored.id, name: renamed.data.sheet.name },
      events: [{ kind: "narrative", data: { speaker: "system", text: call.tell("rename.event", { old, name: renamed.data.sheet.name }), format: "plain" } }],
    };
  },
};

// ---------------------------------------------------------------------------
// The claimable roster
// ---------------------------------------------------------------------------

const CLAIM_WORDS: ReadonlySet<string> = new Set(["claim", "认领", "認領"]);
const RELEASE_WORDS: ReadonlySet<string> = new Set(["release", "放弃", "放棄", "释放", "釋放"]);
const LIST_WORDS: ReadonlySet<string> = new Set(["", "list", "列表"]);

function rosterViews(call: CommandCall): { readonly roster: ClaimableView; readonly seats: SeatingView } {
  const viewer = callerViewer(call);
  const views = call.context.services.views;
  const roster = (views.view(call.context.room, CLAIMABLE_TYPE, CLAIMABLE_ID, viewer) as ClaimableView | null) ?? { characters: [] };
  const seats = (views.view(call.context.room, SEATING_TYPE, SEATING_ID, viewer) as SeatingView | null) ?? { seats: [] };
  return { roster, seats };
}

/** A roster entry by id, else by name (case-insensitive). */
function findEntry(roster: ClaimableView, name: string): ClaimableView["characters"][number] | undefined {
  const wanted = name.trim();
  return roster.characters.find((entry) => entry.id === wanted) ?? roster.characters.find((entry) => entry.name.toLowerCase() === wanted.toLowerCase());
}

function runList(call: CommandCall): Done {
  const { roster, seats } = rosterViews(call);
  if (roster.characters.length === 0) return { text: call.say("pc.empty"), data: { characters: [] } };
  const lines = [call.say("pc.header", { count: roster.characters.length })];
  const entries = roster.characters.map((entry) => {
    const seat = seats.seats.find((item) => item.character === entry.id);
    lines.push(
      seat === undefined ? call.say("pc.line_free", { name: entry.name, blurb: entry.blurb }) : call.say("pc.line_taken", { name: entry.name, blurb: entry.blurb, member: seat.memberName }),
    );
    return { id: entry.id, name: entry.name, blurb: entry.blurb, heldBy: seat?.memberName ?? null };
  });
  return { text: lines.join("\n"), data: { characters: entries } };
}

function runClaim(call: CommandCall, name: string): Done | Refused {
  const member = call.context.who.member;
  if (member === null) return refuse("no_member");
  const entry = findEntry(rosterViews(call).roster, name);
  if (entry === undefined) return refuse("unknown_character", { name });
  const seats = seating(call);
  if (isRefused(seats)) return seats;
  const seated = switchCharacter(seats, member.id, entry.id, member.name);
  if (!seated.ok) return refuse(seated.code === "taken" ? "taken" : "seat_refused", { name: entry.name, code: seated.code });
  saveSeating(call, seated.data);
  // A roster character with a sheet becomes the claimer's: their notes, their sheet.
  const stored = storedCharacter(call, entry.id);
  if (isRefused(stored)) return stored;
  if (stored !== null && stored.character.owner !== member.id) {
    const owned = setOwner(stored.character, member.id);
    if (!owned.ok) return refuse("seat_refused", { code: owned.code });
    saveCharacter(call, entry.id, owned.data);
  }
  return {
    data: { id: entry.id, name: entry.name },
    events: [{ kind: "narrative", data: { speaker: "system", text: call.tell("pc.claimed", { member: member.name, name: entry.name }), format: "plain" } }],
  };
}

function runRelease(call: CommandCall, name: string | undefined): Done | Refused {
  const member = call.context.who.member;
  if (member === null) return refuse("no_member");
  const seats = seating(call);
  if (isRefused(seats)) return seats;
  let id: string | null;
  if (name === undefined) id = call.context.who.character?.id ?? null;
  else {
    const entry = findEntry(rosterViews(call).roster, name);
    id = entry?.id ?? seats.seats.find((seat) => seat.character === name.trim())?.character ?? null;
    if (id === null) {
      // A seated character that is not on the roster (one a member made), by its name.
      for (const seat of seats.seats) {
        const view = call.context.services.views.view(call.context.room, CHARACTER_TYPE, seat.character, callerViewer(call)) as CharacterView | null;
        if (view !== null && view.name.toLowerCase() === name.trim().toLowerCase()) id = seat.character;
      }
    }
  }
  if (id === null) return refuse(name === undefined ? "no_character" : "unknown_character", { name: name ?? "" });
  const holder = memberOf(seats, id);
  if (holder === null) return refuse("unclaimed", { name: name ?? id });
  if (holder !== member.id && !isAdmin(call.context)) return refuse("forbidden");
  const freed = releaseCharacter(seats, id);
  if (!freed.ok) return refuse("unclaimed", { name: name ?? id });
  saveSeating(call, freed.data);
  const view = call.context.services.views.view(call.context.room, CHARACTER_TYPE, id, callerViewer(call)) as CharacterView | null;
  const label = view?.name ?? findEntry(rosterViews(call).roster, id)?.name ?? id;
  return {
    data: { id },
    events: [{ kind: "narrative", data: { speaker: "system", text: call.tell("pc.released", { name: label }), format: "plain" } }],
  };
}

export const pcCommand: CommandSpec = {
  id: "pc",
  source: "engine",
  key: "pc",
  params: object({ op: oneOf(["list", "claim", "release"]), name: text(MAX_NAME_CHARS * 2, 1) }, ["op"]),
  text: { en: ["pc", "roster"], zh: ["pc", "角色池", "预设角色"] },
  role: "player",
  parseText(rest) {
    const [word, after] = firstWord(rest);
    const name = after === "" ? undefined : after;
    if (LIST_WORDS.has(word)) return { op: "list" };
    if (CLAIM_WORDS.has(word)) return compact({ op: "claim", name });
    if (RELEASE_WORDS.has(word)) return compact({ op: "release", name });
    return refuse("usage");
  },
  run(call, args: Args): Done | Refused {
    switch (args.op as string) {
      case "list":
        return runList(call);
      case "claim":
        return args.name === undefined ? refuse("missing_arg", { path: "name" }) : runClaim(call, args.name as string);
      default:
        return runRelease(call, args.name as string | undefined);
    }
  },
};
