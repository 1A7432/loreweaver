/**
 * What the subsystem flows share: finding the declared subsystem, reading and writing a
 * stat through the sheet layer, and rolling the system's check.
 */

import type { ResolutionErrorCode } from "../resolution/index.ts";
import { gradeCheck, ResolutionError, type CheckOutcome, type Resolution, type RolledCheck, rollCheck } from "../resolution/index.ts";
import type { RandomSource } from "../random.ts";
import type { RulePack } from "../rulepacks/types.ts";
import {
  attributeSlot,
  checkValue,
  evaluateSheet,
  hasCheckValue,
  refreshSheet,
  resolveName,
  type Sheet,
  type SheetSpec,
  setSheetValue,
  sheetValue,
  tableWith,
  type WriteRefusal,
} from "../sheets/index.ts";
import { stripSpace } from "../sheets/text.ts";
import type { SubsystemSpec, SubsystemTemplate } from "./spec.ts";

export type SubsystemCallErrorCode =
  /** The pack declares no subsystem with this id. */
  | "UNKNOWN_SUBSYSTEM"
  /** The subsystem exists but is bound to another template than the one called. */
  | "WRONG_TEMPLATE";

/**
 * A call the caller should never make: a subsystem id the pack does not declare, or a
 * request for another template. Content problems (an unknown skill, too few points) are
 * never thrown; they come back as a refusal in the result.
 */
export class SubsystemCallError extends Error {
  readonly code: SubsystemCallErrorCode;
  readonly packId: string;
  readonly subsystem: string;

  constructor(code: SubsystemCallErrorCode, packId: string, subsystem: string, detail: string) {
    super(`${code}: rule pack '${packId}': subsystem '${subsystem}': ${detail}`);
    this.name = "SubsystemCallError";
    this.code = code;
    this.packId = packId;
    this.subsystem = subsystem;
  }
}

/** The declared subsystem `id`, which must be bound to `template`. */
export function subsystemOf<T extends SubsystemTemplate>(pack: RulePack, id: string, template: T): Extract<SubsystemSpec, { template: T }> {
  const spec = pack.subsystems.get(id);
  if (spec === undefined) throw new SubsystemCallError("UNKNOWN_SUBSYSTEM", pack.id, id, "not declared by this pack");
  if (spec.template !== template) throw new SubsystemCallError("WRONG_TEMPLATE", pack.id, id, `bound to ${spec.template}, called as ${template}`);
  return spec as Extract<SubsystemSpec, { template: T }>;
}

/** The pack's resolution; the loader refuses a check-rolling subsystem in a pack without one. */
export function resolutionOf(pack: RulePack, id: string): Resolution {
  if (pack.resolution === null) throw new SubsystemCallError("WRONG_TEMPLATE", pack.id, id, "the pack declares no resolution");
  return pack.resolution;
}

/** An attribute slot's value by storage key (a derived slot evaluates), or null when the sheet has none. */
export function readAttribute(spec: SheetSpec, sheet: Sheet, key: string): number | null {
  const read = attributeSlot(spec, sheet, evaluateSheet(spec, sheet), key);
  return read.kind === "value" ? read.value : null;
}

export interface Written {
  readonly sheet: Sheet;
  /** Why the sheet layer refused the write; the sheet is then unchanged. */
  readonly refused: WriteRefusal | null;
}

/**
 * Writes an attribute slot by storage key. A slot that a canonical name maps to goes
 * through the sheet layer's `setSheetValue` (refresh, vital clamps, derived slots
 * refused); a slot no canonical name declares is written as it stands and refreshed.
 */
export function writeAttribute(spec: SheetSpec, sheet: Sheet, key: string, value: number): Written {
  const shape = spec.shape;
  if (shape !== null) {
    for (const [canonical, slot] of shape.attrKeys) {
      if (slot === key) return fromWrite(sheet, setSheetValue(spec, sheet, canonical, value));
    }
    if (shape.derivedAttrs.has(key)) return { sheet, refused: "derived_slot" };
  }
  const updated = Object.freeze({ ...sheet, attributes: tableWith(sheet.attributes, key, value) });
  return { sheet: refreshSheet(spec, updated).sheet, refused: null };
}

/** Writes a stat by canonical name through the sheet layer. */
export function writeStat(spec: SheetSpec, sheet: Sheet, canonical: string, value: number): Written {
  return fromWrite(sheet, setSheetValue(spec, sheet, canonical, value));
}

function fromWrite(sheet: Sheet, write: ReturnType<typeof setSheetValue>): Written {
  return write.ok ? { sheet: write.sheet, refused: null } : { sheet, refused: write.code };
}

export type StatLookup =
  | { readonly ok: true; readonly canonical: string; readonly value: number }
  /** `unknown`: no alias names it and the sheet has nothing under it; `not_numeric`: it reads as text or its formula failed. */
  | { readonly ok: false; readonly reason: "unknown" | "not_numeric" };

/**
 * A typed stat name read for a check: resolved through the pack's aliases, then read by
 * the sheet layer (stored value, else derivation, else pack default). A name nothing
 * knows is refused rather than read as 0: a check against 0 is a check that cannot fail
 * (or cannot succeed). A name the pack knows without any value or default reads 0.
 * `forCheck` reads through the pack's `check_values` bridge (an ability check rolling its
 * modifier).
 */
export function lookupStat(spec: SheetSpec, sheet: Sheet, name: string, forCheck: boolean): StatLookup {
  const typed = stripSpace(name);
  if (typed === "") return { ok: false, reason: "unknown" };
  const canonical = resolveName(spec, typed) ?? typed;
  const read = forCheck ? checkValue(spec, sheet, canonical) : sheetValue(spec, sheet, canonical);
  if (read.kind === "value") return { ok: true, canonical, value: read.value };
  if (read.kind === "unset") {
    // `hasCheckValue` misses a derived skill that has no alias entry; a value read above
    // already covered that case, so this only decides known-but-unset names.
    return hasCheckValue(spec, sheet, typed) ? { ok: true, canonical, value: 0 } : { ok: false, reason: "unknown" };
  }
  return { ok: false, reason: "not_numeric" };
}

export interface GradedRoll {
  readonly check: RolledCheck;
  readonly outcome: CheckOutcome;
}

/** Rolls the system's check (no modifiers; parameters at their defaults) and grades it against `target`. */
export function rollAndGrade(
  resolution: Resolution,
  random: RandomSource,
  target: number,
  variant: string | null | undefined,
): { readonly ok: true; readonly roll: GradedRoll } | { readonly ok: false; readonly errorCode: ResolutionErrorCode } {
  try {
    const check = rollCheck(resolution, random);
    return { ok: true, roll: Object.freeze({ check, outcome: gradeCheck(resolution, check, { target, variant: variant ?? null }) }) };
  } catch (error) {
    if (error instanceof ResolutionError) return { ok: false, errorCode: error.code };
    throw error;
  }
}
