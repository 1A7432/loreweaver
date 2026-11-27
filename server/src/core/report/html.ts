// The session report as one self-contained HTML page: the 2.6 page, section for section —
// masthead, the dice by player, every roll in order, the session, and (reveal edition
// only) what was behind the screen.
//
// Everything a person, a pack or a model wrote is ESCAPED before it enters the page; the
// only markup is this file's own fixed tags. Narration goes through a small Markdown
// subset applied to already-escaped text (emphasis, lists, lead lines); a link keeps its
// words and loses its target, an image likewise. The page loads nothing: no script, no
// remote resource, the stylesheet inlined.
import { translate } from "../../infra/i18n.ts";
import { REPORT_CATALOG } from "./catalog.ts";
import { type PlayerTally, type ReportDie, type ReportModel, TONES } from "./model.ts";
import type { RevealModel } from "./reveal.ts";
import { REPORT_STYLESHEET } from "./stylesheet.ts";

type Say = (key: string, params?: Readonly<Record<string, string | number>>) => string;

export interface ReportPage {
  readonly html: string;
  readonly edition: "player" | "reveal";
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#x27;");
}

// --- the safe Markdown subset (applied to ALREADY-ESCAPED text) ---------------------------

const LIST_ITEM = /^\s*(?:([-*+])|(\d{1,3})[.)])\s+(.*)$/u;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/u;
const RULE = /^\s{0,3}(?:[-*_]\s*){3,}$/u;
const QUOTE = /^\s{0,3}&gt;\s?(.*)$/u;
// No group can contain `<`, `>` or `"`: the text is escaped, and every substitution below
// inserts only this file's own tags around escaped content.
const LINK = /!?\[([^\]\n]*)\]\((?:[^()\n]|\([^()\n]*\))*\)/gu;
const CODE = /`([^`\n]+)`/gu;
const STRONG = /\*\*(?=\S)(.+?)(?<=\S)\*\*|__(?=\S)(.+?)(?<=\S)__/gu;
// `*` may open inside running text that has no spaces (Chinese narration: 他*低声*说), so only an
// ASCII word character beside it — `2*3*4` — keeps it literal; `_` stays literal inside any word.
const EM = /(?<![A-Za-z0-9_*])\*(?=\S)(.+?)(?<=\S)\*(?![A-Za-z0-9_*])|(?<![\p{L}\p{N}_])_(?=\S)(.+?)(?<=\S)_(?![\p{L}\p{N}_])/gu;

function inline(escaped: string): string {
  return escaped
    .replace(LINK, (_all, words: string) => words)
    .replace(CODE, (_all, code: string) => code)
    .replace(STRONG, (_all, a: string | undefined, b: string | undefined) => `<strong>${a ?? b ?? ""}</strong>`)
    .replace(EM, (_all, a: string | undefined, b: string | undefined) => `<em>${a ?? b ?? ""}</em>`);
}

function normalise(text: string): string {
  return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim();
}

/** Narration → HTML: paragraphs on blank lines, `<br>` on single newlines, lists, a `#` line as a lead paragraph, a rule dropped. */
export function renderMarkdown(text: string): string {
  const escaped = escapeHtml(normalise(text));
  if (escaped === "") return "";
  const out: string[] = [];
  for (const block of escaped.split(/\n[ \t]*\n+/u)) {
    let run: string[] = [];
    let kind = "";
    const flush = (): void => {
      if (run.length === 0) return;
      if (kind === "ul" || kind === "ol") out.push(`<${kind}>${run.map((item) => `<li>${inline(item)}</li>`).join("")}</${kind}>`);
      else out.push(`<p>${run.map(inline).join("<br>")}</p>`);
      run = [];
      kind = "";
    };
    for (const line of block.split("\n")) {
      if (RULE.test(line)) continue;
      const heading = HEADING.exec(line);
      if (heading !== null) {
        flush();
        out.push(`<p class="lead">${inline(heading[1] ?? "")}</p>`);
        continue;
      }
      const item = LIST_ITEM.exec(line);
      const next = item !== null ? (item[2] !== undefined ? "ol" : "ul") : "p";
      const content = item !== null ? (item[3] ?? "") : (QUOTE.exec(line)?.[1] ?? line);
      if (next !== kind) {
        flush();
        kind = next;
      }
      run.push(content.trim());
    }
    flush();
  }
  return out.join("");
}

/** A player's own words: escaped, paragraphs on blank lines, `<br>` on single newlines. */
export function renderPlain(text: string): string {
  const escaped = escapeHtml(normalise(text));
  if (escaped === "") return "";
  return escaped
    .split(/\n[ \t]*\n+/u)
    .map((block) => `<p>${block.split("\n").join("<br>")}</p>`)
    .join("");
}

// --- small formatting ---------------------------------------------------------------------

function two(value: number): string {
  return String(value).padStart(2, "0");
}

/** A moment in the server's local time: `date`, `time`, or both. */
export function stamp(ms: number | null, parts: "both" | "date" | "time" = "both"): string {
  if (ms === null) return "";
  const at = new Date(ms);
  const date = `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}`;
  const time = `${two(at.getHours())}:${two(at.getMinutes())}`;
  return parts === "date" ? date : parts === "time" ? time : `${date} ${time}`;
}

/** `start – end`, the end's date left out when it is the start's. */
export function playedRange(model: Pick<ReportModel, "start" | "end">): string {
  if (model.start === null) return "";
  if (model.end === null || model.end === model.start) return stamp(model.start);
  return `${stamp(model.start)} – ${stamp(model.end, stamp(model.start, "date") === stamp(model.end, "date") ? "time" : "both")}`;
}

function shown(value: unknown, say: Say): string {
  if (typeof value === "boolean") return say(value ? "value.true" : "value.false");
  if (Array.isArray(value)) return value.map((item) => shown(item, say)).join(", ");
  if (value === null || value === undefined) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function sectionTitle(text: string, ornament = "❦"): string {
  return `<h2 class="section-title"><span class="ornament" aria-hidden="true">${ornament}</span>${escapeHtml(text)}</h2>`;
}

// --- sections -----------------------------------------------------------------------------

function masthead(model: ReportModel, title: string, edition: ReportPage["edition"], say: Say): string {
  const meta: [string, string][] = [
    [say("meta.played"), escapeHtml(playedRange(model))],
    [say("meta.room"), escapeHtml(model.room)],
  ];
  if (model.system !== null) meta.push([say("meta.system"), `<span class="system-name">${escapeHtml(model.system)}</span>`]);
  if (model.players.length > 0) meta.push([say("meta.players"), escapeHtml(model.players.join(say("list_sep")))]);
  const rows = meta.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${value}</dd></div>`).join("");
  return (
    '<header class="masthead">' +
    `<p class="kicker"><span>${escapeHtml(say("kicker"))}</span><span class="${edition === "reveal" ? "edition edition--reveal" : "edition"}">${escapeHtml(say(`edition.${edition}`))}</span></p>` +
    `<h1>${escapeHtml(title)}</h1>` +
    `<dl class="meta">${rows}</dl>` +
    "</header>"
  );
}

function card(player: PlayerTally, say: Say): string {
  const bar = TONES.filter((tone) => player.tones[tone] > 0)
    .map((tone) => `<span class="t-${tone}" style="flex-grow:${player.tones[tone]}"></span>`)
    .join("");
  const counts: [string, string, number][] = [
    ["", "stats.rolls", player.rolls],
    ["", "stats.checks", player.checks],
    ["", "stats.successes", player.passed],
    ["is-crit", "stats.criticals", player.criticals],
    ["is-fumble", "stats.fumbles", player.fumbles],
  ];
  const cells = counts.map(([css, key, value]) => `<div class="${css}"><dt>${escapeHtml(say(key))}</dt><dd>${value}</dd></div>`).join("");
  return (
    '<article class="card"><div class="card-head">' +
    `<span class="card-name">${escapeHtml(player.name)}</span><span class="score">${player.score}</span></div>` +
    `<p class="rating">${escapeHtml(say(`rating.${player.rating}`))}</p>` +
    `<div class="bar" aria-hidden="true">${bar}</div>` +
    `<dl class="counts">${cells}</dl></article>`
  );
}

function tally(model: ReportModel, say: Say): string {
  // A player who never touched a die has no card: the section is the dice's.
  const cards = model.tally.filter((player) => player.rolls + player.checks > 0).map((player) => card(player, say));
  const body = cards.length > 0 ? `<div class="tally">${cards.join("")}</div>` : `<p class="quiet">${escapeHtml(say("stats.empty"))}</p>`;
  return `<section>${sectionTitle(say("stats.heading"))}${body}</section>`;
}

function chip(die: ReportDie, strongFloor: number | null, say: Say): string {
  const when = `<span class="when">${escapeHtml(stamp(die.ts, "time"))}</span>`;
  const who = `<span class="who">${escapeHtml(die.actor)}</span>`;
  if (!die.graded) {
    return `<li class="chip t-plain">${when}${who}<span class="num">${escapeHtml(die.expr)} = ${escapeHtml(die.total)}</span></li>`;
  }
  const strong = die.tone === "success" && die.tier !== null && strongFloor !== null && die.tier > strongFloor;
  const numbers = die.target !== null && die.target !== 0 ? `${escapeHtml(die.total)}/${escapeHtml(die.target)}` : escapeHtml(die.total);
  const label = die.label !== "" ? die.label : die.tone === "crit" ? say("dice.critical") : die.tone === "fumble" ? say("dice.fumble") : "";
  return (
    `<li class="chip t-${die.tone}${strong ? " t-strong" : ""}">${when}${who}` +
    `<span class="what">${escapeHtml(die.what)}</span><span class="num">${numbers}</span><span class="label">${escapeHtml(label)}</span></li>`
  );
}

function diceLog(model: ReportModel, say: Say): string {
  if (model.dice.length === 0) return "";
  // An ordinary pass and a better one are told apart by tier: the lowest passing tier is "ordinary".
  const tiers = model.dice.filter((die) => die.tone === "success" && die.tier !== null).map((die) => die.tier as number);
  const strongFloor = tiers.length > 0 ? Math.min(...tiers) : null;
  return `<section>${sectionTitle(say("dice.heading"), "⚄")}<ul class="chips">${model.dice.map((die) => chip(die, strongFloor, say)).join("")}</ul></section>`;
}

function transcript(model: ReportModel, say: Say): string {
  const heading = sectionTitle(say("transcript.heading"), "§");
  if (model.lines.length === 0) return `<section>${heading}<p class="quiet">${escapeHtml(say("transcript.empty"))}</p></section>`;
  const out: string[] = [];
  if (model.omitted > 0) out.push(`<p class="notice">${escapeHtml(say("transcript.truncated", { omitted: model.omitted, kept: model.lines.length }))}</p>`);
  let previous: number | null | undefined;
  let opened = false;
  for (const line of model.lines) {
    const marker = line.turn !== null && line.turn !== previous ? `${escapeHtml(say("transcript.turn"))}<b>${line.turn}</b>` : "";
    previous = line.turn;
    const narrated = line.speaker === "kp" || line.speaker === "npc";
    const label = line.name !== "" ? line.name : say(line.speaker === "player" ? "transcript.player" : line.speaker === "system" ? "transcript.system" : "transcript.keeper");
    let kind = narrated ? "keeper" : line.speaker === "system" ? "system" : "player";
    if (line.speaker === "kp" && !opened) {
      kind += " msg--opening"; // the first Keeper line carries the drop cap
      opened = true;
    }
    const body = line.format === "markdown" || narrated ? renderMarkdown(line.text) : renderPlain(line.text);
    out.push(`<article class="msg msg--${kind}"><div class="turn">${marker}</div><div class="body"><span class="speaker">${escapeHtml(label)}</span><div class="text">${body}</div></div></article>`);
  }
  return `<section>${heading}<div class="log">${out.join("")}</div></section>`;
}

function vault(title: string, count: number, body: string): string {
  return `<details class="vault"><summary><span>${escapeHtml(title)}</span><span class="count">${count}</span></summary><div class="vault-body">${body}</div></details>`;
}

function behind(reveal: RevealModel, say: Say): string {
  const nothing = `<p class="quiet">${escapeHtml(say("reveal.nothing"))}</p>`;
  const vaults: string[] = [];

  const rows = reveal.margins.map(
    (entry) =>
      `<li><span class="entry-name">${escapeHtml(say("reveal.margin_turn", { turn: entry.turn }))}</span>` +
      `<p class="margin-note">${escapeHtml(entry.keeper)}</p>${entry.text !== "" ? `<p class="context">${escapeHtml(entry.text)}</p>` : ""}</li>`,
  );
  if (reveal.summaryMargin !== "") rows.push(`<li><span class="entry-name">${escapeHtml(say("reveal.summary_margin"))}</span><p class="margin-note">${escapeHtml(reveal.summaryMargin)}</p></li>`);
  vaults.push(vault(say("reveal.margins"), rows.length, rows.length > 0 ? `<ul class="entries">${rows.join("")}</ul>` : nothing));

  const blocks: string[] = [];
  if (reveal.lore.length > 0) {
    const entries = reveal.lore.map((entry) => `<li>${entry.title !== "" ? `<span class="entry-name">${escapeHtml(entry.title)}</span>` : ""}<p class="entry-text">${escapeHtml(entry.content)}</p></li>`);
    blocks.push(`<h3>${escapeHtml(say("reveal.lore"))}</h3><ul class="entries">${entries.join("")}</ul>`);
  }
  if (reveal.npcs.length > 0) {
    const entries = reveal.npcs.map((npc) => {
      const facts = npc.knowledge.length > 0 ? `<p class="entry-note"><b>${escapeHtml(say("reveal.knows"))}</b></p><ul class="facts">${npc.knowledge.map((fact) => `<li>${escapeHtml(fact)}</li>`).join("")}</ul>` : "";
      return `<li><span class="entry-name">${escapeHtml(npc.name)}</span>${npc.secret !== "" ? `<p class="entry-text">${escapeHtml(npc.secret)}</p>` : ""}${facts}</li>`;
    });
    blocks.push(`<h3>${escapeHtml(say("reveal.npc_secrets"))}</h3><ul class="entries">${entries.join("")}</ul>`);
  }
  vaults.push(vault(say("reveal.secrets"), reveal.lore.length + reveal.npcs.length, blocks.join("") || nothing));

  const tables: string[] = [];
  const table = (heading: string, pairs: readonly (readonly [string, unknown])[]): string =>
    `<h3>${escapeHtml(say(heading))}</h3><table class="vars"><tbody>${pairs.map(([name, value]) => `<tr><th>${escapeHtml(name)}</th><td>${escapeHtml(shown(value, say))}</td></tr>`).join("")}</tbody></table>`;
  if (reveal.keeperVars.length > 0) tables.push(table("reveal.keeper_vars", reveal.keeperVars.map((item) => [item.label, item.value] as const)));
  if (reveal.hiddenLeaves.length > 0) tables.push(table("reveal.hidden_leaves", reveal.hiddenLeaves.map((item) => [item.path, item.value] as const)));
  vaults.push(vault(say("reveal.variables"), reveal.keeperVars.length + reveal.hiddenLeaves.length, tables.join("") || nothing));

  return (
    '<section class="behind"><div class="banner">' +
    `<span class="spoiler">${escapeHtml(say("reveal.spoiler"))}</span><h2>${escapeHtml(say("reveal.title"))}</h2><p>${escapeHtml(say("reveal.banner"))}</p></div>` +
    vaults.join("") +
    "</section>"
  );
}

/**
 * The whole page in `locale`. `reveal` null is the player edition: it is built from the
 * model alone and so from the event log alone.
 */
export function renderReportHtml(model: ReportModel, locale: string, reveal: RevealModel | null = null): ReportPage {
  const say: Say = (key, params) => translate(REPORT_CATALOG, locale, key, params);
  const edition = reveal === null ? "player" : "reveal";
  const title = model.room;
  const lang = locale.toLowerCase().startsWith("zh") ? "zh-Hans" : "en";
  const parts = [
    "<!DOCTYPE html>",
    `<html lang="${lang}">`,
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="light dark">',
    '<meta name="referrer" content="no-referrer">',
    `<title>${escapeHtml(`${title} · ${say(`edition.${edition}`)}`)}</title>`,
    `<style>${REPORT_STYLESHEET}</style>`,
    "</head>",
    "<body>",
    '<div class="page">',
    masthead(model, title, edition, say),
    tally(model, say),
    diceLog(model, say),
    transcript(model, say),
  ];
  if (reveal !== null) parts.push(behind(reveal, say));
  parts.push(`<footer class="colophon"><p class="thanks">${escapeHtml(say("footer"))}</p><p>${escapeHtml(say("colophon", { time: stamp(model.generatedAt) }))}</p></footer>`);
  parts.push("</div>", "</body>", "</html>", "");
  return { html: parts.join("\n"), edition };
}

/** The compact scoreboard for a chat line: never the transcript. */
export function renderReportText(model: ReportModel, locale: string): string {
  const say: Say = (key, params) => translate(REPORT_CATALOG, locale, key, params);
  const lines = [say("text.title")];
  const range = playedRange(model);
  if (range !== "") lines.push(say("text.played", { range }));
  if (model.players.length > 0) lines.push(say("text.players", { players: model.players.join(say("list_sep")) }));
  lines.push(say("text.lines", { lines: model.lines.length + model.omitted, turns: model.turns }));
  for (const player of model.tally) {
    if (player.rolls + player.checks === 0) continue;
    lines.push(say("text.player", { name: player.name, score: player.score, rating: say(`rating.${player.rating}`) }));
    lines.push(say("text.counts", { rolls: player.rolls, checks: player.checks, passed: player.passed, criticals: player.criticals, fumbles: player.fumbles }));
  }
  if (lines.length <= 3 && model.dice.length === 0) lines.push(say("stats.empty"));
  lines.push(say("text.html_hint"));
  return lines.join("\n");
}
