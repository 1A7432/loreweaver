"""Tests for core.lorecard — the native `*.lorecard.json` bundle parser (M14, parsing half).

The bundles built here mirror the studio's `exportNativeBundle` output field for field
(loreweaver-studio `src/features/studio/exporters.ts` + `docs/FORMATS.md`), so a drift on either
side surfaces as a failure rather than as a silently half-imported card.

Two contracts carry weight beyond "it parses": the emitted worldbook dicts must survive
`core.worldbook`'s import normalization with the typed `condition` and the `secret` flag intact
(the native path deliberately reuses that audited importer instead of growing a second one), and
an author's mistake must never be fatal — a junk entry or an unusable variable spec is skipped
with a warning, while structural garbage raises.
"""

from __future__ import annotations

import json

import pytest

from core.card_split import card_hook_codes, detect_world_payloads
from core.lorecard import (
    LORECARD_FORMAT,
    MAX_LORECARD_ENTRIES,
    MAX_LORECARD_ENTRY_CONTENT_BYTES,
    MAX_LORECARD_FILE_BYTES,
    MAX_LORECARD_VARIABLES,
    SUPPORTED_FORMAT_VERSIONS,
    Lorecard,
    looks_like_lorecard,
    parse_lorecard_bytes,
)
from core.worldbook import _normalize_import_entry

HOOK_SOURCE = "on('turn_start', () => {});"


def _entry(**overrides) -> dict:
    """One worldbook row exactly as `loreToNative` emits it."""
    entry = {
        "title": "Untitled Lore",
        "content": "…",
        "keys": [],
        "category": "lore",
        "secret": False,
        "constant": False,
        "priority": 0,
        "enabled": True,
        "condition": "",
        "secondary_keys": [],
        "selective_logic": "and_any",
        "probability": 100,
        "case_sensitive": False,
        "match_whole_words": False,
        "scan_depth": 0,
        "position": "",
        "sticky": 0,
        "cooldown": 0,
        "delay": 0,
    }
    entry.update(overrides)
    return entry


def _bundle(**overrides) -> dict:
    """A full native bundle, shaped like `exportNativeBundle(project, specs)`."""
    bundle = {
        "format": LORECARD_FORMAT,
        "format_version": 0,
        "name": "雾锁山庄",
        "description": "A rain-soaked manor on the cliff road.",
        "personality": "Watchful.",
        "scenario": "The guests arrive at dusk.",
        "first_mes": "The door swings open.",
        "mes_example": "<START>\n{{user}}: Hello.",
        "alternate_greetings": ["Lightning splits the sky.", "   ", ""],
        "creator_notes": "Run it slow.",
        "tags": ["mystery", "克苏鲁"],
        "variables": [
            {
                "id": "suspicion",
                "kind": "number",
                "visibility": "player",
                "labels": {"en": "Suspicion", "zh": "怀疑度"},
                "default": 0,
                "minimum": 0,
                "maximum": 10,
            },
            {
                "id": "culprit",
                "kind": "enum",
                "visibility": "keeper",
                "labels": {"en": "Culprit", "zh": "凶手"},
                "default": "butler",
                "options": ["butler", "heir", "doctor"],
            },
            # Invalid: `kind` is not one of core.modvars.KINDS — skipped, never fatal.
            {"id": "mood", "kind": "colour", "visibility": "player", "labels": {}, "default": "grey"},
        ],
        "worldbook": [
            _entry(title="山庄", content="The manor looms over the road.", keys=["山庄", "manor"], priority=5),
            _entry(
                title="The Culprit",
                content="The butler did it.",
                keys=["butler"],
                secret=True,
                constant=True,
            ),
            _entry(
                title="Suspicion Rises",
                content="The guests stop meeting your eye.",
                keys=["guests"],
                secondary_keys=["dinner", "study"],
                selective_logic="and_all",
                condition="suspicion >= 5",
                position="before",
                probability=70,
                case_sensitive=True,
                match_whole_words=True,
                scan_depth=4,
                sticky=2,
                cooldown=3,
                delay=1,
            ),
            "not an entry at all",
            _entry(title="Blank", content="   "),
        ],
        "extensions": {"loreweaver_hooks": [HOOK_SOURCE]},
    }
    bundle.update(overrides)
    return bundle


def _bytes(bundle: dict) -> bytes:
    return json.dumps(bundle, ensure_ascii=False).encode("utf-8")


def _parse(**overrides) -> Lorecard:
    return parse_lorecard_bytes(_bytes(_bundle(**overrides)), filename="manor.lorecard.json")


def _by_title(card_book: list[dict], title: str) -> dict:
    return next(entry for entry in card_book if entry["comment"] == title)


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


def test_full_bundle_populates_every_card_field():
    parsed = _parse()
    card = parsed.card

    assert card.name == "雾锁山庄"
    assert card.description == "A rain-soaked manor on the cliff road."
    assert card.personality == "Watchful."
    assert card.scenario == "The guests arrive at dusk."
    assert card.first_mes == "The door swings open."
    assert card.mes_example == "<START>\n{{user}}: Hello."
    assert card.creator_notes == "Run it slow."
    assert card.tags == ["mystery", "克苏鲁"]
    # The original document rides along verbatim so core.card_split can classify the bundle.
    assert card.raw["format"] == LORECARD_FORMAT


def test_alternate_greetings_are_blank_filtered():
    assert _parse().alternate_greetings == ("Lightning splits the sky.",)
    assert _parse(alternate_greetings=[]).alternate_greetings == ()
    assert _parse(alternate_greetings="only one").alternate_greetings == ("only one",)


def test_hooks_ride_extensions_and_stay_visible_to_the_card_splitter():
    parsed = _parse()
    assert parsed.hooks == (HOOK_SOURCE,)
    # card_split reads the same field off `card.raw` — a native bundle with hooks is world-kind.
    assert card_hook_codes(parsed.card) == [HOOK_SOURCE]
    assert detect_world_payloads(parsed.card).any

    assert _parse(extensions={}).hooks == ()
    assert parse_lorecard_bytes(_bytes({k: v for k, v in _bundle().items() if k != "extensions"})).hooks == ()
    # `{code: ...}` dicts are tolerated, matching core.card_split.card_hook_codes.
    assert _parse(extensions={"loreweaver_hooks": [{"code": HOOK_SOURCE}, "  ", 7]}).hooks == (HOOK_SOURCE,)


def test_variables_pass_through_modvars_normalization():
    parsed = _parse()
    assert [spec["id"] for spec in parsed.variable_specs] == ["suspicion", "culprit"]

    suspicion, culprit = parsed.variable_specs
    assert suspicion == {
        "id": "suspicion",
        "kind": "number",
        "visibility": "player",
        "labels": {"en": "Suspicion", "zh": "怀疑度"},
        "minimum": 0,
        "maximum": 10,
        "default": 0,
    }
    assert culprit["visibility"] == "keeper"
    assert culprit["options"] == ["butler", "heir", "doctor"]
    assert culprit["default"] == "butler"


def test_invalid_and_duplicate_variable_specs_are_skipped_with_warnings():
    parsed = _parse()
    assert any("variables[2]" in warning for warning in parsed.warnings)
    assert all("mood" != spec["id"] for spec in parsed.variable_specs)

    duplicate = _parse(
        variables=[
            {"id": "suspicion", "kind": "number", "visibility": "player", "labels": {}, "default": 1},
            {"id": "Suspicion", "kind": "number", "visibility": "player", "labels": {}, "default": 2},
            "not a spec",
        ]
    )
    assert [spec["default"] for spec in duplicate.variable_specs] == [1]
    assert any("duplicate" in warning for warning in duplicate.warnings)
    assert any("variables[2]" in warning for warning in duplicate.warnings)


def test_junk_entries_are_skipped_with_warnings_never_fatally():
    parsed = _parse()
    assert [entry["comment"] for entry in parsed.card.character_book] == ["山庄", "The Culprit", "Suspicion Rises"]
    assert any("worldbook[3]" in warning for warning in parsed.warnings)
    assert any("worldbook[4]" in warning for warning in parsed.warnings)
    # Warnings are plain strings for the caller to echo; nothing raised.
    assert all(isinstance(warning, str) for warning in parsed.warnings)


def test_condition_is_re_emitted_as_an_at_if_first_line():
    entry = _by_title(_parse().card.character_book, "Suspicion Rises")
    assert entry["content"] == "@@if suspicion >= 5\nThe guests stop meeting your eye."
    # An unconditioned entry keeps its content byte-for-byte.
    assert _by_title(_parse().card.character_book, "山庄")["content"] == "The manor looms over the road."


def test_multiline_condition_is_collapsed_onto_the_decorator_line():
    parsed = _parse(worldbook=[_entry(title="C", content="Body.", condition="  a > 1\n  && b < 2  ")])
    assert parsed.card.character_book[0]["content"] == "@@if a > 1 && b < 2\nBody."


def test_overlong_condition_warns_but_still_imports():
    parsed = _parse(worldbook=[_entry(title="C", content="Body.", condition="x " * 400)])
    assert parsed.card.character_book[0]["content"].startswith("@@if x x")
    assert any("condition" in warning for warning in parsed.warnings)


def test_entry_dicts_carry_every_trigger_field_the_importer_reads():
    entry = _by_title(_parse().card.character_book, "Suspicion Rises")
    assert entry == {
        "comment": "Suspicion Rises",
        "content": "@@if suspicion >= 5\nThe guests stop meeting your eye.",
        "keys": ["guests"],
        "secondary_keys": ["dinner", "study"],
        "selective": True,
        "selective_logic": "and_all",
        "category": "lore",
        "secret": False,
        "constant": False,
        "priority": 0,
        "enabled": True,
        "probability": 70,
        "case_sensitive": True,
        "match_whole_words": True,
        "scan_depth": 4,
        "position": "before_char",
        "sticky": 2,
        "cooldown": 3,
        "delay": 1,
    }
    plain = _by_title(_parse().card.character_book, "山庄")
    assert (plain["selective"], plain["selective_logic"], plain["position"], plain["priority"]) == (
        False,
        "and_any",
        "",
        5,
    )


def test_emitted_entries_survive_the_worldbook_importer_intact():
    """The load-bearing wiring contract: these dicts go straight into `import_entries`."""
    book = _parse().card.character_book

    conditioned = _normalize_import_entry(
        _by_title(book, "Suspicion Rises"), source="manor", index=1, is_keeper=True
    )
    assert conditioned.condition == "suspicion >= 5"
    assert conditioned.content == "The guests stop meeting your eye."  # decorator peeled back off
    assert conditioned.secondary_keys == ["dinner", "study"]
    assert conditioned.selective_logic == "and_all"
    assert conditioned.position == "before"
    assert (conditioned.probability, conditioned.scan_depth) == (70, 4)
    assert (conditioned.sticky, conditioned.cooldown, conditioned.delay) == (2, 3, 1)
    assert (conditioned.case_sensitive, conditioned.match_whole_words) == (True, True)

    keeper_secret = _normalize_import_entry(_by_title(book, "The Culprit"), source="manor", index=2, is_keeper=True)
    assert keeper_secret is not None
    assert keeper_secret.secret is True
    assert keeper_secret.title == "The Culprit"
    assert keeper_secret.priority == 0
    # Iron rule #3 stays structural: a non-keeper import DROPS a secret-flagged entry
    # outright (importing it as public would launder keeper-only content into
    # player-visible room state).
    player_view = _normalize_import_entry(_by_title(book, "The Culprit"), source="manor", index=2, is_keeper=False)
    assert player_view is None

    cjk = _normalize_import_entry(_by_title(book, "山庄"), source="manor", index=0, is_keeper=True)
    assert cjk.title == "山庄"
    assert cjk.keys == ["山庄", "manor"]
    assert cjk.priority == 5


# ---------------------------------------------------------------------------
# Sniffing
# ---------------------------------------------------------------------------


def test_looks_like_lorecard_accepts_only_tagged_json_objects():
    assert looks_like_lorecard(_bytes(_bundle())) is True
    # A UTF-8 BOM (Windows editors) must not defeat the sniff.
    assert looks_like_lorecard(b"\xef\xbb\xbf" + _bytes(_bundle())) is True

    assert looks_like_lorecard(b"") is False
    assert looks_like_lorecard(b"not json at all") is False
    assert looks_like_lorecard(_bytes({"spec": "chara_card_v3", "data": {"name": "Ada"}})) is False
    assert looks_like_lorecard(_bytes({"format": "something.else", "format_version": 0})) is False
    # The tag as loose text is not enough — it must be the root `format` field.
    assert looks_like_lorecard(b'{"note": "loreweaver.card"}') is False
    assert looks_like_lorecard(b'["loreweaver.card"]') is False
    assert looks_like_lorecard(b"x" * (MAX_LORECARD_FILE_BYTES + 1)) is False
    assert looks_like_lorecard("a string, not bytes") is False  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# Structural refusals
# ---------------------------------------------------------------------------


def test_non_json_payload_raises():
    with pytest.raises(ValueError, match="readable JSON"):
        parse_lorecard_bytes(b"<html>nope</html>", filename="manor.lorecard.json")
    with pytest.raises(ValueError, match="must be a JSON object"):
        parse_lorecard_bytes(b'["loreweaver.card"]')


def test_wrong_format_tag_raises():
    with pytest.raises(ValueError, match="not a Loreweaver native card"):
        parse_lorecard_bytes(_bytes(_bundle(format="chara_card_v3")))
    with pytest.raises(ValueError, match="not a Loreweaver native card"):
        parse_lorecard_bytes(_bytes({k: v for k, v in _bundle().items() if k != "format"}))


def test_unsupported_format_version_raises():
    assert SUPPORTED_FORMAT_VERSIONS == frozenset({0})
    for version in (1, -1, "0", None, True):
        with pytest.raises(ValueError, match="unsupported format_version"):
            parse_lorecard_bytes(_bytes(_bundle(format_version=version)))


def test_oversized_file_raises_before_parsing():
    payload = b"{" + b" " * MAX_LORECARD_FILE_BYTES
    with pytest.raises(ValueError, match="size limit"):
        parse_lorecard_bytes(payload, filename="huge.lorecard.json")


def test_error_messages_name_the_file():
    with pytest.raises(ValueError, match="^manor.lorecard.json: "):
        parse_lorecard_bytes(b"nope", filename="manor.lorecard.json")


# ---------------------------------------------------------------------------
# Hard caps
# ---------------------------------------------------------------------------


def test_entry_count_cap_is_enforced():
    ok = _parse(worldbook=[_entry(title=f"E{i}", content="lore") for i in range(MAX_LORECARD_ENTRIES)])
    assert len(ok.card.character_book) == MAX_LORECARD_ENTRIES

    with pytest.raises(ValueError, match="at most"):
        _parse(worldbook=[_entry(title=f"E{i}", content="lore") for i in range(MAX_LORECARD_ENTRIES + 1)])


def test_entry_content_cap_is_enforced():
    body = "x" * MAX_LORECARD_ENTRY_CONTENT_BYTES
    assert _parse(worldbook=[_entry(title="Big", content=body)]).card.character_book[0]["content"] == body

    with pytest.raises(ValueError, match="worldbook\\[0\\] content exceeds"):
        _parse(worldbook=[_entry(title="Bigger", content=body + "x")])


def test_variable_count_cap_is_enforced():
    def _spec(index: int) -> dict:
        return {"id": f"v{index}", "kind": "number", "visibility": "player", "labels": {}, "default": 0}

    ok = _parse(variables=[_spec(i) for i in range(MAX_LORECARD_VARIABLES)])
    assert len(ok.variable_specs) == MAX_LORECARD_VARIABLES

    with pytest.raises(ValueError, match="at most"):
        _parse(variables=[_spec(i) for i in range(MAX_LORECARD_VARIABLES + 1)])


# ---------------------------------------------------------------------------
# Degenerate but well-formed bundles
# ---------------------------------------------------------------------------


def test_minimal_bundle_parses_to_empty_extras():
    parsed = parse_lorecard_bytes(_bytes({"format": LORECARD_FORMAT, "format_version": 0, "name": "Bare"}))
    assert parsed.card.name == "Bare"
    assert parsed.card.character_book == []
    assert (parsed.hooks, parsed.variable_specs, parsed.alternate_greetings, parsed.warnings) == ((), (), (), ())


def test_wrong_typed_sections_warn_instead_of_raising():
    parsed = _parse(worldbook={"entries": []}, variables="none", extensions=[HOOK_SOURCE])
    assert parsed.card.character_book == []
    assert parsed.variable_specs == ()
    assert parsed.hooks == ()
    assert len(parsed.warnings) == 3
