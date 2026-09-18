"""The card's standing directives (`system_prompt` / `post_history_instructions`) through
the parser, the split and the brief copy — the deterministic half of the world-card
directives fold (docs/notes/implemented/card-directives-fold.md).

RED LINE: the character half of ANY card carries no directive. That half is what a player
may self-import, and a directive is standing Keeper-prompt text.
"""

from __future__ import annotations

import json

from core.card_split import WorldPayloads, detect_world_payloads, split_card
from core.charcard import CharacterCard, parse_card_bytes
from core.module_brief import (
    DIRECTIVE_FIELDS,
    MAX_FIELD_CHARS,
    build_brief,
    directive_bands,
    prepare_directive,
)

HEAD = "You run {{char}} as a slow-burn mystery. {{original}}"
POST = "[Stay terse. {{user}} decides; you narrate. <% setvar('x', 1) %>{{// keep}}]"


def _v2_bytes() -> bytes:
    return json.dumps(
        {
            "spec": "chara_card_v2",
            "spec_version": "2.0",
            "data": {
                "name": "Manor",
                "description": "A manor.",
                "personality": "quiet",
                "system_prompt": HEAD,
                "post_history_instructions": POST,
                "extensions": {"keep": 1},
            },
        }
    ).encode()


def test_parser_reads_both_directive_fields_from_v2_and_v1():
    card = parse_card_bytes(_v2_bytes(), filename="manor.json")
    assert card.system_prompt == HEAD and card.post_history_instructions == POST

    v1 = parse_card_bytes(json.dumps({"name": "Bert", "system_prompt": "be Bert"}).encode(), filename="bert.json")
    assert v1.system_prompt == "be Bert" and v1.post_history_instructions == ""


def test_split_blanks_directives_on_the_character_half_and_counts_them():
    card = parse_card_bytes(_v2_bytes(), filename="manor.json")
    character, world = split_card(card)

    assert world.directives == 2
    assert character.system_prompt == "" and character.post_history_instructions == ""
    # Raw too: nothing downstream can read a directive back off the character half.
    blob = json.dumps(character.raw)
    assert "system_prompt" not in blob and "post_history_instructions" not in blob
    assert character.raw["data"]["extensions"] == {"keep": 1}  # the rest of raw survives
    assert card.system_prompt == HEAD  # the original is never mutated


def test_directives_are_not_machinery():
    """A persona card with a system prompt is still a character card: `any` (what
    `core.pack` keys the card kind on) excludes directives; only the receipt condition
    `any_stripped` sees them."""
    world = detect_world_payloads(parse_card_bytes(_v2_bytes(), filename="manor.json"))
    assert world == WorldPayloads(directives=2)
    assert not world.any
    assert world.any_stripped
    assert not WorldPayloads().any_stripped


def test_prepare_directive_does_the_static_work_and_leaves_per_turn_macros_alone():
    text = prepare_directive(HEAD + " " + POST, "Manor")
    assert "Manor" in text and "{{char}}" not in text
    assert "{{original}}" not in text
    assert "<%" not in text and "setvar" not in text
    assert "{{// keep}}" not in text
    assert "{{user}}" in text  # a per-turn macro, left for the prompt lane
    assert prepare_directive("", "Manor") == "" and prepare_directive(None, "") == ""
    assert len(prepare_directive("x" * (MAX_FIELD_CHARS + 50), "M")) == MAX_FIELD_CHARS
    # A card name is never a regex replacement template.
    assert prepare_directive("{{char}}", "a\\1b") == "a\\1b"


def test_build_brief_carries_directives_and_keeps_a_directives_only_card():
    brief = build_brief(CharacterCard(name="Rules", system_prompt="head text", post_history_instructions="post text"))
    assert brief is not None
    assert brief[DIRECTIVE_FIELDS["head"]] == "head text"
    assert brief[DIRECTIVE_FIELDS["post_history"]] == "post text"
    assert build_brief(CharacterCard(name="Blank")) is None


def test_directive_bands_join_every_brief_in_order():
    views = [
        {"directives_head": "one", "directives_post": ""},
        {"directives_head": "two", "directives_post": "late"},
        {"name": "no directives"},
    ]
    assert directive_bands(views) == {"head": "one\n\ntwo", "post_history": "late"}
    assert directive_bands([]) == {"head": "", "post_history": ""}
