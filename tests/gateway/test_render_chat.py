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
    message = render_chat_event(event, _i18n())
    assert message is not None and message.text == "The hall is dark and cold."
    assert message.markdown


def test_npc_narrative_renders_localized_bold_name_line() -> None:
    event = Event.narrative(speaker="npc", name="Martha", text="Keep your voice down.")
    message = render_chat_event(event, _i18n())
    assert message is not None and message.text == "**Martha:** Keep your voice down."


def test_system_narrative_renders_its_text() -> None:
    event = Event.narrative(speaker="system", text="Roll: [15] = 15")
    message = render_chat_event(event, _i18n())
    assert message is not None and message.text == "Roll: [15] = 15"


def test_player_action_renders_for_other_channels() -> None:
    assert render_chat_event(Event.narrative(speaker="player", text="I look around"), _i18n()) is None
    message = render_chat_event(Event.player_action(name="Nora", text="I look around"), _i18n())
    assert message is not None and message.text == "**Nora:** I look around"


def test_dice_renders_public_one_liner_with_level_and_no_keeper_data() -> None:
    event = Event.dice("Nora", "check", expr="Spot Hidden", rolls=[15], total=15, rank=2, success=True)
    message = render_chat_event(event, _i18n())
    assert message is not None
    assert "🎲" in message.text
    assert "Nora" in message.text and "Spot Hidden" in message.text and "15" in message.text
    assert message.embeds
    # the level is the localized COC rank label (rank 2 == a hard success)
    assert coc_rank_label(2, _i18n()) in message.text


def test_dice_without_rank_falls_back_to_plain_one_liner() -> None:
    event = Event.dice("Nora", "roll", expr="1d20", rolls=[12], total=12)
    message = render_chat_event(event, _i18n())
    assert message is not None
    assert "🎲" in message.text and "1d20" in message.text and "12" in message.text


def _dice_fields(event: Event, locale: str = "en") -> dict[str, str]:
    message = render_chat_event(event, _i18n(locale))
    assert message is not None and message.embeds
    return {field.name: field.value for field in message.embeds[0].fields}


def test_dice_card_renders_existing_critical_flags_only_when_true() -> None:
    success = _dice_fields(
        Event.dice(
            "Nora",
            "roll",
            expr="1d20",
            rolls=[20],
            total=20,
            critical_success=True,
            critical_failure=False,
        )
    )
    failure = _dice_fields(
        Event.dice(
            "Nora",
            "roll",
            expr="1d20",
            rolls=[1],
            total=1,
            critical_success=False,
            critical_failure=True,
        )
    )
    ordinary = _dice_fields(
        Event.dice(
            "Nora",
            "roll",
            expr="1d20",
            rolls=[10],
            total=10,
            critical_success=False,
            critical_failure=False,
        )
    )

    assert success["Critical"] == "Critical success"
    assert failure["Critical"] == "Critical failure"
    assert "Critical" not in ordinary


def test_dice_card_renders_opposed_right_side_and_winner() -> None:
    fields = _dice_fields(
        Event.dice(
            "Nora",
            "opposed",
            expr="Spot Hidden vs Listen",
            total=35,
            rank=2,
            right={"name": "Listen", "total": 61, "target": 50, "rank": 0},
            winner="left",
        )
    )

    assert fields["Right side"] == "Listen · 61/50 · Failure"
    assert fields["Winner"] == "Left side"


def test_dice_card_renders_san_loss_and_remaining() -> None:
    fields = _dice_fields(
        Event.dice(
            "Nora",
            "sanity",
            expr="SAN",
            total=72,
            rank=0,
            loss=4,
            remaining=36,
        )
    )

    assert fields["SAN loss"] == "4"
    assert fields["SAN remaining"] == "36"


def test_state_and_presence_render_none() -> None:
    assert render_chat_event(Event.state({"type": "state", "online": 1}), _i18n()) is None
    assert render_chat_event(Event.presence([{"id": "a"}], 1), _i18n()) is None


def test_panel_renders_structured_card() -> None:
    message = render_chat_event(
        Event.panel(
            {
                "type": "state",
                "online": 2,
                "character": {"name": "Nora"},
                "party": [{"name": "Nora"}, {"name": "Sam"}],
            },
            private=True,
        ),
        _i18n(),
    )

    assert message is not None
    assert message.private and message.coalesce_key == "panel"
    assert message.embeds and "Nora" in str(message.embeds[0].fields)
