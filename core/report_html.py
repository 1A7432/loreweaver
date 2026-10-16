"""The session report ("团报") as ONE self-contained HTML page — the printed keepsake.

Deterministic like the rest of `core/`: the page is a pure function of engine records
(the dice ledgers in `core.battle_report.SessionRecord`), the room's conversation (the
`agent.history.load_chain` wire shape, cut by the SAME `transcript_window` the Markdown
report uses) and — for the reveal edition only — keeper-grade views that the CALLER
obtained through `core.documents.project`. Nothing here reads a store, a document or a
model; nothing here knows a rule system either: dice are coloured from the semantic
outcome flags and the ladder `tier`, never from any system's rank vocabulary.

Two editions, one renderer:

- **player** (`reveal=None`): the scoreboard over VISIBLE rolls (`_visible_rolls`, so a
  hidden `.rh` roll is neither shown nor counted), the dice log, and the transcript.
- **reveal** (`reveal=RevealSections`): the player edition plus a visibly separate
  "behind the screen" part — hidden rolls, the Keeper's chronicle margins, the module's
  secrets, and the keeper-only variables. Whoever builds a `RevealSections` is handing a
  keeper-grade view to a keeper; this module only lays it out.

Security: every string that reaches the page is untrusted — player text, Keeper prose,
imported card text, NPC names, variable paths. Everything is HTML-escaped FIRST; Keeper
narration (Markdown) is then rendered through a small fixed subset — paragraphs, line
breaks, emphasis, lists — whose substitutions only ever insert this module's own tags.
No raw HTML passes through, no link is ever emitted (a Markdown link keeps its text and
loses its target), and no attribute value is taken from content. The page carries no
script and fetches nothing: the stylesheet (`assets/session_report.css`) is inlined.
"""

from __future__ import annotations

import html
import json
import re
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import datetime
from functools import lru_cache
from pathlib import Path
from typing import Any

from core.battle_report import (
    NPC_USER_ID,
    BattleReportGenerator,
    SessionRecord,
    _visible_rolls,
    transcript_window,
)
from infra.i18n import I18n
from infra.llm import HISTORY_TURN_KEY

_STYLESHEET = Path(__file__).resolve().parent.parent / "assets" / "session_report.css"

EDITION_PLAYER = "player"
EDITION_REVEAL = "reveal"


@lru_cache(maxsize=1)
def _stylesheet() -> str:
    return _STYLESHEET.read_text(encoding="utf-8")


@dataclass(frozen=True)
class ReportHeader:
    """The title block's facts — all plain values, all escaped on the way out."""

    session_name: str
    room: str
    system: str
    start_time: float
    end_time: float | None
    generated_at: float


@dataclass(frozen=True)
class RevealSections:
    """The reveal edition's keeper-grade material, ALREADY projected for a keeper.

    ``module`` is ``None`` for a room with no module pool (a world-card room): that part
    of the module section is omitted, never an error. Every list holds plain dicts:

    - ``hidden_rolls``: the session's hidden (`.rh`) raw-roll ledger entries;
    - ``chronicle_margins``: ``{"turn", "text", "keeper"}`` — the public record line and
      the keeper margin written beside it; ``summary_margin`` is the rolling summary's;
    - ``module``: ``{"truths", "threats", "clues", "npcs"}`` from the knowledge pool's
      keeper half (``clues`` = the ones never unlocked, ``npcs`` = ``{"name","secret"}``);
    - ``npc_secrets``: ``{"name", "secret", "knowledge"}`` from NPC documents;
    - ``keeper_vars``: ``{"label", "value"}``; ``hidden_leaves``: ``{"path", "value"}``.
    """

    hidden_rolls: list[dict[str, Any]] = field(default_factory=list)
    chronicle_margins: list[dict[str, Any]] = field(default_factory=list)
    summary_margin: str = ""
    module: dict[str, list[dict[str, Any]]] | None = None
    npc_secrets: list[dict[str, Any]] = field(default_factory=list)
    keeper_vars: list[dict[str, Any]] = field(default_factory=list)
    hidden_leaves: list[dict[str, Any]] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Escaping and the safe Markdown subset
# ---------------------------------------------------------------------------


def _esc(value: Any) -> str:
    return html.escape(str(value if value is not None else ""), quote=True)


_LIST_ITEM_RE = re.compile(r"^\s*(?:([-*+])|(\d{1,3})[.)])\s+(.*)$")
_HEADING_RE = re.compile(r"^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$")
_RULE_RE = re.compile(r"^\s{0,3}(?:[-*_]\s*){3,}$")
_QUOTE_RE = re.compile(r"^\s{0,3}&gt;\s?(.*)$")
# Applied to ALREADY-ESCAPED text, so no group can contain `<`, `>` or `"`: every
# substitution below inserts only this module's own fixed tags around escaped content.
_LINK_RE = re.compile(r"!?\[([^\]\n]*)\]\((?:[^()\n]|\([^()\n]*\))*\)")
_CODE_RE = re.compile(r"`([^`\n]+)`")
_STRONG_RE = re.compile(r"\*\*(?=\S)(.+?)(?<=\S)\*\*|__(?=\S)(.+?)(?<=\S)__")
_EM_RE = re.compile(r"(?<![\w*])\*(?=\S)(.+?)(?<=\S)\*(?![\w*])|(?<![\w_])_(?=\S)(.+?)(?<=\S)_(?![\w_])")


def _inline(escaped: str) -> str:
    """Emphasis over one ALREADY-ESCAPED line. Links keep their text, never a target."""
    text = _LINK_RE.sub(lambda m: m.group(1), escaped)
    text = _CODE_RE.sub(lambda m: m.group(1), text)
    text = _STRONG_RE.sub(lambda m: f"<strong>{m.group(1) or m.group(2)}</strong>", text)
    text = _EM_RE.sub(lambda m: f"<em>{m.group(1) or m.group(2)}</em>", text)
    return text


def render_markdown(text: str) -> str:
    """Keeper narration → HTML through the safe subset (module docstring).

    Escape first, then structure: blank lines split paragraphs, single newlines become
    ``<br>``, runs of ``-``/``*``/``1.`` lines become lists, a ``#`` heading line becomes a
    bold lead paragraph, a ``>`` quote keeps its words, a horizontal rule is dropped."""
    escaped = _esc(str(text or "").replace("\r\n", "\n").replace("\r", "\n").strip())
    if not escaped:
        return ""
    out: list[str] = []
    for block in re.split(r"\n[ \t]*\n+", escaped):
        lines = [line for line in block.split("\n") if not _RULE_RE.match(line)]
        run: list[str] = []
        run_kind = ""

        def flush() -> None:
            nonlocal run, run_kind
            if not run:
                return
            if run_kind in ("ul", "ol"):
                items = "".join(f"<li>{_inline(item)}</li>" for item in run)
                out.append(f"<{run_kind}>{items}</{run_kind}>")
            else:
                out.append("<p>" + "<br>".join(_inline(line) for line in run) + "</p>")
            run, run_kind = [], ""

        for line in lines:
            heading = _HEADING_RE.match(line)
            if heading:
                flush()
                out.append(f'<p class="lead">{_inline(heading.group(1))}</p>')
                continue
            item = _LIST_ITEM_RE.match(line)
            quote = _QUOTE_RE.match(line)
            if item:
                kind = "ol" if item.group(2) else "ul"
                content = item.group(3)
            else:
                kind = "p"
                content = quote.group(1) if quote else line
            if kind != run_kind:
                flush()
                run_kind = kind
            run.append(content.strip())
        flush()
    return "".join(out)


def render_plain(text: str) -> str:
    """Player text: escaped, paragraphs on blank lines, ``<br>`` on single newlines."""
    escaped = _esc(str(text or "").replace("\r\n", "\n").replace("\r", "\n").strip())
    if not escaped:
        return ""
    return "".join(
        "<p>" + "<br>".join(block.split("\n")) + "</p>" for block in re.split(r"\n[ \t]*\n+", escaped)
    )


# ---------------------------------------------------------------------------
# Small formatting helpers
# ---------------------------------------------------------------------------


def _stamp(timestamp: float | None, fmt: str = "%Y-%m-%d %H:%M") -> str:
    if not timestamp:
        return ""
    return datetime.fromtimestamp(float(timestamp)).strftime(fmt)


def _date_range(header: ReportHeader, i18n: I18n) -> str:
    start = _stamp(header.start_time)
    if not header.end_time:
        return i18n.t("battle.report.html.meta.since", start=start)
    if _stamp(header.start_time, "%Y-%m-%d") == _stamp(header.end_time, "%Y-%m-%d"):
        return f"{start} – {_stamp(header.end_time, '%H:%M')}"
    return f"{start} – {_stamp(header.end_time)}"


def _value(value: Any, i18n: I18n) -> str:
    if isinstance(value, bool):
        return i18n.t("battle.report.html.value.true" if value else "battle.report.html.value.false")
    if isinstance(value, list):
        return ", ".join(_value(item, i18n) for item in value)
    if isinstance(value, dict):
        return json.dumps(value, ensure_ascii=False, sort_keys=True)
    if value is None:
        return ""
    return str(value)


def _check_tone(check: dict[str, Any]) -> str:
    """The chip tone of a graded check, from the semantic flags only."""
    if check.get("critical"):
        return "crit"
    if check.get("fumble"):
        return "fumble"
    return "success" if check.get("success") else "fail"


def _roll_tone(roll: dict[str, Any]) -> str:
    """A raw roll has no success notion: only its critical flag colours it."""
    if roll.get("is_critical"):
        return "fumble" if roll.get("critical_type") == "failure" else "crit"
    return "plain"


def _tier(check: dict[str, Any]) -> int | None:
    tier = check.get("tier")
    if isinstance(tier, bool) or not isinstance(tier, int):
        return None
    return tier


def _section_title(text: str, ornament: str = "❦") -> str:
    return f'<h2 class="section-title"><span class="ornament" aria-hidden="true">{ornament}</span>{_esc(text)}</h2>'  # i18n-exempt: HTML markup


# ---------------------------------------------------------------------------
# The page
# ---------------------------------------------------------------------------


def render_report_html(
    record: SessionRecord,
    generator: BattleReportGenerator,
    *,
    header: ReportHeader,
    transcript: list[dict[str, Any]],
    i18n: I18n,
    reveal: RevealSections | None = None,
) -> str:
    """The whole page. ``reveal=None`` is the player edition (module docstring)."""
    edition = EDITION_REVEAL if reveal is not None else EDITION_PLAYER
    edition_label = i18n.t(f"battle.report.html.edition.{edition}")
    lang = "zh-Hans" if str(i18n.locale).casefold().startswith("zh") else "en"
    title = f"{header.session_name} · {edition_label}"
    parts = [
        "<!DOCTYPE html>",
        f'<html lang="{lang}">',
        "<head>",
        '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',  # i18n-exempt: HTML markup
        '<meta name="color-scheme" content="light dark">',  # i18n-exempt: HTML markup
        '<meta name="referrer" content="no-referrer">',
        f"<title>{_esc(title)}</title>",
        f"<style>{_stylesheet()}</style>",
        "</head>",
        "<body>",
        '<div class="page">',
        _masthead(record, header, i18n, edition, edition_label),
        _tally(record, generator, i18n),
        _dice_log(record, i18n),
        _transcript(transcript, i18n),
    ]
    if reveal is not None:
        parts.append(_behind(reveal, i18n))
    parts.append(_colophon(header, i18n))
    parts.extend(["</div>", "</body>", "</html>", ""])
    return "\n".join(parts)


def _player_names(record: SessionRecord, i18n: I18n) -> list[str]:
    unknown = i18n.t("battle.player.unknown_character")
    names: list[str] = []
    for user_id, stats in record.player_stats.items():
        if user_id == NPC_USER_ID:
            continue
        name = str(stats.get("char_name") or unknown)
        if name not in names:
            names.append(name)
    return names


def _masthead(record: SessionRecord, header: ReportHeader, i18n: I18n, edition: str, edition_label: str) -> str:
    meta = [
        (i18n.t("battle.report.html.meta.played"), _esc(_date_range(header, i18n))),
        (i18n.t("battle.report.html.meta.room"), _esc(header.room)),
    ]
    if header.system:
        meta.append((i18n.t("battle.report.html.meta.system"), f'<span class="system-name">{_esc(header.system)}</span>'))
    players = _player_names(record, i18n)
    if players:
        meta.append((i18n.t("battle.report.html.meta.players"), _esc(i18n.t("battle.report.html.list_sep").join(players))))
    rows = "".join(f"<div><dt>{_esc(label)}</dt><dd>{value}</dd></div>" for label, value in meta)
    edition_class = "edition edition--reveal" if edition == EDITION_REVEAL else "edition"
    return (
        '<header class="masthead">'
        f'<p class="kicker"><span>{_esc(i18n.t("battle.report.html.kicker"))}</span>'
        f'<span class="{edition_class}">{_esc(edition_label)}</span></p>'
        f"<h1>{_esc(header.session_name)}</h1>"
        f'<dl class="meta">{rows}</dl>'
        "</header>"
    )


def _tally(record: SessionRecord, generator: BattleReportGenerator, i18n: I18n) -> str:
    visible_rolls = _visible_rolls(record.dice_rolls)
    cards: list[str] = []
    for user_id, stats in record.player_stats.items():
        if user_id == NPC_USER_ID:
            continue
        tones = {"crit": 0, "success": 0, "fail": 0, "fumble": 0, "plain": 0}
        for check in record.skill_checks:
            if str(check.get("user_id", "")) == user_id:
                tones[_check_tone(check)] += 1
        for roll in visible_rolls:
            if str(roll.get("user_id", "")) == user_id:
                tones[_roll_tone(roll)] += 1
        bar = "".join(
            f'<span class="t-{tone}" style="flex-grow:{count}"></span>' for tone, count in tones.items() if count
        )
        score, rating = generator.calculate_player_score(user_id, record, i18n=i18n)
        counts = [
            ("", "battle.report.html.stats.rolls", int(stats.get("total_rolls", 0) or 0)),
            ("", "battle.report.html.stats.checks", int(stats.get("total_checks", 0) or 0)),
            ("", "battle.report.html.stats.successes", int(stats.get("successful_checks", 0) or 0)),
            ("is-crit", "battle.report.html.stats.criticals", int(stats.get("critical_success", 0) or 0)),
            ("is-fumble", "battle.report.html.stats.fumbles", int(stats.get("critical_failure", 0) or 0)),
        ]
        cells = "".join(
            f'<div class="{css}"><dt>{_esc(i18n.t(key))}</dt><dd>{value}</dd></div>' for css, key, value in counts
        )
        name = stats.get("char_name") or i18n.t("battle.player.unknown_character")
        cards.append(
            '<article class="card">'  # i18n-exempt: HTML markup
            '<div class="card-head">'
            f'<span class="card-name">{_esc(name)}</span>'
            f'<span class="score">{int(score)}</span>'
            "</div>"
            f'<p class="rating">{_esc(rating)}</p>'
            f'<div class="bar" aria-hidden="true">{bar}</div>'
            f'<dl class="counts">{cells}</dl>'
            "</article>"
        )
    body = (
        f'<div class="tally">{"".join(cards)}</div>'
        if cards
        else f'<p class="quiet">{_esc(i18n.t("battle.report.html.stats.empty"))}</p>'
    )
    return "<section>" + _section_title(i18n.t("battle.report.html.stats.heading")) + body + "</section>"


def _roll_chip(roll: dict[str, Any], i18n: I18n, *, with_time: bool = True) -> str:
    tone = _roll_tone(roll)
    name = roll.get("char_name") or i18n.t("battle.player.unknown_character")
    when = f'<span class="when">{_esc(_stamp(roll.get("timestamp"), "%H:%M"))}</span>' if with_time else ""
    marker = ""
    if tone == "crit":
        marker = f'<span class="label">{_esc(i18n.t("battle.report.html.dice.critical"))}</span>'
    elif tone == "fumble":
        marker = f'<span class="label">{_esc(i18n.t("battle.report.html.dice.fumble"))}</span>'
    return (
        f'<li class="chip t-{tone}">{when}<span class="who">{_esc(name)}</span>'
        f'<span class="num">{_esc(roll.get("expression", ""))} = {_esc(roll.get("result", ""))}</span>{marker}</li>'
    )


def _check_chip(check: dict[str, Any], i18n: I18n, strong_floor: int | None) -> str:
    tone = _check_tone(check)
    classes = f"chip t-{tone}"
    tier = _tier(check)
    if tone == "success" and tier is not None and strong_floor is not None and tier > strong_floor:
        classes += " t-strong"
    name = check.get("char_name") or i18n.t("battle.player.unknown_character")
    label = check.get("label") or check.get("rank_id") or ""
    target = check.get("target")
    numbers = f"{_esc(check.get('roll', ''))}/{_esc(target)}" if target not in (None, "", 0) else _esc(check.get("roll", ""))
    return (
        f'<li class="{classes}"><span class="when">{_esc(_stamp(check.get("timestamp"), "%H:%M"))}</span>'
        f'<span class="who">{_esc(name)}</span><span class="what">{_esc(check.get("skill", ""))}</span>'
        f'<span class="num">{numbers}</span><span class="label">{_esc(label)}</span></li>'
    )


def _dice_log(record: SessionRecord, i18n: I18n) -> str:
    """Every visible roll and graded check, chronologically — the values prose cannot carry.

    A separate section, not interleaved into the conversation, for the reason the Markdown
    report gives: a history record carries a turn index but no timestamp, so there is no
    honest way to order a roll against a message."""
    successes = [_tier(check) for check in record.skill_checks if check.get("success") and not check.get("critical")]
    tiers = [tier for tier in successes if tier is not None]
    strong_floor = min(tiers) if tiers else None
    entries: list[tuple[float, str]] = []
    for roll in _visible_rolls(record.dice_rolls):
        entries.append((float(roll.get("timestamp", 0) or 0), _roll_chip(roll, i18n)))
    for check in record.skill_checks:
        entries.append((float(check.get("timestamp", 0) or 0), _check_chip(check, i18n, strong_floor)))
    entries.sort(key=lambda item: item[0])
    if not entries:
        return ""
    chips = "".join(chip for _ts, chip in entries)
    return (
        "<section>"
        + _section_title(i18n.t("battle.report.html.dice.heading"), "⚄")
        + f'<ul class="chips">{chips}</ul></section>'
    )


def _transcript(transcript: list[dict[str, Any]], i18n: I18n) -> str:
    kept, omitted = transcript_window(transcript, i18n)
    heading = _section_title(i18n.t("battle.report.html.transcript.heading"), "§")
    if not kept:
        return f'<section>{heading}<p class="quiet">{_esc(i18n.t("battle.report.html.transcript.empty"))}</p></section>'
    out: list[str] = []
    if omitted:
        out.append(
            '<p class="notice">'
            + _esc(i18n.t("battle.report.html.transcript.truncated", omitted=omitted, kept=len(kept)))
            + "</p>"
        )
    previous_turn: int | None = None
    keeper_label = i18n.t("battle.report.md.transcript.keeper")
    player_label = i18n.t("battle.report.md.transcript.player")
    turn_word = i18n.t("battle.report.html.transcript.turn")
    opened = False
    for message in kept:
        turn = int(message.get(HISTORY_TURN_KEY, 0) or 0)
        keeper = message.get("role") == "assistant"
        marker = ""
        if turn != previous_turn:
            marker = f"{_esc(turn_word)}<b>{turn}</b>"
            previous_turn = turn
        content = str(message.get("content", ""))
        text = render_markdown(content) if keeper else render_plain(content)
        kind = "keeper" if keeper else "player"
        if keeper and not opened:
            kind += " msg--opening"  # the first Keeper line carries the drop cap
            opened = True
        out.append(
            f'<article class="msg msg--{kind}">'
            f'<div class="turn">{marker}</div>'
            f'<div class="body"><span class="speaker">{_esc(keeper_label if keeper else player_label)}</span>'
            f'<div class="text">{text}</div></div>'
            "</article>"
        )
    return f'<section>{heading}<div class="log">{"".join(out)}</div></section>'


# ---------------------------------------------------------------------------
# Behind the screen (reveal edition only)
# ---------------------------------------------------------------------------


def _vault(title: str, count: int, body: str) -> str:
    return (
        '<details class="vault">'
        f'<summary><span>{_esc(title)}</span><span class="count">{count}</span></summary>'
        f'<div class="vault-body">{body}</div>'
        "</details>"
    )


def _nothing(i18n: I18n) -> str:
    return f'<p class="quiet">{_esc(i18n.t("battle.report.html.reveal.nothing"))}</p>'


def _note(label_key: str, value: Any, i18n: I18n) -> str:
    text = _value(value, i18n).strip()
    if not text:
        return ""
    return f'<p class="entry-note"><b>{_esc(i18n.t(label_key))}</b> {_esc(text)}</p>'


def _named_entries(items: Iterable[dict[str, Any]], i18n: I18n, notes: tuple[tuple[str, str], ...] = ()) -> str:
    rows: list[str] = []
    for item in items:
        name = str(item.get("name") or item.get("title") or "").strip()
        description = str(item.get("description") or item.get("secret") or "").strip()
        extra = "".join(_note(label, item.get(field_name), i18n) for field_name, label in notes)
        rows.append(
            "<li>"
            + (f'<span class="entry-name">{_esc(name)}</span>' if name else "")
            + (f'<p class="entry-text">{_esc(description)}</p>' if description else "")
            + extra
            + "</li>"
        )
    return f'<ul class="entries">{"".join(rows)}</ul>'


def _threat_stats(threat: dict[str, Any], i18n: I18n) -> str:
    stats = threat.get("stats")
    parts: list[str] = []
    if isinstance(stats, dict):
        parts.extend(f"{key} {_value(value, i18n)}" for key, value in stats.items())
    attacks = threat.get("attacks")
    if isinstance(attacks, list):
        parts.extend(str(attack) for attack in attacks)
    if not parts:
        return ""
    return f'<p class="entry-note">{_esc(" · ".join(parts))}</p>'


def _behind(reveal: RevealSections, i18n: I18n) -> str:
    vaults: list[str] = []

    # (a) hidden rolls
    hidden = sorted(reveal.hidden_rolls, key=lambda roll: float(roll.get("timestamp", 0) or 0))
    body = f'<ul class="chips">{"".join(_roll_chip(roll, i18n) for roll in hidden)}</ul>' if hidden else _nothing(i18n)
    vaults.append(_vault(i18n.t("battle.report.html.reveal.hidden_rolls"), len(hidden), body))

    # (b) the keeper's chronicle margins
    margins = [entry for entry in reveal.chronicle_margins if str(entry.get("keeper", "")).strip()]
    rows: list[str] = []
    for entry in sorted(margins, key=lambda item: int(item.get("turn", 0) or 0)):
        rows.append(
            "<li>"
            f'<span class="entry-name">{_esc(i18n.t("battle.report.html.reveal.margin_turn", turn=int(entry.get("turn", 0) or 0)))}</span>'
            f'<p class="margin-note">{_esc(str(entry.get("keeper", "")).strip())}</p>'
            + (
                f'<p class="context">{_esc(str(entry.get("text", "")).strip())}</p>'
                if str(entry.get("text", "")).strip()
                else ""
            )
            + "</li>"
        )
    summary_margin = reveal.summary_margin.strip()
    if summary_margin:
        rows.append(
            "<li>"
            f'<span class="entry-name">{_esc(i18n.t("battle.report.html.reveal.summary_margin"))}</span>'
            f'<p class="margin-note">{_esc(summary_margin)}</p>'
            "</li>"
        )
    count = len(margins) + (1 if summary_margin else 0)
    body = f'<ul class="entries">{"".join(rows)}</ul>' if rows else _nothing(i18n)
    vaults.append(_vault(i18n.t("battle.report.html.reveal.margins"), count, body))

    # (c) the module's secrets — the pool part is omitted for a room with no pool
    blocks: list[str] = []
    count = 0
    module = reveal.module
    if module is not None:
        for key, heading, notes in (
            ("truths", "battle.report.html.reveal.truths", (("revealed_by", "battle.report.html.reveal.revealed_by"),)),
            ("threats", "battle.report.html.reveal.threats", (("location", "battle.report.html.reveal.location"),)),
            (
                "clues",
                "battle.report.html.reveal.clues",
                (
                    ("location", "battle.report.html.reveal.location"),
                    ("leads_to", "battle.report.html.reveal.leads_to"),
                ),
            ),
            ("npcs", "battle.report.html.reveal.module_npcs", ()),
        ):
            items = [item for item in module.get(key) or [] if isinstance(item, dict)]
            if not items:
                continue
            count += len(items)
            if key == "threats":
                listing = "".join(
                    "<li>"
                    + f'<span class="entry-name">{_esc(item.get("name", ""))}</span>'
                    + (f'<span class="entry-tag">{_esc(item.get("type", ""))}</span>' if item.get("type") else "")
                    + (f'<p class="entry-text">{_esc(item.get("description", ""))}</p>' if item.get("description") else "")
                    + _threat_stats(item, i18n)
                    + _note("battle.report.html.reveal.abilities", item.get("special_abilities"), i18n)
                    + _note("battle.report.html.reveal.location", item.get("location"), i18n)
                    + "</li>"
                    for item in items
                )
                blocks.append(f"<h3>{_esc(i18n.t(heading))}</h3><ul class=\"entries\">{listing}</ul>")
            else:
                blocks.append(f"<h3>{_esc(i18n.t(heading))}</h3>" + _named_entries(items, i18n, notes))
    npcs = [npc for npc in reveal.npc_secrets if str(npc.get("secret", "")).strip() or npc.get("knowledge")]
    if npcs:
        count += len(npcs)
        rows = []
        for npc in npcs:
            knowledge = [str(fact) for fact in npc.get("knowledge") or [] if str(fact).strip()]
            facts = (
                f'<p class="entry-note"><b>{_esc(i18n.t("battle.report.html.reveal.knows"))}</b></p>'
                + '<ul class="facts">'
                + "".join(f"<li>{_esc(fact)}</li>" for fact in knowledge)
                + "</ul>"
                if knowledge
                else ""
            )
            secret = str(npc.get("secret", "")).strip()
            rows.append(
                "<li>"
                f'<span class="entry-name">{_esc(npc.get("name", ""))}</span>'
                + (f'<p class="entry-text">{_esc(secret)}</p>' if secret else "")
                + facts
                + "</li>"
            )
        blocks.append(
            f"<h3>{_esc(i18n.t('battle.report.html.reveal.npc_secrets'))}</h3>"
            f'<ul class="entries">{"".join(rows)}</ul>'
        )
    if module is not None or npcs:
        vaults.append(_vault(i18n.t("battle.report.html.reveal.module"), count, "".join(blocks) or _nothing(i18n)))

    # (d) keeper-only variables and unexposed card variables, final values
    tables: list[str] = []
    if reveal.keeper_vars:
        rows = [
            f"<tr><th>{_esc(item.get('label', ''))}</th><td>{_esc(_value(item.get('value'), i18n))}</td></tr>"
            for item in reveal.keeper_vars
        ]
        tables.append(
            f"<h3>{_esc(i18n.t('battle.report.html.reveal.keeper_vars'))}</h3>"
            f'<table class="vars"><tbody>{"".join(rows)}</tbody></table>'
        )
    if reveal.hidden_leaves:
        rows = [
            f"<tr><th>{_esc(item.get('path', ''))}</th><td>{_esc(_value(item.get('value'), i18n))}</td></tr>"
            for item in reveal.hidden_leaves
        ]
        tables.append(
            f"<h3>{_esc(i18n.t('battle.report.html.reveal.hidden_leaves'))}</h3>"
            f'<table class="vars"><tbody>{"".join(rows)}</tbody></table>'
        )
    vaults.append(
        _vault(
            i18n.t("battle.report.html.reveal.variables"),
            len(reveal.keeper_vars) + len(reveal.hidden_leaves),
            "".join(tables) or _nothing(i18n),
        )
    )

    return (
        '<section class="behind">'  # i18n-exempt: HTML markup
        '<div class="banner">'
        f'<span class="spoiler">{_esc(i18n.t("battle.report.html.reveal.spoiler"))}</span>'
        f"<h2>{_esc(i18n.t('battle.report.html.reveal.title'))}</h2>"
        f"<p>{_esc(i18n.t('battle.report.html.reveal.banner'))}</p>"
        "</div>"
        + "".join(vaults)
        + "</section>"
    )


def _colophon(header: ReportHeader, i18n: I18n) -> str:
    return (
        '<footer class="colophon">'
        f'<p class="thanks">{_esc(i18n.t("battle.report.footer"))}</p>'
        f"<p>{_esc(i18n.t('battle.report.html.colophon', time=_stamp(header.generated_at)))}</p>"
        "</footer>"
    )
