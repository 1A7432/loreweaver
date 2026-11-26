// Character-sheet tools: read the acting character's sheet or the whole party's, and
// change an attribute or the status effects. Every write goes through the pack's sheet
// layer (`core/sheets`, `core/characters`): ranges, vitals and derived values are the
// pack's, and what it corrected is reported to the model.
import { CHARACTER_TYPE, MAX_STATUS_CHARS, MAX_STATUS_EFFECTS, readSeating, SEATING_ID, SEATING_TYPE, setStatus } from "../../core/characters/index.ts";
import {
  evaluateSheet,
  getHitPoints,
  HP_ATTRIBUTE,
  HPMAX_ATTRIBUTE,
  resolveName,
  type Sheet,
  type SheetSpec,
  setHitPoints,
  setSheetValue,
  sheetValue,
  tableHas,
  tableWith,
  wireResources,
} from "../../core/sheets/index.ts";
import type { RoomContext } from "../context.ts";
import { param } from "./params.ts";
import { activeCharacter, getDocument, type LoadedCharacter, listDocuments, loadCharacter, refuse, saveCharacter, saveSheet, shown, violationNotice } from "./shared.ts";
import { defineTool, type ToolResult } from "./types.ts";

/** A sheet's attributes (stored, then derived) and its meters, one line each. */
function characteristicLines(spec: SheetSpec, sheet: Sheet): { readonly attributes: string[]; readonly meters: string[] } {
  const evaluation = evaluateSheet(spec, sheet);
  const attributes = sheet.attributes.map(([key, value]) => `  ${key}: ${value}`);
  for (const [slot, canonical] of spec.shape?.derivedAttrs ?? []) {
    const value = evaluation.values.get(canonical);
    if (value !== undefined && !tableHas(sheet.attributes, slot)) attributes.push(`  ${slot}: ${value}`);
  }
  const meters = wireResources(spec, sheet, "en").resources.map((meter) => `  ${meter.label}: ${meter.value}/${meter.max}`);
  return { attributes, meters };
}

export const getCharacterSheetTool = defineTool({
  name: "get_character_sheet",
  description: "Get the current user's character sheet details.",
  params: {},
  flags: { readOnly: true },
  suspends: null,
  run(context): ToolResult {
    const active = activeCharacter(context);
    if (!active.ok) return active.result;
    const { pack, character } = active.loaded;
    const spec = pack.sheet;
    const sheet = character.sheet;
    const { attributes, meters } = characteristicLines(spec, sheet);
    const lines = [`Character sheet: ${sheet.name}`, `System: ${pack.id}`];
    if (attributes.length > 0) lines.push("", "Base attributes:", ...attributes);
    if (meters.length > 0) lines.push("", "Status:", ...meters);
    else {
      const hp = getHitPoints(spec, sheet);
      if (hp.ok && hp.max > 0) lines.push("", "Status:", `  HP: ${hp.current}/${hp.max}`);
    }
    if (character.status.length > 0) lines.push("", `Status effects: ${character.status.join(", ")}`);
    const fields = sheet.fields.filter(([, value]) => value !== "").map(([name, value]) => `${name}: ${value}`);
    if (fields.length > 0) lines.push("", ...fields);

    // Untrained derived skills are not stored; their computed values make the sheet read complete.
    const evaluation = evaluateSheet(spec, sheet);
    const skills: [string, number][] = sheet.skills.map(([name, value]) => [name, value]);
    for (const [slot, canonical] of spec.shape?.derivedSkills ?? []) {
      const value = evaluation.values.get(canonical);
      if (typeof value === "number" && !tableHas(sheet.skills, slot)) skills.push([slot, value]);
    }
    if (skills.length > 0) {
      skills.sort((a, b) => b[1] - a[1]);
      lines.push("", "Skills:", ...skills.map(([name, value]) => `  ${name}: ${value}`));
    }
    if (sheet.equipment.length > 0) lines.push("", `Equipment: ${sheet.equipment.map(shown).join(", ")}`);
    if (sheet.background !== "") lines.push("", `Background: ${sheet.background}`);
    if (sheet.notes !== "") lines.push("", `Notes: ${sheet.notes}`);
    return { text: lines.join("\n") };
  },
});

/** The party: the characters members are playing; every character of the room when nobody is seated. */
function partyCharacterIds(context: RoomContext): string[] {
  const seatingDocument = getDocument(context, SEATING_TYPE, SEATING_ID);
  const seating = seatingDocument === null || seatingDocument.corrupt ? null : readSeating(seatingDocument.data);
  const seated = seating?.seats.map((seat) => seat.character) ?? [];
  return seated.length > 0 ? seated : listDocuments(context, CHARACTER_TYPE).map((document) => document.id);
}

export const listPartySheetsTool = defineTool({
  name: "list_party_sheets",
  description: "Every character sheet at this table — the WHOLE party, not only whoever is acting.",
  params: {},
  flags: { readOnly: true },
  suspends: null,
  run(context): ToolResult {
    const blocks: string[] = [];
    for (const id of partyCharacterIds(context)) {
      const loaded = loadCharacter(context, id);
      // One unreadable character must not cost the Keeper the whole roster.
      if (!loaded.ok) continue;
      const { pack, character } = loaded.loaded;
      const { attributes, meters } = characteristicLines(pack.sheet, character.sheet);
      const status = character.status.length > 0 ? [`  status effects: ${character.status.join(", ")}`] : [];
      blocks.push([`— ${character.sheet.name} (${pack.id})`, ...attributes, ...meters, ...status].join("\n"));
    }
    if (blocks.length === 0) return { text: "No character sheets in this room yet." };
    return {
      text: [
        `Party sheets (${blocks.length}):`,
        ...blocks,
        "Read-only. To change one of these, say the new absolute value in your narration and let that player set it on their own turn (`.st <key>=<value>`).",
      ].join("\n"),
    };
  },
});

function readNumber(spec: SheetSpec, sheet: Sheet, name: string): string {
  const read = sheetValue(spec, sheet, name);
  if (read.kind === "value") return String(read.value);
  if (read.kind === "text") return read.text;
  return "unset";
}

function writeAttribute(loaded: LoadedCharacter, attribute: string, value: number): { ok: true; sheet: Sheet; old: string; name: string } | { ok: false; result: ToolResult } {
  const spec = loaded.pack.sheet;
  const sheet = loaded.character.sheet;
  const typed = attribute.trim();
  const upper = typed.toUpperCase();
  if (upper === HP_ATTRIBUTE || upper === HPMAX_ATTRIBUTE) {
    const before = getHitPoints(spec, sheet);
    const old = before.ok ? String(upper === HP_ATTRIBUTE ? before.current : before.max) : "unset";
    const write = setHitPoints(spec, sheet, upper === HP_ATTRIBUTE ? { current: value } : { maximum: value });
    if (!write.ok) return { ok: false, result: refuse(write.code, `${typed} could not be written (${write.code}).`) };
    return { ok: true, sheet: write.sheet, old, name: upper };
  }
  const canonical = resolveName(spec, typed);
  if (canonical !== null) {
    const old = readNumber(spec, sheet, canonical);
    const write = setSheetValue(spec, sheet, canonical, value);
    if (!write.ok) return { ok: false, result: refuse(write.code, `${typed} could not be written (${write.code}): ${write.code === "derived_slot" ? "it is derived from other values and changes only through them" : "the pack refused the value"}.`) };
    return { ok: true, sheet: write.sheet, old, name: canonical };
  }
  const old = readNumber(spec, sheet, typed);
  return { ok: true, sheet: Object.freeze({ ...sheet, attributes: tableWith(sheet.attributes, typed, value) }), old, name: typed };
}

export const updateCharacterAttributeTool = defineTool({
  name: "update_character_attribute",
  description: "Update a character's attribute value.",
  params: {
    attribute: param.string("Attribute name (e.g. STR, DEX, POW)."),
    value: param.integer("The new attribute value."),
  },
  flags: {},
  suspends: null,
  run(context, args): ToolResult {
    const active = activeCharacter(context);
    if (!active.ok) return active.result;
    const loaded = active.loaded;
    const written = writeAttribute(loaded, args.attribute, args.value);
    if (!written.ok) return written.result;
    const saved = saveSheet(context, loaded, written.sheet);
    if (!saved.ok) return saved.result;
    const spec = loaded.pack.sheet;
    const sheet = saved.character.sheet;
    let now: string;
    if (written.name === HP_ATTRIBUTE || written.name === HPMAX_ATTRIBUTE) {
      const hp = getHitPoints(spec, sheet);
      now = hp.ok ? String(written.name === HP_ATTRIBUTE ? hp.current : hp.max) : "unset";
    } else {
      now = readNumber(spec, sheet, written.name);
    }
    const line = `Updated ${sheet.name}'s ${args.attribute}: ${written.old} → ${now}`;
    const notice = violationNotice(saved.violations);
    return { text: notice === "" ? line : `${line}\n${notice}` };
  },
});

export const updateCharacterStatusTool = defineTool({
  name: "update_character_status",
  description: "Update the active character's status effects (poisoned, afraid, injured, insane, ...).",
  params: {
    status_effects: param.string(
      "A JSON array of status strings, e.g. '[\"Poisoned\", \"Afraid\"]'. Synced into the shared party roster and injected into the AI's context on every turn.",
    ),
  },
  flags: {},
  suspends: null,
  run(context, args): ToolResult {
    let effects: unknown;
    try {
      effects = JSON.parse(args.status_effects);
    } catch {
      effects = null;
    }
    if (!Array.isArray(effects)) return refuse("invalid_status", "status_effects must be a JSON array of strings, e.g. '[\"Poisoned\"]'.");
    const active = activeCharacter(context);
    if (!active.ok) return active.result;
    const texts = effects.map((effect) => (typeof effect === "string" ? effect : shown(effect)));
    const change = setStatus(active.loaded.character, texts);
    if (!change.ok) {
      const reason = change.code === "too_many_status" ? `more than ${MAX_STATUS_EFFECTS} status effects` : `a status effect is empty or longer than ${MAX_STATUS_CHARS} characters`;
      return refuse(change.code, `Status not updated: ${reason}.`);
    }
    saveCharacter(context, active.loaded, change.data);
    return { text: `Character status updated: ${change.data.status.length === 0 ? "(none)" : change.data.status.join(", ")}` };
  },
});
