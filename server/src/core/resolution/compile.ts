/**
 * Compiling a rule pack's `resolution:` section into a frozen `Resolution`.
 *
 * Everything that can be checked without a roll is checked here, where the error can
 * point at the author's text: the shape of every entry, every expression's syntax and
 * the names it reads (statically, from `references`, because a short-circuited `&&`
 * would hide a misspelt name from any dry run), every dice notation and the `{slot}`s it
 * uses. A section that compiles can then only fail at grading time on what the CALLER
 * supplies (no target, too few dice) or on a value an expression cannot compute.
 *
 * The section is passed in as parsed data (`loadYaml` output); this module knows nothing
 * about the rest of a pack.
 */

import { compile, type CompiledExpr, ExprError, type FunctionName } from "../condexpr.ts";
import { DiceError, type DiceExpression, type DiceOp, type Expr, type IntTerm, parseDice } from "../dice/index.ts";
import { ResolutionError } from "./errors.ts";
import {
  type CheckDefaults,
  type Compare,
  type Difficulty,
  FrozenMap,
  type Ladder,
  type ParamSpec,
  type Rank,
  type RankRule,
  type Resolution,
  type RollModifier,
  type TargetKind,
} from "./types.ts";

/** The section's own format version; a pack declaring another is refused. */
export const RESOLUTION_VERSION = 1;

export const MAX_RANKS = 32;
export const MAX_VARIANTS = 32;
export const MAX_DIFFICULTIES = 16;

/** Rank conditions, target transforms and margins: pure arithmetic helpers, no `if`. */
const RULE_FUNCTIONS: readonly FunctionName[] = ["floor", "ceil", "min", "max", "abs"];

const SLUG = /^[a-z][a-z0-9_]{0,31}$/;
const DICE_NAME = /^dice\.(?:0|[1-9][0-9]*)$/;

/**
 * The closed namespace a ladder or margin reads: `roll` (total plus modifier), `dice.<i>`
 * (kept natural faces), `target` (difficulty-adjusted), `raw_target`, `modifier`,
 * `successes`, `ones`.
 */
const CHECK_NAMES = new Set(["roll", "target", "raw_target", "modifier", "successes", "ones"]);
/** A difficulty transform runs before any roll: it sees the target and nothing else. */
const TRANSFORM_NAMES = new Set(["target", "raw_target"]);
/** Names that exist only when a check has a target, which a `target: none` system never has. */
const TARGET_NAMES = new Set(["target", "raw_target"]);

const SECTION_KEYS = new Set([
  "version",
  "roll",
  "target",
  "compare",
  "modifiers",
  "ranks",
  "variants",
  "difficulties",
  "params",
  "margin",
  "check",
  "script",
]);
const RANK_KEYS = new Set(["id", "when", "success", "critical", "fumble", "tier"]);
const DIFFICULTY_KEYS = new Set(["target", "prefixes"]);
const PARAM_KEYS = new Set(["min", "max", "default"]);
const MODIFIER_KEYS = new Set(["roll", "tens_reroll"]);
const CHECK_KEYS = new Set(["favorable", "unfavorable", "default_target", "proficiency", "default_skill"]);

type Raw = Readonly<Record<string, unknown>>;

/** Per-compile context, so every diagnostic names the pack. */
class Compiler {
  readonly packId: string;
  forbidTarget = false;
  declaredParams: ReadonlySet<string> = new Set();

  constructor(packId: string) {
    this.packId = packId;
  }

  fail(code: ConstructorParameters<typeof ResolutionError>[0], path: string, detail: string, cause?: unknown): never {
    throw new ResolutionError(code, detail, { packId: this.packId, path, cause });
  }

  /** A plain mapping (what `loadYaml` produces), or a failure. */
  mapping(value: unknown, path: string): Raw {
    if (!isRecord(value)) this.fail("BAD_FIELD", path, "must be a mapping");
    return value;
  }

  /** An optional mapping: absent or null reads as empty. */
  optionalMapping(value: unknown, path: string): Raw {
    return value === undefined || value === null ? {} : this.mapping(value, path);
  }

  noUnknownKeys(raw: Raw, allowed: ReadonlySet<string>, path: string): void {
    const unknown = Object.keys(raw).filter((key) => !allowed.has(key));
    if (unknown.length > 0) this.fail("UNKNOWN_KEY", path, `unknown key(s) ${unknown.map((key) => JSON.stringify(key)).join(", ")}`);
  }

  slug(id: string, path: string, what: string): string {
    if (!SLUG.test(id)) this.fail("BAD_ID", path, `${what} ${JSON.stringify(id)} must be a slug (a-z, then a-z 0-9 _, at most 32)`);
    return id;
  }

  integer(value: unknown, path: string): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) this.fail("BAD_FIELD", path, "must be an integer");
    return value;
  }

  optionalString(value: unknown, path: string): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== "string") this.fail("BAD_FIELD", path, "must be a string");
    const text = value.trim();
    return text === "" ? null : text;
  }

  /**
   * Compiles one expression and checks the names it reads against what its context can
   * supply: `allowed` (plus `dice.<i>` when `dice` is set).
   */
  expression(value: unknown, path: string, allowed: ReadonlySet<string>, dice: boolean): CompiledExpr {
    if (typeof value !== "string" || value.trim() === "") this.fail("BAD_FIELD", path, "must be a non-empty expression string");
    let compiled: CompiledExpr;
    try {
      compiled = compile(value, { functions: RULE_FUNCTIONS });
    } catch (error) {
      if (error instanceof ExprError) this.fail("BAD_EXPRESSION", path, error.message, error);
      throw error;
    }
    const unknown = compiled.references.filter((name) => !allowed.has(name) && !(dice && DICE_NAME.test(name)));
    if (unknown.length > 0) this.fail("UNKNOWN_NAME", path, `reads ${unknown.map((name) => JSON.stringify(name)).join(", ")}, which a check never supplies here`);
    if (this.forbidTarget) {
      const banned = compiled.references.filter((name) => TARGET_NAMES.has(name));
      if (banned.length > 0) this.fail("TARGET_FORBIDDEN", path, `reads ${banned.join(", ")}, but resolution.target is 'none': a targetless check has no target`);
    }
    return compiled;
  }

  /** Parses dice notation and checks its `{slot}`s are declared parameters. */
  notation(value: unknown, path: string): DiceExpression {
    if (typeof value !== "string" || value.trim() === "") this.fail("BAD_FIELD", path, "must be a dice notation string");
    let parsed: DiceExpression;
    try {
      parsed = parseDice(value.trim());
    } catch (error) {
      if (error instanceof DiceError) this.fail("BAD_NOTATION", path, `does not parse (${error.message})`, error);
      throw error;
    }
    const undeclared = [...slotNames(parsed.root)].filter((name) => !this.declaredParams.has(name));
    if (undeclared.length > 0) this.fail("UNDECLARED_PARAM", path, `uses slot(s) ${undeclared.map((name) => `{${name}}`).join(", ")} not declared under resolution.params`);
    return parsed;
  }
}

/**
 * Compiles one `resolution:` section. Throws `ResolutionError` (with `packId` and `path`)
 * on any malformed entry: a pack whose resolution does not compile does not load.
 */
export function compileResolution(packId: string, section: unknown): Resolution {
  const c = new Compiler(packId);
  const raw = c.mapping(section, "resolution");
  c.noUnknownKeys(raw, SECTION_KEYS, "resolution");

  const version = field(raw, "version");
  if (version !== undefined && version !== RESOLUTION_VERSION) {
    c.fail("UNSUPPORTED_VERSION", "resolution.version", `${JSON.stringify(version)} is not a version this engine reads (${RESOLUTION_VERSION})`);
  }
  // The script lane runs pack JavaScript in a sandbox; this layer grades by ladders only,
  // so a pack that needs a script is refused here rather than graded by a stand-in.
  if (field(raw, "script") !== undefined && field(raw, "script") !== null) {
    c.fail("SCRIPT_UNSUPPORTED", "resolution.script", "the script lane is not supported; declare rank ladders instead");
  }

  const targetKind = orDefault(field(raw, "target"), "skill");
  if (targetKind !== "skill" && targetKind !== "dc" && targetKind !== "none") {
    c.fail("BAD_FIELD", "resolution.target", "must be one of skill, dc, none");
  }
  const compare = orDefault(field(raw, "compare"), "<=");
  if (compare !== "<=" && compare !== ">=") c.fail("BAD_FIELD", "resolution.compare", "must be '<=' or '>='");
  c.forbidTarget = targetKind === "none";

  // Parameters first: the notations below may only use declared slots.
  const params = compileParams(c, field(raw, "params"));
  c.declaredParams = new Set(params.keys());
  const roll = c.notation(field(raw, "roll"), "resolution.roll");
  const modifiers = compileModifiers(c, field(raw, "modifiers"));

  const ladder = compileLadder(c, field(raw, "ranks"), "resolution.ranks");
  const variantsRaw = c.optionalMapping(field(raw, "variants"), "resolution.variants");
  const variantIds = Object.keys(variantsRaw);
  if (variantIds.length > MAX_VARIANTS) c.fail("TOO_MANY", "resolution.variants", `at most ${MAX_VARIANTS} variants`);
  const variants: [string, Ladder][] = [];
  for (const id of variantIds) {
    const path = `resolution.variants.${id}`;
    c.slug(id, path, "variant id");
    const spec = c.mapping(variantsRaw[id], path);
    c.noUnknownKeys(spec, new Set(["ranks"]), path);
    if (!Object.hasOwn(spec, "ranks")) c.fail("BAD_FIELD", path, "must declare 'ranks'");
    variants.push([id, compileLadder(c, spec.ranks, `${path}.ranks`)]);
  }

  const marginRaw = field(raw, "margin");
  const margin = marginRaw === undefined || marginRaw === null ? null : c.expression(marginRaw, "resolution.margin", CHECK_NAMES, true);

  return Object.freeze({
    packId,
    roll,
    targetKind: targetKind as TargetKind,
    compare: compare as Compare,
    modifiers,
    ladder,
    variants: new FrozenMap(variants),
    difficulties: compileDifficulties(c, field(raw, "difficulties")),
    params,
    margin,
    check: compileCheck(c, field(raw, "check"), modifiers),
  });
}

function compileLadder(c: Compiler, value: unknown, path: string): Ladder {
  if (!Array.isArray(value) || value.length === 0) c.fail("BAD_FIELD", path, "must be a non-empty list of rank rules");
  if (value.length > MAX_RANKS) c.fail("TOO_MANY", path, `at most ${MAX_RANKS} ranks`);
  const rules: RankRule[] = [];
  value.forEach((entry: unknown, index: number) => {
    const at = `${path}[${index}]`;
    const spec = c.mapping(entry, at);
    c.noUnknownKeys(spec, RANK_KEYS, at);
    const id = spec.id;
    if (typeof id !== "string") c.fail("BAD_ID", at, "needs a slug 'id'");
    c.slug(id, `${at}.id`, "rank id");
    const flag = (name: "success" | "critical" | "fumble"): boolean => {
      const raw = field(spec, name);
      if (raw === undefined) return false;
      if (typeof raw !== "boolean") c.fail("BAD_FIELD", `${at}.${name}`, "must be a boolean");
      return raw;
    };
    // An undeclared tier counts down from the top: the first rule is the best outcome.
    const tier = orDefault(field(spec, "tier"), value.length - 1 - index);
    if (typeof tier !== "number" || !Number.isSafeInteger(tier) || tier < 0 || tier > MAX_RANKS) {
      c.fail("BAD_FIELD", `${at}.tier`, `must be an integer 0..${MAX_RANKS}`);
    }
    const whenRaw = field(spec, "when");
    const when = whenRaw === undefined || whenRaw === null ? null : c.expression(whenRaw, `${at}.when`, CHECK_NAMES, true);
    const rank: Rank = Object.freeze({ id, tier, success: flag("success"), critical: flag("critical"), fumble: flag("fumble") });
    rules.push(Object.freeze({ rank, when }));
  });
  // Exactly one unconditional rule, last: every roll grades, and no rule is dead code.
  if (rules[rules.length - 1]?.when !== null) c.fail("BAD_LADDER", path, "must end with an unconditional fallback rule (no 'when')");
  const early = rules.findIndex((rule, index) => rule.when === null && index < rules.length - 1);
  if (early !== -1) c.fail("BAD_LADDER", `${path}[${early}]`, "an unconditional rule may only come last");
  return Object.freeze(rules);
}

function compileDifficulties(c: Compiler, value: unknown): FrozenMap<string, Difficulty> {
  const raw = c.optionalMapping(value, "resolution.difficulties");
  const ids = Object.keys(raw);
  if (ids.length > MAX_DIFFICULTIES) c.fail("TOO_MANY", "resolution.difficulties", `at most ${MAX_DIFFICULTIES} difficulties`);
  const entries: [string, Difficulty][] = [];
  for (const id of ids) {
    const path = `resolution.difficulties.${id}`;
    c.slug(id, path, "difficulty id");
    const spec = c.optionalMapping(raw[id], path);
    c.noUnknownKeys(spec, DIFFICULTY_KEYS, path);
    const targetRaw = field(spec, "target");
    // A transform is evaluated where only the target is known, so it reads nothing else.
    const target = targetRaw === undefined || targetRaw === null ? null : c.expression(targetRaw, `${path}.target`, TRANSFORM_NAMES, false);
    const prefixesRaw = c.optionalMapping(field(spec, "prefixes"), `${path}.prefixes`);
    const prefixes: [string, readonly string[]][] = [];
    const seen = new Set<string>();
    for (const locale of Object.keys(prefixesRaw)) {
      const at = `${path}.prefixes.${locale}`;
      const key = locale.toLowerCase();
      if (seen.has(key)) c.fail("DUPLICATE_ID", at, "locale declared twice (locales compare case-insensitively)");
      seen.add(key);
      const words = prefixesRaw[locale];
      if (words !== null && words !== undefined && !Array.isArray(words)) c.fail("BAD_FIELD", at, "must be a list of words");
      const list: string[] = [];
      for (const word of words ?? []) {
        if (typeof word !== "string") c.fail("BAD_FIELD", at, "words must be strings");
        if (word.trim() !== "") list.push(word);
      }
      prefixes.push([key, Object.freeze(list)]);
    }
    entries.push([id, Object.freeze({ id, target, prefixes: new FrozenMap(prefixes) })]);
  }
  return new FrozenMap(entries);
}

function compileParams(c: Compiler, value: unknown): FrozenMap<string, ParamSpec> {
  const raw = c.optionalMapping(value, "resolution.params");
  const entries: [string, ParamSpec][] = [];
  for (const id of Object.keys(raw)) {
    const path = `resolution.params.${id}`;
    c.slug(id, path, "parameter id");
    const spec = c.mapping(raw[id], path);
    c.noUnknownKeys(spec, PARAM_KEYS, path);
    const min = c.integer(field(spec, "min"), `${path}.min`);
    const max = c.integer(field(spec, "max"), `${path}.max`);
    if (max < min) c.fail("BAD_RANGE", path, "max is below min");
    const defaultRaw = field(spec, "default");
    // A default outside the range is allowed: it is clamped like any value.
    const fallback = defaultRaw === undefined || defaultRaw === null ? null : c.integer(defaultRaw, `${path}.default`);
    entries.push([id, Object.freeze({ id, min, max, default: fallback })]);
  }
  return new FrozenMap(entries);
}

function compileModifiers(c: Compiler, value: unknown): FrozenMap<string, RollModifier> {
  const raw = c.optionalMapping(value, "resolution.modifiers");
  const entries: [string, RollModifier][] = [];
  for (const name of Object.keys(raw)) {
    const path = `resolution.modifiers.${name}`;
    c.slug(name, path, "modifier name");
    const spec = c.mapping(raw[name], path);
    c.noUnknownKeys(spec, MODIFIER_KEYS, path);
    const rollRaw = field(spec, "roll");
    const roll = rollRaw === undefined ? null : c.notation(rollRaw, `${path}.roll`);
    const tensRaw = field(spec, "tens_reroll");
    if (tensRaw !== undefined && tensRaw !== "keep_lowest" && tensRaw !== "keep_highest") {
      c.fail("BAD_FIELD", `${path}.tens_reroll`, "must be keep_lowest or keep_highest");
    }
    entries.push([name, Object.freeze({ name, roll, tensReroll: tensRaw ?? null })]);
  }
  return new FrozenMap(entries);
}

function compileCheck(c: Compiler, value: unknown, modifiers: FrozenMap<string, RollModifier>): CheckDefaults {
  const raw = c.optionalMapping(value, "resolution.check");
  c.noUnknownKeys(raw, CHECK_KEYS, "resolution.check");
  const route = (key: "favorable" | "unfavorable"): string | null => {
    const name = c.optionalString(field(raw, key), `resolution.check.${key}`);
    if (name !== null && !modifiers.has(name)) c.fail("UNDECLARED_MODIFIER", `resolution.check.${key}`, `routes to undeclared modifier ${JSON.stringify(name)}`);
    return name;
  };
  const targetRaw = field(raw, "default_target");
  return Object.freeze({
    favorable: route("favorable"),
    unfavorable: route("unfavorable"),
    defaultTarget: targetRaw === undefined || targetRaw === null ? null : c.integer(targetRaw, "resolution.check.default_target"),
    proficiency: c.optionalString(field(raw, "proficiency"), "resolution.check.proficiency"),
    defaultSkill: c.optionalString(field(raw, "default_skill"), "resolution.check.default_skill"),
  });
}

/** A key that is ABSENT takes its default; an explicit null is a value, and fails validation like any other wrong value. */
function orDefault(value: unknown, fallback: unknown): unknown {
  return value === undefined ? fallback : value;
}

/** An own property of parsed data; never an inherited member. */
function field(raw: Raw, key: string): unknown {
  return Object.hasOwn(raw, key) ? raw[key] : undefined;
}

function isRecord(value: unknown): value is Raw {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Every `{slot}` a parsed notation reads. */
function slotNames(root: Expr): Set<string> {
  const names = new Set<string>();
  const term = (value: IntTerm | { readonly kind: string } | null): void => {
    if (value !== null && value.kind === "slot") names.add((value as { readonly name: string }).name);
  };
  const ops = (list: readonly DiceOp[]): void => {
    for (const op of list) for (const selector of op.selectors) term(selector.count);
  };
  const visit = (node: Expr): void => {
    switch (node.kind) {
      case "number":
        return;
      case "slot":
        names.add(node.name);
        return;
      case "dice":
        term(node.count);
        term(node.sides);
        ops(node.ops);
        return;
      case "set":
        node.items.forEach(visit);
        ops(node.ops);
        return;
      case "group":
        visit(node.inner);
        ops(node.ops);
        return;
      case "unary":
        visit(node.operand);
        return;
      case "binary":
        visit(node.left);
        visit(node.right);
        return;
      case "pool":
        visit(node.dice);
        term(node.threshold);
        return;
    }
  };
  visit(root);
  return names;
}
