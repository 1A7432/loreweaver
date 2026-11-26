/**
 * Reading a pack's parsed YAML: typed accessors that fail with a `RulePackError` naming
 * the pack and the dotted path of the offending field. Shared by the rule-pack compiler
 * and the subsystem compiler.
 *
 * Parsed data is read through OWN properties only (`field`), so an entry named like an
 * inherited member (`constructor`, `toString`) is an entry like any other.
 */

import { compile, type CompiledExpr, ExprError, type FunctionName } from "../condexpr.ts";
import { DiceError, type DiceExpression, parseDice } from "../dice/index.ts";
import { foldCase, stripSpace } from "../sheets/text.ts";
import { RulePackError, type RulePackErrorCode } from "./errors.ts";

export type Raw = Readonly<Record<string, unknown>>;

export function isRecord(value: unknown): value is Raw {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** An own property of parsed data; never an inherited member. */
export function field(raw: Raw, key: string): unknown {
  return Object.hasOwn(raw, key) ? raw[key] : undefined;
}

/** A locale key as packs compare them: trimmed and case-folded (`EN` is `en`, `zh-CN` is `zh-cn`). */
export function localeKey(locale: string): string {
  return foldCase(stripSpace(locale));
}

/**
 * The base language a viewer locale looks up first: the part before `-`/`_`, case-folded.
 * A missing locale is `""`, which a table matches only if it declares an empty locale.
 */
export function baseLocale(locale: string | null | undefined): string {
  return foldCase((locale ?? "").replaceAll("_", "-").split("-", 1)[0] ?? "");
}

export class Reader {
  readonly packId: string;

  constructor(packId: string) {
    this.packId = packId;
  }

  fail(code: RulePackErrorCode, path: string, detail: string, cause?: unknown, layerCode?: string): never {
    throw new RulePackError(code, this.packId, path, detail, { cause, layerCode });
  }

  mapping(value: unknown, path: string): Raw {
    if (!isRecord(value)) this.fail("BAD_FIELD", path, "must be a mapping");
    return value;
  }

  /** Absent or null reads as an empty mapping. */
  optionalMapping(value: unknown, path: string): Raw {
    return value === undefined || value === null ? {} : this.mapping(value, path);
  }

  onlyKeys(raw: Raw, allowed: ReadonlySet<string>, path: string): void {
    const unknown = Object.keys(raw).filter((key) => !allowed.has(key));
    if (unknown.length > 0) this.fail("UNKNOWN_KEY", path, `unknown key(s) ${unknown.map((key) => JSON.stringify(key)).join(", ")}`);
  }

  /** A string (any content, possibly empty). */
  string(value: unknown, path: string): string {
    if (typeof value !== "string") this.fail("BAD_FIELD", path, "must be a string");
    return value;
  }

  /** A string with something in it besides whitespace, trimmed. */
  text(value: unknown, path: string): string {
    if (typeof value !== "string" || stripSpace(value) === "") this.fail("BAD_FIELD", path, "must be a non-empty string");
    return stripSpace(value);
  }

  /** A list of strings; absent or null is empty. */
  stringList(value: unknown, path: string): readonly string[] {
    if (value === undefined || value === null) return Object.freeze([]);
    if (!Array.isArray(value)) this.fail("BAD_FIELD", path, "must be a list of strings");
    return Object.freeze(value.map((item: unknown, index: number) => this.string(item, `${path}[${index}]`)));
  }

  integer(value: unknown, path: string): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) this.fail("BAD_FIELD", path, "must be an integer");
    return value;
  }

  boolean(value: unknown, path: string): boolean {
    if (typeof value !== "boolean") this.fail("BAD_FIELD", path, "must be true or false");
    return value;
  }

  notation(value: unknown, path: string): DiceExpression {
    const text = this.text(value, path);
    try {
      return parseDice(text);
    } catch (error) {
      if (error instanceof DiceError) this.fail("BAD_NOTATION", path, `does not parse (${error.message})`, error, error.code);
      throw error;
    }
  }

  expression(value: unknown, path: string, functions: readonly FunctionName[] = []): CompiledExpr {
    const text = this.text(value, path);
    try {
      return compile(text, { functions });
    } catch (error) {
      if (error instanceof ExprError) this.fail("BAD_EXPRESSION", path, error.message, error, error.code);
      throw error;
    }
  }

  /**
   * A `locale → text` mapping, locales compared case-folded; blank texts are dropped
   * (an author's empty placeholder means "not translated"). Absent or null is empty.
   */
  localeTexts(value: unknown, path: string): ReadonlyMap<string, string> {
    const raw = this.optionalMapping(value, path);
    const out = new Map<string, string>();
    for (const locale of Object.keys(raw)) {
      const at = `${path}.${locale}`;
      const key = localeKey(locale);
      if (out.has(key)) this.fail("DUPLICATE_ID", at, "locale declared twice (locales compare case-insensitively)");
      const text = this.string(raw[locale], at);
      if (stripSpace(text) !== "") out.set(key, text);
    }
    return out;
  }
}

/**
 * A deep copy of parsed data (mappings become prototype-free, keys keep their order), so a
 * compiled pack never shares, or freezes, an object its caller still holds.
 */
export function cloneData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneData);
  if (isRecord(value)) {
    const out = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(value)) {
      Object.defineProperty(out, key, { value: cloneData(value[key]), enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  return value;
}

/** A JSON-like value, deep-frozen, for the informative sections a pack carries as data. */
export function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}
