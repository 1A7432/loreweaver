// A pack's panels file (protocol 3.0 §8.5, docs/lwf/formats/panels.md): parsed and checked
// as data, every problem a stable code with the dotted path of what it concerns. Pure.
//
// The format is 2.6's, changed only where the move from variables to views forces it:
// - a panel declares the views it reads, under handles: `views: {tide: harbor/tide}`;
// - a binding names a path inside one of them, `{$view: "tide.level"}`, in place of
//   `{$var: "<variable id>"}` / `{$leaf: …}`;
// - `repeat` iterates a list inside a view (`each`, with the element under `as`) instead of
//   the variables whose id starts with a prefix (an optional `prefix` still filters);
// - `visible_when` references the same paths;
// - a choice runs a command (`command`, `args`) instead of sending typed input;
// - a page (2.6 tier 2) is ONE self-contained HTML file: no extra `assets`;
// - `audience: keeper` is `audience: admin` (3.0 has no keeper role among members).
// The path grammar and the caps are the protocol package's (`loreweaver-protocol/v3`), so a
// client and the server read a template the same way.
import {
  BUILT_IN_VIEW_SCHEMAS,
  charCount,
  DEFAULT_REPEAT_AS,
  isAdminViewName,
  MAX_CONDITION_CHARS,
  MAX_PANEL_BLOCKS,
  MAX_PANEL_VIEWS,
  MAX_PANELS_PER_PACK,
  MAX_REPEAT_PREFIX_CHARS,
  PANEL_SLOTS,
  type PanelSlot,
  parsePath,
  VIEW_HANDLE,
} from "loreweaver-protocol/v3";

import { checkEntryPath } from "../../infra/zip.ts";
import { compile, ExprError } from "../condexpr.ts";
import { loadYaml, YamlError } from "../yaml.ts";

/** A panels file, in bytes. */
export const MAX_PANELS_FILE_BYTES = 256 * 1024;
export const MAX_PANEL_TITLE_CHARS = 120;
export const MAX_LABEL_CHARS = 120;
export const MAX_TEXT_CHARS = 2_000;
export const MAX_BODY_CHARS = 4_000;
export const MAX_CAPTION_CHARS = 300;
export const MAX_PROMPT_CHARS = 200;
export const MAX_OPTIONS = 12;
export const MAX_OPTION_ID_CHARS = 64;
export const MAX_COMMAND_CHARS = 128;
/** A choice's `args`, as compact JSON, in bytes. */
export const MAX_ARGS_BYTES = 2_000;
export const MAX_ARGS_DEPTH = 4;

export const PANEL_AUDIENCES = ["all", "player", "admin"] as const;
export type PanelAudience = (typeof PANEL_AUDIENCES)[number];

const PANEL_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const NAME = /^[a-z][a-z0-9_]{0,63}$/u;
const COMMAND_ID = /^[a-z][a-z0-9_]{0,63}(?:[./][a-z][a-z0-9_]{0,63})?$/u;
const ARG_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u;
const PAGE_EXTENSIONS: readonly string[] = [".html", ".htm"];
/** Built-in views a panel may read: every one but `panels` itself. */
const PANEL_READABLE_BUILT_INS: readonly string[] = Object.keys(BUILT_IN_VIEW_SCHEMAS).filter((name) => name !== "panels");

export type PanelCode =
  | "too_large"
  | "not_utf8"
  | "bad_yaml"
  | "not_a_mapping"
  | "missing_field"
  | "unknown_key"
  | "bad_field"
  | "bad_id"
  | "too_long"
  | "too_many"
  | "duplicate"
  /** An image or page path that breaks the path rules, or a page that is not `.html`. */
  | "bad_path"
  /** A view name that is neither a built-in view, `admin/<name>`, nor `<module>/<name>`. */
  | "bad_view_name"
  /** A binding that is not exactly `{$view: <path>}`. */
  | "bad_binding"
  /** A path outside the grammar or over its caps. */
  | "bad_path_syntax"
  /** A path whose first part is no handle in scope there. */
  | "unknown_handle"
  /** A template panel declares a view none of its paths reads. */
  | "unused_view"
  /** A repeat's `as` that is also a declared handle. */
  | "handle_shadowed"
  | "repeat_nested"
  /** `visible_when` that does not compile, or leaves the portable subset (`detail`: the code). */
  | "bad_condition"
  /** A 2.6 field (`$var`, `$leaf`, a choice's `input`, a page's `assets`, `audience: keeper`). */
  | "replaced_2x"
  /** `audience: player` with an `admin/*` view: nobody could ever be shown it. */
  | "audience_conflict";

export interface PanelProblem {
  readonly code: PanelCode;
  readonly path: string;
  readonly detail?: string;
}

/** `en`/`zh` text with at least one present. A fixed key set, so a plain object is safe. */
export interface PanelText {
  readonly en?: string;
  readonly zh?: string;
}

/** A field read from a view. */
export interface AuthoredBinding {
  readonly $view: string;
}

/**
 * One template block as authored, normalised: text fields are `PanelText` or a binding,
 * numbers a number or a binding, `image`/`map_pin` name their picture by pack path (`src`).
 * The block vocabulary is fixed, so the keys are never content.
 */
export type AuthoredBlock = { readonly [field: string]: unknown };

export interface PanelViewDecl {
  readonly as: string;
  readonly view: string;
}

export interface PanelSpec {
  readonly id: string;
  readonly title: PanelText;
  readonly slot: PanelSlot;
  readonly audience: PanelAudience;
  /** The views it reads, by handle, in declaration order. */
  readonly views: readonly PanelViewDecl[];
  readonly kind: "template" | "page";
  /** A template's blocks; empty for a page. */
  readonly blocks: readonly AuthoredBlock[];
  /** A page's HTML file; null for a template. */
  readonly entry: string | null;
  /** A page's fallback blocks; null when it declares none (and for a template). */
  readonly fallback: readonly AuthoredBlock[] | null;
  /** Every picture its blocks name, by pack path, once each. */
  readonly images: readonly string[];
  /** The handles its paths read (the template's, or the fallback's). */
  readonly reads: readonly string[];
}

export type PanelsParse = { readonly ok: true; readonly panels: readonly PanelSpec[] } | { readonly ok: false; readonly problems: readonly PanelProblem[] };

type Raw = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is Raw {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function join(path: string, key: string | number): string {
  return path === "" ? String(key) : `${path}.${key}`;
}

/** Whether a view name is one a panel may declare. */
export function isPanelViewName(name: string): boolean {
  if (PANEL_READABLE_BUILT_INS.includes(name)) return true;
  const parts = name.split("/");
  return parts.length === 2 && NAME.test(parts[0] as string) && NAME.test(parts[1] as string);
}

/** Whether a panel can be listed only to admins: its audience says so, or it reads an `admin/*` view. */
export function panelAdminOnly(panel: Pick<PanelSpec, "audience" | "views">): boolean {
  return panel.audience === "admin" || panel.views.some((ref) => isAdminViewName(ref.view));
}

/** Whether a member with `role` is listed `panel`. */
export function panelListedTo(panel: Pick<PanelSpec, "audience" | "views">, role: "player" | "admin" | "observer"): boolean {
  if (panel.views.some((ref) => isAdminViewName(ref.view)) && role !== "admin") return false;
  if (panel.audience === "admin") return role === "admin";
  if (panel.audience === "player") return role !== "admin";
  return true;
}

const PERFORMANCE: ReadonlyMap<string, { readonly required: readonly string[]; readonly optional: readonly string[] }> = new Map([
  ["letter", { required: ["body"], optional: ["from", "to", "date"] }],
  ["clipping", { required: ["headline", "body"], optional: ["source", "date"] }],
  ["map_pin", { required: ["src", "label", "x", "y"], optional: ["note"] }],
  ["title_card", { required: ["title"], optional: ["subtitle", "act"] }],
]);
const TEXT_CAPS: ReadonlyMap<string, number> = new Map([
  ["label", MAX_LABEL_CHARS],
  ["headline", MAX_LABEL_CHARS],
  ["title", MAX_LABEL_CHARS],
  ["from", MAX_LABEL_CHARS],
  ["to", MAX_LABEL_CHARS],
  ["date", MAX_LABEL_CHARS],
  ["source", MAX_LABEL_CHARS],
  ["act", MAX_LABEL_CHARS],
  ["alt", MAX_LABEL_CHARS],
  ["text", MAX_TEXT_CHARS],
  ["body", MAX_BODY_CHARS],
  ["note", MAX_CAPTION_CHARS],
  ["subtitle", MAX_CAPTION_CHARS],
  ["caption", MAX_CAPTION_CHARS],
  ["prompt", MAX_PROMPT_CHARS],
]);
const BLOCK_KINDS: readonly string[] = ["meter", "stat", "badge", "text", "divider", "choices", "image", ...PERFORMANCE.keys()];

/** One panel's reading: problems, the handles in scope, the handles read, the pictures named. */
class PanelReader {
  readonly problems: PanelProblem[] = [];
  readonly reads = new Set<string>();
  readonly images: string[] = [];
  readonly #handles: ReadonlySet<string>;

  constructor(problems: PanelProblem[], handles: ReadonlySet<string>) {
    this.problems = problems;
    this.#handles = handles;
  }

  fail(code: PanelCode, path: string, detail?: string): void {
    this.problems.push(detail === undefined ? { code, path } : { code, path, detail });
  }

  closed(raw: Raw, path: string, allowed: readonly string[]): void {
    for (const key of Object.keys(raw)) if (!allowed.includes(key)) this.fail("unknown_key", join(path, key));
  }

  /** A path read in a scope (`inner`: the repeat's element handle, when inside one). */
  path(raw: unknown, at: string, inner: string | null): string | null {
    const parts = parsePath(raw);
    if (parts === null) {
      this.fail("bad_path_syntax", at);
      return null;
    }
    const handle = parts[0] as string;
    if (handle === inner) return raw as string;
    if (!this.#handles.has(handle)) {
      this.fail("unknown_handle", at, handle);
      return null;
    }
    this.reads.add(handle);
    return raw as string;
  }

  /** A binding, when `raw` is shaped like one; undefined when it is not one at all. */
  binding(raw: unknown, at: string, inner: string | null): AuthoredBinding | null | undefined {
    if (!isRecord(raw)) return undefined;
    if (Object.hasOwn(raw, "$var") || Object.hasOwn(raw, "$leaf")) {
      this.fail("replaced_2x", at, Object.hasOwn(raw, "$var") ? "$var" : "$leaf");
      return null;
    }
    if (!Object.hasOwn(raw, "$view")) return undefined;
    if (Object.keys(raw).length !== 1) {
      this.fail("bad_binding", at);
      return null;
    }
    const path = this.path(raw.$view, join(at, "$view"), inner);
    return path === null ? null : { $view: path };
  }

  text(raw: unknown, at: string, cap: number, inner: string | null): PanelText | AuthoredBinding | null {
    const bound = this.binding(raw, at, inner);
    if (bound !== undefined) return bound;
    if (typeof raw === "string") {
      const value = raw.trim();
      if (value === "") this.fail("missing_field", at);
      else if (charCount(value) > cap) this.fail("too_long", at);
      return value === "" ? null : { en: value };
    }
    if (!isRecord(raw)) {
      this.fail("bad_field", at);
      return null;
    }
    this.closed(raw, at, ["en", "zh"]);
    const out: { en?: string; zh?: string } = {};
    for (const locale of ["en", "zh"] as const) {
      if (!Object.hasOwn(raw, locale)) continue;
      const value = raw[locale];
      if (typeof value !== "string" || value.trim() === "") this.fail("bad_field", join(at, locale));
      else if (charCount(value.trim()) > cap) this.fail("too_long", join(at, locale));
      else out[locale] = value.trim();
    }
    if (out.en === undefined && out.zh === undefined) {
      this.fail("missing_field", at);
      return null;
    }
    return out;
  }

  scalar(raw: unknown, at: string, inner: string | null, types: readonly ("number" | "string" | "boolean")[]): unknown {
    const bound = this.binding(raw, at, inner);
    if (bound !== undefined) return bound;
    const type = typeof raw;
    if ((type === "number" && Number.isFinite(raw) && types.includes("number")) || (type === "string" && types.includes("string")) || (type === "boolean" && types.includes("boolean"))) return raw;
    this.fail("bad_field", at);
    return null;
  }

  image(raw: unknown, at: string): string | null {
    if (typeof raw !== "string" || raw.trim() === "") {
      this.fail(raw === undefined ? "missing_field" : "bad_field", at);
      return null;
    }
    const value = raw.trim();
    const problem = checkEntryPath(value);
    if (problem !== null) {
      this.fail("bad_path", at, problem);
      return null;
    }
    if (!this.images.includes(value)) this.images.push(value);
    return value;
  }

  condition(raw: unknown, at: string, inner: string | null): string | null {
    if (typeof raw !== "string" || raw.trim() === "") {
      this.fail("bad_condition", at, "EMPTY");
      return null;
    }
    const source = raw.trim();
    if (charCount(source) > MAX_CONDITION_CHARS) {
      this.fail("too_long", at);
      return null;
    }
    let references: readonly string[];
    try {
      references = compile(source, { portable: true }).references;
    } catch (error) {
      if (!(error instanceof ExprError)) throw error;
      this.fail("bad_condition", at, error.code);
      return null;
    }
    for (const reference of references) this.path(reference, at, inner);
    return source;
  }

  args(raw: unknown, at: string): Readonly<Record<string, unknown>> | null {
    if (!isRecord(raw)) {
      this.fail("bad_field", at);
      return null;
    }
    const ok = (value: unknown, depth: number): boolean => {
      if (depth > MAX_ARGS_DEPTH) return false;
      if (value === null || typeof value === "string" || typeof value === "boolean") return true;
      if (typeof value === "number") return Number.isFinite(value);
      if (Array.isArray(value)) return value.every((item) => ok(item, depth + 1));
      if (isRecord(value)) return Object.entries(value).every(([key, item]) => ARG_KEY.test(key) && ok(item, depth + 1));
      return false;
    };
    if (!ok(raw, 1)) {
      this.fail("bad_field", at);
      return null;
    }
    if (new TextEncoder().encode(JSON.stringify(raw)).length > MAX_ARGS_BYTES) {
      this.fail("too_long", at);
      return null;
    }
    return raw;
  }

  blocks(raw: unknown, at: string): AuthoredBlock[] {
    if (!Array.isArray(raw) || raw.length === 0) {
      this.fail(raw === undefined ? "missing_field" : "bad_field", at);
      return [];
    }
    if (raw.length > MAX_PANEL_BLOCKS) {
      this.fail("too_many", at);
      return [];
    }
    const out: AuthoredBlock[] = [];
    raw.forEach((item, index) => {
      const block = this.block(item, join(at, index), null);
      if (block !== null) out.push(block);
    });
    return out;
  }

  block(raw: unknown, at: string, inner: string | null): AuthoredBlock | null {
    if (!isRecord(raw)) {
      this.fail("not_a_mapping", at);
      return null;
    }
    const gate = Object.hasOwn(raw, "visible_when") ? raw.visible_when : undefined;
    if (Object.hasOwn(raw, "repeat")) {
      this.closed(raw, at, ["repeat", "visible_when"]);
      if (inner !== null) {
        this.fail("repeat_nested", join(at, "repeat"));
        return null;
      }
      // The repeat's own gate is read outside the element.
      const condition = gate === undefined ? null : this.condition(gate, join(at, "visible_when"), null);
      const spec = raw.repeat;
      const specAt = join(at, "repeat");
      if (!isRecord(spec)) {
        this.fail("not_a_mapping", specAt);
        return null;
      }
      this.closed(spec, specAt, ["each", "as", "prefix", "block"]);
      const each = Object.hasOwn(spec, "each") ? this.path(spec.each, join(specAt, "each"), null) : (this.fail("missing_field", join(specAt, "each")), null);
      let as = DEFAULT_REPEAT_AS;
      if (Object.hasOwn(spec, "as")) {
        if (typeof spec.as !== "string" || !VIEW_HANDLE.test(spec.as)) this.fail("bad_id", join(specAt, "as"));
        else as = spec.as;
      }
      if (this.#handles.has(as)) this.fail("handle_shadowed", join(specAt, "as"), as);
      let prefix: string | null = null;
      if (Object.hasOwn(spec, "prefix")) {
        if (typeof spec.prefix !== "string" || spec.prefix === "") this.fail("bad_field", join(specAt, "prefix"));
        else if (charCount(spec.prefix) > MAX_REPEAT_PREFIX_CHARS) this.fail("too_long", join(specAt, "prefix"));
        else prefix = spec.prefix;
      }
      if (!Object.hasOwn(spec, "block")) {
        this.fail("missing_field", join(specAt, "block"));
        return null;
      }
      const block = this.block(spec.block, join(specAt, "block"), as);
      if (each === null || block === null) return null;
      const repeat: Record<string, unknown> = { each, as, block };
      if (prefix !== null) repeat.prefix = prefix;
      return condition === null ? { repeat } : { repeat, visible_when: condition };
    }

    const kind = raw.kind;
    if (typeof kind !== "string" || !BLOCK_KINDS.includes(kind)) {
      this.fail(kind === undefined ? "missing_field" : "bad_field", join(at, "kind"));
      return null;
    }
    const out: Record<string, unknown> = { kind };
    const allow = (fields: readonly string[]): void => this.closed(raw, at, ["kind", "visible_when", ...fields]);
    const need = (name: string): unknown => {
      if (!Object.hasOwn(raw, name)) this.fail("missing_field", join(at, name));
      return raw[name];
    };
    const textField = (name: string, required: boolean): void => {
      if (!Object.hasOwn(raw, name)) {
        if (required) need(name);
        return;
      }
      const value = this.text(raw[name], join(at, name), TEXT_CAPS.get(name) ?? MAX_LABEL_CHARS, inner);
      if (value !== null) out[name] = value;
    };
    const numberField = (name: string): void => {
      if (!Object.hasOwn(raw, name)) {
        need(name);
        return;
      }
      const value = this.scalar(raw[name], join(at, name), inner, ["number"]);
      if (value !== null) out[name] = value;
    };
    switch (kind) {
      case "divider":
        allow([]);
        break;
      case "meter":
        allow(["label", "value", "min", "max"]);
        textField("label", true);
        for (const name of ["value", "min", "max"]) numberField(name);
        if (typeof out.min === "number" && typeof out.max === "number" && out.max <= out.min) this.fail("bad_field", join(at, "max"));
        break;
      case "stat": {
        allow(["label", "value"]);
        textField("label", true);
        if (!Object.hasOwn(raw, "value")) {
          need("value");
          break;
        }
        const value = raw.value;
        const bound = this.binding(value, join(at, "value"), inner);
        if (bound !== undefined) {
          if (bound !== null) out.value = bound;
        } else if (typeof value === "string") {
          const text = this.text(value, join(at, "value"), MAX_LABEL_CHARS, inner);
          if (text !== null) out.value = text;
        } else if (isRecord(value)) {
          const text = this.text(value, join(at, "value"), MAX_LABEL_CHARS, inner);
          if (text !== null) out.value = text;
        } else {
          const scalar = this.scalar(value, join(at, "value"), inner, ["number", "boolean"]);
          if (scalar !== null) out.value = scalar;
        }
        break;
      }
      case "badge":
        allow(["label", "tone"]);
        textField("label", true);
        if (Object.hasOwn(raw, "tone")) {
          const tone = this.scalar(raw.tone, join(at, "tone"), inner, ["string"]);
          if (typeof tone === "string" && !["info", "warn", "danger"].includes(tone)) this.fail("bad_field", join(at, "tone"));
          else if (tone !== null) out.tone = tone;
        }
        break;
      case "text":
        allow(["text", "style"]);
        textField("text", true);
        if (Object.hasOwn(raw, "style")) {
          if (raw.style !== "quote" && raw.style !== "warning") this.fail("bad_field", join(at, "style"));
          else out.style = raw.style;
        }
        break;
      case "image": {
        allow(["src", "caption", "alt"]);
        const src = this.image(raw.src, join(at, "src"));
        if (src !== null) out.src = src;
        textField("caption", false);
        textField("alt", false);
        break;
      }
      case "choices": {
        allow(["prompt", "options"]);
        textField("prompt", false);
        const options = need("options");
        const optionsAt = join(at, "options");
        if (!Array.isArray(options) || options.length === 0) {
          if (options !== undefined) this.fail("bad_field", optionsAt);
          break;
        }
        if (options.length > MAX_OPTIONS) {
          this.fail("too_many", optionsAt);
          break;
        }
        const ids = new Set<string>();
        out.options = options.flatMap((option, index) => {
          const optionAt = join(optionsAt, index);
          if (!isRecord(option)) {
            this.fail("not_a_mapping", optionAt);
            return [];
          }
          if (Object.hasOwn(option, "input")) this.fail("replaced_2x", join(optionAt, "input"), "input");
          this.closed(option, optionAt, ["id", "label", "command", "args", "input"]);
          const id = option.id;
          if (typeof id !== "string" || id.trim() === "" || charCount(id) > MAX_OPTION_ID_CHARS) this.fail(id === undefined ? "missing_field" : "bad_id", join(optionAt, "id"));
          else if (ids.has(id)) this.fail("duplicate", join(optionAt, "id"));
          else ids.add(id);
          const label = Object.hasOwn(option, "label") ? this.text(option.label, join(optionAt, "label"), MAX_LABEL_CHARS, inner) : (this.fail("missing_field", join(optionAt, "label")), null);
          const command = option.command;
          if (typeof command !== "string" || charCount(command) > MAX_COMMAND_CHARS || !COMMAND_ID.test(command)) {
            if (!Object.hasOwn(option, "input")) this.fail(command === undefined ? "missing_field" : "bad_id", join(optionAt, "command"));
            return [];
          }
          const args = Object.hasOwn(option, "args") ? this.args(option.args, join(optionAt, "args")) : null;
          if (typeof id !== "string" || label === null) return [];
          return [args === null ? { id, label, command } : { id, label, command, args }];
        });
        break;
      }
      default: {
        const fields = PERFORMANCE.get(kind) as { required: readonly string[]; optional: readonly string[] };
        allow([...fields.required, ...fields.optional]);
        for (const name of fields.required) {
          if (name === "src") {
            const src = this.image(raw.src, join(at, "src"));
            if (src !== null) out.src = src;
          } else if (name === "x" || name === "y") numberField(name);
          else textField(name, true);
        }
        for (const name of fields.optional) textField(name, false);
      }
    }
    if (gate !== undefined) {
      const condition = this.condition(gate, join(at, "visible_when"), inner);
      if (condition !== null) out.visible_when = condition;
    }
    return out;
  }
}

function readViews(problems: PanelProblem[], raw: unknown, at: string): PanelViewDecl[] {
  const fail = (code: PanelCode, path: string, detail?: string): void => {
    problems.push(detail === undefined ? { code, path } : { code, path, detail });
  };
  if (raw === undefined || raw === null) return [];
  if (!isRecord(raw)) {
    fail("not_a_mapping", at);
    return [];
  }
  const keys = Object.keys(raw);
  if (keys.length > MAX_PANEL_VIEWS) {
    fail("too_many", at);
    return [];
  }
  const out: PanelViewDecl[] = [];
  for (const handle of keys) {
    const value = raw[handle];
    if (!VIEW_HANDLE.test(handle)) fail("bad_id", join(at, handle));
    else if (typeof value !== "string" || !isPanelViewName(value)) fail("bad_view_name", join(at, handle), typeof value === "string" ? value : undefined);
    else out.push({ as: handle, view: value });
  }
  return out;
}

function readPanel(raw: unknown, at: string, problems: PanelProblem[]): PanelSpec | null {
  const fail = (code: PanelCode, path: string, detail?: string): void => {
    problems.push(detail === undefined ? { code, path } : { code, path, detail });
  };
  if (!isRecord(raw)) {
    fail("not_a_mapping", at);
    return null;
  }
  const id = raw.id;
  if (typeof id !== "string" || !PANEL_ID.test(id)) {
    fail(id === undefined ? "missing_field" : "bad_id", join(at, "id"));
    return null;
  }
  const before = problems.length;
  const views = readViews(problems, raw.views, join(at, "views"));
  const reader = new PanelReader(problems, new Set(views.map((ref) => ref.as)));
  reader.closed(raw, at, ["id", "title", "slot", "audience", "views", "blocks", "entry", "fallback", "assets"]);
  if (Object.hasOwn(raw, "assets")) reader.fail("replaced_2x", join(at, "assets"), "assets");
  const title = Object.hasOwn(raw, "title") ? reader.text(raw.title, join(at, "title"), MAX_PANEL_TITLE_CHARS, null) : (reader.fail("missing_field", join(at, "title")), null);
  if (title !== null && "$view" in title) reader.fail("bad_field", join(at, "title"));
  const slot = raw.slot;
  if (typeof slot !== "string" || !(PANEL_SLOTS as readonly string[]).includes(slot)) reader.fail(slot === undefined ? "missing_field" : "bad_field", join(at, "slot"));
  let audience: PanelAudience = "all";
  if (Object.hasOwn(raw, "audience")) {
    if (raw.audience === "keeper") reader.fail("replaced_2x", join(at, "audience"), "keeper");
    else if (typeof raw.audience !== "string" || !(PANEL_AUDIENCES as readonly string[]).includes(raw.audience)) reader.fail("bad_field", join(at, "audience"));
    else audience = raw.audience as PanelAudience;
  }
  if (audience === "player" && views.some((ref) => isAdminViewName(ref.view))) reader.fail("audience_conflict", join(at, "audience"));

  let kind: "template" | "page" = "template";
  let blocks: AuthoredBlock[] = [];
  let entry: string | null = null;
  let fallback: AuthoredBlock[] | null = null;
  if (Object.hasOwn(raw, "entry")) {
    kind = "page";
    if (Object.hasOwn(raw, "blocks")) reader.fail("unknown_key", join(at, "blocks"), "page");
    const file = raw.entry;
    const entryAt = join(at, "entry");
    if (typeof file !== "string" || file.trim() === "") reader.fail("bad_field", entryAt);
    else {
      const value = file.trim();
      const problem = checkEntryPath(value);
      if (problem !== null) reader.fail("bad_path", entryAt, problem);
      else if (!PAGE_EXTENSIONS.some((extension) => value.toLowerCase().endsWith(extension))) reader.fail("bad_path", entryAt, "extension");
      else entry = value;
    }
    // A page's fallback is required, but may be an explicit null: the author's choice to
    // show text clients one "needs a rich client" line.
    if (!Object.hasOwn(raw, "fallback")) reader.fail("missing_field", join(at, "fallback"));
    else if (raw.fallback !== null) fallback = reader.blocks(raw.fallback, join(at, "fallback"));
  } else {
    if (Object.hasOwn(raw, "fallback")) reader.fail("unknown_key", join(at, "fallback"), "template");
    blocks = reader.blocks(raw.blocks, join(at, "blocks"));
    // A template's views are exactly what it reads: the subscriptions it costs, no more.
    // (Checked only once its blocks read cleanly: a broken path is reported as itself.)
    if (problems.length === before) for (const ref of views) if (!reader.reads.has(ref.as)) reader.fail("unused_view", join(join(at, "views"), ref.as));
  }
  if (problems.length > before || title === null || "$view" in title) return null;
  return {
    id,
    title: title as PanelText,
    slot: slot as PanelSlot,
    audience,
    views,
    kind,
    blocks,
    entry,
    fallback,
    images: [...reader.images],
    reads: [...reader.reads],
  };
}

/** Check a panels file's value, already read from YAML. */
export function checkPanels(document: unknown): PanelsParse {
  const problems: PanelProblem[] = [];
  if (!isRecord(document)) return { ok: false, problems: [{ code: "not_a_mapping", path: "" }] };
  for (const key of Object.keys(document)) if (key !== "panels") problems.push({ code: "unknown_key", path: key });
  const list = document.panels;
  if (!Array.isArray(list) || list.length === 0) return { ok: false, problems: [...problems, { code: list === undefined ? "missing_field" : "bad_field", path: "panels" }] };
  if (list.length > MAX_PANELS_PER_PACK) return { ok: false, problems: [...problems, { code: "too_many", path: "panels" }] };
  const panels: PanelSpec[] = [];
  const ids = new Set<string>();
  list.forEach((item, index) => {
    const panel = readPanel(item, join("panels", index), problems);
    if (panel === null) return;
    if (ids.has(panel.id)) problems.push({ code: "duplicate", path: join(join("panels", index), "id"), detail: panel.id });
    ids.add(panel.id);
    panels.push(panel);
  });
  return problems.length > 0 ? { ok: false, problems } : { ok: true, panels };
}

/** Parse a panels file's text. */
export function parsePanels(text: string): PanelsParse {
  if (new TextEncoder().encode(text).length > MAX_PANELS_FILE_BYTES) return { ok: false, problems: [{ code: "too_large", path: "" }] };
  let document: unknown;
  try {
    document = loadYaml(text);
  } catch (error) {
    if (error instanceof YamlError) return { ok: false, problems: [{ code: "bad_yaml", path: error.line === undefined ? "" : `line ${error.line}`, detail: error.code }] };
    throw error;
  }
  return checkPanels(document);
}
