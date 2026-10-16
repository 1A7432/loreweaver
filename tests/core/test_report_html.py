"""`core.report_html` — the self-contained HTML session report renderer.

Pure rendering: escaping of untrusted text, the safe Markdown subset, the player /
reveal split over the session ledger, self-containment, and rule-agnostic dice tones.
"""

from __future__ import annotations

import html
import re

import pytest

import core.battle_report as battle_report
from core.battle_report import BattleReportGenerator, SessionRecord
from core.report_html import ReportHeader, RevealSections, render_markdown, render_plain, render_report_html
from infra.i18n import I18n
from infra.store import Store

INJECTION = '<script>alert("x")</script><img src=x onerror=alert(1)><svg onload=alert(2)>'


def _header(**overrides) -> ReportHeader:
    fields = dict(
        session_name="The Lamplighter's Debt",
        room="lamp-room",
        system="call of cthulhu",
        start_time=1_760_000_000.0,
        end_time=1_760_007_200.0,
        generated_at=1_760_008_000.0,
    )
    fields.update(overrides)
    return ReportHeader(**fields)


def _record() -> SessionRecord:
    record = SessionRecord("s1")
    record.add_dice_roll("u1", "Nora", "1d20", 15)
    record.add_dice_roll("u1", "Nora", "1d100", 2, is_critical=True, critical_type="success")
    record.add_dice_roll("kp", "Keeper", "1d100+SECRETEXPR", 9, hidden=True)
    record.add_skill_check("u1", "Nora", "Listen", 50, 20, success=True, tier=2, label="Hard")
    record.add_skill_check("u1", "Nora", "Listen", 50, 45, success=True, tier=1, label="Regular")
    record.add_skill_check("u2", "Ash", "Climb", 30, 99, success=False, fumble=True, tier=-1, label="Fumble")
    return record


TRANSCRIPT = [
    {"role": "user", "content": "Nora: I listen at the door.", "_lw_turn": 1},
    {"role": "assistant", "content": "Footsteps. **Two** of them.\n\n- one heavy\n- one light", "_lw_turn": 1},
]


def _render(record=None, transcript=TRANSCRIPT, reveal=None, locale="en", header=None) -> str:
    return render_report_html(
        record or _record(),
        BattleReportGenerator(Store()),
        header=header or _header(),
        transcript=transcript,
        i18n=I18n(locale=locale),
        reveal=reveal,
    )


def _tags(page: str) -> list[str]:
    return re.findall(r"<[^>]+>", page)


def test_player_edition_never_shows_or_counts_a_hidden_roll():
    page = _render()
    assert "SECRETEXPR" not in page
    assert "1d20" in page and "Nora" in page
    # The reveal edition prints it behind the screen.
    revealed = _render(reveal=RevealSections(hidden_rolls=[r for r in _record().dice_rolls if r.get("hidden")]))
    assert "SECRETEXPR" in revealed
    assert 'class="behind"' in revealed and 'class="behind"' not in page


def test_page_is_self_contained_and_scriptless():
    page = _render(reveal=RevealSections())
    assert page.startswith("<!DOCTYPE html>")
    assert "<script" not in page.lower()
    assert "<link" not in page.lower()
    assert "@import" not in page
    assert not re.search(r"(?:src|href)\s*=", page, re.IGNORECASE)
    assert not re.search(r"url\(\s*['\"]?(?:https?:|//|data:)", page, re.IGNORECASE)
    assert "prefers-color-scheme: dark" in page and "@media print" in page


@pytest.mark.parametrize("locale", ["en", "zh"])
def test_injection_payload_is_escaped_everywhere(locale):
    record = SessionRecord("s1")
    record.add_dice_roll("u1", INJECTION, INJECTION, 3)
    transcript = [
        {"role": "user", "content": INJECTION, "_lw_turn": 1},
        {
            "role": "assistant",
            "content": f"[click](javascript:alert(1)) **{INJECTION}** <b onclick=x>bold</b>\n- {INJECTION}",
            "_lw_turn": 1,
        },
    ]
    reveal = RevealSections(
        npc_secrets=[{"name": INJECTION, "secret": INJECTION, "knowledge": [INJECTION]}],
        keeper_vars=[{"label": INJECTION, "value": INJECTION}],
        hidden_leaves=[{"path": INJECTION, "value": INJECTION}],
        chronicle_margins=[{"turn": 1, "text": INJECTION, "keeper": INJECTION}],
        module={"truths": [{"name": INJECTION, "description": INJECTION}], "threats": [], "clues": [], "npcs": []},
    )
    page = _render(record=record, transcript=transcript, reveal=reveal, header=_header(session_name=INJECTION, room=INJECTION), locale=locale)
    lowered = page.lower()
    assert "<script" not in lowered and "<img" not in lowered and "<svg" not in lowered
    assert "javascript:" not in lowered
    assert "<b onclick" not in lowered
    # No tag anywhere carries an event-handler attribute or a link.
    for tag in _tags(page):
        assert not re.search(r"\son\w+\s*=", tag, re.IGNORECASE), tag
        assert "href" not in tag.lower(), tag
    assert "&lt;script&gt;" in page


def test_markdown_subset_renders_only_safe_structure():
    rendered = render_markdown("# Title\nThe **ink** is *wet*.\nNext line\n\n- a\n- b\n\n1. one\n2. two\n\n[text](https://x.test)")
    assert '<p class="lead">Title</p>' in rendered
    assert "<strong>ink</strong>" in rendered and "<em>wet</em>" in rendered
    assert "<br>Next line" in rendered
    assert "<ul><li>a</li><li>b</li></ul>" in rendered
    assert "<ol><li>one</li><li>two</li></ol>" in rendered
    assert "text" in rendered and "https://x.test" not in rendered
    # A link target carrying parentheses is dropped whole, not left half-parsed.
    assert render_markdown("[go](javascript:alert(1))") == "<p>go</p>"
    assert render_markdown("<b>x</b>") == "<p>&lt;b&gt;x&lt;/b&gt;</p>"


def test_plain_text_keeps_line_breaks_and_escapes():
    assert render_plain("a\nb\n\n<c>") == "<p>a<br>b</p><p>&lt;c&gt;</p>"


def test_dice_tones_come_from_semantic_flags_and_tier():
    page = _render()
    assert 'class="chip t-crit"' in page  # the critical raw roll
    assert 'class="chip t-fumble"' in page  # the fumbled check
    assert 'class="chip t-success t-strong"' in page  # tier 2 over the tier-1 floor
    assert 'class="chip t-success"' in page  # tier 1 itself
    assert 'class="chip t-plain"' in page  # an ordinary raw roll


def test_transcript_uses_the_markdown_reports_cut(monkeypatch):
    monkeypatch.setattr(battle_report, "TRANSCRIPT_MAX_CHARS", 120)
    transcript = [
        {"role": "user" if index % 2 == 0 else "assistant", "content": f"message-{index} " + "x" * 40, "_lw_turn": index // 2}
        for index in range(10)
    ]
    page = _render(transcript=transcript)
    i18n = I18n(locale="en")
    kept, omitted = battle_report.transcript_window(transcript, i18n)
    assert omitted > 0 and kept
    assert "message-9 " in page and "message-0 " not in page
    assert i18n.t("battle.report.html.transcript.truncated", omitted=omitted, kept=len(kept)) in page


def test_world_card_reveal_without_a_pool_omits_only_that_part():
    page = _render(reveal=RevealSections(module=None, npc_secrets=[]))
    i18n = I18n(locale="en")
    module_heading = html.escape(i18n.t("battle.report.html.reveal.module"))
    assert module_heading not in page
    assert i18n.t("battle.report.html.reveal.hidden_rolls") in page
    assert i18n.t("battle.report.html.reveal.variables") in page
    with_npc = _render(reveal=RevealSections(module=None, npc_secrets=[{"name": "Wick", "secret": "owes", "knowledge": []}]))
    assert module_heading in with_npc
    assert i18n.t("battle.report.html.reveal.truths") not in with_npc


def test_ui_strings_follow_the_issuers_locale():
    zh = _render(locale="zh", reveal=RevealSections())
    assert '<html lang="zh-Hans">' in zh
    assert I18n(locale="zh").t("battle.report.html.reveal.title") in zh
    assert '<html lang="en">' in _render()
