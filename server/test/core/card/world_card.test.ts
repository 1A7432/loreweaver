import { describe, expect, test } from "bun:test";

import {
  MAX_ALTERNATE_GREETINGS,
  MAX_WORLD_NAME_CHARS,
  prepareDirective,
  readWorldCardDocument,
  validateWorldCard,
  worldCardData,
  worldCardDocumentType,
  worldCardId,
  WORLD_CARD_TYPE,
  type WorldCard,
} from "../../../src/core/card/index.ts";
import { actorViewer, KEEPER, playerViewer, type Document, type Viewer } from "../../../src/core/documents/index.ts";

const HASH = "a".repeat(64);

function card(overrides: Partial<WorldCard> = {}): WorldCard {
  return {
    name: "Harbor Town",
    description: "desc",
    personality: "",
    scenario: "scenario",
    examples: "",
    creatorNotes: "",
    head: "head text",
    postHistory: "post text",
    opening: "The fog rolls in.",
    alternates: ["Rain again."],
    provenance: { hash: HASH, importedAt: 5, importedBy: "m-admin", format: "sillytavern" },
    ...overrides,
  };
}

function documentOf(value: WorldCard): Document {
  return { type: WORLD_CARD_TYPE, id: worldCardId(value.name), version: 1, data: worldCardData(value), meta: {}, corrupt: false };
}

describe("world_card", () => {
  test("is part of the imported world: only a reset of the whole room removes it", () => {
    expect(worldCardDocumentType.lifecycle).toEqual({ reset: "all" });
  });

  test("round-trips a valid payload", () => {
    const value = card();
    expect(validateWorldCard(worldCardData(value))).toEqual([]);
    expect(readWorldCardDocument(documentOf(value))).toEqual(value);
  });

  test("refuses what is over a bound or malformed", () => {
    expect(validateWorldCard(worldCardData(card({ name: "名".repeat(MAX_WORLD_NAME_CHARS + 1) })))[0]?.code).toBe("too_long");
    expect(validateWorldCard(worldCardData(card({ name: "名".repeat(MAX_WORLD_NAME_CHARS) })))).toEqual([]);
    expect(validateWorldCard(worldCardData(card({ alternates: Array.from({ length: MAX_ALTERNATE_GREETINGS + 1 }, () => "x") })))[0]?.path).toBe("alternates");
    expect(validateWorldCard({ ...worldCardData(card()), extra: 1 })[0]).toEqual({ code: "unknown_field", path: "extra" });
    const badHash = { ...worldCardData(card()), provenance: { hash: "nope", importedAt: 1, importedBy: null, format: "sillytavern" } };
    expect(validateWorldCard(badHash)[0]?.path).toBe("provenance.hash");
    expect(readWorldCardDocument({ ...documentOf(card()), data: badHash })).toBeNull();
  });

  test("the sentinel: directives, prose and openings reach the Keeper alone", () => {
    const M = { desc: "MK-DESC", pers: "MK-PERS", scen: "MK-SCEN", ex: "MK-EX", notes: "MK-NOTES", head: "MK-HEAD", post: "MK-POST", open: "MK-OPEN", alt: "MK-ALT", by: "MK-BY" };
    const value = card({
      description: M.desc,
      personality: M.pers,
      scenario: M.scen,
      examples: M.ex,
      creatorNotes: M.notes,
      head: M.head,
      postHistory: M.post,
      opening: M.open,
      alternates: [M.alt],
      provenance: { hash: HASH, importedAt: 1, importedBy: M.by, format: "lorecard" },
    });
    const document = documentOf(value);
    const keeper = JSON.stringify(worldCardDocumentType.project(document, KEEPER));
    for (const mark of Object.values(M)) expect(keeper).toContain(mark);

    const text = Object.values(M).filter((mark) => mark !== M.by);
    const admin = worldCardDocumentType.project(document, { grade: "admin", locale: "en", memberId: "m-admin" });
    expect(admin).toMatchObject({ view: "admin", name: "Harbor Town", headChars: M.head.length, postHistoryChars: M.post.length, openings: 2 });
    for (const mark of text) expect(JSON.stringify(admin)).not.toContain(mark);

    const table: Viewer[] = [
      playerViewer("en", "m-1"),
      { grade: "observer", locale: "en" },
      actorViewer("npc-1", "en"),
      { grade: "admin", locale: "en", actorId: "npc-1" },
    ];
    for (const viewer of table) {
      const view = worldCardDocumentType.project(document, viewer);
      expect(view).toEqual({ view: "table", id: "card:Harbor Town", name: "Harbor Town" });
      for (const mark of Object.values(M)) expect(JSON.stringify(view)).not.toContain(mark);
    }
  });

  test("a corrupt or invalid payload has no view", () => {
    expect(worldCardDocumentType.project({ ...documentOf(card()), data: { name: 3 } }, KEEPER)).toBeNull();
  });
});

describe("prepareDirective", () => {
  test("drops template code, {{original}} and comments, binds {{char}}, keeps other macros", () => {
    const text = "  <% if (x) { %>You are {{char}}<% } %>. {{original}} Speak to {{user}}. {{// author note}} {{ CHAR }}  ";
    expect(prepareDirective(text, "Mira")).toBe("You are Mira.  Speak to {{user}}.  Mira");
  });

  test("an unnamed card leaves {{char}} for the per-turn pass", () => {
    expect(prepareDirective("Be {{char}}", "")).toBe("Be {{char}}");
  });

  test("a dangling template opener strips to the end", () => {
    expect(prepareDirective("Rule one. <% broken", "")).toBe("Rule one.");
  });
});
