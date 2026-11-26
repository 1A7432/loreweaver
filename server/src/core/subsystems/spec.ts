/**
 * A rule pack's `subsystems:` section: the extra mechanics its system runs beyond the
 * basic check, each one binding an engine TEMPLATE to pack parameters and a pack-chosen
 * name. Compiled once, when the pack loads; a section that does not validate fails the
 * pack (`RulePackError`, path `subsystems.<name>...`).
 *
 * The templates are a small closed set:
 * - `check_with_loss`: roll the system's check against an attribute, then deduct the loss
 *   dice of the outcome (the horror-stress family);
 * - `improvement_check`: roll against a skill; on success it grows (experience ticks);
 * - `resource_spend_adjust`: spend points of an attribute to lower a recorded check's roll
 *   (the Luck family);
 * - `opposed`: two checks compared, by outcome tier (roll-under systems) or by total
 *   (meet-the-target systems; see `settle`);
 * - `table_draw`: one uniform draw from a pack table (madness, omens).
 * A pack key that declares `script` is a script flow, which needs the sandboxed rules
 * script lane; that lane is not built, so such a pack is refused.
 */

import type { CompiledExpr } from "../condexpr.ts";
import type { DiceExpression } from "../dice/index.ts";
import { FrozenMap } from "../resolution/index.ts";
import { foldCase, stripSpace } from "../sheets/text.ts";
import { field, type Raw, Reader } from "../rulepacks/raw.ts";

export const SUBSYSTEM_TEMPLATES = ["check_with_loss", "improvement_check", "resource_spend_adjust", "opposed", "table_draw"] as const;
export type SubsystemTemplate = (typeof SUBSYSTEM_TEMPLATES)[number];

export const MAX_SUBSYSTEMS = 16;
export const MAX_TABLE_ENTRIES = 64;
/** The longest `loss_ceiling.when` accepted, as for every pack expression. */
export const MAX_CEILING_LENGTH = 500;
/** Tool names the engine materializes itself; a pack subsystem may not take one. */
export const RESERVED_SUBSYSTEM_NAMES: ReadonlySet<string> = new Set(["module_action"]);

/** A subsystem key: an identifier (Unicode letters allowed), not starting with `_`. */
const SUBSYSTEM_NAME = /^[\p{L}\p{Nl}][\p{L}\p{Nl}\p{Mn}\p{Mc}\p{Nd}\p{Pc}]*$/u;

interface SubsystemBase {
  /** The pack key: also the tool/command name and the subsystem id on the wire. */
  readonly id: string;
  /** Display names by case-folded locale. */
  readonly labels: FrozenMap<string, string>;
}

export interface LossCeiling {
  /** Reads the call's `tag` and the sheet's canonical values (bare or as `stat_data.<name>`). */
  readonly when: CompiledExpr;
  readonly value: number;
}

export interface CheckWithLossSpec extends SubsystemBase {
  readonly template: "check_with_loss";
  /** Attribute storage key rolled against and deducted from (`SAN`). */
  readonly stat: string;
  /** Attribute storage key reported as the stat's maximum (`SANMAX`), or null. */
  readonly statMax: string | null;
  /** On a fumble: `all` loses the whole stat, `max` the loss notation's maximum. */
  readonly fumbleLoss: "all" | "max" | null;
  readonly lossCeiling: LossCeiling | null;
}

export interface ImprovementCheckSpec extends SubsystemBase {
  readonly template: "improvement_check";
  /** The improvement roll, compared to the skill value. */
  readonly roll: DiceExpression;
  /** The growth roll on success. */
  readonly improve: DiceExpression;
  /** The skill's ceiling: no roll at or above it, and growth stops at it. */
  readonly cap: number;
  /** A roll above this always grows the skill, whatever its value; null = no such rule. */
  readonly autoSuccessAbove: number | null;
}

export interface ResourceSpendSpec extends SubsystemBase {
  readonly template: "resource_spend_adjust";
  /** Attribute storage key paid from (`LUC`). */
  readonly stat: string;
}

/**
 * How an opposed check is settled. `outcome`: each side is graded against its own value
 * and the better rank wins (CoC). `total`: each side's value is the modifier on its roll
 * and the higher total wins, with no success/failure rank (D&D 5e contests: "instead of
 * comparing the total to a DC, they compare the totals of their two checks").
 */
export type OpposedSettle = "outcome" | "total";

export interface OpposedSpec extends SubsystemBase {
  readonly template: "opposed";
  /** As declared (`settle:`), else from the system's comparison: `<=` → outcome, `>=` → total. */
  readonly settle: OpposedSettle;
}

/** What the subsystem compiler needs to know about the rest of the pack. */
export interface SubsystemContext {
  /** The resolution's comparison; null for a pack without a resolution. */
  readonly compare: "<=" | ">=" | null;
}

export interface DrawTable {
  /** Case-folded id. */
  readonly id: string;
  readonly labels: FrozenMap<string, string>;
  /** Opaque game data, in pack order. */
  readonly entries: readonly string[];
  /** Case-folded, trimmed alternative references. */
  readonly aliases: readonly string[];
}

export interface TableDrawSpec extends SubsystemBase {
  readonly template: "table_draw";
  readonly tables: FrozenMap<string, DrawTable>;
  /** The table drawn from when the caller names none. */
  readonly defaultTable: string;
}

export type SubsystemSpec = CheckWithLossSpec | ImprovementCheckSpec | ResourceSpendSpec | OpposedSpec | TableDrawSpec;

const TEMPLATE_KEYS: Readonly<Record<SubsystemTemplate, readonly string[]>> = {
  check_with_loss: ["stat", "stat_max", "fumble_loss", "loss_ceiling"],
  improvement_check: ["roll", "improve", "cap", "auto_success_above"],
  resource_spend_adjust: ["stat"],
  opposed: ["settle"],
  table_draw: ["tables", "default"],
};

function isTemplate(value: unknown): value is SubsystemTemplate {
  return typeof value === "string" && (SUBSYSTEM_TEMPLATES as readonly string[]).includes(value);
}

/** An optional value: absent or null means "not given". */
function given(raw: Raw, key: string): unknown {
  const value = field(raw, key);
  return value === null ? undefined : value;
}

function compileTables(r: Reader, value: unknown, path: string): FrozenMap<string, DrawTable> {
  const raw = r.mapping(value, path);
  const ids = Object.keys(raw);
  if (ids.length === 0) r.fail("BAD_FIELD", path, "must declare at least one table");
  const tables: [string, DrawTable][] = [];
  for (const written of ids) {
    const at = `${path}.${written}`;
    const id = foldCase(stripSpace(written));
    if (id === "") r.fail("BAD_FIELD", at, "a table id must not be empty");
    if (tables.some(([seen]) => seen === id)) r.fail("DUPLICATE_ID", at, "table id declared twice (ids compare case-insensitively)");
    const spec = r.optionalMapping(raw[written], at);
    r.onlyKeys(spec, new Set(["display", "entries", "aliases"]), at);
    const entriesRaw = field(spec, "entries");
    if (!Array.isArray(entriesRaw) || entriesRaw.length === 0) r.fail("BAD_FIELD", `${at}.entries`, "must be a non-empty list");
    if (entriesRaw.length > MAX_TABLE_ENTRIES) r.fail("TOO_MANY", `${at}.entries`, `at most ${MAX_TABLE_ENTRIES} entries`);
    const entries = entriesRaw.map((entry: unknown, index: number) => r.string(entry, `${at}.entries[${index}]`));
    const aliases = r
      .stringList(field(spec, "aliases"), `${at}.aliases`)
      .map((alias) => foldCase(stripSpace(alias)))
      .filter((alias) => alias !== "");
    tables.push([
      id,
      Object.freeze({
        id,
        labels: new FrozenMap(r.localeTexts(field(spec, "display"), `${at}.display`)),
        entries: Object.freeze(entries),
        aliases: Object.freeze(aliases),
      }),
    ]);
  }
  return new FrozenMap(tables);
}

function compileOne(r: Reader, id: string, value: unknown, context: SubsystemContext): SubsystemSpec {
  const path = `subsystems.${id}`;
  const raw = r.mapping(value, path);
  // The script lane runs pack JavaScript in a sandbox. It is not built, and a stand-in
  // would run a different mechanic than the author wrote, so the pack does not load.
  if (Object.hasOwn(raw, "script")) r.fail("SCRIPT_UNSUPPORTED", `${path}.script`, "script flows need the rules-script lane, which is not supported");
  const template = field(raw, "template");
  if (!isTemplate(template)) r.fail("BAD_FIELD", `${path}.template`, `must be one of ${SUBSYSTEM_TEMPLATES.join(", ")}`);
  r.onlyKeys(raw, new Set(["template", "display", ...TEMPLATE_KEYS[template]]), path);
  const base = { id, labels: new FrozenMap(r.localeTexts(field(raw, "display"), `${path}.display`)) };

  switch (template) {
    case "check_with_loss": {
      const fumble = given(raw, "fumble_loss");
      if (fumble !== undefined && fumble !== "all" && fumble !== "max") r.fail("BAD_FIELD", `${path}.fumble_loss`, "must be all or max");
      let lossCeiling: LossCeiling | null = null;
      const ceilingRaw = given(raw, "loss_ceiling");
      if (ceilingRaw !== undefined) {
        const at = `${path}.loss_ceiling`;
        const ceiling = r.mapping(ceilingRaw, at);
        r.onlyKeys(ceiling, new Set(["when", "value"]), at);
        const whenText = r.text(field(ceiling, "when"), `${at}.when`);
        if (whenText.length > MAX_CEILING_LENGTH) r.fail("BAD_FIELD", `${at}.when`, `at most ${MAX_CEILING_LENGTH} characters`);
        const cap = r.integer(field(ceiling, "value"), `${at}.value`);
        if (cap < 0) r.fail("BAD_FIELD", `${at}.value`, "must be 0 or more");
        lossCeiling = Object.freeze({ when: r.expression(whenText, `${at}.when`), value: cap });
      }
      const statMax = given(raw, "stat_max");
      return Object.freeze({
        ...base,
        template,
        stat: r.text(field(raw, "stat"), `${path}.stat`),
        statMax: statMax === undefined ? null : r.text(statMax, `${path}.stat_max`),
        fumbleLoss: fumble ?? null,
        lossCeiling,
      });
    }
    case "improvement_check": {
      const cap = given(raw, "cap");
      const auto = given(raw, "auto_success_above");
      const roll = given(raw, "roll");
      const improve = given(raw, "improve");
      return Object.freeze({
        ...base,
        template,
        roll: r.notation(roll ?? "1d100", `${path}.roll`),
        improve: r.notation(improve ?? "1d10", `${path}.improve`),
        cap: cap === undefined ? 100 : r.integer(cap, `${path}.cap`),
        autoSuccessAbove: auto === undefined ? null : r.integer(auto, `${path}.auto_success_above`),
      });
    }
    case "resource_spend_adjust":
      return Object.freeze({ ...base, template, stat: r.text(field(raw, "stat"), `${path}.stat`) });
    case "opposed": {
      const settle = given(raw, "settle");
      if (settle !== undefined && settle !== "outcome" && settle !== "total") r.fail("BAD_FIELD", `${path}.settle`, "must be outcome or total");
      return Object.freeze({ ...base, template, settle: settle ?? (context.compare === ">=" ? "total" : "outcome") });
    }
    case "table_draw": {
      const tables = compileTables(r, field(raw, "tables"), `${path}.tables`);
      const defaultRaw = given(raw, "default");
      const first = tables.keys().next().value as string;
      const defaultTable = defaultRaw === undefined ? first : foldCase(r.text(defaultRaw, `${path}.default`));
      if (!tables.has(defaultTable)) r.fail("UNDECLARED", `${path}.default`, `names an undeclared table ${JSON.stringify(defaultTable)}`);
      return Object.freeze({ ...base, template, tables, defaultTable });
    }
  }
}

/**
 * Compiles a pack's `subsystems:` section (absent or null: none), in declared order.
 * Throws `RulePackError`.
 */
export function compileSubsystems(packId: string, section: unknown, context: SubsystemContext = { compare: null }): FrozenMap<string, SubsystemSpec> {
  const r = new Reader(packId);
  const raw = r.optionalMapping(section, "subsystems");
  const ids = Object.keys(raw);
  if (ids.length > MAX_SUBSYSTEMS) r.fail("TOO_MANY", "subsystems", `at most ${MAX_SUBSYSTEMS} subsystems`);
  const specs: [string, SubsystemSpec][] = [];
  for (const id of ids) {
    if (!SUBSYSTEM_NAME.test(id)) r.fail("BAD_ID", `subsystems.${id}`, "a subsystem name must be an identifier that does not start with '_'");
    if (RESERVED_SUBSYSTEM_NAMES.has(id)) r.fail("RESERVED_NAME", `subsystems.${id}`, "this name is reserved for the engine's own tool");
    specs.push([id, compileOne(r, id, raw[id], context)]);
  }
  return new FrozenMap(specs);
}

/**
 * The display name of a subsystem (or a draw table) for a viewer locale: its base
 * language, then `en`, then any declared label, then the id.
 */
export function localizedName(labels: ReadonlyMap<string, string>, locale: string | null | undefined, id: string): string {
  const base = foldCase(((locale ?? "") === "" ? "en" : (locale as string)).replaceAll("_", "-").split("-", 1)[0] ?? "");
  const found = labels.get(base) ?? labels.get("en") ?? labels.values().next().value;
  return found ?? id;
}
