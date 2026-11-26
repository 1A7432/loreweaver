// Reading YAML that arrives as content: rule packs, pack manifests, skill frontmatter,
// the variable schemas inside imported cards.
//
// YAML 1.2 core schema, on purpose. The Python server read YAML 1.1 (`yes`/`no` were
// booleans, `010` was eight); the SillyTavern ecosystem these files come from parses
// with JavaScript libraries, which follow 1.2, so 1.2 is both the simpler rule and the
// one authors already test against.
//
// Three things are refused rather than tolerated:
//   - anchors and aliases: an alias makes one small document expand without bound, and
//     nothing we read needs them;
//   - the key `__proto__`: every value becomes a plain object, and that key would
//     change the object instead of naming an entry;
//   - a mapping whose keys JavaScript would reorder: an object lists integer-like keys
//     first, in numeric order, whatever order they were written in — and the order of a
//     mapping is meaning here (attributes, resources, difficulty ladders). Such a
//     mapping is an author's list in disguise; the error says so.
import { isScalar, LineCounter, parseDocument, visit } from "yaml";

export class YamlError extends Error {
  readonly code: "syntax" | "alias" | "forbidden_key" | "key_order" | "too_large";
  /** 1-based line of the offending node, when known. */
  readonly line: number | undefined;

  constructor(code: YamlError["code"], message: string, line?: number) {
    super(line === undefined ? message : `line ${line}: ${message}`);
    this.name = "YamlError";
    this.code = code;
    this.line = line;
  }
}

/** Larger than any rule pack or manifest; a card's variable schema is far smaller. */
export const MAX_YAML_CHARS = 2_000_000;

const INTEGER_LIKE = /^(0|[1-9]\d*)$/;

/** True when an object with these keys, in this order, would iterate in another order. */
function reordered(keys: readonly string[]): boolean {
  let lastInteger = -1;
  let seenOther = false;
  for (const key of keys) {
    if (INTEGER_LIKE.test(key) && Number(key) < 2 ** 32 - 1) {
      if (seenOther || Number(key) < lastInteger) return true;
      lastInteger = Number(key);
    } else {
      seenOther = true;
    }
  }
  return false;
}

/** Parse one YAML document into plain JSON-like data. Throws `YamlError`. */
export function loadYaml(text: string): unknown {
  if (text.length > MAX_YAML_CHARS) {
    throw new YamlError("too_large", `document is longer than ${MAX_YAML_CHARS} characters`);
  }
  const lines = new LineCounter();
  const document = parseDocument(text, {
    version: "1.2",
    schema: "core",
    merge: false,
    lineCounter: lines,
    uniqueKeys: true,
  });
  const first = document.errors[0];
  if (first) throw new YamlError("syntax", first.message, first.linePos?.[0].line);

  const lineOf = (node: { range?: [number, number, number] | null }): number | undefined =>
    node.range ? lines.linePos(node.range[0]).line : undefined;

  // The library calls the most specific visitor for a node, so the anchor check is
  // repeated on each kind rather than left to a catch-all.
  const refuseAnchor = (node: { anchor?: string; range?: [number, number, number] | null }): void => {
    if (node.anchor !== undefined) {
      throw new YamlError("alias", "anchors and aliases are not accepted", lineOf(node));
    }
  };

  visit(document, {
    Alias(_key, node) {
      throw new YamlError("alias", "anchors and aliases are not accepted", lineOf(node));
    },
    Scalar(_key, node) {
      refuseAnchor(node);
    },
    Seq(_key, node) {
      refuseAnchor(node);
    },
    Map(_key, node) {
      refuseAnchor(node);
      const keys = node.items.map((pair) => (isScalar(pair.key) ? String(pair.key.value) : String(pair.key)));
      if (keys.includes("__proto__")) {
        throw new YamlError("forbidden_key", "the key __proto__ is not accepted", lineOf(node));
      }
      if (reordered(keys)) {
        throw new YamlError(
          "key_order",
          "a mapping with number-like keys would lose its written order; write a list instead",
          lineOf(node),
        );
      }
    },
  });
  return document.toJS({ maxAliasCount: 0 }) as unknown;
}
