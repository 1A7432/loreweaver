// The SillyTavern card vectors (`st_card_parse`, `st_card_split`, recorded from the
// frozen Python engine) mapped onto `core/card`.
//
// The target is SillyTavern's behaviour (and the card specs), not the old engine's: each
// row where they differ is listed below with the reason and pinned to the NEW outcome.
//
// Not compared, and why:
// - `error.message`: the old English (or Python exception) text; the error CLASS is the
//   contract, mapped to a `CardError.code` by `expectedCode`.
// - `lorecard.hooks`: 3.0 keeps no hook source. The count is compared against
//   `unsupportedHooks`, and the `hooks_unsupported` warning it produces is extra.
// - Lorecard warnings are compared as (code, where, count) via `expectedWarning`, not as
//   English text.
// - `st_card_split` `character_half.raw`: the new character half carries no source
//   document at all (`raw: null`), so nothing downstream can read machinery off it.
// - `player_import` / `keeper_world_import` `entries`: the per-field normalization of a
//   lore entry (clamps, `{{char}}` binding, the constant/secret trust rules) is the
//   lorebook importer's job (`st_worldbook_import`), not the split's. Here the split's
//   part is compared: how many entries each import receives, their titles (with the
//   card name bound for `{{char}}` as the importer binds it) and which are keeper-only,
//   the declared variable tree, and the hook count.
import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";

import { CardError, entryTitle, isSecretEntry, isVariableDeclaration, isWorld, parseCard, splitCard, stripTemplates, type CardErrorCode, type CharacterCard } from "../../../src/core/card/index.ts";
import { toJson, type VariableSpec } from "../../../src/core/variables/index.ts";
import { readReference } from "../../reference.ts";

type Row = Record<string, any>;

function bytesOf(input: Row): Uint8Array {
  return input.b64 !== undefined ? new Uint8Array(Buffer.from(input.b64, "base64")) : new TextEncoder().encode(input.text);
}

/** The new card in the vectors' 2.x field names. */
function legacyCard(card: CharacterCard): Record<string, unknown> {
  return {
    character_book: card.book,
    creator_notes: card.creatorNotes,
    description: card.description,
    first_mes: card.firstMessage,
    mes_example: card.exampleMessages,
    name: card.name,
    personality: card.personality,
    post_history_instructions: card.postHistoryInstructions,
    scenario: card.scenario,
    system_prompt: card.systemPrompt,
    tags: card.tags,
    raw: card.raw,
  };
}

function legacySpec(spec: VariableSpec): Record<string, unknown> {
  const { optionLabels, ...rest } = spec;
  return optionLabels === undefined ? rest : { ...rest, option_labels: optionLabels };
}

function expectedCode(error: { type: string; message: string }): CardErrorCode {
  const message = error.message;
  if (error.type === "JSONDecodeError") return "bad_json";
  const table: [string, CardErrorCode][] = [
    ["must be an object", "not_an_object"],
    ["unsupported character card format", "unsupported_format"],
    ["does not contain a SillyTavern", "no_card_in_png"],
    ["invalid embedded", "bad_embedded_payload"],
    ["payload is not a JSON object", "embedded_not_an_object"],
    ["compressed character-card text", "compressed_text_too_large"],
    ["unsupported format_version", "unsupported_version"],
    ["must be an integer", "bad_version"],
    ["worldbook has", "too_many_entries"],
    ["variables declared", "too_many_variables"],
  ];
  const hit = table.find(([needle]) => message.includes(needle));
  if (hit === undefined) throw new Error(`unmapped error: ${message}`);
  return hit[1];
}

function expectedWarning(message: string): Record<string, unknown> {
  const where = message.slice(0, message.indexOf(": "));
  const table: [RegExp, string][] = [
    [/entry must be a JSON object/, "entry_not_object"],
    [/content must be text/, "content_not_text"],
    [/content exceeds/, "content_too_long"],
    [/empty content/, "content_empty"],
    [/condition is longer/, "condition_too_long"],
    [/variable spec must be a JSON object/, "variable_not_object"],
    [/unusable id/, "variable_unusable"],
    [/duplicate variable id/, "variable_duplicate"],
    [/only an enum variable/, "option_labels_not_enum"],
    [/must map a locale/, "option_labels_wrong_type"],
    [/label\(s\) dropped/, "option_labels_dropped"],
    [/^pregens\[\d+\]: ignored \(must be an object\)/, "pregen_not_object"],
    [/missing name/, "pregen_missing_name"],
    [/not an integer/, "pregen_skill_not_integer"],
    [/skills: ignored \(must be a mapping\)/, "pregen_skills_wrong_type"],
    [/truncated to/, "pregens_truncated"],
    [/^\w+: ignored \(must be a list/, "section_wrong_type"],
  ];
  const hit = table.find(([pattern]) => pattern.test(message));
  if (hit === undefined) throw new Error(`unmapped warning: ${message}`);
  const dropped = /(\d+) label\(s\) dropped/.exec(message);
  const truncated = /truncated to (\d+)/.exec(message);
  const count = dropped?.[1] ?? truncated?.[1];
  return count === undefined ? { code: hit[1], where } : { code: hit[1], where, count: Number(count) };
}

// ---------------------------------------------------------------------------
// st_card_parse
// ---------------------------------------------------------------------------

const PARSE_DEVIATIONS: Record<string, { reason: string; card?: Record<string, unknown>; ok?: true; extra?: (card: CharacterCard) => void; warnings?: Record<string, unknown>[] }> = {
  v2_data_not_object: {
    reason: "SillyTavern `readFromV2` keeps a root field when `data` lacks it (a string `data` lacks every field)",
    card: { name: "Root" },
  },
  unknown_spec_uses_root: {
    reason: "SillyTavern `importFromJson` reads `data` for ANY document with a `spec` key",
    card: { name: "DataName" },
  },
  tags_coercion: { reason: "spec v2: `tags: Array<string>` — a number or boolean is not a tag (dropped, not stringified)", card: { tags: ["a", "b"] } },
  tags_not_list: { reason: "SillyTavern `charaFormatData` splits a string `tags` on commas", card: { tags: ["a", "b"] } },
  non_string_fields: {
    reason: "ruled: no Python str(); a number/boolean is its JSON text, a structure is not prose (absent)",
    card: { name: "42", personality: "true", scenario: "", first_mes: "", mes_example: "1.5" },
  },
  creator_notes_multilingual_fallback: {
    reason: "spec v3: `creator_notes_multilingual` is its own map (language -> text), never stringified into `creator_notes`",
    card: { creator_notes: "" },
    extra: (card) => expect(card.creatorNotesMultilingual).toEqual({ en: "hi", zh: "你好" }),
  },
  png_first_card_chunk_wins: {
    reason: "SillyTavern `character-card-parser.js` `read`: a `ccv3` chunk takes precedence over `chara` wherever it sits",
    card: { name: "Ada3", description: "v3 scholar", raw: { data: { description: "v3 scholar", name: "Ada3" }, spec: "chara_card_v3" } },
  },
  png_studio_fixture: {
    reason: "ccv3 precedence (as png_first_card_chunk_wins): the parsed fields agree, `raw` is the v3 document",
    extra: (card) => expect(card.raw?.spec).toBe("chara_card_v3"),
  },
  // 3.0 reads a native bundle's flags as booleans: `secret: 0` (and `constant: 1`) skip the
  // entry with `flag_not_boolean` naming the first such field, where 2.x read them by
  // truthiness (`secret: "false"` was secret). The "num" entry and the dict-content skip
  // are unchanged.
  lorecard_entry_coercions: {
    reason: "a native bundle's flags are booleans: a non-boolean `secret` skips the entry (flag_not_boolean), never read by truthiness",
    card: {
      character_book: [
        {
          case_sensitive: false,
          category: "lore",
          comment: "num",
          constant: false,
          content: "12345",
          cooldown: 0,
          delay: 0,
          enabled: true,
          keys: [],
          match_whole_words: false,
          position: "after_char",
          priority: 0,
          probability: 100,
          scan_depth: 0,
          secondary_keys: [],
          secret: false,
          selective: false,
          selective_logic: "and_any",
          sticky: 0,
        },
      ],
    },
    warnings: [
      { code: "flag_not_boolean", where: "worldbook[0].secret" },
      { code: "content_not_text", where: "worldbook[2]" },
    ],
  },
  png_named_json: {
    reason: "a PNG is recognized by its signature whatever its name (SillyTavern goes by the extension and would fail)",
    ok: true,
    extra: (card) => expect(card.name).toBe("Ada"),
  },
};

describe("st_card_parse", () => {
  const rows = readReference<Row>("st_card_parse");
  test("covers every row", () => {
    expect(rows.length).toBe(63);
  });
  for (const row of rows) {
    test(row.case, () => {
      const deviation = PARSE_DEVIATIONS[row.case];
      const bytes = bytesOf(row.input);
      if (!row.ok && deviation?.ok !== true) {
        let caught: unknown;
        try {
          parseCard(bytes, row.input.filename);
        } catch (error) {
          caught = error;
        }
        expect(caught).toBeInstanceOf(CardError);
        expect((caught as CardError).code).toBe(expectedCode(row.error));
        return;
      }
      const imported = parseCard(bytes, row.input.filename);
      deviation?.extra?.(imported.card);
      if (!row.ok) return;
      expect(imported.source === "lorecard" ? "lorecard" : "st").toBe(row.dispatch);
      const got = legacyCard(imported.card);
      const expected: Record<string, unknown> = { ...row.card, ...(deviation?.card ?? {}) };
      // `raw` was recorded for PNG rows only; the studio PNG's raw is the v3 document.
      if (row.case === "png_studio_fixture") delete expected.raw;
      for (const key of Object.keys(expected)) expect([key, got[key]]).toEqual([key, expected[key]]);
      if (row.lorecard) {
        const lorecard = imported.lorecard;
        expect(lorecard).not.toBeNull();
        if (lorecard === null) return;
        expect(imported.card.alternateGreetings).toEqual(row.lorecard.alternate_greetings);
        expect(lorecard.variables.map(legacySpec)).toEqual(row.lorecard.variable_specs);
        expect(lorecard.pregens).toEqual(row.lorecard.pregens);
        expect(lorecard.unsupportedHooks).toBe(row.lorecard.hooks.length);
        expect(lorecard.warnings.filter((warning) => warning.code !== "hooks_unsupported")).toEqual(deviation?.warnings ?? row.lorecard.warnings.map(expectedWarning));
        const hookWarnings = lorecard.warnings.filter((warning) => warning.code === "hooks_unsupported");
        expect(hookWarnings).toEqual(row.lorecard.hooks.length > 0 ? [{ code: "hooks_unsupported", where: "hooks", count: row.lorecard.hooks.length }] : []);
        expect(JSON.stringify(imported.card.raw)).not.toContain("turn_start");
      }
    });
  }
});

// ---------------------------------------------------------------------------
// st_card_split
// ---------------------------------------------------------------------------

interface SplitOverride {
  readonly reason: string;
  readonly kind?: string;
  readonly payloads?: Record<string, unknown>;
  readonly half?: Record<string, unknown>;
  readonly worldTitles?: string[];
  readonly playerTitles?: string[];
  readonly tree?: unknown;
  readonly hooks?: number;
}

const SPLIT_DEVIATIONS: Record<string, SplitOverride> = {
  heavy_card: {
    reason: "the character half also strips EJS from the alternate greetings (they are shown to the table)",
    payloads: { ejs_blocks: 4 },
  },
  root_hooks_shadowed_by_data_extensions: {
    reason: "hook scripts are counted in every place a 2.x card put them; a `data.extensions` no longer hides root ones",
    kind: "world",
    payloads: { hooks: 1, any: true, any_stripped: true },
    hooks: 1,
  },
  ejs_in_greetings_and_title_kept: {
    reason: "EJS is stripped from every text the table can see: greetings, the name, entry titles and keys",
    kind: "world",
    payloads: { ejs_blocks: 4, any: true, any_stripped: true },
    half: { name: "", character_book: [{ comment: "t", content: "ok", keys: [] }] },
    playerTitles: ["t"],
  },
  initvar_in_name_field: {
    reason: "MagVarUpdate marks a declaration with `[initvar]` WITH brackets; `MVU INITVAR` is ordinary lore",
    kind: "character",
    payloads: { initvar_entries: 0, any: false, any_stripped: false },
    half: { character_book: [{ content: "a: 1\n", name: "MVU INITVAR" }] },
    worldTitles: ["MVU INITVAR"],
    playerTitles: ["MVU INITVAR"],
    tree: {},
  },
  secret_in_extensions: {
    reason: "an entry flagged secret in its `extensions` is keeper-only lore too: counted as machinery and dropped from the character half",
    kind: "world",
    payloads: { secret_entries: 1, any: true, any_stripped: true },
    half: { character_book: [{ comment: "lore", content: "X", keys: ["x"] }] },
  },
};

const DECLARATION_DEVIATIONS: Record<string, { reason: string; result: boolean }> = {
  decl_name_fallback: { reason: "MagVarUpdate marks a declaration with `[initvar]` WITH brackets", result: false },
};

function boundTitle(title: string, name: string): string {
  return title.replace(/\{\{char\}\}|<bot>/gi, name);
}

describe("st_card_split", () => {
  const rows = readReference<Row>("st_card_split");
  test("covers every row", () => {
    expect(rows.length).toBe(40);
  });
  for (const row of rows) {
    test(row.case, () => {
      if (row.op === "strip_ejs") {
        expect(stripTemplates(row.input.text)).toEqual({ text: row.text, spans: row.spans_removed });
        return;
      }
      if (row.op === "is_variable_declaration_entry") {
        expect(isVariableDeclaration(row.input.entry)).toBe(DECLARATION_DEVIATIONS[row.case]?.result ?? row.result);
        return;
      }
      const deviation = SPLIT_DEVIATIONS[row.case] ?? { reason: "" };
      const filename = row.input.dispatch === "lorecard" ? "card.lorecard.json" : "card.json";
      const imported = parseCard(new TextEncoder().encode(JSON.stringify(row.input.card)), filename);
      expect(imported.source === "lorecard" ? "lorecard" : "st").toBe(row.input.dispatch);
      const split = splitCard(imported);
      const machinery = split.machinery;

      expect(split.kind).toBe((deviation.kind ?? row.kind) as "world" | "character");
      const payloads = { ...row.payloads, ...(deviation.payloads ?? {}) };
      expect({
        hooks: machinery.unsupportedHooks,
        initvar_entries: machinery.variableDeclarations,
        ejs_blocks: machinery.templateSpans,
        secret_entries: machinery.secretEntries,
        directives: machinery.directives,
        any: isWorld(machinery),
        any_stripped: isWorld(machinery) || machinery.directives > 0,
      }).toEqual(payloads);

      const half = legacyCard(split.character);
      expect(half.raw).toBeNull();
      const expectedHalf: Record<string, unknown> = { ...row.character_half, ...(deviation.half ?? {}) };
      delete expectedHalf.raw;
      for (const key of Object.keys(expectedHalf)) expect([key, half[key]]).toEqual([key, expectedHalf[key]]);
      expect(row.character_half_hooks).toEqual([]);

      // The world import: the original lore minus declarations, the tree, the hook count.
      const name = imported.card.name;
      const world = row.keeper_world_import;
      expect(split.world.entries.map((entry) => boundTitle(entryTitle(entry), name))).toEqual(deviation.worldTitles ?? world.entries.map((entry: Row) => entry.title));
      if (deviation.worldTitles === undefined) {
        expect(split.world.entries.map(isSecretEntry)).toEqual(world.entries.map((entry: Row) => entry.secret));
      }
      expect<unknown>(split.world.variables === null ? {} : toJson(split.world.variables)).toEqual(deviation.tree ?? world.mvu_tree);
      expect(machinery.unsupportedHooks).toBe(deviation.hooks ?? world.hooks.length);

      // The player import: the character half's lore, never keeper-only, never a tree.
      const player = row.player_import;
      expect(split.character.book.map((entry) => boundTitle(entryTitle(entry), name))).toEqual(deviation.playerTitles ?? player.entries.map((entry: Row) => entry.title));
      expect(split.character.book.some(isSecretEntry)).toBe(false);
      expect(player.mvu_tree).toEqual({});
    });
  }
});
