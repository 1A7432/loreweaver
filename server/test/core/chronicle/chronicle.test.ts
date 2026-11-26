import { describe, expect, test } from "bun:test";

import { actorViewer, KEEPER, playerViewer, type Document, type JsonObject, type Viewer } from "../../../src/core/documents/index.ts";
import {
  campaignSummaryData,
  campaignSummaryDocumentType,
  chronicleRecordData,
  chronicleRecordDocumentType,
  chronicleRecordId,
  foldInputLines,
  markRecordFolded,
  MAX_RECORD_CHARACTERS,
  newChronicleRecord,
  newPlotThread,
  plotThreadData,
  plotThreadDocumentType,
  plotThreadId,
  readCampaignSummary,
  readChronicleRecord,
  setSummaryMargin,
  stampFoldMeter,
  summaryThroughTurn,
  updatePlotThread,
  validateCampaignSummary,
  validateChronicleRecord,
  validatePlotThread,
  type CampaignSummary,
  type ChronicleRecord,
} from "../../../src/core/chronicle/index.ts";

const ADMIN: Viewer = { grade: "admin", locale: "en" };
const OBSERVER: Viewer = { grade: "observer", locale: "en" };
const PLAYER = playerViewer("en", "member-1");
const ACTOR = actorViewer("npc-1", "en");
const NOT_KEEPER: readonly Viewer[] = [ADMIN, PLAYER, OBSERVER, ACTOR];
const MARK = "LEAKMARK";

function doc(type: string, id: string, data: JsonObject): Document {
  return { type, id, version: 1, data, meta: {}, corrupt: false };
}

const seen = (view: unknown): string => JSON.stringify(view) ?? "undefined";

function made<T>(change: { ok: true; data: T } | { ok: false; code: string }): T {
  if (!change.ok) throw new Error(`refused: ${change.code}`);
  return change.data;
}

describe("chronicle records", () => {
  test("a new record is stamped by the engine, trimmed, and its character list cleaned", () => {
    const record = made(newChronicleRecord({ text: "  The bell rang. ", keeper: " armed ", characters: [" Ada ", "", "Ada", "Bo"], scene: " Belfry " }, 7));
    expect(record).toEqual({ turn: 7, text: "The bell rang.", characters: ["Ada", "Bo"], scene: "Belfry", keeper: "armed", folded: false });
    expect(newChronicleRecord({ text: "x" }, 0)).toEqual({ ok: false, code: "bad_turn", path: "turn" });
    expect(newChronicleRecord({ text: "x" }, 1.5)).toEqual({ ok: false, code: "bad_turn", path: "turn" });
    expect(newChronicleRecord({ text: "   " }, 1)).toEqual({ ok: false, code: "empty", path: "text" });
    expect(newChronicleRecord({ text: "字".repeat(2001) }, 1)).toEqual({ ok: false, code: "too_long", path: "text" });
    const many = Array.from({ length: MAX_RECORD_CHARACTERS + 1 }, (_, i) => `pc${i}`);
    expect(newChronicleRecord({ text: "x", characters: many }, 1)).toEqual({ ok: false, code: "too_many", path: "characters" });
  });

  test("ids sort in writing order and are bounded", () => {
    expect(made(chronicleRecordId(1))).toBe("c000001");
    expect(made(chronicleRecordId(999_999))).toBe("c999999");
    expect(chronicleRecordId(1_000_000)).toEqual({ ok: false, code: "limit_reached", path: "sequence" });
    expect(chronicleRecordId(0).ok).toBe(false);
  });

  test("round trip and validation", () => {
    const record = made(newChronicleRecord({ text: "x" }, 3));
    const data = chronicleRecordData(record);
    expect(validateChronicleRecord(data)).toEqual([]);
    expect(readChronicleRecord(data)).toEqual(record);
    expect(validateChronicleRecord({ ...data, tokens: 4 }).map((v) => v.code)).toEqual(["unknown_field"]);
    expect(validateChronicleRecord({ ...data, folded: 1 }).map((v) => v.path)).toEqual(["folded"]);
    expect(markRecordFolded(record)).toEqual({ ...record, folded: true });
    expect(markRecordFolded(markRecordFolded(record))).toEqual({ ...record, folded: true });
  });

  test("the keeper annotation and the fold bookkeeping never reach a player-grade view", () => {
    const record: ChronicleRecord = { turn: 4, text: "They found the ledger.", characters: ["Ada"], scene: "Archive", keeper: `${MARK}: the ledger is forged`, folded: true };
    const document = doc(chronicleRecordDocumentType.name, "c000004", chronicleRecordData(record));
    for (const viewer of NOT_KEEPER) {
      const view = chronicleRecordDocumentType.project(document, viewer);
      expect(view).toEqual({ turn: 4, text: "They found the ledger.", characters: ["Ada"], scene: "Archive" });
      expect(seen(view)).not.toContain(MARK);
      expect(seen(view)).not.toContain("folded");
    }
    expect(chronicleRecordDocumentType.project(document, KEEPER)).toEqual(record);
    const smuggled = doc(document.type, document.id, { ...document.data, secretTail: MARK });
    for (const viewer of [KEEPER, ...NOT_KEEPER]) expect(seen(chronicleRecordDocumentType.project(smuggled, viewer))).not.toContain(MARK);
  });

  test("the fold input carries the public line only", () => {
    const record: ChronicleRecord = { turn: 4, text: "They found the ledger.", characters: [`${MARK}-pc`], scene: `${MARK}-scene`, keeper: MARK, folded: false };
    const lines = foldInputLines([record]);
    expect(lines).toEqual([{ turn: 4, text: "They found the ledger." }]);
    expect(seen(lines)).not.toContain(MARK);
  });
});

describe("the campaign summary", () => {
  const summary: CampaignSummary = { text: "Previously: the archive drowned.", throughTurn: 14, foldCount: 2, keeper: `${MARK}: the archivist lied`, foldMeter: { tokens: 611, estimated: true } };

  test("round trip, validation, margin and stamp", () => {
    const data = campaignSummaryData(summary);
    expect(validateCampaignSummary(data)).toEqual([]);
    expect(readCampaignSummary(data)).toEqual(summary);
    expect(validateCampaignSummary({ ...data, foldMeter: { tokens: 1 } }).map((v) => v.path)).toEqual(["foldMeter"]);
    expect(validateCampaignSummary({ ...data, text: "" }).map((v) => v.code)).toEqual(["empty"]);
    expect(validateCampaignSummary({ ...data, throughTurn: -1 }).map((v) => v.path)).toEqual(["throughTurn"]);
    expect(summaryThroughTurn(null)).toBe(0);
    expect(summaryThroughTurn(readCampaignSummary({ ...data, throughTurn: "x" }))).toBe(0);
    expect(summaryThroughTurn(summary)).toBe(14);
    expect(made(setSummaryMargin(summary, "  new note "))).toEqual({ ...summary, keeper: "new note" });
    expect(setSummaryMargin(summary, "x".repeat(4001))).toEqual({ ok: false, code: "too_long", path: "keeper" });
    expect(stampFoldMeter(summary, { tokens: 611, estimated: true })).toBe(summary);
    expect(stampFoldMeter(summary, null)).toEqual({ ...summary, foldMeter: null });
  });

  test("the table sees the text and its through-turn; the margin and the meter stay keeper-side", () => {
    const document = doc(campaignSummaryDocumentType.name, "summary", campaignSummaryData(summary));
    for (const viewer of NOT_KEEPER) {
      const view = campaignSummaryDocumentType.project(document, viewer);
      expect(view).toEqual({ text: "Previously: the archive drowned.", throughTurn: 14 });
      expect(seen(view)).not.toContain(MARK);
      expect(seen(view)).not.toContain("611");
    }
    expect(campaignSummaryDocumentType.project(document, KEEPER)).toEqual(summary);
  });
});

describe("plot threads", () => {
  test("creation, update and the label-derived id", () => {
    const thread = made(newPlotThread("  The forged ledger ", "planted act 1"));
    expect(thread).toEqual({ label: "The forged ledger", status: "open", notes: "planted act 1" });
    expect(made(updatePlotThread(thread, { status: "resolved" }))).toEqual({ ...thread, status: "resolved" });
    expect(newPlotThread(" ")).toEqual({ ok: false, code: "empty", path: "label" });
    expect(updatePlotThread(thread, { notes: "x".repeat(4001) })).toEqual({ ok: false, code: "too_long", path: "notes" });
    expect(plotThreadId("The Forged Ledger ")).toBe(plotThreadId("the forged ledger"));
    expect(plotThreadId("the forged ledger")).toMatch(/^t-[0-9a-f]{16}$/u);
    expect(plotThreadId("the forged ledger")).not.toBe(plotThreadId("the forged ledgers"));
    expect(plotThreadId("")).toBe("t-cbf29ce484222325");
    expect(validatePlotThread({ ...plotThreadData(thread), status: "stale" }).map((v) => v.path)).toEqual(["status"]);
  });

  test("a thread exists for the Keeper only — even its label can be a spoiler", () => {
    const document = doc(plotThreadDocumentType.name, plotThreadId("x"), plotThreadData({ label: `${MARK} mayor`, status: "open", notes: MARK }));
    for (const viewer of NOT_KEEPER) expect(plotThreadDocumentType.project(document, viewer)).toBeNull();
    expect(plotThreadDocumentType.project(document, KEEPER)).toEqual({ label: `${MARK} mayor`, status: "open", notes: MARK });
  });
});

test("lifecycles: all three are play history", () => {
  expect(chronicleRecordDocumentType.lifecycle).toEqual({ reset: "story" });
  expect(campaignSummaryDocumentType.lifecycle).toEqual({ reset: "story" });
  expect(plotThreadDocumentType.lifecycle).toEqual({ reset: "story" });
});
