// The safe static SVG subset. SVG is markup a client may render as browser content, so
// unlike every other media type its bytes are parsed here, and this is the one place
// hostile markup is read. The scanner is purpose-built and fails closed: it accepts a
// small, positively described language — a handful of drawing elements, a fixed set of
// attributes each with its own value grammar — and rejects everything it does not
// recognise, rather than looking for known-bad patterns in otherwise arbitrary XML.
//
// What is therefore impossible by construction: scripts, `foreignObject`, `<style>`,
// `<image>`/`<use>`/`<a>` (anything that references another resource), event handlers
// (no `on*` attribute is in the table), `href`/`xlink:href`, `style` attributes, CSS
// `url(...)`, data URLs, DOCTYPE and entity declarations, CDATA and processing
// instructions other than a leading XML declaration.

export const SVG_MIME = "image/svg+xml";

const MAX_SVG_BYTES = 200_000;
const MAX_ELEMENTS = 800;
const MAX_DEPTH = 32;
const MAX_ATTRIBUTE_CHARS = 20_000;

const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";

type ElementName = "svg" | "g" | "title" | "desc" | "rect" | "line" | "polyline" | "text" | "tspan";

interface ElementRule {
  /** Elements allowed directly inside this one. */
  readonly children: ReadonlySet<ElementName>;
  /** Whether non-whitespace character data may appear directly inside. */
  readonly text: boolean;
}

const DRAWING: ReadonlySet<ElementName> = new Set<ElementName>(["svg", "g", "title", "desc", "rect", "line", "polyline", "text"]);
const LABELS: ReadonlySet<ElementName> = new Set<ElementName>(["title", "desc"]);

const ELEMENTS: ReadonlyMap<string, ElementRule> = new Map<ElementName, ElementRule>([
  ["svg", { children: DRAWING, text: false }],
  ["g", { children: DRAWING, text: false }],
  ["title", { children: new Set(), text: true }],
  ["desc", { children: new Set(), text: true }],
  ["rect", { children: LABELS, text: false }],
  ["line", { children: LABELS, text: false }],
  ["polyline", { children: LABELS, text: false }],
  ["text", { children: new Set<ElementName>(["tspan", "title", "desc"]), text: true }],
  ["tspan", { children: new Set<ElementName>(["tspan"]), text: true }],
]);

// Value grammars. Whitespace in XML attribute values is the four XML space characters.
const NUMBER = String.raw`[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?`;
const NUMBER_RE = new RegExp(`^${NUMBER}$`);
const LENGTH_RE = new RegExp(`^${NUMBER}(?:px|em|ex|pt|pc|cm|mm|in|%)?$`);
const COLOR_FUNCTION_RE = new RegExp(
  `^(?:rgb|rgba|hsl|hsla)\\([ \\t\\n\\r]*${NUMBER}(?:%|deg)?(?:[ \\t\\n\\r]*[, /][ \\t\\n\\r]*${NUMBER}%?){2,3}[ \\t\\n\\r]*\\)$`,
);
const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const COLOR_KEYWORD_RE = /^[A-Za-z]{1,32}$/;
const ID_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;
const CLASS_TOKEN_RE = /^[A-Za-z_-][A-Za-z0-9_-]{0,63}$/;
const FONT_FAMILY_RE = /^[\p{L}\p{N} ,'"_.-]{1,200}$/u;
const ROLE_RE = /^[a-z][a-z-]{0,31}$/;
const SPACE_RE = /[ \t\n\r]+/;
const LIST_SEPARATOR_RE = /[ \t\n\r]*,[ \t\n\r]*|[ \t\n\r]+/;
// Defence in depth on top of the grammars: none of these can pass a grammar above, but
// free-text attributes (`aria-label`) are checked too, so a future grammar mistake
// still cannot let a URL-shaped value through.
const FORBIDDEN_VALUE_RE = /javascript:|data:|https?:|url[ \t\n\r]*\(|expression[ \t\n\r]*\(/i;

function trimXml(value: string): string {
  return value.replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, "");
}

function numberList(value: string, each: RegExp): string[] | undefined {
  const trimmed = trimXml(value);
  if (trimmed === "") return undefined;
  const parts = trimmed.split(LIST_SEPARATOR_RE);
  return parts.every((part) => each.test(part)) ? parts : undefined;
}

const isLength = (value: string): boolean => LENGTH_RE.test(trimXml(value));
const oneOf =
  (...options: string[]) =>
  (value: string): boolean =>
    options.includes(trimXml(value));

function isPaint(value: string): boolean {
  const v = trimXml(value);
  return HEX_COLOR_RE.test(v) || COLOR_KEYWORD_RE.test(v) || COLOR_FUNCTION_RE.test(v);
}

const FONT_SIZE_KEYWORDS = oneOf("xx-small", "x-small", "small", "medium", "large", "x-large", "xx-large", "smaller", "larger");

type ValueCheck = (value: string) => boolean;

/** Attributes allowed on every element, with their value grammar. */
const ATTRIBUTES: ReadonlyMap<string, ValueCheck> = new Map<string, ValueCheck>([
  ["aria-label", (value) => Array.from(value).length <= 500],
  ["class", (value) => {
    const trimmed = trimXml(value);
    return trimmed.length <= 256 && trimmed !== "" && trimmed.split(SPACE_RE).every((token) => CLASS_TOKEN_RE.test(token));
  }],
  ["dominant-baseline", oneOf("auto", "alphabetic", "ideographic", "middle", "central", "mathematical", "hanging", "text-top", "text-bottom")],
  ["fill", isPaint],
  ["font-family", (value) => FONT_FAMILY_RE.test(trimXml(value))],
  ["font-size", (value) => isLength(value) || FONT_SIZE_KEYWORDS(value)],
  ["font-weight", oneOf("normal", "bold", "bolder", "lighter", "100", "200", "300", "400", "500", "600", "700", "800", "900")],
  ["height", isLength],
  ["id", (value) => ID_RE.test(value)],
  ["points", (value) => {
    const parts = numberList(value, NUMBER_RE);
    return parts !== undefined && parts.length % 2 === 0;
  }],
  ["role", (value) => ROLE_RE.test(value)],
  ["rx", isLength],
  ["ry", isLength],
  ["stroke", isPaint],
  ["stroke-dasharray", (value) => trimXml(value) === "none" || numberList(value, LENGTH_RE) !== undefined],
  ["stroke-linecap", oneOf("butt", "round", "square")],
  ["stroke-width", isLength],
  ["text-anchor", oneOf("start", "middle", "end")],
  ["viewBox", (value) => numberList(value, NUMBER_RE)?.length === 4],
  ["width", isLength],
  ["x", isLength],
  ["x1", isLength],
  ["x2", isLength],
  ["y", isLength],
  ["y1", isLength],
  ["y2", isLength],
]);

/** Declarations allowed on the root `svg` only, each with its one accepted value. */
const ROOT_DECLARATIONS: ReadonlyMap<string, ValueCheck> = new Map<string, ValueCheck>([
  ["xmlns", (value) => value === SVG_NS],
  ["xmlns:xlink", (value) => value === XLINK_NS],
  ["version", oneOf("1.0", "1.1")],
]);

const PREDEFINED_ENTITIES: ReadonlyMap<string, string> = new Map([
  ["lt", "<"],
  ["gt", ">"],
  ["amp", "&"],
  ["quot", '"'],
  ["apos", "'"],
]);

/** Thrown inside the scanner only; `isSafeSvg` turns it (and anything else) into `false`. */
class Rejected extends Error {}

function reject(): never {
  throw new Rejected();
}

/** A code point the subset accepts in a document: printable text, tab, newline, return. */
function isAllowedCodePoint(cp: number): boolean {
  if (cp === 0x9 || cp === 0xa || cp === 0xd) return true;
  if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) return false;
  if (cp >= 0xd800 && cp <= 0xdfff) return false;
  if (cp === 0xfffe || cp === 0xffff) return false;
  return cp <= 0x10ffff;
}

function isSpace(code: number): boolean {
  return code === 0x20 || code === 0x9 || code === 0xa || code === 0xd;
}

function isNameStart(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || code === 0x5f;
}

function isNameChar(code: number): boolean {
  return isNameStart(code) || (code >= 0x30 && code <= 0x39) || code === 0x2d || code === 0x2e || code === 0x3a;
}

/** Resolve character and predefined entity references; anything else is refused. */
function decodeReferences(raw: string): string {
  if (!raw.includes("&")) return raw;
  let out = "";
  let at = 0;
  for (;;) {
    const amp = raw.indexOf("&", at);
    if (amp < 0) return out + raw.slice(at);
    out += raw.slice(at, amp);
    const semi = raw.indexOf(";", amp);
    if (semi < 0 || semi - amp > 10) reject();
    const ref = raw.slice(amp + 1, semi);
    const named = PREDEFINED_ENTITIES.get(ref);
    if (named !== undefined) {
      out += named;
    } else {
      let cp: number;
      if (/^#[0-9]{1,7}$/.test(ref)) cp = Number(ref.slice(1));
      else if (/^#x[0-9a-fA-F]{1,6}$/.test(ref)) cp = Number.parseInt(ref.slice(2), 16);
      else reject();
      if (!isAllowedCodePoint(cp)) reject();
      out += String.fromCodePoint(cp);
    }
    at = semi + 1;
  }
}

class Scanner {
  readonly #text: string;
  #pos = 0;
  #elements = 0;

  constructor(text: string) {
    this.#text = text;
  }

  document(): void {
    if (this.#startsWith("<?xml") && isSpace(this.#code(5))) this.#xmlDeclaration();
    this.#misc();
    if (!this.#startsWith("<")) reject();
    this.#pos += 1;
    this.#element(undefined, 0);
    this.#misc();
    if (this.#pos !== this.#text.length) reject();
  }

  #code(offset = 0): number {
    return this.#text.charCodeAt(this.#pos + offset);
  }

  #startsWith(token: string): boolean {
    return this.#text.startsWith(token, this.#pos);
  }

  #skipSpace(): boolean {
    const start = this.#pos;
    while (isSpace(this.#code())) this.#pos += 1;
    return this.#pos > start;
  }

  #name(): string {
    const start = this.#pos;
    if (!isNameStart(this.#code())) reject();
    while (isNameChar(this.#code())) this.#pos += 1;
    return this.#text.slice(start, this.#pos);
  }

  /** Whitespace and comments, the only things allowed around the root element. */
  #misc(): void {
    for (;;) {
      this.#skipSpace();
      if (this.#startsWith("<!--")) this.#comment();
      else return;
    }
  }

  #comment(): void {
    const start = this.#pos + 4;
    const dashes = this.#text.indexOf("--", start);
    // XML forbids `--` inside a comment, so the first `--` must be the terminator.
    if (dashes < 0 || this.#text.charCodeAt(dashes + 2) !== 0x3e) reject();
    this.#pos = dashes + 3;
  }

  /** A quoted attribute value, references resolved. */
  #quoted(): string {
    const quote = this.#code();
    if (quote !== 0x22 && quote !== 0x27) reject();
    const end = this.#text.indexOf(quote === 0x22 ? '"' : "'", this.#pos + 1);
    if (end < 0) reject();
    const raw = this.#text.slice(this.#pos + 1, end);
    if (raw.length > MAX_ATTRIBUTE_CHARS || raw.includes("<")) reject();
    this.#pos = end + 1;
    return decodeReferences(raw);
  }

  #xmlDeclaration(): void {
    this.#pos += 5;
    const seen = new Set<string>();
    for (;;) {
      const spaced = this.#skipSpace();
      if (this.#startsWith("?>")) {
        this.#pos += 2;
        break;
      }
      if (!spaced) reject();
      const name = this.#name();
      if (seen.has(name)) reject();
      seen.add(name);
      this.#skipSpace();
      if (this.#code() !== 0x3d) reject();
      this.#pos += 1;
      this.#skipSpace();
      const value = this.#quoted();
      const ok =
        (name === "version" && (value === "1.0" || value === "1.1")) ||
        (name === "encoding" && value.toLowerCase() === "utf-8") ||
        (name === "standalone" && (value === "yes" || value === "no"));
      if (!ok) reject();
    }
    if (!seen.has("version")) reject();
  }

  /** One element, the `<` already consumed. */
  #element(parent: ElementRule | undefined, depth: number): void {
    const name = this.#name();
    const rule = ELEMENTS.get(name);
    if (rule === undefined) reject();
    if (parent === undefined ? name !== "svg" : !parent.children.has(name as ElementName)) reject();
    this.#elements += 1;
    if (this.#elements > MAX_ELEMENTS || depth >= MAX_DEPTH) reject();

    const seen = new Set<string>();
    for (;;) {
      const spaced = this.#skipSpace();
      if (this.#startsWith("/>")) {
        this.#pos += 2;
        return;
      }
      if (this.#code() === 0x3e) {
        this.#pos += 1;
        break;
      }
      if (!spaced) reject();
      const attribute = this.#name();
      if (seen.has(attribute)) reject();
      seen.add(attribute);
      this.#skipSpace();
      if (this.#code() !== 0x3d) reject();
      this.#pos += 1;
      this.#skipSpace();
      const value = this.#quoted();
      const declaration = parent === undefined ? ROOT_DECLARATIONS.get(attribute) : undefined;
      if (declaration !== undefined) {
        if (!declaration(value)) reject();
        continue;
      }
      const check = ATTRIBUTES.get(attribute);
      if (check === undefined || !check(value) || FORBIDDEN_VALUE_RE.test(value)) reject();
    }

    this.#content(name, rule, depth);
  }

  #content(name: string, rule: ElementRule, depth: number): void {
    for (;;) {
      if (this.#pos >= this.#text.length) reject();
      if (this.#startsWith("</")) {
        this.#pos += 2;
        if (this.#name() !== name) reject();
        this.#skipSpace();
        if (this.#code() !== 0x3e) reject();
        this.#pos += 1;
        return;
      }
      if (this.#startsWith("<!--")) {
        this.#comment();
        continue;
      }
      if (this.#code() === 0x3c) {
        // `<!DOCTYPE`, `<![CDATA[`, `<?pi` all fail here: a name must start with a letter.
        this.#pos += 1;
        this.#element(rule, depth + 1);
        continue;
      }
      const next = this.#text.indexOf("<", this.#pos);
      const end = next < 0 ? this.#text.length : next;
      const raw = this.#text.slice(this.#pos, end);
      this.#pos = end;
      if (raw.includes("]]>")) reject();
      const text = decodeReferences(raw);
      if (!rule.text && trimXml(text) !== "") reject();
    }
  }
}

/** Whether `bytes` is a UTF-8 SVG document within the safe static subset. */
export function isSafeSvg(bytes: Uint8Array): boolean {
  if (bytes.length === 0 || bytes.length > MAX_SVG_BYTES) return false;
  let text: string;
  try {
    // `fatal` refuses malformed UTF-8 (and so lone surrogates); a leading BOM is dropped.
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  for (const char of text) {
    if (!isAllowedCodePoint(char.codePointAt(0) ?? 0)) return false;
  }
  try {
    new Scanner(text).document();
    return true;
  } catch {
    // Any failure — a refusal or an unexpected error in the scanner itself — rejects.
    return false;
  }
}
