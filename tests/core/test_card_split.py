"""Tests for core.card_split — the 拆卡 splitter.

RED LINE: the character half of ANY card must be structurally free of world machinery —
no hook scripts, no variable-declaration entries, no executable EJS — because that half
is what a player may self-import into a shared room. These tests are the tripwire.
"""

from __future__ import annotations

import copy

from core.card_split import (
    WorldPayloads,
    card_hook_codes,
    detect_world_payloads,
    is_variable_declaration_entry,
    split_card,
    strip_ejs,
)
from core.charcard import CharacterCard


def _heavy_card() -> CharacterCard:
    """A "heavy" ST card: hooks + [InitVar] + EJS in prose AND lore — a world in disguise."""
    raw = {
        "spec": "chara_card_v2",
        "data": {
            "name": "理",
            "extensions": {
                "loreweaver_hooks": [
                    "on('turn_start', () => {});",
                    {"code": "on('reply_ready', () => {});"},
                ],
                "unrelated": {"keep": "me"},
            },
        },
    }
    return CharacterCard(
        name="理",
        description="A caretaker. <% setvar('好感度', 50) %>Quiet.",
        personality="curious <%= getvar('mood') %>",
        scenario="An old manor.",
        first_mes="Hello.",
        mes_example="",
        creator_notes="",
        tags=["mystery"],
        character_book=[
            {"comment": "[InitVar]变量初始化", "content": '{"理": {"好感度": [33, "affinity"]}}'},
            {"comment": "manor", "keys": ["manor"], "content": "The manor. <% incvar('visits') %> It looms."},
            {"comment": "plain", "keys": ["door"], "content": "The door is locked."},
        ],
        raw=raw,
    )


def test_split_strips_every_world_payload_from_the_character_half():
    card = _heavy_card()
    character, world = split_card(card)

    assert world == WorldPayloads(hooks=2, initvar_entries=1, ejs_blocks=3)
    assert world.any

    # Character half: no hooks, no declaration entries, no EJS anywhere.
    assert card_hook_codes(character) == []
    assert [entry["comment"] for entry in character.character_book] == ["manor", "plain"]
    blob = "\n".join(
        [
            character.description,
            character.personality,
            character.scenario,
            *[str(entry["content"]) for entry in character.character_book],
        ]
    )
    assert "<%" not in blob
    assert "setvar" not in blob
    # Prose around the stripped spans survives.
    assert character.description == "A caretaker. Quiet."
    assert character.character_book[0]["content"] == "The manor.  It looms."
    # Unrelated extensions survive the hooks removal.
    assert character.raw["data"]["extensions"]["unrelated"] == {"keep": "me"}
    assert "loreweaver_hooks" not in character.raw["data"]["extensions"]


def test_split_never_mutates_the_original_card():
    card = _heavy_card()
    snapshot = copy.deepcopy(card.raw)
    before_book = copy.deepcopy(card.character_book)

    split_card(card)

    assert card.raw == snapshot
    assert card.character_book == before_book
    assert "<%" in card.description  # original prose untouched


def test_plain_persona_card_passes_through_unchanged():
    card = CharacterCard(
        name="Bert",
        description="A valet.",
        character_book=[{"comment": "plain", "keys": ["hat"], "content": "A fine hat."}],
        raw={"name": "Bert"},
    )
    character, world = split_card(card)
    assert not world.any
    assert detect_world_payloads(card) == WorldPayloads()
    assert character.description == card.description
    assert character.character_book == card.character_book
    assert character.raw is card.raw  # no hooks -> raw not copied


def test_variable_declaration_predicate_covers_all_three_upstream_shapes():
    assert is_variable_declaration_entry({"comment": "「[InitVar]变量初始化」", "content": "{}"})
    assert is_variable_declaration_entry({"title": "[Initial Variables]", "content": "{}"})
    assert is_variable_declaration_entry({"comment": "vars", "content": "@@initial_variables\n{}"})
    assert not is_variable_declaration_entry({"comment": "manor", "content": "The manor."})


def test_root_level_extensions_hooks_are_detected_and_stripped():
    card = CharacterCard(name="V1", raw={"name": "V1", "extensions": {"loreweaver_hooks": ["on('turn_start',()=>{});"]}})
    assert detect_world_payloads(card).hooks == 1
    character, _ = split_card(card)
    assert card_hook_codes(character) == []


def test_strip_ejs_handles_adjacent_and_dangling_spans():
    clean, count = strip_ejs("a<% one %>b<%= two %>c")
    assert (clean, count) == ("abc", 2)
    # Unclosed opener strips to end-of-text: no template fragment may survive.
    clean, count = strip_ejs("safe <% broken")
    assert (clean, count) == ("safe ", 1)
    assert strip_ejs("no templates") == ("no templates", 0)
