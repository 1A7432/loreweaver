// The session report: the model read off the event log, the page (everything written by a
// person or a model escaped), and the reveal edition's material decided by comparing views.
import { expect, test } from "bun:test";

import { buildReport, MAX_TRANSCRIPT_CHARS, renderMarkdown, renderPlain, renderReportHtml, renderReportText, scoreOf, type RevealModel } from "../../../src/core/report/index.ts";
import type { StoredEvent } from "../../../src/infra/store.ts";

let seq = 0;
function event(kind: string, data: unknown, turn?: number, ts = 1_764_240_000_000 + seq * 60_000): StoredEvent {
  seq += 1;
  return turn === undefined ? { seq, id: `e${seq}`, ts, kind, data } : { seq, id: `e${seq}`, ts, kind, turn, data };
}
const said = (name: string, text: string, turn: number): StoredEvent => event("narrative", { speaker: "player", name, member: `m-${name}`, text, format: "plain" }, turn);
const kp = (text: string, turn: number): StoredEvent => event("narrative", { speaker: "kp", text, format: "markdown" }, turn);
const check = (actor: string, flags: { success?: boolean; critical?: boolean; fumble?: boolean; tier?: number }, turn = 1): StoredEvent =>
  event(
    "dice",
    {
      actor,
      kind: "check",
      expr: "1d100",
      rolls: [19],
      total: 19,
      target: 25,
      outcome: { id: "x", label: flags.critical === true ? "Critical" : "Success", success: flags.success ?? false, critical: flags.critical ?? false, fumble: flags.fumble ?? false, tier: flags.tier ?? 2 },
      detail: { skill: "Spot Hidden" },
    },
    turn,
  );
const roll = (actor: string): StoredEvent => event("dice", { actor, kind: "roll", expr: "2d6", rolls: [5, 5], total: 10, detail: { text: "2d6 (5, 5) = 10" } }, 1);

function model(events: StoredEvent[], system: string | null = "Call of Cthulhu 7e") {
  return buildReport({ room: "harbor", system, events, generatedAt: 1_764_250_000_000 });
}

test("the model is read off the log: who played, their dice, the lines in order", () => {
  const m = model([
    said("Ada", "I look around.", 1),
    check("Ada", { success: true }),
    check("Ada", { success: true, critical: true }),
    check("Ada", { fumble: true }),
    roll("Ada"),
    check("The Thing", { success: true }),
    kp("The fog **thickens**.", 1),
    said("Bao", "I wait.", 2),
    event("narrative", { speaker: "system", text: "An hour passes.", format: "plain" }, 2),
  ]);
  expect(m.players).toEqual(["Ada", "Bao"]);
  // An NPC's roll is in the log of dice and in nobody's tally.
  expect(m.dice.map((die) => die.actor)).toEqual(["Ada", "Ada", "Ada", "Ada", "The Thing"]);
  expect(m.tally.map((player) => player.name)).toEqual(["Ada", "Bao"]);
  expect(m.tally[0]).toMatchObject({ rolls: 1, checks: 3, passed: 2, criticals: 1, fumbles: 1, tones: { crit: 1, success: 1, fail: 0, fumble: 1, plain: 1 } });
  expect(m.tally[1]).toMatchObject({ rolls: 0, checks: 0 });
  expect(m.lines.map((line) => [line.speaker, line.turn])).toEqual([
    ["player", 1],
    ["kp", 1],
    ["player", 2],
    ["system", 2],
  ]);
  expect(m.turns).toBe(2);
  expect(m.dice[0]).toMatchObject({ what: "Spot Hidden", target: 25, graded: true, tone: "success" });
});

test("a roll is named as the table read it: its label in the room's language before the rule system's own word", () => {
  const data = { actor: "Ada", kind: "check", expr: "1d100", rolls: [14], total: 14, target: 25, label: "Spot Hidden", outcome: { id: "regular", label: "Success", success: true, critical: false, fumble: false, tier: 2 }, detail: { skill: "侦查" } };
  expect(model([event("dice", data, 1)]).dice[0]).toMatchObject({ what: "Spot Hidden", expr: "1d100" });
  const { label: _label, ...unlabelled } = data;
  expect(model([event("dice", unlabelled, 1)]).dice[0]).toMatchObject({ what: "侦查" });
});

test("the score is the 2.6 formula", () => {
  expect(scoreOf({ rolls: 0, checks: 0, passed: 0, criticals: 0 })).toEqual({ score: 60, rating: "qualified" });
  // 60 + min(4·2, 20) + floor(2/3·20) + 1·2
  expect(scoreOf({ rolls: 1, checks: 3, passed: 2, criticals: 1 })).toEqual({ score: 83, rating: "excellent" });
  expect(scoreOf({ rolls: 40, checks: 40, passed: 40, criticals: 40 })).toEqual({ score: 100, rating: "legendary" });
});

test("what came before the last reset of the story is another session's", () => {
  const m = model([said("Old", "long ago", 1), check("Old", { success: true }), event("reset", { scope: "chars", epoch: 2 }), event("reset", { scope: "story", epoch: 3 }), said("Ada", "anew", 1)]);
  expect(m.players).toEqual(["Ada"]);
  expect(m.dice).toEqual([]);
  // A reset of the characters alone does not end the session.
  expect(model([said("Ada", "one", 1), event("reset", { scope: "chars", epoch: 2 }), said("Ada", "two", 2)]).lines).toHaveLength(2);
});

test("a transcript too long to print keeps the newest lines and says how many it left out", () => {
  const long = "好".repeat(MAX_TRANSCRIPT_CHARS / 4);
  const m = model([said("Ada", `${long}1`, 1), said("Ada", `${long}2`, 2), said("Ada", `${long}3`, 3), said("Ada", `${long}4`, 4), said("Ada", `${long}5`, 5)]);
  // Counted in characters, not UTF-16 units or bytes: three lines of a quarter-cap fit.
  expect(m.lines.map((line) => line.text.at(-1))).toEqual(["3", "4", "5"]);
  expect(m.omitted).toBe(2);
  const page = renderReportHtml(m, "en").html;
  expect(page).toContain("the 2 earliest messages were left out and the 3 most recent");
  // The newest line is kept even when it alone is over the cap.
  expect(model([said("Ada", "x".repeat(MAX_TRANSCRIPT_CHARS + 5), 1)]).lines).toHaveLength(1);
});

test("malformed events are passed over, never guessed at", () => {
  const m = model([event("narrative", { speaker: "ghost", text: "boo" }), event("narrative", null), event("dice", { actor: "", total: 3 }), event("dice", { actor: "Ada", total: "3" }), event("blocks", { blocks: [] }), said("Ada", "   ", 1)]);
  expect(m.lines).toEqual([]);
  expect(m.dice).toEqual([]);
});

test("everything a person or a model wrote is escaped; narration keeps emphasis and loses link targets", () => {
  const hostile = '<script>alert(1)</script> & "quotes" <img src=x onerror=1>';
  const m = model([
    said(`Ada<b>${"`"}`, hostile, 1),
    kp(`# A lead\n\n**bold** and *soft* [a link](https://evil.example/x) ![pic](https://evil.example/p.png)\n\n- one\n- two\n\n${hostile}`, 1),
    event("dice", { actor: "<i>Eve</i>", kind: "roll", expr: "1d6<script>", rolls: [1], total: 1 }, 1),
  ], "<u>System</u>");
  const page = renderReportHtml({ ...m, room: "<room>" }, "en").html;
  const has = (needle: string): boolean => page.includes(needle);
  expect(has("<script>alert")).toBe(false);
  expect(page).not.toContain("<img");
  expect(page).not.toContain("evil.example");
  expect(page).not.toContain("<i>Eve</i>");
  expect(page).not.toContain("<u>System</u>");
  expect(page).not.toContain("<room>");
  expect(page).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  expect(page).toContain('<p class="lead">A lead</p>');
  expect(page).toContain("<strong>bold</strong> and <em>soft</em> a link pic");
  expect(page).toContain("<ul><li>one</li><li>two</li></ul>");
  // The page loads nothing from anywhere.
  expect(page).not.toMatch(/<(?:script|link|iframe|object|embed)\b/u);
  expect(page).not.toMatch(/<[a-z][^<>]*\s(?:src|href|on[a-z]+)\s*=/u);
  expect(page.startsWith("<!DOCTYPE html>")).toBe(true);
});

test("the Markdown subset on its own", () => {
  expect(renderMarkdown("a\nb\n\nc")).toBe("<p>a<br>b</p><p>c</p>");
  expect(renderMarkdown("1. one\n2) two")).toBe("<ol><li>one</li><li>two</li></ol>");
  expect(renderMarkdown("> quoted\n---\nafter")).toBe("<p>quoted<br>after</p>");
  expect(renderMarkdown("snake_case_name and 2*3*4 stay")).toBe("<p>snake_case_name and 2*3*4 stay</p>");
  expect(renderMarkdown("**加粗**与*强调*")).toBe("<p><strong>加粗</strong>与<em>强调</em></p>");
  expect(renderMarkdown("  ")).toBe("");
  expect(renderPlain("**not** <b>markup</b>\n\nnext")).toBe("<p>**not** &lt;b&gt;markup&lt;/b&gt;</p><p>next</p>");
});

const REVEAL: RevealModel = {
  margins: [{ turn: 3, keeper: "SENTINEL-MARGIN <b>", text: "They reached the quay." }],
  summaryMargin: "SENTINEL-SUMMARY-MARGIN",
  lore: [{ title: "SENTINEL-LORE-TITLE", content: "SENTINEL-LORE-CONTENT" }],
  npcs: [{ name: "Old Marsh", secret: "SENTINEL-AGENDA", knowledge: ["SENTINEL-FACT"] }],
  keeperVars: [{ label: "SENTINEL-VAR", value: 7 }],
  hiddenLeaves: [{ path: "SENTINEL.leaf", value: true }],
};

test("the player edition holds nothing of the reveal material; the reveal edition holds all of it, escaped", () => {
  const m = model([said("Ada", "hello", 1), kp("The quay.", 1)]);
  const player = renderReportHtml(m, "en");
  expect(player.edition).toBe("player");
  expect(player.html).not.toContain("SENTINEL");
  expect(player.html).not.toContain("Behind the screen");
  expect(player.html).toContain("Player edition");

  const reveal = renderReportHtml(m, "en", REVEAL);
  expect(reveal.edition).toBe("reveal");
  for (const marker of ["SENTINEL-MARGIN &lt;b&gt;", "SENTINEL-SUMMARY-MARGIN", "SENTINEL-LORE-TITLE", "SENTINEL-LORE-CONTENT", "SENTINEL-AGENDA", "SENTINEL-FACT", "SENTINEL-VAR", "SENTINEL.leaf", "Reveal edition", "Behind the screen", "After turn 3"]) {
    expect([marker, reveal.html.includes(marker)]).toEqual([marker, true]);
  }
  expect(reveal.html).not.toContain("SENTINEL-MARGIN <b>");
  expect(reveal.html).toContain("<td>yes</td>");
  // An empty reveal still prints its sections, saying there is nothing.
  expect(renderReportHtml(m, "en", { margins: [], summaryMargin: "", lore: [], npcs: [], keeperVars: [], hiddenLeaves: [] }).html).toContain("Nothing here.");
});

test("both languages; the scoreboard text never carries the transcript", () => {
  const m = model([said("Ada", "A LINE OF THE STORY", 1), check("Ada", { success: true }), kp("NARRATION", 1)]);
  const zh = renderReportHtml(m, "zh").html;
  expect(zh).toContain('<html lang="zh-Hans">');
  expect(zh).toContain("玩家版");
  expect(zh).toContain("各人的骰子");
  const text = renderReportText(m, "en");
  expect(text).toContain("Ada");
  expect(text).toContain("Checks 1/1 passed");
  expect(text).not.toContain("A LINE OF THE STORY");
  expect(text).not.toContain("NARRATION");
  expect(renderReportText(m, "zh")).toContain("检定 1/1 成功");
  // An empty room has a report too.
  const empty = model([]);
  expect(renderReportHtml(empty, "en").html).toContain("This table has not said a word yet.");
  expect(renderReportText(empty, "en")).toContain("Nobody rolled a die this session.");
});
