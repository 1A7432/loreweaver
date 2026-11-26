import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { deflateSync } from "node:zlib";

import { CardError, MAX_BOOK_ENTRIES, MAX_CARD_FILE_BYTES, parseCard, splitCard, type CardErrorCode } from "../../../src/core/card/index.ts";
import { toJson } from "../../../src/core/variables/index.ts";

const encoder = new TextEncoder();
const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A PNG made of the given chunks (CRCs are zero: the reader does not check them). */
function png(chunks: [string, Uint8Array][]): Uint8Array {
  const parts: number[] = [...SIGNATURE];
  const all: [string, Uint8Array][] = [["IHDR", new Uint8Array(13)], ...chunks, ["IEND", new Uint8Array(0)]];
  for (const [type, data] of all) {
    parts.push((data.length >>> 24) & 0xff, (data.length >>> 16) & 0xff, (data.length >>> 8) & 0xff, data.length & 0xff);
    parts.push(...encoder.encode(type), ...data, 0, 0, 0, 0);
  }
  return new Uint8Array(parts);
}

const concat = (...pieces: (Uint8Array | number[])[]): Uint8Array => new Uint8Array(pieces.flatMap((piece) => [...piece]));
const b64Card = (name: string, spec = "chara_card_v2"): string => Buffer.from(JSON.stringify({ spec, data: { name } })).toString("base64");
const tEXt = (keyword: string, text: string): [string, Uint8Array] => ["tEXt", concat(encoder.encode(keyword), [0], encoder.encode(text))];
const zTXt = (keyword: string, payload: Uint8Array): [string, Uint8Array] => ["zTXt", concat(encoder.encode(keyword), [0, 0], deflateSync(payload))];
const iTXt = (keyword: string, payload: Uint8Array, compressed: boolean): [string, Uint8Array] => [
  "iTXt",
  concat(encoder.encode(keyword), [0, compressed ? 1 : 0, 0], encoder.encode("en"), [0], [0], compressed ? deflateSync(payload) : payload),
];

function codeOf(run: () => unknown): CardErrorCode | null {
  try {
    run();
    return null;
  } catch (error) {
    if (error instanceof CardError) return error.code;
    throw error;
  }
}

describe("PNG cards", () => {
  test("a ccv3 chunk wins over chara wherever it sits, across chunk kinds; keywords match case-insensitively", () => {
    const bytes = png([zTXt("Chara", encoder.encode(b64Card("V2"))), tEXt("note", "x"), iTXt("CCV3", encoder.encode(b64Card("V3", "chara_card_v3")), true)]);
    expect(parseCard(bytes).card.name).toBe("V3");
    expect(parseCard(png([iTXt("chara", encoder.encode(b64Card("Plain")), false)])).card.name).toBe("Plain");
  });

  test("a zlib bomb is refused with a code, in zTXt and in iTXt", () => {
    const bomb = new Uint8Array(5 * 1024 * 1024);
    expect(codeOf(() => parseCard(png([zTXt("chara", bomb)])))).toBe("compressed_text_too_large");
    expect(codeOf(() => parseCard(png([iTXt("chara", bomb, true)])))).toBe("compressed_text_too_large");
  });

  test("a corrupt compressed chunk is skipped like any unreadable chunk", () => {
    const corrupt: [string, Uint8Array] = ["zTXt", concat(encoder.encode("ccv3"), [0, 0], [1, 2, 3, 4])];
    expect(parseCard(png([corrupt, tEXt("chara", b64Card("Kept"))])).card.name).toBe("Kept");
  });

  test("a truncated chunk ends the walk", () => {
    const whole = png([tEXt("chara", b64Card("Lost"))]);
    expect(codeOf(() => parseCard(whole.subarray(0, 40)))).toBe("no_card_in_png");
  });
});

describe("bounds and hostile shapes", () => {
  test("an oversized file, deep JSON and an oversized book are refused with codes", () => {
    expect(codeOf(() => parseCard(new Uint8Array(MAX_CARD_FILE_BYTES + 1)))).toBe("too_large");
    expect(codeOf(() => parseCard(encoder.encode(`${"[".repeat(65)}${"]".repeat(65)}`), "x.json"))).toBe("too_deep");
    const entries = Array.from({ length: MAX_BOOK_ENTRIES + 1 }, () => ({ content: "x" }));
    expect(codeOf(() => parseCard(encoder.encode(JSON.stringify({ spec: "chara_card_v2", data: { character_book: { entries } } }))))).toBe("too_many_entries");
  });

  test("a __proto__ key in a card is data, not a prototype", () => {
    const card = parseCard(encoder.encode('{"spec":"chara_card_v2","data":{"name":"P","__proto__":{"description":"polluted"},"character_book":{"entries":[{"__proto__":{"secret":true},"content":"x"}]}}}')).card;
    expect(card.description).toBe("");
    expect(splitCard({ source: "sillytavern", card, lorecard: null, unsupportedHooks: 0 }).machinery.secretEntries).toBe(0);
    expect(({} as Record<string, unknown>).description).toBeUndefined();
  });
});

describe("the split", () => {
  const heavy = {
    spec: "chara_card_v3",
    data: {
      name: "理",
      description: "A caretaker.",
      system_prompt: "Always verse.",
      creator_notes_multilingual: { en: "note <% x %>" },
      extensions: { loreweaver_hooks: ["on('turn_start', () => {});"] },
      character_book: {
        entries: [
          { comment: "[InitVar] one", content: '{"理": {"好感度": [33, "affinity"]}, "list": [1, 2]}' },
          { comment: "[InitVar] two", content: "list: [9]\n世界:\n  日: 1\n" },
          { comment: "[InitVar] broken", content: "{oops" },
          { comment: "lore", content: "Plain.", keys: ["k"] },
        ],
      },
    },
  };

  test("a world import merges every readable declaration; the character half carries no machinery", () => {
    const imported = parseCard(encoder.encode(JSON.stringify(heavy)));
    const before = JSON.stringify(imported);
    const split = splitCard(imported);
    expect(split.kind).toBe("world");
    expect(toJson(split.world.variables ?? new Map())).toEqual({ 理: { 好感度: [33, "affinity"] }, list: [9], 世界: { 日: 1 } });
    expect(split.world.entries.map((entry) => entry.comment)).toEqual(["lore"]);
    expect(split.world.systemPrompt).toBe("Always verse.");
    expect(split.warnings).toEqual([
      { code: "hooks_unsupported", count: 1 },
      { code: "declaration_unreadable", count: 1 },
    ]);
    expect(split.character.systemPrompt).toBe("");
    expect(split.character.raw).toBeNull();
    expect(split.character.creatorNotesMultilingual).toEqual({ en: "note " });
    expect(JSON.stringify(split.character)).not.toContain("InitVar");
    expect(JSON.stringify(split.character)).not.toContain("turn_start");
    expect(JSON.stringify(imported)).toBe(before);
  });

  test("a lorecard's hooks are never kept, and its typed variables make it a world card", () => {
    const bundle = {
      format: "loreweaver.card",
      format_version: 1,
      name: "Manor",
      hooks: [{ code: "on('turn_start', () => {});" }],
      variables: [{ id: "suspicion", kind: "number", default: 0 }],
      pregens: [{ name: "Ada", skills: { Spot: 60 } }],
    };
    const imported = parseCard(encoder.encode(JSON.stringify(bundle)), "m.lorecard.json");
    expect(imported.unsupportedHooks).toBe(1);
    expect(JSON.stringify(imported.card.raw)).not.toContain("turn_start");
    const split = splitCard(imported);
    expect(split.kind).toBe("world");
    expect(split.machinery.moduleVariables).toBe(1);
    expect(split.world.moduleVariables.map((spec) => spec.id)).toEqual(["suspicion"]);
    expect(split.world.pregens).toEqual([{ name: "Ada", blurb: "", notes: "", skills: { Spot: 60 } }]);
    expect(splitCard(parseCard(encoder.encode(JSON.stringify({ format: "loreweaver.card", format_version: 1, name: "Plain" })))).kind).toBe("character");
  });
});
