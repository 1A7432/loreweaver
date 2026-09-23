"""One event, one wire id — whoever receives it.

`Member.deliver` renders each event once per recipient. A line that minted its id at
render time reached two links of the SAME client (the QQ bridge's observer and a member
seat) as two different lines, so the client's id-based dedupe never matched and the
member seat re-sent every system reply and NPC line in private (found live, 2026-09-23).
"""

from __future__ import annotations

from gateway.hub import Event
from net.session import render_frame


def test_a_one_shot_narrative_renders_the_same_id_for_every_recipient() -> None:
    event = Event.narrative(speaker="system", text="installed", fmt="plain")
    first, second = render_frame(event), render_frame(event)
    assert first is not None and second is not None
    assert first["id"] and first["id"] == second["id"]


def test_a_player_echo_renders_the_same_id_for_every_recipient() -> None:
    event = Event.player_action(name="Ada", text="I open the door.")
    first, second = render_frame(event), render_frame(event)
    assert first is not None and second is not None
    assert first["id"] and first["id"] == second["id"]


def test_distinct_events_get_distinct_ids_and_a_stream_id_is_kept() -> None:
    a = render_frame(Event.narrative(speaker="npc", name="Nora", text="Stay back."))
    b = render_frame(Event.narrative(speaker="npc", name="Nora", text="Stay back."))
    assert a is not None and b is not None and a["id"] != b["id"]
    streamed = render_frame(Event.narrative(speaker="kp", text="done", frame_id="draft-1"))
    assert streamed is not None and streamed["id"] == "draft-1"
