"""Tests for the chat-transport renderer (M7 §3).

`render_chat_event` is what an `AdapterMember` runs to turn a normalized hub
`Event` into a single chat line (or `None` to send nothing). These pin the
rendering policy: KP/NPC/system/dice surface; player lines, state and presence
do not; and the dice line carries only public roll fields.
"""

from __future__ import annotations

from core.dice_engine import coc_rank_label
from gateway.hub import Event
from gateway.render_chat import render_chat_event
from infra.i18n import get_i18n


def _i18n(locale: str = "en"):
    return get_i18n(locale)


def test_kp_narrative_renders_its_text() -> None:
    event = Event.narrative(speaker="kp", text="The hall is dark and cold.")
    assert render_chat_event(event, _i18n()) == "The hall is dark and cold."


def test_npc_narrative_renders_localized_bold_name_line() -> None:
    event = Event.narrative(speaker="npc", name="Martha", text="Keep your voice down.")
    assert render_chat_event(event, _i18n()) == "**Martha:** Keep your voice down."


def test_system_narrative_renders_its_text() -> None:
    event = Event.narrative(speaker="system", text="Roll: [15] = 15")
    assert render_chat_event(event, _i18n()) == "Roll: [15] = 15"


def test_player_narrative_and_player_action_render_none() -> None:
    # The channel already shows the player's own message; the KP narration
    # carries the story, so player lines never re-surface on chat.
    assert render_chat_event(Event.narrative(speaker="player", text="I look around"), _i18n()) is None
    assert render_chat_event(Event.player_action(name="Nora", text="I look around"), _i18n()) is None


def test_dice_renders_public_one_liner_with_level_and_no_keeper_data() -> None:
    event = Event.dice("Nora", "check", expr="Spot Hidden", rolls=[15], total=15, rank=2, success=True)
    line = render_chat_event(event, _i18n())
    assert line is not None
    assert "🎲" in line
    assert "Nora" in line and "Spot Hidden" in line and "15" in line
    # the level is the localized COC rank label (rank 2 == a hard success)
    assert coc_rank_label(2, _i18n()) in line


def test_dice_without_rank_falls_back_to_plain_one_liner() -> None:
    event = Event.dice("Nora", "roll", expr="1d20", rolls=[12], total=12)
    line = render_chat_event(event, _i18n())
    assert line is not None
    assert "🎲" in line and "1d20" in line and "12" in line


def test_state_and_presence_render_none() -> None:
    assert render_chat_event(Event.state({"type": "state", "online": 1}), _i18n()) is None
    assert render_chat_event(Event.presence([{"id": "a"}], 1), _i18n()) is None
