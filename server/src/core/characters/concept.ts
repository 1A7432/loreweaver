// A new character biased toward a CONCEPT: the deterministic half of `genchar` (a sheet from
// a description) and of a player's card import, ported from the reference server's
// `agent/char_from_persona.py` (`_bias_sheet`, `_apply_persona_text`).
//
// The model never writes a number (iron rule 1). It proposes a concept — an occupation or
// class, a ranked list of attributes to favour, a few signature skills, a line of backstory
// (`agent/lanes/genchar.ts`) — and this module places numbers the rule pack's own way:
//
//   - a pack that declares a standard array AND archetype priorities
//     (`creation_constraints.methods.standard_array.values`, `.archetype_priorities`,
//     `.default_archetype`) gets the array placed by the archetype the concept's role
//     names (else the default archetype, else the first), the concept's favoured
//     attributes first;
//   - any other pack keeps its ROLLED values and only swaps them within each group of
//     attributes that share one roll and range, the favoured ones taking the group's best
//     rolls and the others keeping theirs in order — a same-distribution swap, never a
//     re-roll;
//   - the role goes into the pack's occupation/class text field, when it has one;
//   - each signature skill the sheet stores (not a derived one) is raised to a competent
//     floor, within the pack's skill range.
//
// The result is refreshed as at creation and then goes through `createCharacter`, which
// validates it like every other stat write. Names the model gave that the pack does not
// know are ignored. Nothing here reads a model's text as anything but a name to look up.
import type { RandomSource } from "../random.ts";
import { generateCharacter, refreshSheet, resolveName, type Sheet, type SheetSpec, tableGet, tableHas, tableWith } from "../sheets/index.ts";
import { foldCase } from "../sheets/text.ts";
import { isRecord } from "./text.ts";

/**
 * A signature skill's floor (the reference's 60). A skill already above it keeps its value;
 * the pack's skill range caps it (the reference capped at 99).
 */
export const SIGNATURE_SKILL_FLOOR = 60;
/** The reference's cap when a pack declares no skill range. */
const DEFAULT_SKILL_CAP = 99;
/** The meta fields a role is written to, the first the pack declares as text (the reference's two). */
export const ROLE_FIELDS: readonly string[] = ["occupation", "character_class"];

/** What the authoring lane proposed, already capped and reviewed by its caller. */
export interface CharacterConcept {
  /** An occupation or class, as text; null when none was given. */
  readonly role: string | null;
  /** Attributes to favour, best first, as the model named them (codes or names). */
  readonly emphasis: readonly string[];
  /** Skills to raise to the floor, as the model named them. */
  readonly skills: readonly string[];
  readonly backstory: string | null;
  readonly notes: string | null;
}

/** The persona text the sheet keeps: the description and the personality. */
export interface ConceptPersona {
  readonly description: string;
  readonly personality: string;
}

/** How the attribute values were made: `standard_array` when the pack's array was placed. */
export type ConceptMethod = "rolled" | "standard_array";

export interface ConceptSheet {
  readonly sheet: Sheet;
  readonly method: ConceptMethod;
}

function child(value: unknown, key: string): unknown {
  return isRecord(value) && Object.hasOwn(value, key) ? value[key] : undefined;
}

/** The pack's standard array, or null when it declares none (or one that is not integers). */
function standardArray(source: unknown): readonly number[] | null {
  const values = child(child(child(child(source, "creation_constraints"), "methods"), "standard_array"), "values");
  if (!Array.isArray(values) || values.length === 0) return null;
  return values.every((value) => Number.isSafeInteger(value)) ? (values as number[]) : null;
}

/** Archetype (case-folded) → attribute keys best first; pack data, so a Map. */
function archetypes(source: unknown): ReadonlyMap<string, readonly string[]> {
  const raw = child(child(source, "creation_constraints"), "archetype_priorities");
  const out = new Map<string, readonly string[]>();
  if (!isRecord(raw)) return out;
  for (const [name, list] of Object.entries(raw)) {
    if (Array.isArray(list) && list.every((item) => typeof item === "string")) out.set(foldCase(name.trim()), list as string[]);
  }
  return out;
}

function defaultArchetype(source: unknown): string {
  const value = child(child(source, "creation_constraints"), "default_archetype");
  return typeof value === "string" ? value : "";
}

/** The attribute storage keys `names` stand for, deduplicated, best first. */
function emphasisKeys(spec: SheetSpec, names: readonly string[]): string[] {
  const allowed = spec.constraints.attributes;
  const out: string[] = [];
  for (const name of names) {
    const code = name.trim().toUpperCase();
    let key: string | null = allowed.has(code) ? code : null;
    if (key === null) {
      const canonical = resolveName(spec, name);
      const slot = canonical === null ? undefined : spec.shape?.attrKeys.get(canonical);
      if (slot !== undefined && allowed.has(slot)) key = slot;
    }
    if (key !== null && !out.includes(key)) out.push(key);
  }
  return out;
}

function favoured(emphasis: readonly string[], keys: readonly string[]): string[] {
  const first = emphasis.filter((key) => keys.includes(key));
  return [...first, ...keys.filter((key) => !first.includes(key))];
}

/** Place the standard array by archetype; null when the pack's data does not fit this sheet. */
function placeArray(spec: SheetSpec, sheet: Sheet, emphasis: readonly string[], values: readonly number[], table: ReadonlyMap<string, readonly string[]>, fallback: string, role: string): Sheet | null {
  const base = table.get(foldCase(role.trim())) ?? table.get(foldCase(fallback.trim())) ?? table.values().next().value;
  if (base === undefined || base.length !== values.length) return null;
  const derived = spec.shape?.derivedAttrs;
  if (!base.every((key) => spec.constraints.attributes.has(key) && derived?.has(key) !== true)) return null;
  let attributes = sheet.attributes;
  favoured(emphasis, base).forEach((key, index) => {
    attributes = tableWith(attributes, key, values[index] as number);
  });
  return { ...sheet, attributes };
}

/** Within each group of attributes sharing one roll and range, the favoured take the best rolls. */
function swapRolled(spec: SheetSpec, sheet: Sheet, emphasis: readonly string[]): Sheet {
  const derived = spec.shape?.derivedAttrs;
  const groups = new Map<string, string[]>();
  for (const [key, rule] of spec.constraints.attributes) {
    if (derived?.has(key) === true || !tableHas(sheet.attributes, key)) continue;
    const signature = `${rule.roll ?? ""}\u0000${rule.min}\u0000${rule.max}`;
    const keys = groups.get(signature) ?? [];
    keys.push(key);
    groups.set(signature, keys);
  }
  let attributes = sheet.attributes;
  for (const keys of groups.values()) {
    const rolled = keys.map((key) => tableGet(sheet.attributes, key) ?? 0);
    const first = emphasis.filter((key) => keys.includes(key));
    const best = [...rolled].sort((a, b) => b - a).slice(0, first.length);
    // The rest keep the rolls they had, in their order, less the ones the favoured took
    // (the reference re-sorted them too, so the first-declared always rolled highest).
    const left = [...rolled];
    for (const value of best) left.splice(left.indexOf(value), 1);
    const others = keys.filter((key) => !first.includes(key));
    first.forEach((key, index) => {
      attributes = tableWith(attributes, key, best[index] as number);
    });
    others.forEach((key, index) => {
      attributes = tableWith(attributes, key, left[index] as number);
    });
  }
  return { ...sheet, attributes };
}

function writeRole(spec: SheetSpec, sheet: Sheet, role: string): Sheet {
  const shape = spec.shape;
  if (shape === null || role === "") return sheet;
  for (const field of ROLE_FIELDS) {
    if (typeof tableGet(shape.fields, field) === "string") return { ...sheet, fields: tableWith(sheet.fields, field, role) };
  }
  return sheet;
}

function raiseSkills(spec: SheetSpec, sheet: Sheet, names: readonly string[]): Sheet {
  const shape = spec.shape;
  if (shape === null) return sheet;
  const cap = spec.constraints.skills?.max ?? DEFAULT_SKILL_CAP;
  let skills = sheet.skills;
  for (const name of names) {
    const canonical = resolveName(spec, name) ?? name.trim();
    const key = shape.skillKeys.get(canonical) ?? canonical;
    // A derived skill follows its sources; an attribute named as a skill is not a skill.
    if (shape.derivedSkills.has(key)) continue;
    const current = tableGet(skills, key);
    if (current === undefined) continue;
    skills = tableWith(skills, key, Math.min(cap, Math.max(current, SIGNATURE_SKILL_FLOOR)));
  }
  return { ...sheet, skills };
}

/**
 * `sheet` (a freshly generated one) biased toward `concept` by the pack's own data — see the
 * file header. `source` is the pack's whole document (`RulePack.source`).
 */
export function applyConcept(spec: SheetSpec, source: unknown, sheet: Sheet, concept: CharacterConcept): ConceptSheet {
  const emphasis = emphasisKeys(spec, concept.emphasis);
  const role = concept.role ?? "";
  const values = standardArray(source);
  const table = archetypes(source);
  let method: ConceptMethod = "rolled";
  let biased: Sheet | null = null;
  if (values !== null && table.size > 0) {
    biased = placeArray(spec, sheet, emphasis, values, table, defaultArchetype(source), role);
    if (biased !== null) method = "standard_array";
  }
  biased ??= swapRolled(spec, sheet, emphasis);
  biased = raiseSkills(spec, writeRole(spec, biased, role), concept.skills);
  // As at creation: the attributes may have moved what a current pool or a derived skill
  // comes from, and this sheet has never been played.
  const refreshed = refreshSheet(spec, Object.freeze(biased), { initializeVitals: true, preserveTrained: false });
  return { sheet: refreshed.sheet, method };
}

/**
 * The background and notes: the concept's backstory as the background when there is one
 * (the persona then kept in the notes), else the persona; the concept's notes after.
 */
export function conceptText(persona: ConceptPersona, concept: CharacterConcept | null): { readonly background: string; readonly notes: string } {
  const parts: string[] = [];
  for (const part of [persona.description, persona.personality]) {
    const text = part.trim();
    if (text !== "" && !parts.includes(text)) parts.push(text);
  }
  const joined = parts.join("\n\n");
  const backstory = concept?.backstory ?? null;
  const notes = [backstory === null ? "" : joined, concept?.notes ?? ""].filter((part) => part !== "").join("\n\n");
  return { background: backstory ?? joined, notes };
}

export interface ConceptCharacterInput {
  readonly name: string;
  readonly system: string;
  readonly persona: ConceptPersona;
  /** Null: the sheet is rolled as `generateCharacter` rolls it, and only the persona is written. */
  readonly concept: CharacterConcept | null;
}

/** A new sheet of `spec`'s system: rolled, biased toward the concept when there is one, with the persona text. */
export function conceptCharacterSheet(spec: SheetSpec, source: unknown, random: RandomSource, input: ConceptCharacterInput): ConceptSheet {
  const generated = generateCharacter(spec, random, { name: input.name, system: input.system });
  const placed: ConceptSheet = input.concept === null ? { sheet: generated.sheet, method: "rolled" } : applyConcept(spec, source, generated.sheet, input.concept);
  const text = conceptText(input.persona, input.concept);
  return { sheet: Object.freeze({ ...placed.sheet, background: text.background, notes: text.notes }), method: placed.method };
}
