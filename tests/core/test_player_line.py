"""`core.player_line` — the speaker tag on the Keeper's player line and its inverse."""

from __future__ import annotations

import agent.player_line as agent_player_line
import core.player_line as core_player_line
from core.player_line import attributed_player_line, player_line_body, split_player_line
from infra.i18n import I18n


def test_split_is_the_full_inverse_of_attribution():
    tagged = attributed_player_line(I18n("en"), "平知章 (Dirac)", "who am I?\nsecond line")
    assert split_player_line(tagged) == ("平知章 (Dirac)", "who am I?\nsecond line")
    assert player_line_body(tagged) == "who am I?\nsecond line"


def test_an_untagged_line_has_no_speaker():
    assert split_player_line("bare") == ("", "bare")
    assert split_player_line("[a]b") == ("", "[a]b")  # no newline after the bracket: not a tag
    assert split_player_line("[]\nx") == ("", "[]\nx")  # an empty name is not a tag
    assert player_line_body("bare") == "bare"


def test_the_keeper_side_import_path_is_the_same_functions():
    assert agent_player_line.attributed_player_line is core_player_line.attributed_player_line
    assert agent_player_line.player_line_body is core_player_line.player_line_body
    assert agent_player_line.split_player_line is core_player_line.split_player_line
