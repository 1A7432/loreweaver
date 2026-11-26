/**
 * Compiling one rule pack's YAML into a frozen `RulePack`.
 *
 * Every section is checked here, where an error can still point at the author's text:
 * the layers below compile their own sections (`resolution:` by `core/resolution`, the
 * sheet-related sections by `core/sheets`, `subsystems:` by `core/subsystems`) and their
 * errors are wrapped into one `RulePackError`; the remaining sections are read here.
 * Cross-section rules come last: a command must name a declared subsystem, a subsystem
 * that rolls the system's check needs a `resolution:`, nothing may write a derived slot.
 *
 * Unknown TOP-LEVEL keys are ignored, as the reference loader did (it only ever looked
 * up the keys it knew) and as the format specifies, so a newer pack's extra section does
 * not stop an older engine; the closed blocks inside a pack refuse unknown keys.
 */

import { DiceError, type DiceExpression, parseDice } from "../dice/index.ts";
import { compileResolution, FrozenMap, type Resolution, ResolutionError } from "../resolution/index.ts";
import { compileSheetSpec, type JsonObject, type JsonValue, type SheetPackSource, type SheetSpec, SheetSpecError } from "../sheets/index.ts";
import { compileSubsystems, type SubsystemSpec } from "../subsystems/spec.ts";
import { loadYaml, YamlError } from "../yaml.ts";
import { RulePackError } from "./errors.ts";
import { type BaseDocumentLoader, resolveExtends } from "./extends.ts";
import { commandWord } from "./registry.ts";
import { cloneData, deepFreeze, field, isRecord, localeKey, type Raw, Reader } from "./raw.ts";
import { BUILT_IN_SOURCES } from "./sources.ts";
import type { CommandBinding, RankLabel, RulePack, TurnCheck } from "./types.ts";

/** A pack id: the slug a pack's rule-pack file stem must be. */
export const PACK_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Where `extends:` bases come from: a base's YAML text (or parsed document) by id, or null. */
export type BaseSource = (id: string) => string | Raw | null;

export interface CompileOptions {
  /**
   * Looks up `extends:` bases by id. Default: the built-in packs. A caller loading a
   * content pack passes a lookup that tries the pack's own rule packs first, then this
   * default (the format's lookup order).
   */
  readonly bases?: BaseSource;
}

/** The built-in packs as `extends:` bases. */
export function builtInBase(id: string): string | null {
  return BUILT_IN_SOURCES.get(id) ?? null;
}

const TURN_CHECK_KEYS = new Set(["id", "when", "condition", "instruction", "max_rounds", "enabled"]);
const COMMAND_KEYS = new Set(["action", "tool", "args"]);
/** Templates that roll the system's check, so need its `resolution:`. */
const CHECK_TEMPLATES = new Set(["check_with_loss", "resource_spend_adjust", "opposed"]);

function parseDocument(packId: string, text: string, path: string): Raw {
  let parsed: unknown;
  try {
    parsed = loadYaml(text);
  } catch (error) {
    if (error instanceof YamlError) throw new RulePackError("BAD_YAML", packId, path, error.message, { cause: error, layerCode: error.code });
    throw error;
  }
  // An empty document is an empty pack, as the reference loader read it.
  if (parsed === null || parsed === undefined) return {};
  if (!isRecord(parsed)) throw new RulePackError("NOT_A_MAPPING", packId, path, "the document must be a mapping");
  return parsed;
}

function wrapResolution(packId: string, section: unknown): Resolution {
  try {
    return compileResolution(packId, section);
  } catch (error) {
    if (!(error instanceof ResolutionError)) throw error;
    const code = error.code === "SCRIPT_UNSUPPORTED" ? "SCRIPT_UNSUPPORTED" : "BAD_RESOLUTION";
    throw new RulePackError(code, packId, error.path ?? "resolution", error.message, { cause: error, layerCode: error.code });
  }
}

function wrapSheet(packId: string, document: Raw): SheetSpec {
  try {
    return compileSheetSpec(packId, document as SheetPackSource);
  } catch (error) {
    if (!(error instanceof SheetSpecError)) throw error;
    throw new RulePackError("BAD_SHEET", packId, error.where, error.message, { cause: error, layerCode: error.code });
  }
}

function compileLabels(r: Reader, value: unknown): FrozenMap<string, FrozenMap<string, RankLabel>> {
  const raw = r.optionalMapping(value, "labels");
  const out = new Map<string, FrozenMap<string, RankLabel>>();
  for (const locale of Object.keys(raw)) {
    const path = `labels.${locale}`;
    const key = localeKey(locale);
    if (out.has(key)) r.fail("DUPLICATE_ID", path, "locale declared twice (locales compare case-insensitively)");
    const table = r.mapping(raw[locale], path);
    const ranks: [string, RankLabel][] = [];
    for (const rankId of Object.keys(table)) {
      const at = `${path}.${rankId}`;
      const spec = table[rankId];
      let label: RankLabel;
      if (typeof spec === "string") {
        // A bare string is both the display text and its one marker.
        label = { display: spec, markers: Object.freeze([spec]) };
      } else if (Array.isArray(spec)) {
        const words = r.stringList(spec, at);
        if (words.length === 0) r.fail("BAD_FIELD", at, "a label list must not be empty");
        label = { display: words[0] as string, markers: words };
      } else if (isRecord(spec)) {
        r.onlyKeys(spec, new Set(["display", "markers"]), at);
        label = { display: r.string(field(spec, "display"), `${at}.display`), markers: r.stringList(field(spec, "markers"), `${at}.markers`) };
      } else {
        r.fail("BAD_FIELD", at, "a label is a string, a list of strings or {display, markers}");
      }
      ranks.push([rankId, Object.freeze(label)]);
    }
    out.set(key, new FrozenMap(ranks));
  }
  return new FrozenMap(out);
}

function compileCommands(r: Reader, value: unknown, subsystems: FrozenMap<string, SubsystemSpec>): FrozenMap<string, CommandBinding> {
  const raw = r.optionalMapping(value, "commands");
  const out = new Map<string, CommandBinding>();
  for (const written of Object.keys(raw)) {
    const path = `commands.${written}`;
    const word = commandWord(written);
    if (word === "") r.fail("BAD_FIELD", path, "a command word must not be empty");
    if (out.has(word)) r.fail("DUPLICATE_ID", path, "command word declared twice (words compare case-insensitively)");
    const spec = r.mapping(raw[written], path);
    r.onlyKeys(spec, COMMAND_KEYS, path);
    const action = field(spec, "action");
    const tool = field(spec, "tool");
    const hasAction = action !== undefined && action !== null && action !== "";
    const hasTool = tool !== undefined && tool !== null && tool !== "";
    if (hasAction === hasTool) r.fail("BAD_FIELD", path, "needs exactly one of action and tool");
    if (hasAction) {
      if (action !== "check" && action !== "make_char") r.fail("BAD_FIELD", `${path}.action`, "must be check or make_char");
      if (field(spec, "args") !== undefined) r.fail("UNKNOWN_KEY", `${path}.args`, "args go with a tool binding only");
      out.set(word, Object.freeze({ kind: "action", action }));
      continue;
    }
    const name = r.string(tool, `${path}.tool`);
    if (!subsystems.has(name)) r.fail("UNDECLARED", `${path}.tool`, `names an undeclared subsystem ${JSON.stringify(name)}`);
    const args = r.optionalMapping(field(spec, "args"), `${path}.args`);
    out.set(word, Object.freeze({ kind: "tool", tool: name, args: args as JsonObject }));
  }
  return new FrozenMap(out);
}

function compileTurnChecks(r: Reader, value: unknown): readonly TurnCheck[] {
  if (value === undefined || value === null) return Object.freeze([]);
  if (!Array.isArray(value)) r.fail("BAD_FIELD", "turn_checks", "must be a list of check rows");
  return Object.freeze(
    value.map((entry: unknown, index: number): TurnCheck => {
      const path = `turn_checks[${index}]`;
      const row = r.mapping(entry, path);
      r.onlyKeys(row, TURN_CHECK_KEYS, path);
      const when = field(row, "when");
      const condition = r.text(when === undefined || when === null || when === "" ? field(row, "condition") : when, `${path}.when`);
      const rounds = field(row, "max_rounds");
      const maxRounds = rounds === undefined || rounds === null ? null : r.integer(rounds, `${path}.max_rounds`);
      if (maxRounds !== null && maxRounds < 1) r.fail("BAD_FIELD", `${path}.max_rounds`, "must be a positive integer");
      const id = field(row, "id");
      const enabled = field(row, "enabled");
      return Object.freeze({
        id: id === undefined || id === null ? null : r.text(id, `${path}.id`),
        condition,
        instruction: new FrozenMap(r.localeTexts(field(row, "instruction"), `${path}.instruction`)),
        maxRounds,
        enabled: enabled === undefined || enabled === null ? true : r.boolean(enabled, `${path}.enabled`),
      });
    }),
  );
}

/** Cross-section rules: what one section requires of another. */
function checkCrossSections(r: Reader, resolution: Resolution | null, sheet: SheetSpec, subsystems: FrozenMap<string, SubsystemSpec>): void {
  const derivedAttrs = sheet.shape?.derivedAttrs;
  for (const spec of subsystems.values()) {
    const path = `subsystems.${spec.id}`;
    if (CHECK_TEMPLATES.has(spec.template) && resolution === null) {
      r.fail("NEEDS_RESOLUTION", `${path}.template`, `${spec.template} rolls the system's check, and the pack declares no resolution`);
    }
    // These templates write their stat back; a derived attribute slot is never stored.
    if ((spec.template === "check_with_loss" || spec.template === "resource_spend_adjust") && derivedAttrs?.has(spec.stat)) {
      r.fail("DERIVED_SLOT", `${path}.stat`, `'${spec.stat}' is a derived attribute slot, which is never written`);
    }
  }
  for (const [key, constraint] of sheet.constraints.attributes) {
    if (constraint.roll === null) continue;
    const path = `creation_constraints.attributes.${key}.roll`;
    try {
      parseDice(constraint.roll);
    } catch (error) {
      if (error instanceof DiceError) r.fail("BAD_NOTATION", path, `does not parse (${error.message})`, error, error.code);
      throw error;
    }
    if (derivedAttrs?.has(key)) r.fail("DERIVED_SLOT", path, `'${key}' is a derived attribute slot, which is never written`);
  }
}

/**
 * Compiles the rule pack `id` from its YAML text (or an already parsed document).
 * Throws `RulePackError` for anything that keeps the pack from loading.
 */
export function compileRulePack(id: string, source: string | Raw, options: CompileOptions = {}): RulePack {
  if (!PACK_ID.test(id)) throw new RulePackError("BAD_ID", id, "(root)", "a pack id is a slug (a-z 0-9, then a-z 0-9 -, at most 64)");
  const bases = options.bases ?? builtInBase;
  const raw = typeof source === "string" ? parseDocument(id, source, "(root)") : cloneData(source);
  if (!isRecord(raw)) throw new RulePackError("NOT_A_MAPPING", id, "(root)", "the document must be a mapping");
  const loadBase: BaseDocumentLoader = (baseId) => {
    const base = bases(baseId);
    if (base === null) return null;
    if (typeof base === "string") return parseDocument(id, base, `extends(${baseId})`);
    const copy = cloneData(base);
    return isRecord(copy) ? copy : base;
  };
  const document = deepFreeze(resolveExtends(id, raw, loadBase));
  const r = new Reader(id);

  const resolutionRaw = field(document, "resolution");
  const resolution = resolutionRaw === undefined || resolutionRaw === null ? null : wrapResolution(id, resolutionRaw);
  const sheet = wrapSheet(id, document);
  const subsystems = compileSubsystems(id, field(document, "subsystems"), { compare: resolution?.compare ?? null });
  checkCrossSections(r, resolution, sheet, subsystems);

  const initiativeRaw = field(document, "initiative");
  let initiative: DiceExpression | null = null;
  if (initiativeRaw !== undefined && initiativeRaw !== null) {
    const section = r.mapping(initiativeRaw, "initiative");
    initiative = r.notation(field(section, "roll"), "initiative.roll");
  }
  const stShow = field(document, "st_show");

  return Object.freeze({
    id,
    names: r.stringList(field(document, "names"), "names"),
    setKeys: r.stringList(field(document, "set_keys"), "set_keys"),
    resolution,
    sheet,
    labels: compileLabels(r, field(document, "labels")),
    commands: compileCommands(r, field(document, "commands"), subsystems),
    initiative,
    subsystems,
    expertise: new FrozenMap(r.localeTexts(field(document, "expertise"), "expertise")),
    turnChecks: compileTurnChecks(r, field(document, "turn_checks")),
    stShow: stShow === undefined ? null : (stShow as JsonValue),
    source: document as JsonObject,
  });
}
